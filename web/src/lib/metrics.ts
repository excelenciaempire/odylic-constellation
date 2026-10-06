/**
 * Metric catalog for the space: the axis and bin pickers, the hover card and
 * the detail drawer. Trimmed from Atelier's Creative Analysis catalog to the
 * metrics the backend returns (SPEC.md Ad) plus the ratios lib/adModel
 * derives from them. No AI, Triple Whale or custom metrics.
 */

export type MetricFormat = 'dollar' | 'number' | 'percent' | 'decimal' | 'text'

export type MetricDef = {
  key: string
  label: string
  format: MetricFormat
  group: string
  description?: string
}

export const SEGMENT_LABELS: Record<string, string> = {
  prospecting: 'New (prospecting)',
  engaged: 'Engaged',
  existing: 'Existing',
  unknown: 'Unknown',
}

export const ALL_METRICS: MetricDef[] = [
  { key: 'spend', label: 'Spend', format: 'dollar', group: 'Performance' },
  { key: 'revenue', label: 'Revenue', format: 'dollar', group: 'Performance', description: 'Purchase value Meta attributes to the ad.' },
  { key: 'roas', label: 'ROAS', format: 'decimal', group: 'Performance', description: 'Revenue / spend.' },
  { key: 'impressions', label: 'Impressions', format: 'number', group: 'Performance' },
  { key: 'reach', label: 'Reach', format: 'number', group: 'Performance' },
  { key: 'frequency', label: 'Frequency', format: 'decimal', group: 'Performance' },
  { key: 'cpm', label: 'CPM', format: 'dollar', group: 'Performance' },
  { key: 'cost_per_1k_reached', label: 'CPMr (cost per 1,000 reached)', format: 'dollar', group: 'Performance' },

  { key: 'clicks', label: 'Clicks (all)', format: 'number', group: 'Clicks' },
  { key: 'link_clicks', label: 'Link clicks', format: 'number', group: 'Clicks' },
  { key: 'outbound_clicks', label: 'Clicks (outbound)', format: 'number', group: 'Clicks' },
  { key: 'ctr', label: 'CTR (all)', format: 'percent', group: 'Clicks' },
  { key: 'ctr_link', label: 'CTR (link click)', format: 'percent', group: 'Clicks' },
  { key: 'cpc', label: 'CPC (all)', format: 'dollar', group: 'Clicks' },
  { key: 'cpc_link', label: 'CPC (link click)', format: 'dollar', group: 'Clicks' },

  { key: 'purchases', label: 'Purchases', format: 'number', group: 'Conversions' },
  { key: 'cost_per_purchase', label: 'CPA', format: 'dollar', group: 'Conversions', description: 'Spend / purchases.' },
  { key: 'aov', label: 'AOV', format: 'dollar', group: 'Conversions', description: 'Revenue / purchases.' },
  { key: 'conversion_rate', label: 'Conversion rate', format: 'percent', group: 'Conversions', description: 'Purchases / link clicks.' },
  { key: 'landing_page_views', label: 'Landing page views', format: 'number', group: 'Conversions' },
  { key: 'cost_per_lpv', label: 'Cost per landing page view', format: 'dollar', group: 'Conversions' },
  { key: 'add_to_cart', label: 'Adds to cart', format: 'number', group: 'Conversions' },
  { key: 'cost_per_atc', label: 'Cost per add to cart', format: 'dollar', group: 'Conversions' },
  { key: 'initiate_checkout', label: 'Checkouts started', format: 'number', group: 'Conversions' },
  { key: 'leads', label: 'Leads', format: 'number', group: 'Conversions' },
  { key: 'cost_per_lead', label: 'Cost per lead', format: 'dollar', group: 'Conversions' },

  { key: 'hook_rate', label: 'Hook rate', format: 'percent', group: 'Video', description: '3-second video plays / impressions.' },
  { key: 'hold_rate', label: 'Hold rate', format: 'percent', group: 'Video', description: 'ThruPlays / 3-second video plays.' },
  { key: 'video_completion_rate', label: 'Completion rate', format: 'percent', group: 'Video', description: '100% plays / 3-second plays.' },
  { key: 'video_3s_views', label: '3s video plays', format: 'number', group: 'Video' },
  { key: 'thruplays', label: 'ThruPlays', format: 'number', group: 'Video' },
  { key: 'video_p25', label: 'Video 25%', format: 'number', group: 'Video' },
  { key: 'video_p50', label: 'Video 50%', format: 'number', group: 'Video' },
  { key: 'video_p75', label: 'Video 75%', format: 'number', group: 'Video' },
  { key: 'video_p100', label: 'Video 100%', format: 'number', group: 'Video' },

  { key: 'post_reactions', label: 'Reactions', format: 'number', group: 'Engagement' },
  { key: 'post_comments', label: 'Comments', format: 'number', group: 'Engagement' },
  { key: 'post_shares', label: 'Shares', format: 'number', group: 'Engagement' },
  { key: 'engagement_rate', label: 'Engagement rate', format: 'percent', group: 'Engagement', description: '(Reactions + comments + shares) / impressions.' },

  { key: 'seg_prospecting_pct', label: 'New (prospecting) %', format: 'percent', group: 'Customer segment', description: 'Share of spend Meta delivered to people new to the brand.' },
  { key: 'seg_engaged_pct', label: 'Engaged %', format: 'percent', group: 'Customer segment', description: 'Share of spend delivered to people who engaged but have not bought.' },
  { key: 'seg_existing_pct', label: 'Existing %', format: 'percent', group: 'Customer segment', description: 'Share of spend delivered to existing customers.' },
  { key: 'seg_unknown_pct', label: 'Unknown %', format: 'percent', group: 'Customer segment', description: 'Share Meta could not attribute to a segment.' },
  { key: 'seg_prospecting_spend', label: 'New (prospecting) spend', format: 'dollar', group: 'Customer segment' },
  { key: 'seg_engaged_spend', label: 'Engaged spend', format: 'dollar', group: 'Customer segment' },
  { key: 'seg_existing_spend', label: 'Existing spend', format: 'dollar', group: 'Customer segment' },
]

export const METRICS_BY_KEY: Record<string, MetricDef> = Object.fromEntries(ALL_METRICS.map(m => [m.key, m]))

export const METRIC_GROUPS: string[] = [...new Set(ALL_METRICS.map(m => m.group))]
