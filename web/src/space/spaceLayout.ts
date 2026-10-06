/**
 * Creative space: the field catalogue, grouping and 3D layouts behind
 * CreativeSpace3D (ported from Atelier). Pure functions (no React, no DOM,
 * no requests), so the component only renders and handles input.
 *
 * World units follow the original Creative Space mockup
 * (~/Desktop/democo-creative-space): a card is 40 to 122 units on its long
 * side, clusters sit on a ring around the origin, and screen y grows
 * downward, so a NEGATIVE world y is up.
 */
import type { SpaceAd } from '../lib/adModel'
import { detectNaming, type AutoNaming } from '../lib/autoNaming'
import { deliveryStatus } from './deliveryStatus'
import {
  FUNNEL_LANES, FUNNEL_LANE_LABEL, FUNNEL_LANE_SUB,
  type FunnelLane, type FunnelPlacement,
} from './funnelPosition'
import { CHART_PALETTE, CHART_NEUTRAL } from '../ui/theme'

type AdCreative = SpaceAd

export type Vec3 = { x: number; y: number; z: number }

/** Arrange keys that are not fields. */
export const ARRANGE_AXES = 'metric:axes'
export const ARRANGE_BINS = 'metric:bins'
/** The segment-based funnel classification (space/funnelPosition). */
export const FIELD_FUNNEL = 'funnel_position'
/** Top 20% / middle 50% / bottom 30% of ads by spend. */
export const FIELD_SPEND_COHORT = 'spend_cohort'

export type FieldGroup = 'Delivery' | 'Naming' | 'Creative' | 'Metric'

export type SpaceField = {
  key: string
  label: string
  group: FieldGroup
  hint?: string
  /** Bucket for ads with no value. */
  empty: string
}

// ── Hashing (salt first + finalizer, so x/y/z jitter is not correlated) ────

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

/** Stable pseudo-random number in [0, 1) for (s, salt). */
export function h01(s: string, salt: string): number {
  let h = djb2(salt + '|' + s)
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995) >>> 0
  h ^= h >>> 15
  return (h >>> 0) % 100000 / 100000
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const clamp01 = (v: number) => clamp(v, 0, 1)

// ── Naming fields (detected from the ad names, lib/autoNaming) ─────────────

export type NamingIndex = AutoNaming

export function buildNamingIndex(ads: AdCreative[]): NamingIndex {
  return detectNaming(ads.map(a => ({ id: a.ad_id, name: a.ad_name || '' })))
}

function topValues(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v)
}

// ── Spend cohorts ──────────────────────────────────────────────────────────

export const SPEND_COHORTS = ['Top 20% by spend', 'Middle 50% by spend', 'Bottom 30% by spend'] as const

/** Each card's spend cohort: ranked by spend, top 20% / next 50% / last 30% of cards. */
export function spendCohorts(ads: AdCreative[]): Map<string, string> {
  const sorted = [...ads].sort((a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0))
  const n = sorted.length
  const topN = Math.max(n ? 1 : 0, Math.round(n * 0.2))
  const midN = Math.round(n * 0.5)
  const out = new Map<string, string>()
  sorted.forEach((a, i) => out.set(a.ad_id, SPEND_COHORTS[i < topN ? 0 : i < topN + midN ? 1 : 2]))
  return out
}

// ── Field catalogue ────────────────────────────────────────────────────────

export function buildFieldCatalog(naming: NamingIndex): SpaceField[] {
  const out: SpaceField[] = [
    { key: FIELD_FUNNEL, label: 'Funnel position', group: 'Delivery', empty: '(not placed)',
      hint: 'Every ad, from Meta customer-segment delivery, then frequency and CPMr' },
    ...naming.fields.map(f => ({
      key: f.key, label: f.label, group: 'Naming' as const, empty: '(other)',
      hint: `${f.coverage} ads${f.examples.length ? `, e.g. ${f.examples.join(', ')}` : ''}`,
    })),
    { key: 'asset_type', label: 'Creative type', group: 'Creative', empty: '(none)', hint: 'Image or video' },
    { key: 'effective_status', label: 'Status', group: 'Creative', empty: '(none)',
      hint: 'Live, paused (ad, ad set or campaign), in review, issues, archived' },
    { key: 'campaign_name', label: 'Campaign', group: 'Creative', empty: '(none)' },
    { key: 'adset_name', label: 'Ad set', group: 'Creative', empty: '(none)' },
    { key: FIELD_SPEND_COHORT, label: 'Spend cohort', group: 'Metric', empty: '(none)',
      hint: 'Top 20%, middle 50% and bottom 30% of ads by spend' },
  ]
  return out
}

/** Default grouping: always the delivery funnel (it places every spending ad). */
export function defaultArrange(): string {
  return FIELD_FUNNEL
}

export type ValueContext = {
  naming: NamingIndex
  funnel: Map<string, FunnelPlacement> | null
  cohort: Map<string, string>
}

/** The ad's value for a field ('' when it has none). */
export function fieldValue(ad: AdCreative, key: string, ctx: ValueContext): string {
  if (key === FIELD_FUNNEL) {
    const p = ctx.funnel?.get(ad.ad_id)
    return p ? FUNNEL_LANE_LABEL[p.lane] : ''
  }
  if (key.startsWith('nm:')) return ctx.naming.values.get(ad.ad_id)?.[key] || ''
  if (key === FIELD_SPEND_COHORT) return ctx.cohort.get(ad.ad_id) || ''
  if (key === 'asset_type') return ad.is_video || ad.video_id ? 'Video' : 'Image'
  if (key === 'effective_status') return deliveryStatus(ad.effective_status)
  const v = (ad as Record<string, unknown>)[key]
  return v === undefined || v === null ? '' : String(v).trim()
}

/** Numeric metric value, NaN when the ad has none. */
export function metricOf(ad: AdCreative, key: string): number {
  const v = (ad as Record<string, unknown>)[key]
  if (v === undefined || v === null || v === '') return NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

// ── Groups and clusters ────────────────────────────────────────────────────

export type SpaceNodeInput = {
  id: string
  ad: AdCreative
  /** Card long side in world units, before the layout's sizeScale. */
  size: number
}

export type Cluster = {
  key: string
  name: string
  sub?: string
  color: string
  ids: string[]
  /** "(none)", "(other)", "Other", "No data": drawn neutral, listed last. */
  sink: boolean
  spend: number
  revenue: number
  purchases: number
  clicks: number
  impressions: number
  center: Vec3
  r: number
  labelAt: Vec3
}

type Bucket = { key: string; name: string; ids: string[]; sink: boolean; spend: number; sub?: string; color?: string }

const NEUTRAL = CHART_NEUTRAL as string
const MAX_NAMED_GROUPS = 12

/** Funnel lanes read cold (new) to hot (saturated), then retention. */
export const FUNNEL_LANE_COLOR: Record<FunnelLane, string> = {
  TOF: CHART_PALETTE[1],   // teal
  MOF: CHART_PALETTE[5],   // ochre
  BOF: CHART_PALETTE[0],   // clay
  REACT: CHART_PALETTE[2], // plum
}

function emptyCluster(b: Bucket, color: string): Cluster {
  return {
    key: b.key, name: b.name, sub: b.sub, color, ids: b.ids, sink: b.sink,
    spend: 0, revenue: 0, purchases: 0, clicks: 0, impressions: 0,
    center: { x: 0, y: 0, z: 0 }, r: 0, labelAt: { x: 0, y: 0, z: 0 },
  }
}

function withTotals(c: Cluster, byId: Map<string, SpaceNodeInput>): Cluster {
  for (const id of c.ids) {
    const ad = byId.get(id)?.ad
    if (!ad) continue
    c.spend += Number(ad.spend) || 0
    c.revenue += Number(ad.revenue) || 0
    c.purchases += Number(ad.purchases) || 0
    c.clicks += Number(ad.clicks) || 0
    c.impressions += Number(ad.impressions) || 0
  }
  return c
}

/** The funnel lane a field value names, or null when it isn't a stage. */
export function laneOfValue(v: string): FunnelLane | null {
  const s = v.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  if (/^(tof|tofu|top( of( the)? funnel)?|prospecting|prospect|acquisition|acq|cold|awareness)$/.test(s)) return 'TOF'
  if (/^(mof|mofu|middle( of( the)? funnel)?|mid( funnel)?|consideration|warm)$/.test(s)) return 'MOF'
  if (/^(bof|bofu|bottom( of( the)? funnel)?|conversion|retargeting|retarget|remarketing|rt|hot)$/.test(s)) return 'BOF'
  if (/^(react|reactivation|retention|existing( customers)?|loyalty|ra|win ?back)$/.test(s)) return 'REACT'
  return null
}

/**
 * A field whose values are funnel stages (the "Funnel (ad name)" field
 * detected from ad names) lays out as the funnel too, not as clusters:
 * its buckets fold into the four lanes, and ads with no stage stay out, as
 * unplaced ads do in the delivery funnel. Null when the values don't read as
 * a funnel (fewer than two stage buckets, or, for a field that isn't named for the funnel, under 30% of the ads).
 */
export function funnelLanesFromClusters(
  nodes: SpaceNodeInput[], clusters: Cluster[], hidden: Set<string>, funnelField = false,
): { clusters: Cluster[]; hidden: Set<string> } | null {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const ids: Record<FunnelLane, string[]> = { TOF: [], MOF: [], BOF: [], REACT: [] }
  const out = new Set(hidden)
  let stageGroups = 0, staged = 0, total = 0
  for (const c of clusters) {
    total += c.ids.length
    const lane = c.sink ? null : laneOfValue(c.name)
    if (!lane) { for (const id of c.ids) out.add(id); continue }
    stageGroups++
    staged += c.ids.length
    ids[lane].push(...c.ids)
  }
  // Any field needs two stages. One that isn't about the funnel (a campaign, an audience) also needs 30% of the ads
  // to carry a stage, so a few stage-like names don't turn it into a funnel; a funnel field draws with what it has.
  if (stageGroups < 2 || staged < (funnelField ? 3 : Math.max(3, total * 0.3))) return null
  const lanes = FUNNEL_LANES.map(l => withTotals(emptyCluster(
    { key: l, name: FUNNEL_LANE_LABEL[l], ids: ids[l], sink: false, spend: 0 },
    FUNNEL_LANE_COLOR[l],
  ), byId))
  return { clusters: lanes, hidden: out }
}

/**
 * Bucket nodes by a field. Case-insensitive (the most common spelling
 * names the bucket), sorted by spend with the empty bucket last; past
 * MAX_NAMED_GROUPS the tail folds into "Other". Nine palette hues, then
 * neutral stone rather than cycling colors.
 */
export function groupByField(
  nodes: SpaceNodeInput[], field: SpaceField, ctx: ValueContext,
): { clusters: Cluster[]; hidden: Set<string> } {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const hidden = new Set<string>()
  if (field.key === FIELD_FUNNEL) {
    const lanes = new Map<FunnelLane, string[]>(FUNNEL_LANES.map(l => [l, []]))
    for (const n of nodes) {
      const p = ctx.funnel?.get(n.id)
      if (!p) { hidden.add(n.id); continue }
      lanes.get(p.lane)!.push(n.id)
    }
    const clusters = FUNNEL_LANES.map(l => withTotals(emptyCluster(
      { key: l, name: FUNNEL_LANE_LABEL[l], sub: FUNNEL_LANE_SUB[l], ids: lanes.get(l)!, sink: false, spend: 0 },
      FUNNEL_LANE_COLOR[l],
    ), byId))
    return { clusters, hidden }
  }

  const buckets = new Map<string, Bucket & { spellings: Map<string, number> }>()
  for (const n of nodes) {
    const raw = fieldValue(n.ad, field.key, ctx)
    const norm = raw.toLowerCase().replace(/\s+/g, ' ')
    const key = norm || '\u0000empty'
    let b = buckets.get(key)
    if (!b) {
      b = { key, name: raw || field.empty, ids: [], sink: !norm, spend: 0, spellings: new Map() }
      buckets.set(key, b)
    }
    b.ids.push(n.id)
    b.spend += Number(n.ad.spend) || 0
    if (raw) b.spellings.set(raw, (b.spellings.get(raw) || 0) + 1)
  }
  const named: Bucket[] = []
  const sinks: Bucket[] = []
  for (const b of buckets.values()) {
    if (b.spellings.size) b.name = topValues(b.spellings, 1)[0]
    ;(b.sink ? sinks : named).push(b)
  }
  named.sort((a, b) => b.spend - a.spend)
  if (named.length > MAX_NAMED_GROUPS) {
    const tail = named.splice(MAX_NAMED_GROUPS - 1)
    named.push({
      key: '\u0000other', name: `Other (${tail.length})`, sink: true,
      ids: tail.flatMap(t => t.ids), spend: tail.reduce((s, t) => s + t.spend, 0),
    })
  }
  const ordered = [...named, ...sinks]
  const clusters = ordered.map((b, i) => withTotals(emptyCluster(b, b.sink || i >= 9 ? NEUTRAL : CHART_PALETTE[i]), byId))
  return { clusters, hidden }
}

// ── Metric bins ────────────────────────────────────────────────────────────

function quantileSorted(sorted: number[], p: number): number {
  if (!sorted.length) return NaN
  const idx = (sorted.length - 1) * clamp01(p)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo)
}

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Low-to-high ramp: stone, ochre, clay. */
export function rampColor(t: number): string {
  const stops = [NEUTRAL, CHART_PALETTE[5], CHART_PALETTE[0]].map(hexToRgb)
  const x = clamp01(t) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const f = x - i
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f))
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Quantile bins of one metric, low to high. A value equal to a cut point
 * stays in the lower bin, so ties (e.g. every ROAS of 0) share one bin and
 * empty bins drop out. Names are the members' actual range.
 */
export function groupByBins(
  nodes: SpaceNodeInput[], metricKey: string, bins: number, fmt: (v: number) => string,
): { clusters: Cluster[]; hidden: Set<string> } {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const withV = nodes.map(n => ({ id: n.id, v: metricOf(n.ad, metricKey) }))
  const finite = withV.filter(x => Number.isFinite(x.v))
  const sorted = finite.map(x => x.v).sort((a, b) => a - b)
  const k = Math.max(2, Math.min(20, Math.round(bins)))
  const cuts: number[] = []
  for (let j = 1; j < k; j++) cuts.push(quantileSorted(sorted, j / k))
  const members: Array<{ ids: string[]; lo: number; hi: number }> = Array.from({ length: k }, () => ({ ids: [], lo: Infinity, hi: -Infinity }))
  for (const x of finite) {
    let j = 0
    while (j < cuts.length && x.v > cuts[j]) j++
    const m = members[j]
    m.ids.push(x.id)
    m.lo = Math.min(m.lo, x.v)
    m.hi = Math.max(m.hi, x.v)
  }
  const used = members.filter(m => m.ids.length)
  const clusters: Cluster[] = used.map((m, i) => withTotals(emptyCluster({
    key: `bin:${i}`,
    name: m.lo === m.hi ? fmt(m.lo) : `${fmt(m.lo)} to ${fmt(m.hi)}`,
    ids: m.ids, sink: false, spend: 0,
  }, rampColor(used.length > 1 ? i / (used.length - 1) : 1)), byId))
  const missing = withV.filter(x => !Number.isFinite(x.v)).map(x => x.id)
  if (missing.length) {
    clusters.push(withTotals(emptyCluster({ key: 'bin:none', name: 'No data', ids: missing, sink: true, spend: 0 }, NEUTRAL), byId))
  }
  return { clusters, hidden: new Set() }
}

// ── Axis scales ────────────────────────────────────────────────────────────

export type ScaleMode = 'auto' | 'linear' | 'log' | 'rank'
export type AxisScale = {
  kind: 'linear' | 'log' | 'rank'
  /** Value to 0..1 along the axis. */
  norm: (v: number) => number
  /** 0..1 along the axis back to a value (tick labels). */
  at: (t: number) => number
}

function lowerBound(a: number[], v: number): number {
  let lo = 0, hi = a.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m }
  return lo
}
function upperBound(a: number[], v: number): number {
  let lo = 0, hi = a.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m }
  return lo
}

/**
 * Robust axis scale. Linear and log clip to the 2nd to 98th percentile so
 * one outlier can't squash every other ad into a corner; `auto` picks log
 * for non-negative, long-tailed metrics (spend, impressions), else linear.
 * `rank` spreads ads evenly by percentile.
 */
export function makeScale(values: number[], mode: ScaleMode): AxisScale {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return { kind: 'linear', norm: () => 0.5, at: t => t }
  let lo = quantileSorted(sorted, 0.02), hi = quantileSorted(sorted, 0.98)
  if (!(hi > lo)) { lo = sorted[0]; hi = sorted[sorted.length - 1] }
  if (!(hi > lo)) hi = lo + 1
  let kind: AxisScale['kind'] = mode === 'auto'
    ? (sorted[0] >= 0 && hi > 0 && hi / Math.max(quantileSorted(sorted, 0.5), hi * 1e-6) >= 8 ? 'log' : 'linear')
    : mode
  if (kind === 'log') {
    const minPos = sorted.find(v => v > 0)
    const llo = minPos === undefined ? NaN : Math.log10(Math.max(lo, minPos))
    const lhi = hi > 0 ? Math.log10(hi) : NaN
    if (Number.isFinite(llo) && Number.isFinite(lhi) && lhi > llo) {
      return {
        kind,
        norm: v => (v > 0 ? clamp01((Math.log10(v) - llo) / (lhi - llo)) : 0),
        at: t => 10 ** (llo + t * (lhi - llo)),
      }
    }
    kind = 'linear'
  }
  if (kind === 'rank') {
    const n = sorted.length
    return {
      kind,
      norm: v => (n < 2 ? 0.5 : clamp01((lowerBound(sorted, v) + upperBound(sorted, v) - 1) / 2 / (n - 1))),
      at: t => quantileSorted(sorted, t),
    }
  }
  return { kind: 'linear', norm: v => clamp01((v - lo) / (hi - lo)), at: t => lo + t * (hi - lo) }
}

// ── Layouts ────────────────────────────────────────────────────────────────

export type FunnelBand = { key: string; y0: number; y1: number; r: number; color: string }
/** The funnel's wall: a bowl from the mouth (radius R0 at yTop) narrowing to the neck (Rs at yNeck), then a straight
 *  spout down to yBottom. y grows downward, like the screen; p shapes the bowl (above 1 it flares at the mouth). */
export type FunnelProfile = { yTop: number; yNeck: number; yBottom: number; R0: number; Rs: number; p: number }
export type AxisGuide = { dim: 'x' | 'y' | 'z'; title: string; ticks: Array<{ t: number; text: string }> }

export type Guides =
  | { kind: 'none' }
  | { kind: 'funnel'; bands: FunnelBand[]; profile: FunnelProfile }
  | { kind: 'axes'; L: number; axes: AxisGuide[] }

/** The funnel wall's radius at height y. */
export function funnelRadius(f: FunnelProfile, y: number): number {
  if (y >= f.yNeck) return f.Rs
  const t = clamp((y - f.yTop) / (f.yNeck - f.yTop), 0, 1)
  return f.Rs + (f.R0 - f.Rs) * Math.pow(1 - t, f.p)
}

export type SpaceLayout = {
  kind: 'clusters' | 'funnel' | 'bins' | 'axes'
  targets: Map<string, Vec3>
  /** Node id to its cluster key (color, legend dimming). */
  groupOf: Map<string, string>
  clusters: Cluster[]
  /** Funnel placements inferred from frequency / CPMr: dashed outline. */
  dashed: Set<string>
  /** Not placed (no metric value on an axis, no funnel placement). */
  hidden: Set<string>
  guides: Guides
  /** Card sizes scale by this in the layout. */
  sizeScale: number
  /** Extent for the camera fit: radial distance from the y axis, and y. */
  bound: { rho: number; yMin: number; yMax: number }
  /** Preferred camera tilt (positive looks down) and azimuth. */
  rotX: number
  rotY: number | null
  /** Cluster labels: 'above' each cluster, 'side' of each funnel band, or none. */
  labels: 'above' | 'side' | 'none'
}

function membersBySpend(c: Cluster, byId: Map<string, SpaceNodeInput>): SpaceNodeInput[] {
  return c.ids.map(id => byId.get(id)!).filter(Boolean).sort((a, b) => (Number(b.ad.spend) || 0) - (Number(a.ad.spend) || 0))
}

function avgSize(ns: SpaceNodeInput[], scale: number): number {
  return ns.length ? ns.reduce((s, n) => s + n.size * scale, 0) / ns.length : 60 * scale
}

/** The mockup's cluster interior: a jittered Fibonacci sphere, biggest first. */
function placeSphere(c: Cluster, members: SpaceNodeInput[], targets: Map<string, Vec3>) {
  const m = members.length
  const rot = h01(c.key, 'rot') * Math.PI * 2
  members.forEach((n, i) => {
    if (m === 1) { targets.set(n.id, { ...c.center }); return }
    const t = (i + 0.5) / m
    const y = clamp(1 - 2 * t + (h01(n.id, 'yj') - 0.5) * 0.34, -0.99, 0.99)
    const rr = Math.sqrt(Math.max(0, 1 - y * y))
    const phi = i * 2.399963 + rot + (h01(n.id, 'ph') - 0.5) * 0.9
    const rad = c.r * (0.8 + 0.2 * h01(n.id, 'r'))
    targets.set(n.id, {
      x: c.center.x + Math.cos(phi) * rr * rad,
      y: c.center.y + y * rad * 0.92,
      z: c.center.z + Math.sin(phi) * rr * rad,
    })
  })
}

function baseLayout(kind: SpaceLayout['kind'], clusters: Cluster[], hidden: Set<string>): SpaceLayout {
  const groupOf = new Map<string, string>()
  for (const c of clusters) for (const id of c.ids) groupOf.set(id, c.key)
  return {
    kind, targets: new Map(), groupOf, clusters, dashed: new Set(), hidden,
    guides: { kind: 'none' }, sizeScale: 1, bound: { rho: 600, yMin: -400, yMax: 400 },
    rotX: -0.22, rotY: null, labels: 'above',
  }
}

/** Clusters on a ring (the original Creative Space layout). */
/**
 * Cards grow when a view holds few creatives, so a 150-ad account fills the
 * space like the mockup's 1,200 templates did (1x at 500+ cards, up to 2x).
 */
function sparseBoost(clusters: Cluster[]): number {
  const n = clusters.reduce((s, c) => s + c.ids.length, 0)
  return clamp(Math.sqrt(500 / Math.max(1, n)), 1, 2)
}

export function layoutRing(nodes: SpaceNodeInput[], clusters: Cluster[], hidden: Set<string>): SpaceLayout {
  const out = baseLayout('clusters', clusters, hidden)
  out.sizeScale = sparseBoost(clusters)
  // Looking slightly down, far clusters rise above near ones (labels stack).
  out.rotX = 0.26
  const byId = new Map(nodes.map(n => [n.id, n]))
  const live = clusters.filter(c => c.ids.length)
  for (const c of live) {
    const ms = membersBySpend(c, byId)
    c.r = Math.max(130, avgSize(ms, out.sizeScale) * Math.sqrt(ms.length) / 1.22)
  }
  const n = live.length
  const radii = live.map(c => c.r).sort((a, b) => b - a)
  const r1 = radii[0] || 0, r2 = radii[1] || 0
  // Each cluster gets an arc as wide as itself plus a gap, so the ring is as
  // big as its clusters need (the mockup's n x 105 floor made a ring of many
  // small clusters huge). Two or three clusters keep the mockup's spacing.
  const GAP = 90
  const arcs = live.map(c => 2 * c.r + GAP)
  const total = arcs.reduce((s, a) => s + a, 0)
  const R = n <= 1 ? 0 : Math.max(470, (total / (2 * Math.PI)) * 1.08, n <= 3 ? r1 * 1.28 + r2 + 190 : 0)
  let yMin = 0, yMax = 0
  let cum = 0
  live.forEach((c, k) => {
    const th = n <= 1 ? 0 : ((cum + arcs[k] / 2) / total) * Math.PI * 2
    cum += arcs[k]
    const cy = n <= 1 ? 0 : (h01(c.key, 'cy') - 0.5) * 240
    c.center = { x: Math.sin(th) * R, y: cy, z: Math.cos(th) * R }
    c.labelAt = { x: c.center.x, y: cy - c.r * 1.06 - 38, z: c.center.z }
    placeSphere(c, membersBySpend(c, byId), out.targets)
    yMin = Math.min(yMin, c.labelAt.y - 20)
    yMax = Math.max(yMax, cy + c.r + 70)
  })
  out.bound = { rho: R + r1 + 70, yMin, yMax }
  return out
}

/** Bins as clusters along the x axis, low to high, "No data" last. */
export function layoutRow(nodes: SpaceNodeInput[], clusters: Cluster[], hidden: Set<string>): SpaceLayout {
  const out = baseLayout('bins', clusters, hidden)
  out.sizeScale = sparseBoost(clusters)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const live = clusters.filter(c => c.ids.length)
  for (const c of live) {
    const ms = membersBySpend(c, byId)
    c.r = Math.max(110, avgSize(ms, out.sizeScale) * Math.sqrt(ms.length) / 1.22)
  }
  let cursor = 0
  const xs: number[] = []
  live.forEach((c, i) => {
    const gap = i === 0 ? 0 : c.sink ? 240 : 130
    const x = cursor + gap + c.r
    xs.push(x)
    cursor = x + c.r
  })
  const shift = cursor / 2
  let yMin = 0, yMax = 0, rho = 0
  live.forEach((c, i) => {
    c.center = { x: xs[i] - shift, y: 0, z: 0 }
    c.labelAt = { x: c.center.x, y: -c.r * 1.06 - 38, z: 0 }
    placeSphere(c, membersBySpend(c, byId), out.targets)
    yMin = Math.min(yMin, c.labelAt.y - 20)
    yMax = Math.max(yMax, c.r + 70)
    rho = Math.max(rho, Math.abs(c.center.x) + c.r + 60)
  })
  out.bound = { rho, yMin, yMax }
  out.rotX = -0.1
  out.rotY = 0
  return out
}

/**
 * Funnel: a real funnel in 3D (Peter, Oct 2 2026: "where there is actually a circular 3d funnel"). One wall, a bowl
 * narrowing from a wide mouth to a neck and then a straight spout, which the engine draws as lines. Each lane takes
 * a stretch of the wall, top of funnel at the mouth down to bottom of funnel at the neck, reactivation in the spout;
 * its creatives sit on the wall in rows around the circle, biggest spenders first, spread over the stretch by how
 * much room each row has. Stretches are sized by how many creatives a lane holds (never thinner than a row), and the
 * whole funnel grows until every lane fits.
 */
export function layoutFunnel(
  nodes: SpaceNodeInput[], clusters: Cluster[], hidden: Set<string>,
  placements: Map<string, FunnelPlacement> | null,
): SpaceLayout {
  const out = baseLayout('funnel', clusters, hidden)
  out.labels = 'side'
  out.sizeScale = 0.82
  const byId = new Map(nodes.map(n => [n.id, n]))
  const placed = clusters.reduce((s, c) => s + c.ids.length, 0)
  const all = clusters.flatMap(c => c.ids.map(id => byId.get(id)!)).filter(Boolean)
  const avg = avgSize(all, out.sizeScale)
  const pitch = avg * 0.9 + 14   // between cards, around the circle
  const rowH = avg * 1.1 + 16    // between rows, down the wall
  const capAt = (r: number) => Math.max(4, Math.floor((2 * Math.PI * r) / pitch))
  const weight = (n: number) => Math.sqrt(n + 3)
  const inSpout = (c: Cluster) => c.key === 'REACT'
  const bowl = clusters.filter(c => !inSpout(c))
  const spout = clusters.filter(inSpout)

  type Row = { y: number; r: number; cap: number }
  type Lane = { c: Cluster; y0: number; y1: number; rows: Row[] }
  let R0 = clamp(26 * Math.sqrt(placed) + 300, 380, 1300)
  let built: { profile: FunnelProfile; lanes: Lane[] } | null = null
  for (let attempt = 0; attempt < 40 && !built; attempt++) {
    const Rs = R0 * 0.15
    const yNeck = R0 * 1.3
    const spoutCap = capAt(Rs * 0.97)
    const spoutRows = spout.reduce((n, c) => n + Math.max(1, Math.ceil(c.ids.length / spoutCap)), 0)
    const profile: FunnelProfile = { yTop: 0, yNeck, yBottom: yNeck + Math.max(R0 * 0.36, (spoutRows + 0.6) * rowH), R0, Rs, p: 1.6 }
    const lanes: Lane[] = []
    let fits = true
    // the bowl: every lane gets a row's height, the rest goes by weight
    const top = rowH * 0.2
    const free = yNeck - top - bowl.length * rowH
    if (free < 0) fits = false
    const wSum = bowl.reduce((n, c) => n + weight(c.ids.length), 0) || 1
    let y = top
    for (const c of bowl) {
      const h = rowH + Math.max(0, free) * (weight(c.ids.length) / wSum)
      const nRows = Math.max(1, Math.floor(h / rowH))
      const rows: Row[] = Array.from({ length: nRows }, (_, k) => {
        const r = funnelRadius(profile, y + (k + 0.5) * (h / nRows)) * 0.97
        return { y: y + (k + 0.5) * (h / nRows), r, cap: capAt(r) }
      })
      if (rows.reduce((n, r) => n + r.cap, 0) < c.ids.length) fits = false
      lanes.push({ c, y0: y, y1: y + h, rows })
      y += h
    }
    // the spout: as many rows as its lanes need, at the neck's radius
    let ys = yNeck
    for (const c of spout) {
      const n = Math.max(1, Math.ceil(c.ids.length / spoutCap))
      const rows: Row[] = Array.from({ length: n }, (_, k) => ({ y: ys + (k + 0.8) * rowH, r: Rs * 0.97, cap: spoutCap }))
      lanes.push({ c, y0: ys, y1: ys + (n + 0.6) * rowH, rows })
      ys += (n + 0.6) * rowH
    }
    if (fits) built = { profile, lanes }
    else R0 *= 1.12
  }
  if (!built) return out

  // centre the funnel on the orbit's look-at point
  const { profile, lanes } = built
  const mid = (profile.yTop + profile.yBottom) / 2
  profile.yTop -= mid; profile.yNeck -= mid; profile.yBottom -= mid
  const bands: FunnelBand[] = []
  for (const { c, y0, y1, rows } of lanes) {
    const ms = membersBySpend(c, byId)
    // fill the rows top down, each taking its share of what's left by its room
    let left = ms.length, room = rows.reduce((n, r) => n + r.cap, 0), at = 0
    rows.forEach((row, k) => {
      const n = left > 0 ? Math.min(row.cap, Math.ceil((left * row.cap) / room)) : 0
      room -= row.cap
      const phase = h01(`${c.key}:${k}`, 'phase') * Math.PI * 2
      for (let j = 0; j < n; j++) {
        const node = ms[at++]
        const th = phase + ((j + (h01(node.id, 'th') - 0.5) * 0.3) / n) * Math.PI * 2
        out.targets.set(node.id, {
          x: Math.sin(th) * row.r,
          y: row.y - mid + (h01(node.id, 'yj') - 0.5) * 8,
          z: Math.cos(th) * row.r,
        })
        if (placements?.get(node.id)?.estimated) out.dashed.add(node.id)
      }
      left -= n
    })
    const yMid = (y0 + y1) / 2 - mid
    const r = funnelRadius(profile, yMid)
    bands.push({ key: c.key, y0: y0 - mid, y1: y1 - mid, r, color: c.color })
    c.center = { x: 0, y: yMid, z: 0 }
    c.r = r
    c.labelAt = { x: -r, y: yMid, z: 0 }
  }
  out.guides = { kind: 'funnel', bands, profile }
  out.bound = { rho: profile.R0 + avg, yMin: profile.yTop - rowH, yMax: profile.yBottom + rowH }
  out.rotX = 0.42
  return out
}

export const AXES_HALF = 560

/**
 * Metric axes: every ad at (x, y, z) = its three metrics on robust scales,
 * inside a cube. Higher values sit right, up and toward the back-left.
 * Ads missing a value on any axis are left out. `colorBy` groups the placed
 * ads for color and the legend (any field; ads it can't place go neutral).
 */
export function layoutAxes(
  nodes: SpaceNodeInput[],
  colorBy: (placed: SpaceNodeInput[]) => Cluster[],
  axes: Array<{ key: string; title: string; fmt: (v: number) => string }>, mode: ScaleMode,
): SpaceLayout {
  const L = AXES_HALF
  const scales = axes.map(a => makeScale(nodes.map(n => metricOf(n.ad, a.key)), mode))
  const targets = new Map<string, Vec3>()
  const hidden = new Set<string>()
  for (const n of nodes) {
    const v = axes.map(a => metricOf(n.ad, a.key))
    if (v.some(x => !Number.isFinite(x))) { hidden.add(n.id); continue }
    const t = v.map((x, i) => scales[i].norm(x))
    targets.set(n.id, {
      x: -L + 2 * L * t[0],
      y: L - 2 * L * t[1],
      z: -L + 2 * L * t[2],
    })
  }
  const out = baseLayout('axes', colorBy(nodes.filter(n => targets.has(n.id))), hidden)
  out.targets = targets
  // A color group runs through the cube rather than sitting in one place: its centre is its members' centroid,
  // its radius the distance that takes in 90% of them, and its label point just above the highest of them.
  for (const c of out.clusters) {
    const ps = c.ids.map(id => targets.get(id)).filter((p): p is Vec3 => !!p)
    if (!ps.length) continue
    const m = ps.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y, z: s.z + p.z }), { x: 0, y: 0, z: 0 })
    c.center = { x: m.x / ps.length, y: m.y / ps.length, z: m.z / ps.length }
    const ds = ps.map(p => Math.hypot(p.x - c.center.x, p.y - c.center.y, p.z - c.center.z)).sort((a, b) => a - b)
    c.r = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.9))]
    c.labelAt = { x: c.center.x, y: Math.min(...ps.map(p => p.y)) - 60, z: c.center.z }
  }
  out.labels = 'none'
  out.sizeScale = 0.72 * clamp(Math.sqrt(500 / Math.max(1, targets.size)), 1, 2)
  const dims: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z']
  out.guides = {
    kind: 'axes',
    L,
    axes: axes.map((a, i) => ({
      dim: dims[i],
      title: a.title,
      ticks: [0, 0.25, 0.5, 0.75, 1].map(t => ({ t, text: a.fmt(scales[i].at(t)) })),
    })),
  }
  out.bound = { rho: L * Math.SQRT2 + 90, yMin: -L - 90, yMax: L + 90 }
  out.rotX = 0.36
  out.rotY = 0.62
  return out
}
