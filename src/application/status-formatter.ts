// StatusFormatter: pure functions turning BridgeStatus into user-facing
// status lines (Feishu text / GUI panel). Harness-agnostic.

import type { BridgeStatus } from "../common/types.ts";

export function formatStatusLine(s: BridgeStatus): string {
  const conn = s.connState.toUpperCase();
  const parts = [
    `连接: ${conn}${s.wsReady ? " (WS)" : ""}`,
    `outbox: ${s.outboxPending} 待发 / ${s.outboxFailed} 失败`,
    `会话: ${s.sessions}`,
  ];
  if (s.quarantinedUntil) {
    const mins = Math.ceil((s.quarantinedUntil - Date.now()) / 60_000);
    parts.push(`熔断: ${Math.max(0, mins)}min 后重试`);
  }
  if (s.lastError) parts.push(`最近错误: ${s.lastError}`);
  return parts.join(" · ");
}

export function statusDetailLines(s: BridgeStatus): string[] {
  const lines = [
    `状态: ${s.connState}`,
    `WS 就绪: ${s.wsReady}`,
    `上次探活: ${s.lastProbeAt ? new Date(s.lastProbeAt).toISOString() : "—"} (${s.lastProbeOk === undefined ? "?" : s.lastProbeOk ? "正常" : "失败"})`,
    `outbox 待发: ${s.outboxPending}`,
    `outbox 失败: ${s.outboxFailed}`,
    `活跃会话: ${s.sessions}`,
  ];
  if (s.connectedAt) lines.push(`连接时间: ${new Date(s.connectedAt).toISOString()}`);
  if (s.quarantinedUntil) lines.push(`熔断至: ${new Date(s.quarantinedUntil).toISOString()} (${s.quarantinedReason ?? ""})`);
  if (s.owner) lines.push(`持有者: pid ${s.owner.pid} @ ${s.owner.host} (${new Date(s.owner.startedAt).toISOString()})`);
  return lines;
}

/** Mask secrets in a diagnostics dump (config/credentials redaction). */
export function redactSecrets(input: string, secrets: string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (!secret) continue; // explicitly-listed secrets are masked regardless of length
    out = out.split(secret).join("***");
  }
  // Mask anything that looks like an appSecret (32-char base64-ish).
  out = out.replace(/\b[0-9A-Za-z_\-]{32,}\b/g, "***");
  return out;
}
