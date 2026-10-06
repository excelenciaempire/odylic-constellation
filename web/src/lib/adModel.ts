/**
 * The ad rows the space draws. Two steps over the API's Ad[]:
 *
 *   enrich  adds the derived metrics (hook rate, AOV, segment shares, ...)
 *           so every metric in the catalog reads straight off the row.
 *   stack   folds ads that run the same creative (same creative_hash) into
 *           one card: counts are summed and ratios recomputed from the sums.
 *           The card keeps the top spender's identity and lists every ad it
 *           stands for in `variants`.
 */
import type { Ad, SegmentSpend } from './api'

export type SpaceAd = Ad & {
  /** Every ad behind this card, top spender first (just this ad when unstacked). */
  variants: Ad[]
  [key: string]: unknown
}

const SUM_KEYS = [
  'spend', 'impressions', 'clicks', 'reach', 'purchases', 'revenue', 'link_clicks', 'outbound_clicks',
  'landing_page_views', 'add_to_cart', 'initiate_checkout', 'leads', 'video_3s_views', 'thruplays',
  'video_p25', 'video_p50', 'video_p75', 'video_p100', 'post_reactions', 'post_comments', 'post_shares',
] as const

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
/** a / b, null when b is zero (a missing ratio is never a fake 0). */
const ratio = (a: number, b: number, scale = 1): number | null => (b > 0 ? (a / b) * scale : null)

/** Adds the derived metrics to a row whose sums are already set. */
function derive(row: Record<string, unknown>): void {
  const spend = num(row.spend), impr = num(row.impressions), clicks = num(row.clicks)
  const reach = num(row.reach), purchases = num(row.purchases), revenue = num(row.revenue)
  const link = num(row.link_clicks), v3 = num(row.video_3s_views), thru = num(row.thruplays)
  row.ctr = ratio(clicks, impr, 100)
  row.cpm = ratio(spend, impr, 1000)
  row.cpc = ratio(spend, clicks)
  row.frequency = ratio(impr, reach)
  row.roas = ratio(revenue, spend)
  row.cost_per_purchase = ratio(spend, purchases)
  row.aov = ratio(revenue, purchases)
  row.ctr_link = ratio(link, impr, 100)
  row.cpc_link = ratio(spend, link)
  row.cost_per_1k_reached = ratio(spend, reach, 1000)
  row.conversion_rate = ratio(purchases, link, 100)
  row.cost_per_atc = ratio(spend, num(row.add_to_cart))
  row.cost_per_lead = ratio(spend, num(row.leads))
  row.cost_per_lpv = ratio(spend, num(row.landing_page_views))
  const isVideo = !!row.is_video || !!row.video_id
  row.hook_rate = isVideo ? ratio(v3, impr, 100) : null
  row.hold_rate = isVideo ? ratio(thru, v3, 100) : null
  row.video_completion_rate = isVideo ? ratio(num(row.video_p100), v3, 100) : null
  row.engagement_rate = ratio(num(row.post_reactions) + num(row.post_comments) + num(row.post_shares), impr, 100)
  const seg = row.segment_spend as SegmentSpend | null | undefined
  const segTotal = seg ? num(seg.prospecting) + num(seg.engaged) + num(seg.existing) + num(seg.unknown) : 0
  for (const k of ['prospecting', 'engaged', 'existing', 'unknown'] as const) {
    row[`seg_${k}_spend`] = seg ? num(seg[k]) : null
    row[`seg_${k}_pct`] = seg && segTotal > 0 ? (num(seg[k]) / segTotal) * 100 : null
  }
}

/** One card per ad, derived metrics added. */
export function enrichAds(ads: Ad[]): SpaceAd[] {
  return ads.map(a => {
    const row: SpaceAd = { ...a, variants: [a] }
    derive(row)
    return row
  })
}

/** Same-creative key: the backend's creative_hash, else the ad itself. */
export const stackKey = (a: Ad) => (a.creative_hash ? `c:${a.creative_hash}` : `a:${a.ad_id}`)

/** One card per creative: sums across the ads running it, ratios recomputed. */
export function stackAds(ads: Ad[]): SpaceAd[] {
  const groups = new Map<string, Ad[]>()
  for (const a of ads) {
    const k = stackKey(a)
    const g = groups.get(k)
    if (g) g.push(a)
    else groups.set(k, [a])
  }
  const out: SpaceAd[] = []
  for (const list of groups.values()) {
    list.sort((x, y) => num(y.spend) - num(x.spend))
    const lead = list[0]
    const row: SpaceAd = { ...lead, variants: list }
    if (list.length > 1) {
      for (const k of SUM_KEYS) (row as Record<string, unknown>)[k] = list.reduce((s, a) => s + num(a[k]), 0)
      const segs = list.map(a => a.segment_spend).filter((s): s is SegmentSpend => !!s)
      row.segment_spend = segs.length
        ? {
          prospecting: segs.reduce((s, x) => s + num(x.prospecting), 0),
          engaged: segs.reduce((s, x) => s + num(x.engaged), 0),
          existing: segs.reduce((s, x) => s + num(x.existing), 0),
          unknown: segs.reduce((s, x) => s + num(x.unknown), 0),
        }
        : null
    }
    derive(row)
    out.push(row)
  }
  return out
}
