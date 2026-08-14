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

import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
	/**
	 * Stable per-deployment nonce — persisted across restarts so bridge session
	 * ids survive dsh reloads (otherwise every restart opens a NEW GUI session
	 * row and the conversation appears to 'switch sessions' mid-chat).
	 */
	runNonce?: string;
	/** Workspace root for created sessions — getter so /workspace hot-swaps. */
	cwd?: () => string;
	/** Agent preset id for created sessions — getter so /mode hot-swaps. */
	preset?: () => string;
	/**
	 * LIVE model selection — the same mutable object for every agent, read by
	 * installModelSelection on each request. Updating its fields switches the
	 * model WITHOUT rebuilding the agent (the session survives /model).
	 */
	modelSelection?: { current: { provider: string; model: string } };
	/**
	 * ask_user_question → Feishu bridge. When present, a shadow
	 * `ask_user_question` tool is registered in each agent scope (overriding
	 * the preset's global tool) that forwards the question to Feishu cards and
	 * waits for the user's answer.
	 */
	askUserQuestion?: (
		questions: Array<{
			id: string;
			question: string;
			header?: string;
			options?: Array<{ label: string; description?: string }>;
			multiSelect?: boolean;
		}>,
		agentId: string,
	) => Promise<{
		answers: Array<{ id: string; selected: string[]; custom?: string }>;
	}>;
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
	let runNonce =
		deps.runNonce ??
		`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	// Per-key generation: /new bumps it so the next agent gets a FRESH session
	// id (a new GUI conversation row) instead of reusing the same log.
	const generations = new Map<string, number>();
	const bridgeKey = (key: string): string =>
		`${deps.sessionPrefix}:${key}:${runNonce}:${generations.get(key) ?? 0}`;

	async function ensureAgent(key: string): Promise<AgentHandle> {
		const existing = tracked.get(key);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing.handle;
		}

		let sessionId = bridgeKey(key);
		let owned: AgentHandleSurface;
		// The bridge creates raw agents, so — like dsh-headless — it must
		// carry the deployment default model (agentDefaultModel service) into
		// CreateAgentOptions and wire the request-waterfall selection.
		// Without this every turn fails with "agent has no provider/model"
		// and inbound messages never get a reply.
		// NB: read via ctx.get() — the Cordis Context proxy throws
		// "cannot get property ... without inject" for undeclared services.
		const sel = deps.modelSelection?.current;
		const defaultModel = sel?.provider && sel.model ? sel : undefined;
		const agentOptions = defaultModel
			? {
					provider: defaultModel.provider,
					model: defaultModel.model,
				}
			: undefined;
		if (!defaultModel) {
			deps.logger?.warn(
				`no model selection — bridge agent for ${key} has no provider/model; turns will fail unless one is supplied`,
			);
		}
		// Shared composition for both create and resume (see the already-exists
		// fallback in the catch below): model selection, agent preset mount,
		// and the ask_user_question shadow tool must exist on a resumed agent
		// exactly as on a freshly created one.
		const setup = async (agentCtx: Context) => {
			// Model selection (optional — depends on the deployment
			// agentDefaultModel service).
			if (deps.modelSelection?.current) {
				installModelSelection(agentCtx, {
					current: deps.modelSelection.current,
					assembled: undefined,
				});
			}
			// Mount the "standard" preset into the agent scope —
			// exactly what the GUI path does via apiproxy's
			// composeAgent. Without this the web profile's host-plane
			// tool rows stay disabled and the bridge agent has NO
			// bash/fs/goal/subagent tools (session-log evidence:
			// `Error: unknown tool "bash"` / "write_file" / …).
			const presets = (
				c as unknown as {
					get?(name: string):
						| {
								mount?(agentCtx: Context, presetId: string): Promise<unknown>;
						  }
						| undefined;
				}
			).get?.("agentPresets");
			if (presets?.mount) {
				await presets.mount(agentCtx, deps.preset?.() ?? "ptc");
			}
			// Shadow ask_user_question: forward DSH intent-confirmation
			// questions to Feishu cards instead of the GUI-only provider.
			if (deps.askUserQuestion) {
				const askTool = defineTool({
					name: "ask_user_question",
					description:
						"Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.",
					parameters: {
						questions: {
							type: "array",
							required: true,
							description: "Questions to ask the user before continuing.",
							items: {
								type: "object",
								additionalProperties: true,
								properties: {
									id: {
										type: "string",
										required: true,
										description:
											"Stable id for this question; echoed in the answer.",
									},
									question: {
										type: "string",
										required: true,
										description: "The specific question to ask the user.",
									},
									header: {
										type: "string",
										description: "Optional short heading for the question.",
									},
									options: {
										type: "array",
										description: "Optional choices to show the user.",
										items: {
											type: "object",
											additionalProperties: true,
											properties: {
												label: {
													type: "string",
													required: true,
													description: "Short user-facing option label.",
												},
												description: {
													type: "string",
													description:
														"One sentence explaining the tradeoff or impact.",
												},
											},
										},
									},
									multi_select: {
										type: "boolean",
										description:
											"Whether the user may select more than one option. Defaults to false.",
									},
								},
							},
						},
					},
					output: {
						schema: {
							type: "object",
							additionalProperties: false,
							properties: {
								answers: {
									type: "array",
									required: true,
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											id: {
												type: "string",
												required: true,
											},
											selected: {
												type: "array",
												required: true,
												items: { type: "string" },
											},
											custom: { type: "string" },
										},
									},
								},
							},
						},
						render: (_args, value) => [
							{ type: "text", text: JSON.stringify(value) },
						],
					},
					async execute(args, exec) {
						if (!deps.askUserQuestion) return { answers: [] };
						const questions = (args.questions ?? []).map(
							(q: {
								id: string;
								question: string;
								header?: string;
								options?: Array<{
									label: string;
									description?: string;
								}>;
								multi_select?: boolean;
							}) => ({
								id: q.id,
								question: q.question,
								...(q.header !== undefined ? { header: q.header } : {}),
								...(q.options !== undefined ? { options: q.options } : {}),
								...(q.multi_select !== undefined
									? { multiSelect: q.multi_select }
									: {}),
							}),
						);
						const agentId =
							(exec as { agent?: { id?: string } }).agent?.id ?? "";
						return deps.askUserQuestion(questions, agentId);
					},
				});
				(
					agentCtx as unknown as {
						tools?: { register?(t: unknown): unknown };
					}
				).tools?.register?.(askTool);
			}
			return undefined; // void — disposer is agentCtx-scoped
		};
		try {
			owned = await c.agents.create({
				sessionId,
				// cwd is REQUIRED: prompt sections like deployment:persona interpolate
				// {{cwd}} — a session without it fails assembly with
				// "prompt variable \"{{cwd}}\" has no value for this assembly".
				// agentPreset: the web profile disables tool rows at the host plane
				// and mounts them per-session via presets — without "standard" the
				// bridge agent has NO bash/fs/goal/subagent tools (session-log
				// evidence: `Error: unknown tool \"bash\"` / "write_file" / …).
				meta: {
					cwd: deps.cwd?.() ?? process.cwd(),
					agentPreset: deps.preset?.() ?? "ptc",
				},
				...(agentOptions ? { agentOptions } : {}),
				setup,
			});
		} catch (err) {
			// runNonce is persisted across restarts (352af88) so the session id
			// can already exist in the DSH store when a restarted bridge tries
			// to create it again — the store refuses (session "…" already
			// exists). Resume the persisted session instead of failing: the
			// agent identity survives, the GUI keeps the same conversation row,
			// and the event wiring below works identically for a resumed agent.
			if (err instanceof Error && /already exists/.test(err.message)) {
				// The persisted session id is taken. dsh-agent-loop's resume is
				// UNUSABLE here: it returns successfully, but the first turn then
				// fails with "already has a persisted log on disk that does not
				// match this live session (id collision)" — the mismatch check is
				// lazy (deferred to turn time). So don't resume; mint a FRESH
				// run nonce and create a brand-new session instead. The old log
				// is left in place (orphaned, harmless); the GUI gets a new
				// conversation row, and the message gets a reply.
				deps.logger?.warn(
					`session id taken for ${key} — minting fresh session (resume is broken for mismatched logs)`, 
				);
				runNonce = `${Date.now().toString(36)}${Math.random()
					.toString(36)
					.slice(2, 6)}`;
				const freshId = bridgeKey(key);
				owned = await c.agents.create({
					sessionId: freshId,
					meta: {
						cwd: deps.cwd?.() ?? process.cwd(),
						agentPreset: deps.preset?.() ?? "ptc",
					},
					...(agentOptions ? { agentOptions } : {}),
					setup,
				});
				// The fresh session has a new id — subsequent wiring (handle
				// sessionId, keyBySession) must use it, not the collided id.
				sessionId = freshId;
			} else {
				throw new Error(
					`failed to create DSH agent for ${key}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		if (!owned?.agent)
			throw new Error(`DSH agents.create returned no agent for ${key}`);
		// Ensure a durable workspace record exists for the session cwd AND the
		// session is attached to it — otherwise the GUI lists the session under
		// 未分组 (workspaces are only created+attached when a user picks one in
		// the UI). Best-effort; failures are logged, never fatal.
		const wsCwd = deps.cwd?.() ?? process.cwd();
		try {
			const workspaces = (
				c as unknown as {
					get?(name: string):
						| {
								create?(
									path: string,
									title?: string,
								): Promise<
									| {
											attachSession?(sessionId: string): Promise<unknown>;
									  }
									| undefined
								>;
						  }
						| undefined;
				}
			).get?.("workspaceRegistry");
			if (workspaces?.create) {
				const entity = await workspaces.create(wsCwd, basename(wsCwd));
				deps.logger?.info(
					`workspace create: ${wsCwd} (${entity ? "entity" : "none"})`,
				);
				if (entity?.attachSession) {
					await entity.attachSession(sessionId);
					deps.logger?.info(`workspace attach: ${sessionId} -> ${wsCwd}`);
				} else {
					deps.logger?.warn(
						`workspace attach skipped: entity has no attachSession (${wsCwd})`,
					);
				}
			} else {
				deps.logger?.warn(
					`workspaceRegistry unavailable — session ${sessionId} will show under 未分组`,
				);
			}
		} catch (err) {
			deps.logger?.warn(
				`workspace create/attach failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
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

		// Surface agent-loop failures that dsh-agent-loop's kick() swallows
		// (its driver catch is empty). Without this, a turn that dies in
		// prepareCall/step (e.g. missing provider/model after resume) is
		// completely silent — no reply, no log. This makes it observable.
		const errDisp = agent.ctx.on(
			"agent/error",
			(payload: { error?: unknown }) => {
				deps.logger?.warn(
					`agent error for ${key}: ${payload.error instanceof Error ? payload.error.message : String(payload.error)}`,
				);
			},
		);
		disposers.set(key, errDisp);

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
		rotate(key) {
			generations.set(key, (generations.get(key) ?? 0) + 1);
			// /new: the OLD agent must no longer be reused (next message opens a
			// fresh session row), but it must NOT be torn down via
			// handle.dispose() — that removes its session from the store and the
			// previous conversation vanishes from the GUI list. Lightweight
			// detach: drop listeners + tracking so the old session id stays
			// listed; the agent idles out via the TTL sweep.
			const t = tracked.get(key);
			if (t) {
				disposers.get(key)?.();
				disposers.delete(key);
				listeners.delete(key);
				tracked.delete(key);
				const oldId = t.handle.sessionId;
				if (oldId) keyBySession.delete(oldId);
			}
		},
		async dispose(key) {
			const t = tracked.get(key);
			if (!t) return;
			await t.handle.dispose();
			tracked.delete(key);
		},
		async disposeAll() {
			for (const t of tracked.values()) await t.handle.dispose();
			tracked.clear();
			keyBySession.clear();
		},
	};
}
