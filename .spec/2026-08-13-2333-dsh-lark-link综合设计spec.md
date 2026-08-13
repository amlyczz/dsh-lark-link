# dsh-lark-link 综合设计 Spec（v1）

日期：2026-08-13 23:33
状态：待评审
作者：dsh 调研会话（pi-feishu-link 范式移植 + 三参考项目对抗性调研 + DSH Cordis 插件体系源码级调研）
调研底稿：`research/pi-feishu-link-analysis.md`、`research/reference-projects-survey.md`、`research/dsh-plugin-system-report.md`（附三个参考项目 clone）

> 参考实现状态：pi-feishu-link **0.2.2 已修复"发消息没回复"三连根因**（daemon 管道保活回归 / 僵尸锁误判 / deps 快照断链，`01f978a`+`ec64036`），262 测试全绿，可作为逐模块移植的可信基准。

---

## 0. 摘要

**DeepSeek Harness × 飞书/Lark 双向桥接插件**（正式 Cordis bundle，`dsh plugin add` 安装）：

- 扫码 30 秒上线（`registerApp` + addons 自动订阅事件/权限，二维码同时出现在终端与 Web GUI 面板）
- 消息零丢失（持久 Outbox，at-least-once + 幂等 + 分航道，kill 重启续投）
- 连接自愈（probe 驱动受控重连 + QuotaGovernor 配额熔断 + 断连补偿）
- 每飞书会话独立 DSH agent（per-key 隔离、并行不串线、映射持久化可恢复）
- 权限：**无审批，默认全放开**（所有工具调用直接放行；不接 `approval/request`，不弹审批卡）
- CardKit 流式卡片（schema 2.0 真流式，失败回退平文本）
- 命令三级分流（桥特有 / DSH 注册命令原生调 handler / 未知原样注入 agent）
- 复用 DSH Web GUI：桥会话=原生 DSH session 直接呈现（流式/工具卡/设置全复用），client plugin 只加桥特有表面（状态浮层 + setup 二维码 + 配置项）
- 一键诊断（脱敏诊断包发回飞书会话）

**与 pi-feishu-link 的最大架构差异**：pi 版用独立 daemon 进程持有飞书连接（TUI 退出不断线）；DSH 宿主插件本身运行在常驻 Node 进程（`dsh web` / CLI 宿主），经用户决策采用**进程内插件形态**——无 daemon、无文件锁、无跨进程状态，生命周期交给 Cordis `ctx.effect()` 可逆注册。

**用户核心方法论约束**（沿袭 pi 项目）：TDD first（先写失败测试再实现）、Spec first、卸载干净、全部放开（无命令拦截）、分层纪律。

---

## 1. 需求与决策（已与用户确认）

| # | 决策点 | 结论 |
| --- | --- | --- |
| D1 | 部署形态 | **进程内 Cordis 插件**（DSH 宿主退出桥即断；不做独立 daemon） |
| D2 | 会话模型 | **每飞书会话独立 DSH session**（per-conversation-key，映射持久化） |
| D3 | 认证 | **保留扫码一键建应用**（registerApp + addons），手动 appId/appSecret 兜底 |
| D4 | Web UI | **复用 DSH Web GUI**（用户 D6 追加）：不另起 UI，桥 agent=原生 DSH session 天然在 GUI 呈现；client plugin 只加桥特有表面（状态/二维码/配置） |
| D5 | 调研结论 | 三参考项目均**无 at-least-once 出站持久化**——这是 pi-feishu-link 已验证的最高价值差异点，必须保留 |

---

## 2. 总体架构

### 2.1 架构图

```
飞书 WS 长连接（@larksuiteoapi/node-sdk WSClient，autoReconnect:false）
   │  supervisor: probe(30s REST 心跳) + 静默检测 + 退避重连 + QuotaGovernor 熔断
   ▼
L1 transport → normalizeInbound → dedupe → 群策略(open/mention/keyword/reply) → 三级分流:
   ├─ 桥特有命令(/status /doctor /lark-config /help /workspace /stop /sessions) → 桥处理
   ├─ DSH 注册命令 → 查 ctx.commands 注册表 → 原生调 handler(agent, rawInput)
   └─ 其他(/goal /skill:x 未知 /xxx 普通消息) → agent.followup() 注入
   ▼
L2 ConversationManager (per-key Agent + FIFO PromptQueue + idleTtl 回收 + 映射持久化)
   │  ctx.agents.create()/resume() · session/event 订阅 · agent.cancel() 中断
   ▼
L3 双通道出站:
   ├─ LiveChannel(易失): assistant/chunk text-delta → CardKit 流式卡 patch
   └─ Outbox(持久 JSONL, at-least-once): assistant/message 定稿 / turn/end DONE / 通知
   ▼
飞书 REST（回复/卡片/媒体/表情）
```

### 2.2 分层纪律（沿用 pi-feishu-link，层名对齐 DSH 语义）

| 层 | 目录 | 职责 | 规则 |
| --- | --- | --- | --- |
| L0 host | `src/host/` | setup 扫码、插件生命周期装配、卸载卫生 | 只懂 DSH Cordis ctx |
| L1 inbound | `src/inbound/` | 飞书协议：transport、supervisor、补偿、附件、群策略 | 只懂飞书，**不许 import DSH** |
| L2 sessions | `src/sessions/` | DSH 编排：conversation-manager、dsh-session-backend、turn-supervisor | 只懂 DSH API，**不许 import 飞书 SDK** |
| L3 outbound | `src/outbound/` | outbox、live-channel（CardKit）、outbound-router、event-forwarder | 两者之间唯一可靠通道；sender 注入，**零 DSH/零飞书 import** |
| L4 presentation | `src/presentation/` | 卡片构建（markdown/状态/帮助/setup） | 纯函数 |
| 应用服务 | `src/application/` | bridge-context（依赖倒置）、message-handler、command-router、notification-service、diagnostics-service、status-formatter | 只依赖各层接口 |
| 共享 | `src/common/` | types、config、quota-governor、reactions、dedupe、logger、status | 零外部依赖 |
| GUI | `src/client/` | client plugin（slots 面板） | 只懂 `ctx.slots`/`ctx.remote` |

**跨层不走直接引用**：`application/` 通过 `BridgeContext` 注入（接口同 pi 版 §4 BridgeContext）。**DSH API 只在 `sessions/dsh-session-backend.ts` 与 `host/` 出现**——与 pi 版"pi SDK 只在 pi-session-backend 一处"同构。

### 2.3 pi → DSH 集成点映射表（移植的核心翻译层）

| pi-feishu-link | DSH 等价物 | 出处（DSH 源码） |
| --- | --- | --- |
| `pi.registerCommand("feishu", …)` | `ctx.commands.register({name, handler})`（handler 直接执行不经模型） | `packages/interaction/commands` |
| `pi.on("message_end")` → 定稿回复 | `ctx.on('session/event')` 过滤 `assistant/message` + `turn/end` | `docs/subsystems/session.md` |
| 流式 delta（subscribe） | `session/event` 的 `assistant/chunk`（text-delta） | 同上 |
| `pi.on("tool_call")` + gate `{block}` | `tools/pre-execute` waterfall 返回 `{allow}/{deny}/{ask}` | `packages/core/tools` |
| ~~审批卡（PermissionBridge）~~ | **无审批（用户决策）**：不接 `approval/request`，`tools/pre-execute` 不挂钩子，默认全放行 | — |
| `session.prompt(text, {streamingBehavior:"followUp"})` | `agent.followup(message)`（排队、空闲唤醒） | `packages/core/agent/runtime-types.ts` |
| `createAgentSession` / `SessionManager.open` | `ctx.agents.create()` / `ctx.agents.resume()` | `docs/subsystems/core.md` |
| `setModel/compact/executeBash` 等适配 | P2：DSH 无统一等价面，一期走"命令注入 agent"策略（见 §5） | — |
| 状态目录 `~/.pi/agent/feishu-link/` | `<DSH_HOME>/lark-link/`（config/outbox/routes/logs 自管文件，宿主插件有完整 fs 能力） | `DSH_HOME` 默认 `~/.dsh` |
| appSecret 存 config.json(600) | **appSecret 存 `ctx.credentials`**（`.credentials.yaml`），其余配置仍 config.json | `packages/credentials` |
| pi 无卸载钩子 → daemon 自监控轮询 | **Cordis `ctx.effect()` disposer**：插件卸载自动 teardown（释放 WS/定时器/会话）；状态目录保留（配置不删，防误删密钥），提供 `/lark uninstall-clean` 显式清理 | cordis-primer |
| `pi.registerTool(feishu_send_local_file)` | `ctx.tools.register(defineTool({name:'lark_send_local_file',…}))` | `docs/cookbook/adding-a-tool.md` |
| systemPromptOverride 注入飞书提示词 | `ctx.systemPrompt.section(...)` | `packages/core/system-prompt` |
| my-pi-scheduler（可选依赖） | **DSH 内置 `packages/schedule`**：桥捕获定时触发结果经路由回投（P1） | `docs/subsystems/schedule.md` |
| qrcode-terminal 终端二维码 | 终端（CLI 模式）+ **GUI 面板渲染二维码图**（P0 双通道） | — |

### 2.4 ADR 表（移植 + 新增）

| ADR | 决策 | 来源 |
| --- | --- | --- |
| ADR-1 连接层 | WSClient `autoReconnect:false`，supervisor 受控重连（SDK 无限重试烧配额） | 移植 |
| ADR-2 静默检测 | probe 健康时不重建（空闲不误杀）；probe 持续失败才重建 | 移植 |
| ADR-3 配额熔断 | QuotaGovernor：60min/12 次失败熔断，落盘 `conn-history.jsonl` 跨重启生效；熔断后**降级为插件内休眠 + 状态上报**（进程内插件不能 `process.exit`，改为禁用桥并提示） | 移植+改造 |
| ADR-4 出站 | Outbox 持久化 at-least-once（kill 重启续投）；**失败消息移出 lane 队尾定时重试，退避有界封顶**（pi 版 F1 教训内建） | 移植 |
| ADR-5 会话 | per-key Agent + sessionId→key 持久映射（`ctx.storage.domain` KV），idleTtl 回收内存，重启 resume 恢复 | 移植+参考 pi-remote-feishu SessionHostManager |
| ADR-6 权限 | **无审批，默认全放开**：所有工具调用直接放行；不注册 approval 应答者、`tools/pre-execute` 不挂钩子。仅保留可选 `denyList`（默认空，命中直接拒绝并返回错误，**不询问不弹卡**） | 用户决策（2026-08-13）；pi 版 relaxed 模式极端化 |
| ADR-7 命令 | 三级分流，无 blocked 无 admin 门禁 | 移植；DSH 注册命令原生调 handler |
| ADR-8 流式 | **CardKit schema 2.0 真流式**（streaming_mode + print_frequency/step，关流先 PATCH settings 再 PUT 全量卡），sequence+uuid 防乱序，失败回退平文本 patch | 采 pi-feishu-lark 精华（优于 pi 版 patch 流） |
| ADR-9 表情 | 收到→随机（池排除 DONE，池内 8 枚实测有效）；完成→DONE | 移植（含 F2 教训：只用实测有效 emoji_type） |
| ADR-10 卸载 | `ctx.effect()` disposer 自动 teardown；状态目录默认保留，显式命令清理 | 改造（进程内形态） |
| ADR-11 会话队列 | per-key PromptQueue（promise 链串行），**不用全局锁**；`/stop` 只 cancel 本会话 agent | 采 pi-remote-feishu 精华 |
| ADR-12 单实例 | 进程内形态天然单实例（一个宿主一份插件）；**多宿主场景**（web+CLI 同开）用 `<DSH_HOME>/lark-link/gateway.json` `wx` 原子锁 + 心跳，抢锁失败者禁用桥 | 简化移植 |
| ADR-13 配置 | 热改白名单（groupPolicy/streaming/keywords/policy…）立即生效落 `runtime-overrides.json`；**禁改 appId/appSecret**（走 setup/credentials） | 采 pi-feishu-lark 精华 |
| ADR-14 依赖 | `@larksuiteoapi/node-sdk` 用 `^` 宽范围 + peerDependencies 声明 DSH 包 `*`；**不 pin 版本** | pi-remote-feishu 糟粕教训 |

---

## 3. 模块设计

```
dsh-lark-link/
├── package.json            # "dsh":{"bundle":{"patch":"./cordis.patch.yml"},"client":{...}}
├── cordis.patch.yml        # - insert: [{id: lark-link, name: 'dsh-lark-link', config: {...}}]
├── tsconfig.json
├── src/
│   ├── index.ts            # 薄装配层：构建 BridgeContext + ctx.effect 注册（<400 行）
│   ├── client/index.ts     # client plugin 入口（GUI 面板）
│   ├── host/
│   │   ├── auth-setup.ts        # 移植：registerApp + addons（REQUIRED_EVENT/SETUP_SCOPES 原样）
│   │   ├── gateway-lock.ts      # wx 原子锁 + 心跳（多宿主防护）
│   │   └── lifecycle.ts         # 装配/teardown/卸载清理
│   ├── inbound/
│   │   ├── transport.ts         # SDK 封装 + v2.0 事件归一化（normalizeInbound 移植）
│   │   ├── connection-supervisor.ts  # probe 心跳/静默/退避重连
│   │   ├── missed-compensation.ts    # 断连补收（真实 chat_id + skipDedupe 回放）
│   │   ├── group-trigger.ts          # open/mention/keywords/alsoOnReply
│   │   └── attachment-pipeline.ts    # 图片→视觉、文件→有界文本提取
│   ├── sessions/
│   │   ├── conversation-manager.ts   # per-key 编排（FIFO + idleTtl + 常驻上限）
│   │   ├── dsh-session-backend.ts    # ★唯一 DSH agent 依赖点：create/resume/followup/cancel/事件订阅
│   │   └── turn-supervisor.ts        # turn 看门狗（超时 dispose 解锁）
│   ├── outbound/
│   │   ├── outbox.ts            # JSONL 段 + 幂等键 + 分航道 + 失败离队重试（F1 修复内建）
│   │   ├── cardkit-stream.ts    # CardKit 流式卡（采 pi-feishu-lark cardkit-stream.ts）
│   │   ├── outbound-router.ts   # sessionKey→chat 路由 + 定时任务回投
│   │   └── event-forwarder.ts   # session/event → LiveChannel/Outbox 分拣
│   ├── application/
│   │   ├── bridge-context.ts    # BridgeContext 接口（依赖倒置）
│   │   ├── message-handler.ts   # 入站编排（去重/表情/路由/注入）
│   │   ├── command-router.ts    # 三级分流
│   │   ├── notification-service.ts
│   │   ├── diagnostics-service.ts    # 脱敏诊断包
│   │   └── status-formatter.ts       # 纯函数
│   ├── presentation/
│   │   ├── cards.ts             # 状态卡/帮助卡/setup 卡/欢迎卡/命令面板（schema 2.0；按钮平铺 body.elements + behaviors callback + width fill，无 tag:action——pi 2026-08-14 200861 修复）
│   │   └── rich-text.ts
│   └── common/
│       ├── types.ts  config.ts  quota-governor.ts  reactions.ts
│       ├── dedupe-store.ts      # 跨进程目录锁 + TTL prune
│       ├── connection-status.ts logger.ts  diagnostics.ts  scheduler-detect.ts
├── test/unit/                  # 镜像 src/ 结构
└── test/integration/           # kill-9 一致性 · 分航道隔离 · 断连补偿
```

**`dsh-session-backend.ts` 接口草图**（唯一 DSH 依赖点，可 mock 单测）：

```ts
export interface DshSessionBackend {
  ensureAgent(key: string): Promise<AgentHandle>          // create 或 resume（storage.domain 查映射）
  followup(key: string, text: string, files?: Attachment[]): Promise<void>
  cancel(key: string): Promise<void>                      // /stop：只停本会话
  onEvent(key: string, fn: (e: SessionEvent) => void): () => void  // scope-filtered 订阅
  disposeIdle(idleTtlMs: number): void
}
export interface AgentHandle { agentId: string; sessionId: string }
```

---

## 4. 命令体系

### 4.1 DSH 侧（CLI / Web GUI composer）

```
/lark setup       扫码建应用（终端出二维码 + GUI 面板显示；手动 appId/Secret 兜底）
/lark start       启动桥接（建立 WS + supervisor + outbox drain）
/lark stop        停止（不断凭据/配置）
/lark restart     重启
/lark status      全链路健康视图（ConnState/outbox 深度/会话数/熔断状态）
/lark doctor      生成诊断包（权限自检 + 脱敏）
/lark config k=v  热改配置（白名单内，如 groupPolicy=mention）
```

实现：`ctx.commands.register`，handler 直接执行（DSH 命令不经模型，`command/run`/`command/done` 落 session 日志）。

### 4.2 飞书侧（三级分流，无拦截无门禁）

| 类别 | 命令 | 行为 |
| --- | --- | --- |
| 桥特有 | `/status` `/workspace` `/stop` `/doctor`（`/support` 旧名兼容）`/sessions` `/lark-config` `/help` | 桥处理（状态/工作区/中断本会话 agent/诊断/热改） |
| DSH 注册命令 | 查 `ctx.commands` 注册表命中（如 `/lark-*` 及用户安装的其他插件命令） | **原生调 `handler({agent, rawInput})`**，结果回飞书 |
| 原生注入 | `/goal`、`/skill:name`、模板、未知 `/xxx`、普通消息 | **原样 `agent.followup()`**，输出经事件流回飞书 |
| 定时任务 | `/schedule` 等 | 转发 DSH schedule 子系统（P1，未装给指引） |

> DSH 无 `commands/pre-handle` 拦截点（调研确认不存在）——分流在桥自己的 inbound 编排内完成，不动 DSH 命令服务。

### 4.3 权限模型（无审批，默认全放开）

**用户决策（2026-08-13）**：不要审批，权限默认全放开。

```
agent 工具调用
  → 直接执行（无拦截、无询问、无弹卡）
```

- 不注册 `approval/request` 应答者；`tools/pre-execute` / `tools/post-execute` 不挂钩子——DSH 默认链即全放行
- 不设 owner/admin、不设群聊权限、不设审批记忆
- 唯一可选兜底：`denyList` 配置（默认空数组）。命中时**直接拒绝执行并返回错误**（纯 deny，不询问、不弹卡），用于挡住用户明确不要的个别命令；可随时热改
- GUI/飞书侧都不出现审批 UI（DSH GUI 审批卡只在其他插件触发时存在，桥不触发）

---

## 5. 可靠性矩阵（故障模式 → 对策 → 来源）

| 故障模式 | 对策 | 来源/教训 |
| --- | --- | --- |
| 发消息没回复（lane 卡死） | 失败消息移出队尾 + 退避有界封顶（≤60s）+ attempts 上限转 fatal | **pi 版 F1 根因，设计内建** |
| WS 断了不自愈 | autoReconnect:false + supervisor probe 驱动重建 | pi 版 ADR-1/2 |
| 配额烧穿（1000040350） | QuotaGovernor 60min/12 熔断 + 落盘跨重启；进程内改休眠+上报 | pi 版 ADR-3 改造 |
| 事件订阅缺失（连上收不到消息） | setup addons 显式订阅 `im.message.receive_v1` + 创建后 verifyEventSubscription 自检 | pi 版实机教训 |
| 事件解析静默丢 | normalizeInbound 兼容 v2.0 嵌套（message_id 在 event.message） | pi 版"终极根因" |
| 空闲误判僵尸 | probe 健康不重建 | pi 版 ADR-2 |
| 回复半截 | CardKit 流式卡类型一致；关流 PATCH settings→PUT 全量 | pi 版 ADR-8 + pi-feishu-lark |
| 断连消息丢失 | missed-compensation 真实 chat_id 拉取 + skipDedupe 回放 | 移植 |
| 进程 kill 回复丢失 | Outbox JSONL at-least-once + 幂等键 + 重启 rebuildFromDisk | 移植（三参考项目都没有，核心差异点） |
| 多宿主并发（web+CLI） | gateway.json wx 原子锁 + 心跳，抢锁失败禁用桥 | 简化移植 |
| 表情 400 | 池内 8 枚实测有效 emoji_type，DONE 独立 | pi 版 F2 |
| 异步分发静默丢消息 | inbound 全链路 await + 缺依赖显式报错（禁止 fire-and-forget 吞错） | pi 版故障点 #4 教训 |
| **deps 快照断链** | **BridgeContext/Deps 的可变字段一律 getter 化 lazy resolve，禁止装配期快照**（pi 版断链根因：startBridge 前构造 deps，outbox 等恒 undefined → 消息静默丢弃；Cordis inject 异步激活有同构风险） | pi 版 01f978a 根因 #3，已实机确认 |
| 探活瞬态错误崩溃 | probe/网络调用重试+降级（ECONNRESET 等瞬态错误不崩溃），只有持续失败才 degrade | pi 版 ec64036，已实机确认 |
| 锁持有者存活校验 | gateway 锁读取必须校验 pid 存活（readLive 语义），僵尸锁自动清理 | pi 版 01f978a 根因 #2，已实机确认 |
| DSH 子进程剥 `DSH_*`/密钥 env | 桥不起子进程持凭据；凭据走 ctx.credentials per-op resolve | DSH 调研 §5.1 |

---

## 6. 配置与状态布局

```
<DSH_HOME>/lark-link/           # DSH_LARK_LINK_HOME 可覆盖
├── config.json                 # 桥配置（600）：appId 引用、groupPolicy、permissions、streaming…
├── runtime-overrides.json      # 热改白名单落盘
├── credentials → ctx.credentials  # appSecret 唯一存放点（ref 风格，config.json 只存引用 key）
├── state/
│   ├── routes.json             # OutboundRouter 路由 + 投递去重 sent(30d)
│   ├── gateway.json            # wx 原子锁 + 心跳
│   ├── conn-history.jsonl      # QuotaGovernor 熔断历史
│   ├── dedupe.jsonl            # 入站去重（目录锁 + TTL prune）
│   └── storage.domain          # sessionKey↔sessionId 映射（ctx.storage.domain KV）
├── outbox/seg-*.jsonl + blobs/ # 持久出站（7 天终态保留 + pending 永不淘汰 + 容量硬顶）
└── logs/                       # 桥日志（诊断包来源）
```

环境变量约定：`DSH_LARK_LINK_*` 前缀（遵守 boot 保留 `DSH_` 前缀规则；不写 `.env`）；`cordis.patch.yml` 的 `config:` 用 `!!js "process.env.DSH_LARK_LINK_ENABLED ?? 'true'"` 插值。

---

## 7. Web UI：复用 DSH Web GUI（client plugin 只做桥特有表面）

**设计原则（用户决策 D6）**：不另起一套 Web UI。桥创建的每飞书会话都是**原生 DSH session**，DSH Web GUI 已天然提供完整会话视图——聊天流式渲染、工具调用卡片、会话列表、设置页全部复用，零开发。client plugin 只负责注入**桥特有**的少量表面：

| 复用（零开发） | 说明 |
| --- | --- |
| 会话聊天视图 | 桥 agent 的 `assistant/chunk` 流式、`tool/call` 卡片、`assistant/message` 定稿，GUI 原生渲染 |
| 会话列表/切换 | 每飞书会话 = 一个 GUI 会话条目，可直接点击查看/继续 |
| 设置页 | 桥配置注册进 `settings.section`，复用 DSH 设置交互 |

| 新增（client plugin，少量） | 槽位 |
| --- | --- |
| "Lark Link"侧栏入口 → 桥状态浮层（连接灯/outbox 深度/熔断/quota/活跃会话数 + start/stop/restart） | `sidebar.footer.action` + `shell.overlay` |
| setup 二维码 | 面板内渲染 QR（`ctx.remote` 调宿主 setup → 前端生成图），扫码状态轮询 |
| 配置热改（桥特有白名单项） | `settings.section` 追加一组表单项 |
| 桥事件镜像 | `conversation.chat.node` 插入"已转发到飞书/来自飞书"小标记（可选，P1） |

打包：同包 `package.json` 声明 `"dsh":{"client":{"inject":["slots","connection","remote"],"platform":"web"}}` + `exports["./client"]`，构建用 `packages/client/tsdown.client.ts` preset。宿主侧配套：桥状态查询/控制经 `ctx.remote` 能力暴露（不另起 HTTP 端口）。

> 双通道视图：本地在 DSH Web GUI 看全量会话；远程在飞书看卡片。两者是同一批 DSH session 的两个投影。

---

## 8. 安全设计

- 凭据：appSecret 仅存 `ctx.credentials`；诊断包脱敏（掩码/hash）；config.json 600
- 权限：无审批、默认全放开（见 §4.3）；可选 `denyList` 纯 deny 兜底（默认空，热改即时生效）
- 群策略：open/mention/keywords/alsoOnReply 可配；用户 allowlist 可选（采 pi-lark-notify userId 白名单思想）
- 文件回传工具 `lark_send_local_file`：路径白名单 + 大小上限（采 pi-remote-feishu）
- 交互选择 pending 态 60s 超时，防误消费后续消息
- 宿主 HTTP 仅 loopback：桥不暴露任何对外 HTTP 端口（飞书走 WS 出站），无鉴权面

---

## 9. 测试策略（TDD first）

- 框架：**node:test + tsc --noEmit**（零额外 dev 依赖，沿袭 pi 项目风格；DSH 包仅 peerDependencies + 类型 import）
- 测试镜像 src 结构；先写失败测试再实现
- 关键覆盖矩阵：
  - normalizeInbound 事件结构矩阵（v2.0 嵌套/缺字段/卡片动作/引用/附件）
  - supervisor 静默/熔断/冷却；quota-governor 落盘跨重启
  - outbox：崩溃恢复（sending→pending）、分航道隔离、失败离队不阻塞、幂等键、blob spill
  - conversation-manager：FIFO、idleTtl、dispose 后路由不丢、映射持久化恢复
  - 权限：默认全放行直通（无钩子即无门禁）；denyList 命中直接拒绝（含热改即时生效）
  - command-router 三级分流矩阵
  - dsh-session-backend：**mock ctx.agents/session/event** 的契约测试
  - 断连补偿（skipDedupe 回放）、CardKit 关流序列、表情池有效性
  - 卸载卫生（disposer 释放全部资源）
- 集成测试：kill-9 一致性、双宿主抢锁

## 10. 命令

```bash
npm run check    # tsc --noEmit
npm test         # node --experimental-strip-types --test "test/**/*.test.ts"
npm run build    # tsc（宿主侧 ESM）+ tsdown.client（client 半边）
```

## 11. 里程碑（每步 TDD，全绿才推进）

| M | 内容 | 验收 |
| --- | --- | --- |
| M1 骨架连通 | bundle 骨架 + config/credentials + transport 连接 + 私聊回声（不过 agent） | 飞书发消息收到回声；/lark status 显示 connected |
| M2 会话核心 | conversation-manager + dsh-session-backend + followup + assistant/message 定稿 + outbox | 飞书提问收到 agent 完整回复；kill -9 重启续投 |
| M3 体验 | CardKit 流式 + 表情回执 + 命令三级分流（无审批，默认全放开） | 逐字流式；任意命令直接执行不询问 |
| M4 可靠性 | supervisor + quota + 断连补偿 + gateway 锁 | 断 WS 自动恢复补收；配额熔断不烧穿 |
| M5 上线闭环 | setup 扫码（终端+GUI）+ 面板 + 诊断包 | 扫码 30s 上线；面板状态实时；/doctor 收到诊断文件 |
| M6 增强 | 定时任务回投（DSH schedule）、多媒体附件、群策略全量 | 说"每天 9 点总结"可创建并回投；图片进视觉模型 |

## 12. Success Criteria

1. 飞书私聊发消息，流式看到回复，完成打 DONE 表情；群聊 mention 触发正常
2. 桥进程 kill -9 后重启，pending 回复自动续投，无重复无丢失
3. 工具调用**默认全部直接放行**，无审批无询问；denyList（默认空）命中直接拒绝并返回错误
4. `/lark setup` 扫码后 30s 内端到端连通（含事件订阅自检）
5. DSH Web GUI 原生呈现桥会话（聊天/流式/工具卡），桥特有表面（侧栏入口/状态浮层/setup 二维码/配置项）可见可用
6. 全部测试绿 + `tsc --noEmit` 干净；实机验收矩阵过（M1-M6）

## 13. Boundaries

- **Always**：TDD（先失败测试）；分层纪律（L1 不碰 DSH、L2 不碰飞书 SDK、outbox 零依赖）；**可变依赖 getter 化 lazy resolve（禁装配期快照）**；锁读取必须校验持有者存活；配置热改走白名单；凭据只进 ctx.credentials
- **Ask first**：新增 npm 依赖；改 cordis.patch.yml 默认 config；引入对外 HTTP 端口；**重新引入任何审批/询问机制**
- **Never**：不 pin `@larksuiteoapi/node-sdk` 精确版本；不用 SDK autoReconnect；不 fire-and-forget 吞异步错误；不在 `.env` 写 `DSH_*`；不注册 approval 应答者（除非用户明确要求恢复）；不删用户状态目录除非显式命令

## 14. 开放问题

1. **DSH 内置命令适配深度**：`/model` `/compact` 等 pi 版深度适配依赖 DSH 是否有等价 session API（调研未确认统一面）——v1 走"注入 agent"降级策略，待 DSH 侧确认后升级（P2）
2. **registerApp 在 DSH CLI（非 TTY）环境的二维码降级**：GUI 面板已覆盖主场景；纯 headless 环境给手动 appId/Secret 通道
3. **多宿主场景**（web + CLI 同时跑）的桥归属：gateway 锁先到先得，是否需要"指定宿主"配置？（P2）
4. **DSH schedule 子系统的结果回投协议**：如何捕获定时任务的完成事件（需读 `packages/schedule` 事件面，M6 前确认）
5. ~~client plugin 与宿主桥的 RPC 通道~~ **已定**：复用 GUI → 桥状态/控制经 `ctx.remote` 能力暴露（不另起 HTTP 端口，§7）
6. ~~approval 无 allow-always / 桥级免询问白名单~~ **已解决**：用户决策无审批、默认全放开（§4.3），本项作废

---

## 附：移植清单（从 pi-feishu-link 直接搬模块，改造点标注）

**零改动移植**（harness-agnostic）：`outbox.ts`、`quota-governor.ts`、`dedupe-store.ts`、`reactions.ts`、`group-trigger.ts`、`missed-compensation.ts`、`turn-supervisor.ts`、`connection-supervisor.ts`、`cards.ts`/`rich-text.ts`（渲染）、`diagnostics.ts`、`status-formatter.ts`

**改造移植**：`transport.ts`（不变，SDK 相同）、`auth-setup.ts`（registerApp 同 SDK，二维码输出改双通道）、`conversation-manager.ts`（AgentSession→DshSessionBackend）、`gateway-lock.ts`（简化为多宿主防护）、`outbound-router.ts`（定时任务改 DSH schedule）

**删除**（用户决策无审批）：`permission-bridge.ts`、`tool-call-gate.ts`、审批卡渲染——不接 `approval/request`、`tools/pre-execute` 不挂钩子；仅保留 `denyList` 纯 deny 兜底（可选，默认空）

**重写**：`pi-session-backend.ts`→`dsh-session-backend.ts`、`index.ts`（pi.on/registerCommand→Cordis ctx 装配）、新增 `client/`（GUI 面板）

**新采**（三参考项目精华）：`cardkit-stream.ts`（pi-feishu-lark）、per-key PromptQueue 无全局锁（pi-remote-feishu）、进程级单例+孤儿清理思想（pi-lark-notify，进程内形态下退化为插件单例）
