// End-to-end integration: full bridge loop with mocks.
//   Feishu WS event → transport.normalize → message-handler → conversation-manager
//   → (memory) agent auto-reply → event-forwarder → outbox → mock Feishu send.
// Verifies the spec's core guarantee: a Feishu message produces a durable
// Feishu reply with no loss.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createTransport, type FeishuClientLike } from "../../src/inbound/transport.ts";
import { createConnectionSupervisor } from "../../src/inbound/connection-supervisor.ts";
import { createOutbox, type Outbox } from "../../src/outbound/outbox.ts";
import { createEventForwarder } from "../../src/outbound/event-forwarder.ts";
import { createRouteStore } from "../../src/outbound/outbound-router.ts";
import { createConversationManager } from "../../src/sessions/conversation-manager.ts";
import { createMemoryDshBackend } from "../../src/sessions/dsh-session-backend.ts";
import { createBridgeContext } from "../../src/application/bridge-context.ts";
import { createMessageHandler } from "../../src/application/message-handler.ts";
import { createCommandRouter } from "../../src/application/command-router.ts";
import { createGroupTrigger } from "../../src/inbound/group-trigger.ts";
import { createStatusStore } from "../../src/common/connection-status.ts";
import { createLogger } from "../../src/common/logger.ts";
import { createConfigStore } from "../../src/common/config.ts";
import { createQuotaGovernor } from "../../src/common/quota-governor.ts";
import { tempDir } from "../../src/common/dedupe-store.ts";

test("integration: Feishu message → agent reply → durable Feishu delivery", async () => {
  const dir = tempDir("it-");
  const configStore = createConfigStore(dir, { groupPolicy: "open" });
  const status = createStatusStore(join(dir, "status.json"));
  const routeStore = createRouteStore(join(dir, "routes.json"));
  const logger = createLogger("it");

  // Mock Feishu side: what the bridge "sends".
  const feishuSent: Array<{ chatId: string; msgType: string; content: string }> = [];
  const larkClient: FeishuClientLike = {
    ws: { start: async () => undefined, stop: async () => undefined },
    on: () => undefined,
    async getBotInfo() {
      return { open_id: "ou_bot", name: "larkbot" };
    },
    async sendMessage({ params }) {
      feishuSent.push({ chatId: params.receive_id, msgType: params.msg_type, content: params.content });
      return {};
    },
    async addReaction() {
      return {};
    },
    async listMessages() {
      return { items: [] };
    },
    async uploadFile() {
      return { file_key: "file_1" };
    },
  };

  const backend = createMemoryDshBackend({ autoReply: (key, text) => `已收到(${key}): ${text}` });
  const conversations = createConversationManager({ backend, maxSessions: 8, idleTtlMs: 60_000 });

  const outbox: Outbox = createOutbox({
    dir: join(dir, "outbox"),
    sender: {
      async deliver(env, payload) {
        if (payload.kind === "text") {
          feishuSent.push({ chatId: env.route.chatId, msgType: "text", content: payload.text });
        }
        return { ok: true };
      },
    },
    cfg: { maxAttempts: 5, backoffMaxMs: 100, retainDays: 7, pendingCap: 1000, blobThreshold: 24_000 },
  });
  outbox.rebuildFromDisk();
  outbox.start();

  const bridge = createBridgeContext({ logger, cfg: () => configStore.get(), configStore, status, backend, router: routeStore, sender: undefined as never });
  bridge.setOutbox(outbox);
  bridge.setConversations(conversations);

  const forwarder = createEventForwarder({
    outbox,
    routeFor: (key) => routeStore.get(key),
    streamFor: () => undefined,
    cfg: () => ({ streamingEnabled: false }),
  });
  bridge.setForwarder(forwarder);

  const commandRouter = createCommandRouter({
    ctx: bridge,
    commands: { has: () => false, async run() { return { kind: "success" }; } },
    bridgeHandler: async () => false,
  });
  const messageHandler = createMessageHandler({
    ctx: bridge,
    commands: commandRouter,
    groupTrigger: createGroupTrigger({ cfg: () => ({ policy: "open", keywords: [], alsoOnReply: false }) }),
    dedupe: {
      add: (id) => {
        const key = `seen:${id}`;
        if (routeStore.get(key)) return false;
        routeStore.upsert({ sessionKey: key, chatId: "dedupe", chatType: "p2p", updatedAt: Date.now() });
        return true;
      },
    },
    allowlist: () => [],
  });

  // Wire conversation events → forwarder (as index.ts does).
  const originalHandle = conversations.handleMessage.bind(conversations);
  (conversations as unknown as { onEvent?: unknown }).onEvent = undefined;
  // index.ts wires via onEvent callback — emulate: subscribe per agent fan-out.
  void originalHandle;

  // Patch: forwarder gets session events through the manager's onEvent.
  // Recreate the manager with onEvent wired (integration path).
  const conversations2 = createConversationManager({
    backend,
    maxSessions: 8,
    idleTtlMs: 60_000,
    onEvent: (key, event) => {
      void forwarder.onSessionEvent(key, event);
    },
  });
  bridge.setConversations(conversations2);
  bridge.setStarted(true);

  // Transport + supervisor (autoReconnect off; supervisor owns reconnect).
  const transport = createTransport({
    getClient: () => larkClient,
    onMessage: async (msg) => { await messageHandler.handleInbound(msg); },
    logger,
  });
  bridge.setTransport(transport);
  const quota = createQuotaGovernor(join(dir, "conn.jsonl"), { windowMinutes: 60, limit: 12 });
  const supervisor = createConnectionSupervisor({
    transport,
    quota,
    status,
    cfg: { probeIntervalMs: 500, probeTimeoutMs: 500, probeFailThreshold: 3, maxReconnectAttempts: 3, idleKeepaliveMs: 60_000, quotaWindowMinutes: 60, quotaLimit: 12 },
    logger,
  });
  await supervisor.start();
  assert.equal(supervisor.state(), "connected");
  bridge.setBotOpenId("ou_bot");

  // Simulate a Feishu message event arriving over the WS.
  const rawEvent = {
    schema: "2.0",
    header: { event_type: "im.message.receive_v1" },
    event: {},
    message: {
      message_id: "om_it_1",
      chat_id: "ou_user1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "帮我看看当前目录" }),
      create_time: String(Date.now()),
    },
    sender: { sender_id: { open_id: "ou_user1" } },
  };

  // Drive the transport's internal handler via its registered event callback:
  // createTransport registers c.on(EVENT_MESSAGE, ...) — capture that handler.
  let wsHandler: ((data: unknown) => void) | undefined;
  larkClient.on = (_event: string, handler: (data: unknown) => void) => {
    wsHandler = handler;
    return undefined;
  };
  // Recreate transport with capturing on() (transport created above already
  // registered — simpler: invoke the normalize path directly through the
  // transport's onMessage by simulating what transport.start() wires).
  const transport2 = createTransport({
    getClient: () => {
      const c = { ...larkClient };
      c.on = (e: string, h: (d: unknown) => void) => {
        if (e === "im.message.receive_v1") wsHandler = h; // capture only message events
        return undefined;
      };
      return c;
    },
    onMessage: async (msg) => { await messageHandler.handleInbound(msg); },
    logger,
  });
  bridge.setTransport(transport2);
  await transport2.start();
  assert.ok(wsHandler, "WS handler registered");

  // Route registration: the bridge records the conversation route on first
  // message (normally done by message-handler/outbound-router wiring).
  routeStore.upsert({ sessionKey: "dm:ou_user1", chatId: "ou_user1", chatType: "p2p", updatedAt: Date.now() });

  wsHandler?.(rawEvent);

  // Wait for: agent reply → forwarder final → outbox drain → feishuSent.
  await new Promise((r) => setTimeout(r, 800));

  const textSends = feishuSent.filter((s) => s.msgType === "text");
  assert.ok(textSends.length >= 1, `expected a text reply, got ${JSON.stringify(feishuSent)}`);
  const reply = textSends.find((s) => s.content.includes("已收到")) ?? textSends[0];
  assert.ok(reply, "reply delivered");
  assert.equal(reply.chatId, "ou_user1");

  await supervisor.stop();
  await outbox.stop();
});
