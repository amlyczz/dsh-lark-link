import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createInboundWal, type InboundWalRecord } from "../../../src/inbound/inbound-wal.ts";
import { createReplaySalvage } from "../../../src/inbound/replay-salvage.ts";

function tmpdir(): string {
  return mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dsh-salvage-"));
}

const ACCEPTED_AT = 1_000_000;

function rec(overrides: Partial<InboundWalRecord> = {}): InboundWalRecord {
  return {
    messageId: "om_lost",
    sessionKey: "dm:oc_chat",
    chatId: "oc_chat",
    chatType: "p2p",
    senderOpenId: "ou_user",
    text: "install highimpact-dev/skill-shield",
    acceptedAt: ACCEPTED_AT,
    attempts: 1,
    state: "replayed",
    ...overrides,
  };
}

/** DSH sessionPersistence.load()-shaped events for a turn that COMPLETED. */
function completedSessionEvents(assistantAt = ACCEPTED_AT + 5_000) {
  return [
    { type: "turn/start", seq: 0, time: ACCEPTED_AT, data: {} },
    { type: "user/message", seq: 1, time: ACCEPTED_AT, data: {} },
    { type: "assistant/message", seq: 2, time: assistantAt, data: { message: { content: [{ type: "text", text: "skill installed ok" }] } } },
    { type: "turn/end", seq: 3, time: assistantAt, data: { reason: { kind: "completed" } } },
  ];
}

function setup(events?: Array<Record<string, unknown>>) {
  const wal = createInboundWal({ dir: tmpdir() });
  const enqueued: Array<{ dedupeKey: string; text: string; chatId: string }> = [];
  const salvage = createReplaySalvage({
    loadSession: async () => (events === undefined ? undefined : { events: events as never }),
    enqueue: async (env) => {
      enqueued.push({
        dedupeKey: env.dedupeKey,
        text: env.payload.text,
        chatId: env.route.chatId,
      });
      return "id-1";
    },
    wal,
    logger: { info() {}, warn() {} },
  });
  return { wal, enqueued, salvage };
}

test("GH #9: salvage delivers the session's completed output instead of re-running the agent", async () => {
  const { wal, enqueued, salvage } = setup(completedSessionEvents());
  const r = rec();
  wal.accept(r);
  const ok = await salvage.salvage(r, "sess-1");
  assert.equal(ok, true, "salvage performed");
  assert.equal(enqueued.length, 1, "exactly one durable enqueue");
  assert.equal(enqueued[0]?.text, "skill installed ok");
  assert.equal(enqueued[0]?.chatId, "oc_chat");
  assert.equal(enqueued[0]?.dedupeKey, "wal-salvage:om_lost", "stable, idempotent dedupe key");
  assert.equal(wal.pendingReplays().length, 0, "record marked delivered — no replay needed");
});

test("GH #9: salvage refuses when the session output predates the request (ordering proof)", async () => {
  const { wal, enqueued, salvage } = setup(completedSessionEvents(ACCEPTED_AT - 60_000));
  const r = rec();
  wal.accept(r);
  const ok = await salvage.salvage(r, "sess-1");
  assert.equal(ok, false, "stale output must not answer a newer request");
  assert.equal(enqueued.length, 0);
  assert.equal(wal.pendingReplays().length, 1, "record stays pending → caller re-dispatches");
});

test("GH #9: salvage returns false when there is no session/no usable output", async () => {
  const noSession = setup(undefined);
  assert.equal(await noSession.salvage.salvage(rec(), undefined), false, "no sessionId");
  const empty = setup([{ type: "assistant/message", seq: 1, time: ACCEPTED_AT, data: { message: { content: [{ type: "text", text: "" }] } } }]);
  assert.equal(await empty.salvage.salvage(rec(), "sess-2"), false, "empty output");
  const none = setup([]);
  assert.equal(await none.salvage.salvage(rec(), "sess-3"), false, "no events");
});

test("GH #9: salvage is idempotent — a second run never double-sends", async () => {
  const { wal, enqueued, salvage } = setup(completedSessionEvents());
  const r = rec();
  wal.accept(r);
  await salvage.salvage(r, "sess-1");
  const again = await salvage.salvage(r, "sess-1");
  assert.equal(again, false, "already delivered — second call does nothing");
  assert.equal(enqueued.length, 1);
});

test("GH #9: 'No response.' finals are not salvaged", async () => {
  const { enqueued, salvage } = setup([
    { type: "assistant/message", seq: 1, time: ACCEPTED_AT, data: { message: { content: [{ type: "text", text: "No response." }] } } },
  ]);
  assert.equal(await salvage.salvage(rec(), "sess-4"), false);
  assert.equal(enqueued.length, 0);
});
