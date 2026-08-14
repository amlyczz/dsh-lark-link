// Inbound event normalization: Feishu v2.0 event → FeishuInboundMessage.
// The v2.0 nested structure (message_id lives inside event.message, not at the
// top level) silently dropped message ids in the pi bridge — the "ultimate
// root cause" of "no replies". This module is the DSH twin of that fix, with a
// structure matrix in tests. Harness-agnostic pure functions.

import type {
	ChatMode,
	ChatType,
	FeishuInboundMessage,
	FeishuMsgType,
} from "../common/types.ts";

interface RawEvent {
	/** v2.0 envelope marker. */
	schema?: string;
	header?: { event_type?: string; event_id?: string; token?: string };
	/** v2.0 "event" container (may be empty). */
	event?: Record<string, unknown>;
	/** v2.0 nested message object. */
	message?: {
		message_id?: string;
		chat_id?: string;
		chat_type?: string; // "p2p" | "group"
		message_type?: string;
		content?: string;
		parent_id?: string;
		root_id?: string;
		thread_id?: string;
		mentions?: Array<{
			key?: string;
			id?: { open_id?: string; user_id?: string };
			name?: string;
		}>;
		create_time?: string;
	};
	/** Fallback flat fields (older events / some SDKs). */
	message_id?: string;
	chat_id?: string;
	chat_type?: string;
	message_type?: string;
	content?: string;
	parent_id?: string;
	root_id?: string;
	thread_id?: string;
	create_time?: string;
	mentions?: Array<{
		key?: string;
		id?: { open_id?: string; user_id?: string };
		name?: string;
	}>;
	sender?: {
		sender_id?: { open_id?: string; user_id?: string };
		sender_type?: string;
		tenant_key?: string;
	};
	operator?: {
		operator_id?: { open_id?: string; user_id?: string };
	};
}

export interface NormalizeOptions {
	/** Bot's own open id — used to strip self-mentions. */
	botOpenId?: string;
	/** Effective group policy (drives chatMode classification). */
	groupPolicy?: "open" | "mention" | "keywords" | "reply";
	/** Keywords for groupPolicy="keywords". */
	groupKeywords?: string[];
	/** Whether the sender mentioned the bot explicitly. */
	mentionedBot?: boolean;
}

export function msgTypeOf(type: string | undefined): FeishuMsgType {
	switch (type) {
		case "text":
			return "text";
		case "post":
			return "post";
		case "image":
			return "image";
		case "file":
			return "file";
		case "audio":
			return "audio";
		case "interactive":
			return "interactive";
		default:
			return "unknown";
	}
}

function pickText(
	contentRaw: string | undefined,
	msgType: FeishuMsgType,
): string | undefined {
	if (!contentRaw) return undefined;
	try {
		const parsed = JSON.parse(contentRaw) as Record<string, unknown>;
		if (typeof parsed.text === "string") return parsed.text;
		// post with text segments
		const content = parsed.content as
			| {
					paragraphs?: Array<{
						elements?: Array<{ text_run?: { content?: string } }>;
					}>;
			  }
			| undefined;
		if (msgType === "post" && content?.paragraphs) {
			return content.paragraphs
				.map((p) =>
					(p.elements ?? []).map((e) => e.text_run?.content ?? "").join(""),
				)
				.join("\n");
		}
		if (typeof parsed.content === "string") return parsed.content;
	} catch {
		return contentRaw; // not JSON — treat as plain text
	}
	return undefined;
}

export function chatModeFor(opts: {
	chatType: ChatType;
	mentionedBot: boolean;
	groupPolicy: "open" | "mention" | "keywords" | "reply";
}): ChatMode {
	if (opts.chatType === "p2p") return "p2p";
	if (opts.groupPolicy === "open") return "group_at";
	if (opts.groupPolicy === "mention")
		return opts.mentionedBot ? "group_at" : "group_all";
	// keywords/reply policies gate at the group-trigger layer; classify as group_at here.
	return "group_at";
}

/**
 * Normalize a raw Feishu event (any shape) into a FeishuInboundMessage.
 * Returns undefined when the event is not a message we should process
 * (e.g. non-message events, missing ids).
 */
export function normalizeInbound(
	raw: RawEvent,
	opts: NormalizeOptions = {},
): FeishuInboundMessage | undefined {
	// v2.0: message details nested under `message`; flat fallback otherwise.
	const msg = (raw.message ?? raw) as NonNullable<RawEvent["message"]> & {
		message_id?: string;
		chat_id?: string;
		chat_type?: string;
		message_type?: string;
		content?: string;
		parent_id?: string;
		root_id?: string;
		thread_id?: string;
		create_time?: string;
	};
	const messageId = msg.message_id ?? raw.message_id;
	const chatId = msg.chat_id ?? raw.chat_id;
	if (!messageId || !chatId) return undefined;

	const chatTypeRaw = (msg.chat_type ?? raw.chat_type ?? "p2p") as string;
	const chatType: ChatType = chatTypeRaw === "group" ? "group" : "p2p";
	const msgType = msgTypeOf(msg.message_type ?? raw.message_type);
	const senderOpenId =
		raw.sender?.sender_id?.open_id ??
		raw.operator?.operator_id?.open_id ??
		"unknown";

	const mentions = (msg.mentions ?? [])
		.map((m) => m.id?.open_id ?? m.id?.user_id ?? m.name ?? "")
		.filter(Boolean);
	const mentionedBot =
		opts.mentionedBot ??
		(opts.botOpenId !== undefined
			? mentions.includes(opts.botOpenId)
			: mentions.length > 0);

	const chatMode = chatModeFor({
		chatType,
		mentionedBot,
		groupPolicy:
			opts.groupPolicy ?? (chatType === "group" ? "mention" : "open"),
	});

	return {
		messageId,
		chatId,
		chatType,
		chatMode,
		senderOpenId,
		msgType,
		content: msg.content ?? raw.content ?? "",
		text: pickText(msg.content ?? raw.content, msgType),
		rootId: msg.root_id ?? raw.root_id,
		parentId: msg.parent_id ?? raw.parent_id,
		threadId: msg.thread_id ?? raw.thread_id,
		mentions,
		timestamp: Number(msg.create_time ?? raw.create_time ?? Date.now()),
	};
}

/** Detect a bot mention in a raw text (for group trigger pre-checks). */
export function isBotMentioned(
	text: string | undefined,
	botName = "",
): boolean {
	if (!text) return false;
	const atPattern = /@_user_\d+/g;
	return atPattern.test(text) || (botName.length > 0 && text.includes(botName));
}

// ---- transport wrapper (WSClient long connection, ADR-1) -------------------

export interface FeishuClientLike {
	ws?: {
		start?(): unknown;
		stop?(): unknown;
	};
	/** Register one event handler; returns unregister. */
	on?(event: string, handler: (data: unknown) => void): unknown;
	/** Probe: fetch bot info over REST. */
	getBotInfo?(): Promise<{ open_id?: string; name?: string }>;
	/** Send a message (REST). */
	sendMessage?(params: unknown): Promise<unknown>;
	/** Upload a file to Feishu. The real SDK returns TOP-LEVEL keys;
	 * legacy shapes nest under {data:{...}} — both tolerated (pi 2026-08-14 fix). */
	uploadFile?(params: {
		file_type: string;
		file_name?: string;
		file: Buffer;
	}): Promise<{ file_key?: string } | { data?: { file_key?: string } }>;
	uploadImage?(params: {
		image: Buffer;
	}): Promise<{ image_key?: string } | { data?: { image_key?: string } }>;
	/** Add a reaction. */
	addReaction?(params: unknown): Promise<unknown>;
	/** Download a message resource (image/file) as bytes. */
	downloadResource?(params: {
		messageId: string;
		fileKey: string;
		type: "image" | "file";
	}): Promise<Buffer>;
	/** List messages in a chat (for missed-compensation). */
	listMessages?(
		params: unknown,
	): Promise<{ items?: Array<{ message_id?: string; create_time?: string }> }>;
}

export interface TransportDeps {
	/** Lazy SDK accessor — real callers pass the lark client factory. */
	getClient(): FeishuClientLike;
	onMessage(msg: FeishuInboundMessage): Promise<void>;
	onEvent?(event: string, data: unknown): void;
	normalize?: typeof normalizeInbound;
	logger?: {
		info(msg: string): void;
		warn(msg: string): void;
		error(msg: string): void;
	};
}

export interface Transport {
	start(): Promise<void>;
	stop(): Promise<void>;
	isConnected(): boolean;
	wsReady(): boolean;
	/** REST probe used by the supervisor. */
	probe(): Promise<boolean>;
	botOpenId(): string | undefined;
	/** Download a message resource (image/file) — inbound multimedia. */
	downloadResource(params: {
		messageId: string;
		fileKey: string;
		type: "image" | "file";
	}): Promise<Buffer>;
}

/** Event name constants. */
export const EVENT_MESSAGE = "im.message.receive_v1";
export const EVENT_CARD_ACTION = "card.action.trigger";

export function createTransport(deps: TransportDeps): Transport {
	let started = false;
	let wsReadyFlag = false;
	let botOpenId: string | undefined;
	const normalize = deps.normalize ?? normalizeInbound;

	const client = (): FeishuClientLike => deps.getClient();

	async function handleEvent(event: string, data: unknown): Promise<void> {
		deps.onEvent?.(event, data);
		if (event !== EVENT_MESSAGE) return;
		const raw = data as Record<string, unknown>;
		const msg = normalize(raw, { botOpenId });
		if (!msg) return;
		try {
			await deps.onMessage(msg);
		} catch (err) {
			deps.logger?.error(`onMessage failed: ${String(err)}`);
			// Never swallow silently: dispatch errors are observable in logs.
		}
	}

	return {
		async start() {
			if (started) return;
			started = true;
			const c = client();
			// autoReconnect is OFF at the SDK config level; the supervisor drives
			// reconnect. We only wire the event handler.
			if (c.on) {
				c.on(EVENT_MESSAGE, (data) => void handleEvent(EVENT_MESSAGE, data));
				c.on(
					EVENT_CARD_ACTION,
					(data) => void handleEvent(EVENT_CARD_ACTION, data),
				);
			}
			try {
				const bot = await c.getBotInfo?.();
				botOpenId = bot?.open_id;
			} catch {
				// probe later via supervisor
			}
			try {
				await c.ws?.start?.();
				wsReadyFlag = true;
			} catch (err) {
				deps.logger?.error(`ws start failed: ${String(err)}`);
				wsReadyFlag = false;
			}
		},
		async stop() {
			started = false;
			wsReadyFlag = false;
			try {
				await client().ws?.stop?.();
			} catch {
				// ignore
			}
		},
		isConnected: () => started && wsReadyFlag,
		wsReady: () => wsReadyFlag,
		async probe() {
			try {
				const bot = await client().getBotInfo?.();
				if (bot?.open_id) botOpenId = bot.open_id;
				return true;
			} catch {
				return false;
			}
		},
		botOpenId: () => botOpenId,
		async downloadResource(params) {
			const c = client();
			if (!c.downloadResource)
				throw new Error("lark client does not support downloadResource");
			return c.downloadResource(params);
		},
	};
}

/**
 * Extract an upload key from a Feishu SDK upload response, tolerating BOTH
 * the real top-level shape ({file_key}) and the legacy nested shape
 * ({data:{file_key}}) — pi-feishu-link 2026-08-14 real-SDK fix.
 */
export function extractUploadKey(
	res: unknown,
	key: "file_key" | "image_key",
): string | undefined {
	if (!res || typeof res !== "object") return undefined;
	const r = res as Record<string, unknown>;
	const direct = r[key];
	if (typeof direct === "string" && direct.length > 0) return direct;
	const data = r.data as Record<string, unknown> | undefined;
	const nested = data?.[key];
	return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}
