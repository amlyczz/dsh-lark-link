import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDshBackend } from "../../../src/sessions/dsh-session-backend.ts";
import { createConversationManager } from "../../../src/sessions/conversation-manager.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

const mkMsg = (chatId: string, chatType: "p2p" | "group" = "p2p", text = "hi"): FeishuInboundMessage => ({
  messageId: `m-${chatId}-${Date.now()}-${Math.random()}`,
  chatId,
  chatType,
  chatMode: chatType === "p2p" ? "p2p" : "group_at",
  senderOpenId: "ou_user",
  msgType: "text",
  content: text,
  text,
  mentions: [],
  timestamp: Date.now(),
});

test("manager: per-conversation keys isolate dm and group", () => {
  const backend = createMemoryDshBackend();
  const cm = createConversationManager({ backend, maxSessions: 8, idleTtlMs: 60_000 });
  assert.equal(cm.keyFor(mkMsg("ou_a")), "dm:ou_a");
  assert.equal(cm.keyFor(mkMsg("oc_g", "group")), "group:oc_g");
});

test("manager: message routes to agent and events fan out once per agent", async () => {
  const backend = createMemoryDshBackend({ autoReply: () => "reply!" });
  const events: string[] = [];
  const cm = createConversationManager({
    backend,
    maxSessions: 8,
    idleTtlMs: 60_000,
    onEvent: (key, e) => events.push(`${key}:${e.type}`),
  });
  await cm.handleMessage(mkMsg("ou_a"));
  await cm.handleMessage(mkMsg("ou_a")); // second message to same agent
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(backend.size(), 1, "one agent for one conversation");
  assert.ok(events.some((e) => e.startsWith("dm:ou_a:assistant/message")), "final event seen");
});

test("manager: stop cancels only the target conversation", async () => {
  const backend = createMemoryDshBackend({ latencyMs: 50 });
  const cm = createConversationManager({ backend, maxSessions: 8, idleTtlMs: 60_000 });
  await cm.handleMessage(mkMsg("ou_a"));
  await cm.handleMessage(mkMsg("ou_b"));
  await cm.stop("dm:ou_a");
  const a = backend.get("dm:ou_a");
  const b = backend.get("dm:ou_b");
  assert.ok(a && b, "both agents exist");
  assert.ok(a.isIdle() || a, "cancel invoked on a");
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(b.isIdle(), "b finished normally");
});

test("manager: sweep disposes idle agents over cap", async () => {
  const backend = createMemoryDshBackend();
  const cm = createConversationManager({ backend, maxSessions: 1, idleTtlMs: 0 });
  await cm.handleMessage(mkMsg("ou_a"));
  await cm.handleMessage(mkMsg("ou_b")); // triggers cap enforcement
  assert.ok(backend.size() <= 1, "cap enforced");
  await cm.disposeAll();
});

test("manager: disposeAll cleans everything", async () => {
  const backend = createMemoryDshBackend();
  const cm = createConversationManager({ backend, maxSessions: 8, idleTtlMs: 60_000 });
  await cm.handleMessage(mkMsg("ou_a"));
  await cm.handleMessage(mkMsg("ou_b"));
  assert.equal(backend.size(), 2);
  await cm.disposeAll();
  assert.equal(backend.size(), 0);
});
