import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInboundWal,
  type InboundWalRecord,
} from "../../../src/inbound/inbound-wal.ts";

function tmpdir(): string {
  return mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dsh-wal-"));
}

function base(messageId = "m1") {
  return {
    messageId,
    sessionKey: "dm:oc_x",
    chatId: "oc_x",
    chatType: "p2p" as const,
    senderOpenId: "ou_x",
    text: "hello, agent",
  };
}

test("accept records a request and persists to disk", () => {
  const dir = tmpdir();
  const wal = createInboundWal({ dir });
  const rec = wal.accept(base("a1"));
  assert.equal(rec.state, "accepted");
  assert.equal(rec.attempts, 0);
  assert.equal(rec.acceptedAt > 0, true);

  // A fresh instance reads it back from disk (crash recovery).
  const wal2 = createInboundWal({ dir });
  assert.equal(wal2.pendingReplays().length, 1);
  assert.equal(wal2.pendingReplays()[0]?.messageId, "a1");
});

test("delivered marks the record and excludes it from replay", () => {
  const dir = tmpdir();
  const wal = createInboundWal({ dir });
  wal.accept(base("d1"));
  assert.equal(wal.pendingReplays().length, 1);
  wal.delivered("d1");
  assert.equal(wal.pendingReplays().length, 0);
});

test("markReplay bumps attempts; over-cap requests stop replaying", () => {
  const dir = tmpdir();
  const wal = createInboundWal({ dir, maxReplayAttempts: 2 });
  wal.accept(base("r1"));
  assert.equal(wal.markReplay("r1"), true); // attempt 1
  assert.equal(wal.markReplay("r1"), true); // attempt 2
  assert.equal(wal.markReplay("r1"), false); // cap reached
  assert.equal(wal.pendingReplays().length, 0);
});

test("old accepted records are excluded from replay after retention", () => {
  let t = 1_000_000;
  const dir = tmpdir();
  const wal = createInboundWal({
    dir,
    replayRetentionMs: 10_000,
    now: () => t,
  });
  wal.accept(base("old1"));
  t += 20_000; // age past the window
  assert.equal(wal.pendingReplays().length, 0);
  assert.equal(wal.markReplay("old1"), false);
});

test("prune removes delivered records and dead never-delivered ones", () => {
  let t = 1_000_000;
  const dir = tmpdir();
  const wal = createInboundWal({
    dir,
    replayRetentionMs: 10_000,
    maxReplayAttempts: 1,
    now: () => t,
  });
  wal.accept(base("p1")); // will be delivered then aged
  wal.delivered("p1");
  wal.accept(base("p2")); // over-cap, aged
  wal.markReplay("p2"); // attempt 1 (cap), never delivered

  assert.equal(wal.pendingCount(), 2);
  t += 20_000;
  wal.prune();
  assert.equal(wal.pendingCount(), 0);
});

test("corrupt segment file does not crash load", () => {
  const dir = tmpdir();
  // Write a garbage segment and a valid one next to each other.
  writeFileSync(join(dir, "seg-bad.jsonl"), "{{not json\n");
  const wal = createInboundWal({ dir });
  wal.accept(base("ok1"));
  // A fresh load after corrupt present still works.
  const wal2 = createInboundWal({ dir });
  assert.equal(wal2.pendingReplays().some((r) => r.messageId === "ok1"), true);
});

test("remove forgets a single record", () => {
  const dir = tmpdir();
  const wal = createInboundWal({ dir });
  wal.accept(base("rm1"));
  wal.accept(base("rm2"));
  wal.remove("rm1");
  const ids = wal.pendingReplays().map((r) => r.messageId);
  assert.deepEqual(new Set(ids), new Set(["rm2"]));
});

test("GH #9: record that exhausts replay attempts is marked failed (not left accepted)", () => {
  const dir = tmpdir();
  const wal = createInboundWal({ dir, maxReplayAttempts: 2 });
  wal.accept(base("f1"));
  assert.equal(wal.markReplay("f1"), true); // attempt 1
  assert.equal(wal.markReplay("f1"), true); // attempt 2
  // Attempt cap reached: the record must transition to a TERMINAL failed
  // state — before GH #9 it lingered as accepted/replayed and became
  // invisible (inboundPending=0) while still unresolved.
  assert.equal(wal.markReplay("f1"), false); // cap → failed
  assert.equal(wal.failedCount(), 1, "over-cap record counted as failed");
  assert.equal(wal.pendingReplays().length, 0, "failed records never replay again");
});

test("GH #9: failed records survive a reload as failed (diagnosable, not hidden)", () => {
  const dir = tmpdir();
  const wal = createInboundWal({ dir, maxReplayAttempts: 1 });
  wal.accept(base("f2"));
  wal.markReplay("f2"); // attempt 1 (cap)
  wal.markReplay("f2"); // over cap → failed
  const wal2 = createInboundWal({ dir });
  assert.equal(wal2.failedCount(), 1, "failed state persisted across reload");
  assert.equal(wal2.pendingReplays().length, 0);
});

test("GH #9: delivered still wins over failed (late rescue marks it delivered)", () => {
  const dir = tmpdir();
  const wal = createInboundWal({ dir, maxReplayAttempts: 1 });
  wal.accept(base("f3"));
  wal.markReplay("f3");
  wal.markReplay("f3"); // → failed
  wal.delivered("f3"); // rescue/salvage answered it after all
  assert.equal(wal.failedCount(), 0, "delivered supersedes failed");
  assert.equal(wal.pendingReplays().length, 0);
});


test("persisted file uses 0600 mode", () => {
  const dir = tmpdir();
  const wal = createInboundWal({ dir });
  wal.accept(base("perm1"));
  wal.delivered("perm1");
  // Find the most recent segment written.
  const segs = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(segs.length > 0);
  const last = segs[segs.length - 1];
  assert.ok(last !== undefined);
  const mode = statSync(join(dir, last)).mode & 0o777;
  assert.equal(mode, 0o600);
});
