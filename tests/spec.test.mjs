/**
 * spec.test.mjs — 声明式探针内核的离线单测（跑 lib 产物）。
 *
 * 为什么这个文件重要：探针是**数据驱动**的入口——`where`/`itemsPath` 写错时，
 * 正确的表现是「取不到」，错误的表现是「全都算机会」（静默算错，不报错）。
 * 所以 `matchWhere` 的 **未知 op 判否** 必须有自己的尸体测试：
 * 拿一个拼错的 op 去问，它必须回答「不匹配」，而不是「匹配」。
 * 运行：node --test tests/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getPath, matchWhere, pickItems, projectItem, seenKey } from '../lib/spec.js'

test('getPath：点路径逐层取；缺任一层 ⇒ undefined（不抛）；空路径 ⇒ 原对象', () => {
  const o = { a: { b: { c: 42 } } }
  assert.equal(getPath(o, 'a.b.c'), 42)
  assert.equal(getPath(o, 'a.b.zzz'), undefined)
  assert.equal(getPath(o, 'a.zzz.c'), undefined)
  assert.equal(getPath(o), o)
  assert.equal(getPath(null, 'a.b'), undefined)
})

test('matchWhere：无 where ⇒ 恒真（不过滤）', () => {
  assert.equal(matchWhere({ x: 1 }), true)
  assert.equal(matchWhere({ x: 1 }, []), true)
})

test('matchWhere：九种 op 各自的行为', () => {
  const it = { status: 'open', budget: 100, tags: ['ai', 'remote'], title: 'AI 工程师', body: null }
  assert.equal(matchWhere(it, [{ path: 'status', op: 'eq', value: 'open' }]), true)
  assert.equal(matchWhere(it, [{ path: 'status', op: 'neq', value: 'closed' }]), true)
  assert.equal(matchWhere(it, [{ path: 'status', op: 'in', value: ['open', 'new'] }]), true)
  assert.equal(matchWhere(it, [{ path: 'title', op: 'startsWith', value: 'AI' }]), true)
  assert.equal(matchWhere(it, [{ path: 'title', op: 'notStartsWith', value: 'BD' }]), true)
  assert.equal(matchWhere(it, [{ path: 'budget', op: 'gt', value: 50 }]), true)
  assert.equal(matchWhere(it, [{ path: 'budget', op: 'lt', value: 500 }]), true)
  assert.equal(matchWhere(it, [{ path: 'title', op: 'contains', value: '工程' }]), true)
  assert.equal(matchWhere(it, [{ path: 'budget', op: 'exists' }]), true)
  assert.equal(matchWhere(it, [{ path: 'body', op: 'exists' }]), false, 'null 不算存在')
})

test('尸体测试：未知 op（拼错）⇒ 判否，**绝不判是**——spec 写错必须表现为「取不到」', () => {
  const it = { status: 'open' }
  for (const bad of ['equal', 'EQ', 'equals', 'eql', '==', 'contain', 'existsAny', '']) {
    assert.equal(matchWhere(it, [{ path: 'status', op: bad, value: 'open' }]), false,
      'op=' + JSON.stringify(bad) + ' 必须判否（fail-closed）')
  }
  // 同一批数据用**正确**的 op 必须判是 ⇒ 证明上面的否不是「数据本来就不匹配」
  assert.equal(matchWhere(it, [{ path: 'status', op: 'eq', value: 'open' }]), true)
})

test('matchWhere：多条件须同时成立（AND 语义）', () => {
  const it = { status: 'open', budget: 10 }
  assert.equal(matchWhere(it, [{ path: 'status', op: 'eq', value: 'open' }, { path: 'budget', op: 'gt', value: 50 }]), false)
  assert.equal(matchWhere(it, [{ path: 'status', op: 'eq', value: 'open' }, { path: 'budget', op: 'gt', value: 5 }]), true)
})

test('pickItems：itemsPath 取值 + where 过滤；非数组 ⇒ 空（不抛）', () => {
  const raw = { data: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] } }
  assert.equal(pickItems(raw, 'data.items').length, 3)
  assert.equal(pickItems(raw, 'data.items', [{ path: 'n', op: 'gt', value: 1 }]).length, 2)
  assert.deepEqual(pickItems(raw, 'data.nope'), [])
  assert.deepEqual(pickItems({ notArray: 1 }, 'notArray'), [])
  assert.equal(pickItems([{ a: 1 }]).length, 1, 'itemsPath 缺省 ⇒ 响应体自身即数组')
})

test('seenKey：稳定且区分源/探针；有 itemKey 用值，无则回落 JSON 切片（≤120 字符）', () => {
  assert.equal(seenKey('s1', 'p1', { id: 'x' }, 'id'), 's1/p1/x')
  assert.notEqual(seenKey('s1', 'p1', { id: 'x' }, 'id'), seenKey('s2', 'p1', { id: 'x' }, 'id'))
  assert.notEqual(seenKey('s1', 'p1', { id: 'x' }, 'id'), seenKey('s1', 'p2', { id: 'x' }, 'id'))
  const long = seenKey('s1', 'p1', { blob: 'z'.repeat(500) })
  assert.ok(long.length <= 's1/p1/'.length + 120, '回落键必须截断，实测 ' + long.length)
  assert.equal(seenKey('s1', 'p1', { id: 'x' }, 'id'), seenKey('s1', 'p1', { id: 'x', extra: 1 }, 'id'), '有 itemKey 时其余字段不影响身份')
})

test('projectItem：标题取 itemTitle，缺失则回落 JSON 切片；value 非数则不给值', () => {
  const it = { name: '  AI 岗位  ', pay: '5000', unit: 'CNY' }
  const p = projectItem(it, { itemTitle: 'name', itemValue: 'pay', unit: 'CNY' })
  assert.equal(p.title, 'AI 岗位', '标题要 trim')
  assert.equal(p.value, 5000, '数字字符串要转成数')
  assert.equal(p.unit, 'CNY')
  const noTitle = projectItem(it, {})
  assert.ok(noTitle.title.length > 0, '无 itemTitle ⇒ 回落 JSON 切片，不得空标题')
  assert.equal(noTitle.value, undefined, '无 itemValue ⇒ 不给值（不编 0）')
  assert.equal(projectItem({ t: 'x', v: 'not-a-number' }, { itemTitle: 't', itemValue: 'v' }).value, undefined)
})
