/**
 * Chart axes, ported from Atelier's charts/axes.ts: the one model behind
 * every chart tile's control (ChartAxesControl). A chart's axes are the
 * metrics on the left Y axis, the metrics on the right Y axis and the
 * display options: scale, trend line, moving averages, $ and % on the ticks.
 *
 * Rules that live here so every tile follows them:
 *   - Two units, two axes. A new metric joins the axis that already shows
 *     its unit, else the empty right axis (placeByUnit).
 *   - The left axis is never empty while the right one has metrics.
 *   - Log scale needs values above zero; a series that touches zero falls
 *     back to a fitted linear scale (scaleProps).
 */
import { useCallback, useState } from 'react'
import type { MetricFormat } from '../../lib/metrics'

export type AxisSide = 'left' | 'right'

/** linear = from zero (default), auto = fitted to the data, log = logarithmic. */
export type AxisScale = 'linear' | 'auto' | 'log'

export interface ChartAxes {
  /** Metric keys on the left Y axis (the bottom axis on horizontal bars), in series order. */
  left: string[]
  /** Metric keys on the right Y axis (the top axis on horizontal bars). */
  right: string[]
  scale?: AxisScale
  /** $ and % on axis ticks. Default on. */
  symbols?: boolean
  /** Least-squares trend line per series (time series). */
  trend?: boolean
  /** Moving-average windows in days (time series). */
  sma?: number[]
}

export const EMPTY_AXES: ChartAxes = { left: [], right: [] }

/** Dash pattern per moving-average window (drawn in the series colour). */
export function smaDash(win: number): string {
  if (win <= 7) return '2 3'
  if (win <= 14) return '4 3'
  if (win <= 30) return '6 3'
  return '9 4'
}

/** Dash for least-squares trend lines. */
export const TREND_DASH = '5 4'

/* ── Metric placement ─────────────────────────────────────────────────── */

export type FormatOf = (key: string) => MetricFormat | string | undefined

/** Every metric on either axis: left first, then right. */
export function axesMetrics(a: Pick<ChartAxes, 'left' | 'right'>): string[] {
  return [...a.left, ...a.right]
}

function normalizeSides(left: string[], right: string[]): { left: string[]; right: string[] } {
  if (!left.length && right.length) return { left: right, right: [] }
  return { left, right }
}

/**
 * Put `keys` on the two axes. Keys already on a side keep it; each new key
 * joins the side that already shows its unit, else the empty right axis, so
 * two units always get two axes. A third unit shares the right axis.
 */
export function placeByUnit(keys: string[], prev: Pick<ChartAxes, 'left' | 'right'>, formatOf: FormatOf): { left: string[]; right: string[] } {
  const uniq = keys.filter((k, i) => !!k && keys.indexOf(k) === i)
  const left = new Set<string>()
  const right = new Set<string>()
  for (const k of uniq) {
    if (prev.right.includes(k)) right.add(k)
    else if (prev.left.includes(k)) left.add(k)
  }
  const unitsOf = (set: Set<string>) => new Set([...set].map(k => formatOf(k)))
  for (const k of uniq) {
    if (left.has(k) || right.has(k)) continue
    const f = formatOf(k)
    if (!left.size || unitsOf(left).has(f)) left.add(k)
    else right.add(k)
  }
  return normalizeSides(uniq.filter(k => left.has(k)), uniq.filter(k => right.has(k)))
}

/** Replace one side's metrics; keys taken from the other side move over. */
export function withSide(a: ChartAxes, side: AxisSide, keys: string[]): ChartAxes {
  const uniq = keys.filter((k, i) => !!k && keys.indexOf(k) === i)
  const other = side === 'left' ? 'right' : 'left'
  const next: ChartAxes = { ...a, [side]: uniq, [other]: a[other].filter(k => !uniq.includes(k)) }
  return { ...next, ...normalizeSides(next.left, next.right) }
}

/** Move one metric to the other axis. */
export function moveMetric(a: ChartAxes, key: string, to: AxisSide): ChartAxes {
  const from = to === 'left' ? 'right' : 'left'
  if (!a[from].includes(key)) return a
  const next: ChartAxes = { ...a, [from]: a[from].filter(k => k !== key), [to]: [...a[to], key] }
  return { ...next, ...normalizeSides(next.left, next.right) }
}

export function removeMetric(a: ChartAxes, key: string): ChartAxes {
  return { ...a, ...normalizeSides(a.left.filter(k => k !== key), a.right.filter(k => k !== key)) }
}

/** "Spend · ROAS": left metrics, then right metrics; "Pick metrics" when empty. */
export function axesSummary(a: ChartAxes, labelOf: (k: string) => string): string {
  const list = (keys: string[]) => {
    const names = keys.slice(0, 2).map(labelOf)
    return names.join(', ') + (keys.length > 2 ? ` +${keys.length - 2}` : '')
  }
  if (!a.left.length && !a.right.length) return 'Pick metrics'
  return a.right.length ? `${list(a.left)} · ${list(a.right)}` : list(a.left)
}

/* ── Value-axis scale ─────────────────────────────────────────────────── */

function positivity(values: Iterable<unknown>): { any: boolean; nonPositive: boolean } {
  let any = false
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    if (n <= 0) return { any: true, nonPositive: true }
    any = true
  }
  return { any, nonPositive: false }
}

export type ScaleProps = { scale: 'auto' | 'log'; domain: [number | string, number | string] }

/** Recharts value-axis props: linear from zero, fitted to the data, or log when every value is above zero. */
export function scaleProps(scale: AxisScale | undefined, values: Iterable<unknown>): ScaleProps {
  const p = positivity(values)
  if (scale === 'log' && p.any && !p.nonPositive) return { scale: 'log', domain: ['auto', 'auto'] }
  if (scale === 'log' || scale === 'auto') return { scale: 'auto', domain: ['auto', 'auto'] }
  return { scale: 'auto', domain: [0, 'auto'] }
}

/** True when log scale was asked for but a value is at or below zero. */
export function logBlocked(scale: AxisScale | undefined, values: Iterable<unknown>): boolean {
  return scale === 'log' && positivity(values).nonPositive
}

export const LOG_BLOCKED_NOTE = 'Log needs values above zero, so this chart uses a fitted scale.'

/* ── Series math ──────────────────────────────────────────────────────── */

/** Least-squares line over evenly spaced points (time series). */
export function leastSquares(ys: Array<number | null>): Array<number | null> {
  const pts = ys.map((y, i) => [i, y] as const).filter(([, y]) => y !== null) as Array<readonly [number, number]>
  if (pts.length < 2) return ys.map(() => null)
  let sx = 0, sy = 0, sxy = 0, sxx = 0
  for (const [x, y] of pts) { sx += x; sy += y; sxy += x * y; sxx += x * x }
  const n = pts.length
  const den = n * sxx - sx * sx
  const slope = den ? (n * sxy - sx * sy) / den : 0
  const icpt = (sy - slope * sx) / n
  return ys.map((_, i) => slope * i + icpt)
}

/** Trailing simple moving average; null until the window fills. */
export function movingAverage(ys: Array<number | null>, win: number): Array<number | null> {
  return ys.map((_, i) => {
    if (i < win - 1) return null
    let s = 0, n = 0
    for (let j = i - win + 1; j <= i; j++) {
      const v = ys[j]
      if (v !== null && v !== undefined) { s += v; n++ }
    }
    return n ? s / n : null
  })
}

/* ── Saved axes ───────────────────────────────────────────────────────── */

const keyList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && k.length > 0) : []

/** Validate a saved blob into ChartAxes. */
export function sanitizeAxes(raw: unknown): ChartAxes | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const left = keyList(r.left).filter((k, i, a) => a.indexOf(k) === i)
  const right = keyList(r.right).filter((k, i, a) => a.indexOf(k) === i && !left.includes(k))
  const out: ChartAxes = { left, right }
  if (r.scale === 'linear' || r.scale === 'auto' || r.scale === 'log') out.scale = r.scale
  if (typeof r.symbols === 'boolean') out.symbols = r.symbols
  if (typeof r.trend === 'boolean') out.trend = r.trend
  if (Array.isArray(r.sma)) {
    const w = r.sma.map(Number).filter(n => Number.isFinite(n) && n >= 2 && n <= 365).map(Math.round)
    if (w.length) out.sma = [...new Set(w)].sort((a, b) => a - b)
  }
  return out
}

/** Axes kept in localStorage under `key` (the default until the user changes them). */
export function useStoredAxes(key: string, initial: () => ChartAxes): [ChartAxes, (next: ChartAxes) => void] {
  const [axes, setAxesState] = useState<ChartAxes>(() => {
    try {
      const saved = sanitizeAxes(JSON.parse(localStorage.getItem(key) || 'null'))
      if (saved && (saved.left.length || saved.right.length)) return saved
    } catch { /* storage off */ }
    return initial()
  })
  const setAxes = useCallback((next: ChartAxes) => {
    setAxesState(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* storage off */ }
  }, [key])
  return [axes, setAxes]
}
