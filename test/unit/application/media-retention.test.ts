import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	utimesSync,
	existsSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	sweepMediaDir,
	startMediaSweeper,
} from "../../../src/application/media-retention.ts";

const HOUR = 3600_000;

function mediaDir(): string {
	const d = mkdtempSync(join(tmpdir(), "media-ret-test-"));
	mkdirSync(join(d, "media"), { recursive: true });
	return join(d, "media");
}

test("sweepMediaDir deletes only files older than the retention window", () => {
	const dir = mediaDir();
	const old1 = join(dir, "feishu-om1-old.png");
	const old2 = join(dir, "feishu-om2-old.jpg");
	const fresh = join(dir, "feishu-om3-fresh.png");
	for (const f of [old1, old2, fresh]) writeFileSync(f, "x");
	const now = Date.now();
	utimesSync(old1, new Date(now - 48 * HOUR), new Date(now - 48 * HOUR));
	utimesSync(old2, new Date(now - 25 * HOUR), new Date(now - 25 * HOUR));
	utimesSync(fresh, new Date(now - 1 * HOUR), new Date(now - 1 * HOUR));

	const r = sweepMediaDir(dir, 24, now);
	assert.equal(r.deleted, 2, "both expired files removed");
	assert.equal(existsSync(old1), false);
	assert.equal(existsSync(old2), false);
	assert.equal(existsSync(fresh), true, "file inside the window stays");
	rmSync(dir, { recursive: true, force: true });
});

test("sweepMediaDir: retentionHours <= 0 disables cleanup entirely", () => {
	const dir = mediaDir();
	const f = join(dir, "ancient.png");
	writeFileSync(f, "x");
	const now = Date.now();
	utimesSync(f, new Date(now - 1000 * HOUR), new Date(now - 1000 * HOUR));
	const r = sweepMediaDir(dir, 0, now);
	assert.equal(r.deleted, 0, "nothing deleted when retention is 0");
	assert.equal(existsSync(f), true);
	rmSync(dir, { recursive: true, force: true });
});

test("sweepMediaDir: missing directory is a no-op (no throw)", () => {
	const r = sweepMediaDir(join(tmpdir(), "no-such-media-dir-xyz"), 24);
	assert.equal(r.deleted, 0);
});

test("startMediaSweeper: startup sweep runs immediately, stop() halts the timer", async () => {
	const dir = mediaDir();
	const f = join(dir, "stale-from-previous-run.png");
	writeFileSync(f, "x");
	const now = Date.now();
	utimesSync(f, new Date(now - 72 * HOUR), new Date(now - 72 * HOUR));

	const logs: string[] = [];
	const stop = startMediaSweeper({
		mediaDir: dir,
		retentionHours: () => 24,
		intervalMs: 50,
		logger: {
			info: (m: string) => logs.push(m),
			warn: () => {},
		},
	});
	// startup sweep is synchronous — the stale file is gone already
	assert.equal(existsSync(f), false, "startup sweep removed the stale file");
	assert.ok(logs.some((m) => m.includes("1")), "removal was logged");

	stop();
	await new Promise((r) => setTimeout(r, 120));
	rmSync(dir, { recursive: true, force: true });
});
