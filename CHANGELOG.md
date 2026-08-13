# Changelog

## 0.1.1（未发布）

对齐 pi-feishu-link 2026-08-14 实机修复轮：

- **卡片 schema 2.0 按钮规范**：新增欢迎卡/命令面板/状态卡交互按钮——按钮平铺 `body.elements`（`width:"fill"` 防截断），回传用 `behaviors:[{type:"callback",value}]`，**移除 tag:"action" 容器**（飞书 ErrCode 200861）；卡片 action 事件接入桥命令路由（`card.action.trigger` → op 分发）
- **上传返回双形状兼容**：`uploadFile`/`uploadImage` 同时解析真实 SDK 顶层 `file_key`/`image_key` 与旧 `{data:{...}}` 包裹（`extractUploadKey`）
- `/support` → `/doctor` 改名（旧名保留兼容）；诊断/帮助文案同步
- emoji 精简为稳定集合（部分 emoji 在部分客户端字体渲染乱码）
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
