/**
 * Creative space: every ad in view as a card in a draggable 3D space. Ported
 * from Atelier's Creative Analysis (same Canvas 2D engine, same layouts).
 * Chrome follows Atelier's DESIGN_BRIEF.md: hairline cards with a
 * group-color dot, small sans labels, one slim KPI strip, a collapsible
 * legend and the canvas controls in the corner.
 *
 * Arrange by funnel position (Meta delivery, the default), any naming field
 * detected from the ad names (lib/autoNaming), creative type, status,
 * campaign, ad set or spend cohort. Or by metric: three metrics as X / Y / Z
 * axes, or quantile bins of one metric.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Pause, Play, RotateCcw } from 'lucide-react'
import type { SpaceAd } from '../lib/adModel'
import { ALL_METRICS, METRICS_BY_KEY, type MetricDef } from '../lib/metrics'
import type { FunnelPlacement } from './funnelPosition'
import {
  ARRANGE_AXES, ARRANGE_BINS, FIELD_FUNNEL,
  buildFieldCatalog, buildNamingIndex, defaultArrange, metricOf, spendCohorts,
  funnelLanesFromClusters, groupByBins, groupByField, layoutAxes, layoutFunnel, layoutRing, layoutRow,
  type Cluster, type ScaleMode, type SpaceLayout, type SpaceNodeInput, type ValueContext,
} from './spaceLayout'
import { SpaceEngine, type SpaceTheme } from './spaceEngine'
import { BTN_ICON, EYEBROW, OVERLAY } from '../ui/theme'
import { ThumbLoader, spaceThumbSources } from './spaceThumbs'
import { GroupMenu, type GroupAction } from './GroupMenu'
import { GroupGrid } from './GroupGrid'
import { GroupSlideshow } from './GroupSlideshow'
import { sortGroupAds } from './groupViews'
import { AxesPopover, AxisSection, OptionPicker } from '../ui/AxesControl'
import { FieldRow } from '../ui/settingsUi'
import { Segmented } from '../ui/Segmented'
import { fmtAxis, fmtCell, fmtCount, fmtMoney, fmtValue } from '../lib/format'

type Props = {
  /** Cards to show (same-creative variants already stacked). */
  ads: SpaceAd[]
  /** Funnel placement of every ad (App computes it once per load, from sourceAds). */
  funnel: Map<string, FunnelPlacement>
  /** Changes when the account or demo switches (re-frames the camera). */
  scope: string
  /** Thumbnails come from the demo set. */
  demo: boolean
  /** When the ads were pulled from Meta: a new pull renews Meta's image links, so failed thumbnails try again. */
  fetchedAt?: string
  selectedId: string | null
  onOpen: (adId: string) => void
}

type Settings = {
  arrange: string
  color: string
  x: string
  y: string
  z: string
  binMetric: string
  bins: number
  scale: ScaleMode
  rotate: boolean
}

const LS_KEY = 'fv.space'
// Legend collapsed or open: a per-viewer convenience, so plain localStorage.
const LS_LEGEND = 'fv.space.legend'
const DEFAULTS: Settings = {
  arrange: '', color: '', x: 'roas', y: 'ctr', z: 'spend',
  binMetric: 'roas', bins: 4, scale: 'auto', rotate: true,
}
// Beyond this many cards the view keeps the top spenders.
const MAX_CARDS = 600

const SCALE_OPTIONS: Array<{ value: ScaleMode; label: string; title: string }> = [
  { value: 'auto', label: 'Auto', title: 'Log for long-tailed metrics like spend, else linear' },
  { value: 'linear', label: 'Linear', title: 'Linear scale' },
  { value: 'log', label: 'Log', title: 'Logarithmic scale' },
  { value: 'rank', label: 'Rank', title: 'Evenly spread by percentile' },
]
const BIN_OPTIONS = [
  { value: '3', label: '3 bins' },
  { value: '4', label: 'Quartiles' },
  { value: '5', label: 'Quintiles' },
  { value: '10', label: 'Deciles' },
]

const METRIC_OPTIONS = ALL_METRICS.filter(m => m.format !== 'text')
  .map(m => ({ value: m.key, label: m.label, group: m.group, hint: m.description }))

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw)
    if (!p || typeof p !== 'object') return DEFAULTS
    const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
    const arrange = str(p.arrange, DEFAULTS.arrange)
    const color = str(p.color, DEFAULTS.color)
    return {
      arrange,
      color,
      x: str(p.x, DEFAULTS.x),
      y: str(p.y, DEFAULTS.y),
      z: str(p.z, DEFAULTS.z),
      binMetric: str(p.binMetric, DEFAULTS.binMetric),
      bins: [3, 4, 5, 10].includes(Number(p.bins)) ? Number(p.bins) : DEFAULTS.bins,
      scale: ['auto', 'linear', 'log', 'rank'].includes(p.scale) ? p.scale : DEFAULTS.scale,
      rotate: typeof p.rotate === 'boolean' ? p.rotate : DEFAULTS.rotate,
    }
  } catch {
    return DEFAULTS
  }
}

/** A metric value for the hover card; missing reads "n/a", never a fake 0. */
const fmtMetric = (v: number, def: MetricDef) => (Number.isFinite(v) ? fmtCell(v, def.format) : 'n/a')

function totalsOf(list: SpaceAd[]) {
  let spend = 0, revenue = 0, purchases = 0, clicks = 0, impressions = 0
  // Reach can't be summed across ads (the same people see several), so frequency and CPMr here are
  // spend-weighted averages of each ad's own, labelled "avg".
  let freqW = 0, cpmrW = 0, wSpend = 0
  for (const a of list) {
    const s = Number(a.spend) || 0, imp = Number(a.impressions) || 0, reach = Number(a.reach) || 0
    spend += s
    revenue += Number(a.revenue) || 0
    purchases += Number(a.purchases) || 0
    clicks += Number(a.clicks) || 0
    impressions += imp
    if (reach > 0 && s > 0) { freqW += (imp / reach) * s; cpmrW += (s / reach) * 1000 * s; wSpend += s }
  }
  return {
    n: list.length, spend, revenue, purchases, clicks, impressions,
    freq: wSpend > 0 ? freqW / wSpend : null,
    cpmr: wSpend > 0 ? cpmrW / wSpend : null,
  }
}

/** The theme tokens the canvas draws with, resolved to colors through a
 *  hidden probe inside the space (so light-dark() picks the active scheme). */
function readSpaceTheme(el: HTMLElement): SpaceTheme {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  el.appendChild(probe)
  const read = (token: string) => {
    probe.style.color = `var(${token})`
    return getComputedStyle(probe).color
  }
  const theme = { ink: read('--color-text-primary'), muted: read('--color-text-muted'), bg: read('--color-surface') }
  probe.remove()
  return theme
}

export function CreativeSpace3D({ ads: allAds, funnel: funnelAll, scope, demo, fetchedAt, selectedId, onOpen }: Props) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const update = (patch: Partial<Settings>) => setSettings(s => ({ ...s, ...patch }))
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)) } catch { /* storage off */ }
  }, [settings])

  // Very large views keep the top spenders. The payload itself is not capped; the hourly Meta call
  // budget keeps a load to a few thousand ads at most.
  const ads = useMemo(() => {
    if (allAds.length <= MAX_CARDS) return allAds
    return [...allAds].sort((a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0)).slice(0, MAX_CARDS)
  }, [allAds])
  const adById = useMemo(() => new Map(ads.map(a => [a.ad_id, a])), [ads])

  // ── Fields, metrics, grouping ──────────────────────────────────────────
  const naming = useMemo(() => buildNamingIndex(ads), [ads])
  const cohort = useMemo(() => spendCohorts(ads), [ads])
  const fields = useMemo(() => buildFieldCatalog(naming), [naming])
  const fieldByKey = useMemo(() => new Map(fields.map(f => [f.key, f])), [fields])
  const fallbackKey = defaultArrange()
  const isMetricMode = (k: string) => k === ARRANGE_AXES || k === ARRANGE_BINS
  const arrange = isMetricMode(settings.arrange) || fieldByKey.has(settings.arrange) ? settings.arrange : fallbackKey
  const colorKey = fieldByKey.has(settings.color) ? settings.color : fieldByKey.has(arrange) ? arrange : fallbackKey

  const numericDef = (k: string): MetricDef | undefined => {
    const d = k ? METRICS_BY_KEY[k] : undefined
    return d && d.format !== 'text' ? d : undefined
  }
  const xDef = numericDef(settings.x) || METRICS_BY_KEY.roas
  const yDef = numericDef(settings.y) || METRICS_BY_KEY.ctr
  const zDef = numericDef(settings.z) || METRICS_BY_KEY.spend
  const binDef = numericDef(settings.binMetric) || METRICS_BY_KEY.roas

  const usesFunnel = arrange === FIELD_FUNNEL || (arrange === ARRANGE_AXES && colorKey === FIELD_FUNNEL)
  const funnel = usesFunnel ? funnelAll : null

  const nodes = useMemo<SpaceNodeInput[]>(() => {
    let max = 1
    for (const a of ads) max = Math.max(max, Number(a.spend) || 0)
    return ads.map(ad => ({ id: ad.ad_id, ad, size: 40 + 82 * Math.sqrt(Math.max(0, Number(ad.spend) || 0) / max) }))
  }, [ads])

  const layout = useMemo<SpaceLayout>(() => {
    const ctx: ValueContext = { naming, funnel, cohort }
    if (arrange === ARRANGE_AXES) {
      const colorField = fieldByKey.get(colorKey)!
      return layoutAxes(
        nodes,
        placed => groupByField(placed, colorField, ctx).clusters,
        [xDef, yDef, zDef].map(d => ({ key: d.key, title: d.label, fmt: (v: number) => fmtAxis(v, d.format) })),
        settings.scale,
      )
    }
    if (arrange === ARRANGE_BINS) {
      const g = groupByBins(nodes, binDef.key, settings.bins, v => fmtValue(v, binDef.format))
      return layoutRow(nodes, g.clusters, g.hidden)
    }
    const field = fieldByKey.get(arrange)!
    const g = groupByField(nodes, field, ctx)
    if (field.key === FIELD_FUNNEL) return layoutFunnel(nodes, g.clusters, g.hidden, funnel)
    // A naming field whose values are funnel stages draws the funnel too.
    const lanes = funnelLanesFromClusters(nodes, g.clusters, g.hidden, /funnel/i.test(field.label))
    return lanes
      ? layoutFunnel(nodes, lanes.clusters, lanes.hidden, null)
      : layoutRing(nodes, g.clusters, g.hidden)
  }, [nodes, arrange, colorKey, fieldByKey, naming, funnel, cohort, xDef, yDef, zDef, binDef, settings.bins, settings.scale])

  // A new arrangement re-frames the camera; new data under the same one doesn't.
  const cameraSig = [
    scope, arrange,
    ...(arrange === ARRANGE_AXES ? [xDef.key, yDef.key, zDef.key, settings.scale] : []),
    ...(arrange === ARRANGE_BINS ? [binDef.key, settings.bins] : []),
  ].join('|')

  // ── Engine ─────────────────────────────────────────────────────────────
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const legendRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<SpaceEngine | null>(null)
  const loaderRef = useRef<ThumbLoader | null>(null)
  const lastSigRef = useRef('')

  // Hover card content reads the latest render through this ref (the engine
  // calls back outside React).
  const hoverDefs: MetricDef[] = arrange === ARRANGE_AXES
    ? [xDef, yDef, zDef]
    : arrange === ARRANGE_BINS
      ? [binDef, binDef.key === 'spend' ? METRICS_BY_KEY.roas : METRICS_BY_KEY.spend]
      : [METRICS_BY_KEY.spend, METRICS_BY_KEY.roas, METRICS_BY_KEY.ctr]
  const groupLabel = arrange === ARRANGE_BINS ? `${binDef.label} bin`
    : fieldByKey.get(arrange === ARRANGE_AXES ? colorKey : arrange)?.label || ''
  const tipCtx = useRef({ adById, layout, hoverDefs, groupLabel, funnel, menuOpen: false })
  const onOpenRef = useRef(onOpen)
  // A click on a group label in the space runs the same clickGroup as its legend row (set below, each render).
  const groupClickRef = useRef<(key: string) => void>(() => {})
  useLayoutEffect(() => {
    tipCtx.current = { adById, layout, hoverDefs, groupLabel, funnel, menuOpen: !!menu }
    onOpenRef.current = onOpen
  })

  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current
    if (!canvas || !wrap) return
    // The hover card is rebuilt only when the hovered ad (or the render behind
    // it) changes; a plain pointer move just moves it, with no layout read.
    let tipShown: { id: string; ctx: typeof tipCtx.current } | null = null
    let tipW = 0, tipH = 0
    const showTip = (h: { id: string; x: number; y: number } | null) => {
      const el = tipRef.current
      if (!el) return
      const ctx = tipCtx.current
      const { adById: byId, layout: L, hoverDefs: defs, groupLabel: gl, funnel: fp, menuOpen } = ctx
      const ad = h ? byId.get(h.id) : undefined
      if (!h || !ad || menuOpen) {
        if (tipShown) { el.style.display = 'none'; tipShown = null }
        return
      }
      if (!tipShown || tipShown.id !== h.id || tipShown.ctx !== ctx) {
        const [nameEl, groupEl, metricsEl] = Array.from(el.children) as HTMLElement[]
        nameEl.textContent = ad.ad_name || ad.ad_id
        const cluster = L.clusters.find(c => c.key === L.groupOf.get(ad.ad_id))
        const estimated = L.kind === 'funnel' && fp?.get(ad.ad_id)?.estimated
        groupEl.textContent = cluster ? `${gl}: ${cluster.name}${estimated ? ' (estimated from frequency and CPMr)' : ''}` : ''
        groupEl.style.display = cluster ? '' : 'none'
        metricsEl.replaceChildren(...defs.map((d, i) => {
          const span = document.createElement('span')
          const v = document.createElement('span')
          v.className = i === 0 ? 'font-display text-[14px] text-text-primary tabular-nums' : 'tabular-nums text-text-secondary'
          v.textContent = fmtMetric(metricOf(ad, d.key), d)
          const l = document.createElement('span')
          l.className = 'text-text-muted'
          l.textContent = ` ${d.label}`
          span.append(v, l)
          return span
        }))
        el.style.display = 'block'
        tipW = el.offsetWidth
        tipH = el.offsetHeight
        tipShown = { id: h.id, ctx }
      }
      const pw = wrap.clientWidth, ph = wrap.clientHeight
      el.style.left = `${Math.min(h.x + 14, pw - tipW - 10)}px`
      el.style.top = `${Math.min(h.y + 14, ph - tipH - 10)}px`
    }
    const loader = new ThumbLoader(() => engine.invalidate())
    const engine = new SpaceEngine(canvas, {
      getThumb: id => loader.get(id),
      onHover: showTip,
      onOpen: id => onOpenRef.current(id),
      onGroupMenu: (key, x, y) => setMenu({ key, x, y }),
      onGroupClick: key => groupClickRef.current(key),
      onFocus: key => setFocused(key),
    })
    engineRef.current = engine
    loaderRef.current = loader
    engine.resize(wrap.clientWidth, wrap.clientHeight)
    // The canvas can't read CSS variables: resolve the theme tokens to
    // colors, now and whenever Light, Dark or System changes.
    const applyTheme = () => engine.setTheme(readSpaceTheme(wrap))
    applyTheme()
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
    mq?.addEventListener?.('change', applyTheme)
    const mo = new MutationObserver(applyTheme)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect
      if (r) engine.resize(r.width, r.height)
    })
    ro.observe(wrap)
    // Off screen (scrolled away) the loop stops; back on screen it resumes.
    const io = new IntersectionObserver(entries => engine.setActive(entries.some(e => e.isIntersecting)))
    io.observe(wrap)
    return () => {
      mq?.removeEventListener?.('change', applyTheme)
      mo.disconnect()
      ro.disconnect()
      io.disconnect()
      engine.destroy()
      loader.destroy()
      engineRef.current = null
      loaderRef.current = null
      lastSigRef.current = ''
    }
  }, [])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    const reset = cameraSig !== lastSigRef.current
    lastSigRef.current = cameraSig
    engine.setLayout(
      nodes.map(n => ({ id: n.id, size: n.size, video: !!(n.ad.is_video || n.ad.video_id), count: n.ad.variants?.length || 1 })),
      layout,
      { resetCamera: reset },
    )
  }, [nodes, layout, cameraSig])

  const lastFetchRef = useRef(fetchedAt)
  useEffect(() => {
    const loader = loaderRef.current
    if (!loader) return
    if (fetchedAt !== lastFetchRef.current) { lastFetchRef.current = fetchedAt; loader.retryFailed() }
    const order = [...ads].sort((a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0))
    loader.request(order.map(ad => ({ id: ad.ad_id, sources: spaceThumbSources(ad.ad_id, demo, ad.creative_hash) })))
  }, [ads, demo, fetchedAt])

  useEffect(() => { engineRef.current?.setSelected(selectedId) }, [selectedId])
  useEffect(() => { engineRef.current?.setAutoRotate(settings.rotate) }, [settings.rotate])
  // A focus frames its group clear of the legend, so the engine follows the legend's footprint in the bottom
  // left corner: from the canvas's left edge to the legend's right, and from the bottom up to its top.
  useEffect(() => {
    const el = legendRef.current, wrap = wrapRef.current
    if (!el || !wrap) return
    const measure = () => engineRef.current?.setLegendBox(el.offsetLeft + el.offsetWidth, wrap.clientHeight - el.offsetTop)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // ── Legend + KPI strip ──────────────────────────────────────────────────
  const [legendHover, setLegendHover] = useState<string | null>(null)
  // Open until someone closes it; on a phone it starts closed, so it doesn't cover the space.
  const [legendOpen, setLegendOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(LS_LEGEND)
      if (saved) return saved !== 'closed'
      return !window.matchMedia('(max-width: 639px)').matches
    } catch { return true }
  })
  const toggleLegend = () => setLegendOpen(o => {
    try { localStorage.setItem(LS_LEGEND, o ? 'closed' : 'open') } catch { /* storage off */ }
    return !o
  })
  // A hover recorded against an older layout simply doesn't match any group.
  const hoveredCluster = legendHover ? layout.clusters.find(c => c.key === legendHover) : undefined

  // Right-click a legend row, a group label or a card: the group menu. Isolate in the model (the rest
  // darkens, the camera stays), or take the group into the plain grid or the slideshow, over the space.
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const groupCtx = `${arrange}|${colorKey}`
  const [iso, setIso] = useState<{ key: string; ctx: string } | null>(null)
  const isolated = iso && iso.ctx === groupCtx ? iso.key : null
  const setIsolated = (key: string | null) => setIso(key ? { key, ctx: groupCtx } : null)
  const [view, setView] = useState<{ kind: 'grid' | 'slides'; key: string; start: string | null } | null>(null)
  // Keys from an older layout (a new arrangement) simply match nothing.
  const isoCluster = isolated ? layout.clusters.find(c => c.key === isolated) : undefined
  const menuCluster = menu ? layout.clusters.find(c => c.key === menu.key) : undefined
  const viewCluster = view ? layout.clusters.find(c => c.key === view.key) : undefined
  // The group the camera flew to (a click on its legend row or label), until a reset or a new arrangement.
  const [focused, setFocused] = useState<string | null>(null)
  const focusedCluster = focused ? layout.clusters.find(c => c.key === focused) : undefined
  useEffect(() => { engineRef.current?.setIsolated(isoCluster ? isoCluster.key : null) }, [isoCluster])
  // The group lit on the canvas: the one a group menu is open for (so it shows what the menu acts on), else a
  // hovered legend row. An isolated group keeps the light while other rows are hovered.
  const activeHover = menuCluster ? menuCluster.key : isoCluster ? null : hoveredCluster ? hoveredCluster.key : null
  useEffect(() => { engineRef.current?.setHoverGroup(activeHover) }, [activeHover])
  // The 3D view rests while a plain view or slideshow covers it.
  useEffect(() => { engineRef.current?.setActive(!viewCluster) }, [viewCluster])
  const groupAds = (c: Cluster) => c.ids.filter(id => !layout.hidden.has(id)).map(id => adById.get(id)!).filter(Boolean)
  // Show all, Esc, or a second click on the isolated group: every group back. In the axes a click framed the
  // group as well as isolating it, so the whole cube comes back with it.
  const releaseIsolated = () => {
    setIsolated(null)
    if (layout.kind === 'axes' && focused !== null) engineRef.current?.resetView()
  }
  // A click on a group, from its legend row or its label in the space. Funnel, ring and bins: the camera flies
  // to frame it. Axes, where the groups run through each other: it is isolated too (the rest darkens), and the
  // camera frames its cards. Clicking the isolated group again lets go of it; clicking another while one is
  // isolated isolates that one instead. A group with no card in view does nothing.
  const clickGroup = (key: string) => {
    const c = layout.clusters.find(g => g.key === key)
    if (!c || !visibleIds(c).length) return
    if (isoCluster?.key === key) { releaseIsolated(); return }
    if (isoCluster || layout.kind === 'axes') setIsolated(key)
    engineRef.current?.focus(key)
  }
  const onGroupAction = (a: GroupAction, key: string) => {
    if (a === 'isolate') {
      setIsolated(key)
      const engine = engineRef.current
      if (engine && (layout.kind === 'axes' || !engine.onScreenCount(key))) engine.focus(key)
    }
    else if (a === 'show-all') releaseIsolated()
    else setView({ kind: a, key, start: null })
  }
  // Esc lets go of an isolated group, else of a focused one (the view glides back to the whole space). The
  // drawer, menu and views take Esc first while open.
  const escRef = useRef(() => {})
  useLayoutEffect(() => {
    groupClickRef.current = clickGroup
    escRef.current = () => { if (isoCluster) releaseIsolated(); else engineRef.current?.resetView() }
  })
  useEffect(() => {
    if ((!isoCluster && !focusedCluster) || menu || view || selectedId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') escRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isoCluster, focusedCluster, menu, view, selectedId])

  const visibleIds = (c: Cluster) => c.ids.filter(id => !layout.hidden.has(id))
  const shownAds = useMemo(() => ads.filter(a => !layout.hidden.has(a.ad_id)), [ads, layout])
  // The KPI strip: the isolated group, else a hovered legend row, else the group the camera is on.
  const kpiCluster = isoCluster || hoveredCluster || focusedCluster
  const kpi = totalsOf(kpiCluster ? visibleIds(kpiCluster).map(id => adById.get(id)!).filter(Boolean) : shownAds)

  const legendTitle = arrange === ARRANGE_AXES ? `Color: ${fieldByKey.get(colorKey)?.label || ''}`
    : arrange === ARRANGE_BINS ? `${binDef.label}, ${BIN_OPTIONS.find(b => b.value === String(settings.bins))?.label.toLowerCase()}, low to high`
    : layout.kind === 'funnel' ? `${fieldByKey.get(arrange)?.label || 'Funnel position'}, top to bottom`
    : `${fieldByKey.get(arrange)?.label || ''}, by spend`
  const notes: string[] = []
  if (layout.kind === 'axes' && layout.hidden.size) notes.push(`${layout.hidden.size} ads have no value on an axis`)
  if (layout.kind === 'funnel') {
    if (layout.dashed.size) notes.push(`Dashed: ${layout.dashed.size} placed by frequency and CPMr (no segment data)`)
    if (layout.hidden.size) notes.push(arrange === FIELD_FUNNEL
      ? `${layout.hidden.size} ads with no spend are not placed`
      : `${layout.hidden.size} ads with no stage in ${fieldByKey.get(arrange)?.label || 'this field'} are not placed. Funnel position places every ad from Meta delivery`)
  }
  if (allAds.length > ads.length) notes.push(`Top ${ads.length} of ${allAds.length} by spend`)

  // ── Controls ───────────────────────────────────────────────────────────
  const fieldOptions = fields.map(f => ({ value: f.key, label: f.label, group: f.group, hint: f.hint }))
  const arrangeOptions = [
    ...fieldOptions,
    { value: ARRANGE_AXES, label: 'Metric axes (X, Y, Z)', group: 'Metric', hint: 'Place each ad by three metrics' },
    { value: ARRANGE_BINS, label: 'Metric bins', group: 'Metric', hint: 'Cluster by quantile bins of one metric' },
  ]
  const setArrange = (v: string) => update(isMetricMode(v) ? { arrange: v } : { arrange: v, color: v })
  const binsLabel = BIN_OPTIONS.find(b => b.value === String(settings.bins))?.label || ''
  // The space's one control (the same pill and panel as every chart): how
  // cards are arranged, and for metric layouts the axes, color and scale.
  const controlLabel = arrange === ARRANGE_AXES ? `${xDef.label}, ${yDef.label}, ${zDef.label}`
    : arrange === ARRANGE_BINS ? `${binDef.label} ${binsLabel.toLowerCase()}`
    : (fieldByKey.get(arrange)?.label || 'Group by')
  const metricPick = (value: string, onPick: (k: string) => void, aria: string) => (
    <OptionPicker ariaLabel={aria} value={value} options={METRIC_OPTIONS} onChange={k => { if (k) onPick(k) }} />
  )
  const control = (
    <AxesPopover label={controlLabel} title="Group the cards, or place them by metrics">
      <AxisSection label="Arrange" title="Group the cards by a field, or place them by metrics"
        action={<OptionPicker ariaLabel="Arrange" value={arrange} options={arrangeOptions} onChange={setArrange} />} />
      {arrange === ARRANGE_AXES && (
        <>
          <AxisSection label="X axis" action={metricPick(xDef.key, k => update({ x: k }), 'X axis metric')} />
          <AxisSection label="Y axis" action={metricPick(yDef.key, k => update({ y: k }), 'Y axis metric')} />
          <AxisSection label="Z axis (depth)" action={metricPick(zDef.key, k => update({ z: k }), 'Z axis metric')} />
          <AxisSection label="Color" action={<OptionPicker ariaLabel="Color" value={colorKey} options={fieldOptions} onChange={v => update({ color: v })} />} />
          <AxisSection label="Options">
            <FieldRow label="Scale">
              <Segmented<ScaleMode> size="sm" ariaLabel="Axis scale" value={settings.scale}
                onChange={v => update({ scale: v })} options={SCALE_OPTIONS} />
            </FieldRow>
          </AxisSection>
        </>
      )}
      {arrange === ARRANGE_BINS && (
        <>
          <AxisSection label="Metric" title="Metric to bin" action={metricPick(binDef.key, k => update({ binMetric: k }), 'Bin metric')} />
          <AxisSection label="Bins" action={<OptionPicker ariaLabel="Bins" value={String(settings.bins)} options={BIN_OPTIONS} onChange={v => update({ bins: Number(v) })} />} />
        </>
      )}
    </AxesPopover>
  )

  return (
    <div className="h-full flex flex-col">
      <div
        ref={wrapRef}
        // A glass panel on the ground (Atelier's Creative Analysis body): the
        // glass field draws its frost and liquid rim behind the canvas, which
        // clears to transparent, so the cards float over the frosted ground.
        className="fv-space ody-glass relative flex-1 overflow-hidden select-none"
        style={{ minHeight: 420 }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 block" style={{ touchAction: 'none', cursor: 'grab' }} />

        {/* KPI strip: the cards in view, or the hovered legend group. One
            hairlined row, cells divided by hairlines, value then label. */}
        <div
          className={`absolute top-12 sm:top-3 left-3 flex items-center divide-x divide-line pointer-events-none max-w-[calc(100%-24px)] sm:max-w-[calc(100%-320px)] overflow-hidden ${OVERLAY}`}
          aria-live="polite"
        >
          {kpiCluster && (
            <div className="h-8 px-2.5 flex items-center gap-1.5 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: kpiCluster.color }} />
              <span className="text-[12px] font-medium text-text-primary truncate max-w-[160px]">{kpiCluster.name}</span>
              {isoCluster && (
                <button type="button" onClick={releaseIsolated}
                  className="ody-pill pointer-events-auto ml-1 h-6 px-2.5 rounded-full text-[12px] flex items-center whitespace-nowrap shrink-0"
                  title="Bring every group back (Esc)">
                  Show all
                </button>
              )}
            </div>
          )}
          {([
            ['creatives', fmtCount(kpi.n), ''],
            ['spend', fmtMoney(kpi.spend), ''],
            ['ROAS', kpi.spend ? (kpi.revenue / kpi.spend).toFixed(2) : '0.00', ''],
            ['purchases', fmtCount(kpi.purchases), 'hidden lg:flex'],
            ['CTR', kpi.impressions ? `${((kpi.clicks / kpi.impressions) * 100).toFixed(2)}%` : '0%', 'hidden lg:flex'],
            ['CPA', kpi.purchases ? fmtCell(kpi.spend / kpi.purchases, 'dollar') : 'n/a', 'hidden xl:flex'],
            ['CPM', kpi.impressions ? fmtCell((kpi.spend / kpi.impressions) * 1000, 'dollar') : 'n/a', 'hidden xl:flex'],
            ['CPMr avg', kpi.cpmr != null ? fmtCell(kpi.cpmr, 'dollar') : 'n/a', kpiCluster ? 'hidden 2xl:flex' : 'hidden xl:flex'],
            ['freq avg', kpi.freq != null ? kpi.freq.toFixed(2) : 'n/a', kpiCluster ? 'hidden 2xl:flex' : 'hidden xl:flex'],
          ] as Array<[string, string, string]>).map(([label, value, cls]) => (
            <div key={label} className={`h-8 px-2.5 flex items-baseline gap-1 whitespace-nowrap pt-[8px] ${cls}`}>
              <span className="font-display text-[15px] leading-none tabular-nums text-text-primary">{value}</span>
              <span className="text-[12px] leading-none text-text-muted">{label}</span>
            </div>
          ))}
        </div>

        {/* Legend: compact and collapsible (collapsed shows the color dots). */}
        <div
          ref={legendRef}
          className={`absolute left-3 bottom-3 w-[260px] max-w-[calc(100%-96px)] flex flex-col ${OVERLAY}`}
          style={{ maxHeight: '44%' }}
          onMouseLeave={() => setLegendHover(null)}
        >
          <button
            type="button"
            onClick={toggleLegend}
            aria-expanded={legendOpen}
            className="h-7 px-2.5 flex items-center gap-2 w-full text-left shrink-0"
            title={legendOpen ? 'Collapse the legend' : 'Show the legend'}
          >
            <span className={`${EYEBROW} truncate`}>{legendTitle}</span>
            {!legendOpen && (
              <span className="flex items-center gap-[3px] shrink-0">
                {layout.clusters.filter(c => visibleIds(c).length || layout.kind === 'funnel').slice(0, 10).map(c => (
                  <span key={c.key} className="w-1.5 h-1.5 rounded-full" style={{ background: c.color }} />
                ))}
              </span>
            )}
            <ChevronDown size={12} className={`ml-auto shrink-0 text-text-muted transition-transform duration-150 ${legendOpen ? '' : '-rotate-90'}`} />
          </button>
          {legendOpen && (
            <div className="overflow-auto border-t border-line px-1 py-1">
              {layout.clusters.map(c => {
                const n = visibleIds(c).length
                if (!n && layout.kind !== 'funnel') return null
                return (
                  <button
                    key={c.key}
                    type="button"
                    onMouseEnter={() => setLegendHover(n ? c.key : null)}
                    // A mouse click drops focus from the row, so no keyboard focus ring stays on it afterwards.
                    onClick={e => { clickGroup(c.key); if (e.detail) e.currentTarget.blur() }}
                    // An empty lane (a stage no ad name carries) has nothing to isolate or show.
                    onContextMenu={e => { e.preventDefault(); if (n) setMenu({ key: c.key, x: e.clientX, y: e.clientY }) }}
                    className={`w-full flex items-center gap-2 px-1.5 py-[3px] rounded-md text-left text-[11px] transition-colors ${
                      (isoCluster ? isoCluster.key : hoveredCluster ? hoveredCluster.key : focusedCluster?.key) === c.key ? 'bg-hover text-text-primary' : 'text-text-secondary hover:text-text-primary'
                    }`}
                    title={!n ? `${c.name}: no creatives in this view`
                      : isoCluster?.key === c.key ? `${c.name}: click to bring every group back, right-click for more`
                      : layout.kind === 'axes' ? `${c.name}: click to spotlight, right-click for more`
                      : `${c.name}: click to fly here, right-click for more`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c.color }} />
                    <span className="flex flex-col min-w-0">
                      <span className="truncate">{c.name}</span>
                      {c.sub && <span className="truncate text-[10px] text-text-muted">{c.sub}</span>}
                    </span>
                    <span className="ml-auto pl-2 flex items-baseline gap-1.5 tabular-nums whitespace-nowrap">
                      <span className="text-[12px] text-text-primary">{n}</span>
                      <span className="text-[12px] text-text-muted w-[54px] text-right">{fmtMoney(c.spend)}</span>
                    </span>
                  </button>
                )
              })}
              {notes.map(t => (
                <div key={t} className="text-[10px] text-text-muted mt-1 px-1.5 leading-snug">{t}</div>
              ))}
            </div>
          )}
        </div>

        {/* The arrangement and axes control, top right (the KPI strip holds the counts). Its frost keeps the
            label clear of the cards passing under it. */}
        <div className="absolute top-3 right-3 ody-frost fv-float-pill">{control}</div>

        {/* Canvas controls, bottom right (Figma / Linear canvas corner). */}
        <div className={`absolute right-3 bottom-3 flex items-center gap-0.5 p-0.5 ${OVERLAY}`}>
          <button type="button" className={BTN_ICON} onClick={() => update({ rotate: !settings.rotate })}
            title={settings.rotate ? 'Pause rotation' : 'Resume rotation'} aria-label={settings.rotate ? 'Pause rotation' : 'Resume rotation'}>
            {settings.rotate ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <span className="w-px h-4 bg-line mx-0.5" aria-hidden="true" />
          <button type="button" className={BTN_ICON} onClick={() => engineRef.current?.resetView()}
            title="Reset view. Drag to orbit, scroll or double-click to zoom in on any card, shift drag to pan." aria-label="Reset view">
            <RotateCcw size={13} />
          </button>
        </div>

        {/* Hover card (filled in imperatively, so moving the mouse never re-renders). */}
        <div
          ref={tipRef}
          className="fv-tip absolute z-10 pointer-events-none bg-surface-overlay rounded-lg border border-line shadow-popover px-3 py-2.5 max-w-[280px]"
          style={{ display: 'none' }}
        >
          <div className="text-[12px] font-medium text-text-primary leading-snug line-clamp-2 break-words" />
          <div className="text-[12px] text-text-muted mt-0.5 truncate" />
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 mt-1.5 pt-1.5 border-t border-line text-[12px]" />
        </div>

        {viewCluster && view?.kind === 'grid' && (
          <GroupGrid name={viewCluster.name} color={viewCluster.color} groupLabel={groupLabel || 'Group'}
            ads={groupAds(viewCluster)} demo={demo} selectedId={selectedId}
            onBack={() => setView(null)} onOpen={onOpen}
            onSlideshow={start => setView({ kind: 'slides', key: viewCluster.key, start })} />
        )}
        {viewCluster && view?.kind === 'slides' && (
          <GroupSlideshow name={viewCluster.name} color={viewCluster.color}
            ads={sortGroupAds(groupAds(viewCluster), 'spend')} demo={demo} startAdId={view.start}
            keysPaused={!!selectedId || !!menu}
            onBack={() => setView(null)} onInspect={onOpen} />
        )}
      </div>
      {menu && menuCluster && (
        <GroupMenu x={menu.x} y={menu.y} name={menuCluster.name} color={menuCluster.color}
          count={visibleIds(menuCluster).length} isolated={isoCluster?.key === menuCluster.key}
          onAction={a => onGroupAction(a, menuCluster.key)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
