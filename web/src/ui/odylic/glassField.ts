/**
 * The glass field, ported from Atelier (its glassField.ts, Oct 5 2026) and trimmed
 * to what Constellation needs: one ground (the Creative Analysis "fan", by night and its daylight grade by day), no
 * rail, no widget grid.
 *
 * Every glass surface that sits on the ground (the space panel, the header's pills and buttons, the onboarding
 * cards) gets one static layer BEHIND the content, inside the ground host:
 *   - frost: a pre-blurred, pre-saturated copy of the ground (grounds/fan-frost.avif) lined up with the ground, as a
 *     plain CSS background;
 *   - edge: canvases drawn once from the full-resolution render (glassRim.ts) by a worker: along the rim the ground
 *     is bent inward along the rounded rectangle's normal, red and blue split a little from each other, faded into the frost.
 * Nothing is filtered at paint time, so the 3D canvas can animate at 120 fps over it.
 *
 * Surfaces inside another surface show their parent's glass. Floating UI (menus, popovers, the drawer, the overlays
 * over the canvas) is left to frost.ts, which paints the same frost on the element itself so nothing behind it, the
 * moving cards included, shows through.
 */
import { ART_H, ART_W, DAY_FRINGE, FRINGE, drawRimTile, rimTiles, type RimJob, type Size, type Tile } from './glassRim'
import fan from './grounds/fan.avif'
import fanFrost from './grounds/fan-frost.avif'
import fanDay from './grounds/fan-day.avif'
import fanDayFrost from './grounds/fan-day-frost.avif'

export type Art = { sharp: string; frost: string }

/** The fan render (sharp and pre-blurred), by night or by day. Both are 3392 x 5056. */
export function groundArt(day: boolean): Art {
  return day ? { sharp: fanDay, frost: fanDayFrost } : { sharp: fan, frost: fanFrost }
}

/** Glass that sits in the page: what the field draws under. */
export const FIELD_SELECTOR = [
  '.ody-glass', '.atelier-section', '.atelier-tile', '.glass', '.ody-pill', 'button.rounded-full[aria-haspopup]',
  '[data-seg="pill"] [role="tab"]', '.ody-chip', '.ody-tag', '.ody-badge', '.ody-btn-icon', '.ody-btn-secondary',
  '.ody-btn-primary', '.ody-field',
].join(', ')

/** Floating UI: painted by frost.ts on the element itself (it floats over the canvas or the page). */
export const FROST_SELECTOR = [
  '.ody-frost', '.ody-overlay', '.ody-menu', '[data-atelier-popover]', '.ody-modal', '.fv-drawer',
  '.shadow-popover:not(img)',
].join(', ')

/** Never drawn by the field: floating UI and anything inside it. */
const OVERLAY_SELECTOR = [
  FROST_SELECTOR, '[role="dialog"]', '[role="menu"]', '[role="listbox"]', '[role="tooltip"]',
].join(', ')

export type Geo = { gx: number; gy: number; gw: number; dx: number; dy: number; dw: number; dh: number; scrim: string; scrimH: number }

/** Where the render lands on a ground box (cover, centred across and anchored at `fy` down it, as odylic.css draws
 *  it: 0 is the top), in the box's own coordinates, with the ground's header shade. */
export function coverOf(gx: number, gy: number, gw: number, gh: number, scrim: string, scrimH: number, fy = 0): Geo {
  const s = Math.max(gw / ART_W, gh / ART_H)
  const dw = ART_W * s
  const dh = ART_H * s
  return { gx, gy, gw, dx: gx + (gw - dw) / 2, dy: gy + (gh - dh) * fy, dw, dh, scrim, scrimH }
}

/** How far down its render a ground is anchored (0 top, 1 bottom), read from the image layer's own CSS
 *  (`--ody-gpos`), so the frost and the rims always line up with what the ground shows. */
export function groundAnchorY(ground: Element): number {
  const v = getComputedStyle(ground, '::before').backgroundPositionY
  return v.endsWith('%') ? Math.min(1, Math.max(0, parseFloat(v) / 100 || 0)) : 0
}

/** CSS background for a face at (x, y), width w, in the same coordinates as `geo`: the header shade, then the render
 *  lined up with the ground. */
export function faceCSS(url: string, geo: Geo, x: number, y: number): string {
  const fx = geo.dx - x
  const fy = geo.dy - y
  const shade = geo.scrim ? `${geo.scrim} 0 ${Math.round(geo.gy - y)}px / 100% ${geo.scrimH}px no-repeat, ` : ''
  return `${shade}url("${url}") ${fx.toFixed(1)}px ${fy.toFixed(1)}px / ${geo.dw.toFixed(1)}px ${geo.dh.toFixed(1)}px no-repeat`
}

/** The ground's geometry in its own box (offset coordinates inside the host). */
export function groundGeometry(ground: HTMLElement, box: { x: number; y: number; w: number; h: number }): Geo {
  const cs = getComputedStyle(ground)
  return coverOf(box.x, box.y, box.w, box.h, cs.getPropertyValue('--ody-scrim').trim(),
    parseFloat(cs.getPropertyValue('--ody-scrim-h')) || 380, groundAnchorY(ground))
}

/** A face with a surface's veil laid over it (the rim, drawn above the frost, is left as it is). */
const veiled = (veil: string, face: string) => (veil ? `linear-gradient(${veil}, ${veil}), ${face}` : face)

const images = new Map<string, Promise<HTMLImageElement>>()
function loadImage(url: string): Promise<HTMLImageElement> {
  let p = images.get(url)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = url
    })
    images.set(url, p)
  }
  return p
}

/** The header shade's stops, read from the computed `--ody-scrim` (rgba colour and px position pairs). */
function scrimStops(scrim: string): Array<{ color: string; at: number }> {
  const out: Array<{ color: string; at: number }> = []
  const re = /(rgba?\([^)]*\))\s+(-?[\d.]+)px/g
  let m: RegExpExecArray | null
  while ((m = re.exec(scrim))) out.push({ color: m[1], at: parseFloat(m[2]) })
  return out
}

// ---------- the rim worker, shared by every field ----------

type RimReply = { id: number; out?: Array<{ tile: Tile; bitmap: ImageBitmap }>; error?: string }
let rimWorker: Worker | null | undefined
let rimWorkerBroken = false
let nextJob = 1
const waiting = new Map<number, (reply: RimReply) => void>()

/** The worker, started on first use; null where a worker can't draw (the field then draws on the main thread). */
function worker(): Worker | null {
  if (rimWorkerBroken) return null
  if (rimWorker !== undefined) return rimWorker
  rimWorker = null
  try {
    if (typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function') {
      const w = new Worker(new URL('./glassRim.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<RimReply>) => {
        const done = waiting.get(e.data.id)
        waiting.delete(e.data.id)
        done?.(e.data)
      }
      w.onerror = () => retireWorker()
      rimWorker = w
    }
  } catch {
    rimWorker = null
  }
  return rimWorker
}

/** A worker that can't draw (an older Safari without a 2D OffscreenCanvas) is retired for the session. */
function retireWorker() {
  rimWorkerBroken = true
  rimWorker?.terminate()
  rimWorker = null
  const pending = [...waiting.values()]
  waiting.clear()
  for (const done of pending) done({ id: 0, error: 'rim worker retired' })
}

/** `veil`: the surface's --gf-veil, a tint laid over its frost under the rim (Peter, Oct 5 2026: "on dark mode the glass
 *  less transparent, the background is a bit distracting"), so the glass darkens while the rim keeps its colour. */
type Placement = { el: Element; x: number; y: number; w: number; h: number; tracked: boolean; radius: string; size: Size; veil: string }

type Rec = {
  box: HTMLDivElement
  frost: HTMLElement
  lens: HTMLElement | null
  tracked: boolean
  sig: string
  /** what the rim was last drawn for; a new placement queues a redraw */
  drawn: string
  /** the placement a worker job is out for */
  asked: string
  place: Placement | null
}

const RIM_SIZES: Record<string, Size> = { t: 't', tight: 't', s: 's', m: 'm', l: 'l' }

export class GlassField {
  private layer = document.createElement('div')
  private recs = new Map<Element, Rec>()
  private ro: ResizeObserver | null = null
  private surfaceRO: ResizeObserver | null = null
  private mo: MutationObserver | null = null
  private pending = 0
  private timer = 0
  private scrolling = 0
  private lastScroll = 0
  private idle = 0
  private pumpFrame = 0
  private inflight = 0
  private queue: Element[] = []
  /** the main-thread rim in progress, a tile per idle slot (no worker) */
  private slow: { el: Element; rec: Rec; sig: string; job: RimJob; tiles: Tile[]; done: HTMLCanvasElement[] } | null = null
  private geo: Geo | null = null
  private base = '#3B3335'
  private stopped = false
  private marked = new Set<Element>()
  private img: HTMLImageElement | null = null
  private art: Art
  private host: HTMLElement
  private ground: HTMLElement
  private day: boolean
  private dpr = Math.min(2, Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))

  constructor(host: HTMLElement, ground: HTMLElement, day = false) {
    this.host = host
    this.ground = ground
    this.day = day
    this.art = groundArt(day)
  }

  /** False where the field can't help (reduced transparency): CSS keeps an opaque fill. */
  static supported(): boolean {
    if (typeof window === 'undefined') return false
    try { return !window.matchMedia('(prefers-reduced-transparency: reduce)').matches } catch { return true }
  }

  start() {
    this.layer.className = 'ody-gf'
    this.layer.setAttribute('aria-hidden', 'true')
    this.ground.after(this.layer)
    this.host.classList.add('ody-gf-host')

    this.ro = new ResizeObserver(() => this.schedule())
    this.ro.observe(this.host)
    this.ro.observe(this.ground)
    // A drawn surface that changes size moves its layer at once, before the browser paints (the full pass is
    // debounced).
    this.surfaceRO = new ResizeObserver(entries => {
      if (!this.stopped) for (const e of entries) this.follow(e.target)
      this.schedule()
    })
    this.mo = new MutationObserver(records => this.onMutations(records))
    this.mo.observe(this.host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-expanded', 'hidden'] })
    window.addEventListener('resize', this.onResize)
    window.addEventListener('scroll', this.onScroll, { passive: true })
    document.fonts?.ready.then(() => this.schedule()).catch(() => { /* fonts API off */ })
    this.scan()
  }

  stop() {
    this.stopped = true
    this.ro?.disconnect()
    this.surfaceRO?.disconnect()
    this.mo?.disconnect()
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('scroll', this.onScroll)
    window.clearTimeout(this.timer)
    cancelAnimationFrame(this.pending)
    cancelAnimationFrame(this.scrolling)
    cancelAnimationFrame(this.pumpFrame)
    this.cancelIdle()
    this.layer.remove()
    for (const el of this.marked) el.removeAttribute('data-gf')
    this.marked.clear()
    this.host.classList.remove('ody-gf-host')
    this.recs.clear()
  }

  private onResize = () => this.schedule()

  private onScroll = () => {
    this.lastScroll = performance.now()
    if (this.scrolling) return
    this.scrolling = requestAnimationFrame(() => {
      this.scrolling = 0
      this.realignTracked()
    })
  }

  private onMutations(records: MutationRecord[]) {
    if (this.stopped) return
    for (const r of records) {
      const t = r.target as Element
      if (this.layer.contains(t)) continue
      // a change inside a drawn surface (the space panel's overlays, a card grid filling in) is that surface's own
      // business: its resize observer catches a size change
      const surface = t.nodeType === 1 ? t.closest('[data-gf=""]') : null
      if (surface && surface !== t) continue
      this.schedule()
      return
    }
  }

  /** Debounced full pass: mutations come in bursts while a view renders, and nothing is measured mid-scroll. */
  private schedule() {
    if (this.stopped) return
    window.clearTimeout(this.timer)
    const wait = Math.max(90, 180 - (performance.now() - this.lastScroll))
    this.timer = window.setTimeout(() => {
      if (performance.now() - this.lastScroll < 150) return this.schedule()
      cancelAnimationFrame(this.pending)
      this.pending = requestAnimationFrame(() => this.scan())
    }, wait)
  }

  private geometry(): Geo {
    const g = this.ground
    return groundGeometry(g, { x: g.offsetLeft, y: g.offsetTop, w: g.offsetWidth, h: g.offsetHeight })
  }

  private scan() {
    if (this.stopped) return
    const host = this.host
    const hr = host.getBoundingClientRect()
    const geo = this.geometry()
    this.geo = geo
    this.base = getComputedStyle(host).getPropertyValue('--ody-base').trim() || this.base
    const els = Array.from(host.querySelectorAll(FIELD_SELECTOR))
    const field = new Set<Element>(els)
    const scroller = new Map<Element, boolean>()
    const sticky = new Map<Element, boolean>()
    const isScroller = (p: Element) => {
      let v = scroller.get(p)
      if (v === undefined) {
        const cs = getComputedStyle(p)
        v = (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1)
          || (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1)
        scroller.set(p, v)
      }
      return v
    }
    const isSticky = (p: Element) => {
      let v = sticky.get(p)
      if (v === undefined) {
        const pos = getComputedStyle(p).position
        v = pos === 'sticky' || pos === 'fixed'
        sticky.set(p, v)
      }
      return v
    }
    const places: Placement[] = []
    // What the field covers, marked on the element: '' drawn, 'n' inside a drawn surface (its glass shows through).
    const marks = new Map<Element, string>()
    for (const el of els) {
      if (el.closest(OVERLAY_SELECTOR) || el.closest('[class*="opacity-0"]')) continue
      let parent: Element | null = null
      let tracked = isSticky(el)
      let skip = false
      for (let p = el.parentElement; p && p !== host; p = p.parentElement) {
        if (field.has(p)) { parent = p; break }
        if (isScroller(p)) { skip = true; break }
        if (!tracked && isSticky(p)) tracked = true
      }
      if (parent) {
        if (marks.has(parent)) marks.set(el, 'n')
        continue
      }
      if (skip) continue
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue
      // A big panel's wide rim needs room: on a phone its text sits 16 to 24px from the edge, right over the band,
      // so panels take the medium rim there. data-gf-rim picks one outright.
      const asked = RIM_SIZES[el.getAttribute('data-gf-rim') || '']
      const size: Size = asked
        || (el.matches('.ody-glass, .atelier-section') ? (window.innerWidth < 640 ? 'm' : 'l') : Math.min(r.width, r.height) <= 48 ? 's' : 'm')
      places.push({ el, x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height, tracked, radius: cs.borderRadius, size,
        veil: cs.getPropertyValue('--gf-veil').trim() })
      marks.set(el, '')
    }
    for (const el of this.marked) if (!marks.has(el)) el.removeAttribute('data-gf')
    for (const [el, v] of marks) if (el.getAttribute('data-gf') !== v) el.setAttribute('data-gf', v)
    this.marked = new Set(marks.keys())
    const seen = new Set<Element>()
    for (const p of places) {
      seen.add(p.el)
      this.place(p, geo)
    }
    for (const [el, rec] of this.recs) {
      if (!seen.has(el)) { rec.box.remove(); this.recs.delete(el); this.surfaceRO?.unobserve(el) }
    }
  }

  /** Re-place one drawn surface's layer from its current box, keeping its rim size, radius and tracking. */
  private follow(el: Element) {
    const p = this.recs.get(el)?.place
    if (!p || !this.geo) return
    const hr = this.host.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return
    this.place({ ...p, x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height }, this.geo)
  }

  private place(p: Placement, geo: Geo) {
    const { el, x, y, w, h, tracked, radius, size, veil } = p
    const sig = `${x.toFixed(1)},${y.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)},${radius},${tracked ? 1 : 0},${size},${veil},${geo.dw.toFixed(1)},${geo.dh.toFixed(1)},${geo.dy.toFixed(1)},${geo.scrimH}`
    let rec = this.recs.get(el)
    if (rec && rec.sig === sig) return
    if (!rec || rec.tracked !== tracked) {
      rec?.box.remove()
      const box = document.createElement('div')
      box.className = 'ody-gf-l'
      const frost = document.createElement('i')
      frost.className = 'ody-gf-frost'
      box.appendChild(frost)
      let lens: HTMLElement | null = null
      if (!tracked) {
        lens = document.createElement('i')
        lens.className = 'ody-gf-lens'
        box.appendChild(lens)
      }
      this.layer.appendChild(box)
      rec = { box, frost, lens, tracked, sig: '', drawn: '', asked: '', place: null }
      this.recs.set(el, rec)
      this.surfaceRO?.observe(el)
    }
    rec.sig = sig
    rec.place = p
    const b = rec.box.style
    b.left = `${x}px`
    b.top = `${y}px`
    b.width = `${w}px`
    b.height = `${h}px`
    b.borderRadius = radius
    rec.frost.style.background = veiled(veil, faceCSS(this.art.frost, geo, x, y))
    if (rec.lens) this.enqueue(el)
  }

  // ---------- the rim: drawn by the worker, placed here ----------

  private enqueue(el: Element) {
    if (!this.queue.includes(el)) this.queue.push(el)
    this.kick()
  }

  /** Next frame: hand queued rims to the worker (or to idle time on the main thread). */
  private kick() {
    if (this.stopped || this.pumpFrame) return
    this.pumpFrame = requestAnimationFrame(() => {
      this.pumpFrame = 0
      this.pump()
    })
  }

  /** The queued surface nearest the window (on screen first), taken off the queue. */
  private takeNext(): Element | undefined {
    if (!this.queue.length) return undefined
    const top = this.host.getBoundingClientRect().top
    const vh = window.innerHeight || 800
    let best = 0
    let bestGap = Infinity
    for (let i = 0; i < this.queue.length; i++) {
      const p = this.recs.get(this.queue[i])?.place
      if (!p) continue
      const y0 = top + p.y
      const gap = Math.max(0, y0 - vh, -(y0 + p.h))
      if (gap < bestGap) { best = i; bestGap = gap }
      if (gap === 0) break
    }
    return this.queue.splice(best, 1)[0]
  }

  private jobFor(rec: Rec): RimJob {
    const p = rec.place!
    const g = this.geo || this.geometry()
    return {
      x: p.x, y: p.y, w: p.w, h: p.h, r: parseFloat(p.radius) || 0, size: p.size, dpr: this.dpr,
      geo: { gx: g.gx, gy: g.gy, gw: g.gw, dx: g.dx, dy: g.dy, dw: g.dw, dh: g.dh, scrimH: g.scrimH },
      stops: scrimStops(g.scrim), base: this.base, mirror: false, fringe: this.day ? DAY_FRINGE : FRINGE,
    }
  }

  private pump() {
    if (this.stopped) return
    const w = worker()
    if (!w) {
      if (!this.idle) this.requestIdle()
      return
    }
    const url = new URL(this.art.sharp, window.location.href).href
    // two jobs out at a time: results stay fresh, and a surface that moves again isn't drawn twice for nothing
    while (this.inflight < 2) {
      const el = this.takeNext()
      if (!el) break
      const rec = this.recs.get(el)
      if (!rec || !rec.lens || !rec.place || rec.drawn === rec.sig || rec.asked === rec.sig) continue
      const job = this.jobFor(rec)
      const sig = rec.sig
      const id = nextJob++
      rec.asked = sig
      this.inflight++
      waiting.set(id, reply => {
        this.inflight--
        if (rec.asked === sig) rec.asked = ''
        if (reply.error || !reply.out) {
          // this browser's worker can't draw: the main thread takes over
          if (!rimWorkerBroken) retireWorker()
          if (!this.stopped) this.enqueue(el)
          return
        }
        if (!this.stopped && rec.sig === sig && this.recs.get(el) === rec) {
          this.apply(rec, reply.out.map(o => ({ tile: o.tile, src: o.bitmap })), job.dpr)
          rec.drawn = sig
        } else {
          for (const o of reply.out) o.bitmap.close()
        }
        this.kick()
      })
      w.postMessage({ id, url, job, tiles: rimTiles(job) })
    }
  }

  /** Swap a surface's rim for new tiles. Each tile hugs the edge it belongs to, so a surface that grows keeps its
   *  rim on its edges until the redraw lands (a side may stop short for a moment). */
  private apply(rec: Rec, tiles: Array<{ tile: Tile; src: ImageBitmap | HTMLCanvasElement }>, dpr: number) {
    const p = rec.place!
    const W = Math.round(p.w * dpr)
    const H = Math.round(p.h * dpr)
    const frag = document.createDocumentFragment()
    for (const { tile: [ox, oy, cw, ch], src } of tiles) {
      let cv: HTMLCanvasElement
      if (src instanceof HTMLCanvasElement) {
        cv = src
      } else {
        cv = document.createElement('canvas')
        const br = cv.getContext('bitmaprenderer')
        if (br) {
          br.transferFromImageBitmap(src)
        } else {
          cv.width = cw
          cv.height = ch
          cv.getContext('2d')?.drawImage(src, 0, 0)
          src.close()
        }
      }
      const across = ox > 0 && ox + cw >= W ? `right:${(W - ox - cw) / dpr}px` : `left:${ox / dpr}px`
      const down = oy > 0 && oy + ch >= H ? `bottom:${(H - oy - ch) / dpr}px` : `top:${oy / dpr}px`
      cv.style.cssText = `position:absolute;${across};${down};width:${cw / dpr}px;height:${ch / dpr}px`
      frag.appendChild(cv)
    }
    rec.lens!.replaceChildren(frag)
  }

  // ---------- no worker: the main thread draws a tile per idle slot ----------

  private requestIdle() {
    const w = window as Window & { requestIdleCallback?: (cb: (d: { timeRemaining: () => number }) => void, o?: { timeout: number }) => number }
    if (w.requestIdleCallback) this.idle = w.requestIdleCallback(d => this.drain(() => d.timeRemaining()), { timeout: 400 })
    else this.idle = window.setTimeout(() => { const t0 = performance.now(); this.drain(() => 12 - (performance.now() - t0)) }, 16)
  }

  private cancelIdle() {
    const w = window as Window & { cancelIdleCallback?: (id: number) => void }
    if (w.cancelIdleCallback) w.cancelIdleCallback(this.idle)
    else window.clearTimeout(this.idle)
    this.idle = 0
  }

  private drain(left: () => number) {
    this.idle = 0
    if (this.stopped) return
    if (worker()) { this.kick(); return }
    if (!this.img) {
      loadImage(this.art.sharp).then(img => {
        this.img = img
        if (!this.stopped) this.requestIdle()
      }).catch(() => { /* the frost alone still reads as glass */ })
      return
    }
    // never draw mid-scroll: the next idle slot after the page settles picks it up
    if (performance.now() - this.lastScroll < 150) { this.requestIdle(); return }
    while (left() > 3) {
      if (!this.slow) {
        const el = this.takeNext()
        if (!el) break
        const rec = this.recs.get(el)
        if (!rec || !rec.lens || !rec.place || rec.drawn === rec.sig) continue
        const job = this.jobFor(rec)
        this.slow = { el, rec, sig: rec.sig, job, tiles: rimTiles(job), done: [] }
      }
      const s = this.slow
      if (s.rec.sig !== s.sig || this.recs.get(s.el) !== s.rec) { this.slow = null; continue }
      const tile = s.tiles[s.done.length]
      const data = drawRimTile(this.img, s.job, tile, (w, h) => {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        return c.getContext('2d', { willReadFrequently: true })
      })
      const cv = document.createElement('canvas')
      cv.width = tile[2]
      cv.height = tile[3]
      if (data) cv.getContext('2d')?.putImageData(data, 0, 0)
      s.done.push(cv)
      if (s.done.length === s.tiles.length) {
        this.apply(s.rec, s.tiles.map((t, i) => ({ tile: t, src: s.done[i] })), s.job.dpr)
        s.rec.drawn = s.sig
        this.slow = null
      }
    }
    if (this.queue.length || this.slow) this.requestIdle()
  }

  /** Sticky surfaces moved against the ground: read every rect, then write (no layout thrash). */
  private realignTracked() {
    if (this.stopped) return
    const tracked = [...this.recs].filter(([, r]) => r.tracked)
    if (!tracked.length) return
    const hr = this.host.getBoundingClientRect()
    const geo = this.geo || this.geometry()
    const reads = tracked.map(([el, rec]) => ({ rec, r: el.getBoundingClientRect() }))
    for (const { rec, r } of reads) {
      const x = r.left - hr.left
      const y = r.top - hr.top
      const at = rec.place
      if (at && Math.abs(at.x - x) < 0.5 && Math.abs(at.y - y) < 0.5 && Math.abs(at.w - r.width) < 0.5) continue
      if (at) { at.x = x; at.y = y; at.w = r.width }
      rec.box.style.left = `${x}px`
      rec.box.style.top = `${y}px`
      rec.frost.style.background = veiled(at?.veil || '', faceCSS(this.art.frost, geo, x, y))
    }
  }
}
