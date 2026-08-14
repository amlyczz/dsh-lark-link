# Changelog

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
