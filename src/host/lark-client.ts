// Credential resolution + Feishu SDK client adapter (spec §3 L0 host).
//
// Credentials (appId/appSecret/domain) live ONLY in ctx.credentials, stored as
// a JSON blob under a single ref key (config.credentialRef, default
// "LARK_LINK_APP"). The ref must match ^[A-Za-z_][A-Za-z0-9_]*$ (no dots) per
// the credentials service. The config.json carries only the ref, never the
// secret.
//
// buildLarkClient wraps @larksuiteoapi/node-sdk's Client + WSClient +
// EventDispatcher into the harness-agnostic FeishuClientLike shape the
// transport/sender already consume. The SDK is loaded via an injectable
// sdkLoader so the adapter is unit-testable without the real SDK.

import type { FeishuClientLike } from "../inbound/transport.ts";
import type { Logger } from "../common/logger.ts";

export type LarkDomain = "feishu" | "lark";

export interface LarkCredentials {
	appId: string;
	appSecret: string;
	domain: LarkDomain;
}

/** Minimal credential-store seam — ctx.credentials satisfies this. */
export interface CredentialsStore {
	resolve(ref: string): Promise<{ value: string } | undefined>;
	set(ref: string, value: string): Promise<void>;
	unset(ref: string): Promise<void>;
}

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidRef(ref: string): boolean {
	return REF_PATTERN.test(ref);
}

/** Parse the stored JSON blob into credentials; undefined if absent/malformed. */
export function parseCredentials(
	raw: string | undefined,
): LarkCredentials | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Partial<LarkCredentials>;
		if (parsed.appId && parsed.appSecret) {
			return {
				appId: parsed.appId,
				appSecret: parsed.appSecret,
				domain: parsed.domain === "lark" ? "lark" : "feishu",
			};
		}
	} catch {
		// malformed blob → treat as unconfigured
	}
	return undefined;
}

export async function resolveCredentials(
	store: CredentialsStore,
	ref: string,
): Promise<LarkCredentials | undefined> {
	const resolved = await store.resolve(ref);
	return parseCredentials(resolved?.value);
}

export async function persistCredentials(
	store: CredentialsStore,
	ref: string,
	creds: LarkCredentials,
): Promise<void> {
	if (!isValidRef(ref))
		throw new TypeError(
			`credential ref "${ref}" must match ${String(REF_PATTERN)}`,
		);
	await store.set(ref, JSON.stringify(creds));
}

export async function clearCredentials(
	store: CredentialsStore,
	ref: string,
): Promise<void> {
	await store.unset(ref);
}

// ---- SDK adapter -----------------------------------------------------------

/** Structural slice of @larksuiteoapi/node-sdk we depend on. */
export interface LarkSdk {
	Client: new (opts: Record<string, unknown>) => SdkClient;
	WSClient: new (opts: Record<string, unknown>) => SdkWsClient;
	EventDispatcher: new (opts: Record<string, unknown>) => SdkDispatcher;
	AppType: { SelfBuild: number };
	Domain: { Feishu: unknown; Lark: unknown };
	LoggerLevel: { error: number };
	/** SDK's shared axios instance (response-unwrapping interceptors included). */
	defaultHttpInstance?: { defaults?: { proxy?: boolean } };
}

export interface SdkClient {
	request(opts: Record<string, unknown>): Promise<unknown>;
	im: {
		message: {
			create(opts: Record<string, unknown>): Promise<unknown>;
			reply(opts: Record<string, unknown>): Promise<unknown>;
			list(opts: Record<string, unknown>): Promise<unknown>;
		};
		messageReaction: {
			create(opts: Record<string, unknown>): Promise<unknown>;
		};
		file: {
			create(opts: Record<string, unknown>): Promise<unknown>;
			get?(opts: Record<string, unknown>): Promise<{
				getReadableStream?(): unknown;
				writeFile?(path: string): Promise<string>;
			}>;
		};
		image: {
			create(opts: Record<string, unknown>): Promise<unknown>;
			get?(opts: Record<string, unknown>): Promise<{
				getReadableStream?(): unknown;
				writeFile?(path: string): Promise<string>;
			}>;
		};
	};
}

export interface SdkWsClient {
	start(opts: { eventDispatcher: SdkDispatcher }): unknown;
	stop?(): unknown;
}

export interface SdkDispatcher {
	register(map: Record<string, (data: unknown) => unknown>): SdkDispatcher;
}

export type SdkLoader = () => Promise<LarkSdk> | LarkSdk;

/** Default loader: dynamic import of the real SDK (kept out of test paths). */
export const defaultSdkLoader: SdkLoader = async (): Promise<LarkSdk> =>
	(await import("@larksuiteoapi/node-sdk")) as unknown as LarkSdk;

export interface BuildLarkClientOptions {
	appId: string;
	appSecret: string;
	domain: LarkDomain;
	logger?: Logger;
	sdkLoader?: SdkLoader;
}

/** Extract a key from SDK responses that may be top-level or nested under data. */
function pick<T>(res: unknown, key: string): T | undefined {
	const r = res as Record<string, unknown> | undefined;
	const direct = r?.[key];
	if (direct !== undefined) return direct as T;
	const nested = (r?.data as Record<string, unknown> | undefined)?.[key];
	return nested as T | undefined;
}

/**
 * Build a FeishuClientLike backed by the real SDK. Event handlers attach via
 * `.on()` (forwarded to the EventDispatcher); `ws.start()` boots the WSClient
 * with that dispatcher; send/probe/upload calls translate to SDK shapes.
 */
export async function buildLarkClient(
	opts: BuildLarkClientOptions,
): Promise<FeishuClientLike> {
	const sdk = await (opts.sdkLoader ?? defaultSdkLoader)();
	const domain = opts.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu;
	// The SDK's shared axios instance follows http_proxy/https_proxy env vars;
	// with a proxy set, axios routes https URLs through http.request and dies
	// with "Protocol \"https:\" not supported. Expected \"http:\"" under
	// Node ≥18. Feishu endpoints are direct — disable proxy on the SDK's own
	// instance (which carries the response unwrap interceptors the SDK relies
	// on; a hand-built axios instance would break {code,data,msg} parsing).
	const dh = sdk.defaultHttpInstance as
		| { defaults?: { proxy?: boolean } }
		| undefined;
	if (dh?.defaults) dh.defaults.proxy = false;
	const clientOpts = {
		appId: opts.appId,
		appSecret: opts.appSecret,
		appType: sdk.AppType.SelfBuild,
		domain,
		loggerLevel: sdk.LoggerLevel.error,
	};

	const sdkClient = new sdk.Client(clientOpts);
	const dispatcher = new sdk.EventDispatcher({
		loggerLevel: sdk.LoggerLevel.error,
	});
	const wsClient = new sdk.WSClient(clientOpts);

	const client: FeishuClientLike = {
		on(event, handler) {
			dispatcher.register({ [event]: handler as (data: unknown) => unknown });
		},
		ws: {
			start() {
				try {
					wsClient.start({ eventDispatcher: dispatcher });
				} catch (err) {
					opts.logger?.error(
						`wsClient.start failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
			stop() {
				void Promise.resolve(wsClient.stop?.()).catch(() => undefined);
			},
		},
		async getBotInfo() {
			const res = (await sdkClient.request({
				url: "/open-apis/bot/v3/info",
				method: "GET",
			})) as Record<string, unknown> | undefined;
			const bot =
				(res?.bot as Record<string, unknown> | undefined) ??
				((res?.data as Record<string, unknown> | undefined)?.bot as
					| Record<string, unknown>
					| undefined);
			const openId =
				(bot?.open_id as string | undefined) ??
				((res?.data as Record<string, unknown> | undefined)?.open_id as
					| string
					| undefined);
			return { open_id: openId, name: bot?.app_name as string | undefined };
		},
		async sendMessage(params) {
			// sender shape: { receive_id_type, params: { receive_id, msg_type, content } }
			const p = params as {
				receive_id_type: string;
				params: Record<string, unknown>;
			};
			return sdkClient.im.message.create({
				params: { receive_id_type: p.receive_id_type },
				data: p.params,
			});
		},
		async addReaction(params) {
			const p = params as { message_id: string; emoji_type: string };
			return sdkClient.im.messageReaction.create({
				path: { message_id: p.message_id },
				data: { reaction_type: { emoji_type: p.emoji_type } },
			});
		},
		async listMessages(params) {
			const p = params as {
				container_id_type: string;
				container_id: string;
				start_time: string;
				end_time: string;
			};
			const res = (await sdkClient.im.message.list({
				params: { ...p, page_size: 50 },
			})) as Record<string, unknown> | undefined;
			const items =
				(res?.items as Array<Record<string, unknown>> | undefined) ??
				((res?.data as Record<string, unknown> | undefined)?.items as
					| Array<Record<string, unknown>>
					| undefined) ??
				[];
			return {
				items: items.map((i) => ({
					message_id: i.message_id as string | undefined,
					create_time: i.create_time as string | undefined,
				})),
			};
		},
		async uploadFile(params) {
			const p = params as {
				file_type: string;
				file_name?: string;
				file: Buffer;
			};
			// SDK im.v1.file.create expects data: {file_type, file_name, file}
			// (multipart) — passing a bare Buffer 400s (code 9499).
			return sdkClient.im.file.create({
				data: {
					file_type: p.file_type,
					file_name: p.file_name ?? "file",
					file: p.file,
				},
			}) as Promise<{ file_key?: string } | { data?: { file_key?: string } }>;
		},
		async uploadImage(params) {
			const p = params as { image: Buffer };
			// SDK im.v1.image.create expects data: {image_type, image}.
			return sdkClient.im.image.create({
				data: { image_type: "message", image: p.image },
			}) as Promise<{ image_key?: string } | { data?: { image_key?: string } }>;
		},
		async downloadResource(params) {
			const p = params as {
				messageId: string;
				fileKey: string;
				type: "image" | "file";
			};
			// im/v1/messages/:message_id/resources/:file_key returns a binary
			// stream; drain it into a Buffer for the attachment pipeline.
			const res = (await sdkClient.request({
				url: `/open-apis/im/v1/messages/${p.messageId}/resources/${p.fileKey}`,
				method: "GET",
				params: { type: p.type },
				responseType: "stream",
			})) as { getReadableStream?: () => NodeJS.ReadableStream } | undefined;
			const stream = res?.getReadableStream?.();
			if (!stream)
				throw new Error(`downloadResource: no stream for ${p.fileKey}`);
			const chunks: Buffer[] = [];
			for await (const chunk of stream as AsyncIterable<Uint8Array>) {
				chunks.push(Buffer.from(chunk));
			}
			return Buffer.concat(chunks);
		},
	};

	// `pick` referenced for parity with future shape variance; harmless no-op pin.
	void pick;
	return client;
}
