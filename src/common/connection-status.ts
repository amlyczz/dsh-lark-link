// Connection status store: in-memory snapshot + optional JSONL persistence
// (status.json) updated on transitions. Harness-agnostic.

import { readFileSync, writeFileSync } from "node:fs";
import type { BridgeStatus, ConnState } from "./types.ts";

export interface StatusStore {
  get(): BridgeStatus;
  update(patch: Partial<BridgeStatus>): BridgeStatus;
  setConn(state: ConnState, extra?: Partial<BridgeStatus>): BridgeStatus;
  /** Refresh counters from the outbox (called on startup, not only timers). */
  refreshCounters(counters: Pick<BridgeStatus, "outboxPending" | "outboxFailed">): void;
}

export function createStatusStore(file: string | undefined, now: () => number = Date.now): StatusStore {
  let status: BridgeStatus = {
    connState: "idle",
    outboxPending: 0,
    outboxFailed: 0,
    sessions: 0,
    wsReady: false,
  };

  if (file) {
    try {
      const raw = readFileSync(file, "utf8");
      status = { ...status, ...(JSON.parse(raw) as Partial<BridgeStatus>) };
    } catch {
      // first run
    }
  }

  const persist = (): void => {
    if (!file) return;
    try {
      writeFileSync(file, JSON.stringify(status, null, 2), { mode: 0o600 });
    } catch {
      // best-effort
    }
  };

  return {
    get: () => ({ ...status }),
    update(patch) {
      status = { ...status, ...patch };
      persist();
      return this.get();
    },
    setConn(state, extra) {
      const patch: Partial<BridgeStatus> = { connState: state, ...extra };
      if (state === "connected") patch.connectedAt = now();
      status = { ...status, ...patch };
      persist();
      return this.get();
    },
    refreshCounters(counters) {
      status = { ...status, ...counters };
      persist();
    },
  };
}
