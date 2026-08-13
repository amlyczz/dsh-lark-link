import { test } from "node:test";
import assert from "node:assert/strict";
import { createReactionPicker, VALID_EMOJI_TYPES, DEFAULT_DONE } from "../../../src/common/reactions.ts";

test("reactions: filters invalid emoji types from config pool (F2 fix)", () => {
  const picker = createReactionPicker(["FIRE", "AMAZE", "AWESOME", "COOL", "THUMBSUP"], "WHITE_CHECK_MARK");
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(picker.pickRandom() as string);
  assert.ok(![...seen].some((t) => !VALID_EMOJI_TYPES.includes(t as never)), "never picks invalid type");
  assert.equal(picker.done(), "WHITE_CHECK_MARK");
});

test("reactions: fully-invalid pool falls back to default pool", () => {
  const picker = createReactionPicker(["FIRE", "AMAZE"], "BAD_MARK");
  const picked = picker.pickRandom();
  assert.ok(picked !== undefined && VALID_EMOJI_TYPES.includes(picked as never));
  assert.equal(picker.done(), DEFAULT_DONE);
});

test("reactions: pickRandom never returns the DONE marker", () => {
  const picker = createReactionPicker([DEFAULT_DONE], DEFAULT_DONE);
  for (let i = 0; i < 50; i++) {
    const p = picker.pickRandom();
    assert.ok(p !== undefined);
    assert.notEqual(p, DEFAULT_DONE);
  }
});

test("reactions: empty pool falls back to the default random pool", () => {
  const picker = createReactionPicker([], DEFAULT_DONE);
  const picked = picker.pickRandom();
  assert.ok(picked !== undefined);
  assert.notEqual(picked, DEFAULT_DONE);
});
