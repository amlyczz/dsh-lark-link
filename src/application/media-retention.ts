// Inbound Feishu media (downloaded images/files) are TRANSIENT turn
// artifacts, not durable bridge state: the model (or the user) reads them
// right after the turn, and the paths folded into conversation text go
// stale naturally. They therefore live under the OS TEMP DIR and are swept
// by age — retention bounds growth without any manual cleanup.
//
// `retentionHours <= 0` disables sweeping entirely (keep-forever mode for
// deployments that pin attachments.dir to a durable location instead).

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SweepResult {
	/** Files removed by this sweep. */
	deleted: number;
	/** Entries that failed to stat/remove (logged, never thrown). */
	errors: number;
}

/**
 * Delete files under `mediaDir` whose mtime is older than
 * `retentionHours`. Missing directory / unreadable entries are no-ops so
 * the sweeper can never take the bridge down.
 */
export function sweepMediaDir(
	mediaDir: string,
	retentionHours: number,
	now: number = Date.now(),
): SweepResult {
	if (!(retentionHours > 0)) return { deleted: 0, errors: 0 };
	let entries: string[];
	try {
		entries = readdirSync(mediaDir);
	} catch {
		return { deleted: 0, errors: 0 }; // missing dir — nothing to sweep
	}
	const cutoff = now - retentionHours * 3_600_000;
	let deleted = 0;
	let errors = 0;
	for (const name of entries) {
		const p = join(mediaDir, name);
		try {
			const st = statSync(p);
			if (st.isFile() && st.mtimeMs < cutoff) {
				// force + maxRetries: on Windows a file still held open (the
				// model reading it via read_image) fails with EBUSY/EPERM —
				// retry briefly, then leave it for the next hourly sweep.
				// Node's rm retries only the transient errno set, so this is
				// safe on every platform.
				rmSync(p, { force: true, maxRetries: 3, retryDelay: 100 });
				deleted++;
			}
		} catch {
			errors++; // raced away / unreadable — skip, next sweep retries
		}
	}
	return { deleted, errors };
}

/**
 * Start the media retention sweeper: one sweep IMMEDIATELY (clears stale
 * files from previous runs — the temp dir survives restarts) and then every
 * `intervalMs` (default: hourly). `retentionHours` is a live getter so
 * `/lark-config attachments.retentionHours=<n>` applies without a reload.
 * Returns a stop function (wired into the Cordis ctx.effect disposer).
 */
export function startMediaSweeper(
	opts: {
		mediaDir: string;
		retentionHours: () => number;
		intervalMs?: number;
		logger?: { info?: (m: string) => void; warn?: (m: string) => void };
	},
): () => void {
	const run = (): void => {
		try {
			const r = sweepMediaDir(opts.mediaDir, opts.retentionHours());
			if (r.deleted > 0)
				opts.logger?.info?.(
					`media sweep: removed ${r.deleted} expired file(s) under ${opts.mediaDir}`,
				);
			if (r.errors > 0)
				opts.logger?.warn?.(
					`media sweep: ${r.errors} entr(y/ies) failed under ${opts.mediaDir}`,
				);
		} catch (err) {
			opts.logger?.warn?.(
				`media sweep failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};
	run(); // startup sweep
	const timer = setInterval(run, opts.intervalMs ?? 3_600_000);
	timer.unref?.();
	return () => clearInterval(timer);
}
