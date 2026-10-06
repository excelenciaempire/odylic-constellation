/**
 * DatePicker: the date-range picker, ported from Atelier (presets and two
 * calendars; the comparison range is left out, the space shows one period).
 * Presets live in lib/dateRanges.ts.
 */
import { useEffect, useState } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { Select } from '../ui/Select'
import { BTN_PRIMARY, BTN_SECONDARY, OPTION_ROW, PANEL_LG, CSS_VAR } from '../ui/theme'
import { isoDate, matchPreset, parseIso, presetRange, rangeLabel, type Preset } from '../lib/dateRanges'

/** The presets this app offers (a hand-picked range on the calendars is the custom one). */
export const PICKER_PRESETS: Preset[] = [
  'Yesterday', 'Last 7 days', 'Last 14 days', 'Last 30 days', 'Last 90 days', 'This month', 'Last month',
]

interface DatePickerProps {
  start: string
  end: string
  /** The preset the open range came from (several can share dates). */
  preset?: Preset | null
  /** `preset` is the preset the range came from (null for a hand-picked range). */
  onApply: (start: string, end: string, preset: Preset | null) => void
  onClose: () => void
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function MiniCal({ year, month, start, end, onSelect, onNav, onSetMonth, onSetYear }: {
  year: number; month: number; start: string; end: string
  onSelect: (d: string) => void; onNav: (dir: number) => void
  onSetMonth: (m: number) => void; onSetYear: (y: number) => void
}) {
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const today = isoDate(new Date())
  const currYear = new Date().getFullYear()
  const years: number[] = []
  for (let y = 2020; y <= currYear + 1; y++) years.push(y)

  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  return (
    <div style={{ width: 196 }}>
      <div className="flex items-center justify-between mb-1.5">
        <button type="button" onClick={() => onNav(-1)} title="Previous month" aria-label="Previous month"
          className="p-1 rounded-full text-text-muted hover:text-text-primary hover:bg-hover">
          <ChevronLeft size={12} />
        </button>
        <div className="flex items-center gap-0.5">
          <Select compact
            value={String(month)}
            options={MONTHS.map((m, i) => ({ value: String(i), label: m.slice(0, 3) }))}
            onChange={v => onSetMonth(parseInt(v))} />
          <Select compact
            value={String(year)}
            options={years.map(y => ({ value: String(y), label: String(y) }))}
            onChange={v => onSetYear(parseInt(v))} />
        </div>
        <button type="button" onClick={() => onNav(1)} title="Next month" aria-label="Next month"
          className="p-1 rounded-full text-text-muted hover:text-text-primary hover:bg-hover">
          <ChevronRight size={12} />
        </button>
      </div>
      <div className="grid grid-cols-7">
        {DAYS_SHORT.map((d, i) => <div key={i} className="text-[10px] text-center text-text-muted py-0.5">{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} className="w-7 h-6" />
          const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const isEdge = ds === start || ds === end
          const inRange = start && end && ds >= start && ds <= end

          let style: React.CSSProperties | undefined
          const future = ds > today
          // range ends in the ground's ink with the menu colour as text (Atelier's date picker)
          if (isEdge) style = { background: 'var(--ody-date-edge, #B7410E)', color: 'var(--ody-date-edge-ink, #FFFFFF)' }
          else if (inRange) style = { background: CSS_VAR.select, color: CSS_VAR.textPrimary }

          return (
            <button key={day} type="button" onClick={() => onSelect(ds)} style={style} disabled={future}
              className={`w-7 h-6 disabled:opacity-30 disabled:cursor-not-allowed text-[11px] rounded transition-colors tabular-nums ${style ? '' : 'hover:bg-hover'} ${isEdge ? 'font-medium' : ''} ${ds === today && !style ? 'font-semibold text-text-primary' : ''}`}>
              {day}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function DatePicker({ start, end, preset, onApply, onClose }: DatePickerProps) {
  const [tempStart, setTempStart] = useState(start)
  const [tempEnd, setTempEnd] = useState(end)
  const [picking, setPicking] = useState<'start' | 'end'>('start')
  const [activePreset, setActivePreset] = useState<Preset | null>(() => preset ?? matchPreset({ start, end }))

  const ed = parseIso(tempEnd || tempStart || end || isoDate(new Date()))
  const [rightMonth, setRightMonth] = useState(ed.getMonth())
  const [rightYear, setRightYear] = useState(ed.getFullYear())

  const leftMonth = rightMonth === 0 ? 11 : rightMonth - 1
  const leftYear = rightMonth === 0 ? rightYear - 1 : rightYear

  const canApply = !!tempStart && !!tempEnd && tempStart <= tempEnd

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function nav(dir: number) {
    let m = rightMonth + dir, y = rightYear
    if (m > 11) { m = 0; y++ }
    if (m < 0) { m = 11; y-- }
    setRightMonth(m); setRightYear(y)
  }

  function selectDate(ds: string) {
    if (picking === 'start') {
      setTempStart(ds)
      setTempEnd(ds)
      setPicking('end')
    } else {
      if (ds < tempStart) { setTempStart(ds) } else { setTempEnd(ds) }
      setPicking('start')
    }
    setActivePreset(null)
  }

  function selectPreset(p: Preset) {
    const r = presetRange(p)
    setTempStart(r.start); setTempEnd(r.end); setActivePreset(p); setPicking('start')
    const d = parseIso(r.end)
    setRightMonth(d.getMonth()); setRightYear(d.getFullYear())
  }

  const apply = () => {
    if (!canApply) return
    onApply(tempStart, tempEnd, activePreset)
    onClose()
  }

  return (
    <div className="ody-portal fixed inset-0" style={{ zIndex: 99998, background: 'transparent' }} onClick={onClose}>
      <div className={`fixed ${PANEL_LG} !py-0`} role="dialog" aria-label="Date range"
        style={{ zIndex: 99999, top: 60, left: '50%', transform: 'translateX(-50%)', width: 580, maxWidth: 'calc(100vw - 32px)' }}
        onClick={e => e.stopPropagation()}>
        <div className="flex flex-col sm:flex-row">
          {/* Presets */}
          <div className="sm:w-[140px] flex sm:block overflow-x-auto sm:border-r border-b sm:border-b-0 border-line py-1.5 flex-shrink-0 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 120px)' }}>
            {PICKER_PRESETS.map(p => {
              const on = activePreset === p
              return (
                <button key={p} type="button" onClick={() => selectPreset(p)}
                  className={OPTION_ROW} style={on ? { color: CSS_VAR.accentInk } : undefined}>
                  <span className={on ? '' : 'text-text-secondary'}>{p}</span>
                  {on && <Check size={12} className="shrink-0 ml-2" />}
                </button>
              )
            })}
          </div>

          <div className="flex-1 min-w-0 p-3 flex flex-col gap-3">
            <div className="flex gap-4 justify-center flex-wrap">
              <MiniCal year={leftYear} month={leftMonth} start={tempStart} end={tempEnd}
                onSelect={selectDate} onNav={nav}
                onSetMonth={m => {
                  // The left calendar's month moves the right one to the month after it.
                  const newRight = m + 1
                  if (newRight > 11) { setRightMonth(0); setRightYear(leftYear + 1) }
                  else { setRightMonth(newRight); setRightYear(leftYear) }
                }}
                onSetYear={y => {
                  const newRight = leftMonth + 1
                  if (newRight > 11) { setRightMonth(0); setRightYear(y + 1) }
                  else { setRightMonth(newRight); setRightYear(y) }
                }} />
              <MiniCal year={rightYear} month={rightMonth} start={tempStart} end={tempEnd}
                onSelect={selectDate} onNav={nav}
                onSetMonth={m => setRightMonth(m)}
                onSetYear={y => setRightYear(y)} />
            </div>

            {/* Footer: what will be applied, then the actions. */}
            <div className="flex items-center gap-3 pt-2 border-t border-line">
              <div className="flex flex-col gap-0.5 text-[11px] min-w-0">
                <span className="flex items-center gap-1.5 text-text-primary tabular-nums">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--ody-date-edge, #B7410E)' }} />
                  {tempStart && tempEnd ? rangeLabel(tempStart, tempEnd) : 'Pick a start and end day'}
                </span>
                {picking === 'end' && <span className="text-text-muted">Now pick the end day</span>}
              </div>
              <div className="ml-auto flex gap-2 shrink-0">
                <button type="button" onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
                <button type="button" onClick={apply} disabled={!canApply} className={BTN_PRIMARY}>Apply</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
