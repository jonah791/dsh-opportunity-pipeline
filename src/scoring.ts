/**
 * scoring.ts — 机会打分（**纯函数**，无 IO、无网络、可离线单测）。
 *
 * ## 为什么口径是数据不是代码
 * 旧两件各有一套打分：`freelance-radar` 有 `ScoreBreakdown{keyword,tag,remote,freshness,quality}`
 * 与排除词表，`earn-radar` 连 digest 都没有。本件把口径收成**一个 `Profile` 对象**——
 * 改口径是改数据，不是改代码；且每一项都进 `breakdown`，让「为什么这条 72 分」可被追问。
 *
 * ## 公式（全确定，无随机、无时钟以外输入）
 * | 项 | 计法 | 上限 |
 * |---|---|---|
 * | `keyword` | 标题里每命中一个 `profile.keywords` 项 +12 | 48 |
 * | `tag` | 标签里每命中一个 +6 | 18 |
 * | `remote` | 标题或标签含 `远程/remote/居家/线上` 之一 +10 | 10 |
 * | `freshness` | 采集时刻距今 <6h +14 · <24h +10 · <72h +6 · 更早 +2 | 14 |
 * | `quality` | 标题长度 8–80 +4 · 标题含数字 +6 · 有 url +2 | 12 |
 *
 * 命中排除词 ⇒ `excluded=true`、`score=0`（`breakdown` 仍如实给出，便于复核排除是否过宽）。
 * 总分 = `min(100, 各项之和)`。
 *
 * ## 诚实标注
 * 这套权重是**设计判断，没有实测支撑**（旧件没有留下可用于标定的样本）。
 * 若它不能把机会分出层次，正确的处置是**删掉没有分辨力的项**，而不是反复调权重。
 */

import type { Profile, RawOpportunity, ScoreBreakdown } from './types.js'

/** 缺省画像：关键词与排除词都是数据，可在配置里整体覆盖。 */
export const DEFAULT_PROFILE: Profile = {
  keywords: [
    'ai', 'agent', 'llm', 'gpt', 'prompt', '模型', '自动化', '爬虫', '脚本',
    'python', 'typescript', 'javascript', 'node', 'api', '数据', '工具', 'workflow',
  ],
  excludeKeywords: [
    '区块链', 'web3', '币圈', '虚拟币', '加密货币', '博彩', '赌博', '刷单', '刷量', '灰产', '资金盘',
  ],
  minScore: 40,
}

/** 远程信号词——与旧件 `freelance-radar` 的口径同名同义。 */
const REMOTE_SIGNALS = ['远程', 'remote', '居家', '线上']

const HOUR_MS = 3_600_000

/** 打分结果。`excluded` 为真时 `score` 恒为 0，但 `breakdown` 仍是真实读数。 */
export interface ScoreResult {
  readonly score: number
  readonly breakdown: ScoreBreakdown
  readonly excluded: boolean
  readonly excludeReason?: string
}

/** 机会指纹：源 id + 源内键 ⇒ 跨轮去重的唯一键（不变量 I2）。 */
export function fingerprintOf(sourceId: string, key: string): string {
  return sourceId + '::' + key.trim().toLowerCase()
}

function haystackOf(o: RawOpportunity): string {
  return [o.title, ...(o.tags ?? [])].join(' ').toLowerCase()
}

function hits(text: string, needles: readonly string[]): number {
  let n = 0
  for (const needle of needles) {
    if (needle.length > 0 && text.includes(needle.toLowerCase())) n += 1
  }
  return n
}

/**
 * 给一条机会打分。
 *
 * @param o - 采集到的原始机会
 * @param profile - 打分画像（关键词/排除词/门槛）
 * @param nowMs - 现在（注入以便测；也是 freshness 的唯一时钟来源）
 * @returns 分数 + 明细 + 是否被排除
 */
export function scoreOpportunity(o: RawOpportunity, profile: Profile, nowMs: number): ScoreResult {
  const title = o.title.toLowerCase()
  const tags = (o.tags ?? []).join(' ').toLowerCase()
  const hay = haystackOf(o)

  const excludeHit = profile.excludeKeywords.find(k => k.length > 0 && hay.includes(k.toLowerCase()))
  const breakdown: ScoreBreakdown = {
    keyword: Math.min(48, hits(title, profile.keywords) * 12),
    tag: Math.min(18, hits(tags, profile.keywords) * 6),
    remote: REMOTE_SIGNALS.some(s => hay.includes(s)) ? 10 : 0,
    freshness: freshnessScore(nowMs - o.foundAtMs),
    quality: qualityScore(o),
  }
  const sum = breakdown.keyword + breakdown.tag + breakdown.remote + breakdown.freshness + breakdown.quality

  if (excludeHit !== undefined) {
    return { score: 0, breakdown, excluded: true, excludeReason: '命中排除词: ' + excludeHit }
  }
  return { score: Math.min(100, sum), breakdown, excluded: false }
}

/** 新鲜度分档（越新越高）。 */
export function freshnessScore(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 2
  if (ageMs < 6 * HOUR_MS) return 14
  if (ageMs < 24 * HOUR_MS) return 10
  if (ageMs < 72 * HOUR_MS) return 6
  return 2
}

/** 质量分档：标题长度适中 + 含数字 + 有链接。 */
export function qualityScore(o: RawOpportunity): number {
  let q = 0
  const len = o.title.trim().length
  if (len >= 8 && len <= 80) q += 4
  if (/\d/.test(o.title)) q += 6
  if (/^https?:\/\//.test(o.url)) q += 2
  return Math.min(12, q)
}

/** 一条机会是否达到呈现门槛（`dropped` 永不过门槛——不变量 I5）。 */
export function passesThreshold(score: number, minScore: number): boolean {
  return Number.isFinite(score) && score >= minScore
}
