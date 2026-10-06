/**
 * The page ground (Atelier's Creative Analysis "fan", ported from ui/odylic/LiquidGlass.tsx): a host with the ground
 * image as its bottom layer, and the glass field drawing the frost and the liquid rim of every glass surface on it.
 * Floating glass (menus, the drawer, the overlays over the 3D canvas) takes the same frost through frost.ts.
 *
 * The host runs from the top of the window, under the header, so the bar's controls are glass on the same ground.
 * It covers the content up to `maxViewports` window heights; past that the base colour continues, with a fade.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useResolvedTheme } from '../../lib/colorScheme'
import { GlassField, groundArt } from './glassField'
import { startFrost } from './frost'
import './odylic.css'
import './constellation.css'

export function Ground({ className = '', maxViewports = 2.5, children }: {
  className?: string
  maxViewports?: number
  children?: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const groundRef = useRef<HTMLDivElement | null>(null)
  const day = useResolvedTheme() === 'light'

  useLayoutEffect(() => {
    const host = hostRef.current
    const ground = groundRef.current
    if (!host || !ground) return
    const size = () => {
      const vh = window.innerHeight || 800
      // never taller than the host, at most maxViewports windows
      const h = Math.round(Math.min(host.scrollHeight, Math.max(vh, Math.min(host.scrollHeight, vh * maxViewports))))
      ground.style.height = `${h}px`
      host.toggleAttribute('data-cut', host.scrollHeight > h + 1)
    }
    size()
    window.addEventListener('resize', size)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size)
    ro?.observe(host)
    return () => {
      window.removeEventListener('resize', size)
      ro?.disconnect()
    }
  }, [maxViewports])

  // the frost and the liquid edge of every surface on this ground, drawn once (./glassField.ts), and the frost of
  // everything that floats (./frost.ts)
  useEffect(() => {
    const host = hostRef.current
    const ground = groundRef.current
    if (!host || !ground || !GlassField.supported()) return
    const field = new GlassField(host, ground, day)
    field.start()
    const stopFrost = startFrost(ground, groundArt(day).frost)
    return () => {
      field.stop()
      stopFrost()
    }
  }, [day])

  return (
    <div ref={hostRef} className={`ody-ground-host ${className}`}>
      <div ref={groundRef} className="ody-ground ody-bg-fan" aria-hidden="true" />
      {children}
    </div>
  )
}
