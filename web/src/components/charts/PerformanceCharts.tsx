/**
 * By day, Placements and Video retention: Atelier's ad detail charts
 * (ads/PerformanceCharts.tsx), ported to the drawer. Each tile asks for its
 * data only while open, and each takes one ChartAxesControl: its metric
 * pickers (the catalog, limited to what the rows resolve) put metrics on
 * either axis, and the same panel holds the scale, $ and % ticks, the daily
 * chart's trend line and moving averages, and the placements' rows and
 * "Show as" choices.
 */
import { useId, useMemo } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { chartDwell, chartUrl, useChartData, type BreakdownPayload, type CurvePayload, type DailyPayload } from '../../lib/adCharts'
import { fmtAxis, fmtCell, fmtValue } from '../../lib/format'
import {
  BASE_FIELDS, axisFormat, chartRegistry, computeRow, pickedDefs, presentFields, type Row,
} from './chartMetrics'
import {
  LOG_BLOCKED_NOTE, TREND_DASH, axesMetrics, leastSquares, logBlocked, movingAverage, scaleProps, smaDash, useStoredAxes,
  type ChartAxes,
} from './axes'
import { AxisSection } from '../../ui/AxesControl'
import { ChartAxesControl, ChoiceRows } from './ChartAxesControl'
import {
  CHART_H, ChartTile, DotLegend, TileState, axisLine, axisTick, barOf, fmtDay, fmtRange, gridProps, lineOf, lineWidthOf,
  tooltipProps, useChartTheme, usePersisted, useTileOpen, type ChartCtx,
} from './ChartKit'

const finiteOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Saved picks the registry can resolve. */
const resolvable = (saved: ChartAxes, byKey: Record<string, unknown>): ChartAxes => ({
  ...saved,
  left: saved.left.filter(k => !!byKey[k]),
  right: saved.right.filter(k => !!byKey[k]),
})

/** The error text for a tile, plus Meta's pause time when there is one. */
const errorText = (e: Error | null) => (e ? e.message : '')

/** A note under a chart (saved data while Meta is paused). */
function Note({ text }: { text: string | null | undefined }) {
  return text ? <div className="text-[10.5px] text-text-muted">{text}</div> : null
}

// --- By day ------------------------------------------------------------------

const DAILY_SMA = [7, 14, 30] as const

/**
 * The ad's day-by-day series in the tile and control the breakdowns use:
 * every catalog metric the day rows resolve, on a left and a right Y axis,
 * with scale, trend line and moving averages. Spend and ROAS until the user
 * picks others.
 */
export function DailyChart({ ctx }: { ctx: ChartCtx }) {
  const theme = useChartTheme()
  const [open, setOpen] = useTileOpen('daily', true)
  const { data, error, loading, retry } = useChartData<DailyPayload>(
    open ? chartUrl('daily', ctx.adIds, ctx.range, ctx.demo) : null, chartDwell(ctx.demo))
  const [saved, setAxes] = useStoredAxes('fv.chart.daily.axes', () => ({ left: ['spend'], right: ['roas'] }))

  const days = useMemo(() => (data?.days || []).filter(d => typeof d.date === 'string' && d.date), [data])
  const fields = useMemo(() => (days.length ? presentFields(days) : [...BASE_FIELDS]), [days])
  const registry = useMemo(() => chartRegistry(fields, ctx.video), [fields, ctx.video])
  const axes = resolvable(saved, registry.byKey)
  const keys = axesMetrics(axes)
  const leftDefs = pickedDefs(axes.left, registry)
  const rightDefs = pickedDefs(axes.right, registry)
  const symbols = axes.symbols !== false
  const sma = axes.sma || []
  const color = (k: string) => lineOf(theme, Math.max(0, keys.indexOf(k)))
  const width = (k: string) => lineWidthOf(theme, Math.max(0, keys.indexOf(k)))

  const base = useMemo(() => days.map(d => ({ ...computeRow([d], ctx.video), date: d.date }) as Row), [days, ctx.video])
  // Trend and moving-average overlays, as `${key}::trend` and `${key}::sma${n}`.
  const rows = base.map(r => ({ ...r }))
  for (const k of keys) {
    const ys = rows.map(r => finiteOrNull(r[k]))
    if (axes.trend) leastSquares(ys).forEach((y, i) => { rows[i][`${k}::trend`] = y })
    for (const w of sma) movingAverage(ys, w).forEach((y, i) => { rows[i][`${k}::sma${w}`] = y })
  }
  const values = (ks: string[]) => rows.flatMap(r => ks.map(k => r[k]))

  const seriesName = (dataKey: string) => {
    const [k, overlay] = dataKey.split('::')
    const label = registry.byKey[k]?.label || k
    if (!overlay) return label
    return overlay === 'trend' ? `${label}, trend` : `${label}, ${overlay.replace('sma', '')}-day average`
  }

  const actions = (
    <ChartAxesControl registry={registry} value={axes} onChange={setAxes}
      x={{ value: 'Date' }}
      options={{ scale: true, trend: true, sma: DAILY_SMA, symbols: true }}
      scaleNote={logBlocked(axes.scale, values(keys)) ? LOG_BLOCKED_NOTE : undefined}
      colorOf={color}
      title="Metrics for the daily chart" />
  )

  let body
  if (loading) body = <TileState kind="loading" />
  else if (error) body = <TileState kind="error" title={errorText(error)} onRetry={retry}>{errorText(error) || 'Could not load daily data'}</TileState>
  else if (!days.length) body = ctx.spend > 0
    ? (
      <TileState kind="empty" title={`Meta returned no per-day rows for ${fmtRange(ctx.range.since, ctx.range.until)}. It often leaves them out while attribution is still processing.`}>
        No daily data
      </TileState>
    )
    : <TileState kind="empty">No spend in this period</TileState>
  else if (!keys.length) body = <TileState kind="empty">Pick a metric</TileState>
  else body = (
    <>
      <div style={{ height: CHART_H }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps(theme)} vertical={false} />
            <XAxis dataKey="date" tickFormatter={fmtDay} tick={axisTick(theme)} tickLine={false} axisLine={axisLine(theme)} minTickGap={16} />
            <YAxis yAxisId="L" width={46} tick={axisTick(theme)} tickLine={false} axisLine={false}
              tickFormatter={(v: unknown) => fmtAxis(v, axisFormat(leftDefs), symbols)} {...scaleProps(axes.scale, values(axes.left))} />
            {rightDefs.length > 0 && (
              <YAxis yAxisId="R" orientation="right" width={42} tick={axisTick(theme)} tickLine={false} axisLine={false}
                tickFormatter={(v: unknown) => fmtAxis(v, axisFormat(rightDefs), symbols)} {...scaleProps(axes.scale, values(axes.right))} />
            )}
            <Tooltip {...tooltipProps(theme)} cursor={theme.cursorLine}
              labelFormatter={(l: unknown) => fmtDay(l)}
              formatter={(v: unknown, _name: unknown, item: { dataKey?: unknown }) => {
                const dataKey = String(item?.dataKey ?? '')
                return [fmtValue(v, registry.byKey[dataKey.split('::')[0]]?.format), seriesName(dataKey)]
              }} />
            {(['L', 'R'] as const).flatMap(side => (side === 'L' ? axes.left : axes.right).flatMap(k => [
              <Line key={k} yAxisId={side} dataKey={k} stroke={color(k)} strokeWidth={width(k)} strokeLinecap="round"
                dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />,
              ...(axes.trend ? [
                <Line key={`${k}::trend`} yAxisId={side} type="linear" dataKey={`${k}::trend`} stroke={color(k)} strokeWidth={1.25}
                  strokeDasharray={TREND_DASH} strokeOpacity={0.8} dot={false} activeDot={false} isAnimationActive={false} />,
              ] : []),
              ...sma.map(w => (
                <Line key={`${k}::sma${w}`} yAxisId={side} dataKey={`${k}::sma${w}`} stroke={color(k)} strokeWidth={1.25}
                  strokeDasharray={smaDash(w)} strokeOpacity={0.8} dot={false} activeDot={false} isAnimationActive={false} />
              )),
            ]))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {keys.length > 1 && (
        <DotLegend items={keys.map(k => ({
          key: k,
          label: axes.right.includes(k) ? `${registry.byKey[k]?.label || k} (right axis)` : registry.byKey[k]?.label || k,
          color: color(k),
        }))} />
      )}
      <Note text={data?.note} />
    </>
  )

  return (
    <ChartTile title="By day" open={open} onToggle={() => setOpen(!open)} actions={actions}
      hint={`${ctx.adIds.length > 1 ? `The ${ctx.adIds.length} ads that run this creative, added up per day` : "This ad's daily values"}, ${fmtRange(ctx.range.since, ctx.range.until)}. Each day's ratios use that day's own counts.`}>
      {body}
    </ChartTile>
  )
}

// --- Placements, platforms and devices --------------------------------------

type RowsDim = 'placement' | 'platform' | 'device'
const ROW_CHOICES: { value: RowsDim; label: string }[] = [
  { value: 'placement', label: 'Placement' },
  { value: 'platform', label: 'Platform' },
  { value: 'device', label: 'Device' },
]
const ROW_TITLES: Record<RowsDim, string> = { placement: 'Placements', platform: 'Platforms', device: 'Devices' }
const isRowsDim = (v: unknown): v is RowsDim => v === 'placement' || v === 'platform' || v === 'device'

type View = 'chart' | 'table'
const VIEW_CHOICES: { value: View; label: string }[] = [
  { value: 'chart', label: 'Bar chart' },
  { value: 'table', label: 'Table' },
]
const isView = (v: unknown): v is View => v === 'chart' || v === 'table'

type TickLine = { top: string; sub: string | null }

/** Category tick: the position on top, the platform under it (one line for platforms and devices). */
function RowTick(props: { x?: number; y?: number; payload?: { value?: unknown }; lookup: Record<string, TickLine>; ink: string; muted: string }) {
  const { x = 0, y = 0, payload, lookup, ink, muted } = props
  const info = lookup[String(payload?.value ?? '')]
  if (!info) return null
  return (
    <g transform={`translate(${x},${y})`}>
      {info.sub ? (
        <>
          <text x={-6} y={-1} textAnchor="end" fontSize={10} fill={ink}>{info.top}</text>
          <text x={-6} y={10} textAnchor="end" fontSize={9} fill={muted}>{info.sub}</text>
        </>
      ) : (
        <text x={-6} y={4} textAnchor="end" fontSize={10} fill={ink}>{info.top}</text>
      )}
    </g>
  )
}

/**
 * Where the ad ran: Meta's publisher platform and position (or platform, or
 * device) as horizontal bars or a table, sorted by the first picked metric.
 */
export function PlacementChart({ ctx }: { ctx: ChartCtx }) {
  const theme = useChartTheme()
  const [open, setOpen] = useTileOpen('placement', false)
  const [dim, setDim] = usePersisted<RowsDim>('fv.chart.placement.rows', 'placement', isRowsDim)
  const [view, setView] = usePersisted<View>('fv.chart.placement.view', 'chart', isView)
  const { data, error, loading, retry } = useChartData<BreakdownPayload>(
    open ? chartUrl(dim, ctx.adIds, ctx.range, ctx.demo) : null, chartDwell(ctx.demo))
  const [saved, setAxes] = useStoredAxes('fv.chart.placement.axes', () => ({ left: ['spend'], right: ['roas'] }))

  const live = useMemo(() => (data?.rows || []).filter(r => Number(r.spend) > 0 || Number(r.impressions) > 0), [data])
  const fields = useMemo(() => (live.length ? presentFields(live) : [...BASE_FIELDS]), [live])
  const registry = useMemo(() => chartRegistry(fields, ctx.video), [fields, ctx.video])
  const axes = resolvable(saved, registry.byKey)
  const defs = pickedDefs(axesMetrics(axes), registry)
  const sortKey = defs[0] ? defs[0].key : 'spend'

  const rows = useMemo(() => {
    const out = live.map(r => ({
      ...computeRow([r], ctx.video),
      key: String(r.key),
      top: String((dim === 'placement' ? r.position_label : r.label) ?? r.key),
      sub: dim === 'placement' ? String(r.platform_label ?? '') || null : null,
    }) as Row & { key: string; top: string; sub: string | null })
    // Biggest first; rows with no value for the sort metric go to the end.
    return out.sort((a, b) => {
      const av = finiteOrNull(a[sortKey]), bv = finiteOrNull(b[sortKey])
      if (av == null && bv == null) return Number(b.spend || 0) - Number(a.spend || 0)
      if (av == null) return 1
      if (bv == null) return -1
      return bv - av
    })
  }, [live, sortKey, dim, ctx.video])
  const lookup = useMemo(() => Object.fromEntries(rows.map(r => [r.key, { top: r.top, sub: r.sub }])), [rows])

  const rightKeys = defs.filter(m => axes.right.includes(m.key)).map(m => m.key)
  const leftDefs = defs.filter(m => !rightKeys.includes(m.key))
  const rightDefs = defs.filter(m => rightKeys.includes(m.key))
  const symbols = axes.symbols !== false
  const values = (ks: string[]) => rows.flatMap(r => ks.map(k => r[k]))
  const color = (k: string) => barOf(theme, Math.max(0, defs.findIndex(d => d.key === k)))
  const barSize = 10
  const rowH = 14 + 10 * Math.max(1, defs.length)
  const chartH = Math.max(120, rows.length * rowH + (leftDefs.length ? 24 : 0) + (rightDefs.length ? 24 : 0))
  const title = ROW_TITLES[dim]

  const actions = (
    <ChartAxesControl registry={registry} value={axes} onChange={setAxes}
      x={{
        label: 'Rows',
        title: 'One bar per placement (platform and position), per platform, or per device.',
        picker: <ChoiceRowsPicker value={dim} onChange={setDim} />,
      }}
      leftLabel="Bottom axis" rightLabel="Top axis"
      options={{ scale: true, symbols: true }}
      scaleNote={logBlocked(axes.scale, values(defs.map(m => m.key))) ? LOG_BLOCKED_NOTE : undefined}
      colorOf={color}
      title={`Metrics for the ${title.toLowerCase()} breakdown`}
      extra={(
        <AxisSection label="Show as">
          <ChoiceRows<View> ariaLabel="Show as" options={VIEW_CHOICES} value={view} onChange={setView} />
        </AxisSection>
      )} />
  )

  let body
  if (loading) body = <TileState kind="loading" />
  else if (error) body = <TileState kind="error" title={errorText(error)} onRetry={retry}>{errorText(error) || `Could not load ${title.toLowerCase()}`}</TileState>
  else if (!rows.length) body = ctx.spend > 0
    ? <TileState kind="empty" title={`Meta returned no rows for ${fmtRange(ctx.range.since, ctx.range.until)}`}>No {title.toLowerCase()} data</TileState>
    : <TileState kind="empty">No spend in this period</TileState>
  else if (!defs.length) body = <TileState kind="empty">Pick a metric</TileState>
  else if (view === 'table') body = (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-text-muted text-[10px] uppercase tracking-[0.06em]">
            <th className="text-left py-1.5 px-1 font-medium">{ROW_CHOICES.find(c => c.value === dim)?.label}</th>
            {defs.map(m => <th key={m.key} className="text-right py-1.5 px-1 font-medium whitespace-nowrap">{m.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className="border-t border-line hover:bg-hover">
              <td className="py-1.5 px-1 min-w-0" title={r.key}>
                <div className="text-text-primary leading-tight">{r.top}</div>
                {r.sub && <div className="text-[10px] text-text-muted leading-tight">{r.sub}</div>}
              </td>
              {defs.map(m => (
                <td key={m.key} className="text-right px-1 tabular-nums text-text-secondary whitespace-nowrap">{fmtCell(r[m.key], m.format)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  else body = (
    <>
      <div style={{ height: chartH }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }} barGap={2}>
            <CartesianGrid {...gridProps(theme)} horizontal={false} />
            {leftDefs.length > 0 && (
              <XAxis xAxisId="L" type="number" orientation="bottom" tick={axisTick(theme)} tickLine={false} axisLine={axisLine(theme)}
                tickFormatter={(v: unknown) => fmtAxis(v, axisFormat(leftDefs), symbols)} {...scaleProps(axes.scale, values(leftDefs.map(m => m.key)))} />
            )}
            {rightDefs.length > 0 && (
              <XAxis xAxisId="R" type="number" orientation="top" tick={axisTick(theme)} tickLine={false} axisLine={axisLine(theme)}
                tickFormatter={(v: unknown) => fmtAxis(v, axisFormat(rightDefs), symbols)} {...scaleProps(axes.scale, values(rightKeys))} />
            )}
            <YAxis type="category" dataKey="key" width={dim === 'placement' ? 104 : 96} interval={0} tickLine={false} axisLine={false}
              tick={<RowTick lookup={lookup} ink={theme.ink} muted={theme.inkMuted} />} />
            <Tooltip {...tooltipProps(theme)} cursor={theme.cursorBand}
              labelFormatter={(l: unknown) => {
                const info = lookup[String(l)]
                return info ? (info.sub ? `${info.sub} ${info.top}` : info.top) : String(l)
              }}
              formatter={(v: unknown, name: unknown) => {
                const def = registry.byKey[String(name)]
                return [fmtValue(v, def?.format), def?.label || String(name)]
              }} />
            {defs.map(m => (
              <Bar key={m.key} dataKey={m.key} xAxisId={rightKeys.includes(m.key) ? 'R' : 'L'}
                fill={color(m.key)} radius={[0, 3, 3, 0]} maxBarSize={barSize} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {defs.length > 1 && (
        <DotLegend items={defs.map(m => ({
          key: m.key,
          label: rightKeys.includes(m.key) ? `${m.label} (top axis)` : m.label,
          color: color(m.key),
        }))} />
      )}
    </>
  )

  return (
    <ChartTile title={title} open={open} onToggle={() => setOpen(!open)} actions={actions}
      hint={`Meta's ${dim === 'placement' ? 'platform and position' : dim} breakdown for ${ctx.adIds.length > 1 ? `the ${ctx.adIds.length} ads that run this creative` : 'this ad'}, sorted by ${defs[0]?.label || 'spend'}.`}>
      {body}
      {open && <Note text={data?.note} />}
    </ChartTile>
  )
}

/** The Rows choice inside the control's X section. */
function ChoiceRowsPicker({ value, onChange }: { value: RowsDim; onChange: (v: RowsDim) => void }) {
  return (
    <div className="flex items-center gap-1">
      {ROW_CHOICES.map(c => (
        <button key={c.value} type="button" aria-pressed={c.value === value} onClick={() => onChange(c.value)}
          className={`h-6 px-2 rounded-full text-[10.5px] transition-colors ${c.value === value
            ? 'bg-select border border-select-line text-text-primary'
            : 'glass glass-hover text-text-secondary'}`}>
          {c.label}
        </button>
      ))}
    </div>
  )
}

// --- Video retention -----------------------------------------------------------

/**
 * Meta's retention curve: the share of plays still watching at each point of
 * the video. Seconds 0 to 15 one by one, then Meta's ranges (15 to 20, 20 to
 * 25, 25 to 30, 30 to 40, 40 to 50, 50 to 60 and over 60 seconds).
 */
export function RetentionChart({ ctx }: { ctx: ChartCtx }) {
  const theme = useChartTheme()
  const [open, setOpen] = useTileOpen('retention', false)
  const { data, error, loading, retry } = useChartData<CurvePayload>(
    open ? chartUrl('video-curve', ctx.adIds, ctx.range, ctx.demo) : null, chartDwell(ctx.demo))
  const gradId = `fvRetention-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  const points = data?.points || []
  const hold3 = points.find(p => p.second === 3)?.pct
  const color = lineOf(theme, 0)

  let body
  if (loading) body = <TileState kind="loading" />
  else if (error) body = <TileState kind="error" title={errorText(error)} onRetry={retry}>{errorText(error) || 'Could not load retention'}</TileState>
  else if (!points.length) body = (
    <TileState kind="empty" title="Meta publishes a retention curve once a video clears its minimum view threshold">
      No retention curve yet
    </TileState>
  )
  else body = (
    <div style={{ height: CHART_H }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={theme.dark ? 0.32 : 0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid {...gridProps(theme)} vertical={false} />
          <XAxis dataKey="label" tick={axisTick(theme)} tickLine={false} axisLine={axisLine(theme)} minTickGap={10} />
          <YAxis width={38} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={axisTick(theme)} tickLine={false} axisLine={false}
            tickFormatter={(v: unknown) => `${v}%`} />
          <Tooltip {...tooltipProps(theme)} cursor={theme.cursorLine}
            labelFormatter={(l: unknown) => `At ${l}`}
            formatter={(v: unknown) => [`${Number(v).toFixed(0)}%`, 'Still watching']} />
          <Area type="monotone" dataKey="pct" stroke={color} strokeWidth={theme.hero} strokeLinecap="round" fill={`url(#${gradId})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )

  return (
    <ChartTile title="Video retention" open={open} onToggle={() => setOpen(!open)}
      hint="Share of plays still watching at each second of the video. 3s hold is the share still watching at 0:03."
      aside={hold3 !== undefined && !loading ? (
        <div className="ml-auto text-[10px] text-text-muted tabular-nums whitespace-nowrap">
          3s hold <span className="text-text-primary font-medium">{hold3.toFixed(0)}%</span>
        </div>
      ) : undefined}>
      {body}
      {open && <Note text={data?.note} />}
    </ChartTile>
  )
}
