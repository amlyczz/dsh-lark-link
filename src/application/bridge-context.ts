// BridgeContext: the assembled dependency container (dependency inversion).
// All application-layer services receive this interface — never concrete
// modules. CRITICAL (pi-feishu-link 01f978a lesson): mutable dependencies
// are read through GETTERS — never construction-time snapshots. The host
// assembles an instance, wires late-bound services via setters, then passes
// the context around.

import type { FeishuConfig, ConfigStore } from "../common/config.ts";
import type { Logger } from "../common/logger.ts";
import type { StatusStore } from "../common/connection-status.ts";
import type { ConversationManager } from "../sessions/conversation-manager.ts";
import type { DshSessionBackend } from "../sessions/dsh-session-backend.ts";
import type { Outbox } from "../outbound/outbox.ts";
import type { EventForwarder } from "../outbound/event-forwarder.ts";
import type { RouteStore } from "../outbound/outbound-router.ts";
import type { Transport } from "../inbound/transport.ts";
import type { MissedCompensation } from "../inbound/missed-compensation.ts";
import type { FeishuInboundMessage, Route } from "../common/types.ts";

/** Sender abstraction: how the bridge actually writes to Feishu. */
export interface FeishuSender {
  replyTo(msg: FeishuInboundMessage, textOrCard: string | unknown): Promise<void>;
  sendText(chatId: string, text: string): Promise<unknown>;
  sendCard(chatId: string, card: unknown): Promise<unknown>;
  addReaction(messageId: string, emojiType: string): Promise<void>;
  sendFile(chatId: string, fileKey: string, type: "image" | "file"): Promise<unknown>;
  listMessages(params: { chatId: string; startTimeMs: number; endTimeMs: number }): Promise<Array<{ messageId: string; timestampMs: number }>>;
}

/** DSH image-attachment service surface (ctx.attachments). */
export interface ImageAttachmentService {
  saveImage(input: {
    data: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    name?: string;
  }): Promise<{
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    name?: string;
  }>;
}

export interface BridgeContextDeps {
  logger: Logger;
  cfg: () => FeishuConfig;
  configStore?: ConfigStore;
  status: StatusStore;
  backend?: DshSessionBackend;
  router?: RouteStore;
  sender?: FeishuSender;
  /** DSH attachment store (ctx.attachments) — for inbound image blocks. */
  attachments?: ImageAttachmentService;
}

/** Read-side surface used by application services. */
export interface BridgeContextRead {
  get conversations(): ConversationManager | undefined;
  get backend(): DshSessionBackend | undefined;
  get transport(): Transport | undefined;
  get outbox(): Outbox | undefined;
  get router(): RouteStore | undefined;
  get forwarder(): EventForwarder | undefined;
  get compensation(): MissedCompensation | undefined;
  get sender(): FeishuSender | undefined;
  get attachments(): ImageAttachmentService | undefined;
  get logger(): Logger;
  get cfg(): () => FeishuConfig;
  get configStore(): ConfigStore | undefined;
  get status(): StatusStore;
  botOpenId(): string | undefined;
  started(): boolean;
  conversationKeyFor(msg: FeishuInboundMessage): string;
  routeFor(key: string): Route | undefined;
  markDone(key: string, triggerMessageId?: string): Promise<void>;
}

/** Write-side surface used by the host (index.ts). */
export interface BridgeContextWrite {
  setConversations(v: ConversationManager | undefined): void;
  setTransport(v: Transport | undefined): void;
  setOutbox(v: Outbox | undefined): void;
  setForwarder(v: EventForwarder | undefined): void;
  setCompensation(v: MissedCompensation | undefined): void;
  setBotOpenId(v: string | undefined): void;
  setStarted(v: boolean): void;
}

export type BridgeContext = BridgeContextRead & BridgeContextWrite;

export function createBridgeContext(deps: BridgeContextDeps): BridgeContext {
  let _conversations: ConversationManager | undefined;
  let _transport: Transport | undefined;
  let _outbox: Outbox | undefined;
  let _forwarder: EventForwarder | undefined;
  let _compensation: MissedCompensation | undefined;
  let _botOpenId: string | undefined;
  let _started = false;

  return {
    get conversations() {
      return _conversations;
    },
    setConversations(v) {
      _conversations = v;
    },
    get backend() {
      return deps.backend;
    },
    get transport() {
      return _transport;
    },
    setTransport(v) {
      _transport = v;
    },
    get outbox() {
      return _outbox;
    },
    setOutbox(v) {
      _outbox = v;
    },
    get router() {
      return deps.router;
    },
    get forwarder() {
      return _forwarder;
    },
    setForwarder(v) {
      _forwarder = v;
    },
    get compensation() {
      return _compensation;
    },
    setCompensation(v) {
      _compensation = v;
    },
    get sender() {
      return deps.sender;
    },
    get attachments() {
      return deps.attachments;
    },
    get logger() {
      return deps.logger;
    },
    get cfg() {
      return deps.cfg;
    },
    get configStore() {
      return deps.configStore;
    },
    get status() {
      return deps.status;
    },
    botOpenId: () => _botOpenId,
    setBotOpenId(v) {
      _botOpenId = v;
    },
    started: () => _started,
    setStarted(v) {
      _started = v;
    },
    conversationKeyFor: (msg) =>
      msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`,
    routeFor(key) {
      return deps.router?.get(key);
    },
    async markDone(key, triggerMessageId) {
      if (!triggerMessageId || !deps.sender) return;
      const doneEmoji = deps.cfg().reactions.done || "DONE";
      try {
        await deps.sender.addReaction(triggerMessageId, doneEmoji);
      } catch {
        deps.logger.warn(`markDone reaction failed for ${key}`);
      }
    },
  };
}
