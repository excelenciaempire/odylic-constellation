/**
 * Number formatting + delta semantics shared by every widget, ChartView,
 * DataTable and the Creative Analysis views (ported from Atelier), so a value reads the same
 * wherever it shows up: fmtCell in tables and cards, fmtValue in tiles and
 * tooltips, fmtAxis on chart ticks.
 */
import type { MetricFormat } from './metrics'

/** Currency symbol for 'dollar' values (set from the account currency). */
let SYM = '$'
export function setCurrency(code: string | null | undefined): void {
  SYM = currencySymbol(code)
}
export function currencySymbol(code: string | null | undefined): string {
  if (!code) return '$'
  try {
    const sym = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find(p => p.type === 'currency')
    return sym?.value || code + ' '
  } catch {
    return code + ' '
  }
}
export const money = () => SYM

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Full-precision display value (tiles, tables, tooltips). */
export function fmtValue(v: unknown, format: MetricFormat | string | undefined): string {
  const n = toNum(v)
  if (n === null) return 'n/a'
  const abs = Math.abs(n)
  switch (format) {
    case 'dollar': {
      const sign = n < 0 ? '-' : ''
      if (abs >= 1_000_000) return `${sign}${SYM}${(abs / 1_000_000).toFixed(2)}M`
      if (abs >= 10_000) return `${sign}${SYM}${(abs / 1_000).toFixed(1)}k`
      if (abs >= 100) return `${sign}${SYM}${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      return `${sign}${SYM}${abs.toFixed(2)}`
    }
    case 'percent':
      return `${n.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2)}%`
    case 'decimal':
      return abs >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(2)
    case 'text':
      return String(v)
    default: {
      if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
      if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}k`
      if (!Number.isInteger(n) && abs < 100) return n.toFixed(2)
      return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    }
  }
}

/**
 * Table-cell value: full precision, the one formatter every table uses
 * (Overview tables, Creative Analysis table + grouped table, widget tables,
 * ad cards). Dollars keep cents under $1,000 and whole dollars above; counts
 * are grouped whole numbers; percents and ratios keep two decimals. Tiles,
 * tooltips and axes stay compact through fmtValue / fmtAxis.
 */
export function fmtCell(v: unknown, format: MetricFormat | string | undefined): string {
  if (format === 'text') return v === null || v === undefined || v === '' ? 'n/a' : String(v)
  const n = toNum(v)
  if (n === null) return 'n/a'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  const whole = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 0 })
  switch (format) {
    case 'dollar':
      return abs >= 1000 ? `${sign}${SYM}${whole(abs)}` : `${sign}${SYM}${abs.toFixed(2)}`
    case 'percent':
      return `${n.toFixed(2)}%`
    case 'decimal':
      return abs >= 1000 ? whole(n) : n.toFixed(2)
    default:
      return Number.isInteger(n) || abs >= 100 ? whole(n) : n.toFixed(2)
  }
}

/** Compact axis tick. `symbols` adds $ / % the way ChartSettingsButton does. */
export function fmtAxis(v: unknown, format: MetricFormat | string | undefined, symbols = true): string {
  const n = toNum(v)
  if (n === null) return ''
  const abs = Math.abs(n)
  // Enough decimals that a tick never rounds to a value it is not (a 2.25
  // tick read "2.3", a 12.5k tick "13k"), with trailing zeros dropped so
  // neighbours read alike: 0, 0.75, 1.5, 2.25, 3 and $2.5k, $5k, $7.5k.
  const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)
  let core: string
  if (abs >= 1_000_000) core = trim((n / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)) + 'M'
  else if (abs >= 1_000) core = trim((n / 1_000).toFixed(abs >= 10_000 ? 1 : 2)) + 'k'
  else if (abs >= 100 || abs === 0) core = Math.round(n).toString()
  else if (abs >= 10) core = trim(n.toFixed(1))
  else core = trim(n.toFixed(2))
  if (symbols) {
    if (format === 'dollar') return (n < 0 ? '-' + SYM + core.slice(1) : SYM + core)
    if (format === 'percent') return core + '%'
  }
  return core
}


/** Compact money for KPI strips and legends: $1.2k, $3.40M. */
export function fmtMoney(v: number): string {
  return v >= 1e6 ? `${SYM}${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${SYM}${(v / 1e3).toFixed(1)}k` : `${SYM}${v.toFixed(0)}`
}
export function fmtCount(v: number): string {
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v))
}
