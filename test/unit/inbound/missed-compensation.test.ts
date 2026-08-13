import { test } from "node:test";
import assert from "node:assert/strict";
import { createMissedCompensation } from "../../../src/inbound/missed-compensation.ts";
import { createRouteStore } from "../../../src/outbound/outbound-router.ts";
import { tempDir } from "../../../src/common/dedupe-store.ts";
import { join } from "node:path";
import type { Route } from "../../../src/common/types.ts";

test("compensation: re-injects missed messages per route with skipDedupe path", async () => {
  const routes = createRouteStore(join(tempDir("comp-"), "routes.json"));
  const route: Route = { sessionKey: "dm:ou_x", chatId: "oc_x", chatType: "p2p", updatedAt: Date.now() };
  routes.upsert(route);

  const reinjected: string[] = [];
  let fakeNow = 1_000_000;
  const comp = createMissedCompensation({
    routes,
    now: () => fakeNow,
    listMessages: async () => [
      { messageId: "missed-1", timestampMs: fakeNow - 60_000 },
      { messageId: "missed-2", timestampMs: fakeNow - 120_000 },
    ],
    reinject: async (msg) => {
      reinjected.push(msg.messageId);
    },
  });

  comp.noteDelivered("missed-1"); // already delivered — must NOT be re-injected
  await comp.onRecovered();
  assert.deepEqual(reinjected, ["missed-2"]);
});

test("compensation: no routes means no pulls", async () => {
  const routes = createRouteStore(join(tempDir("comp-"), "routes.json"));
  let pulled = false;
  const comp = createMissedCompensation({
    routes,
    listMessages: async () => {
      pulled = true;
      return [];
    },
    reinject: async () => {},
  });
  await comp.onRecovered();
  assert.equal(pulled, false);
});
