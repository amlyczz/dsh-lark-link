// Inbound WAL — durable journal of agent-bound user requests (ADR: 入站请求补发).
// Purpose: when the bridge/dsh process dies or the plugin is reloaded MID-TURN,
// a user message that was accepted and handed to the agent would otherwise be
// lost: it has already consumed its dedupe slot, and missed-compensation only
// replays messages missed during a WS *disconnection*, not ones whose agent-turn
// never completed before process death. This module records every agent-bound
// text request before it is enqueued and marks it delivered once the turn's
// durable output hits the outbox. On boot, accepted-but-never-delivered records
// within a replay window are re-dispatched through the inbound pipeline
// (skipDedupe), so no user request is silently dropped by a crash/restart.
//
// Deliberately ZERO DSH and ZERO Feishu SDK imports — the store is a pure
// persistence primitive (same discipline as outbox.ts), unit-testable in
// isolation.
//
// Only TEXT requests are journaled. Media in/out (images/files) can't be
// dependent on reliable replay here and CLI commands are re-runnable/stateless,
// so those are deliberately not recorded.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/** Delivery state of one recorded request. */
export type InboundWalState =
  | "accepted" // recorded, agent turn not yet proven delivered
  | "delivered" // the turn's durable output was enqueued to the outbox
  | "replayed" // re-dispatched at boot (may still need delivery, but attempts counted)
  | "failed"; // GH #9: exhausted its replay budget without delivery — terminal, surfaced via failedCount()

export interface InboundWalRecord {
  messageId: string;
  sessionKey: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  text: string;
  acceptedAt: number;
  attempts: number;
  state: InboundWalState;
}

export interface InboundWalDeps {
  dir: string;
  /** How long an accepted-but-undelivered record stays eligible for replay. */
  replayRetentionMs?: number;
  /** Max times a record is re-attempted before it stops being replayed. */
  maxReplayAttempts?: number;
  now?: () => number;
}

export interface InboundWal {
  /** Record (or refresh) an agent-bound request as accepted. Returns the record. */
  accept(rec: Omit<InboundWalRecord, "acceptedAt" | "attempts" | "state">): InboundWalRecord;
  /** Mark the request for a messageId as delivered (turn output enqueued). */
  delivered(messageId: string): void;
  /** Mark accepted → replayed and bump attempt count. Returns false when it
   *  should NOT be replayed (already delivered / over attempt cap / too old). */
  markReplay(messageId: string): boolean;
  /**
   * Enumerate accepted (or replayed-but-undertried) requests within the replay
   * window, oldest first, that are not delivered and haven't exceeded the
   * attempt cap. Caller re-dispatches each and calls markReplay/remove.
   */
  pendingReplays(): InboundWalRecord[];
  /** Drop delivered records older than retention (housekeeping). */
  prune(): void;
  /** Forget a single record entirely (e.g. message could not be resolved). */
  remove(messageId: string): void;
  /** GH #9: terminal-mark a record that can no longer be replayed (cap/
   *  retention exhausted) so it stops masquerading as accepted. */
  fail(messageId: string): void;
  /** GH #9: how many records failed delivery (surfaced in /status). */
  failedCount(): number;
  pendingCount(): number;
}

export function createInboundWal(deps: InboundWalDeps): InboundWal {
  const dir = deps.dir;
  const replayRetentionMs = deps.replayRetentionMs ?? 30 * 60_000; // 30 min
  const maxReplayAttempts = deps.maxReplayAttempts ?? 2;
  const now = deps.now ?? Date.now;
  mkdirSync(dir, { recursive: true });

  /** messageId -> record (bounded set; pruned over time). */
  const records = new Map<string, InboundWalRecord>();

  function load(): void {
    let segs: string[] = [];
    try {
      segs = readdirSync(dir)
        .filter((f) => /^seg-.*\.jsonl$/.test(f))
        .sort();
    } catch {
      segs = [];
    }
    for (const seg of segs) {
      try {
        const lines = readFileSync(join(dir, seg), "utf8")
          .split("\n")
          .filter(Boolean);
        for (const line of lines) {
          try {
            const rec = JSON.parse(line) as InboundWalRecord;
            if (rec?.messageId) records.set(rec.messageId, rec);
          } catch {
            // skip corrupt line
          }
        }
      } catch {
        // missing/corrupt segment — skip
      }
    }
  }

  function persistAll(): void {
    try {
      const segFile = join(dir, `seg-${Date.now()}.jsonl`);
      const tmp = `${segFile}.tmp`;
      const lines = [...records.values()].map((r) => JSON.stringify(r));
      writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
      renameSync(tmp, segFile);
    } catch {
      // best-effort persistence; in-memory continues
    }
  }

  load();

  return {
    accept(rec) {
      const full: InboundWalRecord = {
        ...rec,
        acceptedAt: now(),
        attempts: 0,
        state: "accepted",
      };
      records.set(rec.messageId, full);
      persistAll();
      return full;
    },
    delivered(messageId) {
      const rec = records.get(messageId);
      // Delivered is the ground truth — it supersedes ANY prior state,
      // including failed (GH #9: a late rescue/salvage can still answer a
      // record whose replay budget was already exhausted).
      if (!rec || rec.state === "delivered") return;
      rec.state = "delivered";
      persistAll();
    },
    fail(messageId) {
      const rec = records.get(messageId);
      if (!rec || rec.state === "delivered" || rec.state === "failed") return;
      rec.state = "failed";
      persistAll();
    },
    markReplay(messageId) {
      const rec = records.get(messageId);
      if (!rec) return false;
      if (rec.state === "delivered") return false;
      if (rec.attempts >= maxReplayAttempts) {
        // GH #9: the attempt budget is gone — leave a terminal marker
        // instead of lingering as accepted (invisible-but-unresolved).
        if (rec.state !== "failed") {
          rec.state = "failed";
          persistAll();
        }
        return false;
      }
      if (now() - rec.acceptedAt > replayRetentionMs) return false;
      rec.attempts += 1;
      rec.state = "replayed";
      persistAll();
      return true;
    },
    pendingReplays() {
      const cutoff = now() - replayRetentionMs;
      return [...records.values()]
        .filter(
          (r) =>
            r.state !== "delivered" &&
            r.state !== "failed" &&
            r.attempts < maxReplayAttempts &&
            r.acceptedAt >= cutoff,
        )
        .sort((a, b) => a.acceptedAt - b.acceptedAt);
    },
    prune() {
      const deliveredCutoff = now() - replayRetentionMs;
      let changed = false;
      for (const [id, r] of records) {
        // Delivered/failed records age out after retention; never-delivered
        // records are retained only while still within the replay window and
        // attempt budget.
        const expired =
          r.state === "delivered" || r.state === "failed"
            ? r.acceptedAt < deliveredCutoff
            : r.acceptedAt < deliveredCutoff && r.attempts >= maxReplayAttempts;
        if (expired) {
          records.delete(id);
          changed = true;
        }
      }
      if (changed) persistAll();
    },
    remove(messageId) {
      if (records.delete(messageId)) persistAll();
    },
    failedCount: () =>
      [...records.values()].filter((r) => r.state === "failed").length,
    pendingCount: () => records.size,
  };
}

/** Does the file path exist? Exported for caller sanity checks. */
export function walDirExists(dir: string): boolean {
  return existsSync(dir);
}
