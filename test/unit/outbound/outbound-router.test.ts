import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouteStore } from "../../../src/outbound/outbound-router.ts";
import { tempDir } from "../../../src/common/dedupe-store.ts";
import { join } from "node:path";
import type { Route } from "../../../src/common/types.ts";

const mkRoute = (updatedAt = 1000): Route => ({ sessionKey: "dm:ou_x", chatId: "oc_x", chatType: "p2p", updatedAt });

test("router: upsert/get/touch/remove round-trip", () => {
  const store = createRouteStore(join(tempDir("router-"), "routes.json"));
  store.upsert(mkRoute());
  assert.equal(store.get("dm:ou_x")?.chatId, "oc_x");
  store.touch("dm:ou_x", "msg-1");
  assert.equal(store.get("dm:ou_x")?.lastMessageId, "msg-1");
  store.remove("dm:ou_x");
  assert.equal(store.get("dm:ou_x"), undefined);
});

test("router: persists across recreation", () => {
  const file = join(tempDir("router-"), "routes.json");
  const s1 = createRouteStore(file);
  s1.upsert(mkRoute());
  const s2 = createRouteStore(file);
  assert.equal(s2.get("dm:ou_x")?.chatId, "oc_x");
});

test("router: prune removes stale routes", () => {
  let fakeNow = 1000;
  const store = createRouteStore(join(tempDir("router-"), "routes.json"), () => fakeNow);
  store.upsert(mkRoute());
  fakeNow = 1000 + 40 * 86_400_000; // 40 days later (route TTL 30d)
  store.prune(30 * 86_400_000);
  assert.equal(store.get("dm:ou_x"), undefined);
});
