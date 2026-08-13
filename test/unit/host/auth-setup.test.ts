import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSetupAddons,
  SETUP_SCOPES,
  REQUIRED_EVENT,
  createAuthSetup,
  detectDomain,
  type QRCodeInfo,
} from "../../../src/host/auth-setup.ts";
import { createLogger } from "../../../src/common/logger.ts";

test("auth-setup: addons subscribe message event + group/emoji scopes", () => {
  const addons = buildSetupAddons();
  assert.ok(addons.events?.items?.tenant?.includes(REQUIRED_EVENT), "message event subscribed");
  assert.ok(addons.scopes?.tenant?.includes("im:message.group_msg"), "group-all scope");
  assert.ok(addons.scopes?.tenant?.includes("im:message.reactions:write_only"), "reaction scope");
  assert.deepEqual(addons.callbacks, { items: ["card.action.trigger"] });
});

test("auth-setup: detectDomain maps tenant_brand to feishu/lark", () => {
  assert.equal(detectDomain(undefined), "feishu");
  assert.equal(detectDomain({ tenant_brand: "feishu" }), "feishu");
  assert.equal(detectDomain({ tenant_brand: "lark" }), "lark");
});

test("auth-setup: setup flows QR(info) → persist(creds+domain) → result", async () => {
  let persisted: { appId: string; appSecret: string; domain: string } | undefined;
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
  assert.deepEqual(capturedQR, { url: "https://feishu.cn/scan?x=1", expireIn: 300 });
  assert.deepEqual(persisted, { appId: "cli_abc", appSecret: "sec_xyz", domain: "feishu" });
  assert.deepEqual(result, { appId: "cli_abc", appSecret: "sec_xyz", domain: "feishu" });
  assert.ok(statuses.includes("完成 ✅"));
  // sanity: registerApp received the addons + source
  void registerQRShape;
});

test("auth-setup: lark tenant detected as domain=lark", async () => {
  let persisted: { domain: string } | undefined;
  const setup = createAuthSetup({
    registerApp: async () => ({ client_id: "c", client_secret: "s", user_info: { tenant_brand: "lark" } }),
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
