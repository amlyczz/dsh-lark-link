import { test } from "node:test";
import assert from "node:assert/strict";
import { createDshAdapter } from "../../../src/sessions/dsh-adapter.ts";
import type { DshSessionBackend } from "../../../src/sessions/dsh-session-backend.ts";

test("adapter: cwd/preset/modelSelection are resolved PER KEY (no cross-talk)", async () => {
	const registry = fakeRegistry();
	const ctx = ctxOf(registry, undefined);
	const selA = { provider: "p1", model: "m1" };
	const selB = { provider: "p2", model: "m2" };
	const backend = createDshAdapter({
		ctx,
		sessionPrefix: "lark-link",
		logger: silentLogger,
		cwd: (key) => (key === "dm:ou_a" ? "/ws/a" : "/ws/default"),
		preset: (key) => (key === "dm:ou_b" ? "ptc" : "code"),
		modelSelection: {
			currentFor: (key) => (key === "dm:ou_a" ? selA : selB),
		},
	});
	await backend.ensureAgent("dm:ou_a");
	await backend.ensureAgent("dm:ou_b");

	assert.equal(registry.created.length, 2);
	const a = registry.created[0] as {
		meta?: { cwd?: string; agentPreset?: string };
		agentOptions?: { provider?: string; model?: string };
	};
	const b = registry.created[1] as {
		meta?: { cwd?: string; agentPreset?: string };
		agentOptions?: { provider?: string; model?: string };
	};
	// key A: its own cwd, default preset, its own model
	assert.equal(a.meta?.cwd, "/ws/a");
	assert.equal(a.meta?.agentPreset, "code");
	assert.deepEqual(a.agentOptions, { provider: "p1", model: "m1" });
	// key B: default cwd, "ptc" alias preset, its own model — NOT A's values
	assert.equal(b.meta?.cwd, "/ws/default");
	assert.equal(b.meta?.agentPreset, "ptc");
	assert.deepEqual(b.agentOptions, { provider: "p2", model: "m2" });
});

test("adapter: currentFor entries are LIVE objects — mutation switches the model", async () => {
	const registry = fakeRegistry();
	const sel = { provider: "p1", model: "m1" };
	const backend = createDshAdapter({
		ctx: ctxOf(registry, undefined),
		sessionPrefix: "lark-link",
		logger: silentLogger,
		modelSelection: { currentFor: () => sel },
	});
	await backend.ensureAgent("dm:ou_a");
	// /model mutates the same object the agent's installModelSelection holds.
	sel.provider = "p2";
	sel.model = "m2";
	assert.equal(sel.provider, "p2");
});


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
		const errorListeners = new Set<(payload: { error?: unknown }) => void>();
		const agent = {
			id,
			status: "idle" as string,
			session: { id: sessionId }, // the real Agent exposes its session
			lastMessage: undefined as { content: Array<Record<string, unknown>> } | undefined,
			followups: [] as Array<{ content: Array<Record<string, unknown>> }>,
			async whenIdle() {},
			followup(message: { content: Array<Record<string, unknown>> }) {
				(agent as { lastMessage?: unknown }).lastMessage = message;
				agent.followups.push(message);
			},
			cancel() {},
			emitAgentError(err: unknown) {
				for (const fn of errorListeners) fn({ error: err });
			},
			ctx: {
				on(event: string, fn: (s: unknown, ev: unknown) => void) {
					if (event === "agent/error") {
						errorListeners.add(fn as (payload: { error?: unknown }) => void);
						return () => errorListeners.delete(fn as (payload: { error?: unknown }) => void);
					}
					if (event !== "session/event") return () => {};
					listeners.add((ev) => fn(undefined, ev));
					opts.onEvent?.(agent, undefined);
					return () => listeners.delete(() => {});
				},
				emit(event: string, ev: unknown) {
					if (event === "session/event") {
						for (const fn of listeners) fn(ev);
						if (agentCtxHolder.ctx?.emit) {
							agentCtxHolder.ctx.emit("session/event", agent.session, ev);
						}
					}
				},
			},
		};
		return agent;
	};
	const agentCtxHolder: { ctx?: { emit?(event: string, session: unknown, ev: unknown): void } } = {};
	// The real AgentFactory awaits opts.setup(agentCtx) before the handle
	// resolves — honor that contract so setup composition stays observable.
	const runSetup = async (setup: unknown) => {
		await (setup as (c: unknown) => Promise<unknown>)({
			on: () => () => {},
			tools: { register() {} },
		});
	};
	const registry = {
		created,
		resumed,
		agents,
		agentCtxHolder,
		async create(createOpts: { sessionId: string; setup?: unknown }) {
			if (agents.has(createOpts.sessionId)) {
				throw new Error(`session "${createOpts.sessionId}" already exists`);
			}
			await runSetup(createOpts.setup);
			created.push(createOpts);
			const agent = makeAgent(createOpts.sessionId);
			agents.set(createOpts.sessionId, agent);
			agentNo.n++;
			return {
				agent,
				dispose: async () => agents.delete(createOpts.sessionId),
			};
		},
		async resume(resumeOpts: { resumeSessionId: string; setup?: unknown }) {
			if (agents.has(resumeOpts.resumeSessionId)) {
				throw new Error(`cannot prepare session "${resumeOpts.resumeSessionId}" while it is live`);
			}
			await runSetup(resumeOpts.setup);
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
	return { ...registry, created, resumed, agentCtxHolder };
}

const ctxOf = (
	registry: ReturnType<typeof fakeRegistry>,
	agentDefaultModel?: unknown,
	agentPresets?: unknown,
) => {
	const sessionListeners = new Set<(sess: unknown, ev: unknown) => void>();
	const ctxObj = {
		agents: registry,
		on(event: string, fn: (s: unknown, ev: unknown) => void) {
			if (event === "session/event") {
				sessionListeners.add(fn);
				return () => sessionListeners.delete(fn);
			}
			return () => {};
		},
		emit(event: string, sess: unknown, ev: unknown) {
			if (event === "session/event") {
				for (const fn of sessionListeners) fn(sess, ev);
			}
		},
		// Cordis proxy surface — services are read via ctx.get(), not props.
		get(name: string) {
			if (name === "agentDefaultModel") return agentDefaultModel;
			if (name === "agentPresets") return agentPresets;
			return undefined;
		},
	};
	if (registry?.agentCtxHolder) {
		registry.agentCtxHolder.ctx = ctxObj;
	}
	return ctxObj as unknown as Parameters<typeof createDshAdapter>[0]["ctx"];

};


function mkBackend(
	ctx: unknown,
	modelSelection?: { current: { provider: string; model: string } },
	runNonce?: string,
	activeSessions?: Map<string, string | undefined>,
): DshSessionBackend {
	return createDshAdapter({
		ctx: ctx as Parameters<typeof createDshAdapter>[0]["ctx"],
		sessionPrefix: "lark-link",
		logger: silentLogger,
		modelSelection,
		runNonce,
		activeSessionId: activeSessions ? (key) => activeSessions.get(key) : undefined,
		setActiveSessionId: activeSessions
			? (key, id) => {
					if (id === undefined) activeSessions.delete(key);
					else activeSessions.set(key, id);
				}
			: undefined,
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

test("adapter: todo/write and goal/change events are correctly forwarded to bridge listeners", async () => {
	const registry = fakeRegistry();
	const backend = mkBackend(ctxOf(registry, undefined));
	const handle = await backend.ensureAgent("dm:ou_user_1");
	const events: Array<{ type: string; todos?: unknown; goal?: unknown }> = [];
	handle.onEvent((e) => events.push(e));

	const agent = registry.agents.get(handle.sessionId) as {
		ctx: { emit(event: string, ev: unknown): void };
	};

	// 1. Emitting todo/write
	agent.ctx.emit("session/event", {
		type: "todo/write",
		seq: 2,
		time: Date.now(),
		data: {
			todos: [
				{ content: "Task 1", status: "completed" },
				{ content: "Task 2", status: "in_progress" },
			],
		},
	});

	const todoEv = events.find((e) => e.type === "todo/write");
	assert.ok(todoEv, "todo/write forwarded");
	assert.deepEqual(todoEv.todos, [
		{ content: "Task 1", status: "completed" },
		{ content: "Task 2", status: "in_progress" },
	]);

	// 2. Emitting goal/change from dsh-goal structure (data.goal)
	agent.ctx.emit("session/event", {
		type: "goal/change",
		seq: 3,
		time: Date.now(),
		data: {
			kind: "goal/change",
			operation: "create",
			goal: {
				id: "g_123",
				revision: 1,
				objective: "Deploy service",
				phase: "active",
				maxGoalRounds: 50,
			},
			roundsStarted: 2,
		},
	});

	const goalEv = events.find((e) => e.type === "goal/change");
	assert.ok(goalEv, "goal/change forwarded");
	assert.equal((goalEv.goal as { objective?: string })?.objective, "Deploy service");
	assert.equal((goalEv.goal as { roundsStarted?: number })?.roundsStarted, 2);
});

test("adapter: activeSessionId persists across dsh restart and is resumed", async () => {

	const registry = fakeRegistry();
	const ctx = ctxOf(registry, undefined);
	const activeSessions = new Map<string, string | undefined>();
	const backend1 = mkBackend(ctx, undefined, "r1abc123", activeSessions);

	// First ensureAgent creates the session and records activeSessionId.
	const first = await backend1.ensureAgent("dm:ou_user_1");
	assert.equal(registry.created.length, 1);
	assert.equal(registry.resumed.length, 0);
	assert.equal(activeSessions.get("dm:ou_user_1"), first.sessionId);

	// Simulate dsh restart: new adapter created with same persisted activeSessions.
	const backend2 = mkBackend(ctx, undefined, "r2xyz456", activeSessions);
	const second = await backend2.ensureAgent("dm:ou_user_1");

	// Session is resumed, reusing the SAME session id across restart!
	assert.equal(registry.resumed.length, 1, "session was resumed on restart");
	assert.equal(second.sessionId, first.sessionId, "same session ID after restart");
	assert.equal(second.agentId, first.sessionId, "same agent ID after restart");
});

test("adapter: create collision falls back to resume existing session", async () => {
	const registry = fakeRegistry();
	const ctx = ctxOf(registry, undefined);
	const NONCE = "r2def456";
	const collidedId = `lark-link:dm:ou_user_1:${NONCE}:0`;
	// Pre-seed the persisted session in registry
	registry.agents.set(collidedId, {
		id: collidedId,
		status: "idle",
		session: { id: collidedId },
		ctx: { on: () => () => {}, emit: () => {} },
	});
	const backend = mkBackend(ctx, undefined, NONCE);

	const handle = await backend.ensureAgent("dm:ou_user_1");

	// Collision during create automatically fell back to resume the existing session
	assert.equal(registry.resumed.length, 1, "resume was used on collision");
	assert.equal(handle.sessionId, collidedId, "reused existing session id");
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

test("adapter: concurrent ensureAgent on the same key collapses into ONE agent (no already-exists race)", async () => {
	const registry = fakeRegistry();
	const ctx = ctxOf(registry, undefined);
	// Stable persisted runNonce — both concurrent calls compute the SAME
	// sessionId, which is exactly the pre-race condition from the issue.
	const backend = mkBackend(ctx, undefined, "rRace123");

	// Two near-simultaneous ensureAgent calls on the same key. This mirrors an
	// outbox re-reply racing a live inbound message right after a dsh restart —
	// before the fix, the losing call re-entered agents.create on the same id
	// and hit "session … already exists".
	const [a, b] = await Promise.all([
		backend.ensureAgent("dm:ou_race"),
		backend.ensureAgent("dm:ou_race"),
	]);

	// Both callers must get the SAME agent: one create, one session, no leak.
	assert.equal(registry.created.length, 1, "exactly one agents.create");
	assert.equal(a.sessionId, b.sessionId, "same session for both callers");
	assert.equal(a.agentId, b.agentId, "same agent for both callers");
	assert.equal(
		backend.get("dm:ou_race")?.agentId,
		a.agentId,
		"tracked handle is the shared created agent",
	);
});

test("adapter: concurrent create-collision still mints a fresh session and never throws the raw already-exists", async () => {
	// A registry whose create ALWAYS reports "already exists" (nothing is ever
	// creatable). ensureAgent must go collision → mint-fresh → and surface a
	// WRAPPED, clearly-labeled error instead of the raw "session … already
	// exists" escaping out to kill the inbound handler (issue symptom).
	const alwaysCollide = {
		agents: new Map<string, unknown>(),
		async create() {
			throw new Error('session "x" already exists');
		},
		resume() {
			throw new Error("unused");
		},
		get() {
			return undefined;
		},
	} as unknown as ReturnType<typeof fakeRegistry>;
	const ctx = ctxOf(alwaysCollide, undefined);
	const backend = mkBackend(ctx, undefined, "rRace999");

	await assert.rejects(
		() => backend.ensureAgent("dm:ou_bad"),
		(err: unknown) =>
			err instanceof Error &&
			err.message.includes("failed to mint fresh session"),
		"collision re-try failure must be wrapped, not raw already-exists",
	);
});

// ---- resumeAgent (/resume) ---------------------------------------------------

test("adapter: resumeAgent calls agents.resume with the stored preset and tracks the handle", async () => {
	const registry = fakeRegistry();
	const mounts: Array<string | undefined> = [];
	const agentPresets = {
		async mount(_ctx: unknown, presetId: string) {
			mounts.push(presetId);
		},
	};
	const backend = createDshAdapter({
		ctx: ctxOf(registry, undefined, agentPresets),
		sessionPrefix: "lark-link",
		logger: silentLogger,
		modelSelection: { currentFor: () => ({ provider: "p", model: "m" }) },
	});

	const handle = await backend.resumeAgent("dm:ou_r", "hist-session-1", {
		preset: "minimal",
	});

	assert.equal(registry.resumed.length, 1);
	const opts = registry.resumed[0] as {
		resumeSessionId: string;
		agentOptions?: { provider: string; model: string };
		setup?: unknown;
	};
	assert.equal(opts.resumeSessionId, "hist-session-1");
	assert.deepEqual(opts.agentOptions, { provider: "p", model: "m" });
	assert.equal(typeof opts.setup, "function", "setup composes the resumed world");
	assert.equal(handle.sessionId, "hist-session-1");
	assert.equal(handle.agentId, "hist-session-1");

	// setup must have mounted the STORED preset (resume must not recompose a
	// different one — apiproxy asserts preset-unchanged on resume).
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(mounts, ["minimal"]);

	// tracked: the NEXT message reuses the resumed agent — no new create.
	const again = await backend.ensureAgent("dm:ou_r");
	assert.equal(again.agentId, handle.agentId);
	assert.equal(registry.created.length, 0);
	assert.equal(
		backend.keyForSessionId("hist-session-1"),
		"dm:ou_r",
		"reverse map for event routing",
	);
});

test("adapter: resumeAgent detaches and cleans up the previous agent", async () => {
	const registry = fakeRegistry();
	const ctx = ctxOf(registry, undefined);
	const backend = mkBackend(ctx, undefined, "rRes123");

	const first = await backend.ensureAgent("dm:ou_r");
	const oldSessionId = first.sessionId;
	// events from the OLD agent must no longer reach bridge listeners
	const events: Array<{ type: string }> = [];
	first.onEvent((e) => events.push(e));

	const resumed = await backend.resumeAgent("dm:ou_r", "hist-2");

	assert.notEqual(resumed.sessionId, oldSessionId);
	assert.equal(
		backend.get("dm:ou_r")?.agentId,
		resumed.agentId,
		"the resumed agent replaces the tracked handle",
	);
	// old session was released so it does not conflict when resumed later
	assert.equal(events.length, 0, "old agent's events no longer forwarded");
});

test("adapter: resumeAgent can safely resume a previously live session without collision", async () => {
	const registry = fakeRegistry();
	const ctx = ctxOf(registry, undefined);
	const backend = mkBackend(ctx, undefined, "rResLive");

	const first = await backend.ensureAgent("dm:ou_live");
	const liveSessionId = first.sessionId;

	// Rotate to start a new session (like /new)
	backend.rotate("dm:ou_live");

	// Resuming the previous liveSessionId must succeed without "cannot prepare session while it is live"
	const restored = await backend.resumeAgent("dm:ou_live", liveSessionId);
	assert.equal(restored.sessionId, liveSessionId);
	assert.equal(backend.get("dm:ou_live")?.sessionId, liveSessionId);
});

test("adapter: memory backend resumeAgent adopts the given session id", async () => {
	const { createMemoryDshBackend } = await import(
		"../../../src/sessions/dsh-session-backend.ts"
	);
	const mem = createMemoryDshBackend();
	const before = await mem.ensureAgent("dm:ou_m");
	const handle = await mem.resumeAgent("dm:ou_m", "hist-mem-1");
	assert.equal(handle.sessionId, "hist-mem-1");
	assert.equal(mem.keyForSessionId("hist-mem-1"), "dm:ou_m");
	const again = await mem.ensureAgent("dm:ou_m");
	assert.equal(again.agentId, handle.agentId);
	assert.notEqual(before.agentId, handle.agentId);
});

// ---- per-session permission application (GH #8) ------------------------------

test("adapter: ensureAgent applies the bridge permissionMode to THIS session only", async () => {
	const registry = fakeRegistry();
	const applied: Array<{ session: unknown; mode: string }> = [];
	const approvalPolicies: Array<{ agent: unknown; policy: string }> = [];
	const permissionPresets = {
		apply(session: unknown, name: string, setApproval: (p: string) => void) {
			applied.push({ session, mode: name });
			setApproval("never");
		},
	};
	const approval = {
		setPolicy(agent: unknown, policy: string) {
			approvalPolicies.push({ agent, policy });
		},
	};
	const ctx = {
		agents: registry,
		get(name: string) {
			if (name === "agentPresets") return undefined;
			if (name === "permissionPresets") return permissionPresets;
			if (name === "approval") return approval;
			return undefined;
		},
	} as unknown as Parameters<typeof createDshAdapter>[0]["ctx"];
	const backend = createDshAdapter({
		ctx,
		sessionPrefix: "lark-link",
		logger: silentLogger,
		permissionMode: () => "danger-full-access",
	});
	await backend.ensureAgent("dm:ou_p");

	assert.equal(applied.length, 1, "permission applied once per created session");
	assert.equal(applied[0]!.mode, "danger-full-access");
	assert.equal(
		approvalPolicies.length,
		1,
		"approval policy set through the apply callback",
	);
	assert.equal(approvalPolicies[0]!.policy, "never");
});

test("adapter: resumeAgent applies the bridge permissionMode to the resumed session", async () => {
	const registry = fakeRegistry();
	const applied: Array<{ mode: string }> = [];
	const permissionPresets = {
		apply(_s: unknown, name: string, _cb: (p: string) => void) {
			applied.push({ mode: name });
		},
	};
	const ctx = {
		agents: registry,
		get(name: string) {
			if (name === "permissionPresets") return permissionPresets;
			return undefined;
		},
	} as unknown as Parameters<typeof createDshAdapter>[0]["ctx"];
	const backend = createDshAdapter({
		ctx,
		sessionPrefix: "lark-link",
		logger: silentLogger,
		permissionMode: () => "workspace-write",
	});
	await backend.resumeAgent("dm:ou_p", "hist-9");
	assert.equal(applied.length, 1);
	assert.equal(applied[0]!.mode, "workspace-write");
});

test("adapter: missing permission services never break agent creation (GH #8 no-op path)", async () => {
	const registry = fakeRegistry();
	const backend = createDshAdapter({
		ctx: ctxOf(registry, undefined),
		sessionPrefix: "lark-link",
		logger: silentLogger,
		permissionMode: () => "read-only",
	});
	const handle = await backend.ensureAgent("dm:ou_np");
	assert.ok(handle.agentId, "creation unaffected when services are absent");
});

// ---- inbound images reach the model content (图片 bug 后半) --------------------

test("adapter: followup pushes an ImageBlock when imageRef exists AND notes the local path", async () => {
	const registry = fakeRegistry();
	const backend = mkBackend(ctxOf(registry, undefined));
	const handle = await backend.ensureAgent("dm:ou_img");
	await handle.followup("看这张图", [
		{
			path: "/ws/media/feishu-m1-x.png",
			kind: "image",
			name: "shot.png",
			imageRef: {
				attachmentId: "att-1",
				mediaType: "image/png",
				bytes: 10,
				width: 4,
				height: 4,
			},
		},
	]);
	const agent = registry.agents.get(handle.sessionId) as {
		lastMessage?: { content: Array<{ type: string; text?: string; attachment?: { attachmentId: string } }> };
	};
	const blocks = agent.lastMessage!.content;
	const img = blocks.find((b) => b.type === "image");
	assert.ok(img, "ImageBlock present for a vision model");
	assert.equal(img!.attachment!.attachmentId, "att-1");
	assert.match(
		blocks[0]!.text!,
		/\/ws\/media\/feishu-m1-x\.png/,
		"local path folded into the text so non-vision models can read it with tools",
	);
});

test("adapter: followup NEVER silently drops an image without imageRef", async () => {
	const registry = fakeRegistry();
	const backend = mkBackend(ctxOf(registry, undefined));
	const handle = await backend.ensureAgent("dm:ou_img2");
	await handle.followup("看这张图", [
		{ path: "/ws/media/only-local.png", kind: "image", name: "only-local.png" },
	]);
	const agent = registry.agents.get(handle.sessionId) as {
		lastMessage?: { content: Array<{ type: string; text?: string }> };
	};
	const blocks = agent.lastMessage!.content;
	assert.equal(
		blocks.find((b) => b.type === "image"),
		undefined,
		"no ImageBlock without a ref",
	);
	assert.match(
		blocks[0]!.text!,
		/\/ws\/media\/only-local\.png/,
		"the model is at least TOLD the image path (previously: total silence)",
	);
});


// ---- non-vision model: auto-degrade instead of a dead turn -------------------
// Real event 2026-08-19: pi-ai model "glm-5.3" does not support image input →
// turn ended 'error' with no output → bridge reset the session ("会话没了").
// Expected: the adapter catches that agent/error, marks the conversation, and
// re-sends the SAME text (path note included, no ImageBlock) so the turn still
// gets an answer; subsequent images skip ImageBlocks from the start.

test("adapter: image-unsupported model auto-degrades (retry text-only, remember per conversation)", async () => {
	const registry = fakeRegistry();
	const backend = mkBackend(ctxOf(registry, undefined));
	const handle = await backend.ensureAgent("dm:ou_nv");
	const agent = registry.agents.get(handle.sessionId) as {
		followups: Array<{ content: Array<Record<string, unknown>> }>;
		followup(message: { content: Array<Record<string, unknown>> }): void;
		emitAgentError(err: unknown): void;
	};
	// The fake "model" rejects image blocks the moment one arrives.
	agent.followup = (message: { content: Array<Record<string, unknown>> }) => {
		agent.followups.push(message);
		(agent as { lastMessage?: unknown }).lastMessage = message;
		if (message.content.some((b) => b.type === "image")) {
			agent.emitAgentError(
				new Error('pi-ai model "glm-5.3" does not support image input'),
			);
		}
	};
	await handle.followup("描述下", [
		{
			path: "/ws/media/feishu-om1.png",
			kind: "image",
			name: "shot.png",
			imageRef: {
				attachmentId: "att-1",
				mediaType: "image/png",
				bytes: 10,
				width: 4,
				height: 4,
			},
		},
	]);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(agent.followups.length, 2, "auto-retry fired for the same turn");
	const retry = agent.followups[1]!.content;
	assert.equal(
		retry.some((b) => b.type === "image"),
		false,
		"retry carries no ImageBlock",
	);
	const retryText = String((retry[0] as { text?: string }).text ?? "");
	assert.match(retryText, /read_image/, "retry keeps the tool hint");
	assert.match(retryText, /\/ws\/media\/feishu-om1\.png/, "retry keeps the local path");
	assert.match(retryText, /描述下/, "retry keeps the user caption");
	// mark persists: next image goes text-only from the start, no error loop
	await handle.followup("再来一张", [
		{
			path: "/ws/media/feishu-om2.png",
			kind: "image",
			name: "shot2.png",
			imageRef: {
				attachmentId: "att-2",
				mediaType: "image/png",
				bytes: 10,
				width: 4,
				height: 4,
			},
		},
	]);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(agent.followups.length, 3, "no extra retry when no ImageBlock was sent");
	assert.equal(
		agent.followups[2]!.content.some((b) => b.type === "image"),
		false,
		"marked conversation skips ImageBlocks",
	);
	assert.match(
		String((agent.followups[2]!.content[0] as { text?: string }).text ?? ""),
		/feishu-om2\.png/,
		"second image path still noted",
	);
});

test("adapter: DeepSeek and qwen3.8-27b error messages trigger image degradation", async () => {
	const registry = fakeRegistry();
	const backend = mkBackend(ctxOf(registry, undefined));
	const handle = await backend.ensureAgent("dm:ou_ds");
	const agent = registry.agents.get(handle.sessionId) as {
		followups: Array<{ content: Array<Record<string, unknown>> }>;
		followup(message: { content: Array<Record<string, unknown>> }): void;
		emitAgentError(err: unknown): void;
	};
	// DeepSeek official error message: "The DeepSeek chat-completions adapter does not support image content."
	agent.followup = (message: { content: Array<Record<string, unknown>> }) => {
		agent.followups.push(message);
		(agent as { lastMessage?: unknown }).lastMessage = message;
		if (message.content.some((b) => b.type === "image")) {
			agent.emitAgentError(
				new Error("The DeepSeek chat-completions adapter does not support image content."),
			);
		}
	};
	await handle.followup("分析图片", [
		{
			path: "/tmp/media/ds.jpg",
			kind: "image",
			name: "ds.jpg",
			imageRef: { attachmentId: "ds1", mediaType: "image/jpeg", bytes: 10, width: 10, height: 10 },
		},
	]);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(agent.followups.length, 2, "DeepSeek image rejection triggered text-only retry");
	assert.equal(agent.followups[1]!.content.some((b) => b.type === "image"), false);

	// clearImageUnsupported resets the mark
	backend.clearImageUnsupported?.("dm:ou_ds");
	await handle.followup("重新发图", [
		{
			path: "/tmp/media/ds2.jpg",
			kind: "image",
			name: "ds2.jpg",
			imageRef: { attachmentId: "ds2", mediaType: "image/jpeg", bytes: 10, width: 10, height: 10 },
		},
	]);
	await new Promise((r) => setTimeout(r, 10));
	// Since imageUnsupported was cleared, the 3rd followup attached an image block (which triggered another retry -> 4th)
	assert.equal(agent.followups[2]!.content.some((b) => b.type === "image"), true, "cleared mark re-enables image blocks");
});

// ---- image-retry grace vs turn-supervisor recovery (race fix) ----------------
// Real ordering (log 2026-08-19): agent/error fires, the adapter SYNCHRONOUSLY
// re-sends the text-only twin, its turn/start lands, and only THEN the original
// turn/end(error) arrives — the supervisor would see "silent turn" and dispose
// the agent, killing the retry mid-flight. Grace: a ONE-SHOT marker consumed
// by the supervisor's silent branch; the retry turn gets to run. If the retry
// itself dies, the SECOND turn/end finds no marker and recovery proceeds.

test("adapter: image-retry grace is one-shot and only set when a retry fires", async () => {
	const registry = fakeRegistry();
	const backend = mkBackend(ctxOf(registry, undefined));
	const key = "dm:ou_grace";
	// before anything: no grace
	assert.equal(backend.consumeImageRetryGrace?.(key), false);

	const handle = await backend.ensureAgent(key);
	const agent = registry.agents.get(handle.sessionId) as {
		followups: Array<{ content: Array<Record<string, unknown>> }>;
		followup(message: { content: Array<Record<string, unknown>> }): void;
		emitAgentError(err: unknown): void;
	};
	// text-only turn: an error must NOT arm grace (no retry happens)
	await handle.followup("纯文字", []);
	agent.emitAgentError(new Error("some unrelated model error"));
	assert.equal(backend.consumeImageRetryGrace?.(key), false);

	// image turn that gets rejected → retry fires → grace armed exactly once
	await handle.followup("看图", [
		{
			path: "/tmp/media/g1.png",
			kind: "image",
			name: "g1.png",
			imageRef: { attachmentId: "a1", mediaType: "image/png", bytes: 1, width: 1, height: 1 },
		},
	]);
	agent.emitAgentError(
		new Error('pi-ai model "glm-5.3" does not support image input'),
	);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(agent.followups.length, 3, "1 text + 1 image + 1 text-only retry");
	assert.equal(backend.consumeImageRetryGrace?.(key), true, "first consume wins");
	assert.equal(backend.consumeImageRetryGrace?.(key), false, "one-shot: second consume is false");
});
