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
import { createConfigStore } from "./common/config.ts";
import { createLogger, type Logger } from "./common/logger.ts";
import { createDedupeStore } from "./common/dedupe-store.ts";
import { createQuotaGovernor } from "./common/quota-governor.ts";
import { helpCard } from "./presentation/cards.ts";
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
import { mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
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
	const getCfg = (): ReturnType<typeof configStore.get> => configStore.get();

	// ---- backend: real DSH adapter, falling back to the in-memory mock ------
	let backend;
	try {
		backend = createDshAdapter({
			ctx,
			sessionPrefix: "lark-link",
			logger,
			cwd: () => getCfg().workspaceRoot || process.cwd(),
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

	const bridgeHandler = async (
		name: string,
		_rawInput: string,
		msg: FeishuInboundMessage,
	): Promise<boolean> => {
		switch (name) {
			case "status":
			case "feishu-config":
			case "lark-config":
				await sender.replyTo(
					msg,
					formatStatusLine(status.get()) +
						"\n\n" +
						statusDetailLines(status.get()).join("\n"),
				);
				return true;
			case "support":
			case "doctor": {
				// pi design: the diagnostic bundle comes back as a FILE, not a wall
				// of text — upload the generated report and send it (fall back to
				// text when upload is unavailable).
				const diag = await diagnostics.build();
				const client = getLarkClient();
				if (client?.uploadFile) {
					try {
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
				await sender.replyTo(msg, diag.text);
				return true;
			}
			case "sessions": {
				// List live bridge sessions (pi f752ece /sessions 决策).
				const keys = bridge.conversations?.keys() ?? [];
				const lines = keys.length
					? keys.map((k) => `- ${k}`)
					: ["（无活跃会话）"];
				await sender.replyTo(
					msg,
					`**会话列表 (${keys.length})**\n\n` + lines.join("\n"),
				);
				return true;
			}
			case "help":
				await sender.replyTo(msg, helpCard());
				return true;
			case "workspace": {
				const arg = _rawInput.trim();
				if (!arg) {
					await sender.replyTo(
						msg,
						`工作区: ${getCfg().workspaceRoot || process.cwd()}`,
					);
					return true;
				}
				// /workspace <path> — switch the bridge workspace root: persist it
				// and dispose hosted sessions so the next message rebuilds agents
				// under the new cwd (DSH session cwd is fixed at creation).
				const target = resolve(arg);
				if (!target.startsWith("/")) {
					await sender.replyTo(msg, `无效路径: ${arg}`);
					return true;
				}
				try {
					if (!statSync(target).isDirectory()) {
						await sender.replyTo(msg, `不是有效目录: ${target}`);
						return true;
					}
				} catch {
					await sender.replyTo(msg, `目录不存在: ${target}`);
					return true;
				}
				configStore.update({ workspaceRoot: target });
				configStore.saveOverrides();
				await conversations?.disposeAll();
				await sender.replyTo(
					msg,
					`工作区已切换: ${target}\n会话已重置，下一条消息在新工作区生效。`,
				);
				return true;
			}
			case "stop": {
				const key = bridge.conversationKeyFor(msg);
				await bridge.conversations?.stop(key);
				await sender.replyTo(msg, "已停止当前会话任务");
				return true;
			}
			case "lark": {
				// Feishu-side /lark subcommands — same executor as the DSH command.
				const sub = _rawInput.trim().split(/\s+/)[0] ?? "";
				await sender.replyTo(msg, await runLarkSubcommand(sub.toLowerCase()));
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
			const chatId = raw.open_id ?? "";
			const messageId = raw.message?.message_id ?? "";
			if (!op) return;
			const pseudo: FeishuInboundMessage = {
				messageId,
				chatId,
				chatType: "p2p",
				chatMode: "p2p",
				senderOpenId: chatId,
				msgType: "interactive",
				content: "",
				text: "",
				mentions: [],
				timestamp: Date.now(),
			};
			await bridgeHandler(op, "", pseudo);
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
	});

	// ---- conversations / turn supervisor --------------------------------------
	const conversations = createConversationManager({
		backend,
		maxSessions: getCfg().maxSessions,
		idleTtlMs: getCfg().sessionIdleTtlMs,
		onEvent: (key, event) => {
			void forwarder
				.onSessionEvent(key, event)
				.catch((e) => logger.warn(`forwarder: ${String(e)}`));
			// Arm the turn watchdog when a turn opens; disarm on completion/output.
			// (Previously arm was never called — the watchdog was dead code.)
			if (event.type === "turn/start") turnSupervisor.arm(key);
			if (event.type === "turn/end" || event.type === "assistant/message") {
				turnSupervisor.disarm(key);
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

		// Transport + supervisor (in-process): WS long connection owns reconnects
		// via probe-driven supervisor; card actions route through the same handler.
		const transport = createTransport({
			getClient: () => larkClient ?? ({} as FeishuClientLike),
			onMessage: async (msg) => {
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
		});
		status.setConn("connected", {
			wsReady: transport.wsReady(),
		});
		bridge.setStarted(true);
		lifecycleStarted = true;
		logger.info("bridge started (in-process) [HMR-RELOAD-MARKER-2]");
	};
	const stopBridge = async (): Promise<void> => {
		if (!lifecycleStarted) return;
		logger.info("stopping bridge…");
		turnSupervisor.stop();
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
				kind: { type: "string", required: true, description: "image | file" },
				caption: { type: "string", description: "Optional caption text" },
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: value as string }],
			},
			async execute(args, exec) {
				const abs = resolve(args.path);
				const cwd = process.cwd();
				if (!abs.startsWith(cwd)) return "拒绝: 路径不在工作区内";
				// Resolve the requesting conversation: exec.agent.id is the bridge
				// session id (lark-link:dm:ou_x:nonce). The session id carries the
				// per-run nonce suffix while route keys do not — prefer the backend
				// reverse map, else strip the trailing nonce.
				const sessionId =
					(exec as { agent?: { id?: string } }).agent?.id ?? "";
				const prefix = "lark-link:";
				const backendKey = bridge.backend?.keyForSessionId?.(sessionId);
				const key =
					backendKey ??
					(sessionId.startsWith(prefix)
						? sessionId
								.slice(prefix.length)
								.replace(/:[a-z0-9]{8,}$/, "")
						: sessionId);
				const route = routeStore.get(key);
				if (!route) return "错误: 无法定位当前飞书会话";
				const client = getLarkClient();
				if (!client) return "错误: lark 客户端未就绪";
				const isImage = args.kind === "image";
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
				});
		}, 60_000);
		sweep.unref?.();
		return async () => {
			clearInterval(sweep);
			await stopBridge();
		};
	});
}
