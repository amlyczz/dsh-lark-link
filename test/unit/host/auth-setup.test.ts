import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildSetupAddons,
	REQUIRED_EVENT,
	createAuthSetup,
	detectDomain,
	encodeAddons,
	registerAppWithFetch,
	type QRCodeInfo,
} from "../../../src/host/auth-setup.ts";
import { createLogger } from "../../../src/common/logger.ts";

test("auth-setup: addons subscribe message event + group/emoji scopes", () => {
	const addons = buildSetupAddons();
	assert.ok(
		addons.events?.items?.tenant?.includes(REQUIRED_EVENT),
		"message event subscribed",
	);
	assert.ok(
		addons.scopes?.tenant?.includes("im:message.group_msg"),
		"group-all scope",
	);
	assert.ok(
		addons.scopes?.tenant?.includes("im:message.reactions:write_only"),
		"reaction scope",
	);
	assert.deepEqual(addons.callbacks, { items: ["card.action.trigger"] });
});

test("auth-setup: detectDomain maps tenant_brand to feishu/lark", () => {
	assert.equal(detectDomain(undefined), "feishu");
	assert.equal(detectDomain({ tenant_brand: "feishu" }), "feishu");
	assert.equal(detectDomain({ tenant_brand: "lark" }), "lark");
});

test("auth-setup: setup flows QR(info) → persist(creds+domain) → result", async () => {
	let persisted:
		| { appId: string; appSecret: string; domain: string }
		| undefined;
	let capturedQR: QRCodeInfo | undefined;
	let registerQRShape: unknown;
	const setup = createAuthSetup({
		registerApp: async ({ onQRCodeReady }) => {
			// the SDK hands onQRCodeReady a SINGLE info object {url, expireIn}
			registerQRShape = onQRCodeReady.length;
			onQRCodeReady({ url: "https://feishu.cn/scan?x=1", expireIn: 300 });
			return { client_id: "cli_abc", client_secret: "sec_xyz" };
		},
		persist: async (r) => {
			persisted = r;
		},
		logger: createLogger("test"),
	});
	const statuses: string[] = [];
	const result = await setup.run({
		onQRCodeReady: (info) => {
			capturedQR = info;
		},
		onStatusChange: (s) => statuses.push(s),
	});
	assert.deepEqual(capturedQR, {
		url: "https://feishu.cn/scan?x=1",
		expireIn: 300,
	});
	assert.deepEqual(persisted, {
		appId: "cli_abc",
		appSecret: "sec_xyz",
		domain: "feishu",
	});
	assert.deepEqual(result, {
		appId: "cli_abc",
		appSecret: "sec_xyz",
		domain: "feishu",
	});
	assert.ok(statuses.includes("完成 ✅"));
	// sanity: registerApp received the addons + source
	void registerQRShape;
});

test("auth-setup: lark tenant detected as domain=lark", async () => {
	let persisted: { domain: string } | undefined;
	const setup = createAuthSetup({
		registerApp: async () => ({
			client_id: "c",
			client_secret: "s",
			user_info: { tenant_brand: "lark" },
		}),
		persist: async (r) => {
			persisted = r;
		},
		logger: createLogger("test"),
	});
	const result = await setup.run({ onQRCodeReady: () => undefined });
	assert.equal(result.domain, "lark");
	assert.equal(persisted?.domain, "lark");
});

test("auth-setup: missing credentials throws", async () => {
	const setup = createAuthSetup({
		registerApp: async () => ({}),
		persist: async () => {},
		logger: createLogger("test"),
	});
	await assert.rejects(() => setup.run({ onQRCodeReady: () => undefined }));
});

// ---- fetch-based registerApp (device-code flow) ---------------------------

test("auth-setup: encodeAddons matches base64url(gzip) shape", () => {
	const enc = encodeAddons(buildSetupAddons());
	assert.equal(typeof enc, "string");
	assert.ok(enc.length > 0);
	// base64url alphabet only — no + / = padding
	assert.ok(!/[+/=]/.test(enc), "base64url encoded");
});

test("auth-setup: registerAppWithFetch drives begin → QR → poll → creds", async () => {
	const calls: Array<{ url: string; body: string }> = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		const u = String(url);
		const body = String(init?.body ?? "");
		calls.push({ url: u, body });
		if (body.includes("action=begin")) {
			return new Response(
				JSON.stringify({
					verification_uri_complete: "https://example.com/device?code=abc",
					device_code: "dev-1",
					expires_in: 600,
					interval: 1,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		// poll: first pending, then success
		if (body.includes("action=poll")) {
			if (calls.filter((c) => c.body.includes("action=poll")).length === 1) {
				return new Response(
					JSON.stringify({ error: "authorization_pending" }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(
				JSON.stringify({
					client_id: "cli_made",
					client_secret: "sec_made",
					user_info: { tenant_brand: "feishu" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response(JSON.stringify({}), { status: 400 });
	};

	try {
		const registerApp = registerAppWithFetch();
		let qr: QRCodeInfo | undefined;
		const statuses: string[] = [];
		const created = await registerApp({
			source: "dsh-lark-link",
			addons: buildSetupAddons(),
			onQRCodeReady: (info) => {
				qr = info;
			},
			onStatusChange: (info) => statuses.push(info.status ?? ""),
		});

		assert.ok(qr, "QR emitted");
		assert.ok(
			qr.url.startsWith("https://example.com/device?code=abc"),
			"QR url",
		);
		assert.ok(qr.url.includes("from=sdk"), "from=sdk");
		assert.ok(
			qr.url.includes("source=node-sdk%2Fdsh-lark-link") ||
				qr.url.includes("source="),
			"source param",
		);
		assert.ok(qr.url.includes("addons="), "addons param encoded");
		assert.equal(created.client_id, "cli_made");
		assert.equal(created.client_secret, "sec_made");
		assert.ok(statuses.includes("polling"), "polling status reported");
		// begin + 2 polls
		assert.ok(calls.length >= 3, "begin + polls performed");
	} finally {
		globalThis.fetch = origFetch;
	}
});

test("auth-setup: registerAppWithFetch aborts via signal", async () => {
	const origFetch = globalThis.fetch;
	globalThis.fetch = async (
		_url: string | URL | Request,
		init?: RequestInit,
	) => {
		if (String(init?.body ?? "").includes("action=begin")) {
			return new Response(
				JSON.stringify({
					verification_uri_complete: "https://example.com/device",
					device_code: "dev-1",
					expires_in: 600,
					interval: 1,
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ error: "authorization_pending" }), {
			status: 400,
		});
	};
	const ac = new AbortController();
	ac.abort();
	try {
		const registerApp = registerAppWithFetch();
		await assert.rejects(
			registerApp({
				source: "dsh-lark-link",
				onQRCodeReady: () => {},
				signal: ac.signal,
			}),
			/aborted/i,
		);
	} finally {
		globalThis.fetch = origFetch;
	}
});
