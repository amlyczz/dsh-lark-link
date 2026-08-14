// ConversationManager: per-conversation-key orchestration (ADR-5). Each
// Feishu conversation maps to one DSH agent; a per-key FIFO queue serializes
// messages (no global lock — pi-remote-feishu's PromptQueue pattern), idle
// agents are disposed after TTL, and a persistent sessionKey↔sessionId mapping
// survives restarts. Harness-agnostic (depends on DshSessionBackend interface).

import type {
  DshSessionBackend,
  AgentHandle,
  SessionEventOut,
  AttachmentInput,
} from "./dsh-session-backend.ts";
import type { FeishuInboundMessage } from "../common/types.ts";

export interface ConversationManagerDeps {
  backend: DshSessionBackend;
  /** Max concurrently hosted sessions; idle ones are evicted beyond the cap. */
  maxSessions: number;
  idleTtlMs: number;
  /** Bridge fan-out: every session event for a conversation key. */
  onEvent?: (key: string, event: SessionEventOut) => void;
  logger?: { warn(msg: string): void };
  now?: () => number;
}

export interface ConversationManager {
  /** Handle an inbound Feishu message: enqueue into the per-key FIFO. */
  handleMessage(msg: FeishuInboundMessage, attachments?: AttachmentInput[]): Promise<void>;
  /** Key for a message (dm:* for p2p, group:* for group chats). */
  keyFor(msg: FeishuInboundMessage): string;
  /** Cancel the current turn of one conversation (does not touch others). */
  stop(key: string): Promise<void>;
  /** Reap idle agents; returns disposed count. */
  sweep(): number;
  size(): number;
  keys(): string[];
  disposeAll(): Promise<void>;
}

export function createConversationManager(deps: ConversationManagerDeps): ConversationManager {
  const queues = new Map<string, Promise<unknown>>(); // per-key serial chain
  const hooks = new Map<string, () => void>(); // key -> detach (one listener per agent)

  const keyFor = (msg: FeishuInboundMessage): string =>
    msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`;

  const enqueueSerial = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task); // run task regardless of prior outcome
    queues.set(key, next.catch(() => undefined));
    return next;
  };

  const ensureUnderCap = async (): Promise<void> => {
    if (deps.backend.size() < deps.maxSessions) return;
    deps.backend.disposeIdle(0); // dispose all idle first
    if (deps.backend.size() >= deps.maxSessions) {
      // Everything busy: brief wait for a slot, then dispose idle again.
      await new Promise((r) => setTimeout(r, 250));
      deps.backend.disposeIdle(0);
    }
  };

  return {
    keyFor,
    async handleMessage(msg, attachments) {
      const key = keyFor(msg);
      await ensureUnderCap();
      const agent: AgentHandle = await deps.backend.ensureAgent(key);
      // Attach the fan-out listener exactly once per agent.
      if (!hooks.has(key)) {
        const detach = agent.onEvent((e) => deps.onEvent?.(key, e));
        hooks.set(key, detach);
      }
      const text = msg.text ?? msg.content ?? "";
      await enqueueSerial(key, async () => {
        try {
          await agent.followup(text, attachments);
        } catch (err) {
          deps.logger?.warn(`followup failed for ${key}: ${String(err)}`);
        }
      });
    },
    async stop(key) {
      const agent = deps.backend.get(key);
      if (agent) await agent.cancel();
    },
    sweep() {
      const n = deps.backend.disposeIdle(deps.idleTtlMs);
      return n;
    },
    size: () => deps.backend.size(),
    keys: () => [...queues.keys()],
    async disposeAll() {
      for (const detach of hooks.values()) detach();
      hooks.clear();
      await deps.backend.disposeAll();
      queues.clear();
    },
  };
}
