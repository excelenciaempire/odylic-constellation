/**
 * Customer segment (Atelier's SegmentMixTile, ported): Meta user_segment_key
 * delivery for the card. The bar is the spend share for New (prospecting),
 * Engaged and Existing (Unknown stays in the bar, never redistributed),
 * straight from the card, so it costs no Meta call and matches the card's
 * funnel position. Under it, one row per picked metric and one column per
 * segment. Spend is on the card too; any other metric (ROAS, CPA,
 * purchases...) reads Meta's segment breakdown for this ad, once, while the
 * tile is open. For a connected account that call waits for one click on
 * "Load results by segment"; after it the tile loads them by itself (the
 * choice is remembered), so nobody pays a Meta call per ad for numbers they
 * never asked to see. The rows are picked in the tile's ChartAxesControl (a
 * metric list with no axes), the control every chart tile uses.
 */
import { useMemo } from 'react'
import type { SpaceAd } from '../../lib/adModel'
import { chartDwell, chartUrl, useChartData, type BreakdownPayload } from '../../lib/adCharts'
import { fmtValue } from '../../lib/format'
import { SEGMENT_LABELS } from '../../lib/metrics'
import { chartRegistry, computeRow, pickedDefs, presentFields, type Row } from './chartMetrics'
import { ChartAxesControl } from './ChartAxesControl'
import { ChartTile, isBool, isKeyList, segmentColor, useChartTheme, usePersisted, useTileOpen, type ChartCtx } from './ChartKit'

type SegKey = 'prospecting' | 'engaged' | 'existing' | 'unknown'
const SEGMENTS: SegKey[] = ['prospecting', 'engaged', 'existing', 'unknown']
/** Column heads are narrow in the drawer: the short name, the full one as the tooltip. */
const SHORT: Record<SegKey, string> = { prospecting: 'New', engaged: 'Engaged', existing: 'Existing', unknown: 'Unknown' }

/** What Meta's segment breakdown returns (clicks come from its CTR). */
const SEGMENT_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach', 'purchases', 'revenue', 'link_clicks', 'landing_page_views',
  'add_to_cart', 'initiate_checkout', 'video_3s_views', 'post_reactions', 'post_comments', 'post_shares',
]

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function SegmentMixTile({ ad, ctx }: { ad: SpaceAd; ctx: ChartCtx }) {
  const theme = useChartTheme()
  const seg = ad.segment_spend
  const total = seg ? SEGMENTS.reduce((t, s) => t + num(seg[s]), 0) : 0
  const [open, setOpen] = useTileOpen('segment', true)
  const [metrics, setMetrics] = usePersisted<string[]>('fv.chart.segment.metrics.v2', ['spend', 'roas', 'cost_per_purchase', 'purchases', 'cpm', 'cost_per_1k_reached', 'frequency'], isKeyList)

  // Spend alone is on the card; anything else asks Meta (once per ad and range): by itself for the demo, or
  // once the viewer has loaded results by segment one time.
  const [auto, setAuto] = usePersisted<boolean>('fv.chart.segment.auto', false, isBool)
  const wantsMeta = open && total > 0 && metrics.some(k => k !== 'spend')
  const needsMeta = wantsMeta && (ctx.demo || auto)
  const { data, error, loading } = useChartData<BreakdownPayload>(
    needsMeta ? chartUrl('segment', ctx.adIds, ctx.range, ctx.demo) : null, chartDwell(ctx.demo))

  const fetched = useMemo(() => {
    if (!data) return null
    const out = Object.fromEntries(SEGMENTS.map(s => [s, {} as Row])) as Record<SegKey, Row>
    for (const r of data.rows) {
      const k = String(r.segment || r.key) as SegKey
      if (SEGMENTS.includes(k)) out[k] = r
    }
    return out
  }, [data])
  const rows = useMemo<Record<SegKey, Row>>(() => fetched ?? {
    prospecting: { spend: num(seg?.prospecting) },
    engaged: { spend: num(seg?.engaged) },
    existing: { spend: num(seg?.existing) },
    unknown: { spend: num(seg?.unknown) },
  }, [fetched, seg])
  const fields = useMemo(
    () => (fetched ? presentFields(SEGMENTS.map(s => fetched[s])) : error ? ['spend'] : SEGMENT_FIELDS),
    [fetched, error],
  )
  const registry = useMemo(() => chartRegistry(fields, ctx.video), [fields, ctx.video])
  const defs = pickedDefs(metrics, registry)
  const values = useMemo(
    () => Object.fromEntries(SEGMENTS.map(s => [s, computeRow([rows[s]], ctx.video)])) as Record<SegKey, Record<string, number | null>>,
    [rows, ctx.video],
  )

  if (total <= 0) return null

  const pctOf = (s: SegKey) => (num(seg?.[s]) / total) * 100
  // Unknown gets a column only when it holds a visible share.
  const cols = SEGMENTS.filter(s => s !== 'unknown' || pctOf('unknown') >= 0.5)
  const bar = SEGMENTS.map(s => ({ s, pct: pctOf(s) })).filter(p => p.pct > 0)
  const pending = (k: string) => k !== 'spend' && !fetched && loading
  const held = (k: string) => k !== 'spend' && !needsMeta

  return (
    <ChartTile title="Customer segment" open={open} onToggle={() => setOpen(!open)}
      hint={`Who ${ctx.adIds.length > 1 ? 'these ads' : 'this ad'} reached (Meta user_segment_key): new people (prospecting), people who engaged with the brand, and existing customers. Share of spend, then the picked metrics per segment. Unknown is spend Meta could not attribute to a segment.`}
      actions={(
        <ChartAxesControl registry={registry} value={{ left: defs.map(d => d.key), right: [] }}
          onChange={next => setMetrics(next.left)} mode="list" leftLabel="Rows"
          title="Metrics per customer segment (everything Meta's segment breakdown resolves)" />
      )}>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-hover" role="img"
        aria-label={bar.map(p => `${SEGMENT_LABELS[p.s]} ${p.pct.toFixed(0)}%`).join(', ')}>
        {bar.map(p => (
          <div key={p.s} style={{ width: `${p.pct}%`, background: segmentColor(theme, p.s) }} title={`${SEGMENT_LABELS[p.s]} ${p.pct.toFixed(0)}%`} />
        ))}
      </div>
      <div className="grid gap-x-2 text-[11px] tabular-nums"
        style={{ gridTemplateColumns: `minmax(64px, 1fr) repeat(${cols.length}, minmax(0, 1fr))` }}
        role="table" aria-label="Metrics by customer segment">
        <div role="columnheader" />
        {cols.map(s => {
          const pct = pctOf(s)
          return (
            <div key={s} role="columnheader" className={`flex flex-col items-end gap-0.5 pb-1.5 min-w-0 ${pct <= 0 ? 'opacity-50' : ''}`}>
              <span className="flex items-center gap-1 text-[9px] uppercase tracking-[0.06em] text-text-muted truncate max-w-full" title={SEGMENT_LABELS[s]}>
                <span className="inline-block h-1.5 w-1.5 rounded-full shrink-0" style={{ background: segmentColor(theme, s) }} />
                <span className="truncate">{SHORT[s]}</span>
              </span>
              <span className="text-[13px] text-text-primary leading-tight font-medium" title="Share of the spend">{pct.toFixed(0)}%</span>
            </div>
          )
        })}
        {defs.map(m => (
          <div key={m.key} role="row" className="contents">
            <div role="rowheader" className="py-1 border-t border-line text-text-muted truncate" title={m.description || m.label}>{m.label}</div>
            {cols.map(s => (
              <div key={s} role="cell" className={`py-1 border-t border-line text-right text-text-primary truncate ${pctOf(s) <= 0 ? 'opacity-50' : ''}`}>
                {held(m.key) ? <span className="text-text-faint">·</span>
                  : pending(m.key) ? <span className="text-text-faint">...</span> : fmtValue(values[s][m.key], m.format)}
              </div>
            ))}
          </div>
        ))}
      </div>
      {!defs.length && <div className="text-[11px] text-text-muted">Pick rows in the menu above.</div>}
      {wantsMeta && !needsMeta && (
        <div className="flex items-center gap-2 text-[10.5px] text-text-muted">
          <button type="button" className="text-text-primary underline underline-offset-2 hover:no-underline" onClick={() => setAuto(true)}>
            Load results by segment
          </button>
          <span>One Meta call per ad, then they load by themselves.</span>
        </div>
      )}
      {error && <div className="text-[10.5px] text-text-muted" title={error.message}>Results by segment could not be loaded, so only spend shows.</div>}
      {data?.note && <div className="text-[10.5px] text-text-muted">{data.note}</div>}
    </ChartTile>
  )
}
