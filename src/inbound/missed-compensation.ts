// Missed-message compensation (ADR: 断连补偿): after WS recovery, pull the
// messages that arrived while disconnected and re-inject them (with real
// chat_id — the 400 fix — and skipDedupe so replay is not dropped).
// Harness-agnostic.

import type { FeishuInboundMessage } from "../common/types.ts";
import type { RouteStore } from "../outbound/outbound-router.ts";

export interface CompensationDeps {
  routes: RouteStore;
  /** List messages in a chat after a cursor (Feishu REST). */
  listMessages(params: {
    chatId: string;
    startTimeMs: number;
    endTimeMs: number;
  }): Promise<Array<{ messageId: string; timestampMs: number }>>;
  /** Re-inject a missed message into the inbound pipeline. */
  reinject(msg: FeishuInboundMessage): Promise<void>;
  now?: () => number;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export interface MissedCompensation {
  /** Called when the connection recovers. */
  onRecovered(): Promise<void>;
  /** Record a delivered message id so compensation can skip it. */
  noteDelivered(messageId: string): void;
}

/** Replay window: pull messages from the last N minutes of disconnection. */
export const REPLAY_WINDOW_MS = 10 * 60_000;

export function createMissedCompensation(deps: CompensationDeps): MissedCompensation {
  const now = deps.now ?? Date.now;
  const delivered = new Set<string>();
  const maxTracked = 5000;

  return {
    noteDelivered(messageId) {
      delivered.add(messageId);
      if (delivered.size > maxTracked) {
        // drop oldest — approximation: clear half
        const arr = [...delivered];
        delivered.clear();
        for (const id of arr.slice(-maxTracked / 2)) delivered.add(id);
      }
    },
    async onRecovered() {
      const until = now();
      const since = until - REPLAY_WINDOW_MS;
      let pulled = 0;
      for (const route of deps.routes.all()) {
        try {
          const items = await deps.listMessages({
            chatId: route.chatId,
            startTimeMs: since,
            endTimeMs: until,
          });
          for (const item of items) {
            if (delivered.has(item.messageId)) continue;
            deps.reinject({
              messageId: item.messageId,
              chatId: route.chatId,
              chatType: route.chatType,
              chatMode: route.chatType === "p2p" ? "p2p" : "group_at",
              senderOpenId: "unknown", // compensation can't always resolve sender
              msgType: "text",
              content: "",
              text: "",
              mentions: [],
              timestamp: item.timestampMs,
            });
            delivered.add(item.messageId);
            pulled++;
          }
        } catch (err) {
          deps.logger?.warn(`compensation listMessages failed for ${route.chatId}: ${String(err)}`);
        }
      }
      if (pulled > 0) deps.logger?.info(`compensation re-injected ${pulled} missed messages`);
    },
  };
}
