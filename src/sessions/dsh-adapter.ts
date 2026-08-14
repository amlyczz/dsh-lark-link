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
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Agent, ModelSelection } from "@deepseek-ai/dsh-agent";
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
	/** Workspace root for created sessions — getter so /workspace hot-swaps. */
	cwd?: () => string;
	logger?: { info(msg: string): void; warn(msg: string): void };
}

/** Agent registry surface we consume (dsh-agent). */
interface AgentRegistrySurface {
	create(opts: {
		sessionId: string;
		meta?: {
			cwd?: string;
			parentSession?: string;
			seedLength?: number;
			origin?: "subagent";
			delegationDepth?: number;
			agentPreset?: string;
		};
		agentOptions?: {
			provider: string;
			model: string;
		};
		setup?: (agentCtx: Context) => unknown;
	}): Promise<AgentHandleSurface>;
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
		case "turn/start":
			return { type: "turn/start" };
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

	// Per-run session nonce: session ids are stable within a run (so the
	// keyBySession/route mapping stays consistent) but unique across runs, so
	// agents.create never collides with a persisted log from a previous run.
	// (Cross-restart history needs seed-based resume — follow-up.)
	const runNonce = `${Date.now().toString(36)}${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	const bridgeKey = (key: string): string =>
		`${deps.sessionPrefix}:${key}:${runNonce}`;

	async function ensureAgent(key: string): Promise<AgentHandle> {
		const existing = tracked.get(key);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing.handle;
		}

		const sessionId = bridgeKey(key);
		let owned: AgentHandleSurface;
		try {
			// The bridge creates raw agents, so — like dsh-headless — it must
			// carry the deployment default model (agentDefaultModel service) into
			// CreateAgentOptions and wire the request-waterfall selection.
			// Without this every turn fails with "agent has no provider/model"
			// and inbound messages never get a reply.
			// NB: read via ctx.get() — the Cordis Context proxy throws
			// "cannot get property ... without inject" for undeclared services.
			const defaultModel = (
				c as unknown as {
					get?(name: string):
						| {
								currentSelection(): ModelSelection | undefined;
						  }
						| undefined;
				}
			)
				.get?.("agentDefaultModel")
				?.currentSelection?.();
			const agentOptions = defaultModel
				? {
						provider: defaultModel.provider,
						model: defaultModel.model,
					}
				: undefined;
			if (!defaultModel) {
				deps.logger?.warn(
					`no agentDefaultModel service — bridge agent for ${key} has no provider/model; turns will fail unless one is supplied`,
				);
			}
			owned = await c.agents.create({
				sessionId,
				// cwd is REQUIRED: prompt sections like deployment:persona interpolate
				// {{cwd}} — a session without it fails assembly with
				// "prompt variable \"{{cwd}}\" has no value for this assembly".
				// agentPreset: the web profile disables tool rows at the host plane
				// and mounts them per-session via presets — without "standard" the
				// bridge agent has NO bash/fs/goal/subagent tools (session-log
				// evidence: `Error: unknown tool "bash"` / "write_file" / …).
				meta: { cwd: deps.cwd?.() ?? process.cwd(), agentPreset: "standard" },
				...(agentOptions ? { agentOptions } : {}),
				...(defaultModel
					? {
							setup: (agentCtx: Context) => {
								installModelSelection(agentCtx, {
									current: defaultModel,
									assembled: undefined,
								});
								return undefined; // void — the disposer is agentCtx-scoped
							},
						}
					: {}),
			});
		} catch (err) {
			throw new Error(
				`failed to create DSH agent for ${key}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (!owned?.agent)
			throw new Error(`DSH agents.create returned no agent for ${key}`);
		const agent = owned.agent;

		const handle: AgentHandle = {
			agentId: agent.id,
			sessionId,
			async followup(text: string, attachments?: AttachmentInput[]) {
				// Attach inbound Feishu images as ImageBlocks (visual model) and fold
				// extracted file text into the prompt — the text stays first so the
				// model sees the message context.
				const parts = [text];
				const content: Array<Record<string, unknown>> = [
					{ type: "text", text },
				];
				for (const a of attachments ?? []) {
					if (a.kind === "image" && a.imageRef) {
						content.push({ type: "image", attachment: a.imageRef });
					} else if (a.kind === "file" && a.textPreview) {
						parts.push(`\n\n[附件 ${a.name ?? "文件"} 内容]\n${a.textPreview}`);
					} else if (a.kind === "file") {
						parts.push(`\n\n[附件 ${a.name ?? "文件"}（未能提取文本）]`);
					}
				}
				content[0] = { type: "text", text: parts.join("") };
				const message = createUserMessage({
					content: content as never,
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
			for (const t of tracked.values()) {
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
