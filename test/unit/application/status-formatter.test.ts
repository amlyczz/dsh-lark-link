import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatusLine, statusDetailLines, redactSecrets } from "../../../src/application/status-formatter.ts";
import type { BridgeStatus } from "../../../src/common/types.ts";

const status: BridgeStatus = {
  connState: "connected",
  wsReady: true,
  outboxPending: 3,
  outboxFailed: 1,
  sessions: 2,
};

test("status-formatter: line contains key metrics", () => {
  const line = formatStatusLine(status);
  assert.ok(line.includes("CONNECTED"));
  assert.ok(line.includes("outbox: 3 待发 / 1 失败"));
  assert.ok(line.includes("会话: 2"));
});

test("status-formatter: quarantine renders countdown", () => {
  const q: BridgeStatus = { ...status, connState: "quarantined", quarantinedUntil: Date.now() + 5 * 60_000 };
  const line = formatStatusLine(q);
  assert.ok(line.includes("熔断"));
});

test("status-formatter: detail lines are exhaustive", () => {
  const lines = statusDetailLines(status);
  assert.ok(lines.some((l) => l.includes("WS 就绪: true")));
  assert.ok(lines.some((l) => l.includes("outbox 待发: 3")));
});

test("status-formatter: redactSecrets masks listed secrets and long tokens", () => {
  const out = redactSecrets("appSecret=abc123 secret=xyz hmm abc123 ends", ["xyz", "abc123"]);
  assert.ok(!out.includes("xyz"), "listed secret masked");
  assert.ok(!out.includes("abc123"), "listed secret masked");
  const long = redactSecrets("token=abcdefghijklmnopqrstuvwxyz1234567890", []);
  assert.ok(long.includes("***"), "long token masked");
});
