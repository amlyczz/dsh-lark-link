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
import { createNotificationService } from "./application/notification-service.ts";
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
import { acquireGatewayLock } from "./host/gateway-lock.ts";
import { createAuthSetup } from "./host/auth-setup.ts";
import {
	resolveCredentials,
	persistCredentials,
	clearCredentials,
	buildLarkClient,
	type CredentialsStore,
	type LarkDomain,
} from "./host/lark-client.ts";
import * as qrcode from "qrcode-terminal";
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
		backend = createDshAdapter({ ctx, sessionPrefix: "lark-link", logger });
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
		streamFor: () => undefined, // streaming cards wired once lark client is up
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
		has: (name) =>
			(
				ctx as unknown as { commands?: { has?(n: string): boolean } }
			).commands?.has?.(name) ?? false,
		async run(name, rawInput, agentId) {
			try {
				const registry = (
					ctx as unknown as {
						commands?: {
							run?(
								n: string,
								r: string,
								a: string,
							): Promise<{ kind: string; text?: string }>;
						};
					}
				).commands;
				if (!registry?.run)
					return { kind: "error", text: "commands service unavailable" };
				return await registry.run(name, rawInput, agentId);
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
			case "doctor":
				await sender.replyTo(msg, (await diagnostics.build()).text);
				return true;
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
			case "workspace":
				await sender.replyTo(msg, `工作区: ${process.cwd()}`);
				return true;
			case "stop": {
				const key = bridge.conversationKeyFor(msg);
				await bridge.conversations?.stop(key);
				await sender.replyTo(msg, "已停止当前会话任务");
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
		status.setConn("connected");
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
				// session id (lark-link:dm:ou_x / lark-link:group:oc_…).
				const sessionId = (exec as { agent?: { id?: string } }).agent?.id ?? "";
				const prefix = "lark-link:";
				const key = sessionId.startsWith(prefix)
					? sessionId.slice(prefix.length)
					: sessionId;
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
		handler: () => Promise<string>,
	): void => {
		commandsCtx.commands?.register?.({
			name,
			description,
			handler: async () => ({ kind: "success", text: await handler() }),
		});
	};
	registerCmd("lark-status", "Show Lark Link bridge status", async () =>
		formatStatusLine(status.get()),
	);
	registerCmd("lark-start", "Start the bridge", async () => {
		await startBridge();
		return lifecycleStarted
			? "bridge started"
			: (startBlocker ?? "bridge 未启动");
	});
	registerCmd("lark-stop", "Stop the bridge", async () => {
		await stopBridge();
		return "bridge stopped";
	});
	registerCmd("lark-restart", "Restart the bridge", async () => {
		await stopBridge();
		await startBridge();
		return lifecycleStarted
			? "bridge restarted"
			: (startBlocker ?? "bridge 未启动");
	});

	registerCmd(
		"lark-setup",
		"Scan QR (or set DSH_LARK_APP_ID/DSH_LARK_APP_SECRET env) to configure Feishu credentials",
		async () => {
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
			const lark = await import("@larksuiteoapi/node-sdk");
			let qrInfo: { url: string; expireIn: number } | undefined;
			void (async () => {
				const setup = createAuthSetup({
					registerApp: lark.registerApp,
					persist: async (c) => {
						await persistCredentials(credStore, ref, c);
					},
					logger,
				});
				try {
					const res = await setup.run({
						onQRCodeReady(info) {
							qrInfo = info;
							// Mirror to the host terminal for TTY users.
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
				} catch (err) {
					logger.warn(
						`setup background failed: ${err instanceof Error ? err.message : String(err)}`,
					);
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
			console.log(`飞书授权二维码链接: ${qrInfo.url}（${qrInfo.expireIn} 秒后过期）`);
			return [
				"📱 飞书授权二维码已生成，请在手机飞书扫码确认。",
				"",
				`链接（手机浏览器可直接打开）：${qrInfo.url}`,
				`二维码 ${qrInfo.expireIn} 秒后过期。`,
				"",
				"扫码确认后凭据会在后台写入 ctx.credentials，稍后运行 /lark start 启动桥接。",
				"（终端也打印了二维码；看不到就用 DSH_LARK_APP_ID/SECRET 手动通道。）",
			].join("\n");
		},
	);

	registerCmd(
		"lark-uninstall-clean",
		"Remove credentials + wipe bridge state (irreversible)",
		async () => {
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
		},
	);

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
