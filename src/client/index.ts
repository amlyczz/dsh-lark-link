// dsh-lark-link client half (browser). Reuses the DSH Web GUI entirely
// (spec §7): bridge sessions are native DSH sessions already rendered by the
// GUI. This client adds one bridge-specific surface — a sidebar footer action
// button that opens a self-contained quick-reference popover.
//
// Slot registration: `sidebar.footer.action` is a `list` slot (declared by
// ui-sidebar). The `name` passed to `ctx.slots.register` MUST be the parent
// slot's name; the entry is identified by `id`. The component owns its own
// open/close state — no second registration, no cross-entry event coupling
// (those were the click-does-nothing failure modes). The popover is
// position:fixed so it escapes any sidebar overflow:hidden ancestor.
//
// ctx.remote is a generated facade over fixed host contributions (commands /
// goals / inventory / …) — a plugin can't register an arbitrary
// `lark-link/status` method — so the popover shows static command help
// instead of attempting an RPC that would always reject. Live status lives
// in the composer via `/lark status`.

import type { Context } from "@deepseek-ai/cordis";

// React is a shared runtime dep of dsh-client-web; the host ModuleLoader
// resolves it via the closure-factory `require` param (createRequire over the
// config-tree baseUrl). Never bundled — see tsdown.config.ts client externals.
type ReactApi = {
	createElement: (
		type: unknown,
		props?: Record<string, unknown> | null,
		...children: unknown[]
	) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
};
const R = require("react") as ReactApi;
const { createElement: h, useState } = R;

export const name = "dsh-lark-link-client";
export const inject = ["slots"];

export interface ClientContext extends Context {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(
			opts: { name: string; id: string; order?: number; label?: string },
			Component: (props?: unknown) => unknown,
		): () => void;
	};
}

const COMMANDS: ReadonlyArray<{ cmd: string; desc: string }> = [
	{ cmd: "/lark setup", desc: "扫码建应用（或 DSH_LARK_APP_ID/SECRET 环境变量手动）" },
	{ cmd: "/lark start", desc: "启动桥接" },
	{ cmd: "/lark stop", desc: "停止（保留凭据/配置）" },
	{ cmd: "/lark restart", desc: "重启" },
	{ cmd: "/lark status", desc: "全链路健康视图" },
	{ cmd: "/lark uninstall-clean", desc: "清凭据 + 清状态目录（不可逆）" },
];

export function apply(ctx: ClientContext): void {
	// Sidebar footer action: a single self-contained component — button +
	// position:fixed popover. All state is local, so the click always works
	// regardless of whether any other surface mounts.
	const SidebarAction = (): unknown => {
		const [open, setOpen] = useState<boolean>(false);

		const button = h(
			"button",
			{
				type: "button",
				title: "Lark Link",
				onClick: () => setOpen((v) => !v),
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "6px",
					padding: "6px 10px",
					border: "1px solid rgba(127,127,127,.25)",
					borderRadius: "8px",
					background: open ? "rgba(127,127,127,.18)" : "transparent",
					color: "inherit",
					cursor: "pointer",
					fontSize: "13px",
					lineHeight: 1,
				},
			},
			"🪶",
			"Lark",
		);

		if (!open) return button;

		// position:fixed escapes sidebar overflow clipping; floats over the app.
		const rows = COMMANDS.map((c) =>
			h(
				"div",
				{ style: { display: "flex", gap: "10px", padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,.06)" } },
				h("code", { style: { color: "#7fd1ff", flex: "0 0 150px" } }, c.cmd),
				h("span", { style: { opacity: 0.8 } }, c.desc),
			),
		);

		const panel = h(
			"div",
			{
				style: {
					position: "fixed",
					top: "12px",
					right: "12px",
					zIndex: 2147483000,
					minWidth: "320px",
					maxWidth: "400px",
					padding: "14px 16px",
					background: "rgba(24,26,32,.97)",
					color: "#e6e8eb",
					border: "1px solid rgba(255,255,255,.16)",
					borderRadius: "12px",
					boxShadow: "0 16px 48px rgba(0,0,0,.5)",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: "12px",
					lineHeight: 1.5,
				},
			},
			h(
				"div",
				{ style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" } },
				h("strong", { style: { fontSize: "13px" } }, "🪶 Lark Link"),
				h(
					"button",
					{
						type: "button",
						onClick: () => setOpen(false),
						style: { background: "transparent", border: "none", color: "#9aa0a6", cursor: "pointer", fontSize: "16px", lineHeight: 1 },
						title: "关闭",
					},
					"×",
				),
			),
			h(
				"div",
				{ style: { marginBottom: "8px", opacity: 0.8 } },
				"飞书/Lark ↔ DeepSeek Harness 桥接。在输入框输入命令：",
			),
			h("div", null, ...rows),
			h(
				"div",
				{ style: { marginTop: "10px", opacity: 0.6, fontSize: "11px" } },
				"实时状态用 /lark status；发消息到飞书机器人即可端到端连通。",
			),
		);

		return h("div", null, button, panel);
	};

	ctx.slots.inject("sidebar.footer.action", () =>
		ctx.slots.register(
			{ name: "sidebar.footer.action", id: "lark-link-entry", order: 100, label: "Lark Link" },
			SidebarAction,
		),
	);
}
