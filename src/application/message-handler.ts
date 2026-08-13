// MessageHandler: inbound orchestration (handleInbound + handleConversation).
// Pipeline: dedupe → allowlist → group trigger → reaction receipt → route →
// command router → conversation manager. NO fire-and-forget: every branch is
// awaited and failures are logged (pi-feishu-link lesson #4).

import type { FeishuInboundMessage } from "../common/types.ts";
import type { BridgeContextRead } from "./bridge-context.ts";
import type { CommandRouter } from "./command-router.ts";
import { createReactionPicker } from "../common/reactions.ts";

export interface MessageHandlerDeps {
  ctx: BridgeContextRead;
  commands: CommandRouter;
  groupTrigger: { shouldTrigger(msg: FeishuInboundMessage): boolean };
  /** Inbound dedupe: add returns false when already seen. */
  dedupe: { add(messageId: string): boolean };
  /** Owner allowlist getter (empty = all allowed); hot-reload friendly. */
  allowlist: () => string[];
  /** Called when a message was reinjected by missed-compensation. */
  onReinjected?: (msg: FeishuInboundMessage) => void;
}

export interface MessageHandler {
  handleInbound(msg: FeishuInboundMessage): Promise<"processed" | "dropped">;
  /** Compensation replay path (skipDedupe semantics handled by caller). */
  handleCompensated(msg: FeishuInboundMessage): Promise<void>;
}

export function createMessageHandler(deps: MessageHandlerDeps): MessageHandler {
  const logger = deps.ctx.logger;

  async function handle(msg: FeishuInboundMessage, compensated: boolean): Promise<"processed" | "dropped"> {
    // 1. dedupe (skip for compensation replay)
    if (!compensated && !deps.dedupe.add(msg.messageId)) {
      logger.info(`drop: duplicate ${msg.messageId}`);
      return "dropped";
    }
    // 2. allowlist (live getter — hot reload honored per message)
    const allowlist = deps.allowlist();
    if (allowlist.length > 0 && !allowlist.includes(msg.senderOpenId)) {
      logger.info(`drop: sender ${msg.senderOpenId} not in allowlist`);
      return "dropped";
    }
    // 3. group trigger
    if (!deps.groupTrigger.shouldTrigger(msg)) {
      logger.info(`drop: group policy for ${msg.chatId}`);
      return "dropped";
    }
    // 4. reaction receipt (random pool, never DONE) — picker built from live cfg
    const reactions = deps.ctx.cfg().reactions;
    if (reactions.enabled) {
      const picker = createReactionPicker(reactions.pool, reactions.done);
      const pick = picker.pickRandom();
      if (pick) {
        try {
          await deps.ctx.sender?.addReaction(msg.messageId, pick);
        } catch {
          logger.warn(`receipt reaction failed for ${msg.messageId}`);
        }
      }
    }
    // 5. command routing (bridge / dsh / agent)
    const route = await deps.commands.route(msg);
    if (route === "agent") {
      const cm = deps.ctx.conversations;
      if (!cm) {
        logger.error("message dropped: conversations not assembled (late wiring?)");
        return "dropped";
      }
      // Establish/refresh the delivery route (sessionKey → chatId) so the
      // event forwarder can route the agent's reply back to this Feishu chat.
      // Without this the forwarder drops every reply (routeFor → undefined).
      const sessionKey = cm.keyFor(msg);
      deps.ctx.router?.upsert({
        sessionKey,
        chatId: msg.chatId,
        chatType: msg.chatType,
        updatedAt: Date.now(),
      });
      try {
        await cm.handleMessage(msg);
      } catch (err) {
        logger.error(`conversation handling failed: ${String(err)}`);
        return "dropped";
      }
    }
    if (compensated) deps.onReinjected?.(msg);
    return "processed";
  }

  return {
    async handleInbound(msg) {
      return handle(msg, false);
    },
    async handleCompensated(msg) {
      await handle(msg, true);
    },
  };
}
