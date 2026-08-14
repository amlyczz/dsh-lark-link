// DshSessionBackend: the ONLY place the bridge touches DSH agent/session APIs.
// Everything else in the bridge depends on this narrow interface, so tests can
// mock it and the real DSH wiring lives in one file (spec §2.3 discipline,
// same as pi-feishu-link's pi-session-backend.ts).
//
// This file ships BOTH the interface and a harness-agnostic in-memory mock
// (used by unit tests and by the bridge when DSH services are absent), plus
// the real adapter implemented against the DSH Cordis ctx in `dsh-adapter.ts`.

import type { FeishuInboundMessage } from "../common/types.ts";

export interface AttachmentInput {
  /** Local file path (image/file). */
  path: string;
  kind: "image" | "file";
  name?: string;
  /** Extracted text preview (bounded) for inbound files. */
  textPreview?: string;
  /** Inbound Feishu image — durable attachment ref for an ImageBlock. */
  imageRef?: {
    attachmentId: string;
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    bytes: number;
    width: number;
    height: number;
    name?: string;
  };
}

/** Events the bridge consumes from a DSH session (normalized slice). */
export type SessionEventOut =
  | { type: "turn/start" }
  | { type: "assistant/chunk"; text: string }
  | { type: "assistant/message"; text: string }
  | { type: "turn/end"; reason: string }
  | { type: "tool/call"; name: string }
  | { type: "tool/result"; name: string; error?: { name: string; code: string } };

export interface AgentHandle {
  agentId: string;
  sessionId: string;
  /** Ask the agent to handle a user message (queue; wake on idle). */
  followup(text: string, attachments?: AttachmentInput[]): Promise<void>;
  /** Cancel the current turn (only this session). */
  cancel(): Promise<void>;
  /** Subscribe to session events; returns an unsubscribe. */
  onEvent(fn: (e: SessionEventOut) => void): () => void;
  /** Idle when no turn is running. */
  isIdle(): boolean;
  dispose(): Promise<void>;
}

export interface DshSessionBackend {
  /** Get-or-create an agent for a conversation key (persisted mapping). */
  ensureAgent(key: string, seed?: { chatId: string; chatType: string }): Promise<AgentHandle>;
  /** Look up a previously created agent (no creation). */
  get(key: string): AgentHandle | undefined;
  /** Map sessionId back to conversation key (for event routing). */
  keyForSessionId(sessionId: string): string | undefined;
  /** Dispose idle agents beyond ttl; returns disposed count. */
  disposeIdle(idleTtlMs: number): number;
  /** Number of hosted agents. */
  size(): number;
  /** Dispose everything (bridge teardown). */
  disposeAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory mock — deterministic, no DSH dependency (unit tests use this).
// ---------------------------------------------------------------------------

export function createMemoryDshBackend(
  opts: {
    /** Simulate agent latency for tests. */
    latencyMs?: number;
    /** Emit a fixed assistant reply after a followup. */
    autoReply?: (key: string, text: string) => string;
  } = {},
): DshSessionBackend & { agents: Map<string, AgentHandle> } {
  const agents = new Map<string, AgentHandle>();
  const keyBySession = new Map<string, string>();
  let counter = 0;

  const makeAgent = (key: string): AgentHandle => {
    const agentId = `agent-${++counter}`;
    const sessionId = `session-${counter}`;
    const listeners = new Set<(e: SessionEventOut) => void>();
    let busy = false;
    let disposed = false;

    const emit = (e: SessionEventOut): void => {
      for (const fn of listeners) fn(e);
    };

    const handle: AgentHandle = {
      agentId,
      sessionId,
      async followup(text, attachments) {
        if (disposed) throw new Error("agent disposed");
        busy = true;
        const reply = opts.autoReply?.(key, text);
        // Simulate streaming chunks of the reply.
        const stream = async (): Promise<void> => {
          const content = reply ?? `echo: ${text}`;
          const mid = Math.floor(content.length / 2);
          emit({ type: "assistant/chunk", text: content.slice(0, mid) });
          if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
          emit({ type: "assistant/chunk", text: content.slice(mid) });
          emit({ type: "assistant/message", text: content });
          emit({ type: "turn/end", reason: "complete" });
          busy = false;
        };
        void stream();
      },
      async cancel() {
        busy = false;
      },
      onEvent(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      isIdle: () => !busy,
      async dispose() {
        disposed = true;
        listeners.clear();
        agents.delete(key);
        keyBySession.delete(sessionId);
      },
    };
    return handle;
  };

  return {
    agents,
    async ensureAgent(key) {
      let a = agents.get(key);
      if (!a) {
        a = makeAgent(key);
        agents.set(key, a);
        keyBySession.set(a.sessionId, key);
      }
      return a;
    },
    get: (key) => agents.get(key),
    keyForSessionId: (sessionId) => keyBySession.get(sessionId),
    disposeIdle(ttlMs) {
      let n = 0;
      for (const [key, a] of agents) {
        if (a.isIdle()) {
          void a.dispose();
          agents.delete(key);
          keyBySession.delete(a.sessionId);
          n++;
        }
      }
      return n;
    },
    size: () => agents.size,
    async disposeAll() {
      for (const a of agents.values()) await a.dispose();
      agents.clear();
      keyBySession.clear();
    },
  };
}

/** Attachments from an inbound Feishu message (image/file). */
export function attachmentsFromMessage(msg: FeishuInboundMessage): AttachmentInput[] {
  // The bridge resolves file keys → local paths in the attachment pipeline;
  // the interface accepts local paths, so this is a no-op placeholder hook.
  return [];
}
