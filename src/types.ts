/**
 * types.ts — 机会流水线的实体、状态与不变量（纯类型，无 IO）。
 *
 * 定位见 `docs/semantic.md`。本文件只声明形状；判定逻辑在 `scoring.ts`，
 * 落盘在 `store.ts`，采集在 `sources.ts`。
 */

/** 机会来源的两种形态。`probe` 是声明式（加源不改代码），`builtin` 需要代码适配器。 */
export type SourceKind = 'probe' | 'builtin'

/**
 * 机会的状态。
 *
 * ⚠ 与旧件 `JobStatus`（`new`/`considered`/`applied`/`ignored`）的映射见迁移脚本：
 * `new→fresh` · `considered→pursuing` · `applied→applied` · `ignored→dropped`。
 */
export type OpportunityStatus = 'fresh' | 'pursuing' | 'applied' | 'dropped'

/** 声明式探针的一条过滤条件。`op` 取值由 `sources.ts` 的白名单决定（不认的 op 一律 fail-loud）。 */
export interface Where {
  readonly path: string
  readonly op: string
  readonly value?: unknown
}

/**
 * 一条声明式探针：**加一个源 = 加一条记录**（只要它能用这套声明表达）。
 *
 * `authRef` 是**指向凭据条目的引用**（不是值本身）——值只经执行层注入，永不进状态文件。
 */
export interface ProbeSpec {
  readonly label: string
  readonly url: string
  readonly method?: string
  readonly authRef?: string
  readonly itemsPath?: string
  readonly where?: readonly Where[]
  readonly itemKey?: string
  readonly itemTitle?: string
  readonly itemValue?: string
  readonly unit?: string
  readonly countsPath?: string
}

/** 一个机会来源。`builtin` 档用 `adapter` 指定代码适配器；`probe` 档用 `probes`。 */
export interface Source {
  readonly id: string
  readonly kind: SourceKind
  readonly label: string
  readonly enabled: boolean
  readonly notes?: string
  readonly probes?: readonly ProbeSpec[]
  readonly adapter?: string
  readonly authRef?: string
}

/** 打分画像：关键词与排除词是**数据**，改口径不改代码。 */
export interface Profile {
  readonly keywords: readonly string[]
  readonly excludeKeywords: readonly string[]
  readonly minScore: number
}

/** 打分明细——每一分都能指到一项，便于事后质疑口径本身。 */
export interface ScoreBreakdown {
  readonly keyword: number
  readonly tag: number
  readonly remote: number
  readonly freshness: number
  readonly quality: number
}

/** 采集到的原始机会（打分前）。 */
export interface RawOpportunity {
  readonly sourceId: string
  readonly key: string
  readonly title: string
  readonly url: string
  readonly value?: number
  readonly unit?: string
  readonly tags?: readonly string[]
  readonly foundAtMs: number
}

/** 落盘的机会记录。 */
export interface Opportunity extends RawOpportunity {
  /** 指纹：跨轮去重的唯一键（源 id + key）。 */
  readonly fp: string
  readonly score: number
  readonly breakdown: ScoreBreakdown
  readonly excluded: boolean
  readonly excludeReason?: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly status: OpportunityStatus
  readonly decidedAt?: string
  /** 最近一次被 digest 呈现的时刻——**呈现即记账**（旧件没有这个面）。 */
  readonly presentedAt?: string
  readonly note?: string
}

/** 账本（`opportunities.json` 的顶层形状）。 */
export interface Ledger {
  readonly version: 1
  readonly opportunities: readonly Opportunity[]
}

/** 呈现账本的一条（`presentations.jsonl`，一行一次）。 */
export interface Presentation {
  readonly at: string
  readonly count: number
  readonly fps: readonly string[]
  readonly minScore: number
}

/**
 * 不变量（由 `store.ts` 与 `index.ts` 共同维持）：
 *
 * I1. **账本坏则响亮报错**——JSON 解析失败或形状不符，抛错并带上文件路径，绝不静默返回空账本
 *     （空账本会让「没有机会」与「账本坏了」不可区分）。
 * I2. **指纹唯一**——同一 `fp` 只允许一条记录；重复入库走「更新 lastSeenAt」而不是新增。
 * I3. **呈现即记账**——每次 digest 都把本次呈现的 fp 集合写进 `presentations.jsonl`。
 * I4. **凭据只以引用出现**——状态文件里只有 `authRef`，永不含值。
 * I5. **状态单调可查**——`decidedAt` 只在状态真的变化时写；`dropped` 不再进 digest。
 * I6. **本件不发送任何消息**——推送由爱丽丝调用 telegram 工具执行（反定位）。
 */
export const INVARIANTS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'] as const
