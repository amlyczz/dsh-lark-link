// DiagnosticsService: one-click sanitized diagnostic bundle (`/doctor`, `/support` 旧名兼容,
// `/lark doctor`). Masks secrets, hashes ids, includes config (redacted),
// connection history, outbox stats, and a prefilled ISSUE.md. Harness-agnostic.

import type { BridgeContextRead } from "./bridge-context.ts";
import { redactSecrets, statusDetailLines } from "./status-formatter.ts";

export interface DiagnosticsDeps {
  ctx: BridgeContextRead;
  /** Credentials to redact (appSecret etc.). */
  secrets: string[];
  /** Extra diagnostics (e.g. DSH version). */
  extra?: Record<string, unknown>;
}

export interface DiagnosticsService {
  build(): Promise<{ text: string; issueMd: string }>;
}

export function createDiagnosticsService(deps: DiagnosticsDeps): DiagnosticsService {
  return {
    async build() {
      const s = deps.ctx.status.get();
      const cfg = deps.ctx.cfg();
      const lines: string[] = [
        "# dsh-lark-link 诊断包",
        "",
        `生成时间: ${new Date().toISOString()}`,
        `桥状态: ${deps.ctx.started() ? "运行中" : "未启动"}`,
        ...statusDetailLines(s),
        "",
        "## 配置（脱敏）",
        "```json",
        redactSecrets(JSON.stringify(cfg, null, 2), deps.secrets),
        "```",
      ];
      if (deps.extra) {
        lines.push("", "## 附加信息", "```json", JSON.stringify(deps.extra, null, 2), "```");
      }
      const issueMd = [
        "## 问题描述",
        "",
        "（请填写：现象 / 复现步骤 / 期望结果）",
        "",
        "## 诊断信息",
        "```",
        ...lines,
        "```",
        "",
        "## 环境",
        "- dsh-lark-link: 0.1.0",
        "- Node: " + process.version,
      ].join("\n");
      return { text: lines.join("\n"), issueMd };
    },
  };
}
