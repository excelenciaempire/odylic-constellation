/*
 * Ported from Atelier (its glassRim.ts, Oct 5 2026; code unchanged, comments lightly edited) so the giveaway
 * draws the same liquid rim. Keep the two in step.
 */
/**
 * The liquid rim of one glass surface, drawn a tile at a time: the ground render around the tile (plus the header
 * shade), softened a little, then every rim pixel bent inward along the rounded rectangle's normal, red and blue
 * split a little from each other, faded into the frost.
 *
 * Peter, Oct 2 2026: "RGB split is too thin and spread out, should be a bit more of a blur line, refraction more
 * subdued", "edges between fog and refraction a bit too separate": the split became a soft blurred line and the rim
 * fades into the frost over a wider band. Oct 3: "I like the current refraction, slightly more vibrant and a little
 * bit more dramatic": a quarter more bend, a wider split and extra saturation at the very rim.
 *
 * Pure: it runs in the rim worker (glassRim.worker.ts) and, where no worker can draw (no OffscreenCanvas), on the
 * main thread a tile at a time (glassField.ts).
 */

export const ART_W = 3392
export const ART_H = 5056
/** Largest tile side, in device pixels: bounds every job's memory and stays well inside iOS Safari's canvas limits. */
export const TILE = 1024

/** s, m, l by the surface's size; t (tight) for a panel whose content starts close to its edge with opaque frozen
 *  panes (the P&L table): its rim has faded out within 15px, before the panes begin, so no seam shows. */
export type Size = 's' | 'm' | 'l' | 't'
/** CSS px: the bending band, the deepest bend (at the very edge), the red/blue pull, the solid outer edge, how far
 *  past the band the rim fades into the frost, and the blur on what the rim refracts. */
export type Edge = { band: number; bend: number; split: number; solid: number; fade: number; soft: number }
export const EDGE: Record<Size, Edge> = {
  s: { band: 7, bend: 7.5, split: 1.3, solid: 0.5, fade: 6, soft: 0.8 },
  m: { band: 15, bend: 15, split: 2.3, solid: 1, fade: 12, soft: 1.4 },
  l: { band: 22, bend: 26, split: 3, solid: 1.5, fade: 18, soft: 2 },
  t: { band: 9, bend: 12, split: 2.2, solid: 1, fade: 6, soft: 1.4 },
}
/** Red bends this much further than green, blue this much less: the split grows where the bend is steep. */
const SPREAD = 0.1
/** Extra saturation at the very rim, easing off as the rim fades into the frost (Peter, Oct 3 2026: "slightly more
 *  vibrant and a little bit more dramatic"). */
const VIBRANCE = 0.4
/** The RGB split itself pushed further: how far red and blue land from where they'd be unsplit, scaled up, so the
 *  colour line gets more saturated while the glass between keeps its own colour (Peter, Oct 3 2026: "glassmorphic
 *  RGB needs to be a bit more saturated, on the colorful side"). By day the ground is pale and light mode's glass
 *  lays a 42% white tint over the rim, so the line needs a stronger push to read at all. */
export const FRINGE = 0.6
export const DAY_FRINGE = 1.5

export type RimGeo = { gx: number; gy: number; gw: number; dx: number; dy: number; dw: number; dh: number; scrimH: number }
/** One surface, in host CSS px, with what the ground looks like behind it. */
export type RimJob = {
  x: number; y: number; w: number; h: number; r: number; size: Size; dpr: number
  geo: RimGeo; stops: Array<{ color: string; at: number }>; base: string; mirror: boolean
  /** How much further the RGB split's colour is pushed (FRINGE by night, DAY_FRINGE by day). */
  fringe?: number
}
/** A tile of the rim: [left, top, width, height] in device px, relative to the surface. */
export type Tile = [number, number, number, number]

/** The rim's tiles: four strips on a big surface (one canvas on a small one), cut to TILE-sized pieces. */
export function rimTiles(job: RimJob): Tile[] {
  const e = EDGE[job.size]
  const W = Math.max(1, Math.round(job.w * job.dpr))
  const H = Math.max(1, Math.round(job.h * job.dpr))
  const T = Math.min(Math.ceil((e.band + e.fade) * job.dpr), Math.ceil(Math.min(W, H) / 2))
  const strips: Tile[] = W <= 2 * T + 2 || H <= 2 * T + 2
    ? [[0, 0, W, H]]
    : [[0, 0, W, T], [0, H - T, W, T], [0, T, T, H - 2 * T], [W - T, T, T, H - 2 * T]]
  const out: Tile[] = []
  for (const [ox, oy, cw, ch] of strips) {
    for (let ty = 0; ty < ch; ty += TILE) {
      for (let tx = 0; tx < cw; tx += TILE) out.push([ox + tx, oy + ty, Math.min(TILE, cw - tx), Math.min(TILE, ch - ty)])
    }
  }
  return out
}

/** Two passes of a box blur on the colour channels: close to a gaussian of the given radius, in place. */
function soften(px: Uint8ClampedArray, w: number, h: number, rad: number) {
  if (rad < 1) return
  const tmp = new Uint8ClampedArray(px.length)
  const div = 2 * rad + 1
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w * 4
      for (let c = 0; c < 3; c++) {
        let acc = 0
        for (let k = -rad; k <= rad; k++) acc += px[row + Math.min(w - 1, Math.max(0, k)) * 4 + c]
        for (let x = 0; x < w; x++) {
          tmp[row + x * 4 + c] = acc / div
          acc += px[row + Math.min(w - 1, x + rad + 1) * 4 + c] - px[row + Math.max(0, x - rad) * 4 + c]
        }
      }
    }
    const stride = w * 4
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const col = x * 4 + c
        let acc = 0
        for (let k = -rad; k <= rad; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * stride + col]
        for (let y = 0; y < h; y++) {
          px[y * stride + col] = acc / div
          acc += tmp[Math.min(h - 1, y + rad + 1) * stride + col] - tmp[Math.max(0, y - rad) * stride + col]
        }
      }
    }
  }
}

/**
 * One tile of a surface's rim, as pixels. `makeCtx` gives a 2D context of a given size to draw the neighbourhood in
 * (an OffscreenCanvas in the worker, a detached canvas on the main thread). Null when no context is available.
 */
export function drawRimTile(img: CanvasImageSource, job: RimJob, tile: Tile,
  makeCtx: (w: number, h: number) => CanvasRenderingContext2D | null): ImageData | null {
  const e = EDGE[job.size]
  const { x, y, w, h, dpr, geo, mirror } = job
  const r = Math.max(0, Math.min(job.r, Math.min(w, h) / 2))
  const [ox, oy, cw, ch] = tile
  // how far a rim pixel can read from, in device px
  const m = Math.ceil((e.bend * (1 + SPREAD) + e.split + 2 * e.soft + 2) * dpr)
  const nw = cw + 2 * m
  const nh = ch + 2 * m
  const ctx = makeCtx(nw, nh)
  if (!ctx) return null
  // the neighbourhood's top left and size, in host CSS px
  const nx0 = x + (ox - m) / dpr
  const ny0 = y + (oy - m) / dpr
  const cssW = nw / dpr
  const cssH = nh / dpr
  ctx.setTransform(dpr, 0, 0, dpr, -nx0 * dpr, -ny0 * dpr)
  ctx.fillStyle = job.base
  ctx.fillRect(nx0, ny0, cssW, cssH)
  // the render, cropped to this neighbourhood (source pixels only, so no tile resamples the whole image)
  const k = ART_W / geo.dw
  const regionL = mirror ? 2 * geo.gx + geo.gw - (nx0 + cssW) : nx0
  const srcX = Math.max(0, (regionL - geo.dx) * k)
  const srcY = Math.max(0, (ny0 - geo.dy) * k)
  const srcW = Math.min(ART_W - srcX, cssW * k)
  const srcH = Math.min(ART_H - srcY, cssH * k)
  if (srcW > 0 && srcH > 0) {
    ctx.save()
    if (mirror) {
      ctx.translate(2 * geo.gx + geo.gw, 0)
      ctx.scale(-1, 1)
    }
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, srcX, srcY, srcW, srcH, geo.dx + srcX / k, geo.dy + srcY / k, srcW / k, srcH / k)
    ctx.restore()
  }
  // the header shade, as the ground draws it
  if (job.stops.length && ny0 < geo.gy + geo.scrimH) {
    const grad = ctx.createLinearGradient(0, geo.gy, 0, geo.gy + geo.scrimH)
    for (const s of job.stops) grad.addColorStop(Math.max(0, Math.min(1, s.at / geo.scrimH)), s.color)
    ctx.fillStyle = grad
    ctx.fillRect(nx0, geo.gy, cssW, geo.scrimH)
  }
  const src = ctx.getImageData(0, 0, nw, nh).data
  soften(src, nw, nh, Math.round(e.soft * dpr))

  const sample = (bx: number, by: number, c: number) => {
    // bilinear read of channel c at device coordinates in the neighbourhood
    const fx = Math.max(0, Math.min(nw - 1.001, bx))
    const fy = Math.max(0, Math.min(nh - 1.001, by))
    const x0 = fx | 0
    const y0 = fy | 0
    const tx = fx - x0
    const ty = fy - y0
    const i = (y0 * nw + x0) * 4 + c
    const a = src[i] + (src[i + 4] - src[i]) * tx
    const b = src[i + nw * 4] + (src[i + nw * 4 + 4] - src[i + nw * 4]) * tx
    return a + (b - a) * ty
  }
  const out = new ImageData(cw, ch)
  const d = out.data
  const hw = w / 2
  const hh = h / 2
  const fadeTo = e.band + e.fade
  const pull = e.split * dpr
  const fringe = 1 + (job.fringe ?? FRINGE)
  for (let py = 0; py < ch; py++) {
    const cy = (oy + py + 0.5) / dpr - hh
    for (let px = 0; px < cw; px++) {
      const cx = (ox + px + 0.5) / dpr - hw
      // signed distance to the rounded rectangle (negative inside), and the inward normal of the nearest edge
      const qx = Math.abs(cx) - (hw - r)
      const qy = Math.abs(cy) - (hh - r)
      const inCorner = qx > 0 && qy > 0
      const outside = inCorner ? Math.hypot(qx, qy) : Math.max(qx, 0) + Math.max(qy, 0)
      const dist = r - outside - Math.min(Math.max(qx, qy), 0)
      if (dist < 0 || dist >= fadeTo) continue
      let alpha = 1
      if (dist > e.solid) {
        const t = (fadeTo - dist) / (fadeTo - e.solid)
        alpha = t * t * (3 - 2 * t)
      }
      let nx = 0
      let ny = 0
      let bend = 0
      if (dist < e.band) {
        if (inCorner) {
          nx = -Math.sign(cx) * qx / outside
          ny = -Math.sign(cy) * qy / outside
        } else if (qx > qy) {
          nx = -Math.sign(cx)
        } else {
          ny = -Math.sign(cy)
        }
        const t = 1 - dist / e.band
        bend = e.bend * t * t * dpr
      }
      // read positions: green bent, red bent a little further and pulled left, blue a little less and right
      const bu = px + m
      const bv = py + m
      const i = (py * cw + px) * 4
      const gu = bu + nx * bend
      const gv = bv + ny * bend
      const G = sample(gu, gv, 1)
      // red and blue where the split puts them, pushed further from where they'd be unsplit (at green's spot)
      const R0 = sample(gu, gv, 0)
      const B0 = sample(gu, gv, 2)
      const R = R0 + (sample(bu + nx * bend * (1 + SPREAD) - pull, bv + ny * bend * (1 + SPREAD), 0) - R0) * fringe
      const B = B0 + (sample(bu + nx * bend * (1 - SPREAD) + pull, bv + ny * bend * (1 - SPREAD), 2) - B0) * fringe
      const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B
      const sat = 1 + VIBRANCE * alpha
      let r1 = lum + (R - lum) * sat
      let g1 = lum + (G - lum) * sat
      let b1 = lum + (B - lum) * sat
      // where a channel would pass white the pixel comes down a touch instead (hue kept), so a pale ground gains
      // colour rather than clipping back to the same white
      const hi = Math.max(r1, g1, b1)
      if (hi > 255) {
        const k = 255 / hi
        r1 *= k
        g1 *= k
        b1 *= k
      }
      d[i] = r1
      d[i + 1] = g1
      d[i + 2] = b1
      d[i + 3] = alpha * 255
    }
  }
  return out
}
