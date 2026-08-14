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
import { gzipSync } from "node:zlib";

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

// ---------------------------------------------------------------------------
// Fetch-based registerApp (device-code flow) — replaces the SDK's registerApp.
// The SDK's defaultHttpInstance uses axios, whose 1.19.x `default.default`
// entry (index.js → lib/axios.js) mis-resolves platform in Node ESM and
// drives https URLs through http.request → "Protocol \"https:\" not
// supported. Expected \"http:\"" under Node ≥18. The flow below replicates
// the SDK wire protocol (RFC 8628 device code) with the global fetch.
// ---------------------------------------------------------------------------

/** base64url(gzip(addons)) — matches the SDK's encodeAddons encoding. */
export function encodeAddons(addons: SetupAddons): string {
	const json = JSON.stringify(addons);
	return gzipSync(Buffer.from(json, "utf8"))
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

async function postForm(
	url: string,
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				"User-Agent": "dsh-lark-link (device-code client)",
			},
			body: new URLSearchParams(params).toString(),
			signal,
		});
	} catch (err) {
		throw new Error(
			`registration request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let data: Record<string, unknown>;
	try {
		data = (await res.json()) as Record<string, unknown>;
	} catch {
		data = {};
	}
	// The device-code flow reports in-band errors via HTTP 400 bodies — surface
	// them (like the SDK's axios path), not as transport failures.
	if (!res.ok && !data.error) {
		throw new Error(`registration request failed: HTTP ${res.status}`);
	}
	return data;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Registration was aborted"));
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = (): void => {
			cleanup();
			reject(new Error("Registration was aborted"));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * registerApp implementation over global fetch. Wire protocol mirrors
 * @larksuiteoapi/node-sdk's registerApp (device-code flow against
 * accounts.feishu.cn / accounts.larksuite.com), so the QR and created-app
 * payload are byte-compatible with the SDK path.
 */
export function registerAppWithFetch(): RegisterAppFn {
	return async (options) => {
		const { source, signal, onQRCodeReady, onStatusChange, addons } = options;
		const baseUrl = "https://accounts.feishu.cn";
		const larkBaseUrl = "https://accounts.larksuite.com";
		const endpoint = "/oauth/v1/app/registration";

		const beginRes = await postForm(
			baseUrl + endpoint,
			{
				action: "begin",
				archetype: "PersonalAgent",
				auth_method: "client_secret",
				request_user_info: "open_id",
			},
			signal,
		);
		const verificationUri = beginRes.verification_uri_complete;
		if (typeof verificationUri !== "string" || verificationUri === "") {
			throw new Error(
				(beginRes.error_description as string) ??
					"registerApp begin 未返回 verification_uri_complete",
			);
		}
		let qrUrl: URL;
		try {
			qrUrl = new URL(verificationUri);
		} catch {
			throw new Error(
				`registerApp begin 返回了无效的 verification_uri_complete: ${verificationUri.slice(0, 80)}`,
			);
		}
		qrUrl.searchParams.set("from", "sdk");
		qrUrl.searchParams.set("source", `node-sdk/${source}`);
		qrUrl.searchParams.set("tp", "sdk");
		if (addons) qrUrl.searchParams.set("addons", encodeAddons(addons));

		onQRCodeReady({
			url: qrUrl.toString(),
			expireIn: (beginRes.expires_in as number | undefined) ?? 600,
		});

		// Poll for the scan (RFC 8628 device-code flow).
		const deviceCode = beginRes.device_code as string | undefined;
		if (!deviceCode) throw new Error("registerApp begin 未返回 device_code");
		let currentBase = baseUrl;
		let interval = ((beginRes.interval as number | undefined) ?? 5) * 1000;
		const deadline = Date.now() + ((beginRes.expires_in as number | undefined) ?? 600) * 1000;
		let domainSwitched = false;

		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("Registration was aborted");
			const pollRes = await postForm(
				currentBase + endpoint,
				{ action: "poll", device_code: deviceCode },
				signal,
			);
			const userInfo = pollRes.user_info as
				| { tenant_brand?: string }
				| undefined;
			// Lark (international) domain switch — once only, like the SDK.
			if (userInfo?.tenant_brand === "lark" && !domainSwitched) {
				currentBase = larkBaseUrl;
				domainSwitched = true;
				onStatusChange?.({ status: "domain_switched" });
				continue;
			}
			const clientId = pollRes.client_id as string | undefined;
			const clientSecret = pollRes.client_secret as string | undefined;
			if (clientId && clientSecret) {
				return {
					client_id: clientId,
					client_secret: clientSecret,
					user_info: userInfo,
				};
			}
			switch (pollRes.error) {
				case "authorization_pending":
					onStatusChange?.({ status: "polling" });
					break;
				case "slow_down":
					interval += 5000;
					onStatusChange?.({
						status: "slow_down",
						interval: interval / 1000,
					} as unknown as { status?: string });
					break;
				case "access_denied":
				case "expired_token":
					throw new Error(
						(pollRes.error_description as string | undefined) ??
							`注册失败：${String(pollRes.error)}`,
					);
				default:
					if (pollRes.error) {
						throw new Error(
							(pollRes.error_description as string | undefined) ??
								`注册失败：${String(pollRes.error)}`,
						);
					}
					break;
			}
			await sleep(interval, signal);
		}
		throw new Error("注册轮询超时（二维码已过期），请重新运行 /lark setup");
	};
}
