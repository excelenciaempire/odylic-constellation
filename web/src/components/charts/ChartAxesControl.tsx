/**
 * ChartAxesControl: the one control on each chart tile, ported from
 * Atelier's charts/AxesControl. A compact pill in the tile header sums up
 * the axes ("Spend · ROAS") and opens ONE panel:
 *
 *   X / Rows   what each point or bar is (fixed, or a choice like Placement,
 *              Platform or Device)
 *   Left Y     metrics (the bottom axis on horizontal bars)
 *   Right Y    metrics (the top axis on horizontal bars)
 *   Options    scale, moving averages, trend line, $ and % on the ticks,
 *              then any section the tile adds (Show as)
 *
 * The metric pickers list the app's catalog, limited to what the chart's
 * rows resolve. Tiles never add a second dropdown or gear beside it.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeftRight, Check, ChevronDown, SlidersHorizontal, X as XIcon } from 'lucide-react'
import { Popover } from '../../ui/Popover'
import { AxisSection } from '../../ui/AxesControl'
import { Segmented } from '../../ui/Segmented'
import { FieldRow } from '../../ui/settingsUi'
import { PILL_GLASS, PILL_TINT } from '../../ui/theme'
import type { ChartRegistry } from './chartMetrics'
import { axesSummary, moveMetric, removeMetric, withSide, type AxisScale, type ChartAxes } from './axes'

export const AXES_PANEL_WIDTH = 312

const SCALE_OPTIONS: Array<{ value: AxisScale; label: string; title: string }> = [
  { value: 'linear', label: 'From zero', title: 'Linear scale starting at zero' },
  { value: 'auto', label: 'Fit', title: 'Linear scale fitted to the range of the data' },
  { value: 'log', label: 'Log', title: 'Logarithmic scale. Needs values above zero.' },
]

function Muted({ children = 'None' }: { children?: ReactNode }) {
  return <div className="px-3 py-[3px] text-[11px] text-text-muted">{children}</div>
}

function Radio({ on }: { on: boolean }) {
  return (
    <span className="w-3 h-3 rounded-full border-[1.5px] flex-shrink-0 flex items-center justify-center"
      style={{ borderColor: on ? 'var(--color-text-primary)' : 'var(--color-line-hover)', background: on ? 'var(--color-text-primary)' : 'transparent' }}>
      {on && <span className="block w-1 h-1 rounded-full bg-surface-raised" />}
    </span>
  )
}

/** A labelled single choice (Show as, Rows): radio rows, Atelier's ChoiceList. */
export function ChoiceRows<T extends string>({ options, value, onChange, ariaLabel }: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col">
      {options.map(o => {
        const on = o.value === value
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => { if (!on) onChange(o.value) }}
            className="w-full text-left px-3 py-1 text-xs flex items-center gap-2 hover:bg-hover">
            <Radio on={on} />
            <span className={`truncate ${on ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Multi-select over the chart's catalog: a "Metrics" pill with a searchable, grouped list. */
function MetricsPicker({ registry, value, onChange, max }: {
  registry: ChartRegistry
  value: string[]
  onChange: (keys: string[]) => void
  max?: number
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLButtonElement>(null)
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const shown = needle ? registry.list.filter(m => m.label.toLowerCase().includes(needle) || m.key.includes(needle)) : registry.list
    return registry.groups.map(g => ({ group: g, items: shown.filter(m => m.group === g) })).filter(g => g.items.length)
  }, [registry, q])
  const full = max !== undefined && value.length >= max
  return (
    <>
      <button ref={ref} type="button" onClick={() => { setOpen(o => !o); setQ('') }} aria-haspopup="listbox" aria-expanded={open}
        className={`h-6 px-2 text-[10.5px] rounded-full flex items-center gap-1.5 transition-colors ${open ? PILL_TINT : PILL_GLASS}`}>
        <span className={`font-medium ${open ? '' : 'text-text-primary'}`}>Metrics</span>
        <ChevronDown size={10} className="opacity-60 shrink-0" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} align="end" width={248} maxHeight={400} className="py-1">
        {registry.list.length > 8 && (
          <div className="px-2 py-1.5 sticky top-0 z-10 bg-surface-overlay">
            <input data-autofocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search..."
              className="w-full bg-surface-recessed border border-line rounded-lg px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-line-hover" />
          </div>
        )}
        <div role="listbox" aria-multiselectable="true" aria-label="Metrics">
          {groups.map(({ group, items }) => (
            <div key={group} className="py-0.5">
              <div className="px-3 pt-2 pb-0.5 text-[9px] uppercase tracking-[0.06em] text-text-muted font-medium">{group}</div>
              {items.map(m => {
                const on = value.includes(m.key)
                const blocked = !on && full
                return (
                  <button key={m.key} type="button" role="option" aria-selected={on} disabled={blocked} title={m.description}
                    onClick={() => onChange(on ? value.filter(k => k !== m.key) : [...value, m.key])}
                    className="w-full text-left px-3 py-1 text-xs hover:bg-hover flex items-center gap-2 disabled:opacity-40">
                    <span className={`w-3 h-3 rounded-[3px] border-[1.5px] flex-shrink-0 flex items-center justify-center ${on ? 'bg-text-primary border-text-primary' : 'border-line-hover'}`}>
                      {on && <Check size={9} strokeWidth={3} className="text-surface-raised" />}
                    </span>
                    <span className={`truncate ${on ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>{m.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
          {!groups.length && <Muted>No matches</Muted>}
        </div>
      </Popover>
    </>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[11px] min-w-0 hover:bg-hover cursor-pointer">
      <input type="checkbox" className="accent-text-primary shrink-0" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="text-text-secondary truncate">{label}</span>
    </label>
  )
}

export type ChartOptions = {
  scale?: boolean
  trend?: boolean
  /** Moving-average windows offered (days). */
  sma?: readonly number[]
  symbols?: boolean
}

export function ChartAxesControl({
  registry, value, onChange, mode = 'dual', x, leftLabel, rightLabel, options, scaleNote, extra, colorOf, title, max,
}: {
  registry: ChartRegistry
  value: ChartAxes
  onChange: (next: ChartAxes) => void
  /** dual = Left Y and Right Y lists; list = one list (rows of a table tile). */
  mode?: 'dual' | 'list'
  /** The X (or Rows) section: a fixed value, or a picker the tile passes. */
  x?: { label?: string; value?: string; title?: string; picker?: ReactNode }
  leftLabel?: string
  rightLabel?: string
  options?: ChartOptions
  scaleNote?: string
  /** Tile sections below the options (Show as). */
  extra?: ReactNode
  /** Series colour per metric (no dot when undefined). */
  colorOf?: (key: string) => string | undefined
  title?: string
  /** Most metrics a side may hold. */
  max?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const label = (k: string) => registry.byKey[k]?.label || k
  const formatOf = (k: string) => registry.byKey[k]?.format
  const known = (keys: string[]) => keys.filter(k => !!registry.byKey[k])
  const summary = axesSummary({ ...value, left: known(value.left), right: known(value.right) }, label)

  // A metric picked for the left axis in another unit than the one there
  // goes on the right axis, where its scale reads, when that axis is free or
  // already in its unit. It can be moved back.
  const pickLeft = (keys: string[]): ChartAxes => {
    if (mode !== 'dual') return { ...value, left: keys, right: [] }
    const kept = value.left.filter(k => keys.includes(k))
    const leftFmts = new Set(kept.map(formatOf))
    if (leftFmts.size !== 1) return withSide(value, 'left', keys)
    const rightFmts = new Set(value.right.map(formatOf))
    const toRight: string[] = []
    for (const k of keys) {
      if (kept.includes(k) || leftFmts.has(formatOf(k))) continue
      if (rightFmts.size === 0 || (rightFmts.size === 1 && rightFmts.has(formatOf(k)))) { toRight.push(k); rightFmts.add(formatOf(k)) }
    }
    if (!toRight.length) return withSide(value, 'left', keys)
    const next = withSide(value, 'left', keys.filter(k => !toRight.includes(k)))
    return withSide(next, 'right', [...next.right, ...toRight])
  }

  const rows = (keys: string[], side: 'left' | 'right' | null) => (keys.length ? keys.map(k => {
    const color = colorOf?.(k)
    const moveTitle = side ? `Move to ${side === 'left' ? (rightLabel || 'Right Y') : (leftLabel || 'Left Y')}` : ''
    return (
      <div key={k} className="flex items-center gap-2 px-3 py-[3px] text-xs hover:bg-hover min-w-0" title={registry.byKey[k]?.description}>
        {color && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />}
        <span className="truncate flex-1 min-w-0 text-text-secondary">{label(k)}</span>
        {side && (
          <button type="button" onClick={() => onChange(moveMetric(value, k, side === 'left' ? 'right' : 'left'))}
            title={moveTitle} aria-label={moveTitle}
            className="h-5 w-5 rounded-full flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-hover shrink-0">
            <ArrowLeftRight size={11} />
          </button>
        )}
        <button type="button" onClick={() => onChange(removeMetric(value, k))} title={`Remove ${label(k)}`} aria-label={`Remove ${label(k)}`}
          className="h-5 w-5 rounded-full flex items-center justify-center text-text-muted hover:text-error hover:bg-hover shrink-0">
          <XIcon size={11} />
        </button>
      </div>
    )
  }) : <Muted />)

  const sma = options?.sma || []
  const picked = value.sma || []
  const hasToggles = !!options?.trend || !!options?.symbols
  const hasOptions = !!options && (!!options.scale || sma.length > 0 || hasToggles)

  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen(o => !o)} title={title || 'Metrics and chart options'}
        aria-haspopup="dialog" aria-expanded={open}
        className={`h-6 px-2 text-[10.5px] gap-1.5 rounded-full flex items-center min-w-0 max-w-[230px] transition-colors ${open ? PILL_TINT : PILL_GLASS}`}>
        <SlidersHorizontal size={11} className="shrink-0 opacity-70" />
        <span className={`truncate ${open ? '' : 'text-text-primary'}`}>{summary}</span>
        <ChevronDown size={10} className="opacity-60 shrink-0" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} align="end" width={AXES_PANEL_WIDTH} maxHeight={600} className="py-2 text-xs">
        <div role="dialog" aria-label={title || 'Metrics and chart options'}>
          {x && (
            <AxisSection label={x.label || 'X axis'} title={x.title}
              action={x.picker ?? <span className="text-[11px] text-text-primary truncate max-w-[62%]">{x.value}</span>} />
          )}
          {mode === 'list' ? (
            <AxisSection label={leftLabel || 'Rows'} action={<MetricsPicker registry={registry} value={known(value.left)} onChange={keys => onChange(pickLeft(keys))} max={max} />}>
              {rows(known(value.left), null)}
            </AxisSection>
          ) : (
            <>
              <AxisSection label={leftLabel || 'Left Y'} action={<MetricsPicker registry={registry} value={known(value.left)} onChange={keys => onChange(pickLeft(keys))} max={max} />}>
                {rows(known(value.left), 'left')}
              </AxisSection>
              <AxisSection label={rightLabel || 'Right Y'} action={<MetricsPicker registry={registry} value={known(value.right)} onChange={keys => onChange(withSide(value, 'right', keys))} max={max} />}>
                {rows(known(value.right), 'right')}
              </AxisSection>
            </>
          )}
          {hasOptions && (
            <AxisSection label="Options">
              {options?.scale && (
                <FieldRow label="Scale">
                  <Segmented<AxisScale> size="sm" ariaLabel="Axis scale" value={value.scale || 'linear'}
                    onChange={s => onChange({ ...value, scale: s })} options={SCALE_OPTIONS} />
                </FieldRow>
              )}
              {options?.scale && scaleNote && <div className="px-3 pb-1 text-[10px] text-text-muted">{scaleNote}</div>}
              {sma.length > 0 && (
                <FieldRow label="Moving average">
                  {sma.map(n => {
                    const on = picked.includes(n)
                    return (
                      <button key={n} type="button" aria-pressed={on} title={`${n}-day moving average`}
                        onClick={() => onChange({ ...value, sma: on ? picked.filter(w => w !== n) : [...picked, n].sort((a, b) => a - b) })}
                        className={`h-6 px-2 rounded-full text-[10.5px] tabular-nums transition-colors ${on ? PILL_TINT : PILL_GLASS}`}>
                        {n}d
                      </button>
                    )
                  })}
                </FieldRow>
              )}
              {hasToggles && (
                <div className="grid grid-cols-2 gap-x-1 px-1.5">
                  {options?.trend && <Toggle label="Trend line" checked={!!value.trend} onChange={v => onChange({ ...value, trend: v })} />}
                  {options?.symbols && <Toggle label="$ and % on axes" checked={value.symbols !== false} onChange={v => onChange({ ...value, symbols: v })} />}
                </div>
              )}
            </AxisSection>
          )}
          {extra}
        </div>
      </Popover>
    </>
  )
}
