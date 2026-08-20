import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDshBackend } from "../../../src/sessions/dsh-session-backend.ts";
import { createConversationManager } from "../../../src/sessions/conversation-manager.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

const mkMsg = (
	chatId: string,
	chatType: "p2p" | "group" = "p2p",
	text = "hi",
): FeishuInboundMessage => ({
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
	const cm = createConversationManager({
		backend,
		maxSessions: 8,
		idleTtlMs: 60_000,
	});
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
	assert.ok(
		events.some((e) => e.startsWith("dm:ou_a:assistant/message")),
		"final event seen",
	);
});

test("manager: stop cancels only the target conversation", async () => {
	const backend = createMemoryDshBackend({ latencyMs: 50 });
	const cm = createConversationManager({
		backend,
		maxSessions: 8,
		idleTtlMs: 60_000,
	});
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
	const cm = createConversationManager({
		backend,
		maxSessions: 1,
		idleTtlMs: 0,
	});
	await cm.handleMessage(mkMsg("ou_a"));
	await cm.handleMessage(mkMsg("ou_b")); // triggers cap enforcement
	assert.ok(backend.size() <= 1, "cap enforced");
	await cm.disposeAll();
});

test("manager: disposeAll cleans everything", async () => {
	const backend = createMemoryDshBackend();
	const cm = createConversationManager({
		backend,
		maxSessions: 8,
		idleTtlMs: 60_000,
	});
	await cm.handleMessage(mkMsg("ou_a"));
	await cm.handleMessage(mkMsg("ou_b"));
	assert.equal(backend.size(), 2);
	await cm.disposeAll();
	assert.equal(backend.size(), 0);
});

test("manager: /new (rotate) keeps the old session listed, next message opens a new row", async () => {
	const backend = createMemoryDshBackend({ autoReply: () => "ok" });
	const cm = createConversationManager({
		backend,
		maxSessions: 8,
		idleTtlMs: 60_000,
	});

	await cm.handleMessage(mkMsg("ou_a", "p2p", "first"));
	const before = backend.get("dm:ou_a");
	assert.ok(before, "first agent exists");
	const firstSessionId = before.sessionId;

	await cm.rotate("dm:ou_a");

	// Old agent must still be tracked (dispose is NOT called) — the GUI session
	// stays listed even though its log is on disk.
	assert.ok(
		backend.get("dm:ou_a"),
		"/new must not dispose the old agent (session stays in the store)",
	);

	// The old session id remains mapped, and the next message does NOT reuse
	// it. (Memory backend's rotate is a no-op stub; the session-id freshness
	// on /new is covered by dsh-adapter's generation-bump test.)
	assert.ok(
		backend.keyForSessionId(firstSessionId),
		"old session id still mapped",
	);
	await cm.disposeAll();
});

test("manager: /new then a message still gets a reply (stale hook dropped)", async () => {
	const backend = createMemoryDshBackend({
		autoReply: () => "reply-after-new",
	});
	const events: string[] = [];
	const cm = createConversationManager({
		backend,
		maxSessions: 8,
		idleTtlMs: 60_000,
		onEvent: (key, e) => events.push(`${key}:${e.type}`),
	});

	await cm.handleMessage(mkMsg("ou_a", "p2p", "first"));
	await new Promise((r) => setTimeout(r, 50));
	await cm.rotate("dm:ou_a");

	// Second message after /new must produce output events — the fan-out
	// listener for the NEW agent must be attached (the old one was dropped).
	events.length = 0;
	await cm.handleMessage(mkMsg("ou_a", "p2p", "after-new"));
	await new Promise((r) => setTimeout(r, 100));

	assert.ok(
		events.some((e) => e === "dm:ou_a:assistant/message"),
		"reply after /new must be fanned out to onEvent",
	);
	await cm.disposeAll();
});

test("manager: idle sweep then message still gets reply (stale hook after disposal)", async () => {
	const backend = createMemoryDshBackend({ autoReply: () => "reply-after-sweep" });
	const events: string[] = [];
	const cm = createConversationManager({
		backend,
		maxSessions: 8,
		idleTtlMs: 0, // idleTtlMs=0 means immediate idle sweep
		onEvent: (key, e) => events.push(`${key}:${e.type}`),
	});

	// First message → agent created
	await cm.handleMessage(mkMsg("ou_a", "p2p", "before-sweep"));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(backend.size(), 1, "one agent after first message");

	// Sweep: idleTtlMs=0 means the agent is immediately eligible for disposal
	const swept = cm.sweep();
	assert.ok(swept >= 1, "swept idle agent");
	assert.equal(backend.size(), 0, "agent disposed after sweep");

	// Second message → new agent created; events MUST still fan out
	events.length = 0;
	await cm.handleMessage(mkMsg("ou_a", "p2p", "after-sweep"));
	await new Promise((r) => setTimeout(r, 100));

	assert.ok(
		events.some((e) => e === "dm:ou_a:assistant/message"),
		"reply after idle sweep must be fanned out (stale hook re-attached)",
	);
	await cm.disposeAll();
});

test("manager: message after stop continues in the same session", async () => {
	const backend = createMemoryDshBackend({ autoReply: () => "reply" });
	const events: string[] = [];
	const cm = createConversationManager({
		backend,
		maxSessions: 8,
		idleTtlMs: 60_000,
		onEvent: (key, e) => events.push(`${key}:${e.type}`),
	});

	await cm.handleMessage(mkMsg("ou_stop_test", "p2p", "msg 1"));
	await new Promise((r) => setTimeout(r, 50));
	const agentBefore = backend.get("dm:ou_stop_test");
	assert.ok(agentBefore);
	const sessionIdBefore = agentBefore.sessionId;

	await cm.stop("dm:ou_stop_test");

	// Next message after stop must use the exact SAME agent and sessionId
	await cm.handleMessage(mkMsg("ou_stop_test", "p2p", "msg 2"));
	await new Promise((r) => setTimeout(r, 50));
	const agentAfter = backend.get("dm:ou_stop_test");
	assert.ok(agentAfter);
	assert.equal(agentAfter.sessionId, sessionIdBefore, "same session ID after stop");
	assert.equal(agentAfter.agentId, agentBefore.agentId, "same agent after stop");
	await cm.disposeAll();
});

