# [Bug] `amlyczz-dsh-lark-link` falsely marked `incompatible ★0` — placeholder-URL misjudgment, not the real repo state

## Summary

In `PLUGINS-ALL.md` bottom owner-group section (`**amlyczz**`, ~line 2619), the entry
`amlyczz-dsh-lark-link` shows `[不兼容] ★0`.
That verdict comes from the radar pipeline testing a **GitHub search placeholder URL**
(`https://github.com/search?q=amlyczz-dsh-lark-link`) instead of the real repository,
so both `star=0` and "incompatible" are artifacts — they never touched the actual repo.

The real repo is fine and already PR-registered:
- `PLUGINS.md` (registry, line 113, `📡 远程渠道`): marked **✅**
- Earlier snapshot (`PLUGINS-ALL.md` line 159, `📡 消息通讯`): `★5 ✅[可用]`

## Root cause evidence

Merging `data/snapshots/*.json` produces two different keys for the same repo:

| snapshot round | name | url | star | verdict |
|---|---|---|---|---|
| 20260814 → 20260815T071634Z (older) | `dsh-lark-link` | `https://github.com/amlyczz/dsh-lark-link` | 3→5 | ✅ compatible |
| **20260815T125358Z / T151237Z (latest two)** | `amlyczz-dsh-lark-link` | `https://github.com/search?q=amlyczz-dsh-lark-link` | **0** | **❌ incompatible** |

`gen-plugins-all.py` merges newest-claims-overwrite (`(name,url)` key, rounds sorted by `run_id` desc).
The latest two rounds: ① switched discovery naming to the `owner-repo` prefix; ② produced a `github.com/search?q=...`
placeholder URL; ③ pulled `star=0`; ④ the agent test ran against the placeholder and judged "incompatible".
Even though `resolve_placeholders.py` later fixed the URL back to the real repo (`locate-cache.json`:
`amlyczz-dsh-lark-link → found → amlyczz/dsh-lark-link`), **`star` and `verdict` were never rebuilt**, so the bad data leaked into the rendered list.

**Live real values (GitHub API, 2026-08-16):**
- `amlyczz/dsh-lark-link`
- `stargazers_count = 10`
- topics include `dsh-plugin` (satisfies auto-discovery)
- description: High-reliability Feishu/Lark bridge ...

## Impact

- Users will think this Feishu/Lark bridge is "incompatible with DSH", though it runs (registry ✅).
- Star shows 0 vs the actual 10, hurting visibility for a new author.
- Likely affects other `owner-repo`-prefixed scan entries too — worth checking how widespread "placeholder URL judged incompatible" is.

## Suggested fix

1. **Rebuild judgment for repaired URLs**: for entries whose URL was fixed from a placeholder to the real repo
   (`locate == 'located'` after repair), discard the stale `star`/`verdict`; re-run an agent test on the real repo,
   or at least mark them `[未测]` instead of inheriting the old verdict.
2. **Dedupe by GitHub repo id**: `dsh-lark-link` and `amlyczz-dsh-lark-link` are two naming keys for the same repo —
   normalize on the GitHub repo id so the newer prefixed name doesn't overwrite an already-correct earlier verdict.
3. **Refresh stars live**: refresh star counts via the GitHub API at render time, or at least re-fetch once the URL
   is verified.

## References
- Registry: `PLUGINS.md` line 113 (`📡 远程渠道`, `dsh-lark-link`, ✅)
- Symptom: `PLUGINS-ALL.md` line 2619 `[不兼容] [amlyczz-dsh-lark-link] ... ★0`
- Location cache: `data/locate-cache.json` → `amlyczz-dsh-lark-link`: status `found`, full_name `amlyczz/dsh-lark-link`
- Snapshot: `data/snapshots/20260815T151237Z.json` (name `amlyczz-dsh-lark-link`, url is the search placeholder)

---
*If a single-entry fix is preferred, the minimal change: refresh the star to 10 and change the verdict from
"incompatible" to "compatible" (or drop it to `[未测]` pending re-verification).*
