// Shared domain types for the Lark Link bridge. Harness-agnostic: no DSH and
// no Feishu SDK imports in this file.

/** Feishu message types we care about. */
export type FeishuMsgType = "text" | "post" | "image" | "file" | "audio" | "interactive" | "unknown";

export type ChatType = "p2p" | "group";
export type ChatMode = "group_at" | "group_all" | "p2p";

/** Normalized inbound message (v2.0 event structure collapsed). */
export interface FeishuInboundMessage {
  messageId: string;
  chatId: string;
  chatType: ChatType;
  chatMode: ChatMode;
  senderOpenId: string;
  /** Bot-internal open id, e.g. ou_… for p2p; oc_… for group chat. */
  senderOpenIdInternal?: string;
  msgType: FeishuMsgType;
  content: string;
  /** Resolved human-readable text (interactive cards flattened). */
  text?: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  mentions: string[];
  timestamp: number;
}

/** Outbound envelope kinds routed by the OutboundRouter. */
export type EnvelopeKind =
  | "final" // settled assistant/message — the durable reply
  | "assistant-output" // raw assistant text (stream finalize fallback)
  | "tool" // tool progress notification
  | "notify" // bridge-generated notice (status, connect, errors)
  | "command-reply" // bridge command result
  | "scheduled" // scheduled task result
  | "media"; // file/image upload

/** Route target — persisted in routes.json (30d). */
export interface Route {
  sessionKey: string;
  sessionId?: string;
  chatId: string;
  chatType: ChatType;
  threadMessageId?: string;
  lastMessageId?: string;
  updatedAt: number;
}

/** A single durable outbound envelope. */
export interface OutboundEnvelope {
  id: string;
  dedupeKey: string;
  laneKey: string;
  route: RouteRef;
  kind: EnvelopeKind;
  payload: EnvelopePayload;
  status: "pending" | "sending" | "done" | "failed" | "fatal";
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
  updatedAt: number;
  /** Payload spilled to a blob file when too large. */
  blobRef?: string;
  error?: string;
}

/** Minimal route reference kept inside each envelope (snapshot at enqueue). */
export interface RouteRef {
  sessionKey: string;
  chatId: string;
  chatType: ChatType;
  threadMessageId?: string;
}

export type EnvelopePayload =
  | { kind: "text"; text: string; card?: unknown }
  | { kind: "card"; card: unknown; text?: string }
  | { kind: "media"; fileKey: string; type: "image" | "file"; caption?: string }
  | { kind: "reaction"; messageId: string; emojiType: string };

/** Inbound dedupe record. */
export interface DedupeRecord {
  messageId: string;
  at: number;
}

/**
 * One agent preset a bridge session can run on, as surfaced by DSH's
 * agentPresets service. Harness-agnostic mirror of the roster row: the DSH
 * adapter maps its `AgentPreset` onto this shape, and the memory backend
 * simulates it, so the presentation layer never touches DSH types.
 */
export interface AgentPresetOption {
  /** Stable id (the preset directory name); also the /mode argument. */
  id: string;
  /** Display label; falls back to `id` when the preset publishes none. */
  label: string;
  /** One sentence on what the preset is for. */
  desc?: string;
  /** 'system' ships with DSH; 'user' was authored locally. */
  trust?: "system" | "user";
  /** Why this preset cannot compose a session (absent = usable). */
  broken?: string;
}

/** Connection state machine. */
export type ConnState = "idle" | "connecting" | "connected" | "degraded" | "reconnecting" | "quarantined" | "stopped";

/** Public bridge status snapshot (rendered by status-formatter). */
export interface BridgeStatus {
  connState: ConnState;
  connectedAt?: number;
  lastProbeAt?: number;
  lastProbeOk?: boolean;
  outboxPending: number;
  outboxFailed: number;
  /** Accepted-but-undelivered inbound requests awaiting (possible) replay — a
   *  crash/restart mid-turn re-triggers these. Zero when everything answered. */
  inboundPending: number;
  sessions: number;
  quarantinedUntil?: number;
  quarantinedReason?: string;
  lastError?: string;
  wsReady: boolean;
  owner?: { pid: number; host: string; startedAt: number };
}
