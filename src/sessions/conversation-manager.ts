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
import { stripLeadingMentions } from "../application/command-router.ts";

export interface ConversationManagerDeps {
	backend: DshSessionBackend;
	/** Max concurrently hosted sessions; idle ones are evicted beyond the cap. */
	maxSessions: number;
	idleTtlMs: number;
	/** Bridge fan-out: every session event for a conversation key. */
	onEvent?: (key: string, event: SessionEventOut) => void;
	logger?: { info(msg: string): void; warn(msg: string): void };
	now?: () => number;
}

export interface ConversationManager {
	/** Handle an inbound Feishu message: enqueue into the per-key FIFO. */
	handleMessage(
		msg: FeishuInboundMessage,
		attachments?: AttachmentInput[],
	): Promise<void>;
	/** Key for a message (dm:* for p2p, group:* for group chats). */
	keyFor(msg: FeishuInboundMessage): string;
	/** Cancel the current turn of one conversation (does not touch others). */
	stop(key: string): Promise<void>;
	/** Dispose one conversation's agent (next message rebuilds it under new config). */
	dispose(key: string): Promise<void>;
	/** /new — bump session generation and dispose, so the next message starts fresh. */
	rotate(key: string): Promise<void>;
	/** Reap idle agents; returns disposed count. */
	sweep(): number;
	size(): number;
	keys(): string[];
	disposeAll(): Promise<void>;
}

export function createConversationManager(
	deps: ConversationManagerDeps,
): ConversationManager {
	const queues = new Map<string, Promise<unknown>>(); // per-key serial chain
	const hooks = new Map<string, () => void>(); // key -> detach (one listener per agent)
	const hooksAgent = new Map<string, string>(); // key -> agentId (detect stale hook after idle disposal)

	const keyFor = (msg: FeishuInboundMessage): string =>
		msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`;

	const enqueueSerial = <T>(
		key: string,
		task: () => Promise<T>,
	): Promise<T> => {
		const prev = queues.get(key) ?? Promise.resolve();
		const next = prev.then(task, task); // run task regardless of prior outcome
		queues.set(
			key,
			next.catch(() => undefined),
		);
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
			// Re-attach if the agent changed (e.g. after idle disposal + recreation,
			// the old hook is stale and won't forward the new agent's events).
			const prevAgentId = hooksAgent.get(key);
			if (!hooks.has(key) || prevAgentId !== agent.agentId) {
				hooks.get(key)?.(); // detach stale hook (no-op if same agent)
				const detach = agent.onEvent((e) => deps.onEvent?.(key, e));
				hooks.set(key, detach);
				hooksAgent.set(key, agent.agentId);
			}
			const rawText = msg.text ?? msg.content ?? "";
			const text = stripLeadingMentions(rawText) || rawText;
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
		async dispose(key) {
			hooks.get(key)?.();
			hooks.delete(key);
			hooksAgent.delete(key);
			queues.delete(key);
			await deps.backend.dispose(key);
		},
		async rotate(key) {
			// /new must NOT dispose the old agent: AgentHandle.dispose() stops the
			// loop AND removes the session from the store (dsh-agent docs), which
			// makes the previous conversation vanish from the GUI session list
			// even though its log survives on disk. Bump the generation so the
			// next message opens a NEW session row; the old agent idles out via
			// the TTL sweep and its session stays listed.
			// BUT the old fan-out listener must be dropped too: handleMessage
			// attaches exactly one listener per key (hooks.has guard), so a stale
			// hook would swallow the NEW agent's events — no reply after /new.
			hooks.get(key)?.();
			hooks.delete(key);
			hooksAgent.delete(key);
			queues.delete(key);
			deps.backend.rotate(key);
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
			hooksAgent.clear();
			await deps.backend.disposeAll();
			queues.clear();
		},
	};
}
