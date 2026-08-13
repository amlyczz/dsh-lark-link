// BridgeLifecycle: host-side assembly & teardown (spec §2.2 L0). Builds the
// BridgeContext, wires the transport/supervisor/outbox/forwarder, and exposes
// start/stop — all teardown is idempotent so Cordis `ctx.effect()` can call it
// on plugin unload. Harness-agnostic: every external dependency is injected.

import type { BridgeContext } from "../application/bridge-context.ts";
import type { FeishuConfig } from "../common/config.ts";
import type { Logger } from "../common/logger.ts";
import type { StatusStore } from "../common/connection-status.ts";
import type { Transport } from "../inbound/transport.ts";
import type { ConnectionSupervisor } from "../inbound/connection-supervisor.ts";
import type { Outbox } from "../outbound/outbox.ts";
import type { EventForwarder } from "../outbound/event-forwarder.ts";
import type { MissedCompensation } from "../inbound/missed-compensation.ts";
import type { ConversationManager } from "../sessions/conversation-manager.ts";
import type { FeishuInboundMessage } from "../common/types.ts";

export interface LifecycleDeps {
  ctx: BridgeContext;
  logger: Logger;
  status: StatusStore;
  /** Factories — the host provides the wired implementations. */
  makeTransport(): Transport;
  makeSupervisor(transport: Transport): ConnectionSupervisor;
  makeOutbox(): Outbox;
  makeForwarder(outbox: Outbox): EventForwarder;
  makeCompensation(): MissedCompensation;
  makeConversations(): ConversationManager;
  /** Send a reconnect signal to the transport's owner (WS-level). */
  onStart?(ctx: BridgeContext): Promise<void>;
  onStop?(ctx: BridgeContext): Promise<void>;
}

export interface BridgeLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  isStarted(): boolean;
  restart(): Promise<void>;
}

export function createLifecycle(deps: LifecycleDeps): BridgeLifecycle {
  let started = false;
  let supervisor: ConnectionSupervisor | undefined;

  async function start(): Promise<void> {
    if (started) return;
    deps.logger.info("bridge starting");

    // Late wiring via getters — never snapshots (pi 01f978a).
    const transport = deps.makeTransport();
    deps.ctx.setTransport(transport);

    const outbox = deps.makeOutbox();
    outbox.rebuildFromDisk();
    deps.ctx.setOutbox(outbox);
    deps.ctx.status.refreshCounters({ outboxPending: outbox.pendingCount(), outboxFailed: outbox.failedCount() });
    outbox.start();

    const forwarder = deps.makeForwarder(outbox);
    deps.ctx.setForwarder(forwarder);

    const compensation = deps.makeCompensation();
    deps.ctx.setCompensation(compensation);

    const conversations = deps.makeConversations();
    deps.ctx.setConversations(conversations);

    supervisor = deps.makeSupervisor(transport);
    await deps.onStart?.(deps.ctx);
    await supervisor.start();

    started = true;
    deps.ctx.setStarted(true);
    deps.status.setConn("connected");
    deps.logger.info("bridge started");
  }

  async function stop(): Promise<void> {
    if (!started) return;
    deps.logger.info("bridge stopping");
    await deps.onStop?.(deps.ctx);
    await supervisor?.stop();
    supervisor = undefined;
    await deps.ctx.conversations?.disposeAll();
    await deps.ctx.outbox?.stop();
    started = false;
    deps.ctx.setStarted(false);
    deps.status.setConn("stopped");
    deps.logger.info("bridge stopped");
  }

  return {
    async start() {
      await start();
    },
    async stop() {
      await stop();
    },
    isStarted: () => started,
    async restart() {
      await stop();
      await start();
    },
  };
}

/** Convenience: route a normalized inbound message into the pipeline. */
export function dispatchInbound(ctx: BridgeContext, handler: { handleInbound(m: FeishuInboundMessage): Promise<unknown> }, msg: FeishuInboundMessage): void {
  void handler.handleInbound(msg).catch((err) => {
    ctx.logger.error(`inbound dispatch failed: ${String(err)}`);
  });
}
