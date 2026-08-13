// dsh-lark-link client half (browser). Reuses the DSH Web GUI entirely
// (spec §7): bridge sessions are native DSH sessions already rendered by the
// GUI. This client adds one bridge-specific surface — a sidebar footer action
// button that opens a self-contained popover showing the setup QR + commands.
//
// Why a host-served QR image (not a base64 data URL or an in-result markdown
// image): the GUI markdown image sanitizer only allows http(s) (data: URLs
// are dropped), and a plugin can't push to the client over ctx.remote. So the
// host serves the active setup QR as a PNG at /plugins/lark-link/qr and this
// panel loads it with a plain <img>. We control this render site, so the QR
// reliably shows; polling with a cache-buster picks it up once /lark setup runs.
//
// Slot registration: `sidebar.footer.action` is a `list` slot (declared by
// ui-sidebar). The `name` passed to `ctx.slots.register` MUST be the parent
// slot's name; the entry is identified by `id`. The component owns its own
// open/close state (no cross-entry event coupling). The popover is
// position:fixed so it escapes any sidebar overflow:hidden ancestor.

import type { Context } from "@deepseek-ai/cordis";

// React is a shared runtime dep of dsh-client-web; the host ModuleLoader
// resolves it via the closure-factory `require` param. Never bundled — see
// tsdown.config.ts client externals.
type ReactApi = {
	createElement: (
		type: unknown,
		props?: Record<string, unknown> | null,
		...children: unknown[]
	) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
};
const R = require("react") as ReactApi;
const { createElement: h, useState, useEffect } = R;

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

const win = globalThis as unknown as {
	location?: { origin?: string };
};

const COMMANDS: ReadonlyArray<{ cmd: string; desc: string }> = [
	{ cmd: "/lark setup", desc: "扫码建应用（面板显示二维码）" },
	{ cmd: "/lark start", desc: "启动桥接" },
	{ cmd: "/lark stop", desc: "停止（保留凭据/配置）" },
	{ cmd: "/lark restart", desc: "重启" },
	{ cmd: "/lark status", desc: "全链路健康视图" },
	{ cmd: "/lark uninstall-clean", desc: "清凭据 + 清状态目录（不可逆）" },
];

export function apply(ctx: ClientContext): void {
	// Sidebar footer action: a single self-contained component — button +
	// position:fixed popover. All state is local, so the click always works.
	const SidebarAction = (): unknown => {
		const [open, setOpen] = useState<boolean>(false);
		const [qrTs, setQrTs] = useState<number>(0);
		const [qrLoaded, setQrLoaded] = useState<boolean>(false);

		// While open, refresh the QR image every few seconds so it appears as
		// soon as /lark setup generates one (and re-fetches a fresh one on retry).
		useEffect(() => {
			if (!open) return;
			setQrTs(Date.now());
			const id = setInterval(() => setQrTs(Date.now()), 4000);
			return () => clearInterval(id);
		}, [open]);

		const origin = win.location?.origin ?? "";
		const qrSrc = qrTs ? `${origin}/plugins/lark-link/qr?t=${qrTs}` : "";

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

		// Single img drives load detection; hidden (but still fetched) until it
		// loads, so onLoad/onError toggle the visible QR vs. the setup hint.
		const qrImg = h("img", {
			src: qrSrc,
			alt: "Lark Link setup QR",
			onError: () => setQrLoaded(false),
			onLoad: () => setQrLoaded(true),
			style: {
				width: "220px",
				height: "220px",
				display: qrLoaded ? "block" : "none",
				margin: "0 auto",
			},
		});
		const qrHint = qrLoaded
			? null
			: h(
					"div",
					{ style: { textAlign: "center", opacity: 0.7, padding: "10px 0" } },
					"（暂无二维码）在输入框运行 ",
					h("code", { style: { color: "#7fd1ff" } }, "/lark setup"),
					" 生成。",
				);

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
					maxHeight: "80vh",
					overflow: "auto",
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
			qrImg,
			qrHint,
			h(
				"div",
				{ style: { marginTop: "12px", marginBottom: "6px", opacity: 0.8 } },
				"命令（在输入框输入）：",
			),
			h("div", null, ...rows),
			h(
				"div",
				{ style: { marginTop: "10px", opacity: 0.6, fontSize: "11px" } },
				"扫码确认后凭据自动写入，运行 /lark start 即可端到端连通。",
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
