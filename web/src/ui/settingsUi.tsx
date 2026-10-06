/**
 * Settings panel primitive (ported from Atelier): a labelled value in a
 * panel. The label takes the row, the control sits on the right.
 */
import type { ReactNode } from 'react'

export function FieldRow({ label, title, children }: { label: ReactNode; title?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs min-w-0" title={title}>
      <span className={`text-[11px] text-text-secondary flex-1 min-w-0 truncate ${title ? 'cursor-help' : ''}`}>{label}</span>
      <div className="flex items-center gap-1 shrink-0">{children}</div>
    </div>
  )
}
