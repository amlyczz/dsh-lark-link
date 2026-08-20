# Spec: Feishu /resume + streaming 卡片修复 + GH #7/#8（0.4.0）

## Objective

四个用户可感知的目标，全部在本仓库（dsh-lark-link）内完成：

1. **飞书侧 `/resume`**：在飞书聊天里查看/恢复**当前会话工作区**的历史 DSH 会话
   （`/resume` 列表，`/resume <序号|id前缀>` 恢复；恢复后下一条消息接续历史上下文）。
2. **流式卡片可用**：`/lark-config streaming.enabled=true` 报 `"streaming.enabled" 不可热改`
   是 bug（白名单只有顶级键，点路径未解析）；且即便热改成功，流式管线也是断的
   （`ensureStream` 返回 `undefined` 桩 + CardKit 载荷与官方 API 不符）。两处都要修。
3. **GH #7**：`/workspace` 与 `lark_send_local_file` 用 `startsWith("/")` 判绝对路径，
   Windows 盘符路径全部被拒（`无效路径` / `拒绝: 路径不在工作区内`）。改用 `node:path` 的
   `isAbsolute()` / `relative()`。
4. **GH #8**：`syncDefaultPermission` 把桥的 `permissionMode` 写进宿主**全局**设置文档，
   污染整个部署的默认权限。改为：不再写宿主设置；在**每个桥会话**创建时应用权限
   （`permissionPresets.apply` + `approval.setPolicy`）。

非目标（明确不做）：
- 不做 approval 审批转发卡片（#8 附注的后续特性）。
- 不修改 awesome-dsh-plugins 仓库（ISSUE-*.md 是对外仓库的 issue 草稿，与本插件代码无关）。
- 不改 `/new`、`/workspace` 的现有会话轮换语义。

## Tech Stack

- TypeScript 5.9（ESM、`--experimental-strip-types` 直跑）、Node ≥24。
- 运行时依赖 DSH 0.1.0-rc.6 的服务面：`ctx.agents.resume({resumeSessionId})`
  （`AgentRegistry.resume`，factory 内部 `sessionPersistence.prepare`）、
  `sessionPersistence.list()/inspect()`、`permissionPresets.apply`、`approval.setPolicy`。
- 飞书 CardKit v1 官方端点（已核对文档）：
  - 创建卡片实体 `POST /open-apis/cardkit/v1/cards`，body `{data:{type:"card_json",data:"<字符串化卡片JSON>"}}`
  - 发送卡片实体 `im/v1/messages` `msg_type:"interactive"`，content `{"type":"card","data":{"card_id"}}`（实体仅可发送一次）
  - 流式更新文本 `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content`，body `{uuid?,content,sequence}`（全量文本、前缀延伸打字机）
  - 更新卡片配置 `PATCH /open-apis/cardkit/v1/cards/:card_id/settings`，body `{settings:"<字符串化config>",uuid?,sequence}`
  - 全量更新 `PUT /open-apis/cardkit/v1/cards/:card_id`，body `{card:{type:"card_json",data:"..."},uuid?,sequence}`
  - sequence 对同一卡片**严格递增**（int32）。

## Commands

```
类型检查:  npm run check
测试:      npm test
构建:      npm run build
```

## Project Structure

```
src/common/paths.ts                      # 新增：跨平台工作区路径解析（#7）
src/common/config.ts                     # 点路径热改解析（streaming bug 前半）
src/outbound/cardkit-stream.ts           # 重写为官方 CardKit API 载荷 + sequence
src/host/lark-client.ts                  # CardKit HTTP 端点适配
src/inbound/transport.ts                 # FeishuClientLike 增加 cardkit 方法（可选）
src/sessions/workspace-sessions.ts       # 新增：列当前工作区历史会话（服务优先、文件扫描兜底）
src/sessions/dsh-session-backend.ts      # 接口加 resumeAgent + memory 实现
src/sessions/dsh-adapter.ts              # agents.resume 接线 + 权限 per-session 应用（#8）
src/application/command-router.ts        # BRIDGE_COMMANDS 加 "resume"
src/presentation/cards.ts                # helpCard 增补 /resume
src/index.ts                             # /resume 命令、lark-config 点路径、streamFor 接线、
                                         # workspace/文件工具路径修复、syncDefaultPermission 移除
test/unit/**                             # 与 src 镜像，node:test + assert/strict
```

## Code Style

- 与现状一致：tab 缩进、double quotes、中文注释说明决策来源（issue/pi 决策号）。
- DSH API 只在 `dsh-adapter.ts` 触碰；其余模块依赖窄接口（spec §2.3 纪律）。
- 纯函数优先（paths/workspace-sessions/cardkit 载荷构造都可独立单测）。

## Testing Strategy（TDD——每个行为先写失败测试）

| 变更 | 测试文件 | 关键断言 |
|---|---|---|
| 点路径热改 | `test/unit/common/config.test.ts` | `buildHotReloadPatch("streaming.enabled", true)` → `{streaming:{enabled:true}}`；非白名单顶级键拒绝；未知子键拒绝 |
| CardKit 载荷 | `test/unit/outbound/cardkit-stream.test.ts` | create 载荷含 `config.streaming_mode` + `element_id`；patch 走 elements/:id/content 全量文本；settings PATCH 关流；sequence 严格递增；finalize 失败 re-throw |
| 路径解析 | `test/unit/common/paths.test.ts` | `D:\ws`（win32）为绝对路径；`/x`（posix）为绝对；相对路径 join 当前工作区；`..` 逃逸被 containment 拒绝 |
| 工作区会话列表 | `test/unit/sessions/workspace-sessions.test.ts` | projectKey 编码（`/home/a/proj`→`--home-a-proj--`）；`~003A` 解码；按时间倒序；服务源按 cwd 过滤并排除 subagent |
| resumeAgent | `test/unit/sessions/dsh-adapter.test.ts` | `resumeSessionId` 传入 registry.resume；旧 agent 被 detach 不 dispose；resume setup 用存储 preset；后续 ensureAgent 复用 resumed handle |
| 权限 per-session | `test/unit/sessions/dsh-adapter.test.ts` | create/resume 后 `permissionPresets.apply(session, mode, cb)` 被调、`approval.setPolicy` 回调生效；无服务时静默跳过 |
| 命令注册 | `test/unit/application/command-router.test.ts` | `/resume` 进入 Tier-1 bridge 命令 |

## Boundaries

- Always: 每个修复带复现测试；`npm run check && npm test && npm run build` 全绿才收尾。
- Ask first: 新增运行时依赖（本 spec 不需要）；改 CI 工作流。
- Never: 不在配置/日志中落凭据明文；不 dispose 用户可见的历史会话（resume 采用 rotate 式 detach）；
  不写宿主全局 settings 文档（#8 的核心约束）。

## Success Criteria

1. 飞书发 `/resume` → 收到当前工作区历史会话编号列表（卡片含可点按钮）；`/resume 1` →
   「已恢复会话 …」，后续消息接续该会话上下文（`agents.resume` 生效，GUI 会话行复用）。
2. 飞书发 `/lark-config streaming.enabled=true` → 「已更新」，随后一轮回复以 CardKit 流式卡
   打字机呈现并正确定稿；`streaming.enabled=false` 随时可关（省流量默认不变）。
3. （#7）Windows 上 `/workspace D:\x\y` 与 `lark_send_local_file` 盘符路径不再被
   `无效路径`/`拒绝` 误杀；Unix 行为不回归。
4. （#8）启动与 `/permission` 切换均**不再**写宿主 `settings.permission.defaultPreset`；
   桥会话仍按 `permissionMode`（默认 danger-full-access）运行。
5. 全部现有测试 + 新增测试通过；`tsc --noEmit`、构建无错。

## Open Questions

无 —— #8 采用 issue 内已验证的三段式方案；CardKit 载荷以官方文档为准重写。

---

## Addendum 2026-08-19（发布前自测反馈修复，未 publish）

### A. 图片：模型找不到图片
- **根因 1**：`bridge-context` 的 `attachments` 是构造时快照（违反自身 GETTER 原则）——服务晚挂载则永远 undefined，imageRef 永不生成。**修复**：deps 改 `attachmentsRef?: () => ImageAttachmentService`，live 解析。
- **根因 2**：adapter followup 对无 imageRef 的图片静默丢弃。**修复**：本地路径折入文本；无附件服务时也明示。post 富文本内嵌 `{tag:"img"}` 提取下载（共享 `resolveOneImage`）。
- 测试：bridge-context live getter、followup ImageBlock/路径附注/无 ref 不丢、post 内嵌图×2、纯文字 post 无图不崩。

### B. 流式卡片无法开启
- **根因**：CardKit create 请求体包了 `{data:{…}}`，官方是扁平 `{type:"card_json", data:"…"}`（已核对 create.md 请求体示例）→ 4xx → 无卡。**修复**：扁平化；新增一次性失败提示（聊天内说明回退原因）。
- 测试：create 载荷断言改为扁平。

### C. /resume 选择卡片
- **bug**：卡片回调按第一个冒号切 op，lark-link id 的冒号使按钮点击永远查不到。**修复**：op 传 `encodeURIComponent(id)`，匹配端解码 + 原始/前缀/后缀兜底。
- **友好化**：相对时间、preset 徽标、当前会话禁用行（无编号）、序号只数可恢复行、空态 + /new /workspace 提示、恢复回执带起始时间。
- 发布约束：**不 publish**（用户明确要求），全部改动停在本地 0.4.0。

## Addendum 3（2026-08-19 下午，实测反馈第二轮 + 全面复查）

### D. 图片链路三连修（实测日志驱动）
1. **下载 404 形状错**：`downloadResource` 走通用 `request()`，其返回是 axios 风格（流在 `.data`），永远没有 `getReadableStream()` → `no stream for img_v3_…` → 附件解析失败。改走 SDK 专用 `im.messageResource.get`（自带 `responseType:"stream"` 包装），通用 request 作 fallback（流取 `.data`）。
2. **post v1 格式漏解析**：真实事件里 post 的 `content` 是**数组的数组**（v1，机器人接收的默认格式），`content_v2` 同款重复。`pickText` 现按 v2 paragraphs → v1 数组数组 → string 三段式提取（img 段不产生空行）；附件提取同步支持 v1，`content`/`content_v2` 重复 image_key 去重（否则同图下载两次、模型看到两份）。
3. **纯图/纯文件消息文本占位**：`text` 为 `undefined` 时对话层回退 `msg.content`，模型收到裸 `{"image_key":…}` JSON。现在 image → `[图片]`、file → `[文件]`。

### E. 非视觉模型发图整轮报错（glm-5.3）
- 症状：`pi-ai model "glm-5.3" does not support image input` → turn error 无输出 → 会话被重置。
- 修复：适配层在 `agent/error` 捕获该错误 → 标记会话 `imageUnsupported`（此后图片只走落盘路径 + read_image 提示）→ 同步用**纯文本孪生**（followup 时预存 `pendingImageRetry`）重发当轮。
- **竞态修复（全面复查发现）**：实测事件顺序是 agent/error →（同步重试）→ 重试 turn/start → 原轮 turn/end(error)。silent-turn 监督器会 dispose agent 把重试连坐杀掉。引入**一次性 grace**（`consumeImageRetryGrace`）：silent 分支先消费，命中则跳过恢复让重试跑完；重试自身再挂时第二次 turn/end 无 grace → 正常恢复兜底。`pendingImageRetry` 在 rotateKey/dispose 清理防陈旧累积。

### F. 入站附件临时目录 + 保留策略（默认 7 天，跨平台）
- 默认根：`os.tmpdir()/dsh-lark-link/inbound/media/`（Linux/macOS/Windows 各自解析）；`attachments.dir` 可覆盖（重启生效）。
- `attachments.retentionHours` 默认 **168h（7 天）**，热改生效；`0` = 永久保留。启动即扫 + 每小时按 mtime 清扫。
- 跨平台加固：`sanitizeAttachmentName`（Windows 保留字符/控制字符/尾点尾空格 → `_`，中文保留，≤200 字符）；删除带 `force+maxRetries`（Windows EBUSY/EPERM 重试，下轮兜底）；路径全程 `node:path`，无硬编码分隔符（`split("/")` 审计唯一命中是 `/model provider/model` 命令语法）。

### 复查结论
224 测试全绿（新增：SDK 下载、v1 双格式、占位、grace 一次性、清扫边界、消毒边界、168 默认）；tsc 干净；dist 重建验证。README 双语配置表已补 attachments 键。
