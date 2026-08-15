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
