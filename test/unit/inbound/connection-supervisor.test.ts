import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectionSupervisor, type SupervisorDeps } from "../../../src/inbound/connection-supervisor.ts";
import { createQuotaGovernor } from "../../../src/common/quota-governor.ts";
import { createStatusStore } from "../../../src/common/connection-status.ts";
import { tempDir } from "../../../src/common/dedupe-store.ts";
import { join } from "node:path";

function makeSupervisor(opts: {
  probeOk?: () => boolean;
  connectOk?: () => boolean;
  failThreshold?: number;
  maxAttempts?: number;
  quotaLimit?: number;
}) {
  let connected = false;
  const calls = { start: 0, stop: 0, probe: 0 };
  // Simulate the real failure mode: when REST probes fail, the WS is down too.
  const transport = {
    async start() {
      calls.start++;
      const ok = opts.connectOk?.() ?? true;
      if (ok && (opts.probeOk?.() ?? true)) connected = true;
    },
    async stop() {
      calls.stop++;
      connected = false;
    },
    isConnected: () => connected,
    wsReady: () => connected,
    async probe() {
      calls.probe++;
      const ok = opts.probeOk?.() ?? true;
      if (!ok) connected = false; // probe failure ⇒ WS deemed down
      return ok;
    },
  };
  const quota = createQuotaGovernor(join(tempDir("sup-"), "conn.jsonl"), {
    windowMinutes: 1,
    limit: opts.quotaLimit ?? 3,
  });
  const status = createStatusStore(undefined);
  const deps: SupervisorDeps = {
    transport,
    quota,
    status,
    cfg: {
      probeIntervalMs: 10,
      probeTimeoutMs: 1000,
      probeFailThreshold: opts.failThreshold ?? 3,
      maxReconnectAttempts: opts.maxAttempts ?? 8,
      idleKeepaliveMs: 60_000,
      quotaWindowMinutes: 1,
      quotaLimit: opts.quotaLimit ?? 3,
    },
  };
  const sup = createConnectionSupervisor(deps);
  return { sup, transport, quota, status, calls };
}

test("supervisor: healthy start reaches connected", async () => {
  const { sup, calls, status } = makeSupervisor({});
  await sup.start();
  assert.equal(calls.start, 1);
  assert.equal(sup.state(), "connected");
  assert.equal(status.get().connState, "connected");
  await sup.stop();
});

test("supervisor: probe healthy does NOT rebuild idle connection (ADR-2)", async () => {
  const { sup, calls } = makeSupervisor({});
  await sup.start();
  const startsBefore = calls.start;
  await sup.tick(); // probe ok, ws still connected
  assert.equal(calls.start, startsBefore, "no rebuild on healthy idle");
  await sup.stop();
});

test("supervisor: repeated probe failures trigger rebuild and quarantine", async () => {
  let probeOk = true;
  const { sup, calls, quota, status } = makeSupervisor({
    probeOk: () => probeOk,
    failThreshold: 2,
    maxAttempts: 3,
    quotaLimit: 3,
  });
  await sup.start(); // connect ok
  assert.equal(sup.state(), "connected");
  probeOk = false;
  // Simulate WS dropping too.
  await sup.tick(); // probe fail 1 — below threshold, no rebuild
  await sup.tick(); // probe fail 2 — threshold hit, rebuild attempted
  await sup.tick();
  await sup.tick();
  assert.ok(quota.tripped(), "quota breaker trips after repeated failures");
  assert.equal(sup.state(), "quarantined");
  assert.equal(status.get().connState, "quarantined");
  await sup.stop();
});

test("supervisor: transient probe blip below threshold does not rebuild", async () => {
  let probeOk = true;
  const { sup, calls } = makeSupervisor({ probeOk: () => probeOk, failThreshold: 5 });
  await sup.start();
  const startsBefore = calls.start;
  probeOk = false;
  await sup.tick(); // fail 1
  await sup.tick(); // fail 2
  assert.equal(calls.start, startsBefore, "no rebuild below threshold");
  await sup.stop();
});

test("supervisor: reconnect resets quota and reconnects", async () => {
  const { sup, calls } = makeSupervisor({});
  await sup.start();
  await sup.reconnect();
  assert.ok(calls.start >= 2);
  assert.equal(sup.state(), "connected");
  await sup.stop();
});
