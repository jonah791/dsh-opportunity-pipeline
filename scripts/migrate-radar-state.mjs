#!/usr/bin/env node
/**
 * migrate-radar-state.mjs — 把旧两件的状态**只读**迁移进新件（一次性，跑完即可归档）。
 *
 * ## 为什么是只读
 * 迁移**只读**旧文件、**只写**新件目录。旧状态文件在迁移前后 SHA-256 必须逐字节一致——
 * 这是回退判据：回退只需还原组合与引用，数据面零成本（旧件从未被改写）。
 *
 * ## 映射
 * - `dsh-freelance-radar` 的 `<DSH_HOME>/freelance-radar/jobs.json`（`{jobs:[{job,status,firstSeenAt,updatedAt}]}`）
 *   → 新账本 `opportunities`，状态 `new→fresh` · `considered→pursuing` · `applied→applied` · `ignored→dropped`
 * - `dsh-earn-radar` 的 `earn-platforms.json`：**盘上不存在**（实测 2026-09-23）⇒ 无此面，脚本如实报「未发现」
 * - 凭据：**不搬不复制**（旧件 `earn-auth.json` 若存在也不读；新件用 `authRef` 引用名，见语义文档 I4）
 *
 * ## 用法
 *   node scripts/migrate-radar-state.mjs --dry-run     # 只报计划与读数，不写
 *   node scripts/migrate-radar-state.mjs               # 真迁移（写新件账本）
 *   node scripts/migrate-radar-state.mjs --verify      # 只校验旧文件哈希与迁移计数
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `DSH_HOME` 在 WSL 里常是 Windows 形态（`E:/alice/.dsh`），`existsSync` 认不出 ⇒
 * 必须能显式覆盖：`--home=/mnt/e/alice/.dsh`。缺省仍读环境变量（Windows 侧直接可用）。
 */
const homeFlag = process.argv.find(a => a.startsWith('--home='))
const HOME = homeFlag !== undefined ? homeFlag.slice('--home='.length) : (process.env.DSH_HOME ?? 'E:/alice/.dsh')
const OLD_JOBS = join(HOME, 'freelance-radar', 'jobs.json')
const OLD_EARN_REG = join(HOME, 'earn-radar', 'earn-platforms.json')
const OLD_EARN_SEEN = join(HOME, 'earn-radar', 'earn-seen.json')
const NEW_DIR = join(HOME, 'opportunity-pipeline')
const NEW_LEDGER = join(NEW_DIR, 'opportunities.json')

const DRY = process.argv.includes('--dry-run')
const VERIFY_ONLY = process.argv.includes('--verify')

/** 旧件状态 → 新件状态（设计稿 §3 的映射表）。 */
const STATUS_MAP = { new: 'fresh', considered: 'pursuing', applied: 'applied', ignored: 'dropped' }

/** 文件 SHA-256；不存在返回 null（缺失是事实，不是错误）。 */
function sha256(path) {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 旧 jobs.json 的一条 → 新账本的一条。 */
function convert(rec) {
  const job = rec?.job ?? {}
  const sourceId = typeof job.source === 'string' && job.source.length > 0 ? job.source : 'eleduck'
  const key = typeof job.id === 'string' ? job.id : JSON.stringify(job).slice(0, 120)
  const firstSeen = typeof rec?.firstSeenAt === 'string' ? rec.firstSeenAt : new Date().toISOString()
  const lastSeen = typeof rec?.updatedAt === 'string' ? rec.updatedAt : firstSeen
  return {
    sourceId,
    key,
    fp: sourceId + '::' + key.trim().toLowerCase(),
    title: typeof job.title === 'string' ? job.title : '(无标题)',
    url: typeof job.url === 'string' ? job.url : '',
    tags: Array.isArray(job.tags) ? job.tags : [],
    foundAtMs: Date.parse(firstSeen) || 0,
    score: 0,
    breakdown: { keyword: 0, tag: 0, remote: 0, freshness: 0, quality: 0 },
    excluded: false,
    firstSeenAt: firstSeen,
    lastSeenAt: lastSeen,
    status: STATUS_MAP[rec?.status] ?? 'fresh',
    note: '迁移自 dsh-freelance-radar（原状态 ' + String(rec?.status) + '）；分数待下次 opp_scan 重算',
  }
}

function main() {
  const before = { jobs: sha256(OLD_JOBS), reg: sha256(OLD_EARN_REG), seen: sha256(OLD_EARN_SEEN) }
  console.log('旧状态哈希（迁移前）:')
  console.log('  jobs.json            ', before.jobs ?? '(不存在)')
  console.log('  earn-platforms.json  ', before.reg ?? '(不存在——实测该注册表从未落盘)')
  console.log('  earn-seen.json       ', before.seen ?? '(不存在)')

  if (!existsSync(OLD_JOBS)) {
    console.log('\n没有可迁移的旧账本（' + OLD_JOBS + '）⇒ 无操作')
    return 0
  }
  const parsed = JSON.parse(readFileSync(OLD_JOBS, 'utf8'))
  const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : []
  const opportunities = jobs.map(convert)

  const counts = {}
  for (const o of opportunities) counts[o.status] = (counts[o.status] ?? 0) + 1
  console.log('\n迁移计数: 旧 ' + jobs.length + ' 条 → 新 ' + opportunities.length + ' 条')
  console.log('  状态分布:', JSON.stringify(counts))
  const dupes = opportunities.length - new Set(opportunities.map(o => o.fp)).size
  console.log('  指纹去重后:', new Set(opportunities.map(o => o.fp)).size, '（重复 ' + dupes + '）')

  if (VERIFY_ONLY) {
    const after = { jobs: sha256(OLD_JOBS) }
    console.log('\n--verify：旧文件哈希', after.jobs === before.jobs ? '未变 ✓' : '**变了 ✗**')
    return after.jobs === before.jobs ? 0 : 1
  }
  if (DRY) {
    console.log('\n--dry-run：未写任何文件')
    return 0
  }

  mkdirSync(NEW_DIR, { recursive: true })
  writeFileSync(NEW_LEDGER, JSON.stringify({ version: 1, opportunities }, null, 2), 'utf8')
  const after = sha256(OLD_JOBS)
  console.log('\n已写 ' + NEW_LEDGER)
  console.log('旧文件哈希（迁移后）:', after)
  const ok = after === before.jobs
  console.log(ok ? '只读校验：旧文件逐字节未变 ✓' : '**只读校验失败：旧文件被改写 ✗**')
  return ok ? 0 : 1
}

process.exit(main())
