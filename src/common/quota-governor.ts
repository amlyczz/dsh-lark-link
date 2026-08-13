// Quota circuit breaker: caps connect attempts per window, persisted across
// restarts (conn-history.jsonl). Prevents burning Feishu's connection quota
// (error 1000040350) on pathological reconnect loops. Harness-agnostic.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface QuotaGovernor {
  /** Record a connect attempt (success or failure); returns the new count. */
  recordConnect(): number;
  /** Record a connect failure (drives the breaker). */
  recordFailure(): void;
  /** True when the window limit has been reached — the bridge must stop trying. */
  tripped(): boolean;
  /** Remaining attempts allowed in the current window. */
  remaining(): number;
  /** When the quarantine lifts (epoch ms), if tripped. */
  resetAt(): number | undefined;
  /** Forget history (e.g. after an explicit /lark restart with user intent). */
  reset(): void;
}

interface ConnRecord {
  at: number;
  ok: boolean;
}

export function createQuotaGovernor(
  historyFile: string,
  opts: { windowMinutes: number; limit: number; now?: () => number } = { windowMinutes: 60, limit: 12 },
): QuotaGovernor {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMinutes * 60_000;

  let history: ConnRecord[] = [];
  try {
    const raw = readFileSync(historyFile, "utf8");
    history = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ConnRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is ConnRecord => r !== undefined);
  } catch {
    history = [];
  }

  const persist = (): void => {
    try {
      mkdirSync(join(historyFile, ".."), { recursive: true });
      writeFileSync(historyFile, history.slice(-500).map((r) => JSON.stringify(r)).join("\n") + "\n", {
        mode: 0o600,
      });
    } catch {
      // best-effort
    }
  };

  const prune = (): void => {
    const cutoff = now() - windowMs;
    history = history.filter((r) => r.at >= cutoff);
  };

  return {
    recordConnect() {
      prune();
      history.push({ at: now(), ok: true });
      persist();
      return history.length;
    },
    recordFailure() {
      prune();
      history.push({ at: now(), ok: false });
      persist();
    },
    tripped() {
      prune();
      return history.filter((r) => !r.ok).length >= opts.limit;
    },
    remaining() {
      prune();
      return Math.max(0, opts.limit - history.filter((r) => !r.ok).length);
    },
    resetAt() {
      prune();
      const oldest = history.filter((r) => !r.ok)[0];
      return oldest ? oldest.at + windowMs : undefined;
    },
    reset() {
      history = [];
      persist();
    },
  };
}
