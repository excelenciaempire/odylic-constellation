/**
 * The group menu: right-click a legend row, a group label in the space, or a
 * card (for its group). Isolate the group in the model (everything else
 * darkens and stops taking clicks, the camera stays where it is), or take its
 * creatives into a plain grid or a slideshow.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Focus, LayoutGrid, Presentation } from 'lucide-react'
import { OPTION_ROW, PANEL } from '../ui/theme'

export type GroupAction = 'isolate' | 'show-all' | 'grid' | 'slides'

const EDGE = 8

export function GroupMenu({ x, y, name, color, count, isolated, onAction, onClose }: {
  /** Client coordinates of the right-click. */
  x: number
  y: number
  name: string
  color: string
  count: number
  /** This group is the one isolated right now. */
  isolated: boolean
  onAction: (a: GroupAction) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Open at the pointer, kept on screen (flips left or up near an edge).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth, h = el.offsetHeight
    const left = x + w + EDGE > window.innerWidth ? Math.max(EDGE, x - w) : x
    const top = y + h + EDGE > window.innerHeight ? Math.max(EDGE, y - h) : y
    setPos({ left, top })
  }, [x, y])

  useEffect(() => {
    const away = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    const close = () => onClose()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('contextmenu', away, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('contextmenu', away, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [onClose])

  const item = (a: GroupAction, icon: React.ReactNode, label: string, hint: string) => (
    <button type="button" role="menuitem" className={`${OPTION_ROW} !justify-start gap-2.5`}
      onClick={() => { onAction(a); onClose() }}>
      <span className="text-text-muted shrink-0">{icon}</span>
      <span className="flex flex-col min-w-0">
        <span className="text-text-primary">{label}</span>
        <span className="text-[10.5px] text-text-muted leading-snug">{hint}</span>
      </span>
    </button>
  )

  return createPortal(
    <div ref={ref} role="menu" aria-label={`${name} actions`}
      className={`fixed z-[60] w-[248px] ${PANEL} ody-menu`}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={e => e.preventDefault()}>
      <div className="px-3 pt-1.5 pb-1.5 mb-1 border-b border-line flex items-center gap-2 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-[11.5px] font-medium text-text-primary truncate">{name}</span>
        <span className="ml-auto text-[10.5px] text-text-muted tabular-nums shrink-0">{count} {count === 1 ? 'creative' : 'creatives'}</span>
      </div>
      {isolated
        ? item('show-all', <Eye size={14} />, 'Show all groups', 'Bring every other group back')
        : item('isolate', <Focus size={14} />, 'Isolate in model', 'Darken the rest and keep this group in place')}
      {item('grid', <LayoutGrid size={14} />, 'Isolate into plain view', 'These creatives in a simple grid')}
      {item('slides', <Presentation size={14} />, 'Isolate into slideshow', 'One creative at a time, with its metrics')}
    </div>,
    document.body,
  )
}
