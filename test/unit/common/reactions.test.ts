import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createReactionPicker,
	VALID_EMOJI_TYPES,
	DONE_EMOJI,
	DEFAULT_RANDOM_POOL,
} from "../../../src/common/reactions.ts";

test("reactions: filters invalid emoji types from config pool (F2 fix)", () => {
	const picker = createReactionPicker(
		["FIRE", "AMAZE", "AWESOME", "COOL", "THUMBSUP"],
		"WHITE_CHECK_MARK",
	);
	const seen = new Set<string>();
	for (let i = 0; i < 200; i++) {
		const p = picker.pickRandom();
		if (p) seen.add(p);
	}
	assert.ok(
		![...seen].some((t) => !VALID_EMOJI_TYPES.has(t)),
		"never picks invalid type",
	);
	// WHITE_CHECK_MARK is not a Feishu emoji_type — falls back to DONE.
	assert.equal(picker.done(), DONE_EMOJI);
});

test("reactions: fully-invalid pool falls back to default pool", () => {
	const picker = createReactionPicker(["FIRE", "AMAZE"], "BAD_MARK");
	const picked = picker.pickRandom();
	assert.ok(
		picked !== undefined && VALID_EMOJI_TYPES.has(picked),
		"falls back to a valid default type",
	);
	assert.equal(picker.done(), DONE_EMOJI);
});

test("reactions: pickRandom never returns the DONE marker", () => {
	const picker = createReactionPicker([DONE_EMOJI], DONE_EMOJI);
	for (let i = 0; i < 50; i++) {
		const p = picker.pickRandom();
		assert.ok(p !== undefined);
		assert.notEqual(p, DONE_EMOJI);
	}
});

test("reactions: empty pool falls back to the default random pool", () => {
	const picker = createReactionPicker([], DONE_EMOJI);
	const picked = picker.pickRandom();
	assert.ok(picked !== undefined);
	assert.notEqual(picked, DONE_EMOJI);
});

test("reactions: default pool is all Feishu-valid (Fire not FIRE)", () => {
	for (const t of DEFAULT_RANDOM_POOL) {
		assert.ok(VALID_EMOJI_TYPES.has(t), `${t} is a valid Feishu emoji_type`);
	}
	assert.ok(!DEFAULT_RANDOM_POOL.includes("FIRE"), "FIRE is invalid; Fire is used");
	assert.ok(DEFAULT_RANDOM_POOL.includes("Fire"), "case-sensitive Fire in pool");
});
