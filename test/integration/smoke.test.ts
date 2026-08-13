// Smoke test: apply() assembles the full plugin against a minimal fake Cordis
// ctx (tools/commands/services) and the ctx.effect disposer tears it down
// cleanly. Uses a temp DSH_LARK_LINK_HOME so no user state is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply, stateDir } from "../../src/index.ts";

function fakeCtx() {
	const tools: Array<Record<string, unknown>> = [];
	const commands: Array<Record<string, unknown>> = [];
	const effects: Array<() => unknown> = [];
	const ctx = {
		config: { enabled: true, groupPolicy: "open" },
		tools: {
			register(def: Record<string, unknown>) {
				tools.push(def);
			},
		},
		commands: {
			register(def: Record<string, unknown>) {
				commands.push(def);
			},
			has: () => false,
			run: async () => ({ kind: "success", text: "ok" }),
		},
		agents: {
			create: async () => {
				throw new Error("no agents service in smoke test");
			},
			get: () => undefined,
		},
		systemPrompt: {
			section() {
				// no-op
			},
		},
		effect(fn: () => unknown) {
			effects.push(fn);
		},
		on() {
			return () => undefined;
		},
	};
	return { ctx, tools, commands, effects };
}

test("smoke: apply() registers tools/commands and effect disposer runs cleanly", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-lark-smoke-"));
	process.env.DSH_LARK_LINK_HOME = home;
	const { ctx, tools, commands, effects } = fakeCtx();
	const before = stateDir();
	assert.ok(
		before.includes("dsh-lark-smoke-"),
		"state dir honors DSH_LARK_LINK_HOME",
	);

	apply(ctx as never, ctx.config);
	const toolNames = tools.map((t) => t.name);
	assert.ok(toolNames.includes("lark_send_local_file"), "file tool registered");
	assert.ok(toolNames.includes("lark_config_get"), "config tool registered");
	const cmdNames = commands.map((c) => c.name);
	assert.ok(
		cmdNames.includes("lark"),
		"single /lark dispatcher command registered",
	);
	assert.ok(
		!cmdNames.includes("lark-status"),
		"no flat lark-status (subcommand form /lark status)",
	);

	assert.equal(effects.length, 1, "one effect registered");
	const disposer = effects[0] as () => () => Promise<void>;
	const teardown = disposer();
	assert.equal(typeof teardown, "function", "effect returns disposer");
	await teardown(); // must not throw
	delete process.env.DSH_LARK_LINK_HOME;
});

test("smoke: disabled config skips registration", () => {
	const { ctx, tools, effects } = fakeCtx();
	apply(ctx as never, { enabled: false });
	assert.equal(tools.length, 0, "no tools when disabled");
	assert.equal(effects.length, 0, "no effect when disabled");
});
