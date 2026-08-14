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
		agents,
		async create(createOpts: { sessionId: string }) {
			created.push(createOpts);
			const agent = makeAgent(createOpts.sessionId);
			agents.set(createOpts.sessionId, agent);
			agentNo.n++;
			return {
				agent,
				dispose: async () => agents.delete(createOpts.sessionId),
			};
		},
		get(id: string) {
			return agents.get(id);
		},
	};
	return registry;
}

const ctxOf = (
	registry: ReturnType<typeof fakeRegistry>,
	agentDefaultModel?: unknown,
) =>
	({ agents: registry, agentDefaultModel }) as unknown as Parameters<
		typeof createDshAdapter
	>[0]["ctx"];

function mkBackend(ctx: unknown): DshSessionBackend {
	return createDshAdapter({
		ctx: ctx as Parameters<typeof createDshAdapter>[0]["ctx"],
		sessionPrefix: "lark-link",
		logger: silentLogger,
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
	const backend = mkBackend(ctx);
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
	assert.equal(opts.setup, undefined, "no setup without default model");
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
