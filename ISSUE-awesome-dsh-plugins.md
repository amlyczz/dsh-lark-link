# [Bug] `amlyczz-dsh-lark-link` 被误标为「不兼容 ★0」——占位 URL 误判，非仓库真实状态

## 概述 / Summary

`PLUGINS-ALL.md` 底部作者分组（`**amlyczz**` 段,约 2619 行）中，条目
`amlyczz-dsh-lark-link` 被显示为 `[不兼容] ★0`。
但该判定是雷达扫描链路拿 **GitHub 搜索占位 URL**（`https://github.com/search?q=amlyczz-dsh-lark-link`）
去测试产生的，**并未命中真实仓库**，因此 `star=0` 与「不兼容」都是假数据。

真实仓库是正常、可运行且已 PR 登记的：
- `PLUGINS.md`（PR 登记表，第 113 行，`📡 远程渠道`）：标注 **✅**
- 分类净值（`PLUGINS-ALL.md` 第 159 行 `📡 消息通讯`，早期快照）：`★5 ✅[可用]`

## 根因证据 / Root cause evidence

在 `data/snapshots/*.json` 的合并结果中，同一仓库存在两条不同键：

| 快照轮次 | name | url | star | verdict |
|---|---|---|---|---|
| 20260814 → 20260815T071634Z（较早） | `dsh-lark-link` | `https://github.com/amlyczz/dsh-lark-link` | 3→5 | ✅ 可用 |
| **20260815T125358Z / T151237Z（最新两轮）** | `amlyczz-dsh-lark-link` | `https://github.com/search?q=amlyczz-dsh-lark-link` | **0** | **❌ 不兼容** |

`gen-plugins-all.py` 的合并逻辑是「最新轮覆盖」（`merged.setdefault((name,url))`，轮次按 `run_id` 新→旧，后者覆盖前者）。
于是最新的两轮：① 把发现命名改成了前缀式 `owner-repo`；② 生成了 search 占位 URL；③ `star` 拉到 0；④ agent 测试对着占位链跑，判成「不兼容」。
虽然之后 `resolve_placeholders.py` / 定位复核把 URL 修回了真实仓库（`locate-cache.json` 中 `amlyczz-dsh-lark-link → found → amlyczz/dsh-lark-link`），
但 **star 与 verdict 没有被重建**，于是坏数据直接进入了可见清单。

**实时真实值（GitHub API, 2026-08-16）**：
- `amlyczz/dsh-lark-link`
- `stargazers_count = 10`
- topics 包含 `dsh-plugin`（满足自动发现条件）
- description: High-reliability Feishu/Lark bridge ...

## 影响 / Impact

- 用户会误以为该飞书/Lark 桥接插件「不兼容 DSH」，实则可运行（PR 表 ✅）。
- Star 显示 0，与实际情况（10）不符，损害新作者的可见度。
- 类似的影响可能波及其它用 `owner-repo` 前缀命名的扫描条目——需要排查是否普遍存在「占位 URL 被判不兼容」。

## 建议修复 / Suggested fix

1. **重建判定**：对 `locate == 'located'` 且 URL 由占位链修复回真实仓库的条目，**丢弃旧的 star/verdict**，
   重新用真实仓库跑一轮 agent 测试，或将「占位链来源」标记为 `[未测]` 而非继承旧 verdict。
2. **合并去重**：`dsh-lark-link` 与 `amlyczz-dsh-lark-link` 是同一仓库的两种命名键，建议按 **GitHub repo id** 做主键归一，
   避免最新轮前缀化命名覆盖早期已正确判定的记录。
3. **Star 实时**：README/PLUGINS 的 star 建议每次渲染时经 GitHub API 实时刷新，或至少在定位复核成功后重取。

## 参考链接 / References
- 本仓库 PR 登记：`PLUGINS.md` 第 113 行（`📡 远程渠道`, `dsh-lark-link`, ✅）
- 占用例：`PLUGINS-ALL.md` 1619 行 `[不兼容] [amlyczz-dsh-lark-link] ... ★0`
- 定位缓存：`data/locate-cache.json` → `amlyczz-dsh-lark-link`: status `found`, full_name `amlyczz/dsh-lark-link`
- 快照：`data/snapshots/20260815T151237Z.json`（name `amlyczz-dsh-lark-link`, url 为 search 占位）

---
*如果只想单条修正，可接受的最小修复：把该条目的 star 刷新为 10，并把 verdict 从「不兼容」改为「可用」（或复核后落到 `[未测]`）。*
