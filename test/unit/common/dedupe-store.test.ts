import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireDirLock, createDedupeStore, tempDir } from "../../../src/common/dedupe-store.ts";
import { join } from "node:path";

test("dedupe: add then seen is true; second add is false", () => {
  const dir = tempDir("dedupe-");
  const store = createDedupeStore(join(dir, "dedupe.json"));
  assert.equal(store.add("m1"), true);
  assert.equal(store.add("m1"), false);
  assert.equal(store.seen("m1"), true);
  assert.equal(store.seen("m2"), false);
});

test("dedupe: persists across store recreation", () => {
  const dir = tempDir("dedupe-");
  const file = join(dir, "dedupe.json");
  const s1 = createDedupeStore(file);
  s1.add("m1");
  const s2 = createDedupeStore(file);
  assert.equal(s2.seen("m1"), true);
});

test("dedupe: prune drops old entries", () => {
  const dir = tempDir("dedupe-");
  let fakeNow = 1_000_000;
  const store = createDedupeStore(join(dir, "dedupe.json"), () => fakeNow);
  store.add("old");
  fakeNow = 2_000_000;
  store.add("new");
  store.prune(100_000);
  assert.equal(store.seen("old"), false);
  assert.equal(store.seen("new"), true);
});

test("dir lock: second acquirer is refused while first holds it", () => {
  const dir = tempDir("lock-");
  const lockPath = join(dir, ".lock");
  const release = acquireDirLock(lockPath, { ttlMs: 60_000, owner: "a" });
  assert.ok(release, "first acquirer gets the lock");
  const second = acquireDirLock(lockPath, { ttlMs: 60_000, owner: "b" });
  assert.equal(second, undefined, "second acquirer refused");
  release?.();
  const third = acquireDirLock(lockPath, { ttlMs: 60_000, owner: "c" });
  assert.ok(third, "lock released => re-acquirable");
  third?.();
});

test("dir lock: stale lock is broken after ttl", () => {
  const dir = tempDir("lock-");
  const lockPath = join(dir, ".lock");
  let fakeNow = 1_000;
  const release = acquireDirLock(lockPath, { ttlMs: 5_000, owner: "a", now: () => fakeNow });
  assert.ok(release);
  fakeNow = 10_000;
  const second = acquireDirLock(lockPath, { ttlMs: 5_000, owner: "b", now: () => fakeNow });
  assert.ok(second, "stale lock broken after ttl");
  second?.();
});
