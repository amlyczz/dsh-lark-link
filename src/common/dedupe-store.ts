// Inbound dedupe store: keeps a bounded set of recently-seen message ids.
// Cross-process safety via an atomic directory lock (mkdir) with TTL break,
// per pi-lark-notify's claim-file pattern. Harness-agnostic.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DedupeRecord } from "./types.ts";

export interface DedupeStore {
  /** True when the message id was already seen (and not refreshed by this call). */
  seen(messageId: string): boolean;
  /** Record the id as seen; returns false if it was already present. */
  add(messageId: string): boolean;
  /** Prune entries older than ttlMs. */
  prune(ttlMs: number): void;
}

const MAX_RECORDS = 10_000;

export function createDedupeStore(file: string, now: () => number = Date.now): DedupeStore {
  let records: DedupeRecord[] = [];
  try {
    const raw = readFileSync(file, "utf8");
    records = (JSON.parse(raw) as DedupeRecord[]).slice(-MAX_RECORDS);
  } catch {
    records = [];
  }

  const persist = (): void => {
    try {
      writeFileSync(file, JSON.stringify(records.slice(-MAX_RECORDS), null, 2), { mode: 0o600 });
    } catch {
      // best-effort
    }
  };

  return {
    seen(messageId) {
      return records.some((r) => r.messageId === messageId);
    },
    add(messageId) {
      if (records.some((r) => r.messageId === messageId)) return false;
      records.push({ messageId, at: now() });
      if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
      persist();
      return true;
    },
    prune(ttlMs) {
      const cutoff = now() - ttlMs;
      const before = records.length;
      records = records.filter((r) => r.at >= cutoff);
      if (records.length !== before) persist();
    },
  };
}

/**
 * Acquire an atomic directory lock (mkdir is atomic on POSIX). Returns a
 * release function, or undefined when the lock is held by a live owner.
 * A stale lock (older than ttlMs) is broken automatically.
 */
export function acquireDirLock(
  lockDir: string,
  opts: { ttlMs: number; owner: string; now?: () => number } = { ttlMs: 15_000, owner: "unknown" },
): (() => void) | undefined {
  const now = opts.now ?? Date.now;
  try {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ owner: opts.owner, at: now() }));
    return () => {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };
  } catch {
    // exists — check staleness
    try {
      const ownerRaw = readFileSync(join(lockDir, "owner.json"), "utf8");
      const owner = JSON.parse(ownerRaw) as { owner: string; at: number };
      if (now() - owner.at > opts.ttlMs) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
          return acquireDirLock(lockDir, opts);
        } catch {
          return undefined;
        }
      }
    } catch {
      // lock dir exists but owner.json unreadable — treat as live
    }
    return undefined;
  }
}

/** Temp-dir helper for tests. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(process.env.TMPDIR ?? "/tmp", prefix));
}
