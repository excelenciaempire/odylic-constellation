/**
 * Thumbnails for the creative space: decoded off the main thread, then kept
 * as small rounded bitmaps in three sizes (192, 96 and 48px on the long
 * side). The engine draws the size nearest the card's on-screen size, so a
 * card 60px wide never samples a 192px bitmap: drawing stays cheap and small
 * cards don't shimmer while they move. The hairline edge is drawn at render
 * time (crisp at any zoom), so the bitmaps carry only the image and its
 * rounded corners.
 *
 * Ported from Atelier. Every ad has one source here, the backend's
 * disk-cached proxy /api/thumb/{ad_id}. Loads run a few at a time (biggest
 * spender first), so 300 cards never hit the local server all at once.
 */
import { thumbUrl } from '../lib/api'

/** One pre-scaled, rounded bitmap of a thumbnail. */
export type ThumbLevel = { img: CanvasImageSource; w: number; h: number }
/** A thumbnail: its aspect ratio and its sizes, largest first, plus the
 *  source it came from (for the full-resolution image, see hiResThumb). */
export type BakedThumb = { ar: number; levels: ThumbLevel[]; url?: string }
export type ThumbSource = { url: string; cacheOnly: boolean }

/** Long side of each pre-scaled size, largest first (each half the last). */
const LEVELS = [192, 96, 48]
/** Corner radius as a share of the bitmap's width (the engine strokes the
 *  hairline with the same share of the drawn width, so they line up). */
export const THUMB_RADIUS = 0.045
/** Transparent creatives sit on white, as they do in Meta's feed. */
const MATTE = '#ffffff'

// Bitmaps by source URL, shared across mounts (switching views and back is
// instant). Least recently used drops first; dropped bitmaps are left to the
// garbage collector, never closed, since a live view may still draw them.
const BAKED = new Map<string, BakedThumb>()
// ~700 thumbnails at 192px (plus the 96 and 48px sizes, +31%) stays near the
// old 900 x 160px memory ceiling.
const BAKED_MAX = 700
// Sources that failed this session, so a remount doesn't retry them.
const DEAD = new Set<string>()
const MAX_INFLIGHT = 4

function remember(url: string, b: BakedThumb) {
  BAKED.delete(url)
  BAKED.set(url, b)
  if (BAKED.size > BAKED_MAX) {
    const oldest = BAKED.keys().next().value
    if (oldest !== undefined) BAKED.delete(oldest)
  }
}

function recall(url: string): BakedThumb | undefined {
  const b = BAKED.get(url)
  if (b) remember(url, b)
  return b
}

/** `version` is the ad's creative_hash: an edited creative gets a new URL, so
 *  neither this cache nor the browser's keeps showing the old image. */
export function spaceThumbSources(adId: string, demo: boolean, version?: string | null): ThumbSource[] {
  return [{ url: thumbUrl(adId, demo, version), cacheOnly: false }]
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      if (img.naturalWidth <= 4 || img.naturalHeight <= 4) { resolve(null); return }
      // Decode off the main thread when the browser will (decode() never
      // settles in a hidden page, so it gets a short leash, never the queue).
      const done = () => resolve(img)
      const t = setTimeout(done, 250)
      img.decode().then(() => { clearTimeout(t); done() }, () => { clearTimeout(t); done() })
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

type Decoded = { src: CanvasImageSource; w: number; h: number; release: () => void }

/**
 * The image decoded off the main thread and already downsized so its height
 * is about the largest size: createImageBitmap on the bytes does both on a
 * decoder thread. Same-origin sources only (the API); `cacheOnly` reads the
 * HTTP cache and never the network. Anything else (the standalone report's
 * CDN URLs) goes through an <img> and decode().
 */
async function decode(url: string, cacheOnly: boolean): Promise<Decoded | null> {
  const sameOrigin = url.startsWith('/')
  if (sameOrigin && typeof createImageBitmap === 'function') {
    let blob: Blob
    try {
      const r = await fetch(url, cacheOnly ? { cache: 'only-if-cached', mode: 'same-origin' } : undefined)
      if (!r.ok) return null
      blob = await r.blob()
    } catch {
      return null
    }
    if (!blob.size || !blob.type.startsWith('image/')) return null
    try {
      // Height-bound: most creatives are portrait or square, so this is the
      // final size; a wide one is cropped and resized once more below.
      const bmp = await createImageBitmap(blob, { resizeHeight: LEVELS[0], resizeQuality: 'high' })
      if (bmp.width > 4 && bmp.height > 4) return { src: bmp, w: bmp.width, h: bmp.height, release: () => bmp.close() }
      bmp.close()
      return null
    } catch {
      // A format createImageBitmap can't take (SVG): the <img> path below.
      const obj = URL.createObjectURL(blob)
      try {
        const img = await loadImage(obj)
        return img ? { src: img, w: img.naturalWidth, h: img.naturalHeight, release: () => {} } : null
      } finally {
        URL.revokeObjectURL(obj)
      }
    }
  }
  if (cacheOnly) return null
  const img = await loadImage(url)
  return img ? { src: img, w: img.naturalWidth, h: img.naturalHeight, release: () => {} } : null
}

type Surface = { el: OffscreenCanvas | HTMLCanvasElement; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D }

function surface(w: number, h: number): Surface | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const el = new OffscreenCanvas(w, h)
    const ctx = el.getContext('2d')
    if (ctx) return { el, ctx }
  }
  const el = document.createElement('canvas')
  el.width = w
  el.height = h
  const ctx = el.getContext('2d')
  return ctx ? { el, ctx } : null
}

/**
 * The rounded bitmaps, largest first. Extreme shapes center-crop to
 * 9:16 .. 1.91:1. Each size samples the one before it (a 2x step), so only
 * the first pass touches the decoded image.
 */
function cropOf(w: number, h: number) {
  let sx = 0, sy = 0, sw = w, sh = h
  let ar = sw / sh || 1
  if (ar < 0.5625) { const nh = sw / 0.5625; sy = (sh - nh) / 2; sh = nh; ar = 0.5625 }
  else if (ar > 1.91) { const nw = sh * 1.91; sx = (sw - nw) / 2; sw = nw; ar = 1.91 }
  return { sx, sy, sw, sh, ar }
}

function bakeLevels(d: Decoded): BakedThumb | null {
  const { sx, sy, sw, sh, ar } = cropOf(d.w, d.h)
  const levels: ThumbLevel[] = []
  let from: { img: CanvasImageSource; sx: number; sy: number; sw: number; sh: number } = { img: d.src, sx, sy, sw, sh }
  for (const M of LEVELS) {
    const w = ar >= 1 ? M : Math.max(1, Math.round(M * ar))
    const h = ar >= 1 ? Math.max(1, Math.round(M / ar)) : M
    const s = surface(w, h)
    if (!s) return levels.length ? { ar, levels } : null
    const c = s.ctx
    c.beginPath(); c.roundRect(0, 0, w, h, Math.max(1, w * THUMB_RADIUS)); c.clip()
    c.fillStyle = MATTE; c.fillRect(0, 0, w, h)
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(from.img, from.sx, from.sy, from.sw, from.sh, 0, 0, w, h)
    const img: CanvasImageSource = s.el instanceof HTMLCanvasElement ? s.el : s.el.transferToImageBitmap()
    levels.push({ img, w, h })
    from = { img, sx: 0, sy: 0, sw: w, sh: h }
  }
  return { ar: levels[0].w / levels[0].h, levels }
}

// ── Full resolution, for a card zoomed in close ──────────────────────────

/** Long side of the full-resolution bitmap: a card filling a laptop screen at 2x. */
const HI_MAX_SIDE = 1400
/** Full-resolution bitmaps kept. The engine asks for at most HIRES_PER_FRAME
 *  (12) per frame, so this always has room for every card on screen. */
const HI_KEEP = 16
/** Full-resolution decodes run at most this many at a time. */
const HI_MAX_INFLIGHT = 2
type HiEntry = ThumbLevel & { frame: number }
const HI = new Map<string, HiEntry>()
// Waiting to decode: the last frame that asked, and who to tell.
const HI_QUEUE = new Map<string, { frame: number; onReady: () => void }>()
const HI_PENDING = new Set<string>()
// Sources with nothing bigger than the baked sizes (or that failed): never asked again.
const HI_NONE = new Set<string>()
// The newest frame number seen: an entry drawn in it is on screen right now.
let hiFrame = 0

function closeLevel(lv: ThumbLevel) {
  if (typeof ImageBitmap !== 'undefined' && lv.img instanceof ImageBitmap) lv.img.close()
}

/** Make room for one more: drop the least recently drawn entry that is not on
 *  screen this frame. False when every entry is (the new one is dropped). */
function hiMakeRoom(): boolean {
  if (HI.size < HI_KEEP) return true
  for (const [url, e] of HI) {  // oldest first
    if (e.frame < hiFrame) {
      HI.delete(url)
      closeLevel(e)  // drawImage copies at once, so nothing still reads it
      return true
    }
  }
  return false
}

function hiPump() {
  while (HI_PENDING.size < HI_MAX_INFLIGHT && HI_QUEUE.size) {
    // Newest request first: the card being looked at now, not one zoomed past.
    let pick: string | null = null, best = -1
    for (const [url, q] of HI_QUEUE) if (q.frame > best) { best = q.frame; pick = url }
    const url = pick!
    const { frame, onReady } = HI_QUEUE.get(url)!
    HI_QUEUE.delete(url)
    if (frame < hiFrame - 2) continue  // no longer drawn large: not worth decoding
    HI_PENDING.add(url)
    void decodeFull(url).then(lv => {
      HI_PENDING.delete(url)
      if (!lv) { HI_NONE.add(url) } else if (hiMakeRoom()) {
        HI.set(url, { ...lv, frame })
        onReady()
      } else {
        closeLevel(lv)
      }
      hiPump()
    })
  }
}

/**
 * The full-resolution rounded bitmap of a thumbnail, or undefined while it
 * decodes (`onReady` fires once it can be drawn). Only the largest cards on
 * screen ask for it (`frame` is the engine's frame number), so a zoomed-out
 * view never holds big images. The bytes come from the same URL as the small
 * sizes, so the browser cache usually serves them.
 */
export function hiResThumb(b: BakedThumb, onReady: () => void, frame: number): ThumbLevel | undefined {
  const url = b.url
  if (!url) return undefined
  if (frame > hiFrame) hiFrame = frame
  const hit = HI.get(url)
  if (hit) { hit.frame = frame; HI.delete(url); HI.set(url, hit); return hit }
  if (HI_PENDING.has(url) || HI_NONE.has(url)) return undefined
  HI_QUEUE.set(url, { frame, onReady })
  hiPump()
  return undefined
}

async function decodeFull(url: string): Promise<ThumbLevel | null> {
  if (typeof createImageBitmap !== 'function') return null
  let bmp: ImageBitmap
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    const blob = await r.blob()
    if (!blob.size || !blob.type.startsWith('image/')) return null
    bmp = await createImageBitmap(blob)
  } catch {
    return null
  }
  try {
    const { sx, sy, sw, sh } = cropOf(bmp.width, bmp.height)
    const scale = Math.min(1, HI_MAX_SIDE / Math.max(sw, sh))
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale))
    // No bigger than the largest baked size: nothing to gain.
    if (Math.max(w, h) <= LEVELS[0]) return null
    const s = surface(w, h)
    if (!s) return null
    const c = s.ctx
    c.beginPath(); c.roundRect(0, 0, w, h, Math.max(1, w * THUMB_RADIUS)); c.clip()
    c.fillStyle = MATTE; c.fillRect(0, 0, w, h)
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h)
    const img: CanvasImageSource = s.el instanceof HTMLCanvasElement ? s.el : s.el.transferToImageBitmap()
    return { img, w, h }
  } finally {
    bmp.close()
  }
}

export class ThumbLoader {
  private ready = new Map<string, BakedThumb>()
  private seen = new Set<string>()
  private queue: Array<{ id: string; sources: ThumbSource[] }> = []
  private want = new Set<string>()
  private inflight = 0
  private destroyed = false
  private onReady: () => void

  constructor(onReady: () => void) {
    this.onReady = onReady
  }

  get(id: string): BakedThumb | undefined {
    return this.ready.get(id)
  }

  /** Show exactly these ads, in the order given (biggest spender first).
   *  Ads no longer in the list are dropped (their bitmaps stay in the shared
   *  cache, which is bounded), so stepping through date ranges never piles
   *  up bitmaps, and the old range's waiting thumbnails never load ahead of
   *  the new range's. */
  request(items: Array<{ id: string; sources: ThumbSource[] }>) {
    const want = new Set(items.map(it => it.id))
    this.want = want
    for (const id of this.ready.keys()) if (!want.has(id)) this.ready.delete(id)
    for (const id of this.seen) if (!want.has(id)) this.seen.delete(id)
    const queued = new Set(this.queue.map(q => q.id))
    const next: Array<{ id: string; sources: ThumbSource[] }> = []
    let instant = false
    for (const it of items) {
      // An edited creative comes with a new URL: load it again.
      const have = this.ready.get(it.id)
      if (have && have.url && !it.sources.some(s => s.url === have.url)) { this.ready.delete(it.id); this.seen.delete(it.id) }
      if (this.seen.has(it.id) && !queued.has(it.id)) continue
      this.seen.add(it.id)
      const hit = it.sources.find(s => BAKED.has(s.url))
      if (hit) { this.ready.set(it.id, recall(hit.url)!); instant = true; continue }
      if (it.sources.some(s => !DEAD.has(s.url))) next.push(it)
    }
    this.queue = next
    if (instant) this.onReady()
    this.pump()
  }

  /** Let thumbnails that failed load again (after a refresh renewed Meta's image links). */
  retryFailed() {
    DEAD.clear()
    for (const id of this.seen) if (!this.ready.has(id)) this.seen.delete(id)
  }

  destroy() {
    this.destroyed = true
    this.queue = []
  }

  private pump() {
    while (!this.destroyed && this.inflight < MAX_INFLIGHT && this.queue.length) {
      const it = this.queue.shift()!
      this.inflight++
      this.load(it.sources).then(b => {
        this.inflight--
        if (this.destroyed) return
        if (b && this.want.has(it.id)) { this.ready.set(it.id, b); this.onReady() }
        this.pump()
      })
    }
  }

  private async load(sources: ThumbSource[]): Promise<BakedThumb | null> {
    for (const s of sources) {
      const cached = recall(s.url)
      if (cached) return cached
      if (DEAD.has(s.url)) continue
      const d = await decode(s.url, s.cacheOnly)
      if (this.destroyed) { d?.release(); return null }
      if (d) {
        const b = bakeLevels(d)
        d.release()
        if (b) { b.url = s.url; remember(s.url, b); return b }
      }
      // A cache-only miss isn't a dead source (the grid may load it later).
      if (!s.cacheOnly) DEAD.add(s.url)
    }
    return null
  }
}
