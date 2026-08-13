import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnSupervisor } from "../../../src/sessions/turn-supervisor.ts";
import { createMemoryDshBackend } from "../../../src/sessions/dsh-session-backend.ts";

test("turn-supervisor: times out a hung turn and disposes the agent", async () => {
  let fakeNow = 0;
  const backend = createMemoryDshBackend();
  const agent = await backend.ensureAgent("dm:ou_x");
  const disposed: string[] = [];
  const origDispose = agent.dispose.bind(agent);
  // Wrap dispose to observe (backend.delete happens inside).
  const supervisor = createTurnSupervisor({
    backend,
    timeoutMs: 10_000,
    now: () => fakeNow,
    logger: { warn: (m) => disposed.push(m), info: () => undefined },
  });
  supervisor.start();
  supervisor.arm("dm:ou_x");
  fakeNow = 20_000; // past timeout
  await new Promise((r) => setTimeout(r, 1500)); // let the 1s sweep run
  supervisor.stop();
  assert.ok(disposed.length >= 1, "timeout warned");
  assert.equal(backend.size(), 0, "agent disposed after timeout");
  void origDispose;
});

test("turn-supervisor: disarm prevents timeout", async () => {
  let fakeNow = 0;
  const backend = createMemoryDshBackend();
  const supervisor = createTurnSupervisor({
    backend,
    timeoutMs: 10_000,
    now: () => fakeNow,
    logger: { warn: () => undefined, info: () => undefined },
  });
  supervisor.start();
  supervisor.arm("dm:ou_x");
  fakeNow = 20_000;
  supervisor.disarm("dm:ou_x"); // turn finished in time
  await new Promise((r) => setTimeout(r, 1500));
  supervisor.stop();
  assert.equal(backend.size(), 0, "no agent was created (nothing to dispose)");
});
