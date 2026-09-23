/**
 * store.ts — 状态落盘（三个落点分离，各自职责单一）。
 *
 * | 文件 | 职责 | 坏掉的后果 |
 * |---|---|---|
 * | `sources.json` | 源注册表（机会从哪来） | 响亮报错，不静默空表 |
 * | `opportunities.json` | 机会账本（含状态与决策） | 响亮报错——空账本会让「没机会」与「账本坏了」不可区分 |
 * | `presentations.jsonl` | 呈现账本（一行一次，**呈现即记账**） | 只追加；写失败不阻断主流程但如实回报 |
 *
 * 不变量 I1：**账本坏则响亮报错**。判据是「文件存在但解析失败/形状不符」——
 * 文件不存在是正常初态（返回空），两者必须可区分。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ledger, Opportunity, Presentation, Source } from './types.js'

/** 三个落点的文件名（单一真源）。 */
export const FILES = {
  sources: 'sources.json',
  ledger: 'opportunities.json',
  presentations: 'presentations.jsonl',
} as const

/** 某状态目录下三个落点的绝对路径。 */
export function pathsOf(stateDir: string): Record<keyof typeof FILES, string> {
  return {
    sources: join(stateDir, FILES.sources),
    ledger: join(stateDir, FILES.ledger),
    presentations: join(stateDir, FILES.presentations),
  }
}

/** 确保状态目录存在（幂等）。 */
export function ensureDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true })
}

/**
 * 读 JSON：不存在 ⇒ 返回缺省；**存在但坏了 ⇒ 抛错**（不变量 I1）。
 *
 * @param path - 文件路径
 * @param fallback - 文件不存在时的缺省值
 * @param shapeOk - 形状校验（返回 false 即视为坏文件）
 */
export function readJsonStrict<T>(path: string, fallback: T, shapeOk: (v: unknown) => boolean): T {
  if (!existsSync(path)) return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error('状态文件损坏（JSON 解析失败）：' + path + ' —— ' + String(err))
  }
  if (!shapeOk(parsed)) {
    throw new Error('状态文件形状不符：' + path + '（期望 ' + JSON.stringify(fallback).slice(0, 80) + ' 的形状）')
  }
  return parsed as T
}

/** 原子写：先写临时文件再 rename（避免半截文件被当成有效状态）。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** 源注册表：缺省为空表（合法初态）。 */
export function loadSources(stateDir: string): Source[] {
  const p = pathsOf(stateDir).sources
  return readJsonStrict<Source[]>(p, [], v => Array.isArray(v))
}

/** 写源注册表。 */
export function saveSources(stateDir: string, sources: readonly Source[]): void {
  ensureDir(stateDir)
  writeJsonAtomic(pathsOf(stateDir).sources, sources)
}

/** 机会账本：缺省为空账本；坏文件抛错（I1）。 */
export function loadLedger(stateDir: string): Ledger {
  const p = pathsOf(stateDir).ledger
  return readJsonStrict<Ledger>(p, { version: 1, opportunities: [] }, v => {
    if (typeof v !== 'object' || v === null) return false
    const o = v as { version?: unknown; opportunities?: unknown }
    return o.version === 1 && Array.isArray(o.opportunities)
  })
}

/** 写机会账本（原子）。 */
export function saveLedger(stateDir: string, ledger: Ledger): void {
  ensureDir(stateDir)
  writeJsonAtomic(pathsOf(stateDir).ledger, ledger)
}

/** 追加一条呈现记录（**呈现即记账**，不变量 I3）。写失败如实返回 false，不抛。 */
export function appendPresentation(stateDir: string, rec: Presentation): boolean {
  try {
    ensureDir(stateDir)
    appendFileSync(pathsOf(stateDir).presentations, JSON.stringify(rec) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 把新采集的机会并进既有账本（**纯函数**，不变量 I2）。
 *
 * 同一 `fp` 只保留一条：更新 `lastSeenAt` / `score` / `breakdown`，**保留既有 `status`**——
 * 我做过决策的机会不因再次采集而被重置成 `fresh`（旧件这里没有区分）。
 *
 * @param existing - 既有账本条目
 * @param incoming - 本轮采集到的（已打分的）机会
 * @param nowIso - 现在（注入以便测）
 * @returns 新账本条目（按分数降序、同分按 fp）
 */
export function mergeOpportunities(
  existing: readonly Opportunity[],
  incoming: readonly Opportunity[],
  nowIso: string,
): Opportunity[] {
  const byFp = new Map<string, Opportunity>()
  for (const o of existing) byFp.set(o.fp, o)

  for (const inc of incoming) {
    const prev = byFp.get(inc.fp)
    if (prev === undefined) {
      byFp.set(inc.fp, { ...inc, firstSeenAt: nowIso, lastSeenAt: nowIso, status: 'fresh' })
      continue
    }
    byFp.set(inc.fp, {
      ...prev,
      title: inc.title,
      url: inc.url,
      value: inc.value,
      unit: inc.unit,
      tags: inc.tags,
      score: inc.score,
      breakdown: inc.breakdown,
      excluded: inc.excluded,
      excludeReason: inc.excludeReason,
      lastSeenAt: nowIso,
      // status / firstSeenAt / decidedAt / presentedAt / note 一律沿用既有值
    })
  }

  return [...byFp.values()].sort((a, b) => (b.score - a.score) || a.fp.localeCompare(b.fp))
}

/**
 * 改一条机会的状态（**纯函数**，不变量 I5：只有真变化才写 `decidedAt`）。
 *
 * @returns 新账本条目数组；`fp` 不存在则返回 null（调用方据此报错）
 */
export function decideOpportunity(
  opportunities: readonly Opportunity[],
  fp: string,
  status: Opportunity['status'],
  nowIso: string,
  note?: string,
): Opportunity[] | null {
  const idx = opportunities.findIndex(o => o.fp === fp)
  if (idx < 0) return null
  const cur = opportunities[idx] as Opportunity
  const next: Opportunity = {
    ...cur,
    status,
    decidedAt: cur.status === status ? cur.decidedAt : nowIso,
    note: note ?? cur.note,
  }
  const out = [...opportunities]
  out[idx] = next
  return out
}

/**
 * 移除某个源的**全部**账本条目（**纯函数**）。
 *
 * 用途：退役一个源时把它留下的条目一起清掉——否则「源没了、条目还在」会让 digest
 * 一直推一个再也更新不了的机会。2026-09-23 端到端冒烟暴露了这一点：账本原本没有删除面，
 * 冒烟源留下的 30 条只能留在账本里（见语义文档 §10 第 7 条）。
 *
 * @returns 新条目数组 + 被移除的条数（调用方据此回报，**不静默**）
 */
export function removeBySource(
  opportunities: readonly Opportunity[],
  sourceId: string,
): { opportunities: Opportunity[]; removed: number } {
  const kept = opportunities.filter(o => o.sourceId !== sourceId)
  return { opportunities: kept, removed: opportunities.length - kept.length }
}

/**
 * 选出该进 digest 的机会（**纯函数**）。
 *
 * 判据：`status` 是 `fresh` 或 `pursuing`（`applied`/`dropped` 不再打扰我）
 * 且 `score >= minScore` 且未被排除。**不按「今天首次出现」过滤**——
 * 旧件 `freelance-radar` 用 `firstSeenAt.slice(0,10) === todayKey` 过滤，
 * 导致未标记的高分机会**次日静默消失且永不回来**（`src/index.ts:555`，2026-09-23 实测）。
 */
export function selectForDigest(
  opportunities: readonly Opportunity[],
  minScore: number,
  limit: number,
): Opportunity[] {
  return opportunities
    .filter(o => !o.excluded && (o.status === 'fresh' || o.status === 'pursuing') && o.score >= minScore)
    .slice(0, Math.max(0, limit))
}
