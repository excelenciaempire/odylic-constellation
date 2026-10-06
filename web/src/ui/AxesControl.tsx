/**
 * The space's one control, ported from Atelier's charts/AxesControl: a
 * compact pill that opens ONE panel (AxesPopover), built from eyebrow
 * sections (AxisSection) and searchable grouped pickers (OptionPicker). The
 * metric pickers use OptionPicker over the metric catalog, so there is no
 * separate metrics dropdown.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { Popover } from './Popover'
import type { SelectOption } from './Select'
import { PILL_GLASS, PILL_TINT } from './theme'

/** Width of the axes panel. */
export const AXES_PANEL_WIDTH = 312

/** Eyebrow section with an optional control on the right. */
export function AxisSection({ label, title, action, children }: {
  label: string
  title?: string
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="pt-1.5 mt-1.5 border-t border-line first:border-t-0 first:mt-0 first:pt-0">
      <div className="flex items-center gap-2 px-3 pb-1 min-h-6" title={title}>
        <span className="text-[10px] uppercase tracking-[0.06em] text-text-muted flex-1 truncate">{label}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

function Muted({ children = 'None' }: { children?: ReactNode }) {
  return <div className="px-3 py-[3px] text-[11px] text-text-muted">{children}</div>
}

function Bullet({ on }: { on: boolean }) {
  return (
    <span
      className="w-3 h-3 rounded-full border-[1.5px] flex-shrink-0 flex items-center justify-center"
      style={{ borderColor: on ? 'var(--color-text-primary)' : 'var(--color-line-hover)', background: on ? 'var(--color-text-primary)' : 'transparent' }}
    >
      {on && <span className="block w-1 h-1 rounded-full bg-surface-raised" />}
    </span>
  )
}

/** A searchable, grouped single-choice picker in a pill. */
export function OptionPicker({ value, options, onChange, ariaLabel, placeholder, align = 'end' }: {
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
  ariaLabel: string
  placeholder?: string
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLButtonElement>(null)
  const current = options.find(o => o.value === value)
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const shown = needle ? options.filter(o => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)) : options
    const out: Array<{ group: string | null; items: SelectOption[] }> = []
    const byGroup = new Map<string | null, SelectOption[]>()
    for (const o of shown) {
      const g = o.group || null
      const items = byGroup.get(g)
      if (items) items.push(o)
      else { const first = [o]; byGroup.set(g, first); out.push({ group: g, items: first }) }
    }
    return out
  }, [options, q])
  return (
    <>
      <button ref={ref} type="button" onClick={() => { setOpen(o => !o); setQ('') }}
        aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} title={current?.hint}
        className={`h-6 px-2 text-[10.5px] rounded-full flex items-center gap-1.5 min-w-0 transition-colors ${open ? PILL_TINT : PILL_GLASS}`}>
        <span className={`font-medium truncate max-w-[160px] ${open ? '' : 'text-text-primary'}`}>{current?.label || placeholder || 'Pick'}</span>
        <ChevronDown size={10} className="opacity-60 shrink-0" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} align={align} width={260} maxHeight={420} className="py-1">
        {options.length > 8 && (
          <div className="px-2 py-1.5 sticky top-0 z-10 bg-surface-overlay">
            <input data-autofocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search..."
              className="w-full bg-surface-recessed border border-line rounded-lg px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-line-hover" />
          </div>
        )}
        <div role="listbox" aria-label={ariaLabel}>
          {groups.map(({ group, items }, gi) => (
            <div key={`${group}-${gi}`} className="py-0.5">
              {group && <div className="px-3 pt-2 pb-0.5 text-[9px] uppercase tracking-[0.06em] text-text-muted font-medium">{group}</div>}
              {items.map(o => {
                const on = o.value === value
                return (
                  <button key={o.value} type="button" role="option" aria-selected={on}
                    onClick={() => { onChange(o.value); setOpen(false) }}
                    className="w-full text-left px-3 py-1 text-xs hover:bg-hover flex items-center gap-2" title={o.hint}>
                    <Bullet on={on} />
                    <span className="flex flex-col min-w-0">
                      <span className={`truncate ${on ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>{o.label}</span>
                      {o.hint && <span className="truncate text-[10px] text-text-muted">{o.hint}</span>}
                    </span>
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

/** The pill trigger plus its panel. */
export function AxesPopover({ label, title, children, align = 'end', width = AXES_PANEL_WIDTH }: {
  label: string
  title?: string
  children: ReactNode
  align?: 'start' | 'end'
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen(o => !o)}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`h-7 px-2.5 text-[11px] gap-1.5 rounded-full flex items-center min-w-0 max-w-[300px] transition-colors ${open ? PILL_TINT : PILL_GLASS}`}
      >
        <SlidersHorizontal size={11} className="shrink-0 opacity-70" />
        <span className="shrink-0 text-text-muted">Arrange</span>
        <span className={`truncate font-medium ${open ? '' : 'text-text-primary'}`}>{label}</span>
        <ChevronDown size={10} className="opacity-60 shrink-0" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} align={align} width={width} maxHeight={680} className="py-2 text-xs">
        <div role="dialog" aria-label="Arrange the space">{children}</div>
      </Popover>
    </>
  )
}
