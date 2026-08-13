import { test } from "node:test";
import assert from "node:assert/strict";
import { createGroupTrigger } from "../../../src/inbound/group-trigger.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

const mkMsg = (partial: Partial<FeishuInboundMessage>): FeishuInboundMessage => ({
  messageId: "m",
  chatId: "oc_g",
  chatType: "group",
  chatMode: "group_at",
  senderOpenId: "ou_u",
  msgType: "text",
  content: "",
  text: "",
  mentions: [],
  timestamp: 0,
  ...partial,
});

const make = (cfg: Parameters<typeof createGroupTrigger>[0]["cfg"], botOpenId?: () => string | undefined) =>
  createGroupTrigger({ cfg, botOpenId });

test("group: open policy triggers on any group message", () => {
  const t = make(() => ({ policy: "open", keywords: [], alsoOnReply: false }));
  assert.equal(t.shouldTrigger(mkMsg({})), true);
});

test("group: mention policy needs bot mention or any @ mention", () => {
  const t = make(() => ({ policy: "mention", keywords: [], alsoOnReply: false }), () => "ou_bot");
  assert.equal(t.shouldTrigger(mkMsg({ mentions: ["ou_bot"] })), true);
  assert.equal(t.shouldTrigger(mkMsg({ mentions: ["ou_other"] })), true, "any @ counts");
  assert.equal(t.shouldTrigger(mkMsg({ mentions: [], chatMode: "group_all" })), false);
});

test("group: mention policy + alsoOnReply triggers on reply to bot without @", () => {
  const t = make(() => ({ policy: "mention", keywords: [], alsoOnReply: true }), () => "ou_bot");
  assert.equal(t.shouldTrigger(mkMsg({ mentions: [], chatMode: "group_all", parentId: "om_parent" })), true);
});

test("group: keywords policy matches substring", () => {
  const t = make(() => ({ policy: "keywords", keywords: ["lark", "小斯"], alsoOnReply: false }));
  assert.equal(t.shouldTrigger(mkMsg({ text: "帮我 lark 一下" })), true);
  assert.equal(t.shouldTrigger(mkMsg({ text: "随便聊聊" })), false);
});

test("group: reply policy triggers on reply to bot message", () => {
  const t = make(() => ({ policy: "reply", keywords: [], alsoOnReply: true }));
  assert.equal(t.shouldTrigger(mkMsg({ parentId: "om_parent" })), true);
  assert.equal(t.shouldTrigger(mkMsg({})), false, "plain message never triggers under reply policy");
});

test("group: p2p always triggers regardless of policy", () => {
  const t = make(() => ({ policy: "reply", keywords: [], alsoOnReply: false }));
  assert.equal(t.shouldTrigger(mkMsg({ chatType: "p2p", chatId: "ou_x" })), true);
});

test("group: hot-reloadable cfg getter is honored per call", () => {
  let policy: "open" | "mention" = "mention";
  const t = make(() => ({ policy, keywords: [], alsoOnReply: false }), () => "ou_bot");
  assert.equal(t.shouldTrigger(mkMsg({ mentions: [], chatMode: "group_all" })), false);
  policy = "open";
  assert.equal(t.shouldTrigger(mkMsg({ mentions: [], chatMode: "group_all" })), true, "hot reload takes effect");
});
