import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	projectKeyOf,
	decodeSessionDirName,
	listWorkspaceSessions,
	extractTitleFromEvents,
} from "../../../src/sessions/workspace-sessions.ts";


// ---- projectKeyOf (DSH persistence 的目录编码，必须逐字对齐) -----------------

test("projectKey: matches the DSH session persistence encoding", () => {
	assert.equal(projectKeyOf("/home/zand/proj"), "--home-zand-proj--");
	assert.equal(projectKeyOf("/home/zand"), "--home-zand--");
	// 真实样本：~/.dsh/sessions/--home-zand-proj-dsh-lark-link--
	assert.equal(
		projectKeyOf("/home/zand/proj/dsh-lark-link"),
		"--home-zand-proj-dsh-lark-link--",
	);
});

test("projectKey: consecutive separators collapse; empty readable → root", () => {
	assert.equal(projectKeyOf("//a///b"), "--a-b--");
	assert.equal(projectKeyOf("///"), "--root--");
});

test("projectKey: windows drive and UNC paths encode separators the same way", () => {
	assert.equal(projectKeyOf("D:\\Users\\kitti\\ws"), "--D-Users-kitti-ws--");
	assert.equal(projectKeyOf("\\\\server\\share"), "--server-share--");
});

test("projectKey: unsafe characters use the ~XXXX escape", () => {
	// 空格 (0x20) → ~0020
	assert.equal(projectKeyOf("/a b"), "--a~0020b--");
});

// ---- decodeSessionDirName ----------------------------------------------------

test("decode: ~003A decodes back to ':' (lark-link session ids)", () => {
	assert.equal(
		decodeSessionDirName("lark-link~003Adm~003Aoc_x~003Anonce~003A0"),
		"lark-link:dm:oc_x:nonce:0",
	);
});

test("decode: plain names and literal tildes survive", () => {
	assert.equal(decodeSessionDirName("abc-123"), "abc-123");
	assert.equal(decodeSessionDirName("7c9e067f-1234"), "7c9e067f-1234");
});

// ---- listWorkspaceSessions: persistence-service source ------------------------

test("list: service source filters by cwd, excludes subagents, sorts desc", async () => {
	const persistence = {
		async list() {
			return [
				{
					id: "gui-newer",
					createdAt: 3000,
					cwd: "/ws/proj",
					agentPreset: "code",
				},
				{
					id: "gui-older",
					createdAt: 1000,
					cwd: "/ws/proj",
					agentPreset: "standard",
				},
				{ id: "other-ws", createdAt: 5000, cwd: "/elsewhere" },
				{
					id: "sub-agent",
					createdAt: 4000,
					cwd: "/ws/proj",
					origin: "subagent",
				},
				{ id: "excluded-current", createdAt: 2000, cwd: "/ws/proj" },
			];
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		persistence,
		exclude: ["excluded-current"],
	});
	assert.deepEqual(
		rows.map((r) => r.id),
		["gui-newer", "gui-older"],
	);
	assert.equal(rows[0]!.preset, "code");
	assert.equal(rows[0]!.source, "service");
});

test("list: service source caps to limit", async () => {
	const persistence = {
		async list() {
			return Array.from({ length: 25 }, (_, i) => ({
				id: `s${i}`,
				createdAt: i,
				cwd: "/ws/proj",
			}));
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		persistence,
		limit: 10,
	});
	assert.equal(rows.length, 10);
	assert.equal(rows[0]!.id, "s24", "newest first");
});

// ---- listWorkspaceSessions: filesystem-scan fallback --------------------------

test("list: scan fallback reads the workspace project dir, decodes ids, sorts by mtime", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-ws-list-"));
	const dir = join(root, projectKeyOf("/ws/proj"));
	mkdirSync(join(dir, "lark-link~003Adm~003Aoc_x~003An1~003A0"), {
		recursive: true,
	});
	mkdirSync(join(dir, "gui-uuid-2"), { recursive: true });
	mkdirSync(join(dir, "empty-no-log"), { recursive: true }); // 无日志 → 跳过
	// 另一个工作区（不该出现）
	mkdirSync(join(root, projectKeyOf("/other"), "stranger"), { recursive: true });
	writeFileSync(
		join(dir, "lark-link~003Adm~003Aoc_x~003An1~003A0", "session.jsonl.zstd"),
		"x",
	);
	writeFileSync(join(dir, "gui-uuid-2", "session.jsonl.zstd"), "x");
	writeFileSync(join(root, projectKeyOf("/other"), "stranger", "session.jsonl.zstd"), "x");
	// mtime: gui-uuid-2 更新 → 排最前
	const now = Date.now();
	const f1 = join(dir, "gui-uuid-2", "session.jsonl.zstd");
	const f2 = join(dir, "lark-link~003Adm~003Aoc_x~003An1~003A0", "session.jsonl.zstd");
	await new Promise((r) => setTimeout(r, 20));
	writeFileSync(f1, "newer");

	const rows = await listWorkspaceSessions({
		sessionsRoot: root,
		cwd: "/ws/proj",
	});
	assert.deepEqual(
		rows.map((r) => r.id),
		["gui-uuid-2", "lark-link:dm:oc_x:n1:0"],
	);
	assert.equal(rows[0]!.source, "scan");
	assert.ok(rows[0]!.createdAt >= rows[1]!.createdAt);
	rmSync(root, { recursive: true, force: true });
});

test("list: scan fallback with no sessions root returns []", async () => {
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent-root",
		cwd: "/ws/proj",
	});
	assert.deepEqual(rows, []);
});

test("list: service failure falls back to the filesystem scan", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-ws-list2-"));
	const dir = join(root, projectKeyOf("/ws/proj"));
	mkdirSync(join(dir, "only-one"), { recursive: true });
	writeFileSync(join(dir, "only-one", "session.jsonl.zstd"), "x");
	const persistence = {
		async list() {
			throw new Error("persistence down");
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: root,
		cwd: "/ws/proj",
		persistence,
	});
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.id, "only-one");
	assert.equal(rows[0]!.source, "scan");
	rmSync(root, { recursive: true, force: true });
});

test("extractTitleFromEvents: session/title event takes precedence over user/message", () => {
	const events = [
		{
			seq: 0,
			type: "user/message",
			data: {
				source: { kind: "user" },
				content: [{ type: "text", text: "First prompt text" }],
			},
		},
		{
			seq: 1,
			type: "session/title",
			data: { title: "Generated Session Title" },
		},
	];
	assert.equal(extractTitleFromEvents(events), "Generated Session Title");
});

test("extractTitleFromEvents: falls back to first human user message when no session/title", () => {
	const events = [
		{
			seq: 0,
			type: "user/message",
			data: {
				source: { kind: "user" },
				content: [{ type: "text", text: "帮我实现飞书机器人的流式卡片输出" }],
			},
		},
	];
	assert.equal(extractTitleFromEvents(events), "帮我实现飞书机器人的流式卡片输出");
});

test("list: inspect resolves titles from persistence events", async () => {
	const persistence = {
		async list() {
			return [{ id: "sess-1", createdAt: 1000, cwd: "/ws/proj" }];
		},
		async inspect(id: string) {
			if (id === "sess-1") {
				return {
					events: [
						{
							type: "user/message",
							data: {
								source: { kind: "user" },
								content: [{ type: "text", text: "测试会话标题提取" }],
							},
						},
					],
				};
			}
			return undefined;
		},
	};
	const rows = await listWorkspaceSessions({
		sessionsRoot: "/nonexistent",
		cwd: "/ws/proj",
		persistence,
	});
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.title, "测试会话标题提取");
});

