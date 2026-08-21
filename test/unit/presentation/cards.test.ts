// Card builder tests (aligned with pi-feishu-link 2026-08-14 fix): schema 2.0
// cards MUST NOT contain tag:"action" containers (ErrCode 200861); buttons are
// flat body.elements with behaviors:[{type:"callback",value}] and width:"fill".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	welcomeCard,
	commandPanelCard,
	statusCard,
	markdownCard,
	setupCard,
	errorCard,
	button,
	modeCard,
	questionCard,
	resumeCard,
} from "../../../src/presentation/cards.ts";

type Json = Record<string, unknown>;

function collectButtons(node: unknown, acc: Array<Json> = []): Array<Json> {
	if (Array.isArray(node)) {
		for (const item of node) collectButtons(item, acc);
		return acc;
	}
	if (node && typeof node === "object") {
		const obj = node as Json;
		if (obj.tag === "button") acc.push(obj);
		for (const v of Object.values(obj)) collectButtons(v, acc);
	}
	return acc;
}

test("命令卡片声明 schema 2.0（按钮需 behaviors 回调）", () => {
	for (const card of [
		welcomeCard("测试"),
		commandPanelCard(),
		statusCard("connected", []),
	]) {
		assert.equal((card as Json).schema, "2.0");
	}
	// setup/error 卡片本来就是 schema 1.0（config + 顶层 elements）。
	for (const card of [setupCard("https://x", 300), errorCard("oops")]) {
		assert.equal((card as Json).schema, "2.0");
	}
});

test("markdownCard 用 schema 2.0（与命令卡片一致）", () => {
	const card = markdownCard("**hi**") as Json;
	assert.equal(card.schema, "2.0");
	const body = card.body as Json;
	const elements = body.elements as Array<{ tag: string; content: string }>;
	assert.equal(elements[0]?.tag, "markdown");
	assert.equal(elements[0]?.content, "**hi**");
});

test("卡片不含 tag:action 容器（schema 2.0 已移除该能力，200861）", () => {
	const cards = [
		welcomeCard("测试"),
		commandPanelCard(),
		statusCard("connected", []),
	];
	let actionCount = 0;
	const walk = (n: unknown): void => {
		if (Array.isArray(n)) return n.forEach(walk);
		if (n && typeof n === "object") {
			const obj = n as Json;
			if (obj.tag === "action") actionCount++;
			Object.values(obj).forEach(walk);
		}
	};
	cards.forEach(walk);
	assert.equal(actionCount, 0, "schema 2.0 卡片不得包含 action 容器");
});

test("按钮直接平铺在 body.elements 且带 behaviors callback + width fill", () => {
	const card = welcomeCard("测试") as Json;
	const body = card.body as Json;
	const elements = body.elements as Json[];
	const buttons = elements.filter((e) => e.tag === "button");
	assert.ok(buttons.length >= 3, `welcome 卡应有按钮，实际 ${buttons.length}`);
	for (const b of buttons) {
		assert.equal(b.width, "fill", "按钮撑满宽度防截断");
		const behaviors = b.behaviors as Array<{ type: string; value: Json }>;
		assert.ok(
			behaviors[0]?.type === "callback",
			"按钮用 behaviors callback 回传",
		);
		assert.ok(typeof behaviors[0]?.value?.op === "string", "回传值含 op");
	}
});

test("按钮 op 路由到期望的命令", () => {
	const card = commandPanelCard() as Json;
	const body = card.body as Json;
	const buttons = collectButtons(body);
	const ops = buttons.map(
		(b) => (b.behaviors as Array<{ value: Json }>)[0]!.value.op as string,
	);
	assert.ok(ops.includes("status"));
	assert.ok(ops.includes("stop"));
	assert.ok(ops.includes("doctor"));
	assert.ok(ops.includes("lark-config"));
});

test("button helper: primary/danger 样式", () => {
	const primary = button(
		"批准",
		{ op: "approve", approvalId: "a1" },
		"primary",
	) as Json;
	assert.equal(primary.type, "primary");
	const danger = button(
		"拒绝",
		{ op: "deny", approvalId: "a1" },
		"danger",
	) as Json;
	assert.equal(danger.type, "danger");
	const plain = button("状态", { op: "status" }) as Json;
	assert.equal(plain.type, undefined);
});

test("modeCard 无名单时回退到官方 4 个模式", () => {
	const card = modeCard() as Json;
	const body = card.body as Json;
	const md = body.elements as Array<{ tag: string; content: string }>;
	const text = md.find((e) => e.tag === "markdown")!.content;
	for (const label of ["标准模式", "PTC 模式", "极简模式", "创造模式"]) {
		assert.ok(text.includes(label), `官方模式 ${label} 应出现在回退卡片`);
	}
});

test("modeCard 渲染动态名单（含自定义与不可用标注）", () => {
	const card = modeCard("aaa", [
		{ id: "standard", label: "标准模式", trust: "system" },
		{ id: "aaa", label: "AAA 模式", trust: "user", desc: "示例描述" },
		{ id: "bbb", label: "BBB 模式", trust: "user", broken: "示例原因" },
	]) as Json;
	const body = card.body as Json;
	const md = body.elements as Array<{ tag: string; content: string }>;
	const text = md.find((e) => e.tag === "markdown")!.content;
	assert.ok(text.includes("AAA 模式（自定义） ← 当前"), "自定义模式应标注并高亮当前");
	assert.ok(text.includes("（不可用：示例原因）"), "broken 模式应标注不可用原因");
	assert.ok(!text.includes("standard（自定义）"), "官方模式不应标自定义");
});

test("questionCard 单选：每选项一个按钮，op 形如 uqa:<id>:<index>", () => {
	const card = questionCard({
		id: "q1",
		question: "请选择",
		options: [{ label: "A" }, { label: "B" }],
	}) as Json;
	const body = card.body as Json;
	const buttons = collectButtons(body);
	const ops = buttons.map(
		(b) => (b.behaviors as Array<{ value: Json }>)[0]!.value.op as string,
	);
	assert.deepEqual(ops, ["uqa:q1:0", "uqa:q1:1"]);
});

test("questionCard 多选：form_container + multi_select_static + 提交/onSubmit 只能一次", () => {
	const card = questionCard({
		id: "q9",
		question: "可多选",
		options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
		multiSelect: true,
	}) as Json;
	assert.equal(card.schema, "2.0");
	const body = card.body as Json;
	const elements = body.elements as Json[];
	const form = elements.find((e) => e.tag === "form_container") as
		| Json
		| undefined;
	assert.ok(form, "多选应包含 form_container");
	const children = (form!.children ?? []) as Json[];
	const select = children.find((c) => c.tag === "multi_select_static") as
		| Json
		| undefined;
	assert.ok(select, "form_container 内应有 multi_select_static");
	assert.equal(select!.name, "answer");
	const opts = (select!.options ?? []) as Array<{ value: string }>;
	assert.deepEqual(
		opts.map((o) => o.value),
		["0", "1", "2"],
		"选项值应为 stringified 索引",
	);
	const onSubmit = (form!.onSubmit ?? []) as Array<{ type: string; value: Json }>;
	assert.equal(onSubmit[0]?.type, "callback");
	assert.equal(onSubmit[0]?.value?.op, "uqam:q9");
	// 多选卡片不应有立即提交的单选项按钮
	assert.equal(collectButtons(body).length, 0, "多选不渲染立即提交按钮");
});


// ---- /resume picker card ------------------------------------------------------

function resumeButtons(card: unknown): Array<{ behaviors?: Array<{ value?: Json }>; disabled?: boolean }> {
	const c = card as { body?: { elements?: unknown[] } };
	return (c.body?.elements ?? []).filter(
		(e): e is { behaviors?: Array<{ value?: Json }>; disabled?: boolean } =>
			(e as { tag?: string }).tag === "button",
	);
}

test("resumeCard: button ops ENCODE the session id so colons survive card-action splitting", () => {
	const card = resumeCard(
		[
			{ id: "lark-link:dm:oc_x:nonce1:0", createdAt: Date.now() - 60_000 },
			{ id: "7c9e067f-abc", createdAt: Date.now() - 3_600_000 },
		],
		undefined,
		{ now: () => 2_000_000_000_000 },
	);
	const ops = resumeButtons(card).map(
		(b) => (b.behaviors?.[0]?.value as { op?: string })?.op ?? "",
	);
	assert.equal(ops.length, 2);
	assert.equal(ops[0], "resume:lark-link~1dm~1oc_x~1nonce1~10".replaceAll("~1", "%3A"));
	assert.equal(ops[1], "resume:7c9e067f-abc");
});

test("resumeCard: relative times, titles, current-session row disabled, empty state", () => {
	const now = Date.now();
	const card = resumeCard(
		[
			{ id: "s1", createdAt: now - 5 * 60_000, title: "重构卡片流式" },
			{ id: "s2", createdAt: now - 3 * 86400_000, title: "修复频控" },
		],
		"s2",
		{ now: () => now },
	);
	const buttons = resumeButtons(card) as Array<{
		text?: { content?: string };
		behaviors?: Array<{ value?: Json }>;
		disabled?: boolean;
	}>;
	assert.match(buttons[0]?.text?.content ?? "", /5 分钟前/);
	assert.match(buttons[0]?.text?.content ?? "", /重构卡片流式/);
	assert.match(buttons[1]?.text?.content ?? "", /3 天前/);
	assert.match(buttons[1]?.text?.content ?? "", /当前会话/);
	assert.match(buttons[1]?.text?.content ?? "", /修复频控/);
	// current session listed but its button disabled
	assert.equal(buttons[1]?.disabled, true, "current session row disabled");
	const texts = JSON.stringify(card);
	assert.match(texts, /当前/);


	const empty = resumeCard([], undefined, { now: () => now });
	assert.match(JSON.stringify(empty), /暂无历史会话/);
});
