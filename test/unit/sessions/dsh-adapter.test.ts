import { test } from "node:test";
import assert from "node:assert/strict";
import { createDshAdapter } from "../../../src/sessions/dsh-adapter.ts";
import type { DshSessionBackend } from "../../../src/sessions/dsh-session-backend.ts";

/**
 * createDshAdapter against a minimal fake Cordis ctx + fake AgentRegistry.
 * The fake agent re-emits session/event through its own ctx (cordis events).
 */

const silentLogger = { info() {}, warn() {} };

/** Minimal AgentRegistry fake — records create opts, returns fake agents. */
function fakeRegistry(
	opts: { onEvent?: (agent: unknown, ev: unknown) => void } = {},
) {
	const created: Array<Record<string, unknown>> = [];
	const resumed: Array<Record<string, unknown>> = [];
	const agentNo = { n: 0 };
	const agents = new Map<string, unknown>();
	const makeAgent = (sessionId: string) => {
		const id = sessionId;
		const listeners = new Set<(ev: unknown) => void>();
		const agent = {
			id,
			status: "idle" as string,
			followup() {},
			cancel() {},
			ctx: {
				on(event: string, fn: (s: unknown, ev: unknown) => void) {
					if (event !== "session/event") return () => {};
					listeners.add((ev) => fn(undefined, ev));
					opts.onEvent?.(agent, undefined);
					return () => listeners.delete(() => {});
				},
				emit(event: string, ev: unknown) {
					if (event === "session/event") for (const fn of listeners) fn(ev);
				},
			},
		};
		return agent;
	};
	const registry = {
		created,
		resumed,
		agents,
		async create(createOpts: { sessionId: string }) {
			if (agents.has(createOpts.sessionId)) {
				throw new Error(`session "${createOpts.sessionId}" already exists`);
			}
			created.push(createOpts);
			const agent = makeAgent(createOpts.sessionId);
			agents.set(createOpts.sessionId, agent);
			agentNo.n++;
			return {
				agent,
				dispose: async () => agents.delete(createOpts.sessionId),
			};
		},
		async resume(resumeOpts: { resumeSessionId: string }) {
			resumed.push(resumeOpts);
			const agent = makeAgent(resumeOpts.resumeSessionId);
			// resume re-mounts the persisted session; the agent id follows the
			// session id (same as create) — the store already knows this session.
			agents.set(resumeOpts.resumeSessionId, agent);
			agentNo.n++;
			return {
				agent,
				dispose: async () => agents.delete(resumeOpts.resumeSessionId),
			};
		},
		get(id: string) {
			return agents.get(id);
		},
	};
	return { ...registry, created, resumed };
}

const ctxOf = (
	registry: ReturnType<typeof fakeRegistry>,
	agentDefaultModel?: unknown,
	agentPresets?: unknown,
) =>
	({
		agents: registry,
		// Cordis proxy surface — services are read via ctx.get(), not props.
		get(name: string) {
			if (name === "agentDefaultModel") return agentDefaultModel;
			if (name === "agentPresets") return agentPresets;
			return undefined;
		},
	}) as unknown as Parameters<typeof createDshAdapter>[0]["ctx"];

function mkBackend(
	ctx: unknown,
	modelSelection?: { current: { provider: string; model: string } },
	runNonce?: string,
): DshSessionBackend {
	return createDshAdapter({
		ctx: ctx as Parameters<typeof createDshAdapter>[0]["ctx"],
		sessionPrefix: "lark-link",
		logger: silentLogger,
		modelSelection,
		runNonce,
	});
}

test("adapter: agents.create receives agentOptions + installModelSelection setup from agentDefaultModel", async () => {
	const registry = fakeRegistry();
	const ctx = ctxOf(registry, {
		currentSelection: () => ({
			provider: "deepseek-official",
			model: "deepseek-v4-flash",
		}),
	});
	const backend = mkBackend(ctx, {
		current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
	});
	const handle = await backend.ensureAgent("dm:ou_user_1");

	assert.equal(registry.created.length, 1);
	const opts = registry.created[0] as {
		agentOptions?: { provider?: string; model?: string };
		setup?: unknown;
	};
	assert.deepEqual(opts.agentOptions, {
		provider: "deepseek-official",
		model: "deepseek-v4-flash",
	});
	assert.equal(
		typeof opts.setup,
		"function",
		"setup must be provided to wire installModelSelection",
	);
	assert.ok(
		handle.agentId.includes("lark-link:dm:ou_user_1"),
		"session prefix applied",
	);
});

test("adapter: create works without agentDefaultModel (no provider/model)", async () => {
	const registry = fakeRegistry();
	const ctx = ctxOf(registry, undefined);
	const backend = mkBackend(ctx);
	const handle = await backend.ensureAgent("dm:ou_user_1");

	assert.equal(registry.created.length, 1);
	const opts = registry.created[0] as {
		agentOptions?: unknown;
		setup?: unknown;
	};
	assert.equal(
		opts.agentOptions,
		undefined,
		"no agentOptions without default model",
	);
	assert.equal(
		typeof opts.setup,
		"function",
		"setup always mounts the agent preset",
	);
	assert.ok(handle.agentId);
});

test("adapter: toSessionEventOut maps turn/start to a bridge event", async () => {
	const registry = fakeRegistry();
	const backend = mkBackend(ctxOf(registry, undefined));
	const handle = await backend.ensureAgent("dm:ou_user_1");
	const events: Array<{ type: string }> = [];
	handle.onEvent((e) => events.push(e));

	const agent = registry.agents.get(handle.sessionId) as {
		ctx: { emit(event: string, ev: unknown): void };
	};
	agent.ctx.emit("session/event", {
		type: "turn/start",
		seq: 0,
		time: Date.now(),
		data: {},
	});

	assert.ok(
		events.some((e) => e.type === "turn/start"),
		"turn/start forwarded to bridge listeners",
	);
});

test("adapter: assistant/message text is extracted from content blocks", async () => {
	const registry = fakeRegistry();
	const backend = mkBackend(ctxOf(registry, undefined));
	const handle = await backend.ensureAgent("dm:ou_user_1");
	const events: Array<{ type: string; text?: string }> = [];
	handle.onEvent((e) => events.push(e));

	const agent = registry.agents.get(handle.sessionId) as {
		ctx: { emit(event: string, ev: unknown): void };
	};
	agent.ctx.emit("session/event", {
		type: "assistant/message",
		seq: 1,
		time: Date.now(),
		data: { message: { content: [{ type: "text", text: "hi there" }] } },
	});

	const msg = events.find((e) => e.type === "assistant/message");
	assert.ok(msg, "assistant/message forwarded");
	assert.equal(msg.text, "hi there");
});

test("adapter: create collision on restart mints a fresh session automatically", async () => {
	const registry = fakeRegistry();
	const ctx = ctxOf(registry, undefined);
	const NONCE = "r1abc123";
	const backend = mkBackend(ctx, undefined, NONCE);

	// First ensureAgent creates the session. The registry's create now throws
	// "already exists" when the id is taken (same as the real DSH session
	// store after a restart that reused the persisted runNonce).
	const first = await backend.ensureAgent("dm:ou_user_1");
	assert.equal(registry.created.length, 1);

	// Force a fresh adapter over the same persisted runNonce — this mirrors
	// the dsh restart: `tracked` is empty, DSH store still holds the session.
	const backend2 = mkBackend(ctx, undefined, NONCE);
	const handle = await backend2.ensureAgent("dm:ou_user_1");

	// The collided id was NOT reused and resume was NOT attempted (it is
	// broken for mismatched logs) — a fresh session was minted instead, so
	// the message is never dropped.
	assert.equal(registry.resumed.length, 0, "resume must NOT be attempted");
	assert.equal(registry.created.length, 2, "original + fresh restart create");
	assert.notEqual(
		handle.sessionId,
		first.sessionId,
		"fresh session after restart",
	);
	assert.notEqual(handle.agentId, first.agentId, "fresh agent after restart");
});

test("adapter: create collision mints a fresh session directly (no resume)", async () => {
	const registry = fakeRegistry();
	// Even if resume EXISTS, the adapter must NOT use it: dsh-agent-loop's
	// resume returns success but fails on first turn (lazy id-collision
	// check). We assert resume is never attempted.
	const ctx = ctxOf(registry, undefined);
	// Pre-seed the persisted session under the same runNonce the backend
	// will mint — the very first ensureAgent must hit the collision and
	// mint a FRESH session instead.
	const NONCE = "r2def456";
	const collidedId = `lark-link:dm:ou_user_1:${NONCE}:0`;
	registry.agents.set(collidedId, {});
	const backend = mkBackend(ctx, undefined, NONCE);

	const handle = await backend.ensureAgent("dm:ou_user_1");

	// Fresh create succeeded with a NEW nonce — the collided id is not
	// reused, resume was never attempted, and the message is not dropped.
	assert.equal(registry.resumed.length, 0, "resume must NOT be attempted");
	assert.equal(registry.created.length, 1, "only the fresh create records");
	assert.notEqual(
		handle.sessionId,
		collidedId,
		"fresh session id, not the collided one",
	);
});

test("adapter: /new (rotate) mints a wholly fresh session id (new nonce)", async () => {
	const registry = fakeRegistry();
	const ctx = ctxOf(registry, undefined);
	const backend = mkBackend(ctx, undefined, "r3abc789");

	const first = await backend.ensureAgent("dm:ou_user_1");
	backend.rotate("dm:ou_user_1");
	const second = await backend.ensureAgent("dm:ou_user_1");

	assert.notEqual(
		second.sessionId,
		first.sessionId,
		"/new gives the next agent a different session id",
	);
	// The fresh id must NOT reuse the old runNonce family — a `:<gen+1>` id
	// can collide with a persisted log from an earlier run and fail the first
	// turn ("already persisted at a different cwd (id collision)").
	assert.notEqual(
		second.sessionId.split(":")[3],
		first.sessionId.split(":")[3],
		"/new mints a new runNonce, not a generation bump",
	);
	assert.ok(
		second.sessionId.endsWith(":0"),
		"fresh session starts at generation 0",
	);
});

test("adapter: listPresets maps the live DSH roster (shipped + custom)", async () => {
	const registry = fakeRegistry();
	const agentPresets = {
		async list() {
			return [
				{ id: "standard", trust: "system", name: "标准模式", description: "全能" },
				{ id: "code", trust: "system" },
				{ id: "aaa", trust: "user", name: "AAA 模式", description: "示例描述" },
				{ id: "bbb", trust: "user", broken: "示例原因" },
			];
		},
	};
	const backend = mkBackend(ctxOf(registry, undefined, agentPresets));

	const presets = await backend.listPresets();
	assert.deepEqual(presets, [
		{ id: "standard", trust: "system", label: "标准模式", desc: "全能" },
		{ id: "code", trust: "system", label: "code" },
		{ id: "aaa", trust: "user", label: "AAA 模式", desc: "示例描述" },
		{ id: "bbb", trust: "user", label: "bbb", broken: "示例原因" },
	]);
});

test("adapter: listPresets falls back to empty when agentPresets service is absent or fails", async () => {
	const registry = fakeRegistry();
	// No agentPresets service at all.
	const bare = mkBackend(ctxOf(registry, undefined, undefined));
	assert.deepEqual(await bare.listPresets(), []);

	// Service present but list() rejects.
	const failing = {
		async list() {
			throw new Error("roster unavailable");
		},
	};
	const withFailure = mkBackend(ctxOf(registry, undefined, failing));
	assert.deepEqual(await withFailure.listPresets(), []);
});
