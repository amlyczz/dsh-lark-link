# Changelog

## 0.3.2

### Docs

- README mascot image now uses an absolute URL so it renders on npmjs.com (npm does not resolve relative image paths).

---

## 0.3.1

### Bugfix: session id collision on idle disposal (GH #5)

- **Root cause**: when `disposeIdle` removed an agent, the `generations` counter was not bumped. The next `ensureAgent()` reused the same session id, which collided with the persisted log left by the disposed agent — DSH rejected the first turn with "id collision", silently dropping the message.
- **Fix**: `dsh-adapter.ts` `disposeIdle` now synchronously removes from `tracked`, bumps `generations`, and THEN fire-and-forgets the async dispose. `conversation-manager.ts` tracks `agentId` per hook and re-attaches the fan-out listener when the agent changes.
- **Regression test**: `manager: idle sweep then message still gets reply (stale hook after disposal)`

### New: per-conversation workspace / model / mode + hung-turn recovery

- `workspace` / `model` / `mode` overrides are now scoped **per conversation key** (persisted `conversation-overrides.json`); other chats no longer follow a switch when their agent is rebuilt (idle TTL, `/new`, maxSessions pressure).
- Live model entries are per-key mutable objects for `installModelSelection`; follower chats (no `/model` override) track the bridge default — and the deployment default is polled so a GUI-side model switch is adopted and announced in Feishu.
- Watchdog: an EMPTY assistant message no longer disarms the turn watchdog (fixes the hung-chat-until-`/new` bug); text chunks and tool events refresh the deadline.
- Card action callbacks get unique pseudo message ids so a second click on the same card (model picker) is not swallowed by outbox dedupe; `chatType` resolved from the route table instead of hardcoded p2p.
- `lark_send_local_file` resolves the per-conversation workspace.

### Other

- Fixed `/lark restart` pgrep pattern to match the `dsh web` invocation.
- Updated Feishu group invite link.

---
## 0.3.0

**新增：入站请求补发（服务中断/插件更新/dsh 重启也能把没回答的消息补回来）**

- **多选意图确认卡片**：`ask_user_question` 的 `multi_select: true` 现在会渲染飞书 schema 2.0 的 `multi_select_static` 下拉多选 + 提交按钮，回调经 `uqam:<id>` op 回传选中的多个选项（此前会被单选的按钮卡片忽略多选标记）。（GH #5）

- **核心保证**：一条用户消息被 Agent **接受但处理到一半**（进程被杀 / 插件热更新 / dsh 重启）时，之前会静默丢失（dedupe 已消费、断连补偿只覆盖 WS 掉线窗口）。现在这类请求会持久化进 Inbound WAL（`<state>/inbound-wal/`），重启后自动重新触发、把回答补发给用户。
- **实现**：新增 `src/inbound/inbound-wal.ts`（崩溃安全的 JSONL 耐久日志，复用 outbox 的 `wx`+rename 落盘纪律）；message-handler 在交给 Agent 前只记录**纯文本**请求（媒体/命令不记）；turn 的可交付输出落盘（outbox 入队 / 流式卡定稿）即标完成；启动时对账，把"已接受但未交付"的请求重新投递（`handleCompensated`，跳过 dedupe）。
- **防空转**：每个请求限重放次数（默认 2 次）+ 重放时间窗（默认 30 分钟），损坏/超时的请求不会无限循环。
- **透明可见**：`/status` 与 Web 面板新增「补发」计数，显示待补发条数，补完后归零。
- **边界**：仅纯文本请求纳入补发；指令/图片/文件等不可靠重放对象不记录。幂等（dedupeKey + 已交付跳过）保证不会重复回答。

### 可靠性 / 稳定 · 5 项修复

针对「消息不丢失 + 各种中断补发 + 稳定」的安全网加固：

- **#1 修复：outbox 磁盘无限膨胀** —— `outbox.prune()` 从未被调用，`done/fatal` envelope 超保留期(默认 7 天)永不清理。现 `start()` 自调度周期清理（约 1h，可 `pruneIntervalMs` 覆盖），磁盘 segments 不再无限增长。
- **#2 修复：命令回复不再裸发** —— `bridgeHandler` 的桥命令回复（`/status /help /sessions /workspace /lark-config /mode /permission /model /new /stop …`）原直接 `sender.replyTo`（裸 await，进程死在此刻即丢），现全部改走 **durable outbox**（`command-reply`，幂等 dedupeKey），进程崩溃/重启自动补发（DSH 注册命令回复本就走 outbox，桥命令现已对齐）。
- **#3 修复：流式卡定稿失败 → 降到 outbox** —— `cardkit-stream.finalize` 原先**吞掉** final PUT 错误（卡停在"正在流式打印"，内容丢失也不报错）。现 final PUT / 无卡时 Create 失败会 **re-throw**，event-forwarder 捕获后落回 durable outbox，内容绝不丢。
- **#4 修复：/status 计数不实时** —— outbox 计数只在启动/60s 定时刷新。现 outbox 增加 `onStatsChange` 回调，随投递/失败/入队/清理实时刷新 `outboxPending/outboxFailed`，`/status` 与 Web 面板实时反映。
- **#5 修复：熔断后需手动重启才恢复** —— 熔断（quota breaker / 重连耗尽）后原需人工 `/lark restart`。现 connection-supervisor 在 **配额窗口过期后自动解除熔断、自动重连**（`tick` 检测 `resetAt`），完全自愈无需干预。


---

## 0.1.1（未发布）

对齐 pi-feishu-link 2026-08-14 实机修复轮：

- **修复：DSH Web GUI 中输入 `/lark setup` 被当普通消息交给模型**（实测根因）。ui-commands 的 `matchEnter` 只对定义了 `input` 的命令执行带参命令，否则非裸斜杠行回落到 agent。`lark` 命令现注册 `input: { hint }`；同时飞书侧 `/lark` 子命令补上分发（bridgeHandler 原缺 `lark` case）
- **修复：`/lark setup` 的 registerApp 报 `Protocol "https:" not supported. Expected "http:"`**。SDK 的 `defaultHttpInstance` 用 axios，其 1.19.x 的 `exports.default.default → index.js`（lib 源码入口）在 Node ESM 下平台解析错位，把 https 请求赶进 `http.request`。改用 fetch 实现的同协议 registerApp（device-code 流程，RFC 8628：begin → QR → poll），二维码/addons 编码与 SDK 字节兼容
- **修复：飞书发消息无响应——环境 proxy 变量导致 WS 连不上**。宿主 shell 带 `http_proxy/https_proxy` 时，SDK 共享 axios 实例按 env 走代理，axios 把 https URL 赶进 `http.request` 报协议错误，WS 端点发现与长连接全部失败。`buildLarkClient` 现对 SDK 自己的 `defaultHttpInstance` 设 `proxy:false`（保留其 response 解包拦截器；新建裸 axios 会破坏 `{code,data,msg}` 解析）。另修 status 面板 `wsReady` 从未写入状态存储的问题
- **修复：表情回执全部 400**——默认池含无效 emoji（FIRE/ROCKET/SUN/WHITE_CHECK_MARK，飞书 231001）。对齐 pi-feishu-link 的实测有效集合（大小写敏感：Fire 有效 FIRE 无效），DONE 用 `DONE` 表情；完成 DONE 表情接线（streamFor 返回真实 StreamTarget，对触发消息打 DONE，message-handler 记录 lastMessageId）
- **修复：飞书侧 DSH 注册命令（/goal 等）全部失效**——原调 `commands.run()` 方法不存在。改调 DSH 真实 API `commands.find(agent,name)` + `commands.execute(agent,line,signal)`
- **诊断包增强**：`/doctor` 从纯文本回复改为上传诊断报告文件发回飞书（对齐 pi 设计，上传失败回退文本）
- **修复：bridge agent 无任何工具**（session log 实锤 `unknown tool "bash"/"write_file"/"list_tools"/"goal_get"`）——web profile 在宿主平面禁用工具行、按会话挂载 preset；bridge 创建 agent 时未指定 preset 导致零工具。现 `meta.agentPreset: "standard"`（含 bash/fs/goal/subagent/workflow 全套）
- **修复：`lark_send_local_file` 报「无法定位当前飞书会话」**——agent.id 带每运行 nonce 后缀而 route key 不带；改用 backend.keyForSessionId 反向映射（回退剥离 nonce）
- **修复：`/workspace <path>` 切换无效**——现持久化 `workspaceRoot` 到配置并重建会话，下一条消息在新 cwd 生效（无参显示当前工作区）
- **入站多媒体（M6）**：飞书图片→下载→attachment store（ImageBlock，视觉模型）；文件→下载→有界文本提取。附件解析失败降级为纯文本，不丢消息
- **新增：模式/权限选择卡片**——飞书 `/mode` 发单选按钮卡片（标准/PTC/极简/创造，点选即切、重建会话下条生效），`/permission` 发权限卡片（只读/工作区写/Full access，点选调 DSH permission 服务切换）。默认 `agentPreset=ptc` + `permissionMode=danger-full-access`（Full access 另经 profile 用户层 sandbox-policy 持久化）；`/lark-config agentPreset=xxx` 文本通道保留
- **修复：`lark_send_local_file` 上传 400（234001）**——飞书 `im/v1/files` 的 `file_type` 只接受 `opus|mp4|pdf|doc|xls|ppt|stream`，"file" 无效。现按扩展名映射（pdf/doc/xls/ppt/mp4/opus），其余默认 `stream`（实测 `stream` 上传成功）
- **修复：bridge agent 仍只有 2 个工具（画图发文件失败）**——`meta.agentPreset` 写入 header 但工具未挂载：preset 需在 agent `setup(agentCtx)` 里显式 `agentPresets.mount(agentCtx, "standard")`（GUI 经 apiproxy 的 composeAgent 就是这样做的）。setup 现无条件执行（模型选择可选、preset 挂载必做）
- **修复：会话显示在「未分组」**——DSH 工作区记录只在 GUI 选择工作区时创建；bridge 现于 agent 创建时对会话 cwd 调 `workspaceRegistry.create()`（best-effort），/workspace 切换后同样生效
- **修复：多媒体出站（lark_send_local_file）与 /doctor 上传 400**——SDK `im.v1.file/image.create` 需要 `data:{file_type,file_name,file}` / `data:{image_type,image}`（multipart），原实现传裸 Buffer（code 9499）。同时路径检查改用 `workspaceRoot`（/workspace 切换后 agent 在工作区建的文件不再被 process.cwd() 误拒），svg 等非光栅格式自动按 file 发送
- **`/doctor` 诊断包升级为 ZIP**：解压当前会话的 DSH session log（`session.jsonl`，与 GUI Session log 导出同构）+ 脱敏 ISSUE.md + 说明打包为 zip 发回飞书；无日志或打包失败回退 .md 单文件，再回退文本
- **修复 `/help` 提示**：DSH 的 skill 是模型工具（`skill` tool）无 `/skill:name` 前缀——修正帮助卡片与 README 文案
- **修复：卡片 header 位置错误导致 `/help` 等卡片消息发送失败**——schema 2.0 的 `header` 是 body 的顶层兄弟，原实现嵌在 body 内，飞书报 ErrCode 200621；markdownCard 现把 header 放顶层
- **修复：DONE 表情只有第一条消息有**——forwarder 的 `doneIssued/hasOutput/acc` 跨 turn 残留，`turn/start` 未重置；现每轮重置，逐条消息都打 DONE（空输出仍不打）
- **修复：回复不渲染 markdown**——sendText 现自动检测 markdown 内容（标题/列表/代码块/表格/粗体）并改为 CardKit 卡片（`tag:"markdown"`）发送，纯文本仍走 text 消息（对齐 pi rich-text 模式选择）
- **修复：`/workspace ~/path` 报目录不存在**——`~` 未展开且相对路径拼到旧 cwd 前。现展开 `~`/`~/`，相对路径基于当前工作区解析
- **修复：飞书侧 `/model` 无反应**——web profile 无 dsh-command-model 插件（GUI 的 /model 是客户端命令），Tier 2 又要求会话 agent 已存在。现桥实现 `/model`（列当前+可用模型，`/model <provider>/<model>` 切换并重建会话）；Tier 2 懒创建会话 agent（首条命令消息不再跳过 DSH 命令）
- **修复：桥 agent 无 provider/model → 每轮 turn 报错、飞书无回复**（实测根因）。桥创建的 DSH agent 直接调 `ctx.agents.create({sessionId})` 未携带默认模型；真实 harness 中 `agentDefaultModel` 服务由 headless/gateway 等入口层消费，不会自动注入到裸 create。现在 adapter 像 dsh-headless 一样：读取 `agentDefaultModel.currentSelection()` → 传 `agentOptions:{provider,model}` → `setup` 里 `installModelSelection`（request-waterfall 级联）。无该服务时告警提示
- **修复：turn-supervisor watchdog 从未 arm**（`turn/start` 未映射 → `arm()` 死代码）。`SessionEventOut` 增加 `turn/start`，adapter 映射该事件，host 在 `onEvent` 里 arm
- 新增测试：adapter 默认模型注入矩阵（有/无 agentDefaultModel → create 参数）、turn/start 事件映射、assistant 文本提取、fetch registerApp 全流程（begin→QR→poll→凭据）/中止（+7 项，共 121 项）
- 卡片 schema 2.0 按钮规范：按钮平铺 `body.elements`（`width:"fill"` 防截断），回传用 `behaviors:[{type:"callback",value}]`，**移除 tag:"action" 容器**（飞书 ErrCode 200861）；卡片 action 事件接入桥命令路由（`card.action.trigger` → op 分发）
- **上传返回双形状兼容**：`uploadFile`/`uploadImage` 同时解析真实 SDK 顶层 `file_key`/`image_key` 与旧 `{data:{...}}` 包裹（`extractUploadKey`）
- `/support` → `/doctor` 改名（旧名保留兼容）；诊断/帮助文案同步
- emoji 精简为稳定集合（部分 emoji 在部分客户端字体渲染乱码）
- 开发：devDependencies 增加 `@deepseek-ai/*` 系列 + tsdown（`npm run check/build` 不再强制依赖本地 DSH checkout）
- 新增测试：卡片 schema 2.0 结构矩阵（无 action/按钮 behaviors/op 路由）、上传 key 双形状解析（+9 项，共 102 项）

## 0.1.0

首个版本。高可靠飞书/Lark 双向桥接插件：

- 持久 Outbox（JSONL + at-least-once + 幂等 + 分航道 + 失败离队不阻塞 + 崩溃恢复）
- CardKit schema 2.0 流式卡片（默认关，省流量；`/lark-config streaming.enabled=true` 热改开启）
- 每飞书会话独立 DSH agent（per-key FIFO、idle 回收、映射持久化）
- 每轮 assistant 输出逐条投递；空输出（"No response."）不发不打 DONE
- 连接自愈：probe 驱动受控重连 + QuotaGovernor 配额熔断 + 断连补偿
- 表情回执（入站随机池 + 完成 DONE，池内仅实测有效 emoji）
- 命令三级分流：桥特有（/status /doctor /sessions /workspace /stop /support /lark-config /help）→ DSH 注册命令原生调用 → 其他原样注入 agent
- 无审批默认全放开（不注册 approval 应答者；可选 denyList 纯拒绝兜底）
- 复用 DSH Web GUI（桥会话=原生 session 直接呈现；client 只加状态浮层与 setup 二维码）
- `/lark setup` 扫码一键建应用（registerApp + addons 显式订阅消息事件/群聊/表情权限）
- 一键诊断（脱敏诊断包）
- 进程内插件形态（Cordis `ctx.effect` disposer 干净卸载；多宿主 gateway 锁防护）
