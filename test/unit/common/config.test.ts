import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMerge, createConfigStore, DEFAULT_CONFIG, HOT_RELOADABLE } from "../../../src/common/config.ts";

test("config: defaults deep-merge with partial overrides", () => {
  const merged = deepMerge(DEFAULT_CONFIG, { groupPolicy: "open", streaming: { enabled: false, printFrequencyMs: 120, printStep: 3 } });
  assert.equal(merged.groupPolicy, "open");
  assert.equal(merged.streaming.enabled, false);
  assert.equal(merged.streaming.printFrequencyMs, DEFAULT_CONFIG.streaming.printFrequencyMs);
  assert.equal(merged.denyList.length, 0);
});

test("config: hot reload only allows whitelisted keys", () => {
  const store = createConfigStore("/tmp/dsh-lark-config-test-1");
  store.update({ groupPolicy: "keywords" });
  assert.equal(store.get().groupPolicy, "keywords");
  assert.throws(() => store.update({ credentialRef: "hack" as never }));
});

test("config: overrides persist to disk and reload", () => {
  const store = createConfigStore("/tmp/dsh-lark-config-test-2");
  store.update({ denyList: ["rm -rf /"] });
  store.saveOverrides();
  const reloaded = createConfigStore("/tmp/dsh-lark-config-test-2");
  assert.deepEqual(reloaded.get().denyList, ["rm -rf /"]);
});

test("config: hot-reloadable keys cover the documented set", () => {
  for (const key of ["groupPolicy", "groupKeywords", "alsoOnReply", "streaming", "reactions", "denyList", "allowlist"]) {
    assert.ok(HOT_RELOADABLE.includes(key as never), `${key} should be hot-reloadable`);
  }
});
