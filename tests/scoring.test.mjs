/**
 * scoring.test.mjs — 打分的离线单测（跑 lib 产物）。
 *
 * 判据：公式全确定（无随机、除注入的 nowMs 外无时钟输入），且每一项都进 breakdown。
 * 运行：node --test tests/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROFILE,
  fingerprintOf,
  freshnessScore,
  passesThreshold,
  qualityScore,
  scoreOpportunity,
} from '../lib/scoring.js'

const NOW = Date.parse('2026-09-23T12:00:00Z')
const raw = (over = {}) => ({
  sourceId: 'src', key: 'k1', title: 'AI agent 远程开发', url: 'https://example.com/a',
  tags: [], foundAtMs: NOW, ...over,
})

test('指纹稳定且大小写无关：同源同键恒等（跨轮去重的依据）', () => {
  assert.equal(fingerprintOf('s1', 'ABC'), fingerprintOf('s1', ' abc '))
  assert.notEqual(fingerprintOf('s1', 'k'), fingerprintOf('s2', 'k'))
})

test('标题命中关键词 ⇒ keyword 分；标签命中 ⇒ tag 分（两者分开计）', () => {
  const r = scoreOpportunity(raw({ title: 'ai llm 工具', tags: [] }), DEFAULT_PROFILE, NOW)
  assert.equal(r.breakdown.keyword, 36, '3 个关键词 × 12')
  assert.equal(r.breakdown.tag, 0)
  const r2 = scoreOpportunity(raw({ title: '无关键词标题', tags: ['ai', 'llm'] }), DEFAULT_PROFILE, NOW)
  assert.equal(r2.breakdown.tag, 12, '2 个标签 × 6')
})

test('keyword 有上限 48（防长标题刷分）', () => {
  const many = DEFAULT_PROFILE.keywords.join(' ')
  assert.equal(scoreOpportunity(raw({ title: many }), DEFAULT_PROFILE, NOW).breakdown.keyword, 48)
})

test('远程信号 +10；freshness 四档；总分不超过 100', () => {
  assert.equal(scoreOpportunity(raw({ title: '远程岗位' }), DEFAULT_PROFILE, NOW).breakdown.remote, 10)
  assert.equal(freshnessScore(1 * 3600_000), 14)
  assert.equal(freshnessScore(12 * 3600_000), 10)
  assert.equal(freshnessScore(48 * 3600_000), 6)
  assert.equal(freshnessScore(200 * 3600_000), 2)
  const maxed = scoreOpportunity(
    raw({ title: DEFAULT_PROFILE.keywords.join(' ') + ' 远程 12345', tags: DEFAULT_PROFILE.keywords, url: 'https://x.y/z' }),
    DEFAULT_PROFILE, NOW,
  )
  assert.ok(maxed.score <= 100, '总分封顶 100，实测 ' + maxed.score)
})

test('质量分：标题长度适中 +4 · 含数字 +6 · 有 http(s) 链接 +2（上限 12）', () => {
  assert.equal(qualityScore({ title: 'abcdefgh', url: 'https://a.b' }), 6)
  assert.equal(qualityScore({ title: 'abcdefgh 9', url: 'https://a.b' }), 12)
  assert.equal(qualityScore({ title: 'x', url: '' }), 0)
})

test('命中排除词 ⇒ score=0 且给理由，但 breakdown 仍是真实读数（便于复核排除是否过宽）', () => {
  const r = scoreOpportunity(raw({ title: 'ai 远程 区块链项目' }), DEFAULT_PROFILE, NOW)
  assert.equal(r.excluded, true)
  assert.equal(r.score, 0)
  assert.match(String(r.excludeReason), /区块链/)
  assert.ok(r.breakdown.keyword > 0, '排除不掩盖明细')
})

test('门槛判据：NaN 不通过（坏分数不得混进 digest）', () => {
  assert.equal(passesThreshold(40, 40), true)
  assert.equal(passesThreshold(39.9, 40), false)
  assert.equal(passesThreshold(Number.NaN, 0), false)
})
