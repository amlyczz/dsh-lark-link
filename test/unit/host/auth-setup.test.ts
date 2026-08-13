import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetupAddons, SETUP_SCOPES, REQUIRED_EVENT, createAuthSetup } from "../../../src/host/auth-setup.ts";
import { createLogger } from "../../../src/common/logger.ts";

test("auth-setup: addons subscribe message event + group/emoji scopes", () => {
  const addons = buildSetupAddons();
  assert.ok(addons.events?.items?.tenant?.includes(REQUIRED_EVENT), "message event subscribed");
  assert.ok(addons.scopes?.tenant?.includes("im:message.group_msg"), "group-all scope");
  assert.ok(addons.scopes?.tenant?.includes("im:message.reactions:write_only"), "reaction scope");
  assert.deepEqual(addons.callbacks, { items: ["card.action.trigger"] });
});

test("auth-setup: setup flows QR → persist → result", async () => {
  let persisted: { appId: string; appSecret: string } | undefined;
  let qrShown = false;
  const setup = createAuthSetup({
    registerApp: async ({ onQRCodeReady }) => {
      onQRCodeReady("https://feishu.cn/scan?x=1", 300);
      qrShown = true;
      return { client_id: "cli_abc", client_secret: "sec_xyz" };
    },
    persist: async (r) => {
      persisted = r;
    },
    logger: createLogger("test"),
  });
  const statuses: string[] = [];
  const result = await setup.run({
    onQRCodeReady: () => undefined,
    onStatusChange: (s) => statuses.push(s),
  });
  assert.equal(qrShown, true);
  assert.deepEqual(persisted, { appId: "cli_abc", appSecret: "sec_xyz" });
  assert.deepEqual(result, { appId: "cli_abc", appSecret: "sec_xyz" });
});

test("auth-setup: missing credentials throws", async () => {
  const setup = createAuthSetup({
    registerApp: async () => ({}),
    persist: async () => {},
    logger: createLogger("test"),
  });
  await assert.rejects(() => setup.run({ onQRCodeReady: () => undefined }));
});
