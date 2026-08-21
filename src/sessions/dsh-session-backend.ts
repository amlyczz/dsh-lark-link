// DshSessionBackend: the ONLY place the bridge touches DSH agent/session APIs.
// Everything else in the bridge depends on this narrow interface, so tests can
// mock it and the real DSH wiring lives in one file (spec §2.3 discipline,
// same as pi-feishu-link's pi-session-backend.ts).
//
// This file ships BOTH the interface and a harness-agnostic in-memory mock
// (used by unit tests and by the bridge when DSH services are absent), plus
// the real adapter implemented against the DSH Cordis ctx in `dsh-adapter.ts`.

import type { FeishuInboundMessage, AgentPresetOption, GoalSnapshotState, TodoItemState } from "../common/types.ts";

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
  | { type: "tool/result"; name: string; error?: { name: string; code: string } }
  | { type: "todo/write"; todos: TodoItemState[] }
  | { type: "goal/change"; goal: GoalSnapshotState };

export interface AgentHandle {
  agentId: string;
  sessionId: string;
  /** Live underlying DSH Agent instance if running on real DSH harness. */
  rawAgent?: unknown;
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
  /**
   * Resume a PERSISTED historical session in this conversation (/resume):
   * detach the current agent (never dispose — its session row must survive)
   * and load the stored log as the live agent identity. `opts.preset`
   * carries the session's STORED agent preset (resume must recompose the
   * same world, not the conversation's current override).
   */
  resumeAgent(
    key: string,
    sessionId: string,
    opts?: { preset?: string },
  ): Promise<AgentHandle>;
  /** Look up a previously created agent (no creation). */
  get(key: string): AgentHandle | undefined;
  /** Map sessionId back to conversation key (for event routing). */
  keyForSessionId(sessionId: string): string | undefined;
  /**
   * The agent presets this deployment currently supplies — shipped AND
   * user-authored (custom) rows. When DSH's agentPresets service is
   * unavailable, the memory backend returns the shipped roster only.
   */
  listPresets(): Promise<AgentPresetOption[]>;
  /** Dispose idle agents beyond ttl; returns disposed count. */
  disposeIdle(idleTtlMs: number): number;
  /** Bump a conversation's session generation — next ensureAgent uses a fresh id (/new). */
  rotate(key: string): void;
  /** Dispose one conversation's agent (mode/model/workspace switches rebuild it). */
  dispose(key: string): Promise<void>;
  /** ONE-SHOT grace: true exactly once after an image-degrade retry was
   * issued for `key` (agent/error "does not support image input" → text-only
   * re-send). The turn supervisor consumes it on a silent turn/end to skip
   * agent recovery — otherwise it would dispose the agent and kill the
   * retry mid-flight (the retry's turn/start lands BEFORE the original
   * turn's turn/end(error)). One-shot: a retry that itself dies gets normal
   * recovery on the second turn/end. */
  consumeImageRetryGrace?(key: string): boolean;
  /** Clear any remembered image-unsupported marks (e.g. after a /model switch). */
  clearImageUnsupported?(key?: string): void;
  /** Number of hosted agents. */
  size(): number;
  /** Dispose everything (bridge teardown). */
  disposeAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory mock — deterministic, no DSH dependency (unit tests use this).
// ---------------------------------------------------------------------------

/** The shipped preset roster, mirrored here so the memory backend (used when
 * DSH services are absent) still answers a /mode picker with the four
 * official modes. Kept in sync with `AGENT_PRESETS` in presentation/cards. */
const SHIPPED_PRESETS: AgentPresetOption[] = [
  { id: "standard", label: "标准模式", desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流", trust: "system" },
  { id: "code", label: "PTC 模式", desc: "标准能力 + Code Mode（多步操作一次执行，更快）", trust: "system" },
  { id: "minimal", label: "极简模式", desc: "仅 bash + 文件编辑，轻量省 token", trust: "system" },
  { id: "cordis", label: "创造模式", desc: "标准能力 + preset 创作工具（面向开发者）", trust: "system" },
];

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

  const makeAgent = (key: string, sessionId?: string): AgentHandle => {
    const sid = sessionId ?? `session-${++counter}`;
    const agentId = sessionId ?? `agent-${counter}`;
    const listeners = new Set<(e: SessionEventOut) => void>();
    let busy = false;
    let disposed = false;

    const emit = (e: SessionEventOut): void => {
      for (const fn of listeners) fn(e);
    };

    const handle: AgentHandle = {
      agentId,
      sessionId: sid,
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
        keyBySession.delete(sid);
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
    async resumeAgent(key, sessionId) {
      // Detach the current mock agent (keep this cheap — nothing to preserve)
      // and adopt the requested session id as this conversation's identity.
      const prev = agents.get(key);
      if (prev) {
        agents.delete(key);
        keyBySession.delete(prev.sessionId);
      }
      const a = makeAgent(key, sessionId);
      agents.set(key, a);
      keyBySession.set(a.sessionId, key);
      return a;
    },
    keyForSessionId: (sessionId) => keyBySession.get(sessionId),
    listPresets: async () => [...SHIPPED_PRESETS],
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
    rotate() {},
    clearImageUnsupported() {},
    async dispose(key) {
      const a = agents.get(key);
      if (a) await a.dispose();
      agents.delete(key);
    },
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
