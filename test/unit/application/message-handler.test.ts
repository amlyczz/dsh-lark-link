import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageHandler } from "../../../src/application/message-handler.ts";
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
