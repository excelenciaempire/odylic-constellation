import { describe, expect, it } from 'vitest'
import type { Ad } from '../../lib/api'
import { enrichAds } from '../../lib/adModel'
import { chartAdIds, chartUrl } from '../../lib/adCharts'
import { chartRegistry, computeRow, isAdditive, presentFields } from './chartMetrics'
import {
  axesSummary, leastSquares, logBlocked, moveMetric, movingAverage, placeByUnit, removeMetric, sanitizeAxes, scaleProps,
  withSide,
} from './axes'

const ad = (over: Partial<Ad> = {}): Ad => ({
  ad_id: '1', ad_name: 'A', adset_id: '7', adset_name: 'S', campaign_id: '9', campaign_name: 'C',
  effective_status: 'ACTIVE', created_time: null, creative_id: 'c1', creative_hash: 'h1', image_hash: 'h1',
  video_id: 'v1', is_video: true, thumbnail_url: '', image_url: '', title: null, body: null,
  call_to_action_type: null, account_id: 'act_1', effective_object_story_id: null, instagram_permalink_url: null,
  ads_manager_url: null, spend: 120, impressions: 9000, clicks: 180, ctr: null, cpm: null, cpc: null, reach: 6000,
  frequency: null, purchases: 6, revenue: 330, roas: null, cost_per_purchase: null, link_clicks: 110,
  outbound_clicks: 100, landing_page_views: 90, add_to_cart: 20, initiate_checkout: 12, leads: 0,
  video_3s_views: 3000, thruplays: 800, video_p25: 1500, video_p50: 900, video_p75: 600, video_p100: 400,
  post_reactions: 30, post_comments: 4, post_shares: 2, segment_spend: null,
  ...over,
})

describe('chart metrics', () => {
  it('derives every ratio with the formulas the cards use', () => {
    const a = ad()
    const card = enrichAds([a])[0] as Record<string, unknown>
    const row = computeRow([a as unknown as Record<string, unknown>], true)
    for (const k of ['ctr', 'cpm', 'cpc', 'frequency', 'roas', 'cost_per_purchase', 'aov', 'ctr_link', 'cpc_link',
      'cost_per_1k_reached', 'conversion_rate', 'cost_per_atc', 'cost_per_lpv', 'hook_rate', 'hold_rate',
      'video_completion_rate', 'engagement_rate']) {
      expect(row[k], k).toBeCloseTo(card[k] as number, 10)
    }
    expect(row.cost_per_lead).toBeNull()
  })

  it('sums rows before taking ratios, and never divides by zero', () => {
    const row = computeRow([{ spend: 10, revenue: 30, impressions: 1000 }, { spend: 30, revenue: 10, impressions: 0 }], false)
    expect(row.spend).toBe(40)
    expect(row.roas).toBe(1)
    expect(row.cpm).toBe(40)
    expect(computeRow([{ spend: 0, revenue: 0 }], false).roas).toBeNull()
    expect(computeRow([{ spend: 5 }], false).hook_rate).toBeNull()
  })

  it('offers only the metrics the rows resolve', () => {
    const fields = presentFields([{ spend: 1, impressions: 10, purchases: 0, revenue: 0, leads: 0 }])
    expect(fields).toEqual(['spend', 'impressions', 'purchases', 'revenue'])
    const reg = chartRegistry(fields, true)
    expect(reg.byKey.roas && reg.byKey.cpm && reg.byKey.cost_per_purchase).toBeTruthy()
    expect(reg.byKey.ctr).toBeUndefined() // no clicks in these rows
    expect(reg.byKey.hook_rate).toBeUndefined()
    expect(reg.list.some(m => m.group === 'Customer segment')).toBe(false)
    expect(chartRegistry(['spend', 'impressions', 'video_3s_views'], false).byKey.hook_rate).toBeUndefined()
    expect(chartRegistry(['spend', 'impressions', 'video_3s_views'], true).byKey.hook_rate).toBeTruthy()
    expect(isAdditive('spend') && !isAdditive('roas') && !isAdditive('cpm')).toBe(true)
  })
})

describe('chart requests', () => {
  it('charts a stacked card as all of its ads, in a stable URL', () => {
    const lead = ad({ ad_id: '30' })
    const ids = chartAdIds({ ...lead, variants: [lead, ad({ ad_id: '12' }), ad({ ad_id: '4' })] })
    expect(ids).toEqual(['30', '12', '4'])
    const range = { since: '2026-09-01', until: '2026-09-30' }
    expect(chartUrl('daily', ids, range, false)).toBe('/api/ads/30/daily?since=2026-09-01&until=2026-09-30&ids=12%2C4')
    expect(chartUrl('age_gender', ['5'], range, true))
      .toBe('/api/ads/5/breakdown?since=2026-09-01&until=2026-09-30&kind=age_gender&demo=1')
    expect(chartUrl('video-curve', ['5'], range, false)).toBe('/api/ads/5/video-curve?since=2026-09-01&until=2026-09-30')
  })
})

describe('chart axes', () => {
  const fmt = (k: string) => ({ spend: 'dollar', revenue: 'dollar', roas: 'decimal', ctr: 'percent' } as Record<string, string>)[k]

  it('gives two units two axes and keeps the left axis filled', () => {
    expect(placeByUnit(['spend', 'roas', 'revenue'], { left: [], right: [] }, fmt)).toEqual({ left: ['spend', 'revenue'], right: ['roas'] })
    const a = { left: ['spend'], right: ['roas'] }
    expect(removeMetric(a, 'spend')).toEqual({ left: ['roas'], right: [] })
    expect(moveMetric(a, 'roas', 'left')).toEqual({ left: ['spend', 'roas'], right: [] })
    expect(withSide(a, 'right', ['spend'])).toEqual({ left: ['spend'], right: [] })
    expect(axesSummary({ left: ['spend', 'revenue', 'ctr'], right: ['roas'] }, k => k.toUpperCase())).toBe('SPEND, REVENUE +1 · ROAS')
  })

  it('falls back from log when a value is not above zero', () => {
    expect(scaleProps('log', [1, 2, 3])).toEqual({ scale: 'log', domain: ['auto', 'auto'] })
    expect(scaleProps('log', [0, 2])).toEqual({ scale: 'auto', domain: ['auto', 'auto'] })
    expect(logBlocked('log', [0, 2])).toBe(true)
    expect(scaleProps(undefined, [1])).toEqual({ scale: 'auto', domain: [0, 'auto'] })
  })

  it('draws trend lines and moving averages', () => {
    expect(leastSquares([1, 2, 3])).toEqual([1, 2, 3])
    expect(leastSquares([5])).toEqual([null])
    expect(movingAverage([2, 4, null, 8], 2)).toEqual([null, 3, 4, 8])
    expect(sanitizeAxes({ left: ['spend', 'spend', 3], right: ['spend', 'roas'], scale: 'log', sma: [7, '14', 1] }))
      .toEqual({ left: ['spend'], right: ['roas'], scale: 'log', sma: [7, 14] })
    expect(sanitizeAxes(null)).toBeNull()
  })
})
