// dsh-lark-link client half (browser). Reuses the DSH Web GUI entirely
// (spec §7): bridge sessions are native DSH sessions already rendered by the
// GUI. This client only adds bridge-specific surfaces:
//   - a sidebar footer action that toggles a status overlay
//   - a shell.overlay status panel (bridge health via ctx.remote)
// Loaded as /plugins/dsh-lark-link/client.js via the "dsh.client" manifest.
//
// Slot registration: `sidebar.footer.action` and `shell.overlay` are both
// `list` slots (declared by ui-sidebar / ui-layout). The `name` passed to
// `ctx.slots.register` MUST be the parent slot's name — the entry is
// identified by `id`. Inventing a fresh `name` throws "slot ... is not
// declared (a parent entry's children table must declare it)" because no
// parent ever declared it.

import type { Context } from "@deepseek-ai/cordis";

// React is a shared runtime dep of dsh-client-web; the host ModuleLoader
// resolves it via the closure-factory `require` param (createRequire over the
// config-tree baseUrl). Never bundled — see tsdown.config.ts client externals.
// Typed by the minimal surface we use; react ships no bundled types here.
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
export const inject = ["slots", "connection", "remote"];

export interface ClientContext extends Context {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(
			opts: { name: string; id: string; order?: number; label?: string },
			Component: (props?: unknown) => unknown,
		): () => void;
	};
	remote: {
		$call(method: string, ...args: unknown[]): Promise<unknown>;
		$on(event: string, fn: (payload: unknown) => void): () => void;
	};
}

// Browser globals (the client runs in the page realm; the shared tsconfig
// ships no DOM lib, so reach them structurally off globalThis).
const win = globalThis as unknown as {
	dispatchEvent(e: unknown): void;
	addEventListener(type: string, fn: (e: unknown) => void): void;
	removeEventListener(type: string, fn: (e: unknown) => void): void;
	CustomEvent: new (type: string) => unknown;
};

// Cross-entry toggle: the sidebar button and the shell overlay are separate
// slot registrations, but they share this module scope. A window event keeps
// them decoupled without a cross-entry store seat.
const TOGGLE_EVENT = "lark-link:toggle-panel";
const STATE_EVENT = "lark-link:state";

export function apply(ctx: ClientContext): void {
	const dispatch = (type: string): void =>
		win.dispatchEvent(new win.CustomEvent(type));

	// Sidebar footer action: compact button that toggles the status overlay.
	const SidebarButton = (): unknown =>
		h(
			"button",
			{
				type: "button",
				title: "Lark Link",
				onClick: () => dispatch(TOGGLE_EVENT),
				style: {
					display: "flex",
					alignItems: "center",
					gap: "6px",
					padding: "6px 10px",
					border: "1px solid rgba(255,255,255,.12)",
					borderRadius: "8px",
					background: "transparent",
					color: "inherit",
					cursor: "pointer",
					fontSize: "13px",
				},
			},
			"🪶",
			"Lark",
		);

	// Shell overlay: a small status card, opened by the sidebar action and by
	// host-pushed state changes. Best-effort fetch via ctx.remote — the host
	// half may not have registered "lark-link/status" yet, so degrade cleanly.
	const StatusPanel = (): unknown => {
		const [open, setOpen] = useState(false);
		const [status, setStatus] = useState<string>("连接中…");

		const refresh = (): void => {
			void ctx.remote.$call("lark-link/status").then(
				(s) =>
					setStatus(typeof s === "string" ? s : JSON.stringify(s, null, 2)),
				(e) =>
					setStatus(
						`状态不可用: ${e instanceof Error ? e.message : String(e)}`,
					),
			);
		};

		useEffect(() => {
			const onToggle = (): void => setOpen((v) => !v);
			const onState = (): void => {
				setOpen(true);
				refresh();
			};
			win.addEventListener(TOGGLE_EVENT, onToggle);
			win.addEventListener(STATE_EVENT, onState);
			return () => {
				win.removeEventListener(TOGGLE_EVENT, onToggle);
				win.removeEventListener(STATE_EVENT, onState);
			};
		}, []);

		useEffect(() => {
			if (open) refresh();
		}, [open]);

		if (!open) return null;
		return h(
			"div",
			{
				style: {
					position: "fixed",
					top: "16px",
					right: "16px",
					zIndex: 9999,
					minWidth: "280px",
					maxWidth: "360px",
					padding: "14px 16px",
					background: "rgba(24,26,32,.96)",
					color: "#e6e8eb",
					border: "1px solid rgba(255,255,255,.14)",
					borderRadius: "12px",
					boxShadow: "0 12px 40px rgba(0,0,0,.45)",
					pointerEvents: "auto",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: "12px",
					lineHeight: 1.5,
				},
			},
			h(
				"div",
				{
					style: {
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: "8px",
					},
				},
				h("strong", { style: { fontSize: "13px" } }, "Lark Link"),
				h(
					"button",
					{
						type: "button",
						onClick: () => setOpen(false),
						style: {
							background: "transparent",
							border: "none",
							color: "#9aa0a6",
							cursor: "pointer",
							fontSize: "16px",
							lineHeight: 1,
						},
						title: "关闭",
					},
					"×",
				),
			),
			h(
				"pre",
				{
					style: { margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" },
				},
				status,
			),
		);
	};

	ctx.slots.inject("sidebar.footer.action", () =>
		ctx.slots.register(
			{
				name: "sidebar.footer.action",
				id: "lark-link-entry",
				order: 100,
				label: "Lark Link",
			},
			SidebarButton,
		),
	);

	ctx.slots.inject("shell.overlay", () =>
		ctx.slots.register(
			{
				name: "shell.overlay",
				id: "lark-link-status",
				order: 100,
				label: "Lark Link Status",
			},
			StatusPanel,
		),
	);

	// Host-pushed bridge state changes → fan out as a window event the panel
	// listens for. Remote events are optional; a missing emitter is harmless.
	ctx.remote.$on("lark-link/state", () => dispatch(STATE_EVENT));
}
