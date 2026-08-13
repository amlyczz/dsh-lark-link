// Gateway lock: single-owner protection for multi-host setups (web + CLI both
// running). Uses an atomic wx-exclusive file + heartbeat + liveness check
// (pi-feishu-link 01f978a lesson: owner pid MUST be validated as live, else a
// zombie lock silently disables the bridge). In-process form: the lock guards
// against a SECOND host starting the bridge; the first host wins.
// Harness-agnostic.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GatewayLockHandle {
  owner: { pid: number; host: string; startedAt: number };
  release(): Promise<void>;
  /** Heartbeat refresh (extend ownership). */
  touch(): void;
  update(s: string): void;
}

export interface GatewayLockDeps {
  dir: string;
  host: string;
  heartbeatMs?: number;
  staleMs?: number;
  now?: () => number;
}

/**
 * Acquire the gateway lock. Returns undefined when another LIVE owner holds it.
 * A stale lock (owner pid not alive, or heartbeat older than staleMs) is
 * broken and re-acquired.
 */
export function acquireGatewayLock(deps: GatewayLockDeps): GatewayLockHandle | undefined {
  const now = deps.now ?? Date.now;
  const lockFile = join(deps.dir, "gateway.json");
  const heartbeatMs = deps.heartbeatMs ?? 5_000;
  const staleMs = deps.staleMs ?? 30_000;

  const isPidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH = dead; EPERM = alive but not ours.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  const readOwner = (): GatewayLockHandle["owner"] | undefined => {
    try {
      const raw = readFileSync(lockFile, "utf8");
      return JSON.parse(raw) as GatewayLockHandle["owner"];
    } catch {
      return undefined;
    }
  };

  const owner = { pid: process.pid, host: deps.host, startedAt: now() };

  // Atomic acquire: exclusive-create the file (O_EXCL) — no read-then-write race.
  const writeOwner = (): boolean => {
    try {
      writeFileSync(lockFile, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  if (!writeOwner()) {
    // File exists — check liveness; break stale locks.
    const existing = readOwner();
    const alive = existing && isPidAlive(existing.pid);
    const stale = existing && now() - existing.startedAt > staleMs;
    if (alive && !stale) return undefined; // live owner holds the lock
    // Stale (dead pid or expired heartbeat): reclaim.
    try {
      rmSync(lockFile, { force: true });
    } catch {
      return undefined;
    }
    if (!writeOwner()) return undefined;
  }

  let heartbeat: NodeJS.Timeout | undefined;
  heartbeat = setInterval(() => {
    try {
      writeFileSync(lockFile, JSON.stringify({ ...owner, startedAt: now() }), { mode: 0o600 });
    } catch {
      // lost lock externally
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    owner,
    async release() {
      if (heartbeat) clearInterval(heartbeat);
      try {
        rmSync(lockFile, { force: true });
      } catch {
        // ignore
      }
    },
    touch() {
      owner.startedAt = now();
      try {
        writeFileSync(lockFile, JSON.stringify(owner));
      } catch {
        // ignore
      }
    },
    update(s) {
      // keepalive channel for status text (pi parity); no-op persistence needed.
      void s;
    },
  };
}

/** Read the current live owner (for status display). */
export function readLiveGatewayOwner(dir: string): { pid: number; host: string; startedAt: number } | undefined {
  const lockFile = join(dir, "gateway.json");
  if (!existsSync(lockFile)) return undefined;
  try {
    const raw = readFileSync(lockFile, "utf8");
    const owner = JSON.parse(raw) as { pid: number; host: string; startedAt: number };
    if (typeof owner.pid !== "number") return undefined;
    return owner;
  } catch {
    return undefined;
  }
}
