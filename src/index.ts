// dsh-lark-link — Cordis bundle plugin entry (thin assembly layer, spec §3).
// Registers:
//   - bridge lifecycle (ctx.effect disposer → clean teardown on unload)
//   - /lark-* commands (ctx.commands)
//   - lark_send_local_file / lark_config_get tools (ctx.tools)
//   - system-prompt section telling the model it's bridged
//   - session/event fan-out → event-forwarder (streaming + durable outbox)
// The heavy logic lives in the layered modules; this file only wires them
// against the real DSH services. No approval/deny gates (user decision:
// 默认全放开).

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createDshAdapter } from "./sessions/dsh-adapter.ts";
import { createMemoryDshBackend } from "./sessions/dsh-session-backend.ts";
import { createConversationManager } from "./sessions/conversation-manager.ts";
import { createConversationConfigStore } from "./sessions/conversation-config.ts";
import { createTurnSupervisor } from "./sessions/turn-supervisor.ts";
import { createOutbox, type OutboxSender } from "./outbound/outbox.ts";
import { createEventForwarder } from "./outbound/event-forwarder.ts";
import { createRouteStore } from "./outbound/outbound-router.ts";
import {
	createTransport,
	extractUploadKey,
	type FeishuClientLike,
} from "./inbound/transport.ts";
import { createConnectionSupervisor } from "./inbound/connection-supervisor.ts";
import { createMissedCompensation } from "./inbound/missed-compensation.ts";
import { createGroupTrigger } from "./inbound/group-trigger.ts";
import {
	createBridgeContext,
	type FeishuSender,
} from "./application/bridge-context.ts";
import { createMessageHandler } from "./application/message-handler.ts";
import {
	createCommandRouter,
	type DshCommandRegistry,
} from "./application/command-router.ts";
import { createDiagnosticsService } from "./application/diagnostics-service.ts";
import {
	formatStatusLine,
	statusDetailLines,
} from "./application/status-formatter.ts";
import { createStatusStore } from "./common/connection-status.ts";
import { createConfigStore, HOT_RELOADABLE } from "./common/config.ts";
import { createLogger, type Logger } from "./common/logger.ts";
import { createDedupeStore } from "./common/dedupe-store.ts";
import { createInboundWal } from "./inbound/inbound-wal.ts";
import { createQuotaGovernor } from "./common/quota-governor.ts";
import {
	helpCard,
	markdownCard,
	looksLikeMarkdown,
	modeCard,
	modelCard,
	permissionCard,
	questionCard,
	withButtons,
	button,
	AGENT_PRESETS,
	PERMISSION_PRESETS,
} from "./presentation/cards.ts";
import { createAuthSetup, registerAppWithFetch } from "./host/auth-setup.ts";
import {
	resolveCredentials,
	persistCredentials,
	clearCredentials,
	buildLarkClient,
	type CredentialsStore,
	type LarkDomain,
} from "./host/lark-client.ts";
import * as qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	rmSync,
	existsSync,
} from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import type { FeishuInboundMessage } from "./common/types.ts";

export const name = "dsh-lark-link";
export const inject = [
	"tools",
	"commands",
	"agents",
	"systemPrompt",
	"credentials",
	"webServer",
];

export interface LarkLinkConfig {
	enabled?: boolean;
	groupPolicy?: "open" | "mention" | "keywords" | "reply";
	denyList?: string[];
}

/** Bridge state directory (<DSH_HOME>/lark-link, overridable). */
export function stateDir(): string {
	return (
		process.env.DSH_LARK_LINK_HOME ??
		join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lark-link")
	);
}

export function apply(ctx: Context, rawConfig: unknown): void {
	const cfg = rawConfig as LarkLinkConfig | undefined;
	if (cfg?.enabled === false) return;

	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	const logger: Logger = createLogger("lark-link");

	// ---- config / status / stores -------------------------------------------
	const configStore = createConfigStore(dir, {
		groupPolicy: cfg?.groupPolicy,
		denyList: cfg?.denyList,
	});
	const status = createStatusStore(join(dir, "status.json"));
	const routeStore = createRouteStore(join(dir, "routes.json"));
	const dedupe = createDedupeStore(join(dir, "dedupe.jsonl"));
	// Durable inbound-request journal (入站请求补发). Records agent-bound text
	// requests before enqueue; on boot, accepted-but-undelivered requests are
	// re-dispatched so a crash/plugin-reload/dsh-restart mid-turn doesn't drop
	// the user's message. Persists in <state>/inbound-wal/.
	const inboundWal = createInboundWal({ dir: join(dir, "inbound-wal") });
	const getCfg = (): ReturnType<typeof configStore.get> => configStore.get();
	// Per-conversation overrides (workspace / model / preset). The bridge-level
	// config stays the DEFAULT; /workspace, /model and /mode in one chat now
	// scope to THAT chat only — other chats no longer follow the switch when
	// their agent is rebuilt (idle TTL, /new, maxSessions pressure).
	const convCfg = createConversationConfigStore(
		join(dir, "conversation-overrides.json"),
	);

	// ---- permission default sync ---------------------------------------------
	// The bridge config `permissionMode` ("read-only | workspace-write |
	// danger-full-access") is documented as the DEFAULT for new sessions, but it
	// is only ever applied to the CURRENT session via /permission. A brand-new
	// session is pinned by DSH's permissionPresets service to ITS default
	// (permission:defaultPreset — the composed default is workspace-write), so
	// new sessions silently ignored the configured mode. Sync the DSH default to
	// the bridge config so every subsequent new session inherits it. This is a
	// best-effort, idempotent, non-fatal write into the DSH settings document.
	let syncTried = 0;
	function syncDefaultPermission(): void {
		const settings = (
			ctx as unknown as {
				get?(
					name: string,
				):
					| {
							update?(
								ns: string,
								patch: { defaultPreset: string },
							): Promise<unknown>;
					  }
					| undefined;
			}
		).get?.("settings");
		if (!settings?.update) {
			// Settings provider absent yet (or not mounted, e.g. bare host). The
			// bridge still functions, just without an inherited default; retry a
			// little so a slow service init still gets synced.
			syncTried++;
			if (syncTried <= 4) setTimeout(syncDefaultPermission, 500 * syncTried);
			return;
		}
		const mode = getCfg().permissionMode;
		settings
			.update("permission", { defaultPreset: mode })
			.then(() => logger.info(`permission default set to ${mode}`))
			.catch((err: unknown) => {
				// The permission namespace may not be registered yet (load order).
				// Retry a couple of times shortly after; otherwise surface and move
				// on — never fatal for the bridge.
				syncTried++;
				logger.warn(
					`sync permission default to ${mode} failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				if (syncTried < 4) {
					setTimeout(syncDefaultPermission, 500 * syncTried);
				}
			});
	}
	syncDefaultPermission();

	// ---- backend: real DSH adapter, falling back to the in-memory mock ------
	// LIVE model selection: liveModelSelection is the bridge-wide DEFAULT
	// (initialized from the deployment agentDefaultModel service; a GUI-side
	// default switch is picked up by the poll started in startBridge). Each
	// conversation gets its own mutable entry via liveModelFor(key) —
	// installModelSelection keeps a reference to it, so mutating the entry
	// switches that conversation's model WITHOUT rebuilding its agent.
	// Entries WITHOUT a per-key /model override are "followers" that track
	// the bridge default; entries with an override keep their own model.
	const liveModelSelection = { provider: "", model: "" };
	const admService = (
		ctx as unknown as {
			get?(
				name: string,
			):
				| {
						currentSelection?():
							| { provider?: string; model?: string }
							| undefined;
						saveSelection?(s: {
							provider: string;
							model: string;
						}): Promise<unknown>;
				  }
				| undefined;
		}
	).get?.("agentDefaultModel");
	{
		const cur = admService?.currentSelection?.();
		if (cur?.provider && cur.model) {
			liveModelSelection.provider = cur.provider;
			liveModelSelection.model = cur.model;
		}
	}
	const liveModels = new Map<
		string,
		{ provider: string; model: string; override: boolean }
	>();
	const liveModelFor = (
		key: string,
	): { provider: string; model: string; override: boolean } => {
		let m = liveModels.get(key);
		if (!m) {
			const o = convCfg.get(key);
			m = {
				provider: o.provider ?? liveModelSelection.provider,
				model: o.model ?? liveModelSelection.model,
				override: Boolean(o.provider && o.model),
			};
			liveModels.set(key, m);
		}
		return m;
	};
	// Push a bridge-default change into every follower entry (conversations
	// that never ran /model themselves). Override entries keep their model.
	const syncModelFollowers = (): void => {
		for (const m of liveModels.values()) {
			if (!m.override) {
				m.provider = liveModelSelection.provider;
				m.model = liveModelSelection.model;
			}
		}
	};
	// Fresh per-run nonce — NEVER persisted. (352af88 persisted it so bridge
	// session ids survive restarts, but that makes a restarted bridge reuse a
	// session id whose on-disk log does not match the live session, and
	// dsh-agent-loop's resume/create then fail the first turn with "already
	// has a persisted log on disk that does not match this live session (id
	// collision)". A fresh nonce per run means create never collides and the
	// bridge always boots clean; the GUI gets a new conversation row per
	// restart, which is the correct trade-off for a reliable bridge.)
	const runNonce = `${Date.now().toString(36)}${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	let backend: ReturnType<typeof createDshAdapter> | undefined;
	try {
		backend = createDshAdapter({
			ctx,
			sessionPrefix: "lark-link",
			runNonce,
			logger,
			// Per-key resolution: conversation override ?? bridge default.
			cwd: (key: string) =>
				convCfg.get(key).workspaceRoot ??
				(getCfg().workspaceRoot || process.cwd()),
			preset: (key: string) => {
				const p =
					convCfg.get(key).preset ?? (getCfg().agentPreset || "code");
				return p === "ptc" ? "code" : p; // 别名兼容
			},
			modelSelection: {
				currentFor: (key: string) => {
					const m = liveModelFor(key);
					return m.provider && m.model ? m : undefined;
				},
			},
			askUserQuestion,
		});
	} catch (err) {
		logger.warn(
			`DSH adapter unavailable — using in-memory backend: ${String(err)}`,
		);
		backend = createMemoryDshBackend();
	}

	// ---- lark client (lazily built from credentials at start) ---------------
	let larkClient: FeishuClientLike | undefined;
	const getLarkClient = (): FeishuClientLike | undefined => larkClient;

	// Credentials live in ctx.credentials under config.credentialRef (ref-style,
	// spec §4.1). Harness-agnostic adapter — no-ops if the service is absent.
	const credStore: CredentialsStore = {
		resolve: (ref) =>
			(
				ctx as unknown as { credentials?: CredentialsStore }
			).credentials?.resolve(ref) ?? Promise.resolve(undefined),
		set: (ref, value) =>
			(ctx as unknown as { credentials?: CredentialsStore }).credentials?.set(
				ref,
				value,
			) ?? Promise.resolve(),
		unset: (ref) =>
			(ctx as unknown as { credentials?: CredentialsStore }).credentials?.unset(
				ref,
			) ?? Promise.resolve(),
	};
	let startBlocker: string | undefined;
	const maskId = (id: string): string =>
		id.length <= 8 ? "****" : `${id.slice(0, 6)}…${id.slice(-4)}`;

	// ---- webui QR surface ---------------------------------------------------
	// /lark setup renders its QR into a PNG served at /plugins/lark-link/qr so
	// the Web GUI (sidebar panel) can show a scannable image directly — the GUI
	// markdown image sanitizer only allows http(s), and a plugin can't push to
	// the client, so a host-served local image is the reliable channel.
	let activeQr: { png: Buffer; expireAt: number } | undefined;
	const webServer = (
		ctx as unknown as {
			webServer?: {
				register(r: {
					kind: "exact" | "prefix";
					path: string;
					handler: (req: unknown, res: unknown) => void;
				}): () => void;
			};
		}
	).webServer;
	if (webServer) {
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: "/plugins/lark-link/qr",
					handler: (_req, res) => {
						const r = res as {
							writeHead(
								status: number,
								headers: Record<string, string>,
							): unknown;
							end(body?: unknown): unknown;
						};
						if (activeQr && Date.now() < activeQr.expireAt) {
							r.writeHead(200, {
								"Content-Type": "image/png",
								"Cache-Control": "no-store",
							});
							r.end(activeQr.png);
						} else {
							r.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
							r.end("no active lark-link setup qr (run /lark setup)");
						}
					},
				}),
			"lark-link: webui qr route",
		);
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: "/plugins/lark-link/status",
					handler: async (_req, res) => {
						const r = res as {
							writeHead(s: number, h: Record<string, string>): unknown;
							end(body?: unknown): unknown;
						};
						const configured = Boolean(
							await resolveCredentials(credStore, getCfg().credentialRef),
						);
						r.writeHead(200, {
							"Content-Type": "application/json; charset=utf-8",
							"Cache-Control": "no-store",
						});
						r.end(JSON.stringify({ ...status.get(), configured }));
					},
				}),
			"lark-link: webui status route",
		);
	}

	// ---- sender (outbox target) ----------------------------------------------
	const sender: FeishuSender = {
		async replyTo(msg, textOrCard) {
			const text =
				typeof textOrCard === "string"
					? textOrCard
					: JSON.stringify(textOrCard);
			if (typeof textOrCard === "string")
				await sender.sendText(msg.chatId, text);
			else await sender.sendCard(msg.chatId, textOrCard as unknown);
		},
		async sendText(chatId, text) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			// Markdown-ish replies render as schema-1.0 cards (Feishu renders the
			// markdown element in every client — old and new). Schema 2.0 cards
			// break older clients ("请升级至最新版本客户端" placeholder), and plain
			// text shows raw markdown source. 1.0 is the compatible middle
			// ground; oversize replies fall back to plain text.
			if (looksLikeMarkdown(text) && text.length <= 28_000) {
				await client.sendMessage({
					receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
					params: {
						receive_id: chatId,
						msg_type: "interactive",
						content: JSON.stringify(markdownCard(text)),
					},
				});
				return;
			}
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text }),
				},
			});
		},
		async sendCard(chatId, card) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: "interactive",
					content: JSON.stringify(card),
				},
			});
		},
		async addReaction(messageId, emojiType) {
			const client = getLarkClient();
			if (!client?.addReaction) throw new Error("lark client not ready");
			await client.addReaction({
				message_id: messageId,
				emoji_type: emojiType,
			});
		},
		async sendFile(chatId, fileKey, type) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: type,
					content: JSON.stringify(
						type === "image" ? { image_key: fileKey } : { file_key: fileKey },
					),
				},
			});
		},
		async listMessages({ chatId, startTimeMs, endTimeMs }) {
			const client = getLarkClient();
			if (!client?.listMessages) return [];
			const res = await client.listMessages({
				container_id_type: "chat",
				container_id: chatId,
				start_time: String(startTimeMs),
				end_time: String(endTimeMs),
			});
			return (res.items ?? []).map((i) => ({
				messageId: i.message_id ?? "",
				timestampMs: Number(i.create_time ?? 0),
			}));
		},
	};

	// ---- bridge context (getters — never snapshots) --------------------------
	const bridge = createBridgeContext({
		logger,
		cfg: getCfg,
		configStore,
		status,
		backend,
		router: routeStore,
		sender,
		// DSH attachment store — saves inbound Feishu images as ImageBlocks.
		attachments: (
			ctx as unknown as {
				get?(name: string):
					| {
							saveImage(input: {
								data: Uint8Array;
								mediaType:
									| "image/png"
									| "image/jpeg"
									| "image/webp"
									| "image/gif";
								name?: string;
							}): Promise<{
								attachmentId: string;
								mediaType: string;
								bytes: number;
								width: number;
								height: number;
								name?: string;
							}>;
					  }
					| undefined;
			}
		).get?.("attachments"),
	});

	// ---- outbox ---------------------------------------------------------------
	const outboxSender: OutboxSender = {
		async deliver(env, payload) {
			const chatId = env.route.chatId;
			try {
				if (payload.kind === "text") {
					if (payload.card !== undefined)
						await sender.sendCard(chatId, payload.card);
					else await sender.sendText(chatId, payload.text);
				} else if (payload.kind === "card") {
					await sender.sendCard(chatId, payload.card);
				} else if (payload.kind === "media") {
					await sender.sendFile(chatId, payload.fileKey, payload.type);
				} else if (payload.kind === "reaction") {
					await sender.addReaction(payload.messageId, payload.emojiType);
				}
				return { ok: true };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { ok: false, retryable: true, error: message };
			}
		},
	};
	const outbox = createOutbox({
		dir: join(dir, "outbox"),
		sender: outboxSender,
		cfg: getCfg().outbox,
		// Live outbox counters → status, so /status (and the Web panel) reflect
		// pending/failed in real time instead of only on startup / timers.
		onStatsChange: (stats) => {
			try {
				status.refreshCounters({ outboxPending: stats.pending, outboxFailed: stats.failed });
			} catch {
				// best-effort
			}
		},
	});

	// ---- forwarder / compensation / trigger / diagnostics --------------------
	const forwarder = createEventForwarder({
		outbox,
		routeFor: (key) => routeStore.get(key),
		// Streaming cards stay off (省流量) unless hot-reloaded; the StreamTarget
		// exists so turn/end can mark the trigger message DONE (pi design:
		// 随机表情回执 + 完成打 DONE). markDone is best-effort via the sender.
		streamFor: (sessionKey) => {
			const route = routeStore.get(sessionKey);
			if (!route) return undefined;
			return {
				route: {
					sessionKey: route.sessionKey,
					chatId: route.chatId,
					chatType: route.chatType,
					threadMessageId: route.threadMessageId,
				},
				ensureStream: () => undefined,
				fallbackText: async (text) => {
					await outbox.enqueue({
						dedupeKey: `${sessionKey}:fallback:${Date.now()}`,
						laneKey: sessionKey,
						route: {
							sessionKey: route.sessionKey,
							chatId: route.chatId,
							chatType: route.chatType,
						},
						kind: "assistant-output",
						payload: { kind: "text", text },
					});
				},
				markDone: () => bridge.markDone(sessionKey, route.lastMessageId),
			};
		},
		cfg: () => ({ streamingEnabled: getCfg().streaming.enabled }),
		// Durable output enqueued → the triggering user request has been
		// answered, so it won't be re-triggered after a crash. Best-effort.
		onDelivered: (sessionKey) => {
			try {
				const route = routeStore.get(sessionKey);
				if (route?.lastMessageId) inboundWal.delivered(route.lastMessageId);
			} catch {
				// swallow — WAL failures never break delivery
			}
		},
	});
	const groupTrigger = createGroupTrigger({
		cfg: () => ({
			policy: getCfg().groupPolicy,
			keywords: getCfg().groupKeywords,
			alsoOnReply: getCfg().alsoOnReply,
		}),
		botOpenId: () => bridge.botOpenId(),
	});

	const diagnostics = createDiagnosticsService({
		ctx: bridge,
		secrets: [],
	});

	// ---- intent confirmation (ask_user_question → Feishu) ---------------------
	// Model questions pause the tool call until the user answers; we send a
	// Feishu card (option buttons) and resolve on the callback. Plain-text
	// replies to the same conversation are treated as a custom answer.
	const pendingQuestions = new Map<
		string,
		{
			resolve: (a: { id: string; selected: string[]; custom?: string }) => void;
			chatId: string;
			questionId: string;
			timer: NodeJS.Timeout;
			options: Array<{ label: string }>;
		}
	>();

	async function askUserQuestion(
		questions: Array<{
			id: string;
			question: string;
			header?: string;
			options?: Array<{ label: string; description?: string }>;
			multiSelect?: boolean;
		}>,
		agentId: string,
	): Promise<{
		answers: Array<{ id: string; selected: string[]; custom?: string }>;
	}> {
		// One card per question, answered serially (multi-question is rare).
		const answers: Array<{
			id: string;
			selected: string[];
			custom?: string;
		}> = [];
		const key = backend?.keyForSessionId?.(agentId);
		const route = key ? routeStore.get(key) : undefined;
		const chatId = route?.chatId;
		if (!chatId) {
			logger.warn(`ask_user_question: no Feishu route for ${agentId}`);
			return {
				answers: questions.map((q) => ({
					id: q.id,
					selected: ["(无会话，未回答)"],
				})),
			};
		}
		for (const q of questions) {
			const answer = await new Promise<{
				id: string;
				selected: string[];
				custom?: string;
			}>((resolve) => {
				const timer = setTimeout(() => {
					pendingQuestions.delete(q.id);
					resolve({ id: q.id, selected: ["(超时未回答)"] });
				}, 10 * 60_000);
				timer.unref?.();
				pendingQuestions.set(q.id, {
					resolve,
					chatId,
					questionId: q.id,
					timer,
					options: q.options ?? [],
				});
				void sender.sendCard(chatId, questionCard(q)).catch((err) => {
					clearTimeout(timer);
					pendingQuestions.delete(q.id);
					resolve({
						id: q.id,
						selected: [
							`(卡片发送失败: ${err instanceof Error ? err.message : String(err)})`,
						],
					});
				});
			});
			answers.push(answer);
		}
		return { answers };
	}

	// ---- command router --------------------------------------------------------
	const dshCommands: DshCommandRegistry = {
		// DSH's CommandRuntime has no `has()`; use find(agent, name) — the
		// agent-scoped effective command registry (ScopedLayers).
		has: (name, agentId) => {
			try {
				const services = ctx as unknown as {
					commands?: { find?(agent: unknown, name: string): unknown };
					agents?: { get?(id: string): unknown };
				};
				const agent = agentId ? services.agents?.get?.(agentId) : undefined;
				if (!agent) return false;
				return Boolean(services.commands?.find?.(agent, name));
			} catch {
				return false;
			}
		},
		async run(name, rawInput, agentId) {
			try {
				const services = ctx as unknown as {
					commands?: {
						execute?(
							agent: unknown,
							line: string,
							signal?: AbortSignal,
						): Promise<
							| {
									result?: { kind: string; text?: string };
							  }
							| undefined
						>;
					};
					agents?: { get?(id: string): unknown };
				};
				const commands = services.commands;
				const agent = services.agents?.get?.(agentId);
				if (!commands?.execute || !agent)
					return { kind: "error", text: "commands service unavailable" };
				const line = rawInput.trim()
					? `/${name} ${rawInput.trim()}`
					: `/${name}`;
				// execute() needs a live signal; a never-aborted controller is fine
				// for a one-shot command.
				const out = await commands.execute(
					agent,
					line,
					new AbortController().signal,
				);
				if (!out?.result) return { kind: "error", text: `未知命令 /${name}` };
				return {
					kind: out.result.kind,
					text: out.result.text,
				};
			} catch (err) {
				return {
					kind: "error",
					text: err instanceof Error ? err.message : String(err),
				};
			}
		},
	};

	// ---- durable command reply (入站请求补发 / 命令回复可靠化) ----------------
	// Bridge-command replies (status/help/sessions/workspace/lark-config/mode/
	// permission/model/new/stop/…) go through the DURABLE outbox (command-reply
	// kind), same as DSH-registered command replies — so a bridge reply in
	// flight when the process dies / plugin reloads still gets delivered on the
	// next boot. Idempotent per trigger message (no duplicates after replay).
	const durableReply = async (
		cmdName: string,
		msg: FeishuInboundMessage,
		textOrCard: string | unknown,
	): Promise<void> => {
		const key = bridge.conversationKeyFor(msg);
		await outbox.enqueue({
			dedupeKey: `bridge:${cmdName}:${msg.messageId}`,
			laneKey: key,
			route: {
				sessionKey: key,
				chatId: msg.chatId,
				chatType: msg.chatType,
			},
			kind: "command-reply",
			payload:
				typeof textOrCard === "string"
					? { kind: "text", text: textOrCard }
					: { kind: "card", card: textOrCard as never },
		});
	};

	const bridgeHandler = async (
		name: string,
		_rawInput: string,
		msg: FeishuInboundMessage,
	): Promise<boolean> => {
		switch (name) {
			case "status":
				await durableReply(name, 
					msg,
					formatStatusLine(status.get()) +
						"\n\n" +
						statusDetailLines(status.get()).join("\n"),
				);
				return true;
			case "feishu-config":
			case "lark-config": {
				// /lark-config key=value — hot reload (no value shows status).
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(name, 
						msg,
						formatStatusLine(status.get()) +
							"\n\n" +
							statusDetailLines(status.get()).join("\n"),
					);
					return true;
				}
				const eq = arg.indexOf("=");
				if (eq === -1) {
					await durableReply(name, 
						msg,
						"用法：/lark-config key=value（可热改: " +
							HOT_RELOADABLE.join(", ") +
							"）",
					);
					return true;
				}
				const key = arg.slice(0, eq).trim();
				const rawVal = arg.slice(eq + 1).trim();
				if (!HOT_RELOADABLE.includes(key as never)) {
					await durableReply(name, 
						msg,
						`"${key}" 不可热改（可改: ${HOT_RELOADABLE.join(", ")}）`,
					);
					return true;
				}
				// Type-coerce: booleans and numbers stay typed for config.
				let val: unknown = rawVal;
				if (rawVal === "true" || rawVal === "false") val = rawVal === "true";
				else if (rawVal !== "" && !Number.isNaN(Number(rawVal)))
					val = Number(rawVal);
				try {
					configStore.update({ [key]: val } as never);
					configStore.saveOverrides();
				} catch (err) {
					await durableReply(name, 
						msg,
						`更新失败: ${err instanceof Error ? err.message : String(err)}`,
					);
					return true;
				}
				await durableReply(name, msg, `已更新 ${key}=${JSON.stringify(val)}`);
				return true;
			}
			case "support":
			case "doctor": {
				// pi design: the diagnostic bundle comes back as a FILE. The
				// bundle is a ZIP containing the DSH session log (decompressed
				// jsonl, same shape as the GUI "Session log" export) plus a
				// sanitized ISSUE.md — falls back to a text reply when the
				// upload path is unavailable.
				const diag = await diagnostics.build();
				const client = getLarkClient();
				if (client?.uploadFile) {
					try {
						const key = bridge.conversationKeyFor(msg);
						const sessionId =
							bridge.backend?.get(key)?.sessionId ?? findLatestLarkSessionId();
						const zipBuf = sessionId
							? await buildSessionExportZip(sessionId, diag.text, diag.issueMd)
							: undefined;
						if (zipBuf) {
							const fileName = `lark-link-doctor-${Date.now()}.zip`;
							const uploadKey = extractUploadKey(
								await client.uploadFile({
									file_type: "file",
									file_name: fileName,
									file: zipBuf,
								}),
								"file_key",
							);
							if (uploadKey) {
								await sender.sendFile(msg.chatId, uploadKey, "file");
								return true;
							}
						}
						// No session log or zip failed — send the report as a file.
						const fileName = `lark-link-doctor-${Date.now()}.md`;
						const buf = Buffer.from(
							`# dsh-lark-link 诊断包\n\n${diag.text}\n\n${diag.issueMd}\n`,
							"utf8",
						);
						const uploadKey = extractUploadKey(
							await client.uploadFile({
								file_type: "file",
								file_name: fileName,
								file: buf,
							}),
							"file_key",
						);
						if (uploadKey) {
							await sender.sendFile(msg.chatId, uploadKey, "file");
							return true;
						}
					} catch (err) {
						logger.warn(
							`doctor file send failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				await durableReply(name, msg, diag.text);
				return true;
			}
			case "sessions": {
				// List live bridge sessions (pi f752ece /sessions 决策).
				const keys = bridge.conversations?.keys() ?? [];
				const lines = keys.length
					? keys.map((k) => `- ${k}`)
					: ["（无活跃会话）"];
				await durableReply(name, 
					msg,
					`**会话列表 (${keys.length})**\n\n` + lines.join("\n"),
				);
				return true;
			}
			case "help":
				await durableReply(name, msg, helpCard());
				return true;
			case "workspace": {
				const arg = _rawInput.trim();
				const wsKey = bridge.conversationKeyFor(msg);
				// Per-conversation workspace: this chat's override ?? bridge default.
				const curWs =
					convCfg.get(wsKey).workspaceRoot ??
					(getCfg().workspaceRoot || process.cwd());
				if (!arg) {
					await durableReply(name, 
						msg,
						`工作区: ${curWs}`,
					);
					return true;
				}
				// /workspace <path> — switch the bridge workspace root: persist it
				// and dispose hosted sessions so the next message rebuilds agents
				// under the new cwd (DSH session cwd is fixed at creation).
				// Expand ~ and relative paths against the current workspace.
				const expanded =
					arg === "~" || arg.startsWith("~/")
						? join(homedir(), arg.slice(arg.startsWith("~/") ? 2 : 1))
						: arg;
				const target = resolve(
					expanded.startsWith("/") ? expanded : join(curWs, expanded),
				);
				if (!target.startsWith("/")) {
					await durableReply(name, msg, `无效路径: ${arg}`);
					return true;
				}
				try {
					if (!statSync(target).isDirectory()) {
						await durableReply(name, msg, `不是有效目录: ${target}`);
						return true;
					}
				} catch {
					await durableReply(name, msg, `目录不存在: ${target}`);
					return true;
				}
				// Scope the switch to THIS conversation only (per-key override).
				// The bridge default is untouched, so other chats keep their
				// workspace even when their agent is later rebuilt.
				convCfg.set(wsKey, { workspaceRoot: target });
				// Only the current conversation rebuilds (next message) — other
				// conversations keep their agents/sessions. rotate() (NOT dispose):
				// dispose() tears down the agent AND removes its session from the
				// store (GUI row vanishes) and the next message would reuse the
				// same sessionId → stale content / id collision. rotate() mints a
				// fresh runNonce so the next message opens a brand-new session
				// under the new cwd, and the old row stays listed.
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				await durableReply(name, 
					msg,
					`工作区已切换: ${target}\n当前会话已重置，下一条消息在新工作区生效（其他会话不受影响）。`,
				);
				return true;
			}
			case "stop": {
				const key = bridge.conversationKeyFor(msg);
				await bridge.conversations?.stop(key);
				await durableReply(name, msg, "已停止当前会话任务");
				return true;
			}
			case "new": {
				// /new — start a fresh conversation in the current workspace:
				// bump the session generation and dispose the agent so the next
				// message opens a NEW session row (never forwarded to the model).
				const key = bridge.conversationKeyFor(msg);
				await conversations?.rotate(key);
				const newWs =
					convCfg.get(key).workspaceRoot ??
					(getCfg().workspaceRoot || process.cwd());
				await durableReply(name, 
					msg,
					`已开启新会话（工作区: ${newWs}）。下一条消息开始全新上下文。`,
				);
				return true;
			}
			case "model": {
				// /model — list the current model + available models (no arg) or
				// switch: /model <provider>/<model> | /model <model>. The switch is
				// scoped to THIS conversation (per-key override + live entry): the
				// agent reads the live entry via installModelSelection, so the model
				// changes on the next reply WITHOUT rebuilding the session, and no
				// other chat follows the switch.
				const arg = _rawInput.trim();
				const modelKey = bridge.conversationKeyFor(msg);
				const mine = liveModelFor(modelKey);
				const services = ctx as unknown as {
					get?(name: string): unknown;
				};
				const llm = services.get?.("llm") as
					| {
							listProviders?(): Array<{ id?: string; name?: string }>;
							listModels?(
								p: string,
							): Promise<Array<{ id: string; name?: string }>>;
					  }
					| undefined;
				const current =
					mine.provider && mine.model
						? { provider: mine.provider, model: mine.model }
						: admService?.currentSelection?.();
				if (!arg) {
					// Picker card grouped by provider (single-select, no typing).
					const groups: Array<{
						provider: string;
						label?: string;
						models: Array<{ id: string; name?: string }>;
					}> = [];
					const providers = llm?.listProviders?.() ?? [];
					for (const p of providers) {
						let models: Array<{ id: string; name?: string }> = [];
						try {
							models = (await llm?.listModels?.(p.id ?? "")) ?? [];
						} catch {
							// adapter without a catalog — skip
						}
						if (models.length > 0) {
							groups.push({
								provider: p.id ?? "",
								label: p.name ?? p.id,
								models,
							});
						}
					}
					await sender.sendCard(msg.chatId, modelCard(current, groups));
					return true;
				}
				// Switch: accept provider/model or bare model id (same provider).
				let provider = current?.provider ?? "";
				let model = arg;
				if (arg.includes("/")) {
					const [p, m] = arg.split("/");
					if (p) provider = p.trim();
					model = (m ?? "").trim();
				}
				if (!provider || !model) {
					await durableReply(name, 
						msg,
						"用法：/model <provider>/<model> 或 /model <model>",
					);
					return true;
				}
				// Scope to THIS conversation: persist the per-key override and
				// mutate the live entry — the agent's installed selection object
				// IS this entry, so the next reply uses the new model without a
				// rebuild. The bridge default (and other chats) are untouched.
				convCfg.set(modelKey, { provider, model });
				const entry = liveModelFor(modelKey);
				entry.provider = provider;
				entry.model = model;
				entry.override = true;
				await durableReply(name, 
					msg,
					`模型已切换: ${provider}/${model}\n本会话下次回复生效（会话不中断，其他会话不受影响）。`,
				);
				return true;
			}
			case "mode": {
				// /mode — picker card (single-select buttons) or switch by name.
				// The roster is LIVE: shipped presets + user-authored (custom)
				// ones, read from DSH's agentPresets service so a preset created
				// in the GUI is selectable here too. AGENT_PRESETS is only the
				// fallback when the service is unreachable.
				const live = backend ? await backend.listPresets() : [];
				const roster = live.length > 0 ? live : [...AGENT_PRESETS];
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await sender.sendCard(
						msg.chatId,
						withButtons(
							modeCard(getCfg().agentPreset, roster),
							roster
								.filter((p) => !p.broken)
								.map((p) => button(p.label, { op: `mode:${p.id}` })),
						),
					);
					return true;
				}
				if (!roster.some((p) => p.id === arg)) {
					await durableReply(name, 
						msg,
						`未知模式 ${arg}（可用: ${roster.map((p) => p.id).join(", ")}）`,
					);
					return true;
				}
				// Per-conversation preset override — other chats keep theirs.
				convCfg.set(bridge.conversationKeyFor(msg), { preset: arg });
				// Agent presets snapshot at agent creation — an existing session's
				// agent CANNOT change mode mid-flight. rotate() (NOT dispose): mints
				// a fresh runNonce so the next message opens a brand-new session in
				// this workspace under the new mode; the old row stays listed.
				// dispose() would tear down the agent + remove its session from the
				// store AND the next message would reuse the same sessionId (stale
				// content / id collision).
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				const picked = roster.find((p) => p.id === arg);
				await durableReply(name, 
					msg,
					`模式已切换为 ${picked?.label ?? arg}${
						picked?.trust === "user" ? "（自定义）" : ""
					}（当前会话已重置，下条消息生效；其他会话不受影响）`,
				);
				return true;
			}
			case "permission": {
				// /permission — picker card or switch by name. The DSH side also
				// registers a /permission command; this bridge handler wins first
				// (Tier 1) so the picker card shows instead of plain text.
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await sender.sendCard(
						msg.chatId,
						withButtons(
							permissionCard(getCfg().permissionMode),
							PERMISSION_PRESETS.map((p) =>
								button(p.label, { op: `permission:${p.id}` }),
							),
						),
					);
					return true;
				}
				if (!PERMISSION_PRESETS.some((p) => p.id === arg)) {
					await durableReply(name, 
						msg,
						`未知权限 ${arg}（可用: ${PERMISSION_PRESETS.map((p) => p.id).join(", ")}）`,
					);
					return true;
				}
				// Apply on the live DSH permission service (session-scoped knobs).
				try {
					const services = ctx as unknown as {
						get?(name: string): unknown;
					};
					const sessionId = bridge.backend?.get(
						bridge.conversationKeyFor(msg),
					)?.sessionId;
					const agent = sessionId
						? (
								services.get?.("agents") as {
									get?(id: string): { session: unknown };
								}
							)?.get?.(sessionId)
						: undefined;
					const permission = services.get?.("permissionPresets") as
						| {
								apply?(
									session: unknown,
									name: string,
									setApproval: (policy: string) => void,
								): void;
						  }
						| undefined;
					if (agent?.session && permission?.apply) {
						permission.apply(agent.session, arg, (policy) => {
							const approval = services.get?.("approval") as
								| { setPolicy?(agent: unknown, policy: string): unknown }
								| undefined;
							approval?.setPolicy?.(agent, policy);
						});
					}
				} catch (err) {
					logger.warn(
						`permission switch failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				configStore.update({ permissionMode: arg });
				configStore.saveOverrides();
				// Keep the DSH default in lockstep so NEW sessions inherit the
				// switch too, not just this one.
				syncDefaultPermission();
				await durableReply(name, msg, `权限已切换为 ${arg}`);
				return true;
			}
			case "lark": {
				// Feishu-side /lark subcommands — same executor as the DSH command.
				const sub = _rawInput.trim().split(/\s+/)[0] ?? "";
				await durableReply(name, msg, await runLarkSubcommand(sub.toLowerCase()));
				return true;
			}
			default:
				return false;
		}
	};

	const commandRouter = createCommandRouter({
		ctx: bridge,
		commands: dshCommands,
		bridgeHandler,
	});

	// Card action routing (schema 2.0 behaviors:[{type:"callback",value}]):
	// a button click arrives as card.action.trigger with the op value.
	const handleCardAction = async (data: unknown): Promise<void> => {
		try {
			const raw = data as {
				action?: { value?: Record<string, unknown> };
				message?: { message_id?: string };
				open_id?: string;
			};
			const value = raw.action?.value ?? {};
			const op = typeof value.op === "string" ? value.op : "";
			logger.info(`card action data: ${JSON.stringify(raw).slice(0, 600)}`);
			const chatId =
				(raw as { context?: { open_chat_id?: string } }).context
					?.open_chat_id ??
				(raw as { operator?: { operator_id?: { open_id?: string } } }).operator
					?.operator_id?.open_id ??
				raw.open_id ??
				"";
			const messageId = raw.message?.message_id ?? "";
			if (!op) return;
			// op may be "name" (bare command) or "name:input" (picker callback).
			// Single-select answer: "uqa:<questionId>:<optionIndex>".
			// Multi-select answer: form submit op "uqam:<questionId>" — the
			// callback event carries action.formValue.answer (string[] of
			// selected option values, i.e. stringified option indexes).
			if (op.startsWith("uqam:")) {
				const questionId = op.slice("uqam:".length);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					const form = (raw as { action?: { formValue?: Record<string, unknown> } })
						.action?.formValue;
					const answer = form?.answer;
					const selectedValues = Array.isArray(answer)
						? answer.map((v) => String(v))
						: typeof answer === "string" && answer
							? [answer]
							: [];
					const selected = selectedValues.map((v) => {
						const i = Number(v);
						return Number.isInteger(i) && pending.options[i]
							? pending.options[i].label
							: v;
					});
					void sender
						.sendText(pending.chatId, `已收到你的选择 ✅（${selected.join("、")}）`)
						.catch(() => undefined);
					pending.resolve({
						id: questionId,
						selected,
					});
				}
				return;
			}
			if (op.startsWith("uqa:")) {
				const parts = op.split(":");
				const questionId = parts[1] ?? "";
				const optionIndex = Number(parts[2] ?? NaN);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					const label =
						pending.options[optionIndex]?.label ?? String(optionIndex);
					void sender
						.sendText(pending.chatId, `已收到你的选择 ✅（${label}）`)
						.catch(() => undefined);
					pending.resolve({
						id: questionId,
						selected: [label],
					});
				}
				return;
			}
			const sep = op.indexOf(":");
			const cmd = sep === -1 ? op : op.slice(0, sep);
			const arg = sep === -1 ? "" : op.slice(sep + 1);
			// messageId must be UNIQUE per click: durableReply dedupes command
			// replies by `bridge:<cmd>:<messageId>`, and the card message id is
			// the same for every click on that card — a second click (e.g.
			// picking another model from the picker) used to be swallowed as a
			// duplicate, so the user got NO confirmation for the new choice.
			// chatType: reuse the known route for this chat so the pseudo message
			// lands on the right conversation lane (group vs dm).
			const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
			const pseudo: FeishuInboundMessage = {
				messageId: messageId
					? `${messageId}#${op}`
					: `card#${Date.now()}#${op}`,
				chatId,
				chatType: knownRoute?.chatType === "group" ? "group" : "p2p",
				chatMode: knownRoute?.chatType === "group" ? "group_all" : "p2p",
				senderOpenId: chatId,
				msgType: "interactive",
				content: "",
				text: "",
				mentions: [],
				timestamp: Date.now(),
			};
			await bridgeHandler(cmd, arg, pseudo);
		} catch (err) {
			logger.error(`card action failed: ${String(err)}`);
		}
	};

	const messageHandler = createMessageHandler({
		ctx: bridge,
		commands: commandRouter,
		groupTrigger,
		dedupe,
		allowlist: () => getCfg().allowlist,
		wal: inboundWal,
		// Persist inbound Feishu images/files as real local files under the
		// bridge state dir, so a non-vision model / external tooling can read
		// them off disk (the DSH attachment store alone is in-memory).
		inboundDir: join(dir, "inbound"),
	});

	// ---- conversations / turn supervisor --------------------------------------
	// Session keys whose in-flight turn has produced at least one deliverable
	// assistant output. Used to detect SILENT turn failures (no reply): when a
	// turn ends aborted/rejected WITHOUT any output, the agent is almost
	// certainly stuck (e.g. a reasoning model returning empty `content`, or a
	// swallowed model/tool error) and would keep swallowing every subsequent
	// message — the chat appears broken with no error. We recover it (dispose
	// → fresh session on next message) and surface a diagnostic so it's never
	// a silent no-reply again. Shared by every conversation (keyed by key).
	const turnDelivered = new Set<string>();
	const conversations = createConversationManager({
		backend,
		maxSessions: getCfg().maxSessions,
		idleTtlMs: getCfg().sessionIdleTtlMs,
		logger,
		onEvent: (key, event) => {
			void forwarder
				.onSessionEvent(key, event)
				.catch((e) => logger.warn(`forwarder: ${String(e)}`));
			// Arm the turn watchdog when a turn opens; disarm ONLY on real
			// (non-empty) output or turn end. An EMPTY assistant message (e.g.
			// reasoning models emit content-less messages) must NOT disarm the
			// watchdog — that is exactly how a hung turn used to disable its
			// own recovery and kill the chat until /new. Any observable
			// progress (text chunks, tool calls/results) refreshes the deadline.
			if (event.type === "turn/start") {
				turnDelivered.delete(key);
				turnSupervisor.arm(key);
			}
			if (event.type === "assistant/chunk") {
				if ((event.text ?? "").trim() !== "") turnSupervisor.arm(key);
			}
			if (event.type === "tool/call" || event.type === "tool/result") {
				turnSupervisor.arm(key); // tools run long legitimately — extend
			}
			if (event.type === "assistant/message") {
				if ((event.text ?? "").trim() !== "") {
					turnSupervisor.disarm(key);
					turnDelivered.add(key);
				} else {
					turnSupervisor.arm(key); // empty message — refresh, stay armed
				}
			}
			if (event.type === "turn/end") {
				turnSupervisor.disarm(key);
				const reason = event.reason;
				const silent =
					!turnDelivered.has(key) &&
					(reason === "aborted" ||
						reason === "rejected" ||
						reason === "failed" ||
						reason === "error");
				turnDelivered.delete(key);
				if (silent) {
					logger.warn(
						`turn ended '${reason}' with no output for ${key}; recovering agent`,
					);
					// Detach the fan-out listener so a late event from the dying
					// agent can't re-enter: dispose() drops the hook + tracking.
					void conversations
						.dispose(key)
						.then(() => {
							// Tell the user instead of a mute dead-end. Best effort;
							// the chat id comes from the route table (may be absent).
							const chatId = routeStore.get(key)?.chatId;
							if (chatId) {
								return sender
									.sendText(
										chatId,
										`⚠️ 本轮没有产出回复（turn ended: ${reason}，无输出）。已重置会话，请再发一条消息重试。若仍无回复，请检查 /model 是否指向可用的模型。`,
									)
									.catch(() => undefined);
							}
						})
						.catch((e) =>
							logger.warn(`recover agent for ${key} failed: ${String(e)}`),
						);
				}
			}
		},
	});
	const turnSupervisor = createTurnSupervisor({
		backend,
		timeoutMs: 10 * 60_000,
		logger,
	});

	// ---- compensation -----------------------------------------------------------
	const compensation = createMissedCompensation({
		routes: routeStore,
		listMessages: (p) => sender.listMessages(p),
		reinject: (msg) => messageHandler.handleCompensated(msg),
		logger,
	});

	// ---- GUI-side model default poll -----------------------------------------
	// The deployment default model can change outside the bridge (dsh web UI).
	// The bridge used to sample it exactly once at boot, so a GUI switch was
	// never reflected (chats kept the old model) and never announced. Poll the
	// agentDefaultModel service; on change: adopt it as the bridge default,
	// push it into follower conversations (those WITHOUT a per-chat /model
	// override), and notify the affected Feishu chats which model is in effect.
	let lastModelSig =
		liveModelSelection.provider && liveModelSelection.model
			? `${liveModelSelection.provider}/${liveModelSelection.model}`
			: "";
	let modelPollTimer: NodeJS.Timeout | undefined;
	const startModelDefaultPoll = (): void => {
		if (modelPollTimer || !admService?.currentSelection) return;
		const t = setInterval(() => {
			try {
				const cur = admService?.currentSelection?.();
				if (!cur?.provider || !cur.model) return;
				const sig = `${cur.provider}/${cur.model}`;
				if (sig === lastModelSig) return;
				lastModelSig = sig;
				liveModelSelection.provider = cur.provider;
				liveModelSelection.model = cur.model;
				syncModelFollowers();
				logger.info(`bridge default model now ${sig} (GUI-side switch)`);
				// Notify follower chats only (per-chat overrides are untouched).
				for (const r of routeStore.all()) {
					const o = convCfg.get(r.sessionKey);
					if (o.provider && o.model) continue;
					void sender
						.sendText(
							r.chatId,
							`🌐 默认模型已切换: ${sig}（web 界面操作）。本会话已跟随新模型；如需单独指定请用 /model。`,
						)
						.catch(() => undefined);
				}
			} catch {
				// best-effort
			}
		}, 10_000);
		t.unref?.();
		modelPollTimer = t;
	};
	const stopModelDefaultPoll = (): void => {
		if (modelPollTimer) clearInterval(modelPollTimer);
		modelPollTimer = undefined;
	};

	// ---- lifecycle -------------------------------------------------------------
	let lifecycleStarted = false;
	let supervisor: ReturnType<typeof createConnectionSupervisor> | undefined;

	const startBridge = async (): Promise<void> => {
		if (lifecycleStarted) return;
		// Resolve credentials + build the lark client before wiring the transport.
		// Missing credentials is NOT fatal (the plugin must still load) — bail with
		// a clear blocker so /lark start reports it and the plugin survives.
		const ref = getCfg().credentialRef;
		const creds = await resolveCredentials(credStore, ref);
		if (!creds) {
			startBlocker = `未配置飞书凭据（ref=${ref}）。请先运行 /lark setup 扫码，或设置 DSH_LARK_APP_ID/DSH_LARK_APP_SECRET 后再 /lark setup。`;
			logger.warn(startBlocker);
			return;
		}
		startBlocker = undefined;
		logger.info("starting bridge…");
		try {
			larkClient = await buildLarkClient({
				appId: creds.appId,
				appSecret: creds.appSecret,
				domain: creds.domain,
				logger,
			});
		} catch (err) {
			startBlocker = `lark client 构建失败: ${err instanceof Error ? err.message : String(err)}`;
			logger.error(startBlocker);
			return;
		}
		bridge.setConversations(conversations);
		bridge.setOutbox(outbox);
		bridge.setForwarder(forwarder);
		bridge.setCompensation(compensation);
		outbox.rebuildFromDisk();
		outbox.start();
		turnSupervisor.start();
		startModelDefaultPoll();

		// Transport + supervisor (in-process): WS long connection owns reconnects
		// via probe-driven supervisor; card actions route through the same handler.
		const transport = createTransport({
			getClient: () => larkClient ?? ({} as FeishuClientLike),
			onMessage: async (msg) => {
				// Custom answer to a pending intent question: a plain-text reply
				// in the same chat resolves it instead of reaching the agent.
				const pendingForChat = [...pendingQuestions.values()].find(
					(p) => p.chatId === msg.chatId,
				);
				if (pendingForChat && (msg.text ?? "").trim() !== "") {
					clearTimeout(pendingForChat.timer);
					pendingQuestions.delete(pendingForChat.questionId);
					const text = (msg.text ?? "").trim();
					pendingForChat.resolve({
						id: pendingForChat.questionId,
						selected: [],
						custom: text,
					});
					return;
				}
				await messageHandler.handleInbound(msg);
			},
			onEvent: (event, data) => {
				if (event === "card.action.trigger") void handleCardAction(data);
			},
			logger,
		});
		bridge.setTransport(transport);
		const quota2 = createQuotaGovernor(join(dir, "conn-history.jsonl"), {
			windowMinutes: getCfg().quota.windowMinutes,
			limit: getCfg().quota.limit,
		});
		supervisor = createConnectionSupervisor({
			transport,
			quota: quota2,
			status,
			cfg: {
				probeIntervalMs: getCfg().supervisor.probeIntervalMs,
				probeTimeoutMs: getCfg().supervisor.probeTimeoutMs,
				probeFailThreshold: getCfg().supervisor.probeFailThreshold,
				maxReconnectAttempts: getCfg().supervisor.maxReconnectAttempts,
				idleKeepaliveMs: getCfg().supervisor.idleKeepaliveMs,
				quotaWindowMinutes: getCfg().quota.windowMinutes,
				quotaLimit: getCfg().quota.limit,
			},
			logger,
			onStateChange: (state, detail) => {
				if (state === "connected") bridge.setBotOpenId(transport.botOpenId());
				logger.info(`conn state: ${state}${detail ? ` (${detail})` : ""}`);
			},
		});
		await supervisor.start();
		bridge.setBotOpenId(transport.botOpenId());

		status.refreshCounters({
			outboxPending: outbox.pendingCount(),
			outboxFailed: outbox.failedCount(),
			inboundPending: inboundWal.pendingReplays().length,
		});
		status.setConn("connected", {
			wsReady: transport.wsReady(),
		});
		bridge.setStarted(true);
		lifecycleStarted = true;
		// ---- inbound request replay (入站请求补发) -----------------------------
		// Any text request recorded as "accepted" but whose agent-turn never
		// produced a durable output was almost certainly interrupted by the
		// previous process dying / a plugin reload / a dsh restart. Re-dispatch
		// it through the normal inbound pipeline (skipDedupe via handleCompensated)
		// so the user's request is answered, not silently dropped. Each record is
		// attempt-capped (default 2) within a replay window (default 30 min), so a
		// genuinely broken request can't loop forever. Fire-and-forget: never
		// blocks bridge startup.
		void (async () => {
			let replayed = 0;
			try {
				inboundWal.prune();
				for (const rec of inboundWal.pendingReplays()) {
					if (!inboundWal.markReplay(rec.messageId)) continue;
					try {
						await messageHandler.handleCompensated({
							messageId: rec.messageId,
							chatId: rec.chatId,
							chatType: rec.chatType,
							chatMode:
								rec.chatType === "p2p" ? "p2p" : "group_all",
							senderOpenId: rec.senderOpenId,
							msgType: "text",
							content: rec.text,
							text: rec.text,
							mentions: [],
							timestamp: rec.acceptedAt,
						});
						replayed++;
					} catch (err) {
						logger.warn(
							`inbound replay failed for ${rec.messageId}: ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
					}
				}
				if (replayed > 0)
					logger.info(`inbound replay re-dispatched ${replayed} request(s)`);
				// Reflect the post-replay pending count (requests that could not be
				// immediately answered stay visible in /status for transparency).
				status.refreshCounters({
					inboundPending: inboundWal.pendingReplays().length,
				});
			} catch (err) {
				logger.warn(
					`inbound replay errored: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		})();
		logger.info("bridge started (in-process) [HMR-RELOAD-MARKER-2]");
	};
	const stopBridge = async (): Promise<void> => {
		if (!lifecycleStarted) return;
		logger.info("stopping bridge…");
		turnSupervisor.stop();
		stopModelDefaultPoll();
		await supervisor?.stop();
		supervisor = undefined;
		await outbox.stop();
		await conversations.disposeAll();
		bridge.setStarted(false);
		status.setConn("stopped");
		lifecycleStarted = false;
		logger.info("bridge stopped");
	};

	// ---- tools ------------------------------------------------------------------
	ctx.tools.register(
		defineTool({
			name: "lark_send_local_file",
			description: "Send a local file or image to the current Feishu chat.",
			parameters: {
				path: {
					type: "string",
					required: true,
					description: "Absolute local path",
				},
				kind: {
					type: "string",
					required: true,
					description:
						"image（png/jpeg/webp/gif，其他格式如 svg 自动按 file 发送）| file",
				},
				caption: { type: "string", description: "Optional caption text" },
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: value as string }],
			},
			async execute(args, exec) {
				// Resolve the requesting conversation FIRST: exec.agent.id is the
				// bridge session id (lark-link:dm:ou_x:nonce). The session id
				// carries the per-run nonce suffix while route keys do not —
				// prefer the backend reverse map, else strip the trailing nonce.
				const sessionId = (exec as { agent?: { id?: string } }).agent?.id ?? "";
				// The agent's workspace is its conversation's workspace (per-key
				// override ?? config.workspaceRoot; may differ from the dsh process
				// cwd after /workspace) — resolve relative paths against it and
				// whitelist it. Using process.cwd() wrongly rejects files the agent
				// just created in its workspace.
				const convKeyForWs =
					bridge.backend?.keyForSessionId?.(sessionId) ?? sessionId;
				const workspaceRoot =
					convCfg.get(convKeyForWs).workspaceRoot ??
					(getCfg().workspaceRoot || process.cwd());
				const abs = resolve(
					args.path.startsWith("/")
						? args.path
						: join(workspaceRoot, args.path),
				);
				if (!abs.startsWith(workspaceRoot)) return "拒绝: 路径不在工作区内";
				const prefix = "lark-link:";
				const backendKey = bridge.backend?.keyForSessionId?.(sessionId);
				const key =
					backendKey ??
					(sessionId.startsWith(prefix)
						? sessionId.slice(prefix.length).replace(/:[a-z0-9]{8,}$/, "")
						: sessionId);
				const route = routeStore.get(key);
				if (!route) return "错误: 无法定位当前飞书会话";
				const client = getLarkClient();
				if (!client) return "错误: lark 客户端未就绪";
				// Feishu image upload only accepts raster formats — non-raster
				// (svg etc.) falls back to file upload regardless of kind.
				const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
				const isImage = args.kind === "image" && IMAGE_EXT.test(args.path);
				if (isImage ? !client.uploadImage : !client.uploadFile)
					return "错误: lark 客户端未就绪";
				let buf: Buffer;
				try {
					const st = statSync(abs);
					if (st.size > 25 * 1024 * 1024) return "错误: 文件超过 25MB 上限";
					buf = readFileSync(abs);
				} catch (err) {
					return `错误: 读取文件失败 (${err instanceof Error ? err.message : String(err)})`;
				}
				const fileName = args.path.split(/[\\/]/).pop() ?? "file";
				// Tolerate both real top-level and legacy {data:{...}} shapes (pi 2026-08-14).
				let uploadKey: string | undefined;
				if (isImage) {
					uploadKey = extractUploadKey(
						await client.uploadImage!({ image: buf }),
						"image_key",
					);
				} else {
					uploadKey = extractUploadKey(
						await client.uploadFile!({
							file_type: "file",
							file_name: fileName,
							file: buf,
						}),
						"file_key",
					);
				}
				if (!uploadKey) return "错误: 上传失败";
				await sender.sendFile(
					route.chatId,
					uploadKey,
					isImage ? "image" : "file",
				);
				return `已发送 ${args.path}`;
			},
		}),
	);
	ctx.tools.register(
		defineTool({
			name: "lark_config_get",
			description: "Read bridge config (hot-reloadable keys).",
			parameters: {},
			output: {
				schema: { type: "string" },
				render: (_a, v) => [{ type: "text", text: v as string }],
			},
			async execute() {
				return JSON.stringify(getCfg(), null, 2);
			},
		}),
	);

	// ---- commands (DSH-side /lark-*) -------------------------------------------
	const commandsCtx = ctx as unknown as {
		commands?: { register(d: unknown): void };
	};
	const registerCmd = (
		name: string,
		description: string,
		handler: (rawInput: string) => Promise<string>,
		inputHint?: string,
	): void => {
		commandsCtx.commands?.register?.({
			name,
			description,
			// input hint is REQUIRED for the DSH web composer to execute a
			// command with arguments: ui-commands' matchEnter returns a claim
			// only when desc.input is defined, otherwise a non-bare slash line
			// (/lark setup) falls through to the agent as a plain message.
			...(inputHint !== undefined ? { input: { hint: inputHint } } : {}),
			handler: async (inv: { rawInput?: string }) => ({
				kind: "success",
				text: await handler(inv?.rawInput ?? ""),
			}),
		});
	};
	// Shared /lark subcommand executor — used by the DSH command (/lark x) AND
	// the Feishu-side route (/lark x in chat). startBridge/stopBridge/runSetup
	// are resolved at call time (all initialized before any message arrives).
	const runLarkSubcommand = async (sub: string): Promise<string> => {
		switch (sub) {
			case "status":
				return formatStatusLine(status.get());
			case "start":
				await startBridge();
				return lifecycleStarted
					? "bridge started"
					: (startBlocker ?? "bridge 未启动");
			case "stop":
				await stopBridge();
				return "bridge stopped";
			case "restart":
				await stopBridge();
				await startBridge();
				return lifecycleStarted
					? "bridge restarted"
					: (startBlocker ?? "bridge 未启动");
			case "setup":
				return await runSetup();
			case "uninstall-clean":
				return await runUninstallClean();
			default:
				return "Lark Link 用法：/lark setup | start | stop | restart | status | uninstall-clean";
		}
	};
	// Single /lark command with subcommand dispatch (DSH command names can't
	// contain spaces — the space separates name from input — so /lark setup is
	// command 'lark' + input 'setup', not a 'lark setup' command).
	registerCmd(
		"lark",
		"Lark Link bridge — usage: /lark setup|start|stop|restart|status|uninstall-clean",
		async (rawInput) =>
			runLarkSubcommand((rawInput.trim().split(/\s+/)[0] ?? "").toLowerCase()),
		"setup|start|stop|restart|status|uninstall-clean",
	);

	/**
	 * Locate the DSH session log for a bridge session id. Persisted logs live
	 * at <DSH_HOME>/sessions/<workspace-dir>/<encoded-session-id>/session.jsonl.zstd
	 * where ":" encodes as "~003A" — scan every workspace dir for the match.
	 */
	/** Scan ~/.dsh/sessions for the most recently written lark-link session id. */
	const findLatestLarkSessionId = (): string | undefined => {
		const sessionsRoot = join(
			process.env.DSH_HOME ?? join(homedir(), ".dsh"),
			"sessions",
		);
		if (!existsSync(sessionsRoot)) return undefined;
		let latest: { id: string; mtime: number } | undefined;
		for (const wsDir of readdirSync(sessionsRoot)) {
			const wsPath = join(sessionsRoot, wsDir);
			let entries: string[] = [];
			try {
				entries = readdirSync(wsPath);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!name.includes("lark-link")) continue;
				const sessionDir = join(wsPath, name);
				const zstd = join(sessionDir, "session.jsonl.zstd");
				if (!existsSync(zstd)) continue;
				let mtime = 0;
				try {
					mtime = statSync(zstd).mtimeMs;
				} catch {
					continue;
				}
				if (!latest || mtime > latest.mtime) {
					latest = { id: name.replace(/~003A/g, ":"), mtime };
				}
			}
		}
		return latest?.id;
	};

	const buildSessionExportZip = async (
		sessionId: string,
		diagText: string,
		issueMd: string,
	): Promise<Buffer | undefined> => {
		try {
			const services = ctx as unknown as {
				get?(name: string): unknown;
			};
			const persistence = services.get?.("sessionPersistence") as
				| {
						readRaw?(
							id: string,
						): Promise<
							{ filename: string; content: string; meta?: unknown } | undefined
						>;
				  }
				| undefined;
			const query = services.get?.("sessionQuery") as
				| {
						traceSession?(id: string): Promise<{
							descendants: Array<{
								session: { header: { id: string } };
								descendants: Array<{
									session: { header: { id: string } };
									descendants: unknown[];
								}>;
							}>;
						}>;
				  }
				| undefined;
			const files: Array<{ name: string; data: Uint8Array }> = [];

			// Primary: same shape as the webui "Session log" download via the
			// sessionPersistence service.
			let root: { filename: string; content: string } | undefined;
			if (persistence?.readRaw) {
				try {
					root = await persistence.readRaw(sessionId);
				} catch (err) {
					logger.warn(
						`doctor: sessionPersistence.readRaw failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			} else {
				logger.warn(
					"doctor: sessionPersistence service unavailable — falling back to file scan",
				);
			}
			if (root) {
				files.push({
					name: root.filename,
					data: Buffer.from(root.content, "utf8"),
				});
				// Descendant (subagent) logs.
				const seen = new Set<string>([sessionId]);
				const collect = async (
					nodes: Array<{
						session: { header: { id: string } };
						descendants: unknown[];
					}>,
				): Promise<void> => {
					for (const node of nodes) {
						const id = node.session.header.id;
						if (seen.has(id)) continue;
						seen.add(id);
						const raw = await persistence?.readRaw?.(id);
						if (raw !== undefined) {
							const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
							files.push({
								name: `subagents/${safe}/${raw.filename}`,
								data: Buffer.from(raw.content, "utf8"),
							});
						}
						await collect((node.descendants ?? []) as typeof nodes);
					}
				};
				if (query?.traceSession) {
					try {
						const lineage = await query.traceSession(sessionId);
						await collect(lineage.descendants as never);
					} catch (err) {
						logger.warn(
							`doctor: traceSession failed (subagents skipped): ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}

			// Fallback: locate the session log on disk directly (node:zlib
			// decompresses zstd; no system unzstd needed).
			if (files.length === 0) {
				const sessionsRoot = join(
					process.env.DSH_HOME ?? join(homedir(), ".dsh"),
					"sessions",
				);
				const encoded = sessionId.replace(/:/g, "~003A");
				let zstdPath: string | undefined;
				if (existsSync(sessionsRoot)) {
					for (const wsDir of readdirSync(sessionsRoot)) {
						const candidate = join(
							sessionsRoot,
							wsDir,
							encoded,
							"session.jsonl.zstd",
						);
						if (existsSync(candidate)) {
							zstdPath = candidate;
							break;
						}
					}
				}
				if (!zstdPath) {
					logger.warn(
						`doctor: no session log found for ${sessionId} (service + file scan)`,
					);
					return undefined;
				}
				const jsonl = zstdDecompressSync(readFileSync(zstdPath)).toString(
					"utf8",
				);
				logger.info(`doctor: file-scan fallback used: ${zstdPath}`);
				files.push({ name: "session.jsonl", data: Buffer.from(jsonl, "utf8") });
			}

			// ISSUE.md + README (diagnostic bundle extras).
			files.push({
				name: "ISSUE.md",
				data: Buffer.from(
					`# dsh-lark-link 诊断包\n\n${diagText}\n\n${issueMd}\n`,
					"utf8",
				),
			});
			files.push({
				name: "README.txt",
				data: Buffer.from(
					[
						"本压缩包内容：",
						"- session.jsonl: 当前会话的 DSH session log（与 WebUI 右上角 Session log 下载一致）",
						"- subagents/: 子代理会话日志",
						"- ISSUE.md: 脱敏诊断信息（配置/连接状态/Outbox 等）",
						"",
						"将本包直接发给维护者，或贴 ISSUE.md 给 AI 即可定位问题。",
					].join("\n"),
					"utf8",
				),
			});

			// fflate sync ZIP (same compressor family the host export uses;
			// zipSync returns the archive directly — the streaming Zip callback
			// fires asynchronously, so reading its output synchronously would
			// yield an empty buffer).
			const { zipSync, strToU8 } = await import("fflate");
			const entries: Record<string, Uint8Array> = {};
			for (const f of files) {
				entries[f.name] = strToU8(new TextDecoder().decode(f.data));
			}
			const buf = Buffer.from(zipSync(entries, { level: 6 }));
			logger.info(
				`doctor: zip built (${files.length} files, ${buf.length} bytes)`,
			);
			return buf;
		} catch (err) {
			logger.warn(
				`doctor: zip build failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return undefined;
		}
	};

	const runSetup = async (): Promise<string> => {
		const ref = getCfg().credentialRef;
		// Manual channel via env (headless / GUI / CI).
		const envAppId = process.env.DSH_LARK_APP_ID?.trim();
		const envSecret = process.env.DSH_LARK_APP_SECRET?.trim();
		if (envAppId && envSecret) {
			const envDomain = (
				process.env.DSH_LARK_DOMAIN === "lark" ? "lark" : "feishu"
			) as LarkDomain;
			await persistCredentials(credStore, ref, {
				appId: envAppId,
				appSecret: envSecret,
				domain: envDomain,
			});
			return `凭据已保存（env 手动，appId=${maskId(envAppId)}，domain=${envDomain}）。运行 /lark start 启动。`;
		}
		// QR channel — NON-BLOCKING. registerApp only resolves AFTER the user
		// scans; awaiting it would hang the GUI ("执行中…") and the QR was only
		// going to host stdout. So: run registerApp detached in the background
		// (persists creds on scan), surface the QR URL to the GUI as soon as
		// onQRCodeReady fires, and return immediately.
		let qrInfo: { url: string; expireIn: number } | undefined;
		void (async () => {
			const setup = createAuthSetup({
				// SDK registerApp is broken under Node ESM: its axios 1.19.x
				// `default.default` entry (index.js → lib/axios.js) drives https
				// through http.request → "Protocol \"https:\" not supported".
				// Use the fetch-based implementation of the same device-code flow.
				registerApp: registerAppWithFetch(),
				persist: async (c) => {
					await persistCredentials(credStore, ref, c);
				},
				logger,
			});
			try {
				const res = await setup.run({
					onQRCodeReady(info) {
						qrInfo = info;
						// Render a PNG for the Web GUI panel (host-served route) and mirror
						// an ASCII QR to the terminal for TTY users.
						void QRCode.toBuffer(info.url, {
							type: "png",
							margin: 1,
							width: 256,
						})
							.then((png) => {
								activeQr = {
									png,
									expireAt: Date.now() + info.expireIn * 1000,
								};
							})
							.catch((e) =>
								logger.warn(
									`qr png failed: ${e instanceof Error ? e.message : String(e)}`,
								),
							);
						try {
							qrcode.generate(info.url, { small: true }, (qr) =>
								console.log(`\n${qr}`),
							);
						} catch {
							// qrcode-terminal optional
						}
					},
					onStatusChange: (s) => logger.info(`setup: ${s}`),
				});
				logger.info(`setup complete: appId=${res.appId} domain=${res.domain}`);
				activeQr = undefined;
			} catch (err) {
				logger.warn(
					`setup background failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				activeQr = undefined;
			}
		})();
		// Bounded wait for the QR to appear (registerApp reaches Feishu first).
		const deadline = Date.now() + 30_000;
		while (!qrInfo && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 200));
		}
		if (!qrInfo) {
			return "扫码流程未在 30s 内就绪。可改用手动通道：设 DSH_LARK_APP_ID + DSH_LARK_APP_SECRET 后再 /lark setup。";
		}
		console.log(
			`飞书授权二维码链接: ${qrInfo.url}（${qrInfo.expireIn} 秒后过期）`,
		);
		return [
			"📱 飞书授权二维码已生成 —— 见左侧 🪶 Lark 面板（或终端），手机飞书扫码确认。",
			"",
			`二维码 ${qrInfo.expireIn} 秒后过期。扫码后凭据在后台写入，运行 /lark start 启动。`,
			`备用链接（手机浏览器打开）：${qrInfo.url}`,
			"看不到二维码？终端也打印了；或用 DSH_LARK_APP_ID/SECRET 手动通道。",
		].join("\n");
	};

	const runUninstallClean = async (): Promise<string> => {
		await stopBridge();
		const ref = getCfg().credentialRef;
		await clearCredentials(credStore, ref);
		larkClient = undefined;
		for (const f of [
			"config.json",
			"routes.json",
			"dedupe.jsonl",
			"conn-history.jsonl",
			"status.json",
			"runtime-overrides.json",
		]) {
			try {
				rmSync(join(dir, f), { force: true });
			} catch {
				// best effort
			}
		}
		try {
			rmSync(join(dir, "outbox"), { recursive: true, force: true });
		} catch {
			// best effort
		}
		try {
			rmSync(join(dir, "inbound-wal"), { recursive: true, force: true });
		} catch {
			// best effort
		}
		return `已清除凭据（ref=${ref}）并清理状态目录 ${dir}。重新使用请运行 /lark setup。`;
	};

	// ---- system prompt section ---------------------------------------------------
	try {
		(
			ctx as unknown as { systemPrompt?: { section(s: unknown): void } }
		).systemPrompt?.section?.({
			priority: 200,
			section: () => ({
				role: "system",
				content: [
					"你正在通过飞书/Lark 桥接与用户对话。",
					"可用工具: lark_send_local_file（发送本地文件到当前飞书会话）、lark_config_get（读取桥配置）。",
					"回复要简洁；长输出会自动流式呈现给用户。",
				].join("\n"),
			}),
		});
	} catch {
		// prompt section optional
	}

	// ---- lifecycle registration (Cordis disposer — clean unload) ----------------
	ctx.effect(() => {
		void startBridge();
		const sweep = setInterval(() => {
			const n = conversations.sweep();
			if (n > 0)
				status.refreshCounters({
					outboxPending: outbox.pendingCount(),
					outboxFailed: outbox.failedCount(),
					inboundPending: inboundWal.pendingReplays().length,
				});
		}, 60_000);
		sweep.unref?.();
		return async () => {
			clearInterval(sweep);
			await stopBridge();
		};
	});
}
