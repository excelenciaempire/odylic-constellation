/**
 * Frost for floating glass: menus, popovers, the date picker, the ad drawer and the overlays that float over the 3D
 * canvas (KPI strip, legend, canvas controls, hover card).
 *
 * Atelier gives these a live backdrop blur. Here they float over a canvas that animates at up to 120 fps, and a
 * backdrop blur would be redone on every frame. Instead each one paints the ground's pre-blurred render on itself,
 * lined up with the ground behind it, under its own tint: thick glass that hides the moving cards and costs nothing
 * per frame. The face is a CSS variable (`--gf-face`, read by odylic.css) set before the browser paints: in the
 * mutation or resize callback that moved the element.
 */
import { FROST_SELECTOR, faceCSS, groundGeometry, type Geo } from './glassField'

export function startFrost(ground: HTMLElement, frostUrl: string): () => void {
  let stopped = false
  let frame = 0
  const last = new WeakMap<Element, string>()
  const watched = new Set<Element>()

  const geo = (): Geo => {
    const r = ground.getBoundingClientRect()
    return groundGeometry(ground, { x: r.left, y: r.top, w: r.width, h: r.height })
  }

  const ro = new ResizeObserver(() => update())

  function update() {
    if (stopped) return
    const els = document.querySelectorAll<HTMLElement>(FROST_SELECTOR)
    if (!els.length && !watched.size) return
    const g = geo()
    for (const el of els) {
      if (!watched.has(el)) { watched.add(el); ro.observe(el) }
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      const v = faceCSS(frostUrl, g, r.left, r.top)
      if (last.get(el) !== v) {
        last.set(el, v)
        el.style.setProperty('--gf-face', v)
      }
    }
    for (const el of watched) if (!el.isConnected) { watched.delete(el); ro.unobserve(el) }
  }

  const later = () => {
    if (frame) return
    frame = requestAnimationFrame(() => { frame = 0; update() })
  }

  // An element that appears, or moves by a style or class change (a popover placing itself, the hover card following
  // the pointer), is painted in the same task, before the browser draws it.
  const mo = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if ((r.target as Element).matches?.(FROST_SELECTOR)) { update(); return }
        continue
      }
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && ((n as Element).matches(FROST_SELECTOR) || (n as Element).querySelector(FROST_SELECTOR))) {
          update()
          return
        }
      }
    }
  })
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
  window.addEventListener('resize', later)
  window.addEventListener('scroll', later, { capture: true, passive: true })
  // slide-ins (the drawer) and CSS transitions end where the next measure finds them
  document.addEventListener('animationend', later, true)
  document.addEventListener('transitionend', later, true)
  update()

  return () => {
    stopped = true
    cancelAnimationFrame(frame)
    mo.disconnect()
    ro.disconnect()
    window.removeEventListener('resize', later)
    window.removeEventListener('scroll', later, { capture: true })
    document.removeEventListener('animationend', later, true)
    document.removeEventListener('transitionend', later, true)
    for (const el of watched) (el as HTMLElement).style?.removeProperty('--gf-face')
    watched.clear()
  }
}
