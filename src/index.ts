/**
 * dsh-opportunity-pipeline — 机会流水线。
 *
 * 把「值得我投入的机会」从多源采集经统一打分收敛成一份 digest、经一条呈现通道送达，
 * 且每一步都留账。替换 `dsh-earn-radar` + `dsh-freelance-radar`
 * （设计见 `docs/plans/插件融合设计_机会流水线_2026-09-23.md`）。
 *
 * 反定位（硬边界）：**不发送任何消息**（推送由爱丽丝调用 telegram 工具执行）·
 * 不判断值不值得做 · 不做支付/申领 · 不做通用爬虫。
 *
 * @module dsh-opportunity-pipeline
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Opportunity, OpportunityStatus, Profile, Source } from './types.js'
import { DEFAULT_PROFILE, fingerprintOf, scoreOpportunity } from './scoring.js'
import { collectSource } from './sources.js'
import {
  appendPresentation,
  decideOpportunity,
  ensureDir,
  loadLedger,
  loadSources,
  mergeOpportunities,
  pathsOf,
  saveLedger,
  saveSources,
  selectForDigest,
} from './store.js'

/** 插件名（与 cordis.patch.yml 的 id `agent-opportunity-pipeline` 对齐）。 */
export const name = 'agent-opportunity-pipeline'

/** 只依赖工具面。 */
export const inject = ['tools'] as const

/** 配置。`stateDir` 缺省落 `<DSH_HOME>/opportunity-pipeline`。 */
export interface Config {
  enabled: boolean
  stateDir: string
  proxy: string
  profileJson: string
  minScore: number
}

/** 配置 schema。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  stateDir: z.string().default(''),
  proxy: z.string().default('http://127.0.0.1:16888'),
  profileJson: z.string().default(''),
  minScore: z.number().default(40),
})

/** 统一文本输出契约。 */
const textOut = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_a: unknown, v: { text: string }) => [{ type: 'text', text: v.text }],
} as const

const tool = (spec: unknown): never => defineTool(spec as never) as never

/** 解析画像：`profileJson` 覆盖缺省画像的任意子集，`minScore` 单独可覆盖。 */
export function resolveProfile(profileJson: string, minScore: number): Profile {
  let parsed: Partial<Profile> = {}
  if (profileJson.trim().length > 0) {
    try {
      parsed = JSON.parse(profileJson) as Partial<Profile>
    } catch (err) {
      throw new Error('profileJson 不是合法 JSON：' + String(err))
    }
  }
  return {
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : DEFAULT_PROFILE.keywords,
    excludeKeywords: Array.isArray(parsed.excludeKeywords) ? parsed.excludeKeywords : DEFAULT_PROFILE.excludeKeywords,
    minScore: Number.isFinite(minScore) ? minScore : (parsed.minScore ?? DEFAULT_PROFILE.minScore),
  }
}

const STATUSES: readonly OpportunityStatus[] = ['fresh', 'pursuing', 'applied', 'dropped']

/** 注册 5 个工具。 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('opportunity-pipeline')
  const DIR = config.stateDir.trim().length > 0
    ? config.stateDir
    : join(process.env.DSH_HOME ?? '.', 'opportunity-pipeline')
  const profile = resolveProfile(config.profileJson, config.minScore)
  ensureDir(DIR)
  log.info('机会流水线就绪：stateDir=%s  minScore=%d  proxy=%s', DIR, profile.minScore, config.proxy)

  // ── ① 源注册表：加源靠加记录，不靠加代码 ────────────────────
  ctx.tools.register(tool({
    name: 'opp_sources',
    description: '机会源注册表：列（缺省）/ 看一个 / 增改 / 删。加源靠加一条记录（声明式 probe），不靠加代码。'
      + 'probe 字段：{label, url, method?, itemsPath?, where?[{path,op,value}], itemKey?, itemTitle?, itemValue?, unit?}；'
      + 'op 取值 eq/neq/in/startsWith/notStartsWith/gt/lt/contains/exists，未知 op 一律判否（fail-closed）。',
    parameters: {
      action: { type: 'string', description: 'list（缺省）| get | upsert | remove' },
      id: { type: 'string', description: '源 id（get/upsert/remove 需要）' },
      sourceJson: { type: 'string', description: 'upsert 时的源记录 JSON：{id,kind:"probe",label,enabled,probes:[…]}' },
    },
    output: textOut,
    async execute(args: { action?: string; id?: string; sourceJson?: string }) {
      const action = (args.action ?? 'list').trim()
      const sources = loadSources(DIR)
      if (action === 'list') {
        if (sources.length === 0) return { text: '(源注册表为空：' + pathsOf(DIR).sources + ')' }
        return {
          text: sources.map(s => '  ' + s.id.padEnd(18) + (s.enabled ? 'on ' : 'off')
            + ' ' + s.kind.padEnd(8) + 'probes=' + String((s.probes ?? []).length).padEnd(3) + '| ' + s.label).join('\n'),
        }
      }
      if (args.id === undefined || args.id.trim().length === 0) return { text: '缺 id' }
      const id = args.id.trim()
      if (action === 'get') {
        const hit = sources.find(s => s.id === id)
        return { text: hit === undefined ? '(无此源: ' + id + ')' : JSON.stringify(hit, null, 1) }
      }
      if (action === 'remove') {
        const next = sources.filter(s => s.id !== id)
        if (next.length === sources.length) return { text: '(无此源: ' + id + ')' }
        saveSources(DIR, next)
        return { text: '已移除源 ' + id + '（余 ' + next.length + ' 个）' }
      }
      if (action === 'upsert') {
        if (args.sourceJson === undefined) return { text: 'upsert 需要 sourceJson' }
        let spec: Source
        try {
          spec = JSON.parse(args.sourceJson) as Source
        } catch (err) {
          return { text: 'sourceJson 不是合法 JSON：' + String(err) }
        }
        if (spec.id !== id) return { text: 'sourceJson.id (' + String(spec.id) + ') 与 id 参数 (' + id + ') 不一致' }
        if (spec.kind !== 'probe' && spec.kind !== 'builtin') return { text: 'kind 必须是 probe 或 builtin' }
        const next = sources.filter(s => s.id !== id)
        next.push({ ...spec, enabled: spec.enabled !== false })
        saveSources(DIR, next)
        return { text: '已保存源 ' + id + '（共 ' + next.length + ' 个；probes=' + String((spec.probes ?? []).length) + '）' }
      }
      return { text: '未知 action: ' + action }
    },
  }))

  // ── ② 扫描：采集 → 打分 → 并账 ──────────────────────────────
  ctx.tools.register(tool({
    name: 'opp_scan',
    description: '扫描机会源（缺省全部 enabled 的源）：采集 → 统一打分 → 并入账本（指纹去重，已决策的状态不被重置）。'
      + '返回各源计数、失败清单与新入账条数。',
    parameters: { source: { type: 'string', description: '只扫这一个源 id（缺省=全部 enabled）' } },
    output: textOut,
    async execute(args: { source?: string }) {
      const sources = loadSources(DIR).filter(s => args.source === undefined || s.id === args.source)
      if (sources.length === 0) return { text: '(没有匹配的源：' + pathsOf(DIR).sources + ')' }
      const nowMs = Date.now()
      const nowIso = new Date(nowMs).toISOString()
      const lines: string[] = []
      const failures: string[] = []
      const incoming: Opportunity[] = []
      let collected = 0

      for (const s of sources) {
        try {
          const r = await collectSource(s, { proxy: config.proxy, nowMs })
          collected += r.raw.length
          for (const raw of r.raw) {
            const sc = scoreOpportunity(raw, profile, nowMs)
            incoming.push({
              ...raw,
              fp: fingerprintOf(raw.sourceId, raw.key),
              score: sc.score,
              breakdown: sc.breakdown,
              excluded: sc.excluded,
              excludeReason: sc.excludeReason,
              firstSeenAt: nowIso,
              lastSeenAt: nowIso,
              status: 'fresh',
            })
          }
          lines.push('  ' + s.id.padEnd(18) + ' collected=' + String(r.raw.length).padEnd(5)
            + (r.failures.length > 0 ? 'failures=' + String(r.failures.length) : 'ok'))
          failures.push(...r.failures.map(f => s.id + ' / ' + f))
        } catch (err) {
          failures.push(s.id + ' / ' + String(err instanceof Error ? err.message : err))
          lines.push('  ' + s.id.padEnd(18) + ' FAILED')
        }
      }

      const before = loadLedger(DIR).opportunities.length
      const merged = mergeOpportunities(loadLedger(DIR).opportunities, incoming, nowIso)
      saveLedger(DIR, { version: 1, opportunities: merged })
      const added = merged.length - before

      return {
        text: ['OPPORTUNITY SCAN  at=' + nowIso + '  sources=' + sources.length,
          ...lines,
          '采集 ' + collected + ' 条 · 新入账 ' + added + ' 条 · 账本共 ' + merged.length + ' 条',
          failures.length > 0 ? '--- 失败 ' + failures.length + ' ---\n' + failures.map(f => '  ' + f).join('\n') : '--- 无失败 ---',
        ].join('\n'),
      }
    },
  }))

  // ── ③ 列账 ─────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'opp_list',
    description: '列机会账本（按分数降序）。可按状态/最低分/源过滤。默认不列 dropped（要看请显式传 status=dropped）。',
    parameters: {
      status: { type: 'string', description: 'fresh | pursuing | applied | dropped（缺省=除 dropped 外全部）' },
      minScore: { type: 'number', description: '最低分（缺省=0）' },
      source: { type: 'string', description: '按源 id 过滤' },
      limit: { type: 'number', description: '条数上限（缺省 20）' },
    },
    output: textOut,
    async execute(args: { status?: string; minScore?: number; source?: string; limit?: number }) {
      const all = loadLedger(DIR).opportunities
      const min = Number.isFinite(args.minScore) ? Number(args.minScore) : 0
      const lim = Number.isFinite(args.limit) ? Number(args.limit) : 20
      const rows = all
        .filter(o => (args.status === undefined ? o.status !== 'dropped' : o.status === args.status))
        .filter(o => (args.source === undefined ? true : o.sourceId === args.source))
        .filter(o => o.score >= min)
        .slice(0, Math.max(0, lim))
      if (rows.length === 0) return { text: '(无匹配机会；账本共 ' + all.length + ' 条)' }
      return {
        text: rows.map(o => '  ' + String(o.score).padStart(3) + '  ' + o.status.padEnd(9)
          + o.sourceId.padEnd(16) + o.title.slice(0, 56) + '\n       fp=' + o.fp).join('\n')
          + '\n账本共 ' + all.length + ' 条，本次列 ' + rows.length + ' 条',
      }
    },
  }))

  // ── ④ 决策 ─────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'opp_decide',
    description: '给一条机会定状态：fresh（新）| pursuing（在跟进）| applied（已投/已申领）| dropped（放弃，不再进 digest）。'
      + '只有状态真的变化才写 decidedAt。',
    parameters: {
      fp: { type: 'string', description: '机会指纹（从 opp_list / opp_digest 取）' },
      status: { type: 'string', description: 'fresh | pursuing | applied | dropped' },
      note: { type: 'string', description: '备注（可选）' },
    },
    output: textOut,
    async execute(args: { fp?: string; status?: string; note?: string }) {
      const fp = (args.fp ?? '').trim()
      const status = (args.status ?? '').trim() as OpportunityStatus
      if (fp.length === 0) return { text: '缺 fp' }
      if (!STATUSES.includes(status)) return { text: 'status 必须是 ' + STATUSES.join(' / ') }
      const ledger = loadLedger(DIR)
      const next = decideOpportunity(ledger.opportunities, fp, status, new Date().toISOString(), args.note)
      if (next === null) return { text: '(账本里没有这个 fp: ' + fp + ')' }
      saveLedger(DIR, { version: 1, opportunities: next })
      return { text: '已把 ' + fp + ' 标为 ' + status }
    },
  }))

  // ── ⑤ 呈现（呈现即记账）─────────────────────────────────────
  ctx.tools.register(tool({
    name: 'opp_digest',
    description: '出一份 digest：选出该看的机会（fresh/pursuing 且达门槛），**并把本次呈现记账**'
      + '（presentations.jsonl，一行一次）。本工具**不发送任何消息**——推送由爱丽丝调用 telegram 工具执行。',
    parameters: {
      minScore: { type: 'number', description: '门槛（缺省用画像的 minScore）' },
      limit: { type: 'number', description: '条数上限（缺省 10）' },
      record: { type: 'boolean', description: '是否写呈现账本（缺省 true）' },
    },
    output: textOut,
    async execute(args: { minScore?: number; limit?: number; record?: boolean }) {
      const min = Number.isFinite(args.minScore) ? Number(args.minScore) : profile.minScore
      const lim = Number.isFinite(args.limit) ? Number(args.limit) : 10
      const picked = selectForDigest(loadLedger(DIR).opportunities, min, lim)
      const nowIso = new Date().toISOString()
      const recorded = args.record === false
        ? 'skipped'
        : (appendPresentation(DIR, { at: nowIso, count: picked.length, fps: picked.map(o => o.fp), minScore: min })
          ? 'ok' : 'failed')
      if (picked.length === 0) {
        return { text: 'OPPORTUNITY DIGEST  at=' + nowIso + '  minScore=' + min + '\n--- 0 条达门槛 ---\n呈现记账: ' + recorded }
      }
      return {
        text: ['OPPORTUNITY DIGEST  at=' + nowIso + '  minScore=' + min,
          ...picked.map((o, i) => '  ' + (i + 1) + '. [' + o.score + '] ' + o.title.slice(0, 64)
            + '\n     ' + o.sourceId + ' · ' + o.url + '\n     fp=' + o.fp),
          '呈现记账: ' + recorded,
        ].join('\n'),
      }
    },
  }))
}
