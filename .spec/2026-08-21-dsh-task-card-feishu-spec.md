# dsh-lark-link 进行中任务与目标看板卡片设计 Spec（v1.0）

- **日期**：2026-08-21
- **状态**：方案设计完毕（待评审，先不执行代码）
- **关联组件**：`@deepseek-ai/dsh` (`dsh-tool-todo`, `dsh-goal`, `dsh-session`), `dsh-lark-link` (L4 presentation, L3 outbound, L2 sessions)
- **设计基准**：飞书交互式消息卡片 Schema 2.0 (Feishu CardKit v1 / Interactive Card v2)

---

## 1. 背景与设计目标

### 1.1 现状与问题
在 DSH（DeepSeek Harness）宿主中，Agent 拥有两大任务/目标追踪机制：
1. **`dsh-goal`（目标域）**：持久化同一会话的目标（`objective`）、生命周期阶段（`active` / `paused` / `blocked` / `complete`）、轮次预算（`roundsStarted` / `maxGoalRounds`）及阻塞原因（`blockedReason`）。
2. **`dsh-tool-todo`（任务清单）**：模型面向任务拆解调用的 `todo_write(todos: [{ content, status }])` 工具，维护包含 `pending`（待处理）、`in_progress`（进行中）、`completed`（已完成）的三态任务列表。

在 DSH Web GUI（原生界面）中，这些状态被优雅地渲染在顶层计划条和底部目标栏（如用户截图所示：顶部展示 `任务 1 进行中 · 12 待处理` + 细分清单；底部展示 `🎯 进行中的目标 在 E:\AI\ESP32\...` + 暂停/编辑/删除按钮）。

但在当前的 `dsh-lark-link` 飞书桥接中：
- 工具调用（`tool/call` / `tool/result`）仅在 GUI 保留，飞书端不输出中间状态。
- 用户在飞书端只能看到文字回复，无法直观感知任务拆解进度、当前正在执行的具体子步骤，也无法在移动端/PC端直接控制目标暂停或终止。

### 1.2 设计目标
设计一套符合**飞书卡片 Schema 2.0 规范**的「任务与目标看板卡片（Task & Goal Card）」，实现：
1. **视觉保真对齐**：完整还原 DSH 原生 UI 的「目标横幅 + 进度统计 + 任务列表 + 控制按钮」层级结构。
2. **实时原位更新**：利用飞书 CardKit 原位更新（`PUT /cards/:card_id`），任务状态变更时仅刷新卡片，不刷屏。
3. **双向反向控制**：卡片提供「⏸ 暂停」、「▶️ 恢复」、「🛑 终止」、「📋 展开/折叠」等交互按钮，回调直通 DSH 核心服务。
4. **多端自适应与性能兜底**：适配移动端与桌面端，支持任务超长智能折叠，内置 1.5s 防抖节流与严格递增 sequence，杜绝飞书频控超限。

---

## 2. 飞书卡片视觉规范与结构设计 (UI/UX)

### 2.1 卡片整体结构拆解

```
┌────────────────────────────────────────────────────────┐
│ [Header] 🎯 DSH 任务看板 · 进行中 (模板色: blue/yellow/green)│
├────────────────────────────────────────────────────────┤
│ 🎯 【进行中的目标】                                     │
│ 在 E:\AI\ESP32\esp3202_new 写出一套完整的 ESP-IDF 构建... │
│ 📁 工作区: /project/esp32  │  🔄 轮次: 3/256             │
├────────────────────────────────────────────────────────┤
│ 📊 【任务总览】 ⚡ 1 进行中 · ⏳ 12 待处理 · ✅ 0 已完成   │
│ 进度: [▓░░░░░░░░░░░░░░░░░░░░] 7.7% (1/13)              │
├────────────────────────────────────────────────────────┤
│ 📋 【任务执行清单】                                     │
│  🔵 **创建项目骨架 (CMakeLists、...) 并首次构建验证**   │
│     ↳ 正在执行工具链环境检查与配置生成...                │
│  ◌ 编写 json 组件 (自包含 JSON 解析/生成)                │
│  ◌ 编写 diagnostics 组件 (版本/重启原因/运行时间/内存)   │
│  ◌ 编写 state_store 组件 (NVS 设置，兼容旧键)            │
│  ◌ 编写 media_store 组件 (SPIFFS 帧 + 上传事务/提交)     │
│  ... (共 13 项，默认展示高优项，支持展开)                 │
├────────────────────────────────────────────────────────┤
│ [操作栏] [ ⏸ 暂停目标 ]  [ 🛑 终止任务 ]  [ 📋 展开全部 ] │
└────────────────────────────────────────────────────────┘
```

### 2.2 状态映射与配色矩阵

| 目标生命周期 (Goal Phase) | 飞书卡片 Header 模板色 | 状态图标 | 说明 |
|---|---|---|---|
| `active` (进行中) | `blue` | 🎯 / ⚡ | 正常执行中，允许暂停、终止 |
| `paused` (已暂停) | `yellow` | ⏸ | 用户或系统已暂停续行，展示恢复按钮 |
| `blocked` (已阻塞) | `orange` | ⚠️ | 因配额、人工确认或环境异常阻塞，展示阻塞原因 |
| `complete` (全部完成) | `green` | ✅ | 目标及所有任务已顺利达成，展示完成统计 |
| `cleared` / 失败 | `red` / `grey` | 🛑 | 任务被终止或抛出致命异常 |

### 2.3 任务项 (Todo Item) 状态渲染细节

| Todo Item 状态 | 飞书 Markdown 渲染格式 | 视觉表现 |
|---|---|---|
| `in_progress` | `🔵 **创建项目骨架...**` | 蓝色实心圆点 + **文字粗体加亮**，排在醒目位置 |
| `pending` | `◌ 编写 json 组件...` | 虚线圆圈 / 灰色字体，常规显示 |
| `completed` | `🟢 ~编写 migration 组件...~` | 绿色勾选 / 删除线弱化，表示已达成 |

---

## 3. 飞书卡片 Schema 2.0 标准 JSON 结构

### 3.1 进行中状态（Active 完整态）JSON 规范

```json
{
  "schema": "2.0",
  "config": {
    "update_multi": true,
    "streaming_mode": false
  },
  "header": {
    "title": {
      "tag": "plain_text",
      "content": "🎯 DSH 任务看板 · 执行中 (1/13)"
    },
    "subtitle": {
      "tag": "plain_text",
      "content": "1 进行中 · 12 待处理 · 0 已完成"
    },
    "template": "blue"
  },
  "body": {
    "elements": [
      {
        "tag": "markdown",
        "content": "**🎯 进行中的目标**\n在 `E:\\AI\\ESP32\\esp3202_new` 写出一套完整的、可用本机 ESP-IDF v6.0.2 成功构建的 ESP32 固件与组件库"
      },
      {
        "tag": "column_set",
        "flex_mode": "flow",
        "background_style": "grey",
        "columns": [
          {
            "tag": "column",
            "width": "weighted",
            "weight": 1,
            "elements": [
              {
                "tag": "markdown",
                "content": "📁 **工作区**\n`esp3202_new`"
              }
            ]
          },
          {
            "tag": "column",
            "width": "weighted",
            "weight": 1,
            "elements": [
              {
                "tag": "markdown",
                "content": "🔄 **执行轮次**\n`3` / 256"
              }
            ]
          },
          {
            "tag": "column",
            "width": "weighted",
            "weight": 1,
            "elements": [
              {
                "tag": "markdown",
                "content": "📊 **总进度**\n`7.7%` (1/13)"
              }
            ]
          }
        ]
      },
      {
        "tag": "hr"
      },
      {
        "tag": "markdown",
        "content": "**📋 任务执行清单** (当前进行到第 1 项)：\n\n🔵 **创建项目骨架 (CMakeLists、partitions.csv、sdkconfig.defaults、main) 并首次构建验证工具链**\n◌ 编写 json 组件 (自包含 JSON 解析/生成)\n◌ 编写 diagnostics 组件 (版本/重启原因/运行时间/内存)\n◌ 编写 state_store 组件 (NVS 设置，兼容旧键)\n◌ 编写 media_store 组件 (SPIFFS 帧 + 上传事务/提交/回滚)\n◌ 编写 migration 组件 (旧 NVS/SPIFFS 只读校验 + 迁移标志)\n◌ 编写 display_driver 组件 (HUR75 全彩双梁油驱动)\n\n*(还有 6 项待处理任务已折叠...)*"
      },
      {
        "tag": "hr"
      },
      {
        "tag": "column_set",
        "flex_mode": "flow",
        "columns": [
          {
            "tag": "column",
            "width": "weighted",
            "weight": 1,
            "elements": [
              {
                "tag": "button",
                "width": "fill",
                "type": "default",
                "text": {
                  "tag": "plain_text",
                  "content": "⏸ 暂停目标"
                },
                "behaviors": [
                  {
                    "type": "callback",
                    "value": {
                      "op": "goal:pause",
                      "goalId": "gid_xxx",
                      "revision": 3
                    }
                  }
                ]
              }
            ]
          },
          {
            "tag": "column",
            "width": "weighted",
            "weight": 1,
            "elements": [
              {
                "tag": "button",
                "width": "fill",
                "type": "danger",
                "text": {
                  "tag": "plain_text",
                  "content": "🛑 终止任务"
                },
                "behaviors": [
                  {
                    "type": "callback",
                    "value": {
                      "op": "goal:clear",
                      "goalId": "gid_xxx",
                      "revision": 3
                    }
                  }
                ]
              }
            ]
          },
          {
            "tag": "column",
            "width": "weighted",
            "weight": 1,
            "elements": [
              {
                "tag": "button",
                "width": "fill",
                "type": "default",
                "text": {
                  "tag": "plain_text",
                  "content": "📋 展开详情"
                },
                "behaviors": [
                  {
                    "type": "callback",
                    "value": {
                      "op": "task:toggle_fold",
                      "folded": false
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### 3.2 阻塞/暂停状态（Blocked/Paused）卡片变体

当目标被暂停或因为依赖问题阻塞时：
- Header 变更为 `yellow`（暂停）或 `orange`（阻塞）。
- 顶部插入告警提示框（Callout）。
- 左侧主按钮从「⏸ 暂停目标」切换为「▶️ 恢复执行」（`op: goal:resume`）。

```json
{
  "tag": "markdown",
  "content": "⚠️ **目标已暂停 / 阻塞**\n> 阻塞原因: `waiting-user-confirmation` - 等待硬件端口映射确认"
}
```

---

## 4. 架构设计与技术实现方案 (`dsh-lark-link`)

### 4.1 架构分层设计（严格遵守 L0-L4 纪律）

```
 [DSH 宿主内核]
   │  ctx.on('session/event') / ctx.goals / ctx.sessionProjections
   ▼
 L2 Session Layer (`src/sessions/dsh-adapter.ts` + `task-state-tracker.ts`)
   ├─ 捕获 `todo/write` (更新 Todo 列表快照)
   ├─ 捕获 `goal/change` (更新 Goal 目标阶段与轮次)
   ├─ 维护每会话最新的 TaskCardState
   ▼
 L3 Outbound Layer (`src/outbound/task-card-syncer.ts`)
   ├─ 防抖节流器 (Debounce 1500ms，合并频繁连续的 todo 更新)
   ├─ 单卡实体管理 (Card Entity ID 映射 + 递增 Sequence 管理)
   ├─ CardKit 更新分发器 (PUT /open-apis/cardkit/v1/cards/:card_id)
   ▼
 L4 Presentation Layer (`src/presentation/task-cards.ts`)
   ├─ 纯函数：buildTaskCard(state: TaskCardState, options): LarkCardSchema2
   └─ 纯函数：formatTodoList(todos, isFolded): string
   ▼
 [飞书 OpenAPI / CardKit 端点]
```

### 4.2 数据结构定义 (`src/common/types.ts`)

```typescript
export interface TaskCardState {
  sessionKey: string;
  cardEntityId?: string;
  sequence: number;
  goal?: {
    id: string;
    revision: number;
    objective: string;
    phase: "active" | "paused" | "blocked" | "complete";
    roundsStarted: number;
    maxGoalRounds: number;
    blockedReason?: {
      code: string;
      message: string;
    };
  };
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  workspacePath?: string;
  isFolded?: boolean;
  lastUpdatedAt: number;
}
```

### 4.3 卡片生命周期与更新策略

1. **首次触发与创建 (Create & Deliver)**：
   - 当会话中首次收到 `goal/change`（创建目标）或首次收到 `todo/write`（模型输出任务分解）时：
   - 调用 `POST /open-apis/cardkit/v1/cards` 创建卡片实体，获得 `card_id`。
   - 调用 `im/v1/messages` 将该卡片发送至当前飞书会话，并在会话状态中记录 `taskCardId`。
2. **原位增量更新 (In-Place Update)**：
   - 随后的每一次 `todo/write` 或目标状态变迁（如轮次增加、状态转换）：
   - 进入 **1500ms 防抖队列**（合并密集写入）。
   - sequence 计数器 `seq += 1`。
   - 调用 `PUT /open-apis/cardkit/v1/cards/:card_id`，将整卡更新为最新视图。
   - **绝不重复发送新消息**，确保飞书聊天流保持清爽。
3. **定稿与收尾 (Finalize)**：
   - 当 `goal` 转换为 `complete` 或全部 `todos` 变为 `completed`：
   - 触发最终全量更新，卡片 Header 变绿，展示完成总结与耗时。
   - 移除定时器与临时监听句柄。

### 4.4 飞书交互回调反向控制 (`command-router.ts`)

飞书用户点击卡片按钮时，通过 WebSocket `card.action.trigger` 接收事件，分流处理：
- `op: "goal:pause"`：
  ```typescript
  await ctx.goals.pause(agent, { id: val.goalId, revision: val.revision });
  ```
- `op: "goal:resume"`：
  ```typescript
  await ctx.goals.resume(agent, { id: val.goalId, revision: val.revision });
  ```
- `op: "goal:clear"` / `stop`：
  ```typescript
  await ctx.goals.clear(agent, { id: val.goalId, revision: val.revision });
  await agent.cancel(); // 同步中断当前活跃轮次
  ```
- `op: "task:toggle_fold"`：
  - 本地切换 `state.isFolded = !state.isFolded`，直接触发 `updateCard` 重新渲染。

---

## 5. 关键边界防御与极端情况应对

| 边界场景 | 风险点 | 应对方案 |
|---|---|---|
| **超长任务列表** (例如 > 20 个 Todo 项) | 飞书卡片长度超限、手机端长篇滚动打断对话 | **智能折叠算法**：优先展示 1 个当前 `in_progress` 项 + 最近 2 个已完成项 + 接下来 3 个待处理项，其余折叠显示为 `(还有 N 项已折叠...)`，提供「展开详情」按钮。 |
| **超高频 Todo 更新** (模型快速连续调用) | 触发飞书 Open API 频控 (50 QPS) 或 CardKit 429 | **Trailing-Edge 防抖节流** (1.5 秒合并窗口)，确保每张卡片每秒最多推送一次更新。 |
| **CardKit Sequence 乱序** | 飞书服务端拒绝旧 sequence，导致卡片卡死在旧状态 | 内存维护会话唯一的 `AtomicSequenceCounter`，保证每次 update 的 sequence 严格单调自增。 |
| **会话重置 / 恢复** (`/new` 或 `/resume`) | 旧卡片失效或操作冲突 | 切换会话时，旧卡片置为「已归档/只读」状态（禁用按钮），新会话新建专属看板卡片。 |
| **网络断连 / 进程重启** | 内存中丢失 `card_id` | 将当前活跃的 `taskCardId` 与 `sequence` 随 `routes.json` 或 `session-projection` 一并持久化，重启后能够无缝续接原卡片更新。 |

---

## 6. 测试策略与 TDD 实施计划 (待执行阶段规划)

| 测试类型 | 测试用例文件 | 核心断言内容 |
|---|---|---|
| **卡片 Schema 纯函数测试** | `test/unit/presentation/task-cards.test.ts` | 1. 验证 `buildTaskCard` 在 `active` / `paused` / `blocked` / `complete` 下的 Header 模板与组件结构；<br>2. 验证 Todo 状态图标转换正确；<br>3. 验证折叠态与展开态的任务切片逻辑。 |
| **防抖与序列号测试** | `test/unit/outbound/task-card-syncer.test.ts` | 1. 连续 5 次写入 `todo/write` 仅触发 1 次 `updateCard`；<br>2. 每次 API 调用 sequence 严格递增；<br>3. 销毁时正确 flush 尾部状态。 |
| **反向操作分流测试** | `test/unit/application/card-action.test.ts` | 1. 点击 `goal:pause` 正确调用 `ctx.goals.pause`；<br>2. CAS 冲突或过期 revision 正确处理报错回执；<br>3. 点击 `task:toggle_fold` 仅触发卡片重绘，不向 Agent 注入用户消息。 |

---

## 7. 评审结论与后续步骤

- **本设计状态**：已产出完整 Spec，保持「先设计、后评审、暂不落地执行」原则。
- **与用户确认要点**：
  1. 任务看板是否采用**单卡原位刷新（In-place update）**模式（推荐，不刷屏）。
  2. 超长任务列表默认展示前 6 项 + 折叠按钮，是否符合预期体验。
  3. 底部控制按钮（暂停、终止、展开）权限是否需要针对群聊做发信人鉴权校验。

---

## 8. 与 DSH `/goal` 命令卡片的协同与一体化设计

### 8.1 概念与定位分工（Controller vs. Tracker）

| 维度 | `/goal` 命令卡片 (Command Deck / Controller) | 任务与目标看板卡片 (Live Dashboard / Tracker) |
|---|---|---|
| **触发机制** | 用户**主动**输入 `/goal` 或点击菜单/按钮调用 | 驱动内核**被动**事件驱动（`todo/write`、`goal/change`、Round 轮次推进） |
| **主要定位** | **主控输入台与目标运维面板** | **实时执行进度投影与透明度看板** |
| **内容重心** | 目标描述、轮次上限设置、生命周期管理、新建/编辑向导 | Todo 任务拆解清单、当前活跃执行项、完成度百分比、即时耗时 |
| **展示时机** | 命令即时回复（单次下发） | 整个任务周期常驻原位刷新（In-place updates） |

### 8.2 统一状态源（SSOT）与双向联动机制

两者不是孤立的卡片，而是共享同一套 DSH 底层领域模型：
1. **领域状态共享**：
   - 目标状态来自 `@deepseek-ai/dsh-goal`（`ctx.goals.get(agent)`）。
   - 任务清单状态来自 `@deepseek-ai/dsh-tool-todo`（`agent.session` 中的 `todo/write` 快照）。
2. **命令 ➔ 看板实时联动**：
   - 当用户在输入框输入 `/goal pause` 或在 `/goal` 控制卡片上点击暂停：
   - `ctx.goals.pause` 执行成功后发出 `goal/change` 事件。
   - 现存的【任务看板卡片】自动感知事件，Header 变黄（`paused`），控制按钮同步切换为「▶️ 恢复执行」。
3. **看板 ➔ 目标内核直通**：
   - 在【任务看板卡片】底部点击「⏸ 暂停」或「🛑 终止」，直接调用 `ctx.goals.pause` 或 `ctx.goals.clear`，等同于执行了 `/goal pause` / `/goal clear`。

### 8.3 飞书 `/goal` 命令卡片的场景化设计

#### 场景 1：当前无活跃目标时输入 `/goal`
渲染 **【新建目标向导卡片（Goal Setup Card）】**：
- **Header**：`blue`，标题「🎯 设定新的 Agent 目标」。
- **Body**：
  - 简短说明：目标（Goal）可驱动 Agent 在多轮循环中自主推进复杂任务，直到目标达成。
  - 示例模板按钮（点击填入或快捷触发）：
    - `[ 🛠️ 构建与测试工程 ]`
    - `[ 🐞 诊断并修复 Bug ]`
    - `[ 📝 重构模块与补全文档 ]`
  - 文本提示：`可直接输入 /goal <你的具体目标描述> 开始执行`。

#### 场景 2：当前有活跃目标时输入 `/goal`
渲染 **【目标主控与详情卡片（Active Goal Controller Card）】**：
- **Header**：根据 Phase 显示对应颜色（`blue` / `yellow` / `orange` / `green`）。
- **Body**：
  - **当前目标内容**（完整 Markdown 渲染）。
  - **当前执行参数**：已耗费轮次 `roundsStarted` / 最大轮次 `maxGoalRounds`、创建时间。
  - **快速运维按钮栏**：
    - `[ ⏸ 暂停 ]` 或 `[ ▶️ 恢复 ]`
    - `[ 🛑 清除目标 (/goal clear) ]`
    - `[ 📋 查看最新任务看板 ]`（点击触发置顶/定位当前看板卡片）
    - `[ ✏️ 编辑目标描述 (/goal edit) ]`

### 8.4 架构演进：将 `/goal` 升级为 Tier-1 Bridge Command

当前 `dsh-lark-link` 的 `command-router.ts` 中，`/goal` 落在 Tier-2（原生 DSH 命令处理，输出纯文本）：
```
用户发 /goal ➔ Tier 2 (dsh-command-goal) ➔ 产出纯文本 "Current goal: ... (active, rounds 3/256)"
```
**建议优化方案**：
在 `src/application/command-router.ts` 中将 `goal` 纳入 `BRIDGE_COMMANDS`（Tier 1）：
1. 拦截 `/goal`（无参）➔ 查询 `ctx.goals.get(agent)` 与 `ctx.sessionProjections.todos` ➔ 构造并返回**飞书富交互卡片**。
2. 拦截 `/goal <objective>` ➔ 调用 DSH 命令创建目标 ➔ 立即下发并注册新的【任务看板卡片】实体。
3. 拦截 `/goal pause|resume|clear` ➔ 调用底层 `ctx.goals` 动词 ➔ 返回操作确认卡片并联动刷新看板。

---

## 9. 全流程闭环设计：Plan (规划) ➔ Goal (目标) ➔ Task (任务) ➔ Resume (恢复)

### 9.1 全生命周期状态机与流转闭环

```
  ┌──────────────┐
  │  1. 用户意图  │ (发消息 / 或 /plan 启动)
  └──────┬───────┘
         │
         ▼
  ┌────────────────────────────────────────────────────────┐
  │ 2. 规划探索阶段 (Plan Mode: @dsh-plan-mode)            │
  │    - Agent 在只读/探索模式下分析工程、构思方案          │
  │    - 完成后 Agent 调用 exit_plan_mode 工具              │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │ 3. 飞书 Plan 评审卡片 (Plan Review Card)                │
  │    - 用户点击 [ ✅ 批准并作为 Goal 执行 ]              │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │ 4. 目标确立与分解阶段 (Goal & Todo Initiation)          │
  │    - 创建 Goal (active, 轮次预算: 256)                 │
  │    - Agent 首次调用 todo_write 拆解任务清单             │
  │    - 飞书下发【任务与目标看板卡片】(Task & Goal Card)   │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │ 5. 自主执行与实时更新 (Autonomous Execution & Updates)  │
  │    - 模型轮次自主推进，动态更新 todo/write 状态         │
  │    - 看板卡片利用 CardKit In-Place 原位刷新 (1.5s防抖)  │
  └──────────┬───────────────────────────────┬─────────────┘
             │                               │
    (暂停/中断/离线)                 (全部任务执行完毕)
             ▼                               ▼
  ┌─────────────────────────┐     ┌────────────────────────┐
  │ 6. 中断与恢复 (Resume)   │     │ 7. 目标达成 (Complete)  │
  │  - /goal pause 暂停      │     │  - 看板 Header 变绿    │
  │  - /goal resume 恢复     │     │  - 产出最终交付物总结   │
  │  - /resume <id> 会话重连 │     │  - 打 DONE 完成表情标记│
  │    (唤出恢复态势就绪卡片) │     └────────────────────────┘
  └──────────┬──────────────┘
             │
             └────────► 回到第 5 步继续执行 (闭环)
```

---

## 10. 全套飞书卡片族谱与交互设计 (Card Suite)

为了实现完整的闭环，我们在飞书侧定义 5 张核心卡片：

### 10.1 卡片 1：【Plan 规划评审卡片】(Plan Review Card)
- **触发源**：Agent 在 Plan 模式下构思完成并调用 `exit_plan_mode`。
- **定位**：方案决策门禁（Gatekeeper），防止大模型未经确认直接大范围改动工程。
- **卡片内容**：
  - **Header**：`turquoise` 或 `blue`，标题「📝 方案设计完成 · 请评审确认」。
  - **Body**：
    - 方案核心思想与技术选型（Markdown 格式）。
    - 预计修改的文件清单与风险评估。
    - 拆解出的预备步骤。
  - **操作栏**：
    - `[ ✅ 批准并启动目标 ]`（`op: plan:approve_goal` ➔ 自动转化为 `/goal <plan>` 并退出 plan mode）。
    - `[ 💬 提出修改意见 ]`（`op: plan:feedback` ➔ 提示用户输入调整建议）。
    - `[ 🛑 放弃计划 ]`（`op: plan:cancel` ➔ 触发 `/plan off`）。

### 10.2 卡片 2：【/goal 目标主控卡片】(Goal Controller Deck)
- **触发源**：用户输入 `/goal`。
- **定位**：目标的常态化运维管理与参数调整入口（详见 §8.3）。

### 10.3 卡片 3：【任务与目标实时看板卡片】(Task & Goal Board Card)
- **触发源**：Agent 处于 Goal 周期并调用 `todo_write`。
- **定位**：实时透明度监视器（对齐截图 UI，详见 §2 与 §3）。
- **更新机制**：CardKit `PUT /cards/:card_id` 原位刷新。

### 10.4 卡片 4：【/resume 历史会话选择卡片】(Session History Picker)
- **触发源**：用户输入 `/resume`。
- **增强特性（闭环感知）**：
  - 会话列表不仅显示时间与预设，还会扫描该会话的历史投影；
  - 若该历史会话含有**未完成的目标或任务**，显示醒目的 `🎯 含有未完成目标` 徽标：
    - `#1 10分钟前 · standard · 🎯 目标: ESP32构建... (7.7% 进行中)`
    - `#2 2小时前 · standard · (已全部完成)`

### 10.5 卡片 5：【Resume 恢复态势就绪卡片】(Session Resumed Briefing Card)
- **触发源**：用户点击或输入 `/resume <序号|ID>` 恢复会话后。
- **关键设计逻辑（解决 DSH Disarm 机制）**：
  - **背景**：根据 DSH `dsh-goal` 设计规范，会话恢复或重新连接时，为了安全，底层的自主续行驱动器会被默认**停用（Disarmed）**，不会自动继续消耗 Token。
  - **飞书卡片呈现**：
    - **Header**：`blue`，标题「🔄 已恢复历史会话」。
    - **Body**：
      - 提示：「已成功加载工作区 `<workspace>` 的历史上下文。」
      - 若历史会话包含未完成目标：
        - `🎯 未完成目标：在 E:\AI\ESP32... [轮次: 3/256 · 状态: 待恢复]`
        - `📊 任务进度：1/13 (7.7%) · 1 进行中 · 11 待处理`
    - **操作栏**：
      - `[ ▶️ 一键继续执行原目标 ]`（`op: goal:resume` ➔ 重新武装驱动器，无缝恢复多轮自主运行！）
      - `[ 📋 唤起完整任务看板 ]`（`op: task:focus_board` ➔ 在聊天窗口重发/置顶当前任务看板）
      - `[ 🛑 清除原目标 (/goal clear) ]`（`op: goal:clear` ➔ 清除目标，作为普通对话继续）

---

## 11. 状态流转矩阵与操作映射表 (Complete State Matrix)

| 当前状态 | 用户触发操作 | 底层 DSH 行为 | 飞书端卡片联动响应 |
|---|---|---|---|
| **空闲 (IDLE)** | 输入 `/plan <需求>` | `ctx.planMode.set(agent, true)` + `agent.steer()` | 回复进入 Plan 模式提示，开始构思方案 |
| **规划中 (PLANNING)** | Agent 调用 `exit_plan_mode` | 触发 `plan-review` 评审事件 | 下发 **【Card 1: Plan 规划评审卡片】** |
| **规划评审 (REVIEW)** | 用户点击「✅ 批准并启动目标」 | 退出 Plan Mode，调用 `ctx.goals.create(agent, plan)` | 下发 **【Card 3: 任务看板卡片】**，变更为 `active` 状态 |
| **规划评审 (REVIEW)** | 用户点击「🛑 放弃计划」 | 调用 `ctx.planMode.set(agent, false)` | 更新评审卡片为「已取消」，恢复普通对话 |
| **执行中 (ACTIVE)** | Agent 调用 `todo_write` | 追加 `todo/write` 事件快照 | **Card 3 原位刷新**：更新进度百分比、加亮当前进行中任务 |
| **执行中 (ACTIVE)** | 用户点击「⏸ 暂停目标」或发 `/goal pause` | 调用 `ctx.goals.pause(agent, ref)` | **Card 3 原位变黄**，按钮切换为「▶️ 恢复执行」 |
| **暂停中 (PAUSED)** | 用户点击「▶️ 恢复执行」或发 `/goal resume` | 调用 `ctx.goals.resume(agent, ref)` | **Card 3 原位变蓝**，Agent 接续执行下一轮次 |
| **执行中 / 暂停中** | 用户点击「🛑 终止任务」或发 `/goal clear` | 调用 `ctx.goals.clear` + `agent.cancel()` | **Card 3 原位变灰**，标记「目标已终止」 |
| **会话中断 / 离线** | 用户发 `/resume` 并选择会话 | 调用 `ctx.agents.resume({ resumeSessionId })` | 下发 **【Card 5: 恢复态势就绪卡片】**，展示历史目标与进度 |
| **会话恢复就绪** | 用户在 Card 5 点击「▶️ 一键继续执行」 | 调用 `ctx.goals.resume(agent, ref)` 重新授权续行 | 重新激活 **Card 3 任务看板**，Agent 自动接续断点推进！ |
| **全部完成 (COMPLETE)**| 目标达成且所有任务 `completed` | 追加 `goal/change (complete)` | **Card 3 原位变绿**，打上 `DONE` 表情，生成执行总结 |


