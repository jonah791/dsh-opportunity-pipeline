/**
 * store.test.mjs — 落盘与账本合并的离线单测（跑 lib 产物）。
 *
 * 夹具纪律：所有临时文件写在 `os.tmpdir()` 的 mkdtemp 目录里，
 * **绝不触碰生产状态**（`<DSH_HOME>/opportunity-pipeline`）。
 * 运行：node --test tests/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendPresentation, decideOpportunity, loadLedger, loadSources, mergeOpportunities,
  pathsOf, readJsonStrict, saveLedger, selectForDigest,
} from '../lib/store.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'opp-test-'))
const NOW = '2026-09-23T12:00:00.000Z'
const opp = (fp, score, status = 'fresh', over = {}) => ({
  sourceId: 's', key: fp, title: 't-' + fp, url: 'https://e.x/' + fp,
  foundAtMs: 0, fp, score, breakdown: { keyword: 0, tag: 0, remote: 0, freshness: 0, quality: 0 },
  excluded: false, firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-01T00:00:00.000Z',
  status, ...over,
})

test('I1 不变量：文件不存在 ⇒ 空初态；文件坏了 ⇒ 响亮报错（两者必须可区分）', () => {
  const d = tmp()
  assert.deepEqual(loadSources(d), [], '不存在 ⇒ 空表')
  assert.equal(loadLedger(d).opportunities.length, 0)
  writeFileSync(pathsOf(d).ledger, '{ 这不是 JSON', 'utf8')
  assert.throws(() => loadLedger(d), /状态文件损坏/, '坏文件必须抛错，不得静默返回空账本')
  writeFileSync(pathsOf(d).ledger, JSON.stringify({ version: 2, opportunities: [] }), 'utf8')
  assert.throws(() => loadLedger(d), /形状不符/, '版本不符也算坏文件')
})

test('readJsonStrict 的形状校验对 null/数组/对象一视同仁', () => {
  const d = tmp()
  const p = join(d, 'x.json')
  writeFileSync(p, 'null', 'utf8')
  assert.throws(() => readJsonStrict(p, [], v => Array.isArray(v)), /形状不符/)
  writeFileSync(p, '[1,2]', 'utf8')
  assert.deepEqual(readJsonStrict(p, [], v => Array.isArray(v)), [1, 2])
})

test('I2 不变量：同 fp 只保留一条；重复入库更新 lastSeenAt 而**保留既有 status**', () => {
  const existing = [opp('a', 50, 'pursuing')]
  const incoming = [opp('a', 70, 'fresh')]
  const merged = mergeOpportunities(existing, incoming, NOW)
  assert.equal(merged.length, 1, '不得新增平行条目')
  assert.equal(merged[0].status, 'pursuing', '我做过决策的机会不因再次采集被重置成 fresh')
  assert.equal(merged[0].score, 70, '分数更新')
  assert.equal(merged[0].lastSeenAt, NOW)
  assert.equal(merged[0].firstSeenAt, '2026-09-01T00:00:00.000Z', 'firstSeenAt 不动')
})

test('merge 结果按分数降序（同分按 fp）——呈现顺序确定', () => {
  const merged = mergeOpportunities([], [opp('b', 10), opp('a', 90), opp('c', 90)], NOW)
  assert.deepEqual(merged.map(o => o.fp), ['a', 'c', 'b'])
})

test('I5 不变量：decidedAt 只在状态真的变化时写', () => {
  const first = decideOpportunity([opp('a', 50, 'fresh')], 'a', 'pursuing', NOW)
  assert.equal(first[0].decidedAt, NOW, '状态变了 ⇒ 写时刻')
  const again = decideOpportunity(first, 'a', 'pursuing', '2026-09-24T00:00:00.000Z')
  assert.equal(again[0].decidedAt, NOW, '状态没变 ⇒ 不覆盖原时刻')
  assert.equal(decideOpportunity([opp('a', 1)], 'nope', 'dropped', NOW), null, 'fp 不存在 ⇒ null（调用方据此报错）')
})

test('回归：digest 选取**不按「今天首次出现」过滤**（旧件 firstSeenAt 当天过滤会让高分机会次日静默消失）', () => {
  const old = opp('old', 90, 'fresh', { firstSeenAt: '2026-09-01T00:00:00.000Z' })
  const picked = selectForDigest([old], 40, 10)
  assert.equal(picked.length, 1, '一周前首次出现、仍未被处理的高分机会必须继续出现')
})

test('digest 选取：dropped/applied 不再打扰；被排除的不进；门槛与 limit 生效', () => {
  const rows = [opp('a', 90, 'fresh'), opp('b', 90, 'dropped'), opp('c', 90, 'applied'),
    opp('d', 90, 'pursuing'), opp('e', 10, 'fresh'), opp('f', 90, 'fresh', { excluded: true })]
  assert.deepEqual(selectForDigest(rows, 40, 10).map(o => o.fp), ['a', 'd'])
  assert.deepEqual(selectForDigest(rows, 40, 1).map(o => o.fp), ['a'], 'limit 生效')
})

test('I3 呈现即记账：appendPresentation 追加一行，且写失败如实返回 false 而不抛', () => {
  const d = tmp()
  assert.equal(appendPresentation(d, { at: NOW, count: 1, fps: ['a'], minScore: 40 }), true)
  assert.equal(appendPresentation(d, { at: NOW, count: 0, fps: [], minScore: 40 }), true)
  const lines = readFileSync(pathsOf(d).presentations, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).fps[0], 'a')
})

test('落盘往返：saveLedger 后 loadLedger 读回同一形状，且不留 .tmp 残片', () => {
  const d = tmp()
  saveLedger(d, { version: 1, opportunities: [opp('a', 1)] })
  assert.equal(loadLedger(d).opportunities.length, 1)
  assert.equal(existsSync(pathsOf(d).ledger + '.tmp'), false, '原子写不得留临时文件')
})
