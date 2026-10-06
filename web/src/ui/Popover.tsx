/**
 * Popover: a floating glass panel (the design-system PANEL surface; the
 * Odylic look paints it as thick glass, ui/odylic/frost.ts; one opened from
 * inside another is solid) rendered in a portal and positioned against its
 * anchor, so it can never be
 * clipped by a grid cell or painted under a neighboring widget, and never
 * runs off the viewport (flips above the anchor and clamps to the edges).
 * Nested popovers (a metric picker inside widget settings) stack correctly:
 * a click inside a child popover does not close its parent.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

type Entry = { id: number; el: HTMLElement | null; close: () => void }
const stack: Entry[] = []
let nextId = 1

const GAP = 6
const EDGE = 8

export function Popover({
  open, onClose, anchorRef, children, align = 'end', width, maxHeight = 520, className = '', scroll = true,
}: {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
  children: ReactNode
  /** Which anchor edge the panel lines up with. */
  align?: 'start' | 'end'
  width?: number
  maxHeight?: number
  className?: string
  /**
   * false = let content overflow the panel (for panels that host the shared
   * <Select>, whose absolutely positioned menu must not be clipped).
   */
  scroll?: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => { closeRef.current = onClose })
  // Side of the anchor the panel opened on. Kept while it stays open, so
  // content that grows or shrinks (typing in a search box) never makes the
  // panel jump from above its anchor to below it.
  const side = useRef<'up' | 'down' | null>(null)

  const place = () => {
    const a = anchorRef.current
    const p = panelRef.current
    if (!a || !p) return
    const r = a.getBoundingClientRect()
    const pw = p.offsetWidth
    const ph = p.scrollHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = align === 'end' ? r.right - pw : r.left
    left = Math.max(EDGE, Math.min(vw - pw - EDGE, left))
    const below = vh - r.bottom - GAP - EDGE
    const above = r.top - GAP - EDGE
    const cap = Math.min(maxHeight, Math.max(below, above))
    let openUp = below < Math.min(ph, maxHeight) && above > below
    if (side.current) openUp = side.current === 'up'
    else side.current = openUp ? 'up' : 'down'
    const maxH = Math.max(160, Math.min(cap, openUp ? above : below))
    const h = Math.min(ph, maxH)
    const top = openUp ? Math.max(EDGE, r.top - GAP - h) : Math.min(vh - EDGE - h, r.bottom + GAP)
    setPos({ top, left, maxH })
  }

  useLayoutEffect(() => {
    if (!open) { setPos(null); side.current = null; return }
    place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // The panel is invisible until positioned, and hidden elements can't take
  // focus, so `autoFocus` would silently fail: focus `[data-autofocus]` here.
  const focused = useRef(false)
  useEffect(() => {
    if (!open) { focused.current = false; return }
    if (!pos || focused.current) return
    focused.current = true
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const entry: Entry = { id: nextId++, el: panelRef.current, close: () => closeRef.current() }
    stack.push(entry)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t)) return
      const idx = stack.findIndex(s => s.id === entry.id)
      // Inside me or any popover opened on top of me: not an outside click.
      if (stack.slice(idx).some(s => s.el?.contains(t))) return
      closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (stack[stack.length - 1]?.id === entry.id) { e.stopPropagation(); closeRef.current() }
    }
    const onMove = () => place()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onMove) : null
    if (ro && panelRef.current) ro.observe(panelRef.current)
    return () => {
      const i = stack.findIndex(s => s.id === entry.id)
      if (i >= 0) stack.splice(i, 1)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  return createPortal(
    <div
      ref={panelRef}
      data-atelier-popover=""
      onMouseDown={e => e.stopPropagation()}
      className={`ody-portal fixed z-[10200] bg-surface-overlay rounded-xl shadow-popover border border-line ${scroll ? 'overflow-y-auto overscroll-contain' : ''} ${className}`}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width,
        maxHeight: scroll ? (pos?.maxH ?? maxHeight) : undefined,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
