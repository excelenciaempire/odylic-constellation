/**
 * Metrics a chart can show, from the app's one catalog (lib/metrics): every
 * metric the chart's rows can resolve. A breakdown that carries spend,
 * impressions, clicks, purchases and revenue offers those plus ROAS, CTR,
 * CPM, CPC, CPA, AOV and the rest; a field Meta did not send (clicks by
 * customer segment, video quartiles in a breakdown) takes its metrics with
 * it, so a gap never shows as a zero. Ratios use the formulas of
 * lib/adModel, recomputed from summed counts, null over a zero denominator.
 */
import { ALL_METRICS, type MetricDef, type MetricFormat } from '../../lib/metrics'

export type Row = Record<string, unknown>

export type ChartRegistry = {
  list: MetricDef[]
  byKey: Record<string, MetricDef>
  groups: string[]
}

/** Counts and money a chart row carries (they add up across rows). */
export const BASE_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach', 'purchases', 'revenue', 'link_clicks', 'outbound_clicks',
  'landing_page_views', 'add_to_cart', 'initiate_checkout', 'leads', 'video_3s_views', 'thruplays',
  'video_p25', 'video_p50', 'video_p75', 'video_p100', 'post_reactions', 'post_comments', 'post_shares',
] as const

const BASE = new Set<string>(BASE_FIELDS)

/** What each derived metric is computed from. */
const DEPS: Record<string, string[]> = {
  ctr: ['clicks', 'impressions'],
  cpm: ['spend', 'impressions'],
  cpc: ['spend', 'clicks'],
  frequency: ['impressions', 'reach'],
  roas: ['revenue', 'spend'],
  cost_per_purchase: ['spend', 'purchases'],
  aov: ['revenue', 'purchases'],
  ctr_link: ['link_clicks', 'impressions'],
  cpc_link: ['spend', 'link_clicks'],
  cost_per_1k_reached: ['spend', 'reach'],
  conversion_rate: ['purchases', 'link_clicks'],
  cost_per_atc: ['spend', 'add_to_cart'],
  cost_per_lead: ['spend', 'leads'],
  cost_per_lpv: ['spend', 'landing_page_views'],
  hook_rate: ['video_3s_views', 'impressions'],
  hold_rate: ['thruplays', 'video_3s_views'],
  video_completion_rate: ['video_p100', 'video_3s_views'],
  engagement_rate: ['post_reactions', 'post_comments', 'post_shares', 'impressions'],
}

const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const num = (v: unknown) => finite(v) ?? 0
const ratio = (a: number, b: number, scale = 1): number | null => (b > 0 ? (a / b) * scale : null)

/** Base fields with a value on at least one row (leads only when there are some). */
export function presentFields(rows: Row[]): string[] {
  return BASE_FIELDS.filter(k => rows.some(r => finite(r?.[k]) !== null) && (k !== 'leads' || rows.some(r => num(r?.leads) > 0)))
}

/** The catalog limited to what `fields` resolve (video metrics only for a video). */
export function chartRegistry(fields: readonly string[], video: boolean): ChartRegistry {
  const have = new Set(fields)
  const list = ALL_METRICS.filter(m => {
    if (m.group === 'Customer segment') return false
    if (m.group === 'Video' && !video) return false
    if (BASE.has(m.key)) return have.has(m.key)
    const deps = DEPS[m.key]
    return !!deps && deps.every(d => have.has(d))
  })
  const byKey = Object.fromEntries(list.map(m => [m.key, m]))
  const groups = [...new Set(list.map(m => m.group))]
  return { list, byKey, groups }
}

/** Sum the base fields of `rows`, then every derived metric from the sums. */
export function computeRow(rows: Row[], video: boolean): Record<string, number | null> {
  const t: Record<string, number | null> = {}
  for (const k of BASE_FIELDS) {
    if (rows.some(r => finite(r?.[k]) !== null)) t[k] = rows.reduce((s, r) => s + num(r?.[k]), 0)
  }
  const g = (k: string) => num(t[k])
  t.ctr = ratio(g('clicks'), g('impressions'), 100)
  t.cpm = ratio(g('spend'), g('impressions'), 1000)
  t.cpc = ratio(g('spend'), g('clicks'))
  t.frequency = ratio(g('impressions'), g('reach'))
  t.roas = ratio(g('revenue'), g('spend'))
  t.cost_per_purchase = ratio(g('spend'), g('purchases'))
  t.aov = ratio(g('revenue'), g('purchases'))
  t.ctr_link = ratio(g('link_clicks'), g('impressions'), 100)
  t.cpc_link = ratio(g('spend'), g('link_clicks'))
  t.cost_per_1k_reached = ratio(g('spend'), g('reach'), 1000)
  t.conversion_rate = ratio(g('purchases'), g('link_clicks'), 100)
  t.cost_per_atc = ratio(g('spend'), g('add_to_cart'))
  t.cost_per_lead = ratio(g('spend'), g('leads'))
  t.cost_per_lpv = ratio(g('spend'), g('landing_page_views'))
  t.hook_rate = video ? ratio(g('video_3s_views'), g('impressions'), 100) : null
  t.hold_rate = video ? ratio(g('thruplays'), g('video_3s_views'), 100) : null
  t.video_completion_rate = video ? ratio(g('video_p100'), g('video_3s_views'), 100) : null
  t.engagement_rate = ratio(g('post_reactions') + g('post_comments') + g('post_shares'), g('impressions'), 100)
  return t
}

/** Money and counts add up (stack them, split a bar into them); rates and ratios do not. */
export const isAdditive = (key: string) => BASE.has(key)

/** The format every metric on an axis shares, else undefined (plain numbers). */
export function axisFormat(defs: Pick<MetricDef, 'format'>[]): MetricFormat | undefined {
  if (!defs.length) return undefined
  const f = defs[0].format
  return defs.every(m => m.format === f) ? f : undefined
}

/** The picked metrics the registry knows, in pick order. */
export function pickedDefs(keys: string[], registry: ChartRegistry): MetricDef[] {
  return keys.map(k => registry.byKey[k]).filter((m): m is MetricDef => !!m)
}
