import { test } from "node:test";
import assert from "node:assert/strict";
import { createQuotaGovernor } from "../../../src/common/quota-governor.ts";
import { join } from "node:path";
import { tempDir } from "../../../src/common/dedupe-store.ts";

test("quota: trips after limit failures within window", () => {
  let fakeNow = 0;
  const g = createQuotaGovernor(join(tempDir("quota-"), "conn-history.jsonl"), {
    windowMinutes: 1,
    limit: 3,
    now: () => fakeNow,
  });
  g.recordFailure();
  g.recordFailure();
  assert.equal(g.tripped(), false);
  g.recordFailure();
  assert.equal(g.tripped(), true);
  assert.equal(g.remaining(), 0);
  assert.ok(g.resetAt() !== undefined);
});

test("quota: failures older than window do not count", () => {
  let fakeNow = 0;
  const g = createQuotaGovernor(join(tempDir("quota-"), "conn-history.jsonl"), {
    windowMinutes: 1,
    limit: 2,
    now: () => fakeNow,
  });
  g.recordFailure();
  fakeNow = 61_000; // outside window
  g.recordFailure();
  assert.equal(g.tripped(), false);
});

test("quota: persists across recreation (survives restart)", () => {
  const file = join(tempDir("quota-"), "conn-history.jsonl");
  let fakeNow = 0;
  const g1 = createQuotaGovernor(file, { windowMinutes: 1, limit: 1, now: () => fakeNow });
  g1.recordFailure();
  const g2 = createQuotaGovernor(file, { windowMinutes: 1, limit: 1, now: () => fakeNow });
  assert.equal(g2.tripped(), true, "breaker state survives restart");
});

test("quota: reset clears history", () => {
  const g = createQuotaGovernor(join(tempDir("quota-"), "conn-history.jsonl"), {
    windowMinutes: 1,
    limit: 1,
  });
  g.recordFailure();
  assert.equal(g.tripped(), true);
  g.reset();
  assert.equal(g.tripped(), false);
});
