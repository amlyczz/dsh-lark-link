import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireGatewayLock, readLiveGatewayOwner } from "../../../src/host/gateway-lock.ts";
import { tempDir } from "../../../src/common/dedupe-store.ts";

test("gateway-lock: first acquirer wins, second refused", () => {
  const dir = tempDir("gw-");
  const lock = acquireGatewayLock({ dir, host: "host-a" });
  assert.ok(lock, "first host acquires");
  const second = acquireGatewayLock({ dir, host: "host-b" });
  assert.equal(second, undefined, "second host refused (same live pid)");
  void lock.release();
});

test("gateway-lock: released lock is re-acquirable", async () => {
  const dir = tempDir("gw-");
  const lock = acquireGatewayLock({ dir, host: "host-a" });
  assert.ok(lock);
  await lock.release();
  const again = acquireGatewayLock({ dir, host: "host-a" });
  assert.ok(again, "re-acquirable after release");
  await again.release();
});

test("gateway-lock: zombie owner (dead pid) is broken and reclaimed", () => {
  const dir = tempDir("gw-");
  // Simulate a lock left by a dead process: write gateway.json with a bogus pid.
  writeFileSync(join(dir, "gateway.json"), JSON.stringify({ pid: 999_999_999, host: "dead-host", startedAt: Date.now() }));
  const lock = acquireGatewayLock({ dir, host: "host-new" });
  assert.ok(lock, "zombie lock broken");
  void lock.release();
});

test("gateway-lock: readLiveGatewayOwner returns owner", async () => {
  const dir = tempDir("gw-");
  const lock = acquireGatewayLock({ dir, host: "host-a" });
  assert.ok(lock);
  const owner = readLiveGatewayOwner(dir);
  assert.ok(owner, "owner readable");
  assert.equal(owner!.host, "host-a");
  await lock.release();
});
