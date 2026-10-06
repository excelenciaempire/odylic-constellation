/**
 * Date-range presets, compare ranges and labels for the app's one global
 * date picker (DatePicker.tsx) and the strip in App.tsx. Everything works on
 * LOCAL calendar dates: toISOString() is UTC, which after 5pm Pacific is
 * already tomorrow, so "yesterday" would include today's incomplete day.
 *
 * Ranges that run "to date" (last N days, this week / month / quarter / year)
 * end yesterday, the last complete day. On the first day of a period there
 * is no complete day yet, so they end today instead of before they start.
 */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const PRESETS = [
  'Yesterday', 'Last 7 days', 'Last 14 days', 'Last 28 days', 'Last 30 days', 'Last 90 days',
  'This week', 'Last week', 'This month', 'Last month', 'This quarter', 'Last quarter', 'This year',
] as const
export type Preset = typeof PRESETS[number]

export const DEFAULT_PRESET: Preset = 'Last 14 days'

export const COMPARE_TYPES = ['Previous period', 'Previous month', 'Previous year', 'Custom'] as const
export type CompareType = typeof COMPARE_TYPES[number]

export type Range = { start: string; end: string }

/** YYYY-MM-DD of a local date. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local midnight of a YYYY-MM-DD string. */
export function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

export function isPreset(v: unknown): v is Preset {
  return typeof v === 'string' && (PRESETS as readonly string[]).includes(v)
}

export function isCompareType(v: unknown): v is CompareType {
  return typeof v === 'string' && (COMPARE_TYPES as readonly string[]).includes(v)
}

export function presetRange(p: Preset, now: Date = new Date()): Range {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = addDays(today, -1)
  const y = today.getFullYear(), m = today.getMonth()
  // Period to date: through yesterday, or just today on the period's first day.
  const toDate = (start: Date): Range => ({ start: isoDate(start), end: isoDate(start > yesterday ? today : yesterday) })
  const lastDays = (n: number): Range => ({ start: isoDate(addDays(today, -n)), end: isoDate(yesterday) })
  const q = Math.floor(m / 3) * 3
  switch (p) {
    case 'Yesterday': return { start: isoDate(yesterday), end: isoDate(yesterday) }
    case 'Last 7 days': return lastDays(7)
    case 'Last 14 days': return lastDays(14)
    case 'Last 28 days': return lastDays(28)
    case 'Last 30 days': return lastDays(30)
    case 'Last 90 days': return lastDays(90)
    case 'This week': return toDate(addDays(today, -today.getDay()))
    case 'Last week': {
      const s = addDays(today, -today.getDay() - 7)
      return { start: isoDate(s), end: isoDate(addDays(s, 6)) }
    }
    case 'This month': return toDate(new Date(y, m, 1))
    case 'Last month': return { start: isoDate(new Date(y, m - 1, 1)), end: isoDate(new Date(y, m, 0)) }
    case 'This quarter': return toDate(new Date(y, q, 1))
    case 'Last quarter': return { start: isoDate(new Date(y, q - 3, 1)), end: isoDate(new Date(y, q, 0)) }
    case 'This year': return toDate(new Date(y, 0, 1))
  }
}

/** The preset a range matches today, if any (first match wins). */
export function matchPreset(r: Range): Preset | null {
  for (const p of PRESETS) {
    const pr = presetRange(p)
    if (pr.start === r.start && pr.end === r.end) return p
  }
  return null
}

/** Same day `months` months away, clamped to that month's last day (Mar 31 to Feb 28). */
function shiftMonths(d: Date, months: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last))
}

const isMonthStart = (d: Date) => d.getDate() === 1
const isMonthEnd = (d: Date) => addDays(d, 1).getDate() === 1

/** The comparison window for a range ('Custom' has none to compute). */
export function compareRange(r: Range, type: CompareType): Range | null {
  if (!r.start || !r.end || type === 'Custom') return null
  const s = parseIso(r.start), e = parseIso(r.end)
  if (type === 'Previous period') {
    const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1
    return { start: isoDate(addDays(s, -days)), end: isoDate(addDays(s, -1)) }
  }
  const months = type === 'Previous month' ? 1 : 12
  // Whole calendar months compare with whole months: September to all of August.
  const whole = isMonthStart(s) && isMonthEnd(e)
  const cs = shiftMonths(s, -months)
  const ce = whole ? new Date(e.getFullYear(), e.getMonth() - months + 1, 0) : shiftMonths(e, -months)
  return { start: isoDate(cs), end: isoDate(ce) }
}

/** "Sep 17 to Sep 30", with the year when it isn't this year or the range spans years. */
export function rangeLabel(start: string, end: string): string {
  if (!start || !end) return ''
  const s = parseIso(start), e = parseIso(end)
  const thisYear = new Date().getFullYear()
  const day = (d: Date) => `${MON[d.getMonth()]} ${d.getDate()}`
  if (start === end) return s.getFullYear() === thisYear ? day(s) : `${day(s)}, ${s.getFullYear()}`
  if (s.getFullYear() !== e.getFullYear()) return `${day(s)}, ${s.getFullYear()} to ${day(e)}, ${e.getFullYear()}`
  return `${day(s)} to ${day(e)}${e.getFullYear() === thisYear ? '' : `, ${e.getFullYear()}`}`
}
