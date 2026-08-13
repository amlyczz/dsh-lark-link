import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInbound, isBotMentioned, chatModeFor } from "../../../src/inbound/transport.ts";

// --- normalizeInbound structure matrix (v2.0 nested vs flat) --------------

test("normalize: v2.0 nested message structure extracts message_id (ultimate root-cause fix)", () => {
  const msg = normalizeInbound({
    schema: "2.0",
    header: { event_type: "im.message.receive_v1" },
    event: {},
    message: {
      message_id: "om_abc123",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "hello @_user_1" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
      create_time: "1720000000000",
    },
    sender: { sender_id: { open_id: "ou_user" } },
  });
  assert.ok(msg, "normalized");
  assert.equal(msg!.messageId, "om_abc123");
  assert.equal(msg!.chatId, "oc_group");
  assert.equal(msg!.chatType, "group");
  assert.equal(msg!.text, "hello @_user_1");
  assert.deepEqual(msg!.mentions, ["ou_bot"]);
  assert.equal(msg!.senderOpenId, "ou_user");
});

test("normalize: flat (legacy) structure still works", () => {
  const msg = normalizeInbound({
    message_id: "om_flat",
    chat_id: "ou_p2p",
    message_type: "text",
    content: JSON.stringify({ text: "hi" }),
  });
  assert.ok(msg);
  assert.equal(msg!.messageId, "om_flat");
  assert.equal(msg!.chatType, "p2p");
});

test("normalize: missing message_id or chat_id returns undefined", () => {
  assert.equal(normalizeInbound({ message: { chat_id: "x" } }), undefined);
  assert.equal(normalizeInbound({ message: { message_id: "x" } }), undefined);
});

test("normalize: post content flattened to text", () => {
  const msg = normalizeInbound({
    message_id: "om_post",
    chat_id: "ou_x",
    message_type: "post",
    content: JSON.stringify({
      content: { paragraphs: [{ elements: [{ text_run: { content: "line1" } }] }, { elements: [{ text_run: { content: "line2" } }] }] },
    }),
  });
  assert.equal(msg!.text, "line1\nline2");
});

test("normalize: unknown message type still normalized with content", () => {
  const msg = normalizeInbound({ message_id: "om_u", chat_id: "ou_x", message_type: "sticker", content: "{}" });
  assert.equal(msg!.msgType, "unknown");
});

// --- chatModeFor -----------------------------------------------------------

test("chatMode: p2p is always p2p mode", () => {
  assert.equal(chatModeFor({ chatType: "p2p", mentionedBot: false, groupPolicy: "mention" }), "p2p");
});

test("chatMode: group open policy is group_at", () => {
  assert.equal(chatModeFor({ chatType: "group", mentionedBot: false, groupPolicy: "open" }), "group_at");
});

test("chatMode: group mention policy depends on mention", () => {
  assert.equal(chatModeFor({ chatType: "group", mentionedBot: true, groupPolicy: "mention" }), "group_at");
  assert.equal(chatModeFor({ chatType: "group", mentionedBot: false, groupPolicy: "mention" }), "group_all");
});

// --- isBotMentioned --------------------------------------------------------

test("isBotMentioned: @_user pattern detected", () => {
  assert.equal(isBotMentioned("hello @_user_1 world"), true);
  assert.equal(isBotMentioned("plain text"), false);
});
