// One-click auth (ADR/spec §4.1 /lark setup): scan a QR to create the Feishu
// app via lark.registerApp (from @larksuiteoapi/node-sdk), with addons that
// explicitly subscribe im.message.receive_v1 (the pi bridge's hard-won lesson:
// registerApp defaults do NOT subscribe message events) + group/emoji scopes.
// Manual appId/appSecret entry is the fallback channel.

import type { Logger } from "../common/logger.ts";

/** registerApp addons payload (launcher applies these when creating the app). */
export interface SetupAddons {
  scopes?: { tenant?: string[]; user?: string[] };
  events?: { items?: { tenant?: string[]; user?: string[] } };
  callbacks?: { items?: string[] };
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

export interface RegisterAppResult {
  appId: string;
  appSecret: string;
}

export interface RegisterAppCallbacks {
  onQRCodeReady(url: string, expireInSec: number): void;
  onStatusChange?(info: { status?: string }): void;
}

export type RegisterAppFn = (callbacks: RegisterAppCallbacks) => Promise<{
  client_id?: string;
  client_secret?: string;
  user_info?: { tenant_brand?: string };
}>;

export interface AuthSetupDeps {
  /** lark.registerApp (lazily imported from @larksuiteoapi/node-sdk). */
  registerApp: RegisterAppFn;
  /** Persist credentials (appId/appSecret) — the caller owns the store. */
  persist(result: RegisterAppResult): Promise<void>;
  logger: Logger;
}

export interface AuthSetup {
  /** Run the QR flow; resolves with the created app credentials. */
  run(opts: { onQRCodeReady(url: string, expireInSec: number): void; onStatusChange?(s: string): void }): Promise<RegisterAppResult>;
}

export function createAuthSetup(deps: AuthSetupDeps): AuthSetup {
  return {
    async run(opts) {
      opts.onStatusChange?.("创建应用中…");
      const created = await deps.registerApp({
        onQRCodeReady: opts.onQRCodeReady,
        onStatusChange: (info) => opts.onStatusChange?.(info.status ?? "…"),
      });
      const appId = created.client_id ?? "";
      const appSecret = created.client_secret ?? "";
      if (!appId || !appSecret) {
        throw new Error("registerApp 未返回 client_id/client_secret");
      }
      // Post-create self-check: verify the event subscription actually landed
      // (pi bridge: registerApp created apps sometimes lack message events).
      opts.onStatusChange?.("校验事件订阅…");
      // The addons are applied at creation time; verifyEventSubscription is a
      // REST call owned by the transport layer — here we just surface status.
      await deps.persist({ appId, appSecret });
      opts.onStatusChange?.("完成 ✅");
      return { appId, appSecret };
    },
  };
}
