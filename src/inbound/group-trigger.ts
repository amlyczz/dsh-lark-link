// Group trigger policy (群策略): decides whether a group-chat message should
// trigger the bot. open / mention / keywords / reply. Config is read through
// a getter so hot reload (ADR-13) takes effect immediately. Harness-agnostic
// pure module. Ported from pi-feishu-link's group-trigger.ts (open/mention/
// keyword/alsoOnReply stack from pi-feishu-lark).

import type { FeishuInboundMessage } from "../common/types.ts";
import type { GroupPolicy } from "../common/config.ts";

export interface GroupTriggerCfg {
  policy: GroupPolicy;
  keywords: string[];
  alsoOnReply: boolean;
}

export interface GroupTriggerDeps {
  /** Config getter — called per message (hot-reload friendly). */
  cfg: () => GroupTriggerCfg;
  /** Bot's own open id (to detect self-mentions); getter for late wiring. */
  botOpenId?: () => string | undefined;
}

export interface GroupTrigger {
  /** True when the group message should reach the agent. */
  shouldTrigger(msg: FeishuInboundMessage): boolean;
}

export function createGroupTrigger(deps: GroupTriggerDeps): GroupTrigger {
  return {
    shouldTrigger(msg) {
      if (msg.chatType !== "group") return true; // p2p always triggers
      const { policy, keywords, alsoOnReply } = deps.cfg();
      const botOpenId = deps.botOpenId?.();
      const isReplyToBot = msg.parentId !== undefined || msg.rootId !== undefined;
      switch (policy) {
        case "open":
          return true; // all group messages
        case "mention": {
          if (botOpenId !== undefined && msg.mentions.includes(botOpenId)) return true;
          if (msg.mentions.length > 0 || msg.chatMode === "group_at") return true;
          // alsoOnReply: trigger when the bot's own message was replied to.
          return alsoOnReply && isReplyToBot;
        }
        case "keywords":
          if (keywords.some((k) => (msg.text ?? "").includes(k))) return true;
          return alsoOnReply && isReplyToBot;
        case "reply":
          return isReplyToBot;
        default:
          return false;
      }
    },
  };
}
