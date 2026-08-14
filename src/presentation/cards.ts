// Feishu card builders (L4 presentation, schema 2.0). Pure functions.
//
// 2026-08-14 对齐 pi-feishu-link 修复：schema 2.0 已移除 tag:"action"
// 容器（ErrCode 200861）——按钮直接平铺进 body.elements（tag:"button"，
// width:"fill" 防截断），交互回传用 behaviors:[{type:"callback",value}]。
// emoji 精简为稳定集合（部分 emoji 在部分客户端字体渲染乱码）。

export type CardVariant = "status" | "help" | "setup" | "welcome" | "error";

/** Card button value (op routing). */
export interface CardButtonValue {
  op: string;
  [key: string]: unknown;
}

/**
 * schema 2.0 按钮：直接作为组件放 elements（平铺、宽度完整不缩略）；
 * 交互回传用 behaviors:[{type:"callback",value}]（card.action.trigger 回调返回 value）。
 */
export function button(text: string, value: CardButtonValue, style?: "primary" | "danger"): unknown {
  const b: Record<string, unknown> = {
    tag: "button",
    width: "fill",
    text: { tag: "plain_text", content: text },
    behaviors: [{ type: "callback", value }],
  };
  if (style === "primary") b.type = "primary";
  if (style === "danger") b.type = "danger";
  return b;
}

/**
 * Heuristic: does this reply carry markdown worth rendering as a card?
 * Matches headings, lists, fenced code, blockquotes, bold, tables and
 * paragraph breaks (pi-feishu-link rich-text mode selection).
 */
export function looksLikeMarkdown(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (
    /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*|\|.*\|)/.test(
      t,
    ) ||
    t.includes("\n\n")
  )
    return true;
  return false;
}

export function markdownCard(markdown: string, opts: { header?: string; accent?: boolean } = {}): unknown {
  return {
    schema: "2.0",
    body: {
      header: opts.header
        ? {
            title: { tag: "plain_text", content: opts.header },
            template: opts.accent ? "blue" : "grey",
          }
        : undefined,
      elements: [{ tag: "markdown", content: markdown }],
    },
  };
}

export function helpCard(): unknown {
  return markdownCard(
    [
      "**可用命令**",
      "",
      "- `/status` 桥接状态",
      "- `/workspace` 当前工作区",
      "- `/stop` 停止当前会话任务",
      "- `/doctor` 生成诊断包",
      "- `/lark-config k=v` 热改配置",
      "- `/model`、`/goal`、`/skill:name` 等原样转发给 DSH",
    ].join("\n"),
    { header: "Lark Link 帮助", accent: true },
  );
}

/** Welcome card with one-click buttons (schema 2.0 平铺按钮). */
export function welcomeCard(botName: string): unknown {
  return {
    schema: "2.0",
    body: {
      header: { title: { tag: "plain_text", content: "连接成功" }, template: "blue" },
      elements: [
        { tag: "markdown", content: `**${botName} 已连接**\n\n你可以直接和我说话，或点下方按钮：` },
        button("命令面板", { op: "help" }),
        button("桥接状态", { op: "status" }),
        button("停止任务", { op: "stop" }),
      ],
    },
  };
}

/** Command panel card with one-click buttons. */
export function commandPanelCard(): unknown {
  return {
    schema: "2.0",
    body: {
      header: { title: { tag: "plain_text", content: "命令面板" }, template: "blue" },
      elements: [
        { tag: "markdown", content: "**命令面板**\n点击按钮一键执行，或直接输入文字聊天：" },
        button("桥接状态", { op: "status" }),
        button("停止任务", { op: "stop" }),
        button("工作区", { op: "workspace" }),
        button("诊断包", { op: "doctor" }),
        button("配置", { op: "lark-config" }),
        { tag: "markdown", content: "文本命令：`/status` `/workspace` `/stop` `/doctor` `/lark-config k=v` `/help`\n\n定时任务等 `/goal`、`/skill:name` 原样转发给 DSH。" },
      ],
    },
  };
}

/** Status card with a doctor button. */
export function statusCard(statusText: string, detailLines: string[] = []): unknown {
  return {
    schema: "2.0",
    body: {
      elements: [
        { tag: "markdown", content: `**状态**\n${statusText}` },
        ...detailLines.map((line) => ({ tag: "markdown", content: line })),
        button("诊断包", { op: "doctor" }),
      ],
    },
  };
}

export function setupCard(qrUrl: string, expireInSec: number): unknown {
  return markdownCard(
    [
      "**扫码创建飞书应用**（30 秒上线）",
      "",
      `二维码有效期 ${expireInSec}s，或用链接手动打开：`,
      qrUrl,
    ].join("\n"),
    { header: "Lark Link 设置", accent: true },
  );
}

export function errorCard(message: string): unknown {
  return markdownCard(`**出错了**\n\n${message}`, { header: "错误", accent: false });
}

export const CARD_MESSAGE_TYPE = "interactive";
