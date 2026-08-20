import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandRouter, type DshCommandRegistry } from "../../../src/application/command-router.ts";
import { createBridgeContext } from "../../../src/application/bridge-context.ts";
import { createStatusStore } from "../../../src/common/connection-status.ts";
import { createLogger } from "../../../src/common/logger.ts";
import { DEFAULT_CONFIG } from "../../../src/common/config.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

const mkMsg = (text: string, messageId = "m1"): FeishuInboundMessage => ({
  messageId,
  chatId: "ou_x",
  chatType: "p2p",
  chatMode: "p2p",
  senderOpenId: "ou_u",
  msgType: "text",
  content: text,
  text,
  mentions: [],
  timestamp: Date.now(),
});

function makeRouter(overrides: { dshHas?: string[]; bridgeHandler?: (name: string) => Promise<boolean> } = {}) {
  const ctx = createBridgeContext({
    logger: createLogger("test"),
    cfg: () => DEFAULT_CONFIG,
    status: createStatusStore(undefined),
    // Tier 2 needs a resolvable agent (agentId) — mock the backend lookup.
    backend: {
      get: () => ({ agentId: "agent-1" }),
    } as never,
  });
  const dshCommands: DshCommandRegistry = {
    has: (name) => (overrides.dshHas ?? ["compact"]).includes(name),
    async run(name, rawInput) {
      return { kind: "success", text: `dsh:${name}:${rawInput}` };
    },
  };
  const router = createCommandRouter({
    ctx,
    commands: dshCommands,
    bridgeHandler: async (name) => {
      if (overrides.bridgeHandler) return overrides.bridgeHandler(name);
      return ["status", "support", "lark-config", "help", "workspace", "stop"].includes(name);
    },
  });
  return { router, ctx };
}

test("router: plain text routes to agent", async () => {
  const { router } = makeRouter();
  assert.equal(await router.route(mkMsg("hello")), "agent");
});

test("router: bridge commands are consumed by the bridge", async () => {
  const { router } = makeRouter();
  assert.equal(await router.route(mkMsg("/status")), "bridge");
  assert.equal(await router.route(mkMsg("/support")), "bridge");
});

test("router: DSH-registered commands run natively and reply via outbox", async () => {
  const { router } = makeRouter({ dshHas: ["compact"] });
  assert.equal(await router.route(mkMsg("/compact old")), "dsh");
});

test("router: unknown /xxx passes through to the agent (三级分流 tier 3)", async () => {
  const { router } = makeRouter();
  assert.equal(await router.route(mkMsg("/goal 写周报")), "agent");
  assert.equal(await router.route(mkMsg("/skill:review")), "agent");
});

test("router: bridge handler decline falls through to agent", async () => {
  const { router } = makeRouter({ bridgeHandler: async () => false });
  assert.equal(await router.route(mkMsg("/status")), "agent");
});

test("router: empty text is skipped", async () => {
  const { router } = makeRouter();
  assert.equal(await router.route(mkMsg("")), "skipped");
});

test("router: /resume is a Tier-1 bridge command (handled before DSH tier)", async () => {
  // DSH ALSO registers a /resume command (tier 2) — the Feishu-side picker
  // must win first, exactly like /permission.
  const seen: string[] = [];
  const { router } = makeRouter({
    dshHas: ["resume"],
    bridgeHandler: async (name) => {
      seen.push(name);
      return name === "resume";
    },
  });
  assert.equal(await router.route(mkMsg("/resume")), "bridge");
  assert.equal(await router.route(mkMsg("/resume 2")), "bridge");
  assert.deepEqual(seen, ["resume", "resume"]);
});

test("router: commands with leading @mentions in group chats route correctly", async () => {
  const seen: string[] = [];
  const { router } = makeRouter({
    dshHas: ["compact"],
    bridgeHandler: async (name) => {
      seen.push(name);
      return ["status", "help"].includes(name);
    },
  });
  // Feishu placeholder mention: @_user_1 /status
  assert.equal(await router.route(mkMsg("@_user_1 /status")), "bridge");
  // Bot name mention: @小斯 /help
  assert.equal(await router.route(mkMsg("@小斯 /help")), "bridge");
  // XML at-tag: <at user_id="ou_xxx">@bot</at> /status
  assert.equal(await router.route(mkMsg('<at user_id="ou_xxx">@bot</at> /status')), "bridge");
  // DSH command with mention: @_user_1 /compact old
  assert.equal(await router.route(mkMsg("@_user_1 /compact old")), "dsh");
  // Plain text with mention: @_user_1 你好 -> agent
  assert.equal(await router.route(mkMsg("@_user_1 你好")), "agent");
  assert.deepEqual(seen, ["status", "help", "status"]);
});
