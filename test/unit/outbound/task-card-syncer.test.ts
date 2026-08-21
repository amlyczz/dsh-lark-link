import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskCardSyncer } from "../../../src/outbound/task-card-syncer.ts";
import type { CardKitApi } from "../../../src/outbound/cardkit-stream.ts";

function fakeCardKitApi() {
	const calls: Array<{ op: string; args: unknown[] }> = [];
	let nextCardId = 1;
	const api: CardKitApi = {
		async createCard(payload) {
			calls.push({ op: "createCard", args: [payload] });
			return { card_id: `task-card-${nextCardId++}` };
		},
		async deliverCard(cardId) {
			calls.push({ op: "deliverCard", args: [cardId] });
			return {};
		},
		async streamText(cardId, elementId, body) {
			calls.push({ op: "streamText", args: [cardId, elementId, body] });
			return {};
		},
		async patchSettings(cardId, body) {
			calls.push({ op: "patchSettings", args: [cardId, body] });
			return {};
		},
		async updateCard(cardId, body) {
			calls.push({ op: "updateCard", args: [cardId, body] });
			return {};
		},
	};
	return { api, calls };
}

test("task-card-syncer: first update creates card entity and delivers it", async () => {
	const { api, calls } = fakeCardKitApi();
	const syncer = createTaskCardSyncer({ api, debounceMs: 50 });

	await syncer.updateGoal("dm:oc_1", {
		id: "g_1",
		revision: 1,
		objective: "Do task",
		phase: "active",
		roundsStarted: 0,
		maxGoalRounds: 100,
	}, "/test/ws");

	const createCall = calls.find((c) => c.op === "createCard");
	const deliverCall = calls.find((c) => c.op === "deliverCard");
	assert.ok(createCall);
	assert.ok(deliverCall);

	const state = syncer.getState("dm:oc_1");
	assert.equal(state?.cardEntityId, "task-card-1");
	assert.equal(state?.sequence, 1);
});

test("task-card-syncer: multiple rapid todo updates are debounced into single in-place update", async () => {
	const { api, calls } = fakeCardKitApi();
	const syncer = createTaskCardSyncer({ api, debounceMs: 50 });

	// First call initializes
	await syncer.updateTodos("dm:oc_1", [{ content: "Step 1", status: "pending" }]);
	assert.equal(calls.filter((c) => c.op === "createCard").length, 1);

	// Rapid updates
	await syncer.updateTodos("dm:oc_1", [{ content: "Step 1", status: "in_progress" }]);
	await syncer.updateTodos("dm:oc_1", [
		{ content: "Step 1", status: "in_progress" },
		{ content: "Step 2", status: "pending" },
	]);

	// Wait for debounce timer
	await new Promise((r) => setTimeout(r, 80));

	const updateCalls = calls.filter((c) => c.op === "updateCard");
	assert.equal(updateCalls.length, 1);
	const seq = (updateCalls[0]!.args[1] as { sequence: number }).sequence;
	assert.equal(seq, 2);
});

test("task-card-syncer: toggleFold triggers immediate card update", async () => {
	const { api, calls } = fakeCardKitApi();
	const syncer = createTaskCardSyncer({ api, debounceMs: 50 });

	await syncer.updateTodos("dm:oc_1", [{ content: "Step 1", status: "in_progress" }]);
	await syncer.toggleFold("dm:oc_1", false);

	const state = syncer.getState("dm:oc_1");
	assert.equal(state?.isFolded, false);
	assert.ok(calls.some((c) => c.op === "updateCard"));
});

test("task-card-syncer: complete goal triggers immediate update", async () => {
	const { api, calls } = fakeCardKitApi();
	const syncer = createTaskCardSyncer({ api, debounceMs: 50 });

	await syncer.updateGoal("dm:oc_1", {
		id: "g_1",
		revision: 1,
		objective: "Build app",
		phase: "active",
		roundsStarted: 1,
		maxGoalRounds: 100,
	});

	await syncer.updateGoal("dm:oc_1", {
		id: "g_1",
		revision: 2,
		objective: "Build app",
		phase: "complete",
		roundsStarted: 2,
		maxGoalRounds: 100,
	});

	assert.ok(calls.some((c) => c.op === "updateCard"));
});
