// CommandRouter: the three-tier command dispatch (ADR-7, spec §4.2):
//   1. bridge-specific commands (/status /support /lark-config …) → bridge
//   2. DSH-registered commands → native handler({agent, rawInput})
//   3. everything else (plugin commands, /skill:x, unknown /xxx, plain text)
//      → injected verbatim into the agent
// No blocked commands, no admin gates (user decision: 无审批, 全放开).

import type { FeishuInboundMessage } from "../common/types.ts";
import type { BridgeContextRead } from "./bridge-context.ts";

export interface DshCommandRegistry {
  /** Look up a registered command handler by name for the agent (no leading slash). */
  has(name: string, agentId?: string): boolean;
  run(name: string, rawInput: string, agentId: string): Promise<{ kind: string; text?: string }>;
}

export interface CommandRouterDeps {
  ctx: BridgeContextRead;
  commands: DshCommandRegistry;
  /** Handle a bridge-specific command; returns handled=true when consumed. */
  bridgeHandler(name: string, rawInput: string, msg: FeishuInboundMessage): Promise<boolean>;
}

export interface CommandRouter {
  /** Route an inbound message (or its text) through the tiers. */
  route(msg: FeishuInboundMessage): Promise<"bridge" | "dsh" | "agent" | "skipped">;
  /** True when the message starts with a slash. */
  isCommand(text: string): boolean;
}

const BRIDGE_COMMANDS = new Set(["status", "workspace", "stop", "support", "doctor", "sessions", "lark-config", "help", "feishu-config"]);

export function createCommandRouter(deps: CommandRouterDeps): CommandRouter {
  return {
    isCommand(text) {
      return /^\//.test(text.trim());
    },
    async route(msg) {
      const text = (msg.text ?? msg.content ?? "").trim();
      if (text === "") return "skipped";
      if (!this.isCommand(text)) return "agent"; // plain message → agent

      // Tier 1: bridge-specific
      const tokens = text.split(/\s+/);
      const head = tokens[0] ?? "";
      const cmdName = head.replace(/^\/+/, "").toLowerCase();
      const rawInput = tokens.slice(1).join(" ");
      if (BRIDGE_COMMANDS.has(cmdName) || cmdName === "lark") {
        const handled = await deps.bridgeHandler(cmdName, rawInput, msg);
        return handled ? "bridge" : "agent";
      }

      // Tier 2: DSH-registered commands (native handler, no model round-trip)
      const agent = deps.ctx.backend?.get(deps.ctx.conversationKeyFor(msg));
      const agentId = agent?.agentId ?? "";
      if (agentId && deps.commands.has(cmdName, agentId)) {
        try {
          const result = await deps.commands.run(cmdName, rawInput, agentId);
          const key = deps.ctx.conversationKeyFor(msg);
          if (result.kind === "success" && result.text) {
            await deps.ctx.outbox?.enqueue({
              dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
              laneKey: key,
              route: { sessionKey: key, chatId: msg.chatId, chatType: msg.chatType },
              kind: "command-reply",
              payload: { kind: "text", text: result.text },
            });
          } else if (result.kind === "error" && result.text) {
            await deps.ctx.outbox?.enqueue({
              dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
              laneKey: key,
              route: { sessionKey: key, chatId: msg.chatId, chatType: msg.chatType },
              kind: "command-reply",
              payload: { kind: "text", text: `⚠️ ${result.text}` },
            });
          }
          return "dsh";
        } catch {
          return "agent"; // handler failed — fall through to the agent
        }
      }

      // Tier 3: everything else passes verbatim to the agent
      return "agent";
    },
  };
}
