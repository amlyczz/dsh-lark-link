// Task, Goal, and Plan Card Builders (L4 presentation, Feishu Card Schema 2.0).
// Pure functions. Zero DSH imports, zero Feishu SDK imports.

import type {
	GoalSnapshotState,
	ResumedSessionBriefing,
	TaskCardState,
	TodoItemState,
} from "../common/types.ts";
import { button, type CardButtonValue } from "./cards.ts";

/**
 * Generate a text-based progress bar, e.g. `[████░░░░░░░░░░░░] 25.0%`.
 */
export function renderProgressBar(completed: number, total: number, width = 14): string {
	if (total <= 0) return "[░░░░░░░░░░░░░░] 0.0%";
	const ratio = Math.min(1, Math.max(0, completed / total));
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	const percent = (ratio * 100).toFixed(1);
	return `\`[${bar}]\` **${percent}%** (${completed}/${total})`;
}

/**
 * Format todo item lines with appropriate visual badges.
 */
export function formatTodoList(todos: ReadonlyArray<TodoItemState>, isFolded = true, maxFoldItems = 6): string {
	if (todos.length === 0) {
		return "*(暂无任务清单)*";
	}

	const formatItem = (t: TodoItemState, i: number): string => {
		switch (t.status) {
			case "in_progress":
				return `🔵 **#${i + 1} ${t.content}** *(进行中)*`;
			case "completed":
				return `🟢 ~#${i + 1} ${t.content}~`;
			case "pending":
			default:
				return `◌ #${i + 1} ${t.content}`;
		}
	};

	if (!isFolded || todos.length <= maxFoldItems) {
		return todos.map((t, i) => formatItem(t, i)).join("\n");
	}

	// Smart folding: show in_progress items, last completed item, first pending items
	const inProgIdx = todos.findIndex((t) => t.status === "in_progress");
	const displayItems: Array<{ item: TodoItemState; index: number }> = [];

	todos.forEach((t, i) => {
		if (i < 3 || (inProgIdx !== -1 && Math.abs(i - inProgIdx) <= 1) || i === todos.length - 1) {
			if (!displayItems.some((d) => d.index === i)) {
				displayItems.push({ item: t, index: i });
			}
		}
	});

	displayItems.sort((a, b) => a.index - b.index);

	const lines: string[] = [];
	let lastIdx = -1;
	for (const { item, index } of displayItems) {
		if (lastIdx !== -1 && index > lastIdx + 1) {
			const hiddenCount = index - lastIdx - 1;
			lines.push(`*... (已折叠 ${hiddenCount} 项待处理任务) ...*`);
		}
		lines.push(formatItem(item, index));
		lastIdx = index;
	}

	if (lastIdx < todos.length - 1) {
		const hiddenCount = todos.length - 1 - lastIdx;
		lines.push(`*... (还有 ${hiddenCount} 项待处理任务已折叠) ...*`);
	}

	return lines.join("\n");
}

/**
 * Main Task & Goal Board Card (Schema 2.0).
 * Matches the DSH native task monitor UI shown in user screenshots.
 */
export function buildTaskBoardCard(state: TaskCardState, opts: { isFolded?: boolean } = {}): unknown {
	const isFolded = opts.isFolded ?? state.isFolded ?? true;
	const todos = state.todos ?? [];
	const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
	const completedCount = todos.filter((t) => t.status === "completed").length;
	const pendingCount = todos.filter((t) => t.status === "pending").length;
	const totalCount = todos.length;

	let template = "blue";
	let statusLabel = "执行中";
	if (state.goal) {
		switch (state.goal.phase) {
			case "complete":
				template = "green";
				statusLabel = "已完成";
				break;
			case "paused":
				template = "yellow";
				statusLabel = "已暂停";
				break;
			case "blocked":
				template = "orange";
				statusLabel = "已阻塞";
				break;
			case "active":
			default:
				template = "blue";
				statusLabel = "执行中";
				break;
		}
	} else if (totalCount > 0 && completedCount === totalCount) {
		template = "green";
		statusLabel = "已完成";
	}

	const elements: unknown[] = [];

	// 1. Goal Section
	if (state.goal) {
		elements.push({
			tag: "markdown",
			content: `**🎯 进行中的目标**\n${state.goal.objective}`,
		});

		if (state.goal.phase === "blocked" && state.goal.blockedReason) {
			elements.push({
				tag: "markdown",
				content: `> ⚠️ **阻塞原因**: \`${state.goal.blockedReason.code}\` - ${state.goal.blockedReason.message}`,
			});
		}

		// Metadata Columns: 工作区 | 轮次 | 进度
		const wsDisplay = state.workspacePath ? state.workspacePath.split("/").filter(Boolean).pop() ?? state.workspacePath : "默认工作区";
		elements.push({
			tag: "column_set",
			flex_mode: "flow",
			background_style: "grey",
			columns: [
				{
					tag: "column",
					width: "weighted",
					weight: 1,
					elements: [{ tag: "markdown", content: `📁 **工作区**\n\`${wsDisplay}\`` }],
				},
				{
					tag: "column",
					width: "weighted",
					weight: 1,
					elements: [{ tag: "markdown", content: `🔄 **执行轮次**\n\`${state.goal.roundsStarted}\` / ${state.goal.maxGoalRounds}` }],
				},
				{
					tag: "column",
					width: "weighted",
					weight: 1,
					elements: [{ tag: "markdown", content: `📊 **总进度**\n${totalCount > 0 ? `${Math.round((completedCount / totalCount) * 100)}%` : "0%"}` }],
				},
			],
		});

		elements.push({ tag: "hr" });
	}

	// 2. Progress summary & Todo list
	elements.push({
		tag: "markdown",
		content: [
			`**📊 任务总览** ⚡ ${inProgressCount} 进行中 · ⏳ ${pendingCount} 待处理 · ✅ ${completedCount} 已完成`,
			renderProgressBar(completedCount, totalCount),
		].join("\n"),
	});

	elements.push({
		tag: "markdown",
		content: `**📋 任务执行清单**:\n\n${formatTodoList(todos, isFolded)}`,
	});

	elements.push({ tag: "hr" });

	// 3. Action Buttons (Schema 2.0 column_set)
	const actionCols: unknown[] = [];

	if (state.goal?.phase === "paused") {
		actionCols.push({
			tag: "column",
			width: "weighted",
			weight: 1,
			elements: [
				button("▶️ 恢复执行", {
					op: "goal:resume",
					goalId: state.goal.id,
					revision: state.goal.revision,
				}, "primary"),
			],
		});
	} else if (state.goal?.phase === "active" || (!state.goal && inProgressCount > 0)) {
		actionCols.push({
			tag: "column",
			width: "weighted",
			weight: 1,
			elements: [
				button("⏸ 暂停目标", {
					op: "goal:pause",
					goalId: state.goal?.id,
					revision: state.goal?.revision,
				}),
			],
		});
	}

	actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [
			button("🛑 终止任务", {
				op: "goal:clear",
				goalId: state.goal?.id,
				revision: state.goal?.revision,
			}, "danger"),
		],
	});

	if (totalCount > 6) {
		actionCols.push({
			tag: "column",
			width: "weighted",
			weight: 1,
			elements: [
				button(isFolded ? "📋 展开详情" : "🔼 收起列表", {
					op: "task:toggle_fold",
					folded: !isFolded,
				}),
			],
		});
	}

	elements.push({
		tag: "column_set",
		flex_mode: "flow",
		columns: actionCols,
	});

	return {
		schema: "2.0",
		config: {
			update_multi: true,
			streaming_mode: false,
		},
		header: {
			title: {
				tag: "plain_text",
				content: `🎯 DSH 任务看板 · ${statusLabel} (${completedCount}/${totalCount})`,
			},
			subtitle: {
				tag: "plain_text",
				content: `${inProgressCount} 进行中 · ${pendingCount} 待处理 · ${completedCount} 已完成`,
			},
			template,
		},
		body: { elements },
	};
}

/**
 * Controller Card for `/goal` command when an active goal exists.
 */
export function buildGoalControlCard(goal: GoalSnapshotState, opts: { workspacePath?: string } = {}): unknown {
	let template = "blue";
	let phaseDesc = "进行中";
	if (goal.phase === "paused") {
		template = "yellow";
		phaseDesc = "已暂停";
	} else if (goal.phase === "blocked") {
		template = "orange";
		phaseDesc = "已阻塞";
	} else if (goal.phase === "complete") {
		template = "green";
		phaseDesc = "已达成";
	}

	const wsDisplay = opts.workspacePath ? opts.workspacePath.split("/").filter(Boolean).pop() ?? opts.workspacePath : "默认工作区";

	const elements: unknown[] = [
		{
			tag: "markdown",
			content: `**🎯 当前目标** (${phaseDesc})\n${goal.objective}`,
		},
	];

	if (goal.phase === "blocked" && goal.blockedReason) {
		elements.push({
			tag: "markdown",
			content: `> ⚠️ **阻塞原因**: \`${goal.blockedReason.code}\` - ${goal.blockedReason.message}`,
		});
	}

	elements.push({
		tag: "column_set",
		flex_mode: "flow",
		background_style: "grey",
		columns: [
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [{ tag: "markdown", content: `📁 **工作区**\n\`${wsDisplay}\`` }],
			},
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [{ tag: "markdown", content: `🔄 **轮次**\n\`${goal.roundsStarted}\` / ${goal.maxGoalRounds}` }],
			},
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [{ tag: "markdown", content: `🚦 **状态**\n\`${goal.phase}\`` }],
			},
		],
	});

	elements.push({ tag: "hr" });

	const actionCols: unknown[] = [];
	if (goal.phase === "paused" || goal.phase === "blocked") {
		actionCols.push({
			tag: "column",
			width: "weighted",
			weight: 1,
			elements: [
				button("▶️ 恢复执行", { op: "goal:resume", goalId: goal.id, revision: goal.revision }, "primary"),
			],
		});
	} else if (goal.phase === "active") {
		actionCols.push({
			tag: "column",
			width: "weighted",
			weight: 1,
			elements: [
				button("⏸ 暂停目标", { op: "goal:pause", goalId: goal.id, revision: goal.revision }),
			],
		});
	}

	actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [
			button("🛑 清除目标", { op: "goal:clear", goalId: goal.id, revision: goal.revision }, "danger"),
		],
	});

	actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [
			button("📋 任务看板", { op: "task:focus_board" }),
		],
	});

	elements.push({
		tag: "column_set",
		flex_mode: "flow",
		columns: actionCols,
	});

	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: `🎯 DSH 目标控制台 · ${phaseDesc}` },
			template,
		},
		body: { elements },
	};
}

/**
 * Setup/Guide Card for `/goal` command when NO active goal exists.
 */
export function buildGoalSetupCard(): unknown {
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: [
				"**目标（Goal）** 可驱动 Agent 在多轮循环中自主推进复杂任务，直到目标达成。",
				"",
				"💡 **常用目标快速模板**（点按钮直接触发）：",
			].join("\n"),
		},
		button("🛠️ 构建与测试工程", { op: "goal:tpl:build" }),
		button("🐞 诊断并修复问题", { op: "goal:tpl:fix" }),
		button("📝 重构模块与补全文档", { op: "goal:tpl:refactor" }),
		{
			tag: "markdown",
			content: [
				"———",
				"或直接输入指令设定自定义目标：",
				"`/goal <你的目标描述>`",
			].join("\n"),
		},
	];

	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "🎯 设定新的 Agent 目标" },
			template: "blue",
		},
		body: { elements },
	};
}

/**
 * Plan Review & Approval Card (Schema 2.0) triggered by `exit_plan_mode`.
 */
export function buildPlanReviewCard(plan: string, questionId = "plan_review"): unknown {
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: plan || "*(空计划)*",
		},
		{ tag: "hr" },
		{
			tag: "markdown",
			content: "**💡 请选择后续执行方式：**",
		},
		button("🚀 批准并设为 Goal (多轮自主执行)", {
			op: `plan:approve_goal:${questionId}`,
		}, "primary"),
		button("✅ 仅批准方案 (在当前对话单步执行)", {
			op: `plan:approve_plain:${questionId}`,
		}),
		button("💬 提出修改意见", {
			op: `plan:feedback:${questionId}`,
		}),
		button("🛑 放弃计划", {
			op: `plan:cancel:${questionId}`,
		}, "danger"),
	];

	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "📝 方案规划完成 · 请评审确认" },
			template: "turquoise",
		},
		body: { elements },
	};
}

/**
 * Briefing card sent when an agent session is restored via `/resume`.
 */
export function buildSessionResumedCard(briefing: ResumedSessionBriefing): unknown {
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: `**工作区**: \`${briefing.workspacePath ?? "默认"}\`${briefing.preset ? ` · **模式**: \`${briefing.preset}\`` : ""}`,
		},
	];

	if (briefing.goal) {
		let phaseLabel = "已暂停 (待恢复)";
		if (briefing.goal.phase === "active") phaseLabel = "活跃中 (需恢复武装)";
		else if (briefing.goal.phase === "complete") phaseLabel = "已完成";

		elements.push({
			tag: "markdown",
			content: [
				`🎯 **历史未完成目标** (${phaseLabel}):`,
				`${briefing.goal.objective}`,
				`🔄 轮次: \`${briefing.goal.roundsStarted}\` / ${briefing.goal.maxGoalRounds}`,
			].join("\n"),
		});
	}

	if (briefing.todos && briefing.todos.length > 0) {
		const total = briefing.todos.length;
		const comp = briefing.todos.filter((t) => t.status === "completed").length;
		const inProg = briefing.todos.filter((t) => t.status === "in_progress").length;
		const pend = briefing.todos.filter((t) => t.status === "pending").length;

		elements.push({
			tag: "markdown",
			content: [
				`📊 **任务进度**: ${renderProgressBar(comp, total)}`,
				`⚡ ${inProg} 进行中 · ⏳ ${pend} 待处理 · ✅ ${comp} 已完成`,
				"",
				formatTodoList(briefing.todos, true, 3),
			].join("\n"),
		});
	}


	if (briefing.goal && briefing.goal.phase !== "complete") {
		elements.push({ tag: "hr" });

		const actionCols: unknown[] = [
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [
					button("▶️ 一键继续执行原目标", {
						op: "goal:resume",
						goalId: briefing.goal.id,
						revision: briefing.goal.revision,
					}, "primary"),
				],
			},
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [
					button("📋 唤起任务看板", { op: "task:focus_board" }),
				],
			},
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [
					button("🛑 清除原目标", {
						op: "goal:clear",
						goalId: briefing.goal.id,
						revision: briefing.goal.revision,
					}),
				],
			},
		];

		elements.push({
			tag: "column_set",
			flex_mode: "flow",
			columns: actionCols,
		});
	} else {
		elements.push({
			tag: "markdown",
			content: "💡 **会话已恢复**，直接发送消息即可继续对话。",
		});
	}

	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "🔄 已恢复历史会话" },
			template: "blue",
		},
		body: { elements },
	};
}

