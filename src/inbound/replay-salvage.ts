// ReplaySalvage (GH #9): boot-replay rescue for turns that ALREADY completed.
//
// When the bridge process died/reloaded mid-turn, the inbound WAL records the
// user request as accepted-but-undelivered and the next boot re-dispatches it
// through the agent. But in the reported bug the agent had ALREADY finished —
// the session log holds the final assistant message — while the bridge's
// outbox never saw it (lost event). Blindly re-invoking the agent re-runs the
// whole turn (re-installing skills, burning tokens) when the answer already
// exists on disk.
//
// Before re-dispatching a WAL record, the boot replay asks this module: does
// the conversation's persisted session already contain an assistant message
// recorded AFTER the request was accepted? If so, enqueue that text through
// the durable outbox (idempotent dedupe key per messageId) and mark the
// record delivered — the user gets the existing answer, no re-run.
//
// Harness-agnostic: session loading and outbox enqueue are injected.

import type { InboundWal, InboundWalRecord } from "./inbound-wal.ts";

/** Minimal enqueue surface of the bridge outbox (see outbound/outbox.ts). */
export interface SalvageEnqueueInput {
  dedupeKey: string;
  laneKey: string;
  route: { sessionKey: string; chatId: string; chatType: "p2p" | "group" };
  kind: "assistant-output";
  payload: { kind: "text"; text: string };
}

export interface ReplaySalvageDeps {
  /** Load a persisted session's events (DSH sessionPersistence.load shape). */
  loadSession(
    sessionId: string,
  ): Promise<{ events?: readonly unknown[] } | undefined>;
  /** Durable enqueue into the bridge outbox. */
  enqueue(input: SalvageEnqueueInput): Promise<unknown> | unknown;
  /** Inbound WAL — a salvaged record is marked delivered. */
  wal: InboundWal;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export interface ReplaySalvage {
  /**
   * Try to answer `rec` from the persisted session's existing output.
   * Returns true when this call performed a salvage (record now delivered);
   * false when the caller should fall back to re-dispatching the request.
   */
  salvage(rec: InboundWalRecord, sessionId: string | undefined): Promise<boolean>;
}

/** Extract assistant text from a DSH session event's content blocks. */
function assistantTextOf(ev: unknown): string | undefined {
  const e = ev as {
    type?: string;
    data?: { message?: { content?: Array<{ type?: string; text?: string }> } };
  };
  if (e?.type !== "assistant/message") return undefined;
  const blocks = e.data?.message?.content;
  if (!Array.isArray(blocks)) return undefined;
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

export function createReplaySalvage(deps: ReplaySalvageDeps): ReplaySalvage {
  // In-process idempotency: a record salvaged once is never salvaged again
  // (cross-restart double-send is additionally blocked by the stable outbox
  // dedupe key).
  const salvaged = new Set<string>();

  return {
    async salvage(rec, sessionId) {
      if (!sessionId || salvaged.has(rec.messageId)) return false;
      let events: readonly unknown[] | undefined;
      try {
        const loaded = await deps.loadSession(sessionId);
        events = loaded?.events;
      } catch (err) {
        deps.logger?.warn(
          `replay-salvage: loadSession(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
      if (!events || events.length === 0) return false;
      // Newest first: the LAST assistant message of the session.
      for (let i = events.length - 1; i >= 0; i--) {
        const text = assistantTextOf(events[i]);
        if (text === undefined) continue;
        const time = (events[i] as { time?: number }).time;
        // Ordering proof: only an output recorded AFTER the request was
        // accepted answers THIS request. Without a timestamp we cannot prove
        // that — fall back to the normal replay path instead of guessing.
        if (typeof time !== "number" || time < rec.acceptedAt) return false;
        if (!text || text.trim() === "" || text === "No response.") return false;
        try {
          await deps.enqueue({
            dedupeKey: `wal-salvage:${rec.messageId}`,
            laneKey: rec.sessionKey,
            route: {
              sessionKey: rec.sessionKey,
              chatId: rec.chatId,
              chatType: rec.chatType,
            },
            kind: "assistant-output",
            payload: { kind: "text", text },
          });
        } catch (err) {
          deps.logger?.warn(
            `replay-salvage: enqueue failed for ${rec.messageId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return false;
        }
        salvaged.add(rec.messageId);
        deps.wal.delivered(rec.messageId);
        deps.logger?.info(
          `replay-salvage: answered ${rec.messageId} from session ${sessionId} (no agent re-run)`,
        );
        return true;
      }
      return false;
    },
  };
}
