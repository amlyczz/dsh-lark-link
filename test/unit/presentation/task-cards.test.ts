import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildGoalControlCard,
	buildGoalSetupCard,
	buildPlanReviewCard,
	buildSessionResumedCard,
	buildTaskBoardCard,
	formatTodoList,
	renderProgressBar,
} from "../../../src/presentation/task-cards.ts";
import type { TaskCardState } from "../../../src/common/types.ts";

test("task-cards: renderProgressBar calculates accurate percentages and bars", () => {
	assert.match(renderProgressBar(0, 10), /0\.0%/);
	assert.match(renderProgressBar(5, 10), /50\.0%/);
	assert.match(renderProgressBar(10, 10), /100\.0%/);
	assert.match(renderProgressBar(0, 0), /0\.0%/);
});

test("task-cards: formatTodoList badges in_progress, completed, and pending items", () => {
	const todos = [
		{ content: "Task 1", status: "completed" as const },
		{ content: "Task 2", status: "in_progress" as const },
		{ content: "Task 3", status: "pending" as const },
	];
	const formatted = formatTodoList(todos, false);
	assert.match(formatted, /🟢 ~#1 Task 1~/);
	assert.match(formatted, /🔵 \*\*#2 Task 2\*\*/);
	assert.match(formatted, /◌ #3 Task 3/);
});

test("task-cards: formatTodoList folds long lists with summary placeholder", () => {
	const todos = Array.from({ length: 12 }, (_, i) => ({
		content: `Task ${i + 1}`,
		status: i === 0 ? "completed" as const : i === 1 ? "in_progress" as const : "pending" as const,
	}));
	const formatted = formatTodoList(todos, true, 5);
	assert.match(formatted, /已折叠/);
});

test("task-cards: buildTaskBoardCard renders active state with goal and todos", () => {
	const state: TaskCardState = {
		sessionKey: "dm:oc_123",
		sequence: 1,
		workspacePath: "/Users/test/project",
		goal: {
			id: "gid_1",
			revision: 1,
			objective: "Build complete ESP32 firmware",
			phase: "active",
			roundsStarted: 3,
			maxGoalRounds: 256,
		},
		todos: [
			{ content: "Setup CMake", status: "completed" },
			{ content: "Write driver", status: "in_progress" },
			{ content: "Write tests", status: "pending" },
		],
		isFolded: true,
	};

	const card = buildTaskBoardCard(state) as {
		schema: string;
		header: { template: string; title: { content: string } };
		body: { elements: Array<{ tag: string; content?: string }> };
	};

	assert.equal(card.schema, "2.0");
	assert.equal(card.header.template, "blue");
	assert.match(card.header.title.content, /执行中/);
	assert.ok(card.body.elements.some((e) => e.content?.includes("Build complete ESP32 firmware")));
	assert.ok(card.body.elements.some((e) => e.content?.includes("Write driver")));
});

test("task-cards: buildTaskBoardCard renders paused and blocked goal states", () => {
	const pausedState: TaskCardState = {
		sessionKey: "dm:oc_123",
		sequence: 2,
		goal: {
			id: "gid_1",
			revision: 2,
			objective: "Build firmware",
			phase: "paused",
			roundsStarted: 3,
			maxGoalRounds: 256,
		},
		todos: [],
	};
	const pausedCard = buildTaskBoardCard(pausedState) as { header: { template: string } };
	assert.equal(pausedCard.header.template, "yellow");

	const blockedState: TaskCardState = {
		sessionKey: "dm:oc_123",
		sequence: 3,
		goal: {
			id: "gid_1",
			revision: 3,
			objective: "Build firmware",
			phase: "blocked",
			roundsStarted: 3,
			maxGoalRounds: 256,
			blockedReason: {
				code: "quota-limit",
				message: "Out of API tokens",
			},
		},
		todos: [],
	};
	const blockedCard = buildTaskBoardCard(blockedState) as {
		header: { template: string };
		body: { elements: Array<{ content?: string }> };
	};
	assert.equal(blockedCard.header.template, "orange");
	assert.ok(blockedCard.body.elements.some((e) => e.content?.includes("quota-limit")));
});

test("task-cards: buildGoalControlCard renders control buttons", () => {
	const card = buildGoalControlCard({
		id: "gid_1",
		revision: 1,
		objective: "Fix critical bug",
		phase: "active",
		roundsStarted: 1,
		maxGoalRounds: 100,
	}) as { header: { template: string } };
	assert.equal(card.header.template, "blue");
});

test("task-cards: buildGoalSetupCard renders templates", () => {
	const card = buildGoalSetupCard() as { body: { elements: Array<{ tag: string }> } };
	assert.ok(card.body.elements.some((e) => e.tag === "button"));
});

test("task-cards: buildPlanReviewCard renders review actions", () => {
	const card = buildPlanReviewCard("# Architecture Plan\n1. Do this\n2. Do that", "q_123") as {
		header: { template: string };
		body: { elements: Array<{ tag: string; content?: string }> };
	};
	assert.equal(card.header.template, "turquoise");
	assert.ok(card.body.elements.some((e) => e.content?.includes("Architecture Plan")));
});

test("task-cards: buildSessionResumedCard renders resumed status and quick rearm button", () => {
	const card = buildSessionResumedCard({
		sessionId: "s_123",
		workspacePath: "/project/app",
		goal: {
			id: "gid_1",
			revision: 1,
			objective: "Resume firmware build",
			phase: "active",
			roundsStarted: 5,
			maxGoalRounds: 256,
		},
		todos: [
			{ content: "Step 1", status: "completed" },
			{ content: "Step 2", status: "in_progress" },
		],
	}) as {
		header: { template: string };
		body: { elements: Array<{ content?: string; tag?: string }> };
	};
	assert.equal(card.header.template, "blue");
	assert.ok(card.body.elements.some((e) => e.content?.includes("Resume firmware build")));
	assert.ok(card.body.elements.some((e) => e.content?.includes("Step 1")));
});

test("task-cards: buildSessionResumedCard renders goal setup options when no active goal exists", () => {
	const card = buildSessionResumedCard({
		sessionId: "s_456",
		workspacePath: "/project/app",
	}) as {
		header: { template: string };
		body: { elements: Array<{ content?: string; tag?: string }> };
	};
	assert.equal(card.header.template, "blue");
	assert.ok(card.body.elements.some((e) => e.content?.includes("会话已恢复")));
	const json = JSON.stringify(card);
	assert.ok(json.includes("设定新目标"));
	assert.ok(json.includes("构建与测试"));
});

