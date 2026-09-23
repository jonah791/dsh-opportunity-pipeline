/**
 * sources.ts — 采集层：把源注册表里的声明变成候选机会。
 *
 * ## 范围（v0.1，如实标注）
 * 本版**只实现声明式探针**（`kind: 'probe'`）。`kind: 'builtin'` 是保留档位——
 * 留给需要签名/分页/令牌刷新的源；**未实现，遇到即响亮报错**，绝不静默跳过
 * （静默跳过会让「这个源没机会」与「这个源根本没跑」不可区分）。
 *
 * ## 凭据纪律（不变量 I4）
 * `authRef` 是**指向凭据条目的引用名**，不是值。v0.1 的 HTTP 采集**不带认证头**；
 * 需要认证的源必须等 builtin 档或经调用方在 `authRef` 之外注入——
 * 状态文件里**永不含值**（旧件 `earn-auth.json` 存 `{value}` 是明文落盘，本件不沿用）。
 *
 * ## 代理
 * 与旧件同形态：`undici` 的 `fetch` + `ProxyAgent`，经 Clash 显式代理（fail-closed——
 * 代理不可用即失败，不回落直连）。
 */

import { createRequire } from 'node:module'
import type { RawOpportunity, Source } from './types.js'
import { pickItems, projectItem, seenKey } from './spec.js'

/**
 * undici 用 cjs require 取，绕开 TS 类型解析（宿主已有该依赖）。
 * 返回类型是 `any`：与旧件同形——undici 的 `Dispatcher` 类型不在本插件的依赖面里，
 * 显式标注会引入一个不该有的类型依赖。
 */
const req = createRequire(import.meta.url)
/* eslint-disable @typescript-eslint/no-explicit-any */
function undici(): any {
  return req('undici')
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 采集上下文。 */
export interface CollectContext {
  readonly proxy: string
  readonly nowMs: number
  /** 采集超时（毫秒）。缺省 20000。 */
  readonly timeoutMs?: number
}

/** 一次采集的结果：拿到的原料 + 如实回报的失败（不吞）。 */
export interface CollectResult {
  readonly raw: RawOpportunity[]
  readonly failures: string[]
}

/**
 * 采集一个源。
 *
 * @param source - 源记录（`probe` 档用 `probes`；`builtin` 档未实现 ⇒ 抛错）
 * @param ctx - 代理与时钟
 * @returns 原料机会 + 失败清单（失败不抛——一个源坏了不该拖垮整轮扫描）
 * @throws 当源是未实现的 `builtin` 档（响亮，不静默跳过）
 */
export async function collectSource(source: Source, ctx: CollectContext): Promise<CollectResult> {
  if (!source.enabled) return { raw: [], failures: [] }
  if (source.kind === 'builtin') {
    throw new Error('源 ' + source.id + ' 是 builtin 档（adapter=' + String(source.adapter) + '），v0.1 未实现——'
      + '请改用声明式 probe，或等 builtin 适配器落地。**不静默跳过**，因为跳过会让「没机会」与「没跑」不可区分。')
  }
  const raw: RawOpportunity[] = []
  const failures: string[] = []
  for (const probe of source.probes ?? []) {
    try {
      raw.push(...await runProbe(source.id, probe, ctx))
    } catch (err) {
      failures.push(probe.label + ': ' + String(err instanceof Error ? err.message : err))
    }
  }
  return { raw, failures }
}

/** 跑一条声明式探针。 */
async function runProbe(
  sourceId: string,
  probe: { label: string; url: string; method?: string; itemsPath?: string; where?: readonly { path: string; op: string; value?: unknown }[]; itemKey?: string; itemTitle?: string; itemValue?: string; unit?: string },
  ctx: CollectContext,
): Promise<RawOpportunity[]> {
  const { fetch: ufetch, ProxyAgent } = undici()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 20_000)
  let body: unknown
  try {
    const res = await ufetch(probe.url, {
      method: probe.method ?? 'GET',
      headers: { accept: 'application/json' },
      dispatcher: new ProxyAgent(ctx.proxy),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
    body = await res.json()
  } finally {
    clearTimeout(timer)
  }

  const items = pickItems(body, probe.itemsPath, probe.where)
  return items.map(item => {
    const projected = projectItem(item, probe)
    return {
      sourceId,
      key: seenKey(sourceId, probe.label, item, probe.itemKey),
      title: projected.title,
      url: probe.url,
      value: projected.value,
      unit: projected.unit,
      foundAtMs: ctx.nowMs,
    }
  })
}
