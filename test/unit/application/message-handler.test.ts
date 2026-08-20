import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageHandler, resolveInboundAttachments } from "../../../src/application/message-handler.ts";
import { createBridgeContext } from "../../../src/application/bridge-context.ts";
import { createStatusStore } from "../../../src/common/connection-status.ts";
import { createLogger } from "../../../src/common/logger.ts";
import { DEFAULT_CONFIG } from "../../../src/common/config.ts";
import { createMemoryDshBackend } from "../../../src/sessions/dsh-session-backend.ts";
import { createConversationManager } from "../../../src/sessions/conversation-manager.ts";
import { createCommandRouter } from "../../../src/application/command-router.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

const mkMsg = (text: string, messageId = "m1", chatId = "ou_x"): FeishuInboundMessage => ({
  messageId,
  chatId,
  chatType: "p2p",
  chatMode: "p2p",
  senderOpenId: "ou_u",
  msgType: "text",
  content: text,
  text,
  mentions: [],
  timestamp: Date.now(),
});

test("message-handler: full pipeline routes plain message to agent", async () => {
  const ctx = createBridgeContext({
    logger: createLogger("test"),
    cfg: () => DEFAULT_CONFIG,
    status: createStatusStore(undefined),
  });
  const backend = createMemoryDshBackend({ autoReply: () => "ok" });
  const cm = createConversationManager({ backend, maxSessions: 8, idleTtlMs: 60_000 });
  ctx.setConversations(cm);
  ctx.setOutbox({
    enqueue: async () => "x",
    start: () => {},
    stop: async () => {},
    pendingCount: () => 0,
    failedCount: () => 0,
    prune: () => {},
    rebuildFromDisk: () => {},
    lanes: () => [],
  } as never);

  const seen = new Set<string>();
  const handler = createMessageHandler({
    ctx,
    commands: createCommandRouter({
      ctx,
      commands: { has: () => false, async run() { return { kind: "success" }; } },
      bridgeHandler: async () => false,
    }),
    groupTrigger: { shouldTrigger: () => true },
    dedupe: {
      add(id) {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
    },
    allowlist: () => [],
  });

  const result = await handler.handleInbound(mkMsg("hello", "m-1"));
  assert.equal(result, "processed");
  assert.equal(backend.size(), 1, "agent created");
  await new Promise((r) => setTimeout(r, 50));
  const a = backend.get("dm:ou_x");
  assert.ok(a);
});

test("message-handler: duplicate message dropped (dedupe)", async () => {
  const ctx = createBridgeContext({
    logger: createLogger("test"),
    cfg: () => DEFAULT_CONFIG,
    status: createStatusStore(undefined),
  });
  ctx.setConversations({ handleMessage: async () => {}, stop: async () => {}, keyFor: () => "k", sweep: () => 0, size: () => 0, keys: () => [], disposeAll: async () => {} } as never);
  const seen = new Set<string>();
  const handler = createMessageHandler({
    ctx,
    commands: { route: async () => "agent" } as never,
    groupTrigger: { shouldTrigger: () => true },
    dedupe: {
      add(id) {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
    },
    allowlist: () => [],
  });
  assert.equal(await handler.handleInbound(mkMsg("a", "dup")), "processed");
  assert.equal(await handler.handleInbound(mkMsg("b", "dup")), "dropped");
});

test("message-handler: allowlist drops non-owner senders", async () => {
  const ctx = createBridgeContext({
    logger: createLogger("test"),
    cfg: () => DEFAULT_CONFIG,
    status: createStatusStore(undefined),
  });
  const handler = createMessageHandler({
    ctx,
    commands: { route: async () => "agent" } as never,
    groupTrigger: { shouldTrigger: () => true },
    dedupe: { add: () => true },
    allowlist: () => ["ou_owner"],
  });
  const msg = mkMsg("hi");
  msg.senderOpenId = "ou_stranger";
  assert.equal(await handler.handleInbound(msg), "dropped");
});

test("message-handler: missing conversations (late wiring) logs and drops, never silent", async () => {
  const ctx = createBridgeContext({
    logger: createLogger("test"),
    cfg: () => DEFAULT_CONFIG,
    status: createStatusStore(undefined),
  });
  // NOTE: conversations intentionally NOT set — must drop with error log.
  const handler = createMessageHandler({
    ctx,
    commands: { route: async () => "agent" } as never,
    groupTrigger: { shouldTrigger: () => true },
    dedupe: { add: () => true },
    allowlist: () => [],
  });
  assert.equal(await handler.handleInbound(mkMsg("hi")), "dropped");
});

// ---- attachments live resolution (图片 bug) ----------------------------------
// ctx.get("attachments") was snapshotted ONCE at apply() time — when the
// DSH attachment service mounts later (Cordis load order), the bridge kept a
// permanent undefined and EVERY inbound image silently lost its imageRef,
// so the model never saw the image at all.

test("bridge-context: attachments resolves LIVE (late-mounted service is picked up)", async () => {
	const { createBridgeContext } = await import(
		"../../../src/application/bridge-context.ts"
	);
	const { createStatusStore } = await import(
		"../../../src/common/connection-status.ts"
	);
	const { createLogger } = await import("../../../src/common/logger.ts");
	const { DEFAULT_CONFIG } = await import("../../../src/common/config.ts");

	let current: unknown = undefined; // service mounts AFTER the bridge loads
	const ctx = createBridgeContext({
		logger: createLogger("test"),
		cfg: () => DEFAULT_CONFIG,
		status: createStatusStore(undefined),
		attachmentsRef: () => current as never,
	});
	assert.equal(ctx.attachments, undefined, "absent before the service mounts");

	current = { saveImage: async () => ({ attachmentId: "a1" }) };
	assert.equal(
		(ctx.attachments as unknown as { saveImage?: unknown }).saveImage,
		(current as { saveImage: unknown }).saveImage,
		"late-mounted service is visible without a bridge reload",
	);
});


// ---- inbound post (rich text) embeds images (图片 bug：post 内嵌图) -------------

function postMsg(elements: unknown[]): FeishuInboundMessage {
  return {
    messageId: "pm1",
    chatId: "ou_x",
    chatType: "p2p",
    chatMode: "p2p",
    senderOpenId: "ou_u",
    msgType: "post",
    content: JSON.stringify({
      content: { paragraphs: [{ elements }] },
    }),
    text: "",
    mentions: [],
    timestamp: Date.now(),
  };
}

test("attachments: post rich-text embedded images are downloaded and turned into imageRefs", async () => {
  const downloads: Array<{ fileKey: string; type: string }> = [];
  const saved: Array<{ mediaType: string; name?: string }> = [];
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ctx = {
    logger: createLogger("test"),
    transport: {
      async downloadResource(p: { fileKey: string; type: string }) {
        downloads.push(p);
        return PNG;
      },
    },
    attachments: {
      async saveImage(input: { mediaType: string; name?: string }) {
        saved.push(input);
        return {
          attachmentId: `att-${saved.length}`,
          mediaType: input.mediaType,
          bytes: PNG.length,
          width: 2,
          height: 2,
          name: input.name,
        };
      },
    },
  } as never;
  const msg = postMsg([
    { text_run: { content: "看这两张图" } },
    { tag: "img", image_key: "img_v2_abc" },
    { tag: "img", image_key: "img_v2_def" },
  ]);
  const out = await resolveInboundAttachments(msg, ctx);
  assert.equal(downloads.length, 2, "both embedded images downloaded");
  assert.ok(downloads.every((d) => d.type === "image"));
  assert.equal(out.filter((a) => a.kind === "image").length, 2);
  assert.ok(out.every((a) => a.kind !== "image" || a.imageRef), "imageRef set for each");
  assert.deepEqual(saved.map((s) => s.mediaType), ["image/png", "image/png"]);
});

test("attachments: post with no images resolves to nothing (no crash)", async () => {
  const ctx = {
    logger: createLogger("test"),
    transport: { async downloadResource() { throw new Error("unused"); } },
  } as never;
  const msg = postMsg([{ text_run: { content: "纯文字" } }]);
  const out = await resolveInboundAttachments(msg, ctx);
  assert.deepEqual(out, []);
});

test("attachments: plain image message still works with a late-mounted attachments service", async () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ctx = {
    logger: createLogger("test"),
    transport: {
      async downloadResource() { return PNG; },
    },
    attachments: {
      async saveImage() {
        return { attachmentId: "att-9", mediaType: "image/png", bytes: PNG.length, width: 1, height: 1 };
      },
    },
  } as never;
  const msg: FeishuInboundMessage = {
    messageId: "im1", chatId: "ou_x", chatType: "p2p", chatMode: "p2p",
    senderOpenId: "ou_u", msgType: "image",
    content: JSON.stringify({ image_key: "img_v2_xyz" }),
    text: "", mentions: [], timestamp: Date.now(),
  };
  const out = await resolveInboundAttachments(msg, ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.imageRef?.attachmentId, "att-9");
});

test("resolveInboundAttachments: post v1 array-of-arrays ([[img],[text]]) extracts the image", async () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const downloads: Array<{ messageId: string; fileKey: string }> = [];
  const saved: Array<{ mediaType: string }> = [];
  const ctx = {
    logger: createLogger("test"),
    transport: {
      async downloadResource(p: { messageId: string; fileKey: string }) {
        downloads.push(p);
        return PNG;
      },
    },
    attachments: {
      async saveImage(i: { mediaType: string }) {
        saved.push(i);
        return { attachmentId: "att-1", mediaType: i.mediaType };
      },
    },
  } as never;
  // Real payload shape observed 2026-08-19: v1 post, content AND content_v2
  // both array-of-arrays with one img + one text paragraph.
  const msg: FeishuInboundMessage = {
    messageId: "om_p1", chatId: "ou_x", chatType: "p2p", chatMode: "p2p",
    senderOpenId: "ou_u", msgType: "post",
    content: JSON.stringify({
      title: "",
      content: [[{ tag: "img", image_key: "img_v3_7235", width: 986, height: 1000 }], [{ tag: "text", text: "这个图片描述下" }]],
      content_v2: [[{ tag: "img", image_key: "img_v3_7235", width: 986, height: 1000 }], [{ tag: "text", text: "这个图片描述下" }]],
    }),
    text: "这个图片描述下", mentions: [], timestamp: Date.now(),
  };
  const out = await resolveInboundAttachments(msg, ctx);
  assert.equal(downloads.length, 1, "image downloaded once despite content+content_v2 duplication");
  assert.equal(downloads[0]!.fileKey, "img_v3_7235");
  assert.equal(out.length, 1);
  assert.equal(saved[0]!.mediaType, "image/png");
  assert.ok(out[0]!.imageRef, "imageRef set");
});

test("sanitizeAttachmentName: cross-platform safe (Windows-reserved chars, control chars, trailing dots)", async () => {
	const { sanitizeAttachmentName } = await import(
		"../../../src/application/message-handler.ts"
	);
	// Finder displays "/" as ":" — a macOS name can carry a real colon
	assert.equal(
		sanitizeAttachmentName("Screenshot 2026-08-19 at 10:00:00.png"),
		"Screenshot 2026-08-19 at 10_00_00.png",
	);
	// Windows-reserved characters
	assert.equal(sanitizeAttachmentName('a<b>c:d"e|f?g*h.png'), "a_b_c_d_e_f_g_h.png");
	// path separators from either OS
	assert.equal(sanitizeAttachmentName("sub\\dir/file.png"), "sub_dir_file.png");
	// control chars stripped, CJK preserved
	assert.equal(sanitizeAttachmentName("截图\x01\x1f.png"), "截图__.png");
	// only the TRAILING dot/space is invalid on Windows — interior ones stay
	assert.equal(sanitizeAttachmentName("report. .pdf ."), "report. .pdf _");
	// collapse to something non-empty, bounded length
	const long = sanitizeAttachmentName("x".repeat(300) + ".png");
	assert.ok(long.length <= 200, "bounded");
	assert.ok(sanitizeAttachmentName("").length > 0, "never empty");
});
