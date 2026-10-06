/**
 * ChartKit: the tile surface, states, legend and house chart style shared by
 * the drawer's chart tiles (ported from Atelier's BreakdownKit,
 * widgets/chartStyle and ui/odylic/series).
 *
 * The look follows Atelier's charts on the Odylic ground (its odylic.css
 * "chart series" and "Recharts on glass"): one rust series first, then steps
 * of the ground's ink (cream by night, charcoal by day) that repeat, so the
 * rust never comes back; hairline grid, ticks in near-full ink, the base line
 * on the axis, a solid tooltip (charcoal by night, paper by day), the hero
 * line 2px and the others 1.5px, a dashed crosshair (ODY_CHART). Off the
 * ground (no `ody-scope` on <html>) the classic house palette applies.
 *
 * SVG colours are resolved to plain values for the look on screen
 * (useChartTheme): a CSS variable inside an SVG attribute is not drawn by
 * every browser.
 */
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { ChartRange } from '../../lib/adCharts'
import { CHART_PALETTE, TILE_FLAT } from '../../ui/theme'

/** What every tile needs to know about the card it charts. */
export type ChartCtx = {
  /** The card's ad first, then the other ads that run its creative. */
  adIds: string[]
  range: ChartRange
  demo: boolean
  video: boolean
  /** The card's spend in the range (picks the empty-state wording). */
  spend: number
}

/* ── Theme ────────────────────────────────────────────────────────────── */

type Seg = 'prospecting' | 'engaged' | 'existing' | 'unknown'
type Gender = 'female' | 'male' | 'unknown'

export type ChartTheme = {
  key: 'night' | 'day' | 'classic-dark' | 'classic-light'
  dark: boolean
  /** Lines and dots, slot 0 first (see slotOf). */
  lines: readonly string[]
  /** Bars and areas. */
  bars: readonly string[]
  seg: Record<Seg, string>
  gender: Record<Gender, string>
  tick: string
  grid: string
  /** Axis base line. */
  axis: string
  /** Text drawn in the chart (category ticks) and its quieter second line. */
  ink: string
  inkMuted: string
  /** Line widths: the lead series and the rest. */
  hero: number
  line: number
  cursorLine: { stroke: string; strokeDasharray?: string }
  cursorBand: { fill: string }
  tooltip: CSSProperties
  tooltipLabel: CSSProperties
}

const cream = (a: number) => `rgba(255,252,242,${a})`
const charcoal = (a: number) => `rgba(30,29,28,${a})`

const NIGHT: ChartTheme = {
  key: 'night', dark: true,
  lines: ['#E0703F', cream(0.78), cream(0.5), cream(0.64), cream(0.42), cream(0.88), cream(0.56), cream(0.7), cream(0.46)],
  bars: ['#C8521C', cream(0.34), cream(0.62), cream(0.46), cream(0.8), cream(0.28), cream(0.54), cream(0.72), cream(0.4)],
  seg: { prospecting: '#E0703F', engaged: cream(0.62), existing: cream(0.38), unknown: cream(0.18) },
  gender: { female: '#C8521C', male: cream(0.62), unknown: cream(0.22) },
  tick: cream(0.9), grid: cream(0.08), axis: cream(0.34), ink: '#FFFCF2', inkMuted: cream(0.68),
  hero: 2, line: 1.5,
  cursorLine: { stroke: cream(0.45), strokeDasharray: '3 3' },
  cursorBand: { fill: cream(0.06) },
  tooltip: {
    background: charcoal(0.94), border: 0, borderRadius: 6, padding: '9px 11px 10px', color: '#FFFCF2',
    boxShadow: `0 0 0 1px ${cream(0.16)}, 0 12px 28px -12px rgba(0,0,0,.6)`, fontSize: 12, lineHeight: 1.35,
  },
  tooltipLabel: { color: '#FFFCF2', fontSize: 11, fontWeight: 500, marginBottom: 4 },
}

const DAY: ChartTheme = {
  key: 'day', dark: false,
  lines: ['#B6410E', charcoal(0.8), charcoal(0.58), charcoal(0.7), charcoal(0.52), charcoal(0.9), charcoal(0.62), charcoal(0.76), charcoal(0.55)],
  bars: ['#B6410E', charcoal(0.52), charcoal(0.8), charcoal(0.64), charcoal(0.92), charcoal(0.46), charcoal(0.7), charcoal(0.86), charcoal(0.58)],
  seg: { prospecting: '#B6410E', engaged: charcoal(0.62), existing: charcoal(0.38), unknown: charcoal(0.16) },
  gender: { female: '#B6410E', male: charcoal(0.8), unknown: charcoal(0.2) },
  tick: charcoal(0.9), grid: charcoal(0.07), axis: charcoal(0.34), ink: '#1E1D1C', inkMuted: charcoal(0.72),
  hero: 2, line: 1.5,
  cursorLine: { stroke: charcoal(0.45), strokeDasharray: '3 3' },
  cursorBand: { fill: charcoal(0.05) },
  tooltip: {
    background: '#FFFCF2', border: 0, borderRadius: 6, padding: '9px 11px 10px', color: '#1E1D1C',
    boxShadow: `0 0 0 1px ${charcoal(0.12)}, 0 12px 28px -12px ${charcoal(0.3)}`, fontSize: 12, lineHeight: 1.35,
  },
  tooltipLabel: { color: '#1E1D1C', fontSize: 11, fontWeight: 500, marginBottom: 4 },
}

// Off the ground: the house palette (clay, teal, plum, sage, rose, ochre, slate,
// sandstone, pine), lifted on dark surfaces so every hue keeps 3:1.
const CLASSIC_LIGHT_SERIES = CHART_PALETTE.slice(0, 9)
const CLASSIC_DARK_SERIES = ['#e67d59', '#3fb8b4', '#b689c2', '#9bb86e', '#d685ad', '#d4a94a', '#6f9fd4', '#d6a46f', '#3fa676']

const classic = (dark: boolean): ChartTheme => {
  const s = dark ? CLASSIC_DARK_SERIES : CLASSIC_LIGHT_SERIES
  const neutral = dark ? '#8f8983' : CHART_PALETTE[9]
  return {
    key: dark ? 'classic-dark' : 'classic-light', dark,
    lines: s, bars: s,
    seg: { prospecting: s[6], engaged: s[5], existing: s[0], unknown: neutral },
    gender: { female: s[0], male: s[1], unknown: neutral },
    tick: dark ? '#a0998f' : '#6b655e', grid: dark ? 'rgba(255,255,255,0.09)' : 'rgba(33,30,27,0.08)',
    axis: dark ? '#3a3631' : '#e7e3dd', ink: dark ? '#f0ece5' : '#211e1b', inkMuted: dark ? '#a0998f' : '#6b655e',
    hero: 1.75, line: 1.75,
    cursorLine: { stroke: dark ? 'rgba(255,255,255,0.2)' : 'rgba(33,30,27,0.18)' },
    cursorBand: { fill: dark ? 'rgba(255,255,255,0.05)' : 'rgba(33,30,27,0.05)' },
    tooltip: {
      background: 'var(--color-surface-overlay)', border: '1px solid var(--color-line)', borderRadius: 8,
      padding: '6px 10px', color: 'var(--color-text-primary)', boxShadow: 'var(--shadow-popover)', fontSize: 11,
    },
    tooltipLabel: { color: 'var(--color-text-secondary)', marginBottom: 2 },
  }
}
const CLASSIC_LIGHT = classic(false)
const CLASSIC_DARK = classic(true)

function themeKey(): ChartTheme['key'] {
  const el = document.documentElement
  if (el.classList.contains('ody-scope')) return el.classList.contains('ody-ground-light') ? 'day' : 'night'
  const pinned = el.dataset.theme
  if (pinned === 'dark') return 'classic-dark'
  if (pinned === 'light') return 'classic-light'
  const q = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  return q && !q.matches ? 'classic-light' : 'classic-dark'
}

function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  mq?.addEventListener('change', cb)
  return () => { mo.disconnect(); mq?.removeEventListener('change', cb) }
}

const THEMES: Record<ChartTheme['key'], ChartTheme> = { night: NIGHT, day: DAY, 'classic-dark': CLASSIC_DARK, 'classic-light': CLASSIC_LIGHT }

/** The chart colours for the look on screen (follows App Settings and the OS). */
export function useChartTheme(): ChartTheme {
  return THEMES[useSyncExternalStore(subscribeTheme, themeKey, () => 'night' as const)]
}

/** Atelier's series slots: 0 is the accent, then eight neutral steps that repeat. */
const slotOf = (i: number) => (i <= 0 ? 0 : 1 + ((i - 1) % 8))
export const lineOf = (t: ChartTheme, i: number) => t.lines[slotOf(i)]
export const barOf = (t: ChartTheme, i: number) => t.bars[slotOf(i)]
/** The lead series is the hero line. */
export const lineWidthOf = (t: ChartTheme, i: number) => (i <= 0 ? t.hero : t.line)

export const genderColor = (t: ChartTheme, g: string) => t.gender[(g === 'female' || g === 'male' ? g : 'unknown') as Gender]
export const segmentColor = (t: ChartTheme, s: string) =>
  t.seg[(s === 'prospecting' || s === 'engaged' || s === 'existing' ? s : 'unknown') as Seg]

/* ── House chart style (recharts props) ───────────────────────────────── */

/** Chart height in a tile: follows the viewport, the same clamp as Atelier's tiles. */
export const CHART_H = 'clamp(180px, 26vh, 440px)'

export const axisTick = (t: ChartTheme) => ({ fontSize: 10, fill: t.tick })
export const gridProps = (t: ChartTheme) => ({ strokeDasharray: '2 4', stroke: t.grid })
export const axisLine = (t: ChartTheme) => ({ stroke: t.axis })

/** Tooltip props for the look on screen. */
export const tooltipProps = (t: ChartTheme) => ({
  isAnimationActive: false,
  contentStyle: t.tooltip,
  labelStyle: t.tooltipLabel,
  itemStyle: { padding: 0 },
  wrapperStyle: { outline: 'none', zIndex: 5 },
})

/* ── Persisted UI state ───────────────────────────────────────────────── */

export function usePersisted<T>(key: string, initial: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw != null) {
        const parsed: unknown = JSON.parse(raw)
        if (valid(parsed)) return parsed
      }
    } catch { /* storage off */ }
    return initial
  })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(val)) } catch { /* storage off */ } }, [key, val])
  return [val, setVal]
}

export const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
export const isKeyList = (v: unknown): v is string[] => Array.isArray(v) && v.every(k => typeof k === 'string' && k.length > 0)

/** A tile's open state, remembered per tile. */
export const useTileOpen = (id: string, initial: boolean) => usePersisted<boolean>(`fv.chart.${id}.open`, initial, isBool)

/* ── Tile surface ─────────────────────────────────────────────────────── */

/**
 * A chart tile: the raised surface with a thin line, the serif title on the
 * left (the hint is its tooltip), the chart's one control on the right. The
 * title opens and closes the tile; a closed tile asks Meta for nothing.
 */
export function ChartTile({ title, hint, actions, aside, open, onToggle, children }: {
  title: string
  hint?: string
  /** The tile's control, shown while open. */
  actions?: ReactNode
  /** A small read-out beside the title (e.g. the 3s hold), shown while open. */
  aside?: ReactNode
  open: boolean
  onToggle: () => void
  children?: ReactNode
}) {
  return (
    <section className={`${TILE_FLAT} !px-3.5 !py-3 flex flex-col gap-3 hover:z-20 focus-within:z-20`}>
      <div className="flex items-center gap-2 min-h-7 min-w-0">
        <button type="button" onClick={onToggle} aria-expanded={open} title={hint}
          className="flex items-center gap-1 min-w-0 -ml-1 pl-0.5 pr-1.5 py-0.5 rounded-md hover:bg-hover transition-colors">
          <ChevronRight size={13} className={`shrink-0 text-text-muted transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          <h3 className="font-display text-[15px] font-medium tracking-[-0.015em] truncate text-text-primary">{title}</h3>
        </button>
        {open && aside}
        {open && actions && <div className="ml-auto flex items-center gap-1.5 shrink-0 min-w-0">{actions}</div>}
      </div>
      {open && children}
    </section>
  )
}

/** Fixed-height placeholder, so loading, empty and error states don't jump. */
export function TileState({ kind, children, title, height = CHART_H, onRetry }: {
  kind: 'loading' | 'empty' | 'error'
  children?: ReactNode
  title?: string
  height?: number | string
  onRetry?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 text-center text-xs px-4" style={{ height }} title={title}>
      {kind === 'loading'
        ? <Loader2 size={16} className="animate-spin text-text-muted" aria-label="Loading" />
        : <span className={kind === 'error' ? 'text-error' : 'text-text-muted'}>{children}</span>}
      {kind === 'error' && onRetry && (
        <button type="button" onClick={onRetry} className="h-6 px-2.5 rounded-full text-[10.5px] glass glass-hover text-text-secondary">
          Try again
        </button>
      )}
    </div>
  )
}

/** Dot legend (in place of the recharts Legend), with an optional value per item. */
export function DotLegend({ items }: { items: { key: string; label: string; color: string; value?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {items.map(it => (
        <div key={it.key} className="flex items-center gap-1 text-[10px] text-text-muted">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: it.color }} />
          {it.label}
          {it.value && <span className="font-medium text-text-primary tabular-nums">{it.value}</span>}
        </div>
      ))}
    </div>
  )
}

/* ── Labels ───────────────────────────────────────────────────────────── */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Sep 7" for an ISO date, the value otherwise. */
export function fmtDay(v: unknown): string {
  const s = String(v ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(`${s}T00:00:00`)
  return `${MON[d.getMonth()]} ${d.getDate()}`
}

/** "Sep 1 to Sep 30" for a range. */
export const fmtRange = (since: string, until: string) => `${fmtDay(since)} to ${fmtDay(until)}`
