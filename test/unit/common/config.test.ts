import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMerge, createConfigStore, DEFAULT_CONFIG, HOT_RELOADABLE, buildHotReloadPatch } from "../../../src/common/config.ts";

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

// ---- dotted-path hot reload (streaming.enabled bug) -------------------------
// /lark-config streaming.enabled=true used to answer "不可热改" — the handler
// only matched TOP-LEVEL whitelist keys and never parsed the dotted path.

test("config: buildHotReloadPatch resolves dotted paths under whitelisted keys", () => {
  const patch = buildHotReloadPatch("streaming.enabled", true);
  assert.deepEqual(patch, { streaming: { enabled: true } });
  const store = createConfigStore("/tmp/dsh-lark-config-test-3");
  store.update(patch);
  assert.equal(store.get().streaming.enabled, true);
  assert.equal(store.get().streaming.printFrequencyMs, DEFAULT_CONFIG.streaming.printFrequencyMs);
});

test("config: buildHotReloadPatch accepts top-level whitelist keys verbatim", () => {
  assert.deepEqual(buildHotReloadPatch("groupPolicy", "open"), { groupPolicy: "open" });
  assert.deepEqual(buildHotReloadPatch("denyList", ["x"]), { denyList: ["x"] });
});

test("config: buildHotReloadPatch rejects non-whitelisted top-level segments", () => {
  assert.throws(() => buildHotReloadPatch("credentialRef", "hack"), /不可热改|not hot-reloadable/);
  assert.throws(() => buildHotReloadPatch("evil.enabled", 1), /不可热改|not hot-reloadable/);
});

test("config: buildHotReloadPatch rejects unknown nested keys", () => {
  assert.throws(() => buildHotReloadPatch("streaming.nope", 1), /未知|unknown/i);
  // object-typed keys only take dotted paths one level deep per schema
  assert.throws(() => buildHotReloadPatch("streaming.enabled.deeper", 1), /未知|unknown|对象/i);
});

// ---- attachments (inbound media: temp dir + retention) ------------------------

test("buildHotReloadPatch: attachments.retentionHours is hot-reloadable", () => {
	const patch = buildHotReloadPatch("attachments.retentionHours", 48);
	assert.deepEqual(patch, { attachments: { retentionHours: 48 } });
});

test("buildHotReloadPatch: unknown attachments sub-key still throws", () => {
	assert.throws(
		() => buildHotReloadPatch("attachments.nope", 1),
		/config key "attachments.nope" is unknown/,
	);
});

test("attachments default retention is 7 days (168h) — survives multi-day sessions on any OS", () => {
	assert.equal(DEFAULT_CONFIG.attachments.retentionHours, 168);
	assert.equal(DEFAULT_CONFIG.attachments.dir, "", "empty dir = OS temp dir default");
});
