// Persistent outbox — the reliability core (ADR-4). at-least-once delivery,
// idempotency keys, per-lane parallel drain with FIFO inside a lane, bounded
// backoff, failed messages leave the lane head (never block the conversation —
// pi-feishu-link F1 fix), crash-safe JSONL segment files.
//
// Deliberately has ZERO DSH and ZERO Feishu SDK imports: the sender is
// injected, so this module is unit-testable in isolation (same discipline as
// pi-feishu-link's outbox.ts).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OutboundEnvelope, EnvelopePayload, RouteRef } from "../common/types.ts";

export type DeliveryResult = { ok: true } | { ok: false; retryable: boolean; error: string };

export interface OutboxSender {
  /** Deliver one envelope to Feishu. Throw or return {ok:false} on failure. */
  deliver(env: OutboundEnvelope, payload: EnvelopePayload): Promise<DeliveryResult>;
}export interface OutboxDeps {
  dir: string;
  sender: OutboxSender;
  cfg: {
    maxAttempts: number;
    backoffMaxMs: number;
    retainDays: number;
    pendingCap: number;
    blobThreshold: number;
  };
  now?: () => number;
  /** Fatal delivery (permanent error, e.g. HTTP 400) marks the envelope fatal. */
  isFatalError?: (error: string) => boolean;
  /** How often (ms) to sweep done/fatal envelopes older than retainDays.
   *  Defaults to retainDays-scaled cadence (every ~1h) when omitted, so on-disk
   *  segments never grow unbounded even if the caller never calls prune(). */
  pruneIntervalMs?: number;
  /** Fired whenever the pending/failed counts change (delivery done/failed,
   *  enqueue, prune, rebuild). Lets the host refresh live status counters. */
  onStatsChange?: (stats: { pending: number; failed: number }) => void;
}

export interface Outbox {
  enqueue(input: {
    dedupeKey: string;
    laneKey: string;
    route: RouteRef;
    kind: OutboundEnvelope["kind"];
    payload: EnvelopePayload;
    /** True to skip the idempotency check (missed-compensation replay). */
    skipDedupe?: boolean;
  }): string | undefined;
  /** Start draining all lanes. */
  start(): void;
  /** Stop draining (in-flight deliveries settle). */
  stop(): Promise<void>;
  pendingCount(): number;
  failedCount(): number;
  /** Remove terminal envelopes older than retainDays. */
  prune(): void;
  /** Crash recovery: anything left 'sending' returns to 'pending'. */
  rebuildFromDisk(): void;
  /** Internal: lanes currently draining (for tests/status). */
  lanes(): string[];
}

interface DiskEnvelope extends Omit<OutboundEnvelope, "payload"> {
  payload?: EnvelopePayload;
  blobRef?: string;
}

const STATUS_ORDER: Record<string, number> = { pending: 0, sending: 1, failed: 2, done: 3, fatal: 4 };

/** Unref'd sleep so an idle pump never keeps the process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const now = deps.now ?? Date.now;
  const dir = deps.dir;
  mkdirSync(join(dir, "blobs"), { recursive: true });

  /** id -> envelope (all statuses, bounded by prune). */
  const envelopes = new Map<string, DiskEnvelope>();
  /** laneKey -> array of envelope ids in FIFO order (pending+failed+sending). */
  const lanes = new Map<string, string[]>();
  /** dedupeKey -> done/fatal envelope id (idempotency, 30d). */
  const sentKeys = new Map<string, string>();
  const isFatal = deps.isFatalError ?? ((e: string) => /400|403|invalid|not found/i.test(e));

  let draining = false;
  let stopped = false;
  let pruneTimer: NodeJS.Timeout | undefined;
  const activeDeliveries = new Set<Promise<void>>();
  const laneQueues = new Map<string, Promise<void>>();
  /** Wake signal for the idle pump (set while it waits). */
  let idleWake: (() => void) | undefined;

  const emitStats = (): void => {
    try {
      let pending = 0;
      let failed = 0;
      for (const env of envelopes.values()) {
        if (env.status === "pending" || env.status === "failed") pending++;
        if (env.status === "failed") failed++;
      }
      deps.onStatsChange?.({ pending, failed });
    } catch {
      // best-effort
    }
  };

  // ---- persistence -------------------------------------------------------
  const segmentPath = (n: number): string => join(dir, `seg-${n}.jsonl`);

  function loadSegment(file: string): void {
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const env = JSON.parse(line) as DiskEnvelope;
          envelopes.set(env.id, env);
          if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id); // any status: idempotency survives restart
          if (env.status === "pending" || env.status === "failed" || env.status === "sending") {
            const lane = lanes.get(env.laneKey) ?? [];
            lane.push(env.id);
            lanes.set(env.laneKey, lane);
          }
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      // segment missing/corrupt — skip
    }
  }

  function rebuildFromDisk(): void {
    envelopes.clear();
    lanes.clear();
    sentKeys.clear();
    let segs: string[] = [];
    try {
      segs = readdirSync(dir)
        .filter((f) => /^seg-\d+\.jsonl$/.test(f))
        .sort((a, b) => {
          const na = Number(basename(a).match(/\d+/)?.[0] ?? 0);
          const nb = Number(basename(b).match(/\d+/)?.[0] ?? 0);
          return na - nb;
        });
    } catch {
      segs = [];
    }
    for (const seg of segs) loadSegment(join(dir, seg));
    // Crash recovery: 'sending' was in-flight when we died → back to pending.
    let changed = false;
    for (const env of envelopes.values()) {
      if (env.status === "sending") {
        env.status = "pending";
        env.updatedAt = now();
        changed = true;
      }
    }
    if (changed) persistAll();
  }

  function persistAll(): void {
    try {
      const segFile = segmentPath(Math.floor(now() / 1000));
      const lines = [...envelopes.values()].map((e) => JSON.stringify(e));
      // Rewrite a fresh segment for crash consistency (segment per flush batch).
      const tmp = `${segFile}.tmp`;
      writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
      renameSync(tmp, segFile);
      // Drop old segments beyond retention.
      const cutoff = now() - deps.cfg.retainDays * 86_400_000;
      for (const f of readdirSync(dir).filter((x) => /^seg-\d+\.jsonl$/.test(x))) {
        const ts = Number(basename(f).match(/\d+/)?.[0] ?? 0) * 1000;
        if (ts < cutoff) {
          try {
            rmSync(join(dir, f));
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // persistence best-effort; in-memory continues
    }
  }

  // ---- blob spill --------------------------------------------------------
  function spill(payload: EnvelopePayload): { payload?: EnvelopePayload; blobRef?: string } {
    const size = JSON.stringify(payload).length;
    if (size <= deps.cfg.blobThreshold) return { payload };
    const ref = `${randomUUID()}.json`;
    try {
      writeFileSync(join(dir, "blobs", ref), JSON.stringify(payload), { mode: 0o600 });
      return { blobRef: ref };
    } catch {
      return { payload }; // couldn't spill — keep inline
    }
  }

  function resolvePayload(env: DiskEnvelope): EnvelopePayload | undefined {
    if (env.payload) return env.payload;
    if (env.blobRef) {
      try {
        return JSON.parse(readFileSync(join(dir, "blobs", env.blobRef), "utf8")) as EnvelopePayload;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  // ---- enqueue -----------------------------------------------------------
  function enqueue(input: {
    dedupeKey: string;
    laneKey: string;
    route: RouteRef;
    kind: OutboundEnvelope["kind"];
    payload: EnvelopePayload;
    skipDedupe?: boolean;
  }): string | undefined {
    if (stopped) return undefined;
    // Idempotency is enforced at ENQUEUE time (any status): a dedupeKey that
    // has ever been enqueued is never delivered twice (at-least-once, not
    // at-most-once per enqueue — the SAME logical message must not double-send
    // even when two enqueues race within one drain window).
    if (!input.skipDedupe && sentKeys.has(input.dedupeKey)) return undefined;
    if (envelopes.size >= deps.cfg.pendingCap) {
      // Hard cap: refuse rather than unbounded growth.
      return undefined;
    }
    const id = randomUUID();
    const spilled = spill(input.payload);
    const env: DiskEnvelope = {
      id,
      dedupeKey: input.dedupeKey,
      laneKey: input.laneKey,
      route: input.route,
      kind: input.kind,
      status: "pending",
      attempts: 0,
      nextRetryAt: now(),
      createdAt: now(),
      updatedAt: now(),
      ...spilled,
    };
    envelopes.set(id, env);
    sentKeys.set(input.dedupeKey, id);
    const lane = lanes.get(input.laneKey) ?? [];
    lane.push(id);
    lanes.set(input.laneKey, lane);
    persistAll();
    // Wake an idle pump immediately — zero poll latency for new work.
    idleWake?.();
    emitStats();
    return id;
  }

  // ---- drain -------------------------------------------------------------
  async function deliverOne(id: string): Promise<void> {
    const env = envelopes.get(id);
    if (!env || env.status === "done" || env.status === "fatal") return;
    const payload = resolvePayload(env);
    if (!payload) {
      env.status = "fatal";
      env.error = "payload unresolved (blob missing)";
      env.updatedAt = now();
      return;
    }
    env.status = "sending";
    env.updatedAt = now();
    // Sender sees a fully-resolved envelope (payload always present here).
    const resolved: OutboundEnvelope = { ...env, payload } as OutboundEnvelope;
    const result = await deps.sender.deliver(resolved, payload);
    if (result.ok) {
      env.status = "done";
      env.updatedAt = now();
      if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id);
    } else {
      env.attempts += 1;
      env.error = result.error;
      env.updatedAt = now();
      if (!result.retryable || isFatal(result.error)) {
        env.status = "fatal";
      } else if (env.attempts >= deps.cfg.maxAttempts) {
        // Attempts exhausted — give up (ADR-4: bounded attempts then fatal).
        env.status = "fatal";
      } else {
        env.status = "failed";
        // Bounded exponential backoff, ceiling at backoffMaxMs.
        const backoff = Math.min(deps.cfg.backoffMaxMs, 1000 * 2 ** Math.min(env.attempts - 1, 10));
        env.nextRetryAt = now() + backoff;
      }
    }
    // A failed message is NOT re-inserted at the lane head (F1 fix): it was
    // already removed from its lane position at drain; it stays failed and is
    // re-drained by the retry sweep. New messages in the lane proceed.
    persistAll();
    emitStats();
  }

  /** Drain one lane FIFO. Failed messages fall out; retry sweep picks them up. */
  async function drainLane(laneKey: string): Promise<void> {
    const ids = lanes.get(laneKey);
    if (!ids || ids.length === 0) return;
    // Copy head; remove as we go so a failure doesn't block the lane.
    const head = ids.shift();
    lanes.set(laneKey, ids);
    if (head !== undefined) {
      await deliverOne(head);
    }
  }

  /** Retry sweep: re-drain 'failed' envelopes whose nextRetryAt has passed. */
  function retrySweep(): void {
    let woke = false;
    const due: string[] = [];
    for (const env of envelopes.values()) {
      if (env.status === "failed" && env.nextRetryAt <= now()) due.push(env.id);
    }
    for (const id of due) {
      const env = envelopes.get(id);
      if (env) {
        const lane = lanes.get(env.laneKey) ?? [];
        if (!lane.includes(id)) {
          lane.push(id);
          lanes.set(env.laneKey, lane);
          woke = true;
        }
      }
    }
    if (woke) idleWake?.();
  }

  async function pump(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!stopped) {
        retrySweep();
        let worked = false;
        for (const laneKey of lanes.keys()) {
          const ids = lanes.get(laneKey);
          if (ids && ids.length > 0) {
            worked = true;
            const laneQueue = laneQueues.get(laneKey) ?? Promise.resolve();
            const next = laneQueue.then(() => drainLane(laneKey));
            laneQueues.set(laneKey, next.catch(() => undefined));
            activeDeliveries.add(next);
            void next.finally(() => activeDeliveries.delete(next));
          }
        }
        if (!worked) {
          // Idle: wait for an enqueue wake signal (or a safety timeout), so
          // new work starts immediately instead of waiting out a poll cycle.
          await new Promise<void>((resolve) => {
            idleWake = resolve;
            const t = setTimeout(() => {
              idleWake = undefined;
              resolve();
            }, 200);
            t.unref?.();
          });
          idleWake = undefined;
        } else {
          await sleep(25);
        }
      }
    } finally {
      draining = false;
    }
  }

  // Named (hoisted) prune so start() can self-schedule it regardless of order.
  function doPrune(): void {
    const cutoff = now() - deps.cfg.retainDays * 86_400_000;
    let changed = false;
    for (const [id, env] of envelopes) {
      if ((env.status === "done" || env.status === "fatal") && env.updatedAt < cutoff) {
        envelopes.delete(id);
        if (env.blobRef) {
          try {
            rmSync(join(dir, "blobs", env.blobRef));
          } catch {
            // ignore
          }
        }
        changed = true;
      }
    }
    if (changed) persistAll();
    emitStats();
  }

  return {
    enqueue,
    start() {
      stopped = false;
      // Self-pruning: sweep done/fatal older than retainDays on a cadence, so
      // on-disk segments never grow unbounded even if no external caller ever
      // invokes prune(). Default ~1h (or a caller-supplied interval).
      const cadence = deps.pruneIntervalMs ?? Math.max(3_600_000, Math.min(24 * 3_600_000, deps.cfg.retainDays * 3_600_000));
      doPrune();
      pruneTimer = setInterval(() => doPrune(), cadence);
      if (pruneTimer.unref) pruneTimer.unref();
      void pump();
    },
    async stop() {
      stopped = true;
      if (pruneTimer) clearInterval(pruneTimer);
      pruneTimer = undefined;
      await Promise.allSettled([...activeDeliveries]);
    },
    pendingCount() {
      let n = 0;
      for (const env of envelopes.values()) {
        if (env.status === "pending" || env.status === "failed") n++;
      }
      return n;
    },
    failedCount() {
      let n = 0;
      for (const env of envelopes.values()) {
        if (env.status === "failed") n++;
      }
      return n;
    },
    prune: doPrune,
    rebuildFromDisk,
    lanes: () => [...lanes.keys()],
  };
}
