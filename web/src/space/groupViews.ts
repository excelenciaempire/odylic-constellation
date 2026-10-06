/**
 * Shared bits of the group views (plain grid and slideshow): the sort orders
 * and a group's totals. Ratios are recomputed from the sums, never averaged.
 */
import type { SpaceAd } from '../lib/adModel'
import type { SelectOption } from '../ui/Select'

export type GroupSort = 'spend' | 'roas' | 'purchases' | 'ctr' | 'cpa' | 'newest'

export const GROUP_SORTS: Array<SelectOption & { value: GroupSort }> = [
  { value: 'spend', label: 'Spend, high to low' },
  { value: 'roas', label: 'ROAS, high to low' },
  { value: 'purchases', label: 'Purchases, high to low' },
  { value: 'ctr', label: 'CTR, high to low' },
  { value: 'cpa', label: 'CPA, low to high' },
  { value: 'newest', label: 'Newest first' },
]

const n = (v: unknown) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

/** Sorted copy. Missing values (no purchases, no ROAS) always sink to the end. */
export function sortGroupAds(ads: SpaceAd[], sort: GroupSort): SpaceAd[] {
  const key = (a: SpaceAd): number | null => {
    switch (sort) {
      case 'spend': return n(a.spend)
      case 'roas': return n(a.roas)
      case 'purchases': return n(a.purchases)
      case 'ctr': return n(a.ctr)
      case 'cpa': { const v = n(a.cost_per_purchase); return v === null ? null : -v }
      case 'newest': { const t = a.created_time ? Date.parse(a.created_time) : NaN; return Number.isFinite(t) ? t : null }
    }
  }
  return [...ads].sort((a, b) => {
    const ka = key(a), kb = key(b)
    if (ka === null && kb === null) return (n(b.spend) || 0) - (n(a.spend) || 0)
    if (ka === null) return 1
    if (kb === null) return -1
    return kb - ka || (n(b.spend) || 0) - (n(a.spend) || 0)
  })
}

export function groupTotals(ads: SpaceAd[]) {
  let spend = 0, revenue = 0, purchases = 0, clicks = 0, impressions = 0
  for (const a of ads) {
    spend += n(a.spend) || 0
    revenue += n(a.revenue) || 0
    purchases += n(a.purchases) || 0
    clicks += n(a.clicks) || 0
    impressions += n(a.impressions) || 0
  }
  return {
    n: ads.length, spend, revenue, purchases,
    roas: spend > 0 ? revenue / spend : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpa: purchases > 0 ? spend / purchases : null,
  }
}
