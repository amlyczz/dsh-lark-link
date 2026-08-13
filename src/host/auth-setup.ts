// One-click auth (ADR/spec §4.1 /lark setup): scan a QR to create the Feishu
// app via lark.registerApp (from @larksuiteoapi/node-sdk), with addons that
// explicitly subscribe im.message.receive_v1 (the pi bridge's hard-won lesson:
// registerApp defaults do NOT subscribe message events) + group/emoji scopes.
// Manual appId/appSecret entry is the fallback channel.
//
// SDK signature (verified against @larksuiteoapi/node-sdk types):
//   registerApp({ source, addons, onQRCodeReady(info:{url,expireIn}),
//                 onStatusChange?(info), appId? }) → { client_id, client_secret, user_info? }

import type { Logger } from "../common/logger.ts";
import type { LarkDomain, LarkCredentials } from "./lark-client.ts";

/** registerApp addons payload (the launcher applies these when creating the app). */
export interface SetupAddons {
	preset?: boolean;
	scopes?: { tenant?: string[]; user?: string[] };
	events?: { items?: { tenant?: string[]; user?: string[] } };
	callbacks?: { items: string[] };
}

/** Bridge-required event subscription: message arrival. */
export const REQUIRED_EVENT = "im.message.receive_v1";
/** Bridge-dependent permission scopes (message + group-all + reactions). */
export const SETUP_SCOPES: readonly string[] = [
	"im:message",
	"im:message.send_as_bot",
	"im:chat",
	"im:resource",
	"im:message.group_msg", // all group messages (no @ required when policy=open)
	"im:message.reactions:write_only", // DONE / receipt reactions
] as const;

/** Pure function — unit-testable addon builder. */
export function buildSetupAddons(): SetupAddons {
	return {
		scopes: { tenant: [...SETUP_SCOPES] },
		events: { items: { tenant: [REQUIRED_EVENT] } },
		callbacks: { items: ["card.action.trigger"] },
	};
}

/** What the QR flow persists (appId/appSecret + detected domain). */
export type SetupResult = LarkCredentials;

export interface QRCodeInfo {
	url: string;
	expireIn: number;
}

/** Minimal structural type matching the SDK's registerApp function. */
export type RegisterAppFn = (options: {
	source?: string;
	addons?: SetupAddons;
	appId?: string;
	signal?: AbortSignal;
	onQRCodeReady: (info: QRCodeInfo) => void;
	onStatusChange?: (info: { status?: string }) => void;
}) => Promise<{
	client_id?: string;
	client_secret?: string;
	user_info?: { tenant_brand?: string };
}>;

export interface AuthSetupDeps {
	/** lark.registerApp (lazily imported from @larksuiteoapi/node-sdk). */
	registerApp: RegisterAppFn;
	/** Persist credentials — the caller owns the store (ctx.credentials). */
	persist(result: SetupResult): Promise<void>;
	logger: Logger;
}

export interface AuthSetup {
	/** Run the QR flow; resolves with the created app credentials. */
	run(opts: {
		onQRCodeReady(info: QRCodeInfo): void;
		onStatusChange?(status: string): void;
	}): Promise<SetupResult>;
}

/** Detect Lark (international) vs Feishu (China) from the registerApp result. */
export function detectDomain(
	userInfo: { tenant_brand?: string } | undefined,
): LarkDomain {
	return userInfo?.tenant_brand === "lark" ? "lark" : "feishu";
}

export function createAuthSetup(deps: AuthSetupDeps): AuthSetup {
	return {
		async run(opts) {
			opts.onStatusChange?.("创建应用中…");
			const created = await deps.registerApp({
				source: "dsh-lark-link",
				addons: buildSetupAddons(),
				onQRCodeReady: (info) => opts.onQRCodeReady(info),
				onStatusChange: (info) => opts.onStatusChange?.(info.status ?? "…"),
			});
			const appId = created.client_id ?? "";
			const appSecret = created.client_secret ?? "";
			if (!appId || !appSecret) {
				throw new Error("registerApp 未返回 client_id/client_secret");
			}
			const domain = detectDomain(created.user_info);
			// registerApp applies the addons (event subscription + scopes) at app
			// creation time; the transport later verifies im.message.receive_v1.
			opts.onStatusChange?.("校验事件订阅…");
			await deps.persist({ appId, appSecret, domain });
			opts.onStatusChange?.("完成 ✅");
			return { appId, appSecret, domain };
		},
	};
}
