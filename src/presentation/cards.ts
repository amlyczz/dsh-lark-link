// Feishu card builders (L4 presentation, schema 2.0). Pure functions.
//
// 2026-08-14 对齐 pi-feishu-link 修复：schema 2.0 已移除 tag:"action"
// 容器（ErrCode 200861）——按钮直接平铺进 body.elements（tag:"button"，
// width:"fill" 防截断），交互回传用 behaviors:[{type:"callback",value}]。
// emoji 精简为稳定集合（部分 emoji 在部分客户端字体渲染乱码）。

import type { AgentPresetOption } from "../common/types.ts";

export type CardVariant = "status" | "help" | "setup" | "welcome" | "error";

/** Card button value (op routing). */
export interface CardButtonValue {
	op: string;
	[key: string]: unknown;
}

/**
 * schema 2.0 按钮：直接作为组件放 elements（平铺、宽度完整不缩略）；
 * 交互回传用 behaviors:[{type:"callback",value}]（card.action.trigger 回调返回 value）。
 */
export function button(
	text: string,
	value: CardButtonValue,
	style?: "primary" | "danger",
): unknown {
	const b: Record<string, unknown> = {
		tag: "button",
		width: "fill",
		text: { tag: "plain_text", content: text },
		behaviors: [{ type: "callback", value }],
	};
	if (style === "primary") b.type = "primary";
	if (style === "danger") b.type = "danger";
	return b;
}

/**
 * Heuristic: does this reply carry markdown worth rendering as a card?
 * Matches headings, lists, fenced code, blockquotes, bold, tables and
 * paragraph breaks (pi-feishu-link rich-text mode selection).
 */
export function looksLikeMarkdown(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (
		/(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*|\|.*\|)/.test(t) ||
		t.includes("\n\n")
	)
		return true;
	return false;
}

export function markdownCard(
	markdown: string,
	opts: { header?: string; accent?: boolean } = {},
): unknown {
	return {
		schema: "2.0",
		// schema 2.0: `header` is a TOP-LEVEL sibling of `body` — nesting it
		// inside body fails with ErrCode 200621 "unknown property header".
		...(opts.header
			? {
					header: {
						title: { tag: "plain_text", content: opts.header },
						template: opts.accent ? "blue" : "grey",
					},
				}
			: {}),
		body: { elements: [{ tag: "markdown", content: markdown }] },
	};
}

/**
 * Agent preset options (DSH agent-presets).
 *
 * `AGENT_PRESETS` is the FALLBACK roster — the four shipped presets — used
 * when the live DSH agentPresets service is unreachable. When the service is
 * up, the bridge renders the dynamic roster (shipped + user-authored) instead;
 * see the DshSessionBackend.listPresets surface.
 */
export const AGENT_PRESETS: ReadonlyArray<AgentPresetOption> = [
	{
		id: "standard",
		label: "标准模式",
		desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流",
		trust: "system",
	},
	{
		id: "code",
		label: "PTC 模式",
		desc: "标准能力 + Code Mode（多步操作一次执行，更快）",
		trust: "system",
	},
	{
		id: "minimal",
		label: "极简模式",
		desc: "仅 bash + 文件编辑，轻量省 token",
		trust: "system",
	},
	{
		id: "cordis",
		label: "创造模式",
		desc: "标准能力 + preset 创作工具（面向开发者）",
		trust: "system",
	},
];

/** Permission preset options (dsh-permission-presets). */
export const PERMISSION_PRESETS: ReadonlyArray<{
	id: string;
	label: string;
	desc: string;
}> = [
	{ id: "read-only", label: "只读", desc: "沙箱只读，危险操作需审批" },
	{
		id: "workspace-write",
		label: "工作区写",
		desc: "仅工作区可写，危险操作需审批",
	},
	{
		id: "danger-full-access",
		label: "Full access",
		desc: "全访问 + 审批 never（默认）",
	},
];

/** Append action buttons to a markdown card's body. */
export function withButtons(card: unknown, buttons: unknown[]): unknown {
	const c = card as { body?: { elements?: unknown[] } };
	return {
		...c,
		body: {
			...(c.body ?? {}),
			elements: [...(c.body?.elements ?? []), ...buttons],
		},
	};
}

/**
 * Intent-confirmation card (DSH ask_user_question → Feishu).
 *
 * Single-select (default): one button per option, answered immediately via op
 * "uqa:<questionId>:<optionIndex>".
 *
 * Multi-select (multiSelect === true): a form_container with a
 * multi_select_static dropdown; the user taps 提交 and the onSubmit callback
 * returns action.formValue.answer (string[] of option indexes) via op
 * "uqam:<questionId>".
 *
 * The footer always invites a plain-text reply as a custom answer.
 */
export function questionCard(q: {
	id: string;
	header?: string;
	question: string;
	detail?: string;
	options?: ReadonlyArray<{ label: string; description?: string }>;
	multiSelect?: boolean;
}): unknown {
	const header = q.header
		? {
				header: {
					title: { tag: "plain_text", content: q.header },
					template: "blue" as const,
				},
			}
		: {};
	if (q.multiSelect) {
		const options = (q.options ?? []).map((o, i) => ({
			text: { tag: "plain_text", content: o.label },
			value: String(i),
		}));
		return {
			schema: "2.0",
			...header,
			body: {
				elements: [
					{ tag: "markdown", content: q.question },
					...(q.detail ? [{ tag: "markdown", content: q.detail }] : []),
					{
						tag: "form_container",
						children: [
							{
								tag: "multi_select_static",
								name: "answer",
								placeholder: {
									tag: "plain_text",
									content: "请选择（可多选）…",
								},
								options,
							},
						],
						onSubmit: [
							{ type: "callback", value: { op: `uqam:${q.id}` } },
						],
					},
					{ tag: "markdown", content: "或直接发消息输入自定义答案" },
				],
			},
		};
	}
	const elements: unknown[] = [
		{ tag: "markdown", content: q.question },
		...(q.detail ? [{ tag: "markdown", content: q.detail }] : []),
	];
	(q.options ?? []).forEach((o, i) => {
		elements.push(button(o.label, { op: `uqa:${q.id}:${i}` }));
	});
	elements.push({
		tag: "markdown",
		content: "或直接发消息输入自定义答案",
	});
	return {
		schema: "2.0",
		...header,
		body: { elements },
	};
}

/** Single-select mode picker card — tap a button to switch (no typing). */
export function modeCard(
	current?: string,
	presets?: ReadonlyArray<AgentPresetOption>,
): unknown {
	const roster = presets && presets.length > 0 ? presets : AGENT_PRESETS;
	return markdownCard(
		[
			"**Agent 模式**（单选，点按钮即切换，下条消息生效）",
			"",
			...roster.map(
				(p) =>
					`- ${p.label}${p.trust === "user" ? "（自定义）" : ""}${
						current === p.id ? " ← 当前" : ""
					}：${p.desc ?? p.id}${p.broken ? `（不可用：${p.broken}）` : ""}`,
			),
		].join("\n"),
		{ header: "切换模式", accent: true },
	) as {
		body: { elements: unknown[] };
	};
}

/** Model picker card grouped by provider: provider header + one button per model. */
export function modelCard(
	current: { provider?: string; model?: string } | undefined,
	groups: ReadonlyArray<{
		provider: string;
		label?: string;
		models: ReadonlyArray<{ id: string; name?: string }>;
	}>,
): unknown {
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: `**当前模型**: ${current?.provider ?? "?"}/${current?.model ?? "未设置"}`,
		},
		{
			tag: "markdown",
			content: "**按供应商选择模型**（点按钮即切换，下条消息生效）",
		},
	];
	let first = true;
	for (const g of groups) {
		if (g.models.length === 0) continue;
		if (!first) elements.push({ tag: "hr" });
		first = false;
		elements.push({
			tag: "markdown",
			content: `**${g.label ?? g.provider}**`,
		});
		for (const m of g.models) {
			elements.push({
				tag: "button",
				width: "fill",
				text: { tag: "plain_text", content: m.name ?? m.id },
				behaviors: [
					{
						type: "callback",
						value: { op: `model:${g.provider}/${m.id}` },
					},
				],
			});
		}
	}
	if (first) {
		elements.push({
			tag: "markdown",
			content: "（无可用模型列表）",
		});
	}
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "切换模型" },
			template: "blue",
		},
		body: { elements },
	};
}

/** Single-select permission picker card. */
export function permissionCard(current?: string): unknown {
	return markdownCard(
		[
			"**权限模式**（单选，点按钮即切换）",
			"",
			...PERMISSION_PRESETS.map(
				(p) => `- ${p.label}${current === p.id ? " ← 当前" : ""}：${p.desc}`,
			),
		].join("\n"),
		{ header: "切换权限", accent: true },
	) as {
		body: { elements: unknown[] };
	};
}

/**
 * Workspace history picker card (/resume): one button per historical session
 * of the CURRENT workspace (newest first).
 *
 * User-friendliness decisions:
 * - Relative times (5 分钟前 / 3 天前) instead of raw timestamps.
 * - Stored preset badge per row; the CURRENT session is listed too but its
 *   button is disabled (users see where they are).
 * - Button op carries the session id URI-ENCODED — the card-action dispatcher
 *   splits op at the FIRST ":" and lark-link session ids are full of colons
 *   (`lark-link:dm:oc_x:nonce:0`); an unencoded id would lose its prefix and
 *   the click would resolve to 未找到会话.
 */
export function resumeCard(
	sessions: ReadonlyArray<{
		id: string;
		createdAt: number;
		preset?: string;
		title?: string;
	}>,
	currentSessionId?: string,
	opts: { now?: () => number } = {},
): unknown {
	const now = opts.now ?? Date.now;
	const rel = (ts: number): string => {
		const d = Math.max(0, now() - ts);
		const m = Math.floor(d / 60_000);
		if (m < 1) return "刚刚";
		if (m < 60) return `${m} 分钟前`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h} 小时前`;
		const day = Math.floor(h / 24);
		if (day < 30) return `${day} 天前`;
		return new Date(ts).toLocaleDateString("zh-CN");
	};
	const elements: unknown[] = [
		{
			tag: "markdown",
			content:
				"**恢复历史会话**（点按钮即恢复；或直接回复 `/resume <序号>`）",
		},
	];
	// Sequence numbers count only RESUMABLE rows — the current session is
	// displayed (disabled, unnumbered) so `/resume <n>` always matches the
	// numbered buttons exactly.
	let n = 0;
	sessions.forEach((s) => {
		const isCurrent = s.id === currentSessionId;
		const titlePart = s.title ? s.title.slice(0, 32) : (s.preset ? `会话 · ${s.preset}` : "会话");
		const label = isCurrent
			? `当前会话: ${titlePart}（${rel(s.createdAt)}）`
			: `#${++n} ${titlePart}（${rel(s.createdAt)}）`;
		const btn = button(label, { op: `resume:${encodeURIComponent(s.id)}` });
		if (isCurrent) {
			(btn as { disabled?: boolean }).disabled = true;
		}
		elements.push(btn);
	});

	if (currentSessionId && !sessions.some((s) => s.id === currentSessionId)) {
		// The current session was excluded from the listing (fresh chat, no
		// history yet) — still show where the conversation IS.
		elements.push({
			tag: "markdown",
			content: `- 当前会话：刚刚开始（发消息即在此会话继续）`,
		});
	}
	if (sessions.length === 0) {
		elements.push({
			tag: "markdown",
			content: "（该工作区暂无历史会话日志）",
		});
	}
	elements.push({
		tag: "markdown",
		content: [
			"———",
			"💡 恢复后**下一条消息接续历史上下文**；此前的会话仍然保留，随时可再 `/resume` 切回。",
			"新起会话用 `/new`；换工作区用 `/workspace <路径>`。",
		].join("\n"),
	});
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "恢复历史会话" },
			template: "blue",
		},
		body: { elements },
	};
}

export function helpCard(): unknown {
	return markdownCard(
		[
			"**可用命令**（点按钮或直接输入）",
			"",
			"- `/status` 桥接状态",
			"- `/mode` 切换 Agent 模式（标准/PTC/极简/创造）",
			"- `/permission` 切换权限（只读/工作区写/Full access）",
			"- `/new` 当前工作区新起会话",
			"- `/resume` 恢复当前工作区的历史会话",
			"- `/workspace <路径>` 切换工作区（`~` 可用）",
			"- `/stop` 停止当前会话任务",
			"- `/doctor` 生成诊断包（含 session log）",
			"- `/model` 查看/切换模型",
			"- `/lark-config k=v` 热改配置（嵌套键如 `streaming.enabled=true`）",
			"- `/lark setup|start|stop|status` 桥接管理",
			"- `/goal` 等 DSH 命令原样执行",
			"- skill 无需前缀：直接说任务（如「用 X skill 做 Y」）",
		].join("\n"),
		{ header: "Lark Link 帮助", accent: true },
	);
}

/** Welcome card with one-click buttons (schema 2.0 平铺按钮). */
export function welcomeCard(botName: string): unknown {
	return {
		schema: "2.0",
		body: {
			header: {
				title: { tag: "plain_text", content: "连接成功" },
				template: "blue",
			},
			elements: [
				{
					tag: "markdown",
					content: `**${botName} 已连接**\n\n你可以直接和我说话，或点下方按钮：`,
				},
				button("命令面板", { op: "help" }),
				button("桥接状态", { op: "status" }),
				button("停止任务", { op: "stop" }),
			],
		},
	};
}

/** Command panel card with one-click buttons. */
export function commandPanelCard(): unknown {
	return {
		schema: "2.0",
		body: {
			header: {
				title: { tag: "plain_text", content: "命令面板" },
				template: "blue",
			},
			elements: [
				{
					tag: "markdown",
					content: "**命令面板**\n点击按钮一键执行，或直接输入文字聊天：",
				},
				button("桥接状态", { op: "status" }),
				button("停止任务", { op: "stop" }),
				button("工作区", { op: "workspace" }),
				button("诊断包", { op: "doctor" }),
				button("配置", { op: "lark-config" }),
				{
					tag: "markdown",
					content:
						"文本命令：`/status` `/mode` `/permission` `/workspace` `/stop` `/doctor` `/help`\n\n`/goal` 等 DSH 命令原样执行；skill 无需前缀，直接描述任务即可。",
				},
			],
		},
	};
}

/** Status card with a doctor button. */
export function statusCard(
	statusText: string,
	detailLines: string[] = [],
): unknown {
	return {
		schema: "2.0",
		body: {
			elements: [
				{ tag: "markdown", content: `**状态**\n${statusText}` },
				...detailLines.map((line) => ({ tag: "markdown", content: line })),
				button("诊断包", { op: "doctor" }),
			],
		},
	};
}

export function setupCard(qrUrl: string, expireInSec: number): unknown {
	return markdownCard(
		[
			"**扫码创建飞书应用**（30 秒上线）",
			"",
			`二维码有效期 ${expireInSec}s，或用链接手动打开：`,
			qrUrl,
		].join("\n"),
		{ header: "Lark Link 设置", accent: true },
	);
}

export function errorCard(message: string): unknown {
	return markdownCard(`**出错了**\n\n${message}`, {
		header: "错误",
		accent: false,
	});
}

export const CARD_MESSAGE_TYPE = "interactive";

export * from "./task-cards.ts";
