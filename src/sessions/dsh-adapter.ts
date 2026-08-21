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
	/** Workspace root for created sessions — per-key getter so /workspace
	 * hot-swaps ONE conversation without touching others. */
	cwd?: (key: string) => string;
	/** Agent preset id for created sessions — per-key getter so /mode
	 * hot-swaps ONE conversation without touching others. */
	preset?: (key: string) => string;
	/**
	 * LIVE model selection. currentFor(key) returns the mutable object the
	 * agent for that conversation reads via installModelSelection on each
	 * request; updating its fields switches the model WITHOUT rebuilding the
	 * agent. Legacy shape {current} is still accepted (shared by all keys).
	 */
	modelSelection?:
		| { current: { provider: string; model: string } }
		| { currentFor: (key: string) => { provider: string; model: string } | undefined };
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
	/**
	 * Bridge permission preset (read-only | workspace-write |
	 * danger-full-access), applied PER SESSION at agent creation and resume
	 * (GH #8) — the bridge never writes the host's global permission default
	 * anymore; this knob governs bridge sessions only.
	 */
	permissionMode?: () => string;
	/** Active session id for this conversation (e.g. persisted across dsh restarts). */
	activeSessionId?: (key: string) => string | undefined;
	/** Callback to persist the active session id for this conversation. */
	setActiveSessionId?: (key: string, sessionId: string | undefined) => void;
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
	/** Load a persisted session and resume an agent on it (/resume). */
	resume(opts: {
		resumeSessionId: string;
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
	const raw = ev as unknown as { type: string; data?: any };
	switch (raw.type) {
		case "turn/start":
			return { type: "turn/start" };
		case "assistant/chunk": {
			const c = raw.data?.chunk;
			if (c?.type === "text-delta")
				return { type: "assistant/chunk", text: c.text };
			return undefined;
		}
		case "assistant/message":
			return {
				type: "assistant/message",
				text: textOf(raw.data?.message?.content),
			};
		case "turn/end":
			return { type: "turn/end", reason: raw.data?.reason?.kind ?? "done" };
		case "tool/call":
			return { type: "tool/call", name: raw.data?.name };
		case "tool/result":
			return {
				type: "tool/result",
				name: raw.data?.message?.content?.[0]?.type ?? "?",
				error: raw.data?.error,
			};
		case "todo/write": {
			const d = raw.data as { todos?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> };
			if (Array.isArray(d?.todos)) {
				return { type: "todo/write", todos: d.todos };
			}
			return undefined;
		}
		case "goal/change": {
			const d = raw.data as {
				id?: string;
				revision?: number;
				objective?: string;
				phase?: "active" | "paused" | "blocked" | "complete";
				roundsStarted?: number;
				maxGoalRounds?: number;
				blockedReason?: { code: string; message: string };
				createdAt?: number;
				updatedAt?: number;
				snapshot?: Record<string, unknown>;
			};
			const g = d?.snapshot ?? d;
			if (g && typeof g.id === "string" && typeof g.objective === "string") {
				return {
					type: "goal/change",
					goal: {
						id: g.id as string,
						revision: typeof g.revision === "number" ? g.revision : 1,
						objective: g.objective as string,
						phase: (g.phase as "active" | "paused" | "blocked" | "complete") || "active",
						roundsStarted: typeof g.roundsStarted === "number" ? g.roundsStarted : 0,
						maxGoalRounds: typeof g.maxGoalRounds === "number" ? g.maxGoalRounds : 256,
						blockedReason: g.blockedReason as { code: string; message: string } | undefined,
						createdAt: typeof g.createdAt === "number" ? g.createdAt : Date.now(),
						updatedAt: typeof g.updatedAt === "number" ? g.updatedAt : Date.now(),
					},
				};
			}
			return undefined;
		}
		default:
			return undefined;
	}
}



export function isImageUnsupportedError(
	errText: string,
	errCode?: string,
): boolean {
	if (
		errCode === "UNSUPPORTED_CONTENT" &&
		/image|vision|multimodal|content/i.test(errText)
	)
		return true;
	return (
		/does not support image/i.test(errText) ||
		/does not support .*image/i.test(errText) ||
		/adapter does not support image/i.test(errText) ||
		/model .* does not support image/i.test(errText) ||
		(/model does not support/i.test(errText) &&
			/image|vision/i.test(errText)) ||
		/image (?:input|content) is not supported/i.test(errText) ||
		/not support (?:image|images|vision|multimodal)/i.test(errText) ||
		/unsupported (?:image|content|content_type)/i.test(errText) ||
		/cannot represent .*image/i.test(errText) ||
		/image.*requires the durable attachment service/i.test(errText) ||
		/UNSUPPORTED_CONTENT/i.test(errText)
	);
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
	// Per-key model selection: prefer the per-conversation resolver, fall back
	// to the legacy shared {current} object. The returned object is expected
	// to be STABLE and MUTABLE per key (installModelSelection keeps a
	// reference; mutating its fields switches the model on the next request).
	const selFor = (
		key: string,
	): { provider: string; model: string } | undefined => {
		const ms = deps.modelSelection;
		if (!ms) return undefined;
		if ("currentFor" in ms) return ms.currentFor(key);
		return ms.current;
	};
	const tracked = new Map<string, Tracked>();
	const keyBySession = new Map<string, string>();
	const listeners = new Map<string, Set<(e: SessionEventOut) => void>>();
	const disposers = new Map<string, () => void>();
	// Per-key in-flight agent creation. ensureAgent(key) can be called
	// concurrently (an outbox outbound re-reply racing a live inbound message
	// right after a DSH restart). Both calls would otherwise see an empty
	// `tracked`, both call agents.create with the SAME stable sessionId, and
	// the losing call hits "session … already exists" — minting a duplicate
	// agent and mutating the global runNonce. Collapse them into one creation.
	const ensureInFlight = new Map<string, Promise<AgentHandle>>();

	// Per-run session nonce: session ids are stable within a run (so the
	// keyBySession/route mapping stays consistent) but unique across runs, so
	// agents.create never collides with a persisted log from a previous run.
	// (Cross-restart history needs seed-based resume — follow-up.)
	let runNonce =
		deps.runNonce ??
		`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	// Per-key generation: /new bumps it so the next agent gets a FRESH session
	// id without colliding with the persisted log from the previous generation.
	const generations = new Map<string, number>();
	const bridgeKey = (key: string): string =>
		`${deps.sessionPrefix}:${key}:${runNonce}:${generations.get(key) ?? 0}`;
	// /resume: a pending resume target makes the NEXT ensureAgent load the
	// persisted log via agents.resume instead of creating; the stored preset
	// override pins the recomposition (resume must mount the world the
	// history was recorded with, not the conversation's current /mode).
	const pendingResume = new Map<string, { sessionId: string }>();
	const presetOverrides = new Map<string, string>();
	// Non-vision model degrade (observed: pi-ai model "qwen3.8-27b", "glm-5.3",
	// deepseek chat-completions adapter rejecting image blocks).
	// Once a conversation or model rejects an ImageBlock we remember it and
	// never attach one again — images degrade to the local-path note (model
	// reads them with read_image or shell/code), and the in-flight turn is
	// retried text-only after the agent settles idle so it still produces a reply.
	const imageUnsupportedKeys = new Set<string>();
	const imageUnsupportedModels = new Set<string>();
	// One-shot marker set when a degrade retry is issued; consumed by the
	// bridge's silent-turn recovery (see DshSessionBackend.consumeImageRetryGrace).
	const imageRetryGrace = new Set<string>();
	const pendingImageRetry = new Map<
		string,
		ReturnType<typeof createUserMessage>
	>();
	// Detach a key's live agent WITHOUT disposing it (rotate / resume): drop
	// listeners + tracking so the old session row stays listed in the GUI and
	// its persisted log survives; mint a fresh runNonce so any later create
	// can never collide with the old id family.
	const rotateKey = (key: string): void => {
		// A stale text-only twin must not survive rotation — the turn it
		// belonged to is gone. (imageUnsupported intentionally persists:
		// the model's lack of image support does not change with the session.)
		pendingImageRetry.delete(key);
		runNonce = `${Date.now().toString(36)}${Math.random()
			.toString(36)
			.slice(2, 6)}`;
		generations.delete(key);
		presetOverrides.delete(key);
		deps.setActiveSessionId?.(key, undefined);
		const t = tracked.get(key);
		if (t) {
			disposers.get(key)?.();
			disposers.delete(key);
			listeners.delete(key);
			tracked.delete(key);
			const oldId = t.handle.sessionId;
			if (oldId) keyBySession.delete(oldId);
		}
	};

	async function ensureAgent(key: string): Promise<AgentHandle> {
		const existing = tracked.get(key);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing.handle;
		}
		// Collapse concurrent ensureAgent(key) calls into a single creation:
		// the second caller awaits the same in-flight promise instead of racing
		// a duplicate agents.create (see ensureInFlight above).
		const inFlight = ensureInFlight.get(key);
		if (inFlight) {
			return inFlight.then((h) => {
				const t = tracked.get(key);
				if (t) t.lastUsedAt = Date.now();
				return h;
			});
		}

		const p = (async (): Promise<AgentHandle> => {

		// /resume: a pending target loads the PERSISTED session through
		// agents.resume (factory awaits sessionPersistence.prepare) instead
		// of creating — the agent identity, GUI row and event wiring are all
		// identical afterwards.
		const pending = pendingResume.get(key);
		let sessionId = pending?.sessionId ?? bridgeKey(key);
		let owned: AgentHandleSurface;
		// The bridge creates raw agents, so — like dsh-headless — it must
		// carry the deployment default model (agentDefaultModel service) into
		// CreateAgentOptions and wire the request-waterfall selection.
		// Without this every turn fails with "agent has no provider/model"
		// and inbound messages never get a reply.
		// NB: read via ctx.get() — the Cordis Context proxy throws
		// "cannot get property ... without inject" for undeclared services.
		const sel = selFor(key);
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
		// exactly as on a freshly created one. `presetOverride` pins the
		// STORED preset of a resumed session (resume must recompose the same
		// world the history was recorded with, not the current override).
		const setup = async (agentCtx: Context) => {
			// Model selection (optional — depends on the deployment
			// agentDefaultModel service). Per-key live object: mutating it (via
			// /model or a GUI default switch) changes the model WITHOUT rebuild.
			const sel = selFor(key);
			if (sel?.provider && sel.model) {
				installModelSelection(agentCtx, {
					current: sel,
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
				await presets.mount(
				agentCtx,
				presetOverrides.get(key) ?? deps.preset?.(key) ?? "ptc",
			);
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
		if (pending) {
			// Resume path — the persisted session id is EXPLICIT, there is no
			// create/collision concern; a failure here must surface to /resume.
			try {
				owned = await c.agents.resume({
					resumeSessionId: pending.sessionId,
					...(agentOptions ? { agentOptions } : {}),
					setup,
				});
				sessionId = pending.sessionId;
				deps.setActiveSessionId?.(key, sessionId);
			} catch (err) {
				throw new Error(
					`failed to resume session "${pending.sessionId}" for ${key}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else {
			// If there is an active session recorded for this conversation (e.g. before dsh restart),
			// resume it so the conversation continues in the same session.
			const activeId = deps.activeSessionId?.(key);
			let resumedOwned: AgentHandleSurface | undefined;
			if (activeId) {
				try {
					resumedOwned = await c.agents.resume({
						resumeSessionId: activeId,
						...(agentOptions ? { agentOptions } : {}),
						setup,
					});
					sessionId = activeId;
				} catch (err) {
					deps.logger?.warn(
						`failed to resume active session "${activeId}" for ${key}: ${err instanceof Error ? err.message : String(err)} — falling back to create fresh session`,
					);
				}
			}

			if (resumedOwned) {
				owned = resumedOwned;
			} else {
				sessionId = bridgeKey(key);
				try {
					owned = await c.agents.create({
						sessionId,
						meta: {
							cwd: deps.cwd?.(key) ?? process.cwd(),
							agentPreset: deps.preset?.(key) ?? "ptc",
						},
						...(agentOptions ? { agentOptions } : {}),
						setup,
					});
					deps.setActiveSessionId?.(key, sessionId);
				} catch (err) {
					if (err instanceof Error && /already exists|already has a persisted log/i.test(err.message)) {
						try {
							owned = await c.agents.resume({
								resumeSessionId: sessionId,
								...(agentOptions ? { agentOptions } : {}),
								setup,
							});
							deps.setActiveSessionId?.(key, sessionId);
						} catch (resumeErr) {
							deps.logger?.warn(
								`session id collision for ${key} and resume failed — minting fresh session: ${String(resumeErr)}`,
							);
							runNonce = `${Date.now().toString(36)}${Math.random()
								.toString(36)
								.slice(2, 6)}`;
							const freshId = bridgeKey(key);
							try {
								owned = await c.agents.create({
									sessionId: freshId,
									meta: {
										cwd: deps.cwd?.(key) ?? process.cwd(),
										agentPreset: deps.preset?.(key) ?? "ptc",
									},
									...(agentOptions ? { agentOptions } : {}),
									setup,
								});
								sessionId = freshId;
								deps.setActiveSessionId?.(key, sessionId);
							} catch (err2) {
								throw new Error(
									`failed to mint fresh session for ${key} (was "${sessionId}"): ${err2 instanceof Error ? err2.message : String(err2)}`,
								);
							}
						}
					} else {
						throw new Error(
							`failed to create DSH agent for ${key}: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}
		}
		if (!owned?.agent)
			throw new Error(`DSH agents.create returned no agent for ${key}`);
		// Ensure a durable workspace record exists for the session cwd AND the
		// session is attached to it — otherwise the GUI lists the session under
		// 未分组 (workspaces are only created+attached when a user picks one in
		// the UI). Best-effort; failures are logged, never fatal.
		const wsCwd = deps.cwd?.(key) ?? process.cwd();
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

		// GH #8: scope the bridge's permissionMode to THIS session — the same
		// pattern the /permission handler uses — instead of writing the host's
		// global settings document (which silently flipped the deployment-wide
		// default, including non-Feishu sessions). Best-effort, never fatal;
		// absent services (bare host) just leave the composed default.
		try {
			const services = c as unknown as {
				get?(name: string): unknown;
			};
			const permission = services.get?.("permissionPresets") as
				| {
						apply?(
							session: unknown,
							name: string,
							setApproval: (policy: string) => void,
						): void;
				  }
				| undefined;
			const approval = services.get?.("approval") as
				| { setPolicy?(agent: unknown, policy: string): unknown }
				| undefined;
			const mode = deps.permissionMode?.();
			if (permission?.apply && agent.session && mode) {
				permission.apply(agent.session, mode, (policy) => {
					approval?.setPolicy?.(agent, policy);
				});
				deps.logger?.info(`permission for ${key} set to ${mode} (session-scoped)`);
			}
		} catch (err) {
			deps.logger?.warn(
				`permission apply failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const handle: AgentHandle = {
			agentId: agent.id,
			sessionId,
			async followup(text: string, attachments?: AttachmentInput[]) {
				// Attach inbound Feishu images as ImageBlocks (visual model) and fold
				// extracted file text into the prompt — the text stays first so the
				// model sees the message context.
				// An image is NEVER silent: with an imageRef it becomes an
				// ImageBlock, and whenever a real local file exists its path is
				// folded into the text too — a non-vision model (or one that
				// wants to re-read/transform the pixels with tools) can still
				// act on it. Previously an image without imageRef (attachments
				// service absent at load time) vanished without a trace and
				// the model answered "I don't see any image".
				const parts = [text];
				const content: Array<Record<string, unknown>> = [
					{ type: "text", text },
				];
				const currentModel = selFor(key);
				const modelTag =
					currentModel?.provider && currentModel?.model
						? `${currentModel.provider}/${currentModel.model}`
						: undefined;
				const isUnsupported =
					imageUnsupportedKeys.has(key) ||
					(modelTag ? imageUnsupportedModels.has(modelTag) : false);

				for (const a of attachments ?? []) {
					if (a.kind === "image") {
						if (a.imageRef && !isUnsupported) {
							content.push({ type: "image", attachment: a.imageRef });
						}
						if (a.path && !a.path.startsWith("feishu://")) {
							parts.push(
								`\n\n[用户发送了图片，已保存到本地: ${a.path}（需要查看时用 read_image 工具读取该路径）]`,
							);
						} else if (!a.imageRef) {
							parts.push("\n\n[用户发送了图片，但未能保存（无附件服务）]");
						}
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
				if (content.length > 1) {
					// ImageBlock(s) attached: keep a text-only twin so an
					// image-unsupported model error can retry this very turn
					// without the blocks (path note is already in the text).
					pendingImageRetry.set(
						key,
						createUserMessage({
							content: [content[0]] as never,
							source: { kind: "user" },
						}),
					);
				} else {
					pendingImageRetry.delete(key);
				}
				// sync, void — errors surface via agent/error and turn/end(rejected)
				agent.followup(message);
			},
			rawAgent: agent,
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
				pendingImageRetry.delete(key);
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
				const errText =
					payload.error instanceof Error
						? payload.error.message
						: String(payload.error);
				const errObj = payload.error as Record<string, unknown> | undefined;
				const errCode = (errObj?.code ??
					(errObj?.failure as Record<string, unknown> | undefined)?.code) as
					| string
					| undefined;
				deps.logger?.warn(`agent error for ${key}: ${errText}`);
				// Non-vision model: degrade instead of dying. Mark the
				// conversation and model (future images → path note only) and retry
				// the in-flight turn without the ImageBlocks so the user
				// still gets a reply instead of "turn ended: error".
				if (isImageUnsupportedError(errText, errCode)) {
					imageUnsupportedKeys.add(key);
					const currentModel = selFor(key);
					if (currentModel?.provider && currentModel?.model) {
						imageUnsupportedModels.add(
							`${currentModel.provider}/${currentModel.model}`,
						);
					}
					const retry = pendingImageRetry.get(key);
					if (retry) {
						pendingImageRetry.delete(key);
						imageRetryGrace.add(key);
						// IMPORTANT: Defer followup() until after the agent loop finishes
						// unwinding the errored turn and returns to idle. Inside throwError()
						// the agent is still "running" and wakeup requests sent without an
						// abort signal are not latched, which would leave the retry permanently
						// stuck in the inbox.
						void (async () => {
							try {
								if (
									typeof (agent as { whenIdle?: () => Promise<void> }).whenIdle ===
									"function"
								) {
									await (agent as { whenIdle: () => Promise<void> }).whenIdle();
								}
								agent.followup(retry);
								deps.logger?.info(
									`model rejects image input for ${key}; retried text-only (image stays on disk, read_image available)`,
								);
							} catch (err) {
								deps.logger?.warn(
									`text-only retry failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
								);
							}
						})();
					}
				}
			},
		);
		disposers.set(key, errDisp);

			return handle;
		})();
		ensureInFlight.set(key, p);
		try {
			return await p;
		} finally {
			ensureInFlight.delete(key);
		}
	}

	return {
		consumeImageRetryGrace(key: string): boolean {
			if (imageRetryGrace.has(key)) {
				imageRetryGrace.delete(key);
				return true;
			}
			return false;
		},
		clearImageUnsupported(key?: string) {
			if (key) {
				imageUnsupportedKeys.delete(key);
			} else {
				imageUnsupportedKeys.clear();
				imageUnsupportedModels.clear();
			}
		},
		async ensureAgent(key) {
			return ensureAgent(key);
		},
		async resumeAgent(key, sessionId, opts) {
			// If this conversation already owns this exact live session, return it directly.
			const existingCurrent = tracked.get(key);
			if (existingCurrent && existingCurrent.handle.sessionId === sessionId) {
				return existingCurrent.handle;
			}

			// If sessionId is currently held by an active agent in tracked, dispose the old agent
			// so the session is retired from ctx.sessions before agents.resume prepares it.
			const oldOwnerKey = keyBySession.get(sessionId);
			if (oldOwnerKey) {
				const oldT = tracked.get(oldOwnerKey);
				if (oldT) {
					disposers.get(oldOwnerKey)?.();
					disposers.delete(oldOwnerKey);
					listeners.delete(oldOwnerKey);
					tracked.delete(oldOwnerKey);
					keyBySession.delete(sessionId);
					try {
						await oldT.handle.dispose();
					} catch {
						// best-effort
					}
				}
			}

			// If any root agent in c.agents is holding this session, dispose it to free the session from ctx.sessions
			try {
				const roots = (c.agents as unknown as { roots?(): Array<{ id?: string; session?: { id?: string }; dispose?(): Promise<void> }> })?.roots?.() ?? [];
				for (const root of roots) {
					if (root.session?.id === sessionId && typeof root.dispose === "function") {
						try {
							await root.dispose();
						} catch {
							// best-effort
						}
					}
				}
			} catch {
				// best-effort
			}

			// Detach the current agent on `key`
			rotateKey(key);
			if (opts?.preset) presetOverrides.set(key, opts.preset);
			pendingResume.set(key, { sessionId });
			try {
				// Reuse the FULL ensureAgent pipeline (in-flight collapse,
				// setup composition, workspace attach, handle wiring).
				return await ensureAgent(key);
			} finally {
				pendingResume.delete(key);
			}
		},

		get: (key) => tracked.get(key)?.handle,
		keyForSessionId: (sessionId) => keyBySession.get(sessionId),
		async listPresets() {
			// The roster the deployment currently supplies: shipped presets AND
			// user-authored (custom) ones. Read live so a preset created while the
			// bridge runs shows up on the next /mode picker. Falls back to the
			// shipped four when the agentPresets service is absent or fails.
			const presets = (
				c as unknown as {
					get?(name: string):
						| {
								list?(): Promise<
									Array<{
										id: string;
										trust?: "system" | "user";
										name?: string;
										description?: string;
										broken?: string;
									}>
								>;
						  }
						| undefined;
				}
			).get?.("agentPresets");
			if (!presets?.list) return [];
			try {
				const rows = await presets.list();
				return rows.map((row) => ({
					id: row.id,
					label: row.name ?? row.id,
					...(row.trust === undefined ? {} : { trust: row.trust }),
					...(row.description === undefined
						? {}
						: { desc: row.description }),
					...(row.broken === undefined ? {} : { broken: row.broken }),
				}));
			} catch (err) {
				deps.logger?.warn(
					`agentPresets.list() failed — /mode falls back to shipped presets: ${String(err)}`,
				);
				return [];
			}
		},
		disposeIdle(idleTtlMs) {
			// Collect entries to dispose: remove from tracked synchronously
			// so the next ensureAgent() sees the key as vacant and creates
			// a fresh agent. Bump the generation so the new session id does
			// NOT collide with the persisted log left by the disposed agent
			// (fixes issue #5: session id collision -> silent message drop).
			const toDispose: Array<{ key: string; handle: AgentHandle }> = [];
			for (const [key, t] of tracked) {
				if (t.handle.isIdle() && Date.now() - t.lastUsedAt >= idleTtlMs) {
					toDispose.push({ key, handle: t.handle });
				}
			}
			for (const { key, handle } of toDispose) {
				tracked.delete(key);
				keyBySession.delete(handle.sessionId);
				generations.set(key, (generations.get(key) ?? 0) + 1);
				void handle.dispose();
			}
			return toDispose.length;
		},
		size: () => tracked.size,
		rotate(key) {
			// /new must mint a WHOLLY fresh session id, not just bump the
			// generation: a `:<gen+1>` id can collide with a persisted log from
			// an earlier run (same runNonce family), and DSH then fails the first
			// turn with "already persisted at a different cwd (id collision)" —
			// no reply after /new. Fresh runNonce + generation 0 gives a
			// collision-free id every time. (rotateKey also keeps the OLD agent
			// alive — its session stays listed; see the comment there.)
			rotateKey(key);
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
