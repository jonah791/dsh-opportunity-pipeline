# dsh-opportunity-pipeline

机会流水线：把「值得我投入的机会」从多源采集，经统一打分收敛成**一份 digest**、经**一条呈现通道**送达，且每一步都留账。

替换 `dsh-earn-radar` + `dsh-freelance-radar`。设计依据：[插件融合设计_机会流水线](../../docs/plans/插件融合设计_机会流水线_2026-09-23.md)；语义正本：[docs/semantic.md](docs/semantic.md)。

## 用途

- **多源采集**：源是数据（加一个源 = 加一条记录），声明式探针即可覆盖大多数 JSON API
- **统一打分**：一套画像（关键词 / 排除词 / 门槛），每一项分数都进明细，口径可被追问
- **一份 digest**：不再两份割裂的报数
- **呈现即记账**：每次 digest 都把本次呈现的指纹集合写进账本（旧件没有这个面）

## 工具（5 个）

| 工具 | 意图 | 关键参数 |
|---|---|---|
| `opp_sources` | 源注册表：列 / 看 / 增改 / 删 | `action` · `id` · `sourceJson` |
| `opp_scan` | 采集 → 打分 → 并账 | `source`（缺省全部 enabled） |
| `opp_list` | 列账本（分数降序） | `status` · `minScore` · `source` · `limit` |
| `opp_decide` | 定状态（fresh/pursuing/applied/dropped） | `fp` · `status` · `note` |
| `opp_digest` | 出 digest **并记账** | `minScore` · `limit` · `record` |

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `stateDir` | `''` | 空 ⇒ `<DSH_HOME>/opportunity-pipeline` |
| `proxy` | `http://127.0.0.1:16888` | Clash 显式代理；**代理不可用即失败，不回落直连** |
| `profileJson` | `''` | JSON，覆盖缺省画像的任意子集（`keywords`/`excludeKeywords`/`minScore`） |
| `minScore` | `40` | 门槛（覆盖画像里的值） |

## 落盘

`<stateDir>/sources.json`（源注册表）· `<stateDir>/opportunities.json`（账本，原子写）· `<stateDir>/presentations.jsonl`（呈现账本，只追加）。**凭据不落盘**——`authRef` 是引用名，不是值。

## 反定位（硬边界）

**不发送任何消息**（推送由爱丽丝调用 telegram 工具执行）· 不判断值不值得做 · 不做支付/申领 · 不做通用爬虫 · 不假装「加源一律零代码」（`probe` 档零代码，`builtin` 档需适配器，**v0.1 未实现且遇到即响亮报错**）。

## 生效判据

1. **构建-进程先后**：`lib/index.js` 的 mtime 必须晚于 web 进程启动时间（mtime 新只证明构建过，不证明进程在跑它）
2. **工具可答**：`opp_sources` 能列出注册表
3. **落盘产物**：三个状态文件出现且 mtime 前进

## 回退

`plugin_unmount dsh-opportunity-pipeline` → 把 `dsh-earn-radar` / `dsh-freelance-radar` 从 `_archive/` 还原并重挂。**数据面零成本**——迁移是**复制**，旧状态文件从未被改写（迁移脚本的只读校验：旧文件 SHA-256 前后一致）。

## 开发

```sh
npm run build       # tsc
npm run typecheck   # tsc --noEmit
npm test            # node --test "tests/*.test.mjs"
node scripts/migrate-radar-state.mjs --home=<DSH_HOME> --dry-run   # 迁移预演
```

迁移脚本只读旧件、只写新件；`--verify` 只校验旧文件哈希与迁移计数。
