// NotificationService: bridge-generated notices to owner/conversation via the
// outbox (so notifications survive restarts too). Harness-agnostic.

import type { BridgeContextRead } from "./bridge-context.ts";

export interface NotificationDeps {
  ctx: BridgeContextRead;
  /** Default chat to notify (owner's private chat, recorded on first message). */
  ownerChatId?: () => string | undefined;
}

export interface NotificationService {
  notifyOwner(text: string): Promise<void>;
  notifyConversation(key: string, text: string): Promise<void>;
  notifyChat(chatId: string, text: string): Promise<void>;
}

export function createNotificationService(deps: NotificationDeps): NotificationService {
  const enqueue = (chatId: string | undefined, laneKey: string, text: string): Promise<void> => {
    if (!chatId) return Promise.resolve();
    const outbox = deps.ctx.outbox;
    if (!outbox) return Promise.resolve();
    outbox.enqueue({
      dedupeKey: `notify:${laneKey}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      laneKey,
      route: { sessionKey: laneKey, chatId, chatType: chatId.startsWith("oc_") ? "group" : "p2p" },
      kind: "notify",
      payload: { kind: "text", text },
    });
    return Promise.resolve();
  };

  return {
    notifyOwner(text) {
      const chatId = deps.ownerChatId?.();
      return enqueue(chatId, "owner", text);
    },
    notifyConversation(key, text) {
      const route = deps.ctx.routeFor(key);
      return enqueue(route?.chatId, key, text);
    },
    notifyChat(chatId, text) {
      return enqueue(chatId, `chat:${chatId}`, text);
    },
  };
}
