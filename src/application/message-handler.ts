// MessageHandler: inbound orchestration (handleInbound + handleConversation).
// Pipeline: dedupe → allowlist → group trigger → reaction receipt → route →
// command router → conversation manager. NO fire-and-forget: every branch is
// awaited and failures are logged (pi-feishu-link lesson #4).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeishuInboundMessage } from "../common/types.ts";
import type { BridgeContextRead } from "./bridge-context.ts";
import type { CommandRouter } from "./command-router.ts";
import { createReactionPicker } from "../common/reactions.ts";
import type { AttachmentInput } from "../sessions/dsh-session-backend.ts";
import type { InboundWal } from "../inbound/inbound-wal.ts";

export interface MessageHandlerDeps {
	ctx: BridgeContextRead;
	commands: CommandRouter;
	groupTrigger: { shouldTrigger(msg: FeishuInboundMessage): boolean };
	/** Inbound dedupe: add returns false when already seen. */
	dedupe: { add(messageId: string): boolean };
	/** Owner allowlist getter (empty = all allowed); hot-reload friendly. */
	allowlist: () => string[];
	/** Called when a message was reinjected by missed-compensation. */
	onReinjected?: (msg: FeishuInboundMessage) => void;
	/** Optional durable inbound-request journal (入站请求补发). When present,
	 *  agent-bound text requests are recorded before enqueue and marked
	 *  delivered when the turn's output is enqueued, so a process-death /
	 *  plugin-reload mid-turn can re-trigger them on boot. */
	wal?: InboundWal;
	/**
	 * Local directory where inbound Feishu images/files are persisted as real
	 * files (so a non-vision model / external tooling can read them off disk,
	 * and so the raw attachment is never only in DSH's in-memory store). When
	 * set, `attachment.path` points at the written file; the DSH ImageBlock
	 * ref (`imageRef`) is still produced for vision-capable models.
	 */
	inboundDir?: string;
}

export interface MessageHandler {
	handleInbound(msg: FeishuInboundMessage): Promise<"processed" | "dropped">;
	/** Compensation replay path (skipDedupe semantics handled by caller). */
	handleCompensated(msg: FeishuInboundMessage): Promise<void>;
}

/** Sniff image media type from magic bytes (feishu im resources are raw). */
function sniffImageType(
	buf: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8)
		return "image/jpeg";
	if (
		buf.length >= 12 &&
		buf.slice(0, 4).every((b, i) => b === [0x52, 0x49, 0x46, 0x46][i]) &&
		buf.slice(8, 12).every((b, i) => b === [0x57, 0x45, 0x42, 0x50][i])
	)
		return "image/webp";
	if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
	return "image/png"; // fallback — DSH validates against decoded bytes anyway
}

/** File extension (including dot) for an image media type. */
function imgExt(m: "image/png" | "image/jpeg" | "image/webp" | "image/gif"): string {
	switch (m) {
		case "image/png":
			return ".png";
		case "image/webp":
			return ".webp";
		case "image/gif":
			return ".gif";
		default:
			return ".jpg";
	}
}

/**
 * Resolve inbound Feishu attachments (M6): image → download → attachment
 * store (ImageBlock for the visual model); file → download → bounded text
 * extraction. Failures degrade to text-only (never drop the message).
 */
async function resolveInboundAttachments(
	msg: FeishuInboundMessage,
	ctx: BridgeContextRead,
	inboundDir?: string,
): Promise<AttachmentInput[]> {
	const out: AttachmentInput[] = [];
	if (!msg.messageId) return out;
	try {
		if (msg.msgType === "image") {
			const parsed = JSON.parse(msg.content ?? "{}") as {
				image_key?: string;
			};
			const key = parsed.image_key;
			if (!key || !ctx.transport) return out;
			const buf = await ctx.transport.downloadResource({
				messageId: msg.messageId,
				fileKey: key,
				type: "image",
			});
			if (!buf || buf.length === 0) return out;
			// Persist the raw image as a real local file (when a media dir is
			// configured) so a non-vision model or external tooling can read it
			// off disk — the pixel data is not lost just because the DSH
			// attachment store is in-memory. Best-effort: a write failure must
			// NOT drop the message, so fall through to the in-store path.
			let localPath: string | undefined;
			if (inboundDir) {
				try {
					const ext = imgExt(sniffImageType(buf));
					const name = `feishu-${msg.messageId}-${Date.now()}${ext}`;
					mkdirSync(join(inboundDir, "media"), { recursive: true });
					const path = join(inboundDir, "media", name);
					writeFileSync(path, buf);
					localPath = path;
				} catch (err) {
					ctx.logger.warn(
						`inbound image persist failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			const attach: AttachmentInput = {
				path: localPath ?? "feishu://image",
				kind: "image",
				name: localPath ?? "feishu-image",
			};
			const store = ctx.attachments;
			if (store?.saveImage) {
				const ref = await store.saveImage({
					data: buf,
					mediaType: sniffImageType(buf),
					name: attach.name,
				});
				attach.imageRef = ref as AttachmentInput["imageRef"];
			}
			out.push(attach);
		} else if (msg.msgType === "file") {
			const parsed = JSON.parse(msg.content ?? "{}") as {
				file_key?: string;
				file_name?: string;
			};
			const key = parsed.file_key;
			const name = parsed.file_name ?? "附件";
			if (key && ctx.transport) {
				const buf = await ctx.transport.downloadResource({
					messageId: msg.messageId,
					fileKey: key,
					type: "file",
				});
				if (buf && buf.length > 0) {
					// Persist the raw file locally too (same rationale as images).
					let localPath: string | undefined;
					if (inboundDir) {
						try {
							mkdirSync(join(inboundDir, "media"), { recursive: true });
							const path = join(
								inboundDir,
								"media",
								`feishu-${msg.messageId}-${Date.now()}-${name}`,
							);
							writeFileSync(path, buf);
							localPath = path;
						} catch (err) {
							ctx.logger.warn(
								`inbound file persist failed: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}
					out.push({
						path: localPath ?? "feishu://file",
						kind: "file",
						name,
					});
					// Bounded text extraction for text-ish files.
					const MAX = 150_000;
					if (buf.length <= MAX) {
						const text = buf.toString("utf8");
						if (text && !text.includes("\uFFFD")) {
							out.push({
								path: "feishu://file-text",
								kind: "file",
								name: `${name} 内容提取`,
								textPreview: text,
							});
						}
					}
				}
			}
		}
	} catch (err) {
		ctx.logger.warn(
			`inbound attachment resolve failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return out;
}

export function createMessageHandler(deps: MessageHandlerDeps): MessageHandler {
	const logger = deps.ctx.logger;

	async function handle(
		msg: FeishuInboundMessage,
		compensated: boolean,
	): Promise<"processed" | "dropped"> {
		// 1. dedupe (skip for compensation replay)
		if (!compensated && !deps.dedupe.add(msg.messageId)) {
			logger.info(`drop: duplicate ${msg.messageId}`);
			return "dropped";
		}
		// 2. allowlist (live getter — hot reload honored per message)
		const allowlist = deps.allowlist();
		if (allowlist.length > 0 && !allowlist.includes(msg.senderOpenId)) {
			logger.info(`drop: sender ${msg.senderOpenId} not in allowlist`);
			return "dropped";
		}
		// 3. group trigger
		if (!deps.groupTrigger.shouldTrigger(msg)) {
			logger.info(`drop: group policy for ${msg.chatId}`);
			return "dropped";
		}
		// 4. reaction receipt (random pool, never DONE) — picker built from live cfg
		const reactions = deps.ctx.cfg().reactions;
		if (reactions.enabled) {
			const picker = createReactionPicker(reactions.pool, reactions.done);
			const pick = picker.pickRandom();
			if (pick) {
				try {
					await deps.ctx.sender?.addReaction(msg.messageId, pick);
				} catch {
					logger.warn(`receipt reaction failed for ${msg.messageId}`);
				}
			}
		}
		// 5. command routing (bridge / dsh / agent)
		const route = await deps.commands.route(msg);
		if (route === "agent") {
			const cm = deps.ctx.conversations;
			if (!cm) {
				logger.error(
					"message dropped: conversations not assembled (late wiring?)",
				);
				return "dropped";
			}
			// Establish/refresh the delivery route (sessionKey → chatId) so the
			// event forwarder can route the agent's reply back to this Feishu chat.
			// Without this the forwarder drops every reply (routeFor → undefined).
			const sessionKey = cm.keyFor(msg);
			deps.ctx.router?.upsert({
				sessionKey,
				chatId: msg.chatId,
				chatType: msg.chatType,
				// Remember the trigger message so turn-end can DONE-reaction it.
				lastMessageId: msg.messageId,
				updatedAt: Date.now(),
			});
			// Inbound multimedia (M6): image → attachment store, file → text.
			const attachments = await resolveInboundAttachments(
				msg,
				deps.ctx,
				deps.inboundDir,
			);
			// Durably record the agent-bound request BEFORE enqueuing it, so a
			// crash/plugin-reload mid-turn can re-trigger it on boot. Only text
			// (media replay isn't reliable, and there may be none to rescue).
			const isText = msg.msgType === "text" || (msg.text ?? "").trim() !== "";
			// Only fresh inbound requests are journaled. A compensated re-dispatch
			// (missed-compensation for WS drops, or inbound-wal boot replay) must
			// NOT re-accept — replay already counted the attempt, and re-accepting
			// would reset its attempt cap and let a broken request loop forever.
			if (isText && !compensated && deps.wal) {
				try {
					deps.wal.accept({
						messageId: msg.messageId,
						sessionKey,
						chatId: msg.chatId,
						chatType: msg.chatType,
						senderOpenId: msg.senderOpenId,
						text: (msg.text ?? msg.content ?? "").slice(0, 8_000),
					});
				} catch (err) {
					logger.warn(
						`inbound-wal accept failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}
			try {
				await cm.handleMessage(msg, attachments);
			} catch (err) {
				logger.error(`conversation handling failed: ${String(err)}`);
				return "dropped";
			}
		}
		if (compensated) deps.onReinjected?.(msg);
		return "processed";
	}

	return {
		async handleInbound(msg) {
			return handle(msg, false);
		},
		async handleCompensated(msg) {
			await handle(msg, true);
		},
	};
}
