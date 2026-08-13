// Real DSH adapter for DshSessionBackend: wires the bridge to the live DSH
// Cordis context. This is the ONLY file that imports @deepseek-ai packages.
//
// Mapping (spec §2.3), verified against real DSH types:
//   ctx.agents.create({sessionId})          → per-conversation agent
//   agent.followup(createUserMessage(...))  → inbound Feishu message (sync, void)
//   agent.cancel({kind:'user'})             → /stop (sync, void)
//   agent.ctx.on('session/event', …)        → assistant/chunk, assistant/message, turn/end
//     SessionEvent = { type, seq, time, data: SessionEventMap[K] }
//     StreamChunk = { type:'text-delta', text } | …
//     AssistantMessage.content: ContentBlock[]  (no .text shortcut)

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {
	SessionEventOut,
	DshSessionBackend,
	AgentHandle,
	AttachmentInput,
} from "./dsh-session-backend.ts";

export interface DshAdapterDeps {
	ctx: Context;
	/** Stable session-id prefix so created sessions are bridge-owned. */
	sessionPrefix: string;
	logger?: { info(msg: string): void; warn(msg: string): void };
}

/** Agent registry surface we consume (dsh-agent). */
interface AgentRegistrySurface {
	create(opts: { sessionId: string }): Promise<AgentHandleSurface>;
	get(id: string): Agent | undefined;
}

/** The owned handle returned by agents.create — carries the disposer. */
interface AgentHandleSurface {
	agent: Agent;
	dispose(): Promise<void>;
}

function textOf(
	blocks: readonly { type: string; text?: string }[] | undefined,
): string {
	return (blocks ?? [])
		.filter((b) => b.type === "text" && b.text !== undefined)
		.map((b) => b.text)
		.join("");
}

function toSessionEventOut(ev: SessionEvent): SessionEventOut | undefined {
	switch (ev.type) {
		case "assistant/chunk": {
			const c = ev.data.chunk;
			if (c.type === "text-delta")
				return { type: "assistant/chunk", text: c.text };
			return undefined;
		}
		case "assistant/message":
			return {
				type: "assistant/message",
				text: textOf(ev.data.message.content),
			};
		case "turn/end":
			return { type: "turn/end", reason: ev.data.reason.kind };
		case "tool/call":
			return { type: "tool/call", name: ev.data.name };
		case "tool/result":
			return {
				type: "tool/result",
				name: ev.data.message.content?.[0]?.type ?? "?",
				error: ev.data.error,
			};
		default:
			return undefined;
	}
}

/** Keep track of last-use for idle TTL (bridge-owned agents only). */
interface Tracked {
	handle: AgentHandle;
	lastUsedAt: number;
}

export function createDshAdapter(deps: DshAdapterDeps): DshSessionBackend {
	const c = deps.ctx as unknown as {
		agents: AgentRegistrySurface;
	};
	const tracked = new Map<string, Tracked>();
	const keyBySession = new Map<string, string>();
	const listeners = new Map<string, Set<(e: SessionEventOut) => void>>();
	const disposers = new Map<string, () => void>();

	const bridgeKey = (key: string): string => `${deps.sessionPrefix}:${key}`;

	async function ensureAgent(key: string): Promise<AgentHandle> {
		const existing = tracked.get(key);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing.handle;
		}

		const sessionId = bridgeKey(key);
		let owned: AgentHandleSurface;
		try {
			// CreateAgentOptions.seed is `readonly SessionEvent[]` (a fork prefix);
			// a fresh per-conversation agent needs none. Passing a plain object
			// here throws "seed.entries is not a function".
			owned = await c.agents.create({ sessionId });
		} catch (err) {
			throw new Error(`failed to create DSH agent for ${key}: ${String(err)}`);
		}
		if (!owned?.agent)
			throw new Error(`DSH agents.create returned no agent for ${key}`);
		const agent = owned.agent;

		const handle: AgentHandle = {
			agentId: agent.id,
			sessionId,
			async followup(text: string, _attachments?: AttachmentInput[]) {
				const message = createUserMessage({
					content: [{ type: "text", text }],
					source: { kind: "user" },
				});
				// sync, void — errors surface via agent/error and turn/end(rejected)
				agent.followup(message);
			},
			async cancel() {
				agent.cancel({ kind: "user" });
			},
			onEvent(fn) {
				const set =
					listeners.get(key) ?? new Set<(e: SessionEventOut) => void>();
				set.add(fn);
				listeners.set(key, set);
				return () => {
					set.delete(fn);
				};
			},
			isIdle: () => agent.status === "idle",
			async dispose() {
				disposers.get(key)?.();
				disposers.delete(key);
				await owned.dispose();
				tracked.delete(key);
				keyBySession.delete(sessionId);
				listeners.delete(key);
			},
		};
		tracked.set(key, { handle, lastUsedAt: Date.now() });
		keyBySession.set(sessionId, key);

		// Agent-scoped session/event subscription → normalized bridge events.
		const disp = agent.ctx.on(
			"session/event",
			(_session: unknown, ev: SessionEvent) => {
				const out = toSessionEventOut(ev);
				if (!out) return;
				const set = listeners.get(key);
				if (set) for (const fn of set) fn(out);
			},
		);
		disposers.set(key, disp);

		return handle;
	}

	return {
		async ensureAgent(key) {
			return ensureAgent(key);
		},
		get: (key) => tracked.get(key)?.handle,
		keyForSessionId: (sessionId) => keyBySession.get(sessionId),
		disposeIdle(idleTtlMs) {
			let n = 0;
			for (const [key, t] of tracked) {
				if (t.handle.isIdle() && Date.now() - t.lastUsedAt >= idleTtlMs) {
					void t.handle.dispose();
					n++;
				}
			}
			return n;
		},
		size: () => tracked.size,
		async disposeAll() {
			for (const t of tracked.values()) await t.handle.dispose();
			tracked.clear();
			keyBySession.clear();
		},
	};
}
