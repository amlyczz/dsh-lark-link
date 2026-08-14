// Feishu card builders (L4 presentation, schema 2.0). Pure functions.
//
// 2026-08-14 对齐 pi-feishu-link 修复：schema 2.0 已移除 tag:"action"
// 容器（ErrCode 200861）——按钮直接平铺进 body.elements（tag:"button"，
// width:"fill" 防截断），交互回传用 behaviors:[{type:"callback",value}]。
// emoji 精简为稳定集合（部分 emoji 在部分客户端字体渲染乱码）。

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

/** Agent preset options (DSH agent-presets). */
export const AGENT_PRESETS: ReadonlyArray<{
	id: string;
	label: string;
	desc: string;
}> = [
	{
		id: "standard",
		label: "标准模式",
		desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流",
	},
	{
		id: "code",
		label: "PTC 模式",
		desc: "标准能力 + Code Mode（多步操作一次执行，更快）",
	},
	{
		id: "minimal",
		label: "极简模式",
		desc: "仅 bash + 文件编辑，轻量省 token",
	},
	{
		id: "cordis",
		label: "创造模式",
		desc: "标准能力 + preset 创作工具（面向开发者）",
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
 * Intent-confirmation card (DSH ask_user_question → Feishu). Option buttons
 * answer via op "uqa:<questionId>:<optionIndex>"; the footer invites a
 * plain-text reply for a custom answer.
 */
export function questionCard(q: {
	id: string;
	header?: string;
	question: string;
	detail?: string;
	options?: ReadonlyArray<{ label: string; description?: string }>;
}): unknown {
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
		...(q.header
			? {
					header: {
						title: { tag: "plain_text", content: q.header },
						template: "blue",
					},
				}
			: {}),
		body: { elements },
	};
}

/** Single-select mode picker card — tap a button to switch (no typing). */
export function modeCard(current?: string): unknown {
	return markdownCard(
		[
			"**Agent 模式**（单选，点按钮即切换，下条消息生效）",
			"",
			...AGENT_PRESETS.map(
				(p) => `- ${p.label}${current === p.id ? " ← 当前" : ""}：${p.desc}`,
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

export function helpCard(): unknown {
	return markdownCard(
		[
			"**可用命令**（点按钮或直接输入）",
			"",
			"- `/status` 桥接状态",
			"- `/mode` 切换 Agent 模式（标准/PTC/极简/创造）",
			"- `/permission` 切换权限（只读/工作区写/Full access）",
			"- `/new` 当前工作区新起会话",
			"- `/workspace <路径>` 切换工作区（`~` 可用）",
			"- `/stop` 停止当前会话任务",
			"- `/doctor` 生成诊断包（含 session log）",
			"- `/model` 查看/切换模型",
			"- `/lark-config k=v` 热改配置",
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
