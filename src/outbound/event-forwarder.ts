// EventForwarder: the bridge's outbound "assistant → Feishu" pipeline.
// Consumes DSH session events (assistant/chunk for streaming, assistant/message
// for the durable final, turn/end for completion) and pushes them either into
// the volatile LiveChannel (streaming card) or the persistent Outbox (final +
// DONE reaction).
//
// Harness-agnostic: receives normalized DSH events through an injected
// subscribe function so this module stays unit-testable without DSH.

import type { GoalSnapshotState, Route, RouteRef, TodoItemState } from "../common/types.ts";
import type { Outbox } from "./outbox.ts";
import type { CardKitStreamHandle } from "./cardkit-stream.ts";
import type { TaskCardSyncer } from "./task-card-syncer.ts";

/** A normalized slice of the DSH session event surface we care about. */
export type BridgeSessionEvent =
  | { type: "turn/start" }
  | { type: "assistant/chunk"; text: string }
  | { type: "assistant/message"; text: string }
  | { type: "turn/end"; reason: string; finalText?: string }
  | { type: "tool/call"; name: string }
  | { type: "tool/result"; name: string; error?: { name: string; code: string } }
  | { type: "todo/write"; todos: TodoItemState[] }
  | { type: "goal/change"; goal: GoalSnapshotState };

export interface StreamTarget {
  route: RouteRef;
  /** Create (or reuse) a streaming card handle for this turn. */
  ensureStream(): CardKitStreamHandle | undefined;
  /** Send a plain-text reply through the outbox (no card). */
  fallbackText(text: string): Promise<void>;
  /** Mark the turn complete (DONE reaction on the trigger message). */
  markDone(): Promise<void>;
}

export interface ForwarderConfig {
  streamingEnabled: boolean;
}

export interface EventForwarderDeps {
  outbox: Outbox;
  /** Live task and goal board card syncer (optional). */
  taskCardSyncer?: TaskCardSyncer;
  /** Map a session event to the Feishu route it belongs to. */
  routeFor(sessionKey: string): Route | undefined;
  /** Live streaming target per session (volatile). */
  streamFor(sessionKey: string): StreamTarget | undefined;
  /** Config getter — read per event (hot-reload friendly). */
  cfg: () => ForwarderConfig;
  /**
   * Called when a session's durable (per-turn) output is enqueued into the
   * outbox. Lets the inbound WAL mark the triggering user request delivered —
   * the durable output IS the proof the turn completed, so that request won't
   * be re-triggered after a crash. Best-effort; failures are swallowed.
   */
  onDelivered?(sessionKey: string): void;
}


export interface EventForwarder {
  /** Feed one normalized DSH session event for a session key. */
  onSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void>;
  /** Finalize any in-flight streaming cards for a session. */
  finalizeSession(sessionKey: string): Promise<void>;
}

interface SessionState {
  stream?: CardKitStreamHandle;
  acc: string;
  lastFlushAt: number;
  /** True once any non-empty assistant text has been delivered this turn. */
  hasOutput: boolean;
  /** True once markDone has been issued (avoid duplicates). */
  doneIssued: boolean;
}

export function createEventForwarder(deps: EventForwarderDeps): EventForwarder {
  const state = new Map<string, SessionState>();

  const emptyState = (): SessionState => ({
    acc: "",
    lastFlushAt: Date.now(),
    hasOutput: false,
    doneIssued: false,
  });

  const routeRefFor = (route: Route): RouteRef => ({
    sessionKey: route.sessionKey,
    chatId: route.chatId,
    chatType: route.chatType,
    threadMessageId: route.threadMessageId,
  });

  async function onSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void> {
    const route = deps.routeFor(sessionKey);
    if (!route) return; // no Feishu route for this session — nothing to forward

    const st = state.get(sessionKey) ?? emptyState();
    state.set(sessionKey, st);

    switch (event.type) {
      case "turn/start":
        // New turn: reset per-turn delivery state. doneIssued/hasOutput/acc
        // must not leak across turns — otherwise only the FIRST turn of a
        // session ever gets its DONE reaction (pi lesson: 每轮都要打 DONE).
        st.hasOutput = false;
        st.doneIssued = false;
        st.acc = "";
        st.stream = undefined;
        break;
      case "assistant/chunk": {
        // Streaming is volatile preview only (ADR-8); the durable per-turn
        // delivery happens on assistant/message. When streaming is off
        // (default, 省流量 — pi 31dc3c9), chunks are ignored entirely.
        const { streamingEnabled } = deps.cfg();
        if (!streamingEnabled) return;
        st.acc += event.text;
        if (!st.stream || st.stream.disposed) {
          const stream = deps.streamFor(sessionKey)?.ensureStream();
          if (stream && !stream.disposed) st.stream = stream;
        }
        if (st.stream && !st.stream.disposed) {
          await st.stream.patch(event.text);
        }
        break;
      }

      case "assistant/message": {
        // Each complete assistant output is delivered as ONE Feishu message
        // (pi bdbc0a2: 每轮输出逐条发, turn_end 不再重复发最终). Empty output
        // (e.g. goal-activation turns) is skipped entirely (pi 5ac1c3d).
        const text = st.acc.length > event.text.length ? st.acc : event.text;
        st.acc = "";
        if (!text || text.trim() === "" || text === "No response.") return;
        st.hasOutput = true;
        if (st.stream && !st.stream.disposed) {
          // Streaming card active: settle it. On ANY failure fall through to
          // the durable outbox so content is never lost.
          try {
            const finalId = await st.stream.finalize(text);
            if (!finalId) throw new Error("CardKit finalize returned empty cardId");
            st.stream = undefined;
            deps.onDelivered?.(sessionKey); // card is final — treat as delivered
            return;
          } catch {
            st.stream = undefined;
            // fall through → outbox
          }
        }
        await deps.outbox.enqueue({
          dedupeKey: `${sessionKey}:assistant:${text.length}:${Date.now()}`,
          laneKey: sessionKey,
          route: routeRefFor(route),
          kind: "assistant-output",
          payload: { kind: "text", text },
        });
        deps.onDelivered?.(sessionKey); // durable enqueue — request is delivered
        break;
      }
      case "turn/end": {
        // Turn completion: the last assistant/message was already delivered
        // (no duplicate final — pi bdbc0a2). Finalize any leftover streaming
        // card; issue the DONE reaction ONLY when real output was delivered
        // (pi 5ac1c3d: 空输出不打 DONE).
        st.acc = "";
        if (st.stream) {
          try {
            await st.stream.finalize("");
          } catch {
            // ignore
          }
          st.stream = undefined;
        }
        // GH #9 兜底 (rescue): the turn produced assistant output but nothing
        // was durably delivered THIS turn — the assistant/message event was
        // lost (plugin reload mid-turn, subscription re-race), outbox.enqueue
        // threw, or the route only appeared after the message. The adapter
        // attaches the session's final assistant text to turn/end; enqueue it
        // now so the user still gets the reply instead of silence. This is
        // also a SECOND, independent path to onDelivered (the inbound WAL no
        // longer depends solely on the assistant/message callback).
        const rescue = (event.finalText ?? "").trim() !== "" ? event.finalText : "";
        if (!st.hasOutput && rescue && rescue !== "No response.") {
          try {
            await deps.outbox.enqueue({
              dedupeKey: `${sessionKey}:rescue:${rescue.length}:${Date.now()}`,
              laneKey: sessionKey,
              route: routeRefFor(route),
              kind: "assistant-output",
              payload: { kind: "text", text: rescue },
            });
            st.hasOutput = true;
            deps.onDelivered?.(sessionKey);
          } catch {
            // Rescue is best-effort: the record stays undelivered in the
            // inbound WAL, so boot replay still applies. Never break the
            // rest of turn/end handling (markDone) on a rescue failure.
          }
        }
        const target = deps.streamFor(sessionKey);
        if (target && st.hasOutput && !st.doneIssued) {
          st.doneIssued = true;
          await target.markDone();
        }
        break;
      }
      case "tool/call":
      case "tool/result":
        // Tool activity stays in the DSH GUI (no per-tool Feishu messages).
      case "todo/write":
      case "goal/change":
        // Internal DSH state updates (not sent as Feishu task cards).
        break;
    }
  }


  async function finalizeSession(sessionKey: string): Promise<void> {
    const st = state.get(sessionKey);
    if (!st) return;
    if (st.acc.length > 0 && st.hasOutput === false) {
      // Streaming-only accumulated text never settled by a message_end.
      const route = deps.routeFor(sessionKey);
      if (route) {
        await deps.outbox.enqueue({
          dedupeKey: `${sessionKey}:finalize:${Date.now()}`,
          laneKey: sessionKey,
          route: routeRefFor(route),
          kind: "assistant-output",
          payload: { kind: "text", text: st.acc },
        });
      }
    }
    if (st.stream) {
      try {
        await st.stream.finalize("");
      } catch {
        // ignore
      }
      st.stream = undefined;
    }
    state.delete(sessionKey);
  }

  return { onSessionEvent, finalizeSession };
}
