<p align="center">
  <img src="assets/mascot.png" alt="dsh-lark-link mascot" width="420"/>
</p>

<h1 align="center">🪶 dsh-lark-link</h1>

<p align="center">
  <b>DeepSeek Harness × 飞书/Lark 双向桥接</b> — 把你的 DSH 智能体装进飞书，扫码 30 秒上线，随时随地对话
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-lark-link"><img src="https://img.shields.io/npm/v/dsh-lark-link?color=cb3837&label=npm&logo=npm" alt="npm"/></a>
  <a href="https://github.com/amlyczz/dsh-lark-link/actions/workflows/ci.yml"><img src="https://github.com/amlyczz/dsh-lark-link/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/status-beta-orange" alt="beta"/>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D24-green" alt="node"/>
</p>

---

# 中文

> 全网统一昵称：**小斯syzs** · B站 [@小斯syzs](https://space.bilibili.com/390211071) · 抖音 · 小红书 · 快手（全网同名）

> 💬 **小斯syzs 邀请你加入飞书群** —— [点此一键加入](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=553i2f4a-5cc8-487f-95d3-3c4095bec0d9)

**DeepSeek Harness × 飞书/Lark 双向桥接插件** —— 把你的 DSH 智能体装进飞书：扫码 30 秒上线、消息零丢失、卡片化交互、每飞书会话独立 Agent。手机上随时给 Agent 派任务、看结果、切模型切模式——不用守着终端。

## 🌟 为什么选 dsh-lark-link

- **零门槛**：扫码即建飞书应用，不用手搓开放平台、不用配回调、不用公网服务器
- **零丢失**：出站 Outbox + 入站 WAL 双持久化，进程崩溃 / 插件热更 / dsh 重启，消息和回答都补得回来
- **零学习成本**：所有切换类命令都是单选卡片，点一下即生效；DSH 原生命令（/goal /compact …）直接用
- **真 Agent**：不是聊天机器人——bash/文件/子代理/工作流全套工具，飞书里跑完整 Harness

## ✨ 特性

| 能力 | 说明 |
| ---- | ---- |
| 🎯 **一键认证** | `/lark setup` 扫码创建飞书应用（自动订阅消息事件 + 群聊全量 + 表情权限），**30 秒上线**，无需手搓开放平台；也支持 `DSH_LARK_APP_ID/SECRET` 手动通道 |
| 🧠 **多模式 Agent** | 标准 / Code / 极简 / Cordis preset + 你在 GUI 自建的 preset，飞书发 `/mode` 出**单选卡片**即切（默认 Code：一次执行多步工具调用，更快更省） |
| 🎛 **权限分级** | 只读 / 工作区写 / **Full access** 三种权限，`/permission` 卡片即切；默认 Full access 全放行 |
| 🎨 **卡片化命令** | `/mode` `/permission` `/model` 全部是**单选按钮卡片**——点一下即切换，不用记命令拼写；模型选择按供应商分组展示 |
| 💬 **意图确认转发** | 模型提问（`ask_user_question`）→ **飞书意图确认卡片**（选项按钮 + 下拉多选 + 自定义输入），答完模型继续，飞书里完成完整交互闭环 |
| 😊 **表情回执** | 收到消息随机表情"已收到"；回复完成 / 命令完成打 **DONE ✅**（只使用飞书实测有效 emoji） |
| 💪 **出站零丢失** | 持久 Outbox（JSONL + at-least-once + 幂等键 + 分航道并行 + 失败离队不阻塞 + 周期清理），kill 重启自动续投；桥命令回复同样走 Outbox |
| 🆕 **入站请求补发** | Agent **处理到一半**插件/dsh 崩溃/重启，重启后自动重新触发这条用户消息（不再静默丢请求）——Inbound WAL 持久化 + 启动对账 + 次数上限/时间窗防空转；`/status` 显示待补发条数 |
| 🛡 **连接自愈** | probe 驱动受控重连 + QuotaGovernor 配额熔断（窗口过期**自动解除、自动重连**）+ 断连补偿；环境代理自动规避 |
| 🔀 **命令三级分流** | 桥特有命令桥处理；DSH 注册命令原生执行；`/goal`、未知 `/xxx`、普通消息原样注入 Agent（无拦截无门禁）；**skill 无前缀**——直接描述任务，模型自动加载 |
| 📎 **入站多媒体** | 飞书图片 → **视觉模型看图**（attachment 存储）；文件 → 有界文本提取进提示词 |
| 📤 **出站多媒体** | 模型经 `lark_send_local_file` 主动回传本地图片/文件（工作区白名单 + 大小校验 + 格式自动降级） |
| 🩺 **一键诊断** | `/doctor` → **ZIP 诊断包**（含当前会话完整 DSH session log + 脱敏配置 + ISSUE.md），发回飞书，贴给 AI 即可定位 |
| ✍️ **Markdown 渲染** | 回复自动检测 markdown → **CardKit 卡片**渲染（标题/列表/代码块/表格），纯文本走文本消息 |
| 🌊 **可选流式输出** | `/lark-config streaming.enabled=true` 热开 CardKit schema 2.0 流式卡片，逐字打印（默认关，省流量） |
| 🆕 **会话管理** | `/new` 当前工作区新起会话（不进 Agent）；`/workspace <路径>` 切换工作区（`~` 展开）；重启后会话 id 持久化，**不丢会话行** |
| 🖥 **复用 DSH Web GUI** | 桥 Agent = 原生 DSH session，聊天/流式/工具卡/设置全由 GUI 呈现；会话自动归入对应工作区（不再"未分组"）；Web 面板实时显示 Outbox/补发计数 |
| 👥 **访问控制** | `allowlist` 限定可对话的 open_id 白名单；`groupPolicy` 群聊触发策略（open / mention / keywords / reply）；`denyList` 命令前缀拒绝兜底 |
| 🔓 **默认 Full access** | 沙箱全访问 + 审批 never，零打扰 |

## 🚀 快速开始

**前置**：Node.js ≥ 24，已安装 DeepSeek Harness（`npm i -g @deepseek-ai/dsh`）。

**安装（官方 `dsh plugin` 机制，无侵入）**——包以官方 bundle 格式分发（`package.json` 的 `dsh.bundle` + `cordis.patch.yml`），安装后自动并入 profile 的 `dsh.profile.bundles` 层：

```bash
# 1. 安装插件（npm 官方包，装预构建产物，无需构建许可）：
dsh plugin --profile web add dsh-lark-link@latest --ignore-scripts

#   升级：
#   dsh plugin --profile web update dsh-lark-link --latest --ignore-scripts
#
#   或本地 tarball（先在源码目录 npm pack 生成，离线/内网友好）：
#   dsh plugin --profile web add ./dsh-lark-link-<version>.tgz --ignore-scripts
#
#   或 GitHub 源码（需 prepare 构建 + allowBuilds 许可）：
#   dsh plugin --profile web add github:amlyczz/dsh-lark-link
```

> **`--ignore-scripts`**：飞书 SDK 的传递依赖 protobufjs 带一个可忽略的 postinstall，pnpm 11 安全策略会拦截并返回非零退出码；加此参数跳过（protobufjs 不执行 postinstall 完全可用）。若你的 pnpm 已全局放行，可不加。
>
> **`--profile web`**：指定安装到哪个 profile（web / tui / headless）。`dsh plugin` 是 pnpm 的转发命令，用法为 `dsh plugin --profile <name> <pnpm 参数>`。想让飞书和 GUI 共用 web profile 就保持 `web`。

```bash
# 2. 启动 DSH Web GUI
dsh web

# 3. 在 GUI 的输入框（或终端 CLI）执行：
/lark setup       # 扫码创建飞书应用（30 秒，面板显示二维码）
/lark start       # 启动桥接
```

然后**飞书搜索你的机器人，发任意消息**——收到表情回执 + 完整回复即端到端连通。群聊**免 @**，直接说话即可。

## ⌨️ 命令

### DSH 侧（GUI 或终端）

```
/lark setup            扫码一键建应用（或 DSH_LARK_APP_ID/SECRET 手动通道）
/lark start|stop|restart|status   桥接生命周期与全链路健康
/lark uninstall-clean  清除凭据与状态目录
```

### 飞书侧（卡片化单选，无需记忆拼写）

| 类别 | 命令 | 行为 |
| ---- | ---- | ---- |
| 选择类 | `/mode` `/permission` `/model` | **单选按钮卡片**，点选即切换 |
| 状态类 | `/status` `/sessions` `/help` | 全链路健康（含 Outbox/补发计数）/ 会话列表 / 帮助卡片 |
| 会话类 | `/new` `/stop` `/workspace <路径>` | 新会话 / 停当前任务 / 切工作区 |
| 诊断 | `/doctor` | ZIP 诊断包（session log + 配置 + ISSUE.md） |
| 热改 | `/lark-config key=value` | 热改配置（如 `groupPolicy=open`、`agentPreset=standard`、`streaming.enabled=true`） |
| DSH 命令 | `/goal` `/compact` 等 | 原生执行，结果回飞书 |
| 多媒体 | 发图片/文件 | 图片→视觉模型；文件→文本提取 |
| 意图确认 | 模型提问 | 自动转**飞书意图确认卡片**，选项或输入作答 |

> 命令无拦截、无门禁：一切 `/` 消息要么桥处理，要么原样交 DSH——绝不停默丢弃。skill 无前缀，直接说任务即可。

## ⚙️ 常用配置（`/lark-config` 热改，立即生效并持久化）

| 配置键 | 默认 | 说明 |
| ------ | ---- | ---- |
| `groupPolicy` | `open` | 群聊触发策略：`open`（免 @ 全触发）/ `mention` / `keywords` / `reply` |
| `groupKeywords` | `["lark","小斯"]` | `keywords` 模式下的触发词 |
| `agentPreset` | `code` | Agent preset（shipped：standard/code/minimal/cordis，或 GUI 自建 id） |
| `permissionMode` | `danger-full-access` | 权限：read-only / workspace-write / danger-full-access |
| `streaming.enabled` | `false` | CardKit 流式卡片（开=逐字打印） |
| `reactions.enabled` | `true` | 表情回执 |
| `allowlist` | `[]` | open_id 白名单，空 = 所有人可对话 |
| `denyList` | `[]` | 命令前缀拒绝兜底 |
| `workspaceRoot` | `` | 桥会话工作区根目录（空 = process.cwd()） |

> 凭据（appId/appSecret）存放在 DSH credentials 服务，不进配置文件；`/lark setup` 扫码自动写入。

## 🩺 遇到问题？

1. 飞书发 `/doctor`，得到 ZIP 诊断包（完整 session log + 脱敏配置 + ISSUE.md 模板）
2. 把诊断包贴给任意 AI（或在 [飞书群](#-加入飞书群) 里发出来），即可快速定位
3. `/status` 可随时看连接 / Outbox / 补发 / 会话全链路健康

## 🛠 开发者

```bash
npm run dev:link   # 链接本地 DSH checkout（类型检查/测试需要）
npm run check      # tsc --noEmit
npm test           # 162 项单元 + 集成测试
npm run build      # tsdown → dist/（宿主 ESM + client bundle）
npm pack           # 产出可分发 tarball
```

**架构**：桥 = Cordis 插件（`dsh.bundle` 格式），分层清晰：

`host`（SDK 适配/认证）→ `inbound`（传输/群触发/断连补偿/Inbound WAL）→ `application`（命令路由/消息编排/诊断）→ `outbound`（Outbox/事件转发/卡片）→ `sessions`（每会话 Agent 管理）。

CI（GitHub Actions）：push/PR 自动跑类型检查 + 162 项测试 + 构建；发布 npm 走 tag release 的 Publish workflow。

## 💬 加入飞书群

**小斯syzs 邀请你加入飞书群**，可以交流使用问题、反馈建议、一起玩 DSH × 飞书：

👉 [https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=553i2f4a-5cc8-487f-95d3-3c4095bec0d9](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=553i2f4a-5cc8-487f-95d3-3c4095bec0d9)

## 📄 许可

MIT — 自由使用、修改、分发。

本项目为社区插件，与 DeepSeek、飞书或 Lark 无隶属关系。

---

# English

<p align="center">
  <img src="assets/mascot.png" alt="dsh-lark-link mascot" width="420"/>
</p>

**DeepSeek Harness × Feishu/Lark bridge** — put your DSH agent inside Feishu. Scan a QR code and go live in 30 seconds; chat from anywhere.

## 🌟 Why dsh-lark-link

- **Zero setup friction**: QR-scan app creation — no Open Platform fiddling, no callback URL, no public server
- **Zero message loss**: durable Outbox (outbound) + Inbound WAL — crashes, hot reloads, and dsh restarts all recover
- **Zero learning curve**: every toggle is a single-select card; native DSH commands (`/goal` `/compact` …) just work
- **A real agent**: full tool belt (bash / files / subagents / workflows) driven from Feishu

## ✨ Features

| Capability | Description |
| ---- | ---- |
| 🎯 **One-click auth** | `/lark setup` scans a QR to create the Feishu app (auto-subscribes message events + group-all + reactions). 30-second onboarding; manual `DSH_LARK_APP_ID/SECRET` channel also supported |
| 🧠 **Multi-mode Agent** | Standard / Code / Minimal / Cordis presets + your custom GUI presets; `/mode` shows a **single-select card** — tap to switch (default Code: multi-step tools in one shot) |
| 🎛 **Permission tiers** | Read-only / workspace-write / **Full access**; `/permission` card switches instantly (Full access by default) |
| 🎨 **Card-based commands** | `/mode` `/permission` `/model` are all **single-select button cards** — tap, no typing; models grouped by provider |
| 💬 **Intent confirmation** | Model questions (`ask_user_question`) land as **Feishu intent-confirmation cards** (option buttons + multi-select dropdown + custom text); answer and the agent resumes |
| 😊 **Reaction receipts** | Random "got it" reaction on inbound; **DONE ✅** on completion (only Feishu-validated emojis) |
| 💪 **Outbound zero-loss** | Persistent Outbox (JSONL + at-least-once + idempotency + per-lane parallel + failure quarantine + periodic prune), resumes after kill/restart; bridge command replies ride the Outbox too |
| 🆕 **Inbound request replay** | If the agent dies / plugin reloads / dsh restarts MID-TURN, the interrupted user message is auto re-triggered on boot (no more silently dropped requests) — durable Inbound WAL + boot reconciliation + attempt/time caps; `/status` shows the pending-replay count |
| 🛡 **Self-healing connection** | Probe-driven controlled reconnect + QuotaGovernor circuit breaker (auto-unblocks and reconnects after the quota window) + missed-message compensation; auto-avoids proxy env |
| 🔀 **3-tier command routing** | Bridge commands → bridge; DSH commands → native; `/goal`, unknown `/xxx`, plain text → injected verbatim (no gates). **Skills need no prefix** — just describe the task |
| 📎 **Inbound media** | Feishu images → **visual model** (attachment-backed); files → bounded text extraction |
| 📤 **Outbound media** | Model sends local files/images via `lark_send_local_file` (workspace whitelist + size/format checks) |
| 🩺 **One-click diagnostics** | `/doctor` → **ZIP bundle** (full DSH session log + sanitized config + ISSUE.md) back to the chat |
| ✍️ **Markdown rendering** | Replies auto-render as CardKit cards (headings/lists/code/tables); plain text stays plain |
| 🌊 **Optional streaming** | `/lark-config streaming.enabled=true` hot-enables CardKit schema 2.0 streaming cards (off by default, saves traffic) |
| 🆕 **Session management** | `/new` opens a fresh session in the current workspace; `/workspace <path>` switches (with `~`); session ids persist across restarts |
| 🖥 **Reuses DSH Web GUI** | Bridge agents are native DSH sessions; conversations auto-group under their workspace; the web panel shows live Outbox/replay counters |
| 👥 **Access control** | `allowlist` restricts inbound to specific open_ids; `groupPolicy` (open / mention / keywords / reply); `denyList` command-prefix deny |
| 🔓 **Full access by default** | Sandbox full access + never-ask approvals |

## 🚀 Quickstart

Prerequisites: Node.js ≥ 24 and DeepSeek Harness installed (`npm i -g @deepseek-ai/dsh`).

```bash
dsh plugin --profile web add dsh-lark-link@latest --ignore-scripts
dsh web
/lark setup          # scan QR (30s)
/lark start
```

Open Feishu, find your bot, send anything — reaction receipt + full reply = end-to-end. **Group chats need no @-mention.**

Install variants: local tarball (`npm pack`, then `dsh plugin --profile web add ./dsh-lark-link-<version>.tgz --ignore-scripts`) or GitHub source (`github:amlyczz/dsh-lark-link`, requires build approval). Upgrade with `dsh plugin --profile web update dsh-lark-link --latest --ignore-scripts`.

## ⌨️ Commands (Feishu side)

- **Selectors** (single-select cards): `/mode` `/permission` `/model`
- **Status**: `/status` `/sessions` `/help`
- **Sessions**: `/new` `/stop` `/workspace <path>`
- **Diagnostics**: `/doctor` (ZIP with session log)
- **Hot reload**: `/lark-config key=value`
- **DSH commands** run natively: `/goal` `/compact` …
- **Media**: send images/files to the bot
- **Intent confirmations** auto-arrive as cards

## ⚙️ Configuration (`/lark-config`, hot-reloaded & persisted)

| Key | Default | Meaning |
| --- | --- | --- |
| `groupPolicy` | `open` | group trigger: open / mention / keywords / reply |
| `agentPreset` | `code` | agent preset (standard/code/minimal/cordis or custom) |
| `permissionMode` | `danger-full-access` | read-only / workspace-write / danger-full-access |
| `streaming.enabled` | `false` | CardKit streaming cards |
| `reactions.enabled` | `true` | reaction receipts |
| `allowlist` | `[]` | open_id allowlist (empty = everyone) |
| `denyList` | `[]` | command-prefix deny |
| `workspaceRoot` | `` | workspace root for bridge sessions |

Credentials (appId/appSecret) live in the DSH credentials service, never in config files.

## 🩺 Troubleshooting

Send `/doctor` in Feishu — you get a ZIP with the full session log, sanitized config, and an ISSUE.md template. Hand it to any AI (or drop it in the [Feishu group](#-join-the-feishu-group)). `/status` shows live connection / Outbox / replay health.

## 🛠 Development

```bash
npm run dev:link && npm run check && npm test && npm run build
```

162 unit + integration tests. GitHub Actions CI runs typecheck + tests + build on every push/PR; npm publishing rides the release-tagged Publish workflow.

Architecture (Cordis plugin, `dsh.bundle` format):
`host` (SDK adapter/auth) → `inbound` (transport/group policy/compensation/Inbound WAL) → `application` (command routing/orchestration/diagnostics) → `outbound` (Outbox/event forwarding/cards) → `sessions` (per-chat agent management).

## 💬 Join the Feishu group

**小斯syzs** invites you to join the Feishu group — ask questions, share feedback, and play with DSH × Feishu together:

👉 [https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=553i2f4a-5cc8-487f-95d3-3c4095bec0d9](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=553i2f4a-5cc8-487f-95d3-3c4095bec0d9)

## 📄 License

MIT — free to use, modify, and distribute.

This is a community plugin, not affiliated with DeepSeek, Feishu, or Lark.
