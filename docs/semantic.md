# dsh-opportunity-pipeline 语义文档

## 1 · 元信息

- 插件名：`dsh-opportunity-pipeline`（插件内 `name = 'agent-opportunity-pipeline'`，组合行 id 同名）
- 版本：0.1.0 · 状态：**draft**（见第 7 节：未实现/未实测项已逐条标注）
- 状态：`draft` · 作者：爱丽丝 · 最近复核：2026-09-23
- 设计依据：`docs/plans/插件融合设计_机会流水线_2026-09-23.md`（本件是它的落地）
- 替换对象：`dsh-earn-radar` + `dsh-freelance-radar`

## 2 · 定位与反定位

**定位**：把「值得我投入的机会」从多源采集，经统一打分收敛成**一份 digest**、经**一条呈现通道**送达，且每一步都留账。

**反定位（硬边界，不做什么）**：

- **不发送任何消息**——推送由爱丽丝调用 telegram 工具执行。本件只产出文本，绝不持有发送通道（旧两件源码里同样零发送代码，推送一直由我手工做；本件把这条边界写成反定位而不是靠自觉）。
- **不判断值不值得做**——本件给分数与明细，判断归我。
- **不做支付/申领**——不碰钱、不碰平台账号。
- **不做通用爬虫**——只采集注册表里声明的源；加源靠加记录（声明式 probe）。
- **不假装「加源一律零代码」**——`probe` 档确实零代码，`builtin` 档需要代码适配器；本版 `builtin` **未实现且遇到即响亮报错**。

## 3 · 术语

| 术语 | 含义 |
|---|---|
| 源（source） | 一个机会来源。`kind: 'probe'`（声明式）或 `'builtin'`（需代码适配器，v0.1 未实现） |
| 探针（probe） | 一条声明：URL + 取值路径 + 过滤条件 + 字段映射。加一条探针 = 加一个采集面 |
| `where` | 过滤条件数组 `{path, op, value}`；op 见第 5 节，**未知 op 一律判否**（fail-closed） |
| 指纹（fp） | `源id::源内键` 的小写规范化——跨轮去重的唯一键 |
| 机会（opportunity） | 一条被打分的机会记录（含状态、明细、首次/最近见到时刻） |
| 呈现（presentation） | 一次 digest 的输出；**呈现即记账**，写进 `presentations.jsonl` |

## 4 · 概念模型与不变量

采集（`sources.ts`）→ 打分（`scoring.ts`）→ 并账（`store.ts`）→ 呈现（`index.ts`）。

不变量：

- **I1 账本坏则响亮报错**——「文件不存在」（合法初态 ⇒ 空）与「文件坏了」（抛错）必须可区分。空账本会让「没有机会」与「账本坏了」不可区分。
- **I2 指纹唯一**——同 `fp` 只保留一条；重复入库更新 `lastSeenAt`/分数，**保留既有 `status`**（我做过决策的机会不因再次采集被重置）。
- **I3 呈现即记账**——每次 digest 把本次 `fp` 集合写进 `presentations.jsonl`；写失败不阻断主流程但如实回报（`recorded: failed`）。
- **I4 凭据只以引用出现**——状态文件里只有 `authRef`（引用名），永不含值。**不沿用旧件 `earn-auth.json` 存 `{value}` 的明文落盘形态。**
- **I5 状态单调可查**——`decidedAt` 只在状态真的变化时写；`applied`/`dropped` 不再进 digest。
- **I6 本件不发送任何消息**——见第 2 节反定位。

## 5 · 契约

### 5.1 调用点清单

| 调用方 | 调用点（文件:符号） | 时机 |
|---|---|---|
| cordis 宿主 | `src/index.ts:name` / `inject` / `Config` / `apply` | 插件激活（缺 `inject` 声明即抛错） |
| 宿主 agent | `src/index.ts:apply → opp_sources` | 列/看/增改/删机会源 |
| 宿主 agent | `src/index.ts:apply → opp_scan` → `src/sources.ts:collectSource` → `src/scoring.ts:scoreOpportunity` → `src/store.ts:mergeOpportunities` | 一轮采集 |
| 宿主 agent | `src/index.ts:apply → opp_list` | 读账本 |
| 宿主 agent | `src/index.ts:apply → opp_decide` → `src/store.ts:decideOpportunity` | 定状态 |
| 宿主 agent | `src/index.ts:apply → opp_digest` → `src/store.ts:selectForDigest` + `appendPresentation` | 出 digest 并记账 |
| 外部 HTTP | `src/sources.ts:runProbe`（`undici` 的 `fetch` + `ProxyAgent`，经 `config.proxy`） | 采集时；代理不可用即失败，**不回落直连** |
| 爱丽丝（本件之外） | telegram 工具 | 推送（本件不发送，见 I6） |

### 5.2 工具契约（5 个，名字逐字）

| 工具 | 意图 | 关键参数 | 返回 |
|---|---|---|---|
| `opp_sources` | 源注册表：列/看/增改/删 | `action`（list/get/upsert/remove）· `id` · `sourceJson` | 文本（表或单条 JSON） |
| `opp_scan` | 采集 → 打分 → 并账 | `source`（缺省全部 enabled） | 各源计数 + 失败清单 + 新入账条数 |
| `opp_list` | 列账本（分数降序） | `status` · `minScore` · `source` · `limit` | 文本（含每条 `fp`） |
| `opp_decide` | 定状态 | `fp` · `status` · `note` | 文本 |
| `opp_digest` | 出 digest **并记账** | `minScore` · `limit` · `record` | 文本（含呈现记账结果） |

输出 schema 一律 `additionalProperties: false`（严格返回值校验），形状为 `{text}`。

### 5.3 配置契约（`Config`）

`enabled`(默认 true) · `stateDir`(默认 `''` ⇒ `<DSH_HOME>/opportunity-pipeline`) · `proxy`(默认 `http://127.0.0.1:16888`) · `profileJson`(默认 `''`，JSON 覆盖缺省画像) · `minScore`(默认 40)。

### 5.4 落盘契约

`<stateDir>/sources.json`（源注册表）· `<stateDir>/opportunities.json`（账本，原子写）· `<stateDir>/presentations.jsonl`（呈现账本，只追加）。**凭据不落盘**（I4）。

### 5.5 `where` 的 op 白名单

`eq` · `neq` · `in` · `startsWith` · `notStartsWith` · `gt` · `lt` · `contains` · `exists`。**其余一律判否**（fail-closed：spec 写错必须表现为「取不到」，绝不能表现为「全都算机会」）。

## 6 · 边界与信任

- **信任源**：只有源注册表里声明的 URL 会被请求；`itemsPath`/`where` 写错的表现是**取不到**而不是全量算机会（fail-closed）。
- **写入边界**：只写 `<stateDir>` 三个文件；不碰旧件状态、不碰凭据库。
- **危险面**：`opp_sources(upsert)` 会新增外部请求目标 ⇒ 加源前应确认该源的 ToS 与出金路径（本件不代判）。
- **失败语义（不静默）**：账本坏 ⇒ 抛错；单源采集失败 ⇒ 进失败清单且不拖垮整轮；`builtin` 档 ⇒ 抛错；digest 记账失败 ⇒ 返回 `failed` 但不阻断。
- **凭据**：v0.1 的 HTTP 采集**不带认证头**；需要认证的源等 `builtin` 档。`authRef` 是引用名，本版不消费。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名或命令或落盘产物） | 状态 |
|---|---|---|---|
| 1 | 打分公式确定：同输入同输出，各项进明细，总分封顶 100 | `tests/scoring.test.mjs`（7 例） | 已实测（离线） |
| 2 | 未知 op 判否（fail-closed） | `tests/spec.test.mjs`「尸体测试：未知 op（拼错）⇒ 判否，**绝不判是**」——8 个拼错 op（`equal`/`EQ`/`equals`/`eql`/`==`/`contain`/`existsAny`/空串）全判否，且**同数据用正确 op 必须判是**（对照证明那个「否」不是数据本来就不匹配） | 已实测（离线） |
| 3 | 指纹稳定且跨源不同 | `tests/scoring.test.mjs`「指纹稳定且大小写无关」 | 已实测（离线） |
| 4 | 命中排除词 ⇒ 0 分 + 理由，且明细不被掩盖 | `tests/scoring.test.mjs`「命中排除词…」 | 已实测（离线） |
| 5 | 账本坏 ⇒ 抛错；不存在 ⇒ 空初态（两者可区分） | `tests/store.test.mjs`「I1 不变量…」 | 已实测（离线） |
| 6 | 同 fp 只一条；重复入库保留既有 status | `tests/store.test.mjs`「I2 不变量…」 | 已实测（离线） |
| 7 | `decidedAt` 只在状态真变化时写 | `tests/store.test.mjs`「I5 不变量…」 | 已实测（离线） |
| 8 | digest **不按「今天首次出现」过滤**（旧件缺陷的回归） | `tests/store.test.mjs`「回归：digest 选取…」 | 已实测（离线） |
| 9 | dropped/applied/被排除的不进 digest；门槛与 limit 生效 | `tests/store.test.mjs`「digest 选取…」 | 已实测（离线） |
| 10 | 呈现即记账：每次 digest 追加一行；写失败返回 false 不抛 | `tests/store.test.mjs`「I3 呈现即记账…」 | 已实测（离线） |
| 11 | 原子写不留 `.tmp` 残片 | `tests/store.test.mjs`「落盘往返…」 | 已实测（离线） |
| 12 | 构建与类型：`npm run build` / `tsc --noEmit` 退出码 0 | 命令 | 已实测（离线） |
| 13 | 全量测试 **24/24** 全绿 | `node --test tests/*.test.mjs`（scoring 7 + store 9 + spec 8） | 已实测（离线） |
| 14 | 迁移只读：迁移后旧状态文件 SHA-256 与迁移前一致 | 迁移脚本输出「只读校验：旧文件逐字节未变 ✓」，哈希 `6773a6fdf9b6ecc4ea5abd6e340c45b62a25ef735d78dc89b9d015d6dcf86e5b` | 已实测（现场） |
| 15 | 迁移保真：旧 jobs 落进新账本，状态映射 new→fresh / considered→pursuing / applied→applied / ignored→dropped | 实测 **365 → 356**（旧数据 9 条重复指纹按 I2 去重，保留 `lastSeenAt` 最新者）· 状态分布 `{new:364,considered:1}` → `{fresh:355,pursuing:1}` · 挂载后 `opp_list` 读出 356 条 | 已实测（现场 + 线上） |
| 16 | 5 个工具在真实组合里在场 | 挂载 + 哨兵重启后：`opp_sources` 答（源注册表为空 + stateDir 正确解析到 `<DSH_HOME>/opportunity-pipeline`）· `opp_list` 读出 356 条；`plugin_boot_status` 报 **live 61 / 需重启 0** | 已实测（线上） |
| 17 | 端到端：加一个真源 → `opp_scan` → `opp_digest` → 记账行出现 | 2026-09-23 实跑（冒烟源 `smoke-gh` = GitHub 公开 API）：`opp_scan` ⇒ `collected=30 · 新入账 30 · 账本 386 条 · 无失败`（HTTP 经 `ProxyAgent` 走 Clash 真通，`proxy_http=200`）；`opp_digest` ⇒ 3 条带分（**50/38/38，有分辨力**）· `呈现记账: ok`；盘上 `presentations.jsonl` 恰一行 `{count:3, fps:[…], minScore:0}` | 已实测（线上 + 落盘核对） |
| 18 | 本件不发消息：源码里零发送调用 | `grep -rniE 'telegram\|sendMessage\|smtp\|webhook' src/` ⇒ **3 处命中全是注释/工具描述**（声明这条边界本身），**零代码命中** | 已实测（离线） |

## 8 · 与实现的关系

**生效判据**（改了代码后怎么证明真的在跑新构建）：

1. **构建-进程先后**：`lib/index.js` 的 mtime 必须**晚于** web 进程启动时间——mtime 新只证明「构建过」，不证明「进程在跑它」；
2. **工具可答**：`opp_sources` 能列出注册表 ⇒ 插件已在本进程加载；
3. **落盘产物**：`<stateDir>/sources.json`、`opportunities.json`、`presentations.jsonl` 出现且 mtime 前进。

**回退**：unmount 本件、把 `dsh-earn-radar`/`dsh-freelance-radar` 从 `_archive/` 还原并重挂；**数据面零成本**——迁移是**复制**，旧状态文件从未被改写。

## 9 · 实践修订记录

- 2026-09-23 首版（v0.1.0）：由 `dsh-earn-radar` + `dsh-freelance-radar` 融合重设计而来。三处**从旧件实测中修正**的语义：① digest **不再按「今天首次出现」过滤**（旧件 `freelance-radar/src/index.ts:555` 会让未标记的高分机会次日静默消失且永不回来）② 重复入库**保留既有 status** ③ `authRef` 从「指向 `earn-auth.json` 的 `{value}`」改为「**引用名**」——凭据值不再落状态文件（I4）。另：旧件 `earn-platforms.json` 在盘上**不存在**（注册表从未落盘）⇒ 迁移无此面。
- 2026-09-23 同日验收闭环：18 条验收**全部结案**（离线单测 24/24 · 迁移只读与保真 · 挂载后工具在真实组合可答 · 端到端冒烟含 digest 与呈现记账 · 零发送调用）。**过程中逼出两条实现缺口**（已入 §10）：账本无删除面、`opp_scan` 无 dry-run——**纯函数测试看不见它们，是端到端冒烟逼出来的**。另记一个正面数据点：30 条真实条目上分数分布 50/38/38 ⇒ 打分**有分辨力**（对 §10 第 1 条「权重无标定」是个初步反证）。

## 10 · 未决问题

1. **打分权重无实测支撑**——公式是设计判断，旧件没留下可标定的样本。若它不能把机会分出层次，正确处置是**删掉没有分辨力的项**，而不是反复调权重。
2. **`builtin` 档未实现**——需要签名/分页/令牌刷新的源（含需要认证的源）目前无法接入。是补齐 builtin，还是把这类源做成「本地代理脚本 + probe」？
3. **`spec.test.mjs` 未写**（验收表第 2 行）——`matchWhere` 的九种 op 与未知 op 判否尚无单测覆盖。
4. **`opp_sources(upsert)` 没有「先跑通再保存」**——旧件 `earn_remember` 有该能力（带 probes 时先跑通、跑不通拒绝保存）。是否补回？
5. **迁移脚本的幂等性**——重复运行是否会重复计入（当前设计是「覆盖写新账本」，故幂等；但未实测）。
6. **呈现账本没有消费方**——`presentations.jsonl` 在写，但「哪些机会已经被推过、要不要节流」尚无工具面。旧件连这个面都没有，故不是回归，是**未闭合的新能力**。
7. **账本没有删除面**——只有 `decide`（改状态）与 `opp_digest`，没有「移除一条 / 清一批」。冒烟测试留下的 30 条 `smoke-gh` 条目因此只能留在账本里（分数 38–50、状态 `fresh`，会在低门槛 digest 里出现）。要么补删除/归档面，要么给扫描加不落账本的 dry-run 通道（见第 8 条）。
8. **`opp_scan` 没有 dry-run**——加源时无法「先跑通再决定是否落账」（旧件 `earn_remember` 带 probes 时有该能力）。这是端到端冒烟会污染账本的结构性原因。
