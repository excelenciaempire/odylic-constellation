/**
 * Segmented, the canonical mode/scope toggle, matching the Creative Analysis
 * view-switcher (a lifted tile on a recessed track). This is THE single
 * source of truth for every segmented control in the app: scope switches,
 * sub-tabs, mode pickers. Do not hand-roll a toggle with TAB_ON or SEG_ON:
 * one control, one look.
 *
 *   container  : inline-flex p-0.5 rounded-full, recessed track + inset line
 *   active     : the selection treatment, ink on a rust tint with a rust
 *                tint line and the control shadow (a lifted tile)
 *   inactive   : text-text-muted hover:text-text-secondary
 *
 * Supports text labels, icon-only (BarChart3 / Search style), or icon+label.
 *
 * variant="underline" renders navigation tabs instead (page and section
 * navigation): a thin line under the row and a rust underline under the
 * active tab. Same API, same options.
 */
import type { ReactNode } from 'react'
import { TAB_UNDERLINE, TAB_UNDERLINE_BAR, TAB_UNDERLINE_OFF, TAB_UNDERLINE_ON } from './theme'

export type SegmentedOption<T extends string | number = string> = {
  value: T
  /** Text label. Omit for an icon-only segment. */
  label?: ReactNode
  /** Optional leading icon (already sized, e.g. <BarChart3 size={12} />). */
  icon?: ReactNode
  title?: string
  disabled?: boolean
}

export function Segmented<T extends string | number = string>({
  options,
  value,
  onChange,
  size = 'md',
  variant = 'pill',
  ariaLabel,
  className = '',
}: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (v: T) => void
  /** md = standard h-7 text labels · sm = compact · icon = square icon-only. */
  size?: 'md' | 'sm' | 'icon'
  /** pill = the white-lifted toggle (default) · underline = navigation tabs. */
  variant?: 'pill' | 'underline'
  ariaLabel?: string
  className?: string
}) {
  if (variant === 'underline') {
    return (
      <div role="tablist" aria-label={ariaLabel} data-seg="underline" className={`${TAB_UNDERLINE_BAR} ${className}`}>
        {options.map(opt => {
          const active = opt.value === value
          return (
            <button
              key={opt.value}
              role="tab"
              type="button"
              aria-selected={active}
              disabled={opt.disabled}
              onClick={() => onChange(opt.value)}
              title={opt.title}
              className={`${TAB_UNDERLINE} ${active ? TAB_UNDERLINE_ON : TAB_UNDERLINE_OFF}`}
            >
              {opt.icon}
              {opt.label}
            </button>
          )
        })}
      </div>
    )
  }
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-seg="pill"
      className={`inline-flex items-center p-0.5 rounded-full bg-surface-recessed ring-1 ring-inset ring-line ${className}`}
    >
      {options.map(opt => {
        const active = opt.value === value
        const shape =
          size === 'icon'
            ? 'p-1.5'
            : size === 'sm'
            ? 'h-6 px-2.5 text-[10.5px] font-medium'
            : 'h-7 px-3 text-[11px] font-medium'
        return (
          <button
            key={opt.value}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
            title={opt.title}
            className={`${shape} rounded-full flex items-center gap-1.5 whitespace-nowrap transition-colors disabled:opacity-40 ${
              active
                ? 'bg-select text-text-primary shadow-control ring-1 ring-select-line'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {opt.icon}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
