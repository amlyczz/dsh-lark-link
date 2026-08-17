import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationConfigStore } from "../../../src/sessions/conversation-config.ts";

function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), "conv-cfg-"));
  return join(d, "conversation-overrides.json");
}

test("conversation-config: empty by default, set/get per key", () => {
  const f = tmpFile();
  const store = createConversationConfigStore(f);
  assert.deepEqual(store.get("dm:ou_a"), {});
  store.set("dm:ou_a", { workspaceRoot: "/tmp/ws-a", provider: "p", model: "m" });
  assert.equal(store.get("dm:ou_a").workspaceRoot, "/tmp/ws-a");
  assert.equal(store.get("dm:ou_a").provider, "p");
  // Other keys untouched — no cross-talk.
  assert.deepEqual(store.get("group:oc_b"), {});
  rmSync(join(f, ".."), { recursive: true, force: true });
});

test("conversation-config: persists across restart and survives reload", () => {
  const f = tmpFile();
  const s1 = createConversationConfigStore(f);
  s1.set("group:oc_x", { preset: "code", model: "glm-5" });
  const s2 = createConversationConfigStore(f);
  assert.equal(s2.get("group:oc_x").preset, "code");
  assert.equal(s2.get("group:oc_x").model, "glm-5");
  assert.deepEqual(s2.keys(), ["group:oc_x"]);
  rmSync(join(f, ".."), { recursive: true, force: true });
});

test("conversation-config: clear removes the whole record", () => {
  const f = tmpFile();
  const store = createConversationConfigStore(f);
  store.set("dm:ou_c", { workspaceRoot: "/w" });
  store.clear("dm:ou_c");
  assert.deepEqual(store.get("dm:ou_c"), {});
  assert.deepEqual(store.keys(), []);
  rmSync(join(f, ".."), { recursive: true, force: true });
});

test("conversation-config: empty-string fields are dropped (fallback to default)", () => {
  const f = tmpFile();
  const store = createConversationConfigStore(f);
  store.set("dm:ou_d", { provider: "", model: "" });
  assert.deepEqual(store.get("dm:ou_d"), {});
  assert.deepEqual(store.keys(), []);
  rmSync(join(f, ".."), { recursive: true, force: true });
});
