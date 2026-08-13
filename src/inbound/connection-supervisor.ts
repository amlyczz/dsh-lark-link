// ConnectionSupervisor: probe-driven controlled reconnect (ADR-1/2/3).
// - WSClient autoReconnect is OFF; the supervisor decides when to rebuild.
// - Probe (REST heartbeat) healthy => never rebuild an idle connection
//   (no false-positive zombie kills — ADR-2).
// - Probe fails repeatedly => degrade → reconnect with bounded backoff.
// - QuotaGovernor trips => quarantine (stop trying, report, wait).
// In-process form: quarantine DISABLES the bridge (no process.exit) and the
// status store surfaces the reason. Harness-agnostic.

import type { ConnState } from "../common/types.ts";
import type { QuotaGovernor } from "../common/quota-governor.ts";
import type { StatusStore } from "../common/connection-status.ts";

export interface SupervisorDeps {
  transport: {
    start(): Promise<void>;
    stop(): Promise<void>;
    isConnected(): boolean;
    wsReady(): boolean;
    probe(): Promise<boolean>;
  };
  quota: QuotaGovernor;
  status: StatusStore;
  cfg: {
    probeIntervalMs: number;
    probeTimeoutMs: number;
    probeFailThreshold: number;
    maxReconnectAttempts: number;
    idleKeepaliveMs: number;
    quotaWindowMinutes: number;
    quotaLimit: number;
  };
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  now?: () => number;
  /** Called on state transitions that need out-of-band notification. */
  onStateChange?: (state: ConnState, detail?: string) => void;
}

export interface ConnectionSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One probe cycle (also the unit-test entry). */
  tick(): Promise<void>;
  state(): ConnState;
  /** Force a rebuild (e.g. /lark restart, config change). */
  reconnect(): Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

export function createConnectionSupervisor(deps: SupervisorDeps): ConnectionSupervisor {
  const now = deps.now ?? Date.now;
  let state: ConnState = "idle";
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let probeFailStreak = 0;
  let reconnectAttempts = 0;
  let lastProbeOk = true;

  const setState = (s: ConnState, detail?: string): void => {
    state = s;
    deps.status.setConn(s, detail ? { lastError: detail } : {});
    deps.onStateChange?.(s, detail);
    if (detail) deps.logger?.warn(`conn -> ${s}: ${detail}`);
    else deps.logger?.info(`conn -> ${s}`);
  };

  async function ensureConnected(): Promise<void> {
    if (stopped) return;
    if (deps.transport.isConnected()) {
      if (state !== "connected") setState("connected");
      return;
    }
    if (state === "quarantined") return;
    if (deps.quota.tripped()) {
      setState("quarantined", `quota breaker tripped (${deps.cfg.quotaLimit}/${deps.cfg.quotaWindowMinutes}min); retry after reset`);
      return;
    }
    if (reconnectAttempts >= deps.cfg.maxReconnectAttempts) {
      deps.quota.recordFailure();
      setState("quarantined", `reconnect attempts exhausted (${reconnectAttempts}); circuit breaker armed`);
      return;
    }
    setState("connecting");
    deps.quota.recordConnect();
    try {
      await deps.transport.start();
    } catch (err) {
      deps.logger?.error(`transport.start threw: ${String(err)}`);
    }
    if (deps.transport.isConnected()) {
      reconnectAttempts = 0;
      probeFailStreak = 0;
      setState("connected");
    } else {
      reconnectAttempts++;
      deps.quota.recordFailure();
      if (deps.quota.tripped()) {
        setState("quarantined", `quota breaker tripped after ${reconnectAttempts} failed connects`);
        return;
      }
      setState("reconnecting", `connect failed (attempt ${reconnectAttempts}/${deps.cfg.maxReconnectAttempts})`);
    }
  }

  async function tick(): Promise<void> {
    if (stopped || state === "quarantined") return;
    // Probe over REST (independent of WS health).
    let ok = false;
    try {
      ok = await Promise.race([
        deps.transport.probe(),
        sleep(deps.cfg.probeTimeoutMs).then(() => false),
      ]);
    } catch {
      ok = false;
    }
    lastProbeOk = ok;
    deps.status.update({ lastProbeAt: now(), lastProbeOk: ok });

    if (ok) {
      // Healthy probe: reset failure streaks — never rebuild an idle but live
      // connection (ADR-2 silent-idle protection).
      probeFailStreak = 0;
      if (!deps.transport.isConnected()) {
        // WS down but REST up: rebuild (connection truly lost).
        reconnectAttempts = 0;
        await ensureConnected();
      } else if (state !== "connected") {
        setState("connected");
      }
      return;
    }

    probeFailStreak++;
    if (probeFailStreak >= deps.cfg.probeFailThreshold) {
      if (deps.transport.isConnected()) {
        setState("degraded", `probe failed ${probeFailStreak}x`);
      }
      await ensureConnected();
    }
    // Below threshold: transient blip, keep watching.
  }

  return {
    async start() {
      stopped = false;
      setState("connecting");
      await ensureConnected();
      timer = setInterval(() => void tick(), deps.cfg.probeIntervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await deps.transport.stop();
      setState("stopped");
    },
    async tick() {
      await tick();
    },
    state: () => state,
    async reconnect() {
      reconnectAttempts = 0;
      deps.quota.reset();
      await deps.transport.stop();
      await ensureConnected();
    },
  };
}
