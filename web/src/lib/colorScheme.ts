/**
 * Light, Dark or System. Dark is the default: the app sits on Atelier's dark
 * "fan" ground; Light is its daylight grade. Stored per browser; index.html
 * applies the same rules before the first paint (keep the two in step).
 *
 * <html> carries the Odylic look's scope classes (ui/odylic/odylic.css):
 * `ody-scope` always, plus `ody-night ody-ground-dark` or `ody-day
 * ody-ground-light`, so portals (menus, the date picker) carry the look too.
 */
import { useEffect, useState } from 'react'

export type Scheme = 'light' | 'dark' | 'system'
export type Resolved = 'light' | 'dark'

const KEY = 'fv.theme'
const EVENT = 'fv:scheme'

const darkQuery = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)') : null)

export function getScheme(): Scheme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'system' ? v : 'dark'
  } catch {
    return 'dark'
  }
}

/** What the page shows for a scheme: System follows the OS, and falls back to dark where it can't tell. */
export function resolveScheme(s: Scheme = getScheme()): Resolved {
  if (s !== 'system') return s
  const q = darkQuery()
  return q && !q.matches ? 'light' : 'dark'
}

/** Put a scheme on <html>: data-theme for an explicit pick, and the look's scope classes. */
export function applyScheme(s: Scheme = getScheme()): void {
  const el = document.documentElement
  if (s === 'system') delete el.dataset.theme
  else el.dataset.theme = s
  const day = resolveScheme(s) === 'light'
  el.classList.add('ody-scope')
  el.classList.toggle('ody-day', day)
  el.classList.toggle('ody-ground-light', day)
  el.classList.toggle('ody-night', !day)
  el.classList.toggle('ody-ground-dark', !day)
  window.dispatchEvent(new Event(EVENT))
}

export function setScheme(s: Scheme): void {
  try { localStorage.setItem(KEY, s) } catch { /* storage off */ }
  applyScheme(s)
}

/** Follow the OS while the scheme is System. Call once at startup. */
export function watchSystemScheme(): () => void {
  const q = darkQuery()
  if (!q) return () => {}
  const on = () => { if (getScheme() === 'system') applyScheme('system') }
  q.addEventListener('change', on)
  return () => q.removeEventListener('change', on)
}

/** Light or dark as shown right now; re-renders when it changes. */
export function useResolvedTheme(): Resolved {
  const [r, setR] = useState<Resolved>(() => resolveScheme())
  useEffect(() => {
    const sync = () => setR(resolveScheme())
    window.addEventListener(EVENT, sync)
    sync()
    return () => window.removeEventListener(EVENT, sync)
  }, [])
  return r
}
