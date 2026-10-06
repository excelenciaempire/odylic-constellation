/**
 * Select, THE app-standard dropdown. Replaces every native <select> so the
 * whole app shares one look: Creative-Analysis pill trigger (h-7 rounded-full
 * control surface; rust selection tint when "active") + the overlay popover with the
 * standard shadow. Auto-closes on pick. Optional search for long lists.
 *
 * Universal definitions (the design-system contract):
 *   trigger : h-7 px-2.5 rounded-full text-[11px] glass (control) / PILL_TINT;
 *             an optional grey `label` key, then the value in ink
 *   panel   : PANEL (bg-surface-overlay rounded-xl border-line shadow-popover) z-[70]
 *   option  : OPTION_ROW (hover:bg-hover); selected = OPTION_ROW_ACTIVE
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Check, Search } from 'lucide-react'
import { OPTION_ROW, OPTION_ROW_ACTIVE, PANEL, PILL_TINT } from './theme'

export type SelectOption = { value: string; label: string; hint?: string; group?: string }

export function Select({
  value, options, onChange, placeholder, active, searchable, prefix, width, compact,
  title, ariaLabel, triggerLabel, placement = 'bottom', disabled, label,
}: {
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
  placeholder?: string
  // Orange-tint the trigger (matches "filter applied" pills). Defaults to
  // tinting whenever a non-empty value is selected and differs from the
  // first option, pass explicitly to override.
  active?: boolean
  searchable?: boolean
  // Small leading element inside the trigger (icon / index number).
  prefix?: React.ReactNode
  width?: number
  // Compact triggers for dense rows (stage pickers): h-6, smaller text.
  compact?: boolean
  // Tooltip and accessible name for the trigger.
  title?: string
  ariaLabel?: string
  // Replaces the selected option's label in the trigger, e.g. "Group by: Angle".
  triggerLabel?: React.ReactNode
  // Grey key shown before the value ("Group by  Angle"). The value reads in
  // charcoal so the trigger reads as a setting.
  label?: React.ReactNode
  // 'top' opens the menu upward, for triggers near the bottom of the page.
  placement?: 'top' | 'bottom'
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => { if (!open) setQ('') }, [open])

  const current = options.find(o => o.value === value)
  const isActive = active ?? false

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return options
    return options.filter(o => o.label.toLowerCase().includes(n) || o.value.toLowerCase().includes(n))
  }, [options, q])

  // Group-aware render order (stable by first appearance): an option joins
  // its group's block even when the list interleaves groups, so a heading
  // never shows twice.
  const grouped = useMemo(() => {
    const out: { group: string | null; items: SelectOption[] }[] = []
    const byGroup = new Map<string | null, SelectOption[]>()
    for (const o of filtered) {
      const g = o.group || null
      const items = byGroup.get(g)
      if (items) items.push(o)
      else { const first = [o]; byGroup.set(g, first); out.push({ group: g, items: first }) }
    }
    return out
  }, [filtered])

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${compact ? 'h-6 px-2 text-[10.5px]' : 'h-7 px-2.5 text-[11px]'} rounded-full flex items-center gap-1.5 transition-colors max-w-[220px] disabled:opacity-40 disabled:cursor-not-allowed ${
          isActive
            ? PILL_TINT
            : 'glass glass-hover text-text-secondary'
        }`}
        style={width ? { width } : undefined}
      >
        {prefix}
        {label && <span className={`shrink-0 ${isActive ? '' : 'text-text-muted'}`}>{label}</span>}
        <span className={`truncate flex-1 text-left ${isActive || triggerLabel ? '' : current ? 'text-text-primary' : 'text-text-muted'}`}>{triggerLabel ?? (current?.label || placeholder || 'Select…')}</span>
        <ChevronDown size={10} className="opacity-60 shrink-0" />
      </button>

      {open && (
        <div role="listbox" className={`absolute z-[70] ${placement === 'top' ? 'bottom-full mb-1' : 'mt-1'} left-0 min-w-[200px] max-w-[280px] ${PANEL}`}>
          {searchable && (
            <div className="px-2 pb-1 pt-0.5">
              <div className="flex items-center gap-1.5 bg-surface-recessed border border-line rounded-lg px-2 py-1">
                <Search size={10} className="text-text-muted shrink-0" />
                <input
                  autoFocus
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="Search…"
                  className="flex-1 bg-transparent text-[11px] outline-none min-w-0"
                />
              </div>
            </div>
          )}
          <div className="max-h-[300px] overflow-y-auto">
            {grouped.map(({ group, items }, gi) => (
              <div key={gi}>
                {group && (
                  <div className="px-3 pt-1.5 pb-0.5 text-[9px] uppercase tracking-[0.06em] text-text-muted">{group}</div>
                )}
                {items.map(o => (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    onClick={() => { onChange(o.value); setOpen(false) }}
                    className={`${OPTION_ROW} ${o.value === value ? OPTION_ROW_ACTIVE : ''}`}
                  >
                    <span className="flex flex-col min-w-0">
                      <span className="truncate">{o.label}</span>
                      {o.hint && <span className="text-[10px] text-text-muted truncate">{o.hint}</span>}
                    </span>
                    {o.value === value && <Check size={12} className="shrink-0 ml-2 text-accent-ink" />}
                  </button>
                ))}
              </div>
            ))}
            {!filtered.length && (
              <div className="px-3 py-3 text-[11px] text-text-muted text-center">No matches.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
