/**
 * spec.ts — 声明式探针的纯函数内核（**忠实移植自 `dsh-earn-radar/src/spec.ts`**，语义逐字一致）。
 *
 * 为什么单独一层：本插件的「成长」靠**加数据**（往注册表加一条源记录），
 * 而数据里的 `where`/`itemsPath` 一旦写错，后果不是报错而是**静默算错**（少报/多报机会）。
 * 所以判定逻辑必须可离线单测——spec 引擎自己得先是对的。
 *
 * 移植纪律：`matchWhere` 的**未知 op 一律判否**（fail-closed）必须原样保留——
 * spec 写错时必须表现为「取不到」，绝不能表现为「全都算机会」。
 */

import type { Where } from './types.js'

/** 点路径取值：`'a.b.c'` → `obj.a.b.c`（任一层缺失即返回 undefined，不抛）。 */
export function getPath(obj: unknown, path?: string): unknown {
  if (!path) return obj
  let cur: unknown = obj
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/**
 * 条件求值（全部条件须同时成立）。**未知 op 一律判否**（fail-closed）。
 *
 * 支持的 op：`eq` `neq` `in` `startsWith` `notStartsWith` `gt` `lt` `contains` `exists`。
 */
export function matchWhere(item: unknown, where?: readonly Where[]): boolean {
  if (!where || where.length === 0) return true
  for (const c of where) {
    const v = getPath(item, c.path)
    const t = c.value
    switch (c.op) {
      case 'eq': if (v !== t) return false; break
      case 'neq': if (v === t) return false; break
      case 'in': if (!(Array.isArray(t) && t.includes(v))) return false; break
      case 'startsWith': if (!String(v ?? '').startsWith(String(t))) return false; break
      case 'notStartsWith': if (String(v ?? '').startsWith(String(t))) return false; break
      case 'gt': if (!(Number(v) > Number(t))) return false; break
      case 'lt': if (!(Number(v) < Number(t))) return false; break
      case 'contains': if (!String(v ?? '').includes(String(t))) return false; break
      case 'exists': if (v === null || v === undefined) return false; break
      default: return false
    }
  }
  return true
}

/** 从响应里取出候选数组（`itemsPath` 缺省 = 响应体自身即数组），再按 `where` 过滤。 */
export function pickItems(raw: unknown, itemsPath?: string, where?: readonly Where[]): unknown[] {
  const all = itemsPath ? getPath(raw, itemsPath) : raw
  if (!Array.isArray(all)) return []
  return all.filter(it => matchWhere(it, where))
}

/** 稳定的见闻键：同一源同一探针下同一件的身份（去重的原料，不变量 I2）。 */
export function seenKey(sourceId: string, label: string, item: unknown, itemKey?: string): string {
  const id = itemKey ? getPath(item, itemKey) : undefined
  return sourceId + '/' + label + '/' + String(id ?? JSON.stringify(item)).slice(0, 120)
}

/** 把一条探针结果映射成候选机会的原料（`RawOpportunity` 的字段来源）。 */
export function projectItem(
  item: unknown,
  spec: { itemTitle?: string; itemValue?: string; unit?: string },
): { title: string; value?: number; unit?: string } {
  const rawTitle = spec.itemTitle ? getPath(item, spec.itemTitle) : undefined
  const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0
    ? rawTitle.trim()
    : JSON.stringify(item).slice(0, 120)
  const rawValue = spec.itemValue ? getPath(item, spec.itemValue) : undefined
  const num = typeof rawValue === 'number' ? rawValue : Number(rawValue)
  const value = Number.isFinite(num) ? num : undefined
  return value === undefined
    ? { title }
    : { title, value, unit: spec.unit ?? '' }
}
