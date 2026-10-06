/**
 * Age and gender (Atelier's DemoBreakdownChart, ported). One Meta call with
 * the age and gender breakdown, made when the tile opens.
 *
 * One metric picked: bars per age bucket split by gender (stacked for
 * metrics that add up, like spend; side by side for rates and ratios like
 * ROAS, which cannot be summed). Several metrics: one bar per metric per age
 * bucket (genders pooled), on the left or right Y axis. All of it is set in
 * the tile's one ChartAxesControl.
 */
import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { chartDwell, chartUrl, useChartData, type BreakdownPayload } from '../../lib/adCharts'
import { fmtAxis, fmtValue } from '../../lib/format'
import { BASE_FIELDS, axisFormat, chartRegistry, computeRow, isAdditive, pickedDefs, presentFields, type Row } from './chartMetrics'
import { LOG_BLOCKED_NOTE, axesMetrics, logBlocked, scaleProps, useStoredAxes } from './axes'
import { ChartAxesControl } from './ChartAxesControl'
import {
  CHART_H, ChartTile, DotLegend, TileState, axisLine, axisTick, barOf, fmtRange, genderColor, gridProps, tooltipProps,
  useChartTheme, useTileOpen, type ChartCtx,
} from './ChartKit'

const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'unknown']
const GENDER_ORDER = ['female', 'male', 'unknown']
const genderLabel = (g: string) => (g === 'unknown' ? 'Unknown' : g.charAt(0).toUpperCase() + g.slice(1))
const ageLabel = (a: string) => (a === 'unknown' ? 'Unknown' : a)
const byOrder = (order: string[]) => (a: string, b: string) => {
  const ai = order.indexOf(a), bi = order.indexOf(b)
  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
}

export function AgeGenderChart({ ctx }: { ctx: ChartCtx }) {
  const theme = useChartTheme()
  const [open, setOpen] = useTileOpen('age', false)
  const { data, error, loading, retry } = useChartData<BreakdownPayload>(
    open ? chartUrl('age_gender', ctx.adIds, ctx.range, ctx.demo) : null, chartDwell(ctx.demo))
  const [saved, setAxes] = useStoredAxes('fv.chart.age.axes', () => ({ left: ['spend'], right: [] }))

  const cross = useMemo(() => (data?.rows || []) as Row[], [data])
  const hasData = useMemo(() => cross.some(r => Number(r.spend) > 0 || Number(r.impressions) > 0), [cross])
  const fields = useMemo(() => (cross.length ? presentFields(cross) : [...BASE_FIELDS]), [cross])
  const registry = useMemo(() => chartRegistry(fields, ctx.video), [fields, ctx.video])
  const axes = { ...saved, left: saved.left.filter(k => !!registry.byKey[k]), right: saved.right.filter(k => !!registry.byKey[k]) }
  const defs = pickedDefs(axesMetrics(axes), registry)

  const ages = useMemo(() => [...new Set(cross.map(r => String(r.age || 'unknown')))].sort(byOrder(AGE_ORDER)), [cross])
  const genders = useMemo(() => [...new Set(cross.map(r => String(r.gender || 'unknown')))].sort(byOrder(GENDER_ORDER)), [cross])

  const split = defs.length === 1
  const single = defs[0]
  const singleKey = single ? single.key : ''
  const stacked = split && !!single && isAdditive(single.key)
  const defsSig = defs.map(d => d.key).join('|')

  const rows = useMemo(() => ages.map(age => {
    const inAge = cross.filter(r => String(r.age || 'unknown') === age)
    const row: Row = { age }
    if (split) {
      for (const g of genders) row[g] = computeRow(inAge.filter(r => String(r.gender || 'unknown') === g), ctx.video)[singleKey] ?? null
    } else {
      const t = computeRow(inAge, ctx.video)
      for (const k of defsSig.split('|')) if (k) row[k] = t[k] ?? null
    }
    return row
  }), [ages, genders, cross, split, singleKey, defsSig, ctx.video])

  // Legend values: each gender's share (a stack) or its value (a ratio).
  const legend = useMemo(() => {
    if (!split) return defs.map((m, i) => ({ key: m.key, label: m.label, color: barOf(theme, i) }))
    const byGender = genders.map(g => ({ g, v: computeRow(cross.filter(r => String(r.gender || 'unknown') === g), ctx.video)[singleKey] }))
    const total = byGender.reduce((s, x) => s + Number(x.v || 0), 0)
    return byGender.map(({ g, v }) => ({
      key: g,
      label: genderLabel(g),
      color: genderColor(theme, g),
      value: stacked ? (total > 0 ? `${Math.round((Number(v || 0) / total) * 100)}%` : undefined) : fmtValue(v, single?.format),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split, defsSig, genders, cross, singleKey, stacked, theme, ctx.video])

  const rightKeys = split ? [] : defs.filter(m => axes.right.includes(m.key)).map(m => m.key)
  const leftDefs = split ? defs : defs.filter(m => !rightKeys.includes(m.key))
  const rightDefs = defs.filter(m => rightKeys.includes(m.key))
  const symbols = axes.symbols !== false
  const leftValues = rows.flatMap(r => (split
    ? (stacked ? [genders.reduce((t, g) => t + Number(r[g] || 0), 0)] : genders.map(g => r[g]))
    : leftDefs.map(m => r[m.key])))
  const rightValues = rows.flatMap(r => rightKeys.map(k => r[k]))
  const color = (k: string) => barOf(theme, Math.max(0, defs.findIndex(d => d.key === k)))

  const actions = (
    <ChartAxesControl registry={registry} value={axes} onChange={setAxes}
      x={{ value: 'Age', title: 'One group of bars per age bucket. One metric splits each age by gender; several metrics pool genders.' }}
      options={{ scale: true, symbols: true }}
      scaleNote={logBlocked(axes.scale, [...leftValues, ...rightValues]) ? LOG_BLOCKED_NOTE : undefined}
      colorOf={split ? undefined : color}
      title="Metrics for the age and gender breakdown" />
  )

  let body
  if (loading) body = <TileState kind="loading" />
  else if (error) body = <TileState kind="error" title={error.message} onRetry={retry}>{error.message || 'Could not load the breakdown'}</TileState>
  else if (!hasData) body = ctx.spend > 0
    ? <TileState kind="empty" title={`Meta returned no age or gender rows for ${fmtRange(ctx.range.since, ctx.range.until)}`}>No age or gender data</TileState>
    : <TileState kind="empty">No spend in this period</TileState>
  else if (!defs.length) body = <TileState kind="empty">Pick a metric</TileState>
  else body = (
    <>
      <div style={{ height: CHART_H }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: rightDefs.length ? 0 : 4, left: 0, bottom: 0 }} barGap={4}>
            <CartesianGrid {...gridProps(theme)} vertical={false} />
            <XAxis dataKey="age" tick={axisTick(theme)} tickLine={false} axisLine={axisLine(theme)} tickFormatter={(v: unknown) => ageLabel(String(v))} />
            <YAxis yAxisId="L" width={46} tick={axisTick(theme)} tickLine={false} axisLine={false}
              tickFormatter={(v: unknown) => fmtAxis(v, axisFormat(leftDefs), symbols)} {...scaleProps(axes.scale, leftValues)} />
            {rightDefs.length > 0 && (
              <YAxis yAxisId="R" orientation="right" width={42} tick={axisTick(theme)} tickLine={false} axisLine={false}
                tickFormatter={(v: unknown) => fmtAxis(v, axisFormat(rightDefs), symbols)} {...scaleProps(axes.scale, rightValues)} />
            )}
            <Tooltip {...tooltipProps(theme)} cursor={theme.cursorBand}
              labelFormatter={(l: unknown) => `Age ${ageLabel(String(l))}`}
              formatter={(v: unknown, name: unknown) => {
                if (split) return [fmtValue(v, single?.format), genderLabel(String(name))]
                const def = registry.byKey[String(name)]
                return [fmtValue(v, def?.format), def?.label || String(name)]
              }} />
            {split
              ? genders.map((g, i) => (
                  <Bar key={g} yAxisId="L" dataKey={g} stackId={stacked ? 'g' : undefined} fill={genderColor(theme, g)}
                    radius={stacked ? (i === genders.length - 1 ? [3, 3, 0, 0] : 0) : [3, 3, 0, 0]}
                    maxBarSize={stacked ? 24 : 12} isAnimationActive={false} />
                ))
              : defs.map(m => (
                  <Bar key={m.key} yAxisId={rightKeys.includes(m.key) ? 'R' : 'L'} dataKey={m.key} fill={color(m.key)}
                    radius={[3, 3, 0, 0]} maxBarSize={12} isAnimationActive={false} />
                ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <DotLegend items={legend} />
      {data?.note && <div className="text-[10.5px] text-text-muted">{data.note}</div>}
    </>
  )

  return (
    <ChartTile title="Age × gender" open={open} onToggle={() => setOpen(!open)} actions={actions}
      hint={`Meta's age and gender breakdown for ${ctx.adIds.length > 1 ? `the ${ctx.adIds.length} ads that run this creative` : 'this ad'}, ${fmtRange(ctx.range.since, ctx.range.until)}. One metric splits each age by gender; several metrics pool genders.`}>
      {body}
    </ChartTile>
  )
}
