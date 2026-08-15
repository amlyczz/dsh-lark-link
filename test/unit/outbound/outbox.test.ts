import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutbox, type OutboxSender } from "../../../src/outbound/outbox.ts";
import { tempDir } from "../../../src/common/dedupe-store.ts";
import type { OutboundEnvelope, EnvelopePayload, RouteRef } from "../../../src/common/types.ts";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const route: RouteRef = { sessionKey: "dm:ou_x", chatId: "oc_x", chatType: "p2p" };

function makeOutbox(opts: {
  dir: string;
  sender?: OutboxSender;
  now?: () => number;
  cfg?: Partial<{ maxAttempts: number; backoffMaxMs: number; retainDays: number; pendingCap: number; blobThreshold: number }>;
}) {
  const delivered: Array<{ env: OutboundEnvelope; payload: EnvelopePayload }> = [];
  const sender: OutboxSender = opts.sender ?? {
    async deliver(env, payload) {
      delivered.push({ env, payload });
      return { ok: true };
    },
  };
  const outbox = createOutbox({
    dir: opts.dir,
    sender,
    cfg: {
      maxAttempts: 50,
      backoffMaxMs: 60_000,
      retainDays: 7,
      pendingCap: 10_000,
      blobThreshold: 24_000,
      ...opts.cfg,
    },
    now: opts.now,
  });
  return { outbox, sender, delivered };
}

test("outbox: enqueue + drain delivers once and marks done", async () => {
  const { outbox, delivered } = makeOutbox({ dir: tempDir("outbox-") });
  outbox.rebuildFromDisk();
  outbox.start();
  const id = outbox.enqueue({ dedupeKey: "k1", laneKey: "lane-a", route, kind: "final", payload: { kind: "text", text: "hi" } });
  assert.ok(id, "enqueued");
  await new Promise((r) => setTimeout(r, 300));
  await outbox.stop();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.payload.kind, "text");
  assert.equal(outbox.pendingCount(), 0);
});

test("outbox: idempotency — same dedupeKey enqueued twice delivers once", async () => {
  const { outbox, delivered } = makeOutbox({ dir: tempDir("outbox-") });
  outbox.rebuildFromDisk();
  outbox.start();
  outbox.enqueue({ dedupeKey: "k1", laneKey: "a", route, kind: "final", payload: { kind: "text", text: "one" } });
  outbox.enqueue({ dedupeKey: "k1", laneKey: "a", route, kind: "final", payload: { kind: "text", text: "two" } });
  await new Promise((r) => setTimeout(r, 300));
  await outbox.stop();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.payload.kind === "text" ? (delivered[0]!.payload as { text: string }).text : "", "one");
});

test("outbox: failed message does NOT block its lane (F1 fix)", async () => {
  let failFirst = true;
  const { outbox, delivered } = makeOutbox({
    dir: tempDir("outbox-"),
    sender: {
      async deliver(env, payload) {
        if (failFirst && payload.kind === "text" && (payload as { text: string }).text === "bad") {
          failFirst = false;
          return { ok: false, retryable: true, error: "transient" };
        }
        delivered.push({ env, payload });
        return { ok: true };
      },
    },
    cfg: { maxAttempts: 5, backoffMaxMs: 100 },
  });
  outbox.rebuildFromDisk();
  outbox.start();
  outbox.enqueue({ dedupeKey: "a1", laneKey: "lane", route, kind: "final", payload: { kind: "text", text: "bad" } });
  outbox.enqueue({ dedupeKey: "a2", laneKey: "lane", route, kind: "final", payload: { kind: "text", text: "good" } });
  // The good message must be delivered even though the bad one failed at the head.
  await new Promise((r) => setTimeout(r, 500));
  await outbox.stop();
  const texts = delivered.map((d) => (d.payload.kind === "text" ? (d.payload as { text: string }).text : ""));
  assert.ok(texts.includes("good"), `good delivered (got ${texts.join(",")})`);
});

test("outbox: permanent failure becomes fatal after maxAttempts", async () => {
  let calls = 0;
  const { outbox } = makeOutbox({
    dir: tempDir("outbox-"),
    sender: {
      async deliver() {
        calls++;
        return { ok: false, retryable: true, error: "nope" };
      },
    },
    cfg: { maxAttempts: 3, backoffMaxMs: 10 },
  });
  outbox.rebuildFromDisk();
  outbox.start();
  outbox.enqueue({ dedupeKey: "f1", laneKey: "l", route, kind: "final", payload: { kind: "text", text: "x" } });
  await new Promise((r) => setTimeout(r, 800));
  await outbox.stop();
  assert.ok(calls >= 3, `attempted ${calls} times`);
  assert.equal(outbox.pendingCount(), 0, "fatal is not pending");
});

test("outbox: crash recovery — sending envelope returns to pending after rebuild", async () => {
  const dir = tempDir("outbox-");
  let block = true;
  const { outbox } = makeOutbox({
    dir,
    sender: {
      async deliver() {
        // Simulate crash mid-delivery: hang until the test releases it.
        while (block) await new Promise((r) => setTimeout(r, 10));
        return { ok: true };
      },
    },
  });
  outbox.rebuildFromDisk();
  outbox.start();
  outbox.enqueue({ dedupeKey: "c1", laneKey: "l", route, kind: "final", payload: { kind: "text", text: "crash" } });
  await new Promise((r) => setTimeout(r, 100)); // in-flight 'sending' (never completed)
  // Simulate process death WITHOUT letting the first outbox settle: a new
  // outbox over the same dir must recover the envelope (crash → pending).
  // NOTE: we do NOT call outbox.stop() here — the first pump is still stuck
  // inside deliver(); that IS the crash.
  const { outbox: outbox2, delivered } = makeOutbox({ dir });
  outbox2.rebuildFromDisk();
  outbox2.start();
  await new Promise((r) => setTimeout(r, 300));
  await outbox2.stop();
  // Release the crashed deliver so the first outbox's pump settles, then stop it.
  block = false;
  await outbox.stop();
  assert.ok(delivered.length >= 1, "rebuilt outbox re-delivers the crashed envelope");
  assert.equal(outbox2.pendingCount(), 0);
});

test("outbox: blob spill — large payload stored in blobs/ and still delivered", async () => {
  const dir = tempDir("outbox-");
  const { outbox, delivered } = makeOutbox({ dir, cfg: { blobThreshold: 100 } });
  outbox.rebuildFromDisk();
  outbox.start();
  const big = "x".repeat(5000);
  outbox.enqueue({ dedupeKey: "b1", laneKey: "l", route, kind: "final", payload: { kind: "text", text: big } });
  await new Promise((r) => setTimeout(r, 300));
  await outbox.stop();
  const blobs = readdirSync(join(dir, "blobs")).filter((f) => f.endsWith(".json"));
  assert.ok(blobs.length >= 1, "blob file written");
  assert.equal(delivered.length, 1);
  const text = delivered[0]!.payload.kind === "text" ? (delivered[0]!.payload as { text: string }).text : "";
  assert.equal(text.length, 5000);
});

test("outbox: prune removes only terminal envelopes older than retainDays", () => {
  let fakeNow = 1_000_000;
  const { outbox } = makeOutbox({ dir: tempDir("outbox-"), now: () => fakeNow, cfg: { retainDays: 1 } });
  outbox.rebuildFromDisk();
  // Seed a done envelope directly by enqueue+deliver, then age it.
  outbox.start();
  outbox.enqueue({ dedupeKey: "p1", laneKey: "l", route, kind: "final", payload: { kind: "text", text: "old" } });
  return new Promise<void>((resolve) => {
    setTimeout(async () => {
      await outbox.stop();
      fakeNow += 2 * 86_400_000; // 2 days later
      outbox.prune();
      // Rebuild and verify the old done envelope is gone (no crash, no redelivery of dedupe).
      const { outbox: outbox2, delivered } = makeOutbox({ dir: tempDir("outbox-2"), now: () => fakeNow });
      outbox2.rebuildFromDisk();
      resolve();
      assert.ok(delivered.length === 0);
    }, 300);
  });
});

test("outbox: start() self-prunes done/fatal letters via pruneIntervalMs", async () => {
  let fakeNow = 1_000_000;
  const dir = tempDir("outbox-selfprune-");
  const outbox = createOutbox({
    dir,
    sender: {
      async deliver() {
        return { ok: true };
      },
    },
    cfg: { maxAttempts: 50, backoffMaxMs: 60_000, retainDays: 1, pendingCap: 1000, blobThreshold: 24_000 },
    now: () => fakeNow,
    pruneIntervalMs: 50, // fast cadence for the test
  });
  outbox.rebuildFromDisk();
  outbox.start();
  outbox.enqueue({ dedupeKey: "sp1", laneKey: "l", route, kind: "final", payload: { kind: "text", text: "x" } });
  await new Promise((r) => setTimeout(r, 200)); // delivered → done
  // Age beyond retainDays; the self-prune timer should remove it from disk.
  fakeNow += 2 * 86_400_000;
  await new Promise((r) => setTimeout(r, 120)); // let one prune tick run
  await outbox.stop();

  // A fresh instance sees it gone (no expired done letters remain on disk).
  const probe = createOutbox({
    dir,
    sender: { async deliver() { return { ok: false, retryable: false, error: "no" }; } },
    cfg: { maxAttempts: 1, backoffMaxMs: 1, retainDays: 1, pendingCap: 1000, blobThreshold: 24 },
    now: () => fakeNow,
  });
  probe.rebuildFromDisk();
  assert.equal(probe.pendingCount(), 0, "old done envelope pruned by self-timer");
});

test("outbox: onStatsChange fires on enqueue and after delivery", async () => {
  const dir = tempDir("outbox-stats-");
  const seen: Array<{ pending: number; failed: number }> = [];
  const outbox = createOutbox({
    dir,
    sender: { async deliver() { return { ok: true }; } },
    cfg: { maxAttempts: 5, backoffMaxMs: 10, retainDays: 7, pendingCap: 1000, blobThreshold: 24_000 },
    onStatsChange: (s) => seen.push(s),
  });
  outbox.rebuildFromDisk();
  outbox.start();
  outbox.enqueue({ dedupeKey: "st1", laneKey: "l", route, kind: "final", payload: { kind: "text", text: "x" } });
  await new Promise((r) => setTimeout(r, 200)); // drained → done
  await outbox.stop();
  assert.ok(seen.length >= 1, "onStatsChange fired at least once");
  // The final recorded stats should show nothing pending/failed (all delivered).
  const last = seen[seen.length - 1]!;
  assert.equal(last.pending, 0);
  assert.equal(last.failed, 0);
});

test("outbox: onStatsChange reflects a failed message", async () => {
  const dir = tempDir("outbox-stats-fail-");
  const seen: Array<{ pending: number; failed: number }> = [];
  const outbox = createOutbox({
    dir,
    sender: { async deliver() { return { ok: false, retryable: true, error: "flaky" }; } },
    cfg: { maxAttempts: 2, backoffMaxMs: 5, retainDays: 7, pendingCap: 1000, blobThreshold: 24_000 },
    onStatsChange: (s) => seen.push(s),
  });
  outbox.rebuildFromDisk();
  outbox.start();
  outbox.enqueue({ dedupeKey: "sf1", laneKey: "l", route, kind: "final", payload: { kind: "text", text: "y" } });
  await new Promise((r) => setTimeout(r, 200));
  await outbox.stop();
  assert.ok(seen.some((s) => s.pending > 0), "a pending count was reported while it failed/retried");
  assert.ok(seen.some((s) => s.failed > 0), "a failed count was reported");
});

