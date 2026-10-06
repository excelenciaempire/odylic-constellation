/**
 * The creative space renderer: a port of the Creative Space mockup's Canvas
 * 2D engine (~/Desktop/democo-creative-space/index.html). Hand-rolled
 * perspective projection, painter's sort, pre-scaled rounded thumbnails,
 * eased fly-in between layouts, a slow orbit when idle. No WebGL: a few
 * hundred small bitmaps draw comfortably at 60 to 120fps.
 *
 * Look (DESIGN_BRIEF.md): cards carry a hairline and a soft contact shadow,
 * the group color is a small dot in the corner (not an outline), hover and
 * selection are a ring offset outside the card, and cluster labels are
 * small sans text on a halo instead of filled pills.
 *
 * Motion (reworked 2026-10-01; "drag and flick lags out and gets choppy"):
 *   - Everything advances on elapsed time, so 60 and 120Hz screens move alike.
 *   - A flick keeps spinning with exponential decay. Its speed comes from the
 *     last ~80ms of pointer samples (coalesced events included), not from the
 *     last event's delta, which made flicks random and, at worst, spun the
 *     view a quarter turn per frame. Capped, so a hard flick never strobes.
 *   - Hovering a card no longer stops a spin dead; hover waits until the
 *     spin slows. Zoom eases in log space with a short time constant.
 *   - Per frame: no allocations, one thumbnail lookup per card, the bitmap
 *     size nearest each card's screen size, cached pointer geometry, and a
 *     lighter draw (no contact shadows) while moving, restored when still.
 *
 * The loop only runs while something moves: it idles when the view is
 * still, hidden or off screen. When the document is hidden (background tab,
 * headless preview) animations snap to their end state so a single frame is
 * right.
 */
import type { Cluster, SpaceLayout, Vec3 } from './spaceLayout'
import { funnelRadius, h01, type FunnelProfile } from './spaceLayout'
import { hiResThumb, type BakedThumb } from './spaceThumbs'

/** `count`: how many ads run this card's visual (a stacked creative); 2 or more draws an "N×" badge. */
export type EngineNode = { id: string; size: number; video: boolean; count?: number }
/** A thumbnail: aspect ratio and pre-scaled rounded bitmaps, largest first. */
export type Thumb = BakedThumb

export type EngineCallbacks = {
  getThumb: (id: string) => Thumb | undefined
  onHover: (h: { id: string; x: number; y: number } | null) => void
  onOpen: (id: string) => void
  /** A right-click (no drag) on a group label, or on a card for its group; client coordinates. */
  onGroupMenu?: (key: string, x: number, y: number) => void
  /** A left-click on a group label. The shell decides what a group click does (fly there, spotlight it, let go
   *  of it), the same as for its legend row; without this callback the label just focuses its group. */
  onGroupClick?: (key: string) => void
  /** The group the camera is framed on (focus()), or null once the view lets go of it (a reset, a new layout). */
  onFocus?: (key: string | null) => void
}

type Node = {
  id: string
  size: number
  video: boolean
  /** Ads running this visual (1 = not stacked). */
  count: number
  cur: Vec3
  tgt: Vec3
  vis: number
  visT: number
  color: string
  group: string
  dashed: boolean
}

type Drawn = {
  n: Node; sx: number; sy: number; w: number; h: number; zc: number
  th: Thumb | undefined
  /** Opacity it was drawn at: a card faded to nothing takes no hover or click. */
  a: number
  /** Drawn from the full-resolution image this frame (one of the largest few). */
  hi: boolean
}
type Rect = { x: number; y: number; w: number; h: number; key: string }
type Pt = [number, number]
/** A ring's on-screen extremes (its outline goes straight into the path). */
type Rim = { left: Pt; right: Pt } | null

const NEUTRAL = '#a8a29e'
const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"

/** What the canvas draws with besides the creatives and group colors. */
type Palette = {
  ink: string; muted: string; halo: string; hoverRing: string
  hairline: string; shadow: string; emptyCard: string
  grid: string; edge: string; axis: string; silhouette: string
}
/** Light defaults: the original look, before setTheme() runs. */
const LIGHT: Palette = {
  ink: '#211e1b', muted: '#6b655e', halo: 'rgba(248,247,245,0.94)', hoverRing: 'rgba(33,30,27,0.5)',
  hairline: 'rgba(0,0,0,0.13)', shadow: 'rgba(26,26,26,0.07)', emptyCard: 'rgba(255,255,255,.7)',
  grid: 'rgba(0,0,0,0.045)', edge: 'rgba(0,0,0,0.07)', axis: 'rgba(0,0,0,0.28)', silhouette: 'rgba(0,0,0,0.24)',
}
/** The app's theme tokens, resolved to colors (CreativeSpace3D reads them
 *  from --color-text-primary, --color-text-muted and --color-surface). */
export type SpaceTheme = { ink: string; muted: string; bg: string }

function rgbOf(c: string): [number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c || '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
/** Screen y of the look-at point, as a share of the height. */
const CENTER_Y = 0.54
/** Depth fade: opacity at the framed distance (the mockup's near-side look);
 *  closer cards go opaque, the far side of a cluster fades toward 0.28. */
const DEPTH_ALPHA = 0.92
/** Card corner radius as a share of its width (spaceThumbs bakes the same). */
const CARD_RADIUS = 0.045

// ── Motion constants (time based, ms) ──────────────────────────────────────
/** Idle orbit, radians per ms (the old 0.001 rad per 60fps frame). */
const ORBIT_RATE = 0.001 / 16.667
/** The orbit eases back in after a drag, a hover or a flick, and out (faster)
 *  when something is looked at or rotation is paused. */
const ORBIT_TAU_IN = 600, ORBIT_TAU_OUT = 200
/** Drag: radians per pixel of pointer travel (Peter, Oct 5 2026: 20% less drag than Atelier's 0.0055). */
const ROT_PER_PX = 0.0066
/** A flick decays with this time constant (travel = speed x tau); 475 is 20% less friction than 380. */
const FLING_TAU = 475
/** Fastest flick, radians per ms (5 rad/s; faster strobes at 60Hz). */
const FLING_MAX = 0.005
/** Below this a flick has stopped (0.02 rad/s). */
const FLING_MIN = 0.00002
/** Hover picking waits while the view spins faster than this (0.35 rad/s). */
const PICK_SPIN_MAX = 0.00035
/** Pointer samples older than this don't count toward a flick. */
const FLING_WINDOW = 90
/** Holding still this long before letting go means no flick. */
const FLING_HOLD = 70
/** Zoom eases in log space with this time constant (was ~177ms, linear). */
const ZOOM_TAU = 90
/** Camera distance bounds, as multiples of the framed distance (a cluster focus dollies within these). */
const ZOOM_MIN = 0.22, ZOOM_MAX = 2.6
/** A focused group's neighbours draw at this share of their opacity (a hovered legend row dims to 0.15, an
 *  isolated group to 0.07): enough to show which cards the camera flew to, with the rest still readable. */
const FOCUS_DIM = 0.3
/** Cards drawn at this opacity or more are "lit" for picking (see pick). */
const PICK_LIT = 0.25
/** A focus never draws a card bigger than this share of the canvas height (a group of one or two would
 *  otherwise fill the view); see FOCUS_CARD_MAX for the cap in pixels. */
const FOCUS_CARD_H = 0.34, FOCUS_CARD_MAX = 300
/** Canvas px the overlays keep from the canvas edge (the legend sits this far in from the bottom left). */
const OVERLAY_INSET = 12
/** Screen zoom (wheel, pinch, double-click): the projected view scales about the pointer, like a map, so
 *  any card can be brought up close. The camera itself never moves in, so no line can reach the near
 *  plane however deep the zoom. Bounds as multiples of the framed size. */
const SCREEN_ZOOM_MIN = 0.4, SCREEN_ZOOM_MAX = 16
/** A double-click zooms in this much about the pointer (with Shift, out). */
const DBL_ZOOM = 2.4
/** Zoomed in past this, the idle orbit holds still so the card being looked at stays put. */
const ZOOM_HOLD = 1.15
/** A card drawn bigger than this (device px, long side) uses the full-resolution image. */
const HIRES_AT = 220
/** At most this many cards per frame do: the largest ones. Kept under the full-resolution cache's size
 *  (spaceThumbs HI_KEEP), so a decode landing never evicts a card still on screen (which would decode it
 *  again the next frame, and so on for as long as the view stays put). */
const HIRES_PER_FRAME = 12
/** Wheel zoom per pixel of scroll, and per pixel of trackpad pinch. */
const WHEEL_ZOOM = 0.0011, PINCH_ZOOM = 0.0033
/** Label widths are measured at the drawn size, rounded to this step (px).
 *  Measuring at one large size and scaling under-reads small text: the
 *  system font tracks wider at text sizes than at display sizes, so the
 *  count drew over the end of the name ("Product Her10"). */
const MEASURE_STEP = 0.5
/** Largest frame step the physics takes (a stalled tab must not jump). */
const MAX_STEP = 50
/** Only the idle orbit moving: draw at most every this many ms (~60fps). */
const ORBIT_FRAME_MS = 15
/** The idle orbit winds down after this long without input on the space (or
 *  a layout, legend, selection or focus change), so a view left open stops
 *  drawing; the next pointer or wheel input brings it back. */
const ORBIT_IDLE_MS = 60_000
/** Backing store cap (device pixels): a huge window drops resolution a
 *  little instead of filling 15M+ pixels a frame. */
const MAX_BACKING_PX = 11_000_000

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** Painter's order: far cards first. */
const byDepth = (a: { zc: number }, b: { zc: number }) => b.zc - a.zc

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

/** `1 - (1 - rate)^(dt / 16.667)`: a per-60fps-frame ease rate, time based. */
/** The funnel wall's slope, d(radius)/dy: funnelRadius differentiated (0 down the spout). */
function funnelSlope(f: FunnelProfile, y: number): number {
  if (y >= f.yNeck || y < f.yTop) return 0
  const span = f.yNeck - f.yTop
  return (-(f.R0 - f.Rs) * f.p * Math.pow(1 - (y - f.yTop) / span, f.p - 1)) / span
}

function easeAmt(rate: number, dt: number): number {
  return 1 - Math.pow(1 - rate, dt / 16.667)
}

export class SpaceEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private cb: EngineCallbacks
  private nodes = new Map<string, Node>()
  private list: Node[] = []
  /** Cards drawn last frame, back to front (hit testing reads it). */
  private drawn: Drawn[] = []
  private drawnCount = 0
  private hiCand: Drawn[] = []
  private frameNo = 0
  private labelRects: Rect[] = []
  private layout: SpaceLayout | null = null
  private clusterByKey = new Map<string, Cluster>()

  private W = 0
  private H = 0
  private DPR = 1
  private fitD = 2000
  private cam = {
    rotX: -0.22, rotY: 0.5, D: 2600, DT: 1750, f: 1050,
    tx: 0, ty: 0, tz: 0, ttx: 0, tty: 0, ttz: 0, panX: 0, panY: 0,
    /** Screen zoom and its target (see SCREEN_ZOOM_MIN). */
    zoom: 1, zoomT: 1,
    /** Pan target while a reset or focus glides the view back (panAnim). */
    panTX: 0, panTY: 0,
  }
  /** The screen point a wheel or pinch zoom holds still (canvas px). */
  private zoomAt = { x: 0, y: 0 }
  /** True while pan and zoom glide to panTX/panTY and zoomT (reset, focus), not about zoomAt. */
  private panAnim = false
  private anim = { active: false, rotX: 0, rotY: 0 }
  // Per-frame rotation terms.
  private sxR = 0; private cxR = 1; private syR = 0; private cyR = 1
  /** project() writes here (no allocation per call). */
  private P = { px: 0, py: 0, zc: 0, s: 0 }

  // Motion state (radians per ms).
  private spinY = 0
  private spinX = 0
  private orbit = ORBIT_RATE
  private orbitDir = 1

  private hoverId: string | null = null
  private selectedId: string | null = null
  private hoverGroup: string | null = null
  /** A group held on its own (Isolate in model): every other card darkens and stops taking clicks. */
  private isolated: string | null = null
  /** The group the camera last flew to (focus()): its cards stay lit and the rest soften, so the view says which
   *  group it shows, until a reset or a new layout lets go. Other groups still take clicks. */
  private focused: string | null = null
  /** The legend's footprint in the bottom-left corner (canvas px, inset included): a focus frames clear of it. */
  private legendBox = { w: 0, h: 0 }
  /** Axes: the spotlit group's on-screen box in the last frame (its label sits above it). */
  private spotBox = { x0: 0, y0: 0, x1: 0, y1: 0, n: 0 }
  /** A right-click waiting for its contextmenu event before the group menu opens (see openGroupMenu). */
  private pendingMenu: (() => void) | null = null
  private menuTimer = 0
  /** This press has had its contextmenu event (Mac Chrome sends it on the press, Windows on the release). */
  private ctxSeen = false
  private autoRotate = true
  private active = true
  private destroyed = false
  private reducedMotion = false

  private raf = 0
  private timer = 0
  private lastT = 0
  private lastDrawT = 0
  /** Last user input (performance.now()); see ORBIT_IDLE_MS. */
  private lastInput = performance.now()
  /** The last frame was drawn without contact shadows (in motion). */
  private drewFast = false

  private dragging = false
  private dragged = false
  private panMode = false
  private lastX = 0
  private lastY = 0
  private dragDist = 0
  private pointers = new Map<number, { x: number; y: number }>()
  private pinchDist = 0
  /** Recent pointer samples for the flick: [t, x, y] ring. */
  private samples: Array<[number, number, number]> = []
  /** Canvas client rect, refreshed on resize, pointer entry, scroll and at
   *  most once a second (reading it per move could force a layout of the
   *  whole page). */
  private rect = { left: 0, top: 0 }
  private rectDirty = true
  private rectAt = 0
  /** A hover pick waiting for the next frame (one per frame at most). */
  private pendingPick: { x: number; y: number; moved: boolean } | null = null
  private pickRaf = 0
  private pointerInside = false
  private lastPointer = { x: 0, y: 0 }
  // Label text widths by weight, rounded size and text.
  private textW = new Map<string, number>()
  private curFont = ''
  private pal: Palette = LIGHT

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: true })!
    this.cb = cb
    try { this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches } catch { /* default motion */ }
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerCancel)
    canvas.addEventListener('pointerenter', this.onPointerEnter)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('dblclick', this.onDblClick)
    canvas.addEventListener('contextmenu', this.onContextMenu)
    document.addEventListener('visibilitychange', this.invalidate)
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true })
    try { document.fonts?.ready.then(this.onFontsLoaded) } catch { /* fonts API missing */ }
    // The interface fonts load without blocking the page, so they can land after the first frames.
    try { document.fonts?.addEventListener?.('loadingdone', this.onFontsLoaded) } catch { /* fonts API missing */ }
  }

  private onFontsLoaded = () => { this.textW.clear(); this.invalidate() }

  destroy() {
    this.destroyed = true
    this.cancel()
    this.cancelMenu()
    if (this.pickRaf) cancelAnimationFrame(this.pickRaf)
    const c = this.canvas
    c.removeEventListener('pointerdown', this.onPointerDown)
    c.removeEventListener('pointermove', this.onPointerMove)
    c.removeEventListener('pointerup', this.onPointerUp)
    c.removeEventListener('pointercancel', this.onPointerCancel)
    c.removeEventListener('pointerenter', this.onPointerEnter)
    c.removeEventListener('pointerleave', this.onPointerLeave)
    c.removeEventListener('wheel', this.onWheel)
    c.removeEventListener('dblclick', this.onDblClick)
    c.removeEventListener('contextmenu', this.onContextMenu)
    document.removeEventListener('visibilitychange', this.invalidate)
    window.removeEventListener('scroll', this.onScroll, { capture: true })
    try { document.fonts?.removeEventListener?.('loadingdone', this.onFontsLoaded) } catch { /* fonts API missing */ }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  resize(w: number, h: number) {
    if (w <= 0 || h <= 0) return
    this.W = w
    this.H = h
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (w * h * dpr * dpr > MAX_BACKING_PX) dpr = Math.max(1, Math.sqrt(MAX_BACKING_PX / (w * h)))
    this.DPR = dpr
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    this.rectDirty = true
    this.curFont = ''
    // Focal length scales with the canvas, so a layout frames the same at
    // any size (the mockup's 1050 belongs to a ~1440 x 780 window).
    this.cam.f = 1050 * Math.min(w / 1440, h / 780)
    if (this.layout) {
      const fit = this.computeFit(this.layout)
      const ratio = this.cam.DT / this.fitD
      this.fitD = fit
      this.cam.DT = fit * ratio
      this.cam.D = this.cam.DT
    }
    this.invalidate()
  }

  setLayout(input: EngineNode[], layout: SpaceLayout, opts: { resetCamera: boolean }) {
    this.lastInput = performance.now()
    const first = this.nodes.size === 0
    this.layout = layout
    this.clusterByKey = new Map(layout.clusters.map(c => [c.key, c]))
    const seen = new Set<string>()
    for (const en of input) {
      seen.add(en.id)
      const tgt = layout.targets.get(en.id)
      const hidden = !tgt || layout.hidden.has(en.id)
      let n = this.nodes.get(en.id)
      if (!n) {
        const t = tgt || { x: 0, y: 0, z: 0 }
        // The mockup's fly-in: start scattered far out, drift into place.
        const cur = {
          x: t.x * 0.2 + (h01(en.id, 'x') - 0.5) * 2600,
          y: t.y * 0.2 + (h01(en.id, 'y') - 0.5) * 2600,
          z: t.z * 0.2 + (h01(en.id, 'z') - 0.5) * 2600,
        }
        n = { id: en.id, size: 0, video: false, count: 1, cur, tgt: { ...cur }, vis: 0, visT: 0, color: NEUTRAL, group: '', dashed: false }
        this.nodes.set(en.id, n)
        this.list.push(n)
      }
      n.size = en.size * layout.sizeScale
      n.video = en.video
      n.count = Math.max(1, en.count || 1)
      if (tgt) { n.tgt.x = tgt.x; n.tgt.y = tgt.y; n.tgt.z = tgt.z }
      else { n.tgt.x = n.cur.x; n.tgt.y = n.cur.y; n.tgt.z = n.cur.z }   // hidden ads fade in place, never drift
      n.visT = hidden ? 0 : 1
      n.group = layout.groupOf.get(en.id) || ''
      n.color = this.clusterByKey.get(n.group)?.color || NEUTRAL
      n.dashed = layout.dashed.has(en.id)
    }
    for (const n of this.list) if (!seen.has(n.id)) { n.visT = 0; n.tgt.x = n.cur.x; n.tgt.y = n.cur.y; n.tgt.z = n.cur.z }
    if (this.hoverId && !seen.has(this.hoverId)) this.setHover(null)

    const fit = this.computeFit(layout)
    if (opts.resetCamera || first) {
      this.cam.DT = fit
      this.cam.ttx = 0; this.cam.tty = 0; this.cam.ttz = 0
      this.cam.panX = this.offsetX(layout); this.cam.panY = 0
      this.cam.zoom = 1; this.cam.zoomT = 1
      this.panAnim = false
      if (first) {
        this.cam.rotX = layout.rotX
        if (layout.rotY !== null) this.cam.rotY = layout.rotY
        this.cam.D = fit * 1.35
      }
      this.animateTo(layout.rotX, layout.rotY)
      this.setFocused(null)
    } else {
      this.cam.DT = fit * (this.cam.DT / this.fitD)
    }
    this.fitD = fit
    // New data under the same arrangement: a focused group that is gone lets go (in the axes, where a focus
    // framed a patch of the cube, the whole cube comes back).
    if (this.focused !== null && !this.visibleCount(this.clusterByKey.get(this.focused))) {
      if (layout.kind === 'axes') this.resetView()
      else this.setFocused(null)
    }
    this.invalidate()
  }

  /** Follow the app theme. Lines and text derive from the ink token (so a
   *  light ink on a dark surface gives light hairlines); shadows stay dark. */
  setTheme(t: SpaceTheme) {
    const ink = rgbOf(t.ink), bg = rgbOf(t.bg)
    if (!ink || !bg) return
    const dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.45
    this.pal = {
      ink: t.ink,
      muted: rgbOf(t.muted) ? t.muted : LIGHT.muted,
      halo: rgba(bg, 0.94),
      hoverRing: rgba(ink, 0.5),
      hairline: rgba(ink, dark ? 0.16 : 0.13),
      shadow: dark ? 'rgba(0,0,0,0.35)' : LIGHT.shadow,
      emptyCard: dark ? rgba(ink, 0.08) : LIGHT.emptyCard,
      grid: rgba(ink, dark ? 0.06 : 0.045),
      edge: rgba(ink, dark ? 0.1 : 0.07),
      axis: rgba(ink, dark ? 0.34 : 0.28),
      silhouette: rgba(ink, dark ? 0.3 : 0.24),
    }
    this.invalidate()
  }

  setSelected(id: string | null) { this.selectedId = id; this.lastInput = performance.now(); this.invalidate() }
  setHoverGroup(key: string | null) { this.hoverGroup = key; this.lastInput = performance.now(); this.invalidate() }
  setIsolated(key: string | null) {
    this.isolated = key
    this.lastInput = performance.now()
    if (key && this.hoverId && this.nodes.get(this.hoverId)?.group !== key) this.setHover(null)
    this.invalidate()
  }
  /** The group drawn in full while the rest dims: a hovered legend row (the shell holds it back while a group
   *  is isolated, unless a group menu is open), else the isolated group, else the focused one. */
  private get spotlight(): string | null { return this.hoverGroup ?? this.isolated ?? this.focused }
  setAutoRotate(on: boolean) { this.autoRotate = on; this.lastInput = performance.now(); this.invalidate() }
  /** The legend's size in the bottom-left corner (canvas px, from its left edge and from the bottom edge), so a
   *  focus frames its group clear of it. Zero when there is none. */
  setLegendBox(w: number, h: number) { this.legendBox.w = Math.max(0, w); this.legendBox.h = Math.max(0, h) }

  private setFocused(key: string | null) {
    if (this.focused === key) return
    this.focused = key
    this.cb.onFocus?.(key)
    this.invalidate()
  }

  setActive(on: boolean) {
    this.active = on
    if (on) { this.lastT = 0; this.invalidate() }
    else this.cancel()
  }

  resetView() {
    if (!this.layout) return
    this.lastInput = performance.now()
    this.cam.ttx = 0; this.cam.tty = 0; this.cam.ttz = 0
    this.glideTo(this.offsetX(this.layout), 0, 1)
    this.cam.DT = this.fitD
    this.animateTo(this.layout.rotX, this.layout.rotY)
    this.setFocused(null)
    this.invalidate()
  }

  /** Glide the screen pan and zoom to a target (a reset or a focus), rather than jump. */
  private glideTo(panX: number, panY: number, zoom: number) {
    this.cam.panTX = panX; this.cam.panTY = panY
    this.cam.zoomT = zoom
    this.panAnim = true
  }

  /** Set a new screen zoom target held still at (x, y): wheel, pinch, double-click. */
  private zoomAbout(x: number, y: number, factor: number) {
    this.panAnim = false
    this.zoomAt.x = x; this.zoomAt.y = y
    this.cam.zoomT = clamp(this.cam.zoomT * factor, SCREEN_ZOOM_MIN, SCREEN_ZOOM_MAX)
    this.invalidate()
  }

  /**
   * Glide the camera to frame a group (legend row or label click): its own cards fill the free area of the
   * canvas, clear of the KPI strip, the legend and the lane labels, and stay lit while the rest softens (see
   * FOCUS_DIM) until a reset. False when the group has no card in view (nothing to fly to).
   *   - Funnel: the lane's ring, centred on the funnel's axis, at the funnel's tilt (the orbit keeps turning).
   *   - Ring: the cluster from outside the ring, so no other cluster stands between it and the camera.
   *   - Bins: the bin square on, as the row is laid out (a row seen end on puts the nearer bins in front).
   *   - Axes: the group's cards from where the camera already looks (the cube keeps its orientation), centred
   *     on their centroid. Groups run through each other there, so the shell isolates the group as well.
   * Ring, bins and axes hold the idle orbit while focused: turning about a group swings the others in front.
   */
  focus(key: string): boolean {
    this.lastInput = performance.now()
    const L = this.layout
    const c = this.clusterByKey.get(key)
    if (!L || !c || !this.W || !this.H) return false
    const pts: Vec3[] = [], half: number[] = []
    const mid = { x: 0, y: 0, z: 0 }
    for (const id of c.ids) {
      const p = L.targets.get(id)
      if (!p || L.hidden.has(id)) continue
      pts.push(p)
      half.push((this.nodes.get(id)?.size ?? 60 * L.sizeScale) / 2)
      mid.x += p.x; mid.y += p.y; mid.z += p.z
    }
    if (!pts.length) return false
    mid.x /= pts.length; mid.y /= pts.length; mid.z /= pts.length
    // The group's own label (above its cluster) stays in the frame too.
    if (L.labels === 'above') { pts.push(c.labelAt); half.push(12) }
    const cam = this.cam
    let at: Vec3 = c.center, rotX = -0.12, rotY = cam.rotY
    let rotYs = [rotY]
    if (L.kind === 'funnel') {
      rotX = L.rotX
      // The orbit keeps turning about the funnel's axis: frame the lane as it reads over a half turn.
      rotYs = [0, 1, 2, 3].map(k => rotY + (k * Math.PI) / 4)
    } else if (L.kind === 'axes') {
      at = mid
      rotX = this.anim.active ? this.anim.rotX : cam.rotX
      rotY = this.anim.active ? this.anim.rotY : cam.rotY
      rotYs = [rotY]
    } else if (L.kind === 'bins') {
      rotY = L.rotY ?? 0
      rotYs = [rotY]
    } else {
      // Outside the ring, looking in: project() puts a point at azimuth az straight ahead when rotY = az + PI.
      // (The mockup's -az held only near 90 degrees; elsewhere the camera stood inside the next cluster.)
      rotY = Math.atan2(c.center.x, c.center.z) + Math.PI
      rotYs = [rotY]
    }
    const fr = this.frameGroup(pts, half, at, rotX, rotYs, this.fitD * ZOOM_MIN * 0.5, this.fitD * ZOOM_MAX)
    cam.ttx = at.x; cam.tty = at.y; cam.ttz = at.z
    cam.DT = fr.D
    this.glideTo(fr.panX, fr.panY, 1)
    this.animateTo(rotX, rotY)
    this.setFocused(key)
    this.invalidate()
    return true
  }

  /**
   * Camera distance and screen pan that frame a group's cards seen from (rotX, rotY) about `at`: the smallest
   * distance (within minD and maxD) where their on-screen box, cards included, fits a free area of the canvas
   * and no card draws bigger than the FOCUS_CARD cap. The free area keeps off the KPI strip and the arrange
   * control (top), the lane labels (the funnel's right-hand column) and the legend: it sits above the legend or
   * beside it, whichever frames the group bigger. The pan centres the box in that area. With several azimuths
   * every one has to fit.
   */
  private frameGroup(
    pts: Vec3[], half: number[], at: Vec3, rotX: number, rotYs: number[], minD: number, maxD: number,
  ): { D: number; panX: number; panY: number } {
    const { W, H } = this
    const L = this.layout!
    const f = this.cam.f
    const side = L.labels === 'side'
    const left = W * 0.04, right = side ? (W < 560 ? Math.max(140, W * 0.4) : Math.max(250, W * 0.22)) : W * 0.05
    // In the axes the spotlit group's label sits just above its cards: room for it under the KPI strip.
    const top = Math.max(58, H * 0.09) + (L.kind === 'axes' ? 22 : 0), bottom = Math.max(46, H * 0.07)
    const lg = this.legendBox
    const areas = lg.w > 0 && lg.h > 0
      ? [
          { x0: left, y0: top, x1: W - right, y1: H - Math.max(bottom, lg.h + 10) },
          { x0: Math.max(left, lg.w + 10), y0: top, x1: W - right, y1: H - bottom },
        ]
      : [{ x0: left, y0: top, x1: W - right, y1: H - bottom }]
    const cap = clamp(H * FOCUS_CARD_H, 140, FOCUS_CARD_MAX)
    const sx = Math.sin(rotX), cx = Math.cos(rotX)
    const trig = rotYs.map(a => [Math.sin(a), Math.cos(a)])
    const box = { x0: 0, y0: 0, x1: 0, y1: 0 }
    // The cards' on-screen box at distance D, about the look-at point's screen position; false when a card
    // would sit right at the camera or draw bigger than the cap.
    const measure = (D: number, k: number): boolean => {
      const [sy, cy] = trig[k]
      box.x0 = Infinity; box.y0 = Infinity; box.x1 = -Infinity; box.y1 = -Infinity
      for (let i = 0; i < pts.length; i++) {
        const x = pts[i].x - at.x, y = pts[i].y - at.y, z = pts[i].z - at.z
        const X = x * cy - z * sy
        const Z1 = x * sy + z * cy
        const Y = y * cx - Z1 * sx
        const zc = y * sx + Z1 * cx + D
        if (zc < 140) return false
        const s = f / zc, r = half[i] * s
        if (r * 2 > cap) return false
        const px = X * s, py = Y * s
        if (px - r < box.x0) box.x0 = px - r
        if (px + r > box.x1) box.x1 = px + r
        if (py - r < box.y0) box.y0 = py - r
        if (py + r > box.y1) box.y1 = py + r
      }
      return true
    }
    type Area = { x0: number; y0: number; x1: number; y1: number }
    const fits = (D: number, a: Area) => {
      for (let k = 0; k < trig.length; k++) {
        if (!measure(D, k) || box.x1 - box.x0 > a.x1 - a.x0 || box.y1 - box.y0 > a.y1 - a.y0) return false
      }
      return true
    }
    let best: { D: number; a: Area } | null = null
    for (const a of areas) {
      if (a.x1 - a.x0 < 80 || a.y1 - a.y0 < 80) continue
      let lo = 40, hi = maxD
      if (fits(hi, a)) {
        for (let i = 0; i < 26; i++) {
          const m = (lo + hi) / 2
          if (fits(m, a)) hi = m
          else lo = m
        }
      }
      if (!best || hi < best.D) best = { D: hi, a }
    }
    const a = best ? best.a : { x0: left, y0: top, x1: W - right, y1: H - bottom }
    const D = clamp(best ? best.D : maxD, minD, maxD)
    measure(D, 0)
    if (!Number.isFinite(box.x0)) return { D, panX: this.offsetX(L), panY: 0 }
    return {
      D,
      panX: (a.x0 + a.x1) / 2 - W / 2 - (box.x0 + box.x1) / 2,
      panY: (a.y0 + a.y1) / 2 - H * CENTER_Y - (box.y0 + box.y1) / 2,
    }
  }

  invalidate = () => { this.schedule() }

  // ── Loop ─────────────────────────────────────────────────────────────────

  private schedule() {
    if (this.destroyed || !this.active || this.raf || this.timer || !this.W) return
    // Hidden documents don't run rAF; a timer still paints one settled frame.
    if (document.hidden) this.timer = window.setTimeout(this.tick, 40)
    else this.raf = requestAnimationFrame(this.tick)
  }

  private cancel() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0 }
    if (this.timer) { clearTimeout(this.timer); this.timer = 0 }
  }

  private tick = () => {
    this.raf = 0
    if (this.timer) { clearTimeout(this.timer); this.timer = 0 }
    if (this.destroyed || !this.active) return
    const now = performance.now()
    const dt = this.lastT ? Math.min(MAX_STEP, Math.max(0, now - this.lastT)) : 16.667
    this.lastT = now
    const snap = document.hidden
    const motion = this.step(dt, snap)
    // Light frames (no contact shadows) while dragging or anything moves
    // fast; the first still frame draws in full.
    const light = !snap && (this.dragging || motion === 'fast')
    // The idle orbit alone is slow: ~60fps is plenty, even on a 120Hz screen.
    const orbitOnly = motion === 'orbit' && !this.drewFast
    if (!orbitOnly || snap || now - this.lastDrawT >= ORBIT_FRAME_MS) {
      this.lastDrawT = now
      this.draw(light)
    }
    // A held drag with nothing else moving waits for the next pointer move.
    if (motion && !snap) this.schedule()
    else this.lastT = 0
  }

  private animateTo(rotX: number, rotY: number | null) {
    let ry = rotY === null ? this.cam.rotY : rotY
    while (ry - this.cam.rotY > Math.PI) ry -= Math.PI * 2
    while (ry - this.cam.rotY < -Math.PI) ry += Math.PI * 2
    this.anim = { active: true, rotX, rotY: ry }
    this.spinX = 0; this.spinY = 0
  }

  private get holding(): boolean {
    // A focused group off the orbit's axis (ring, bins, axes) holds it too: turning about that group would
    // swing the others in front of it. A funnel lane is centred on the axis, so the funnel keeps turning.
    const focusHold = this.focused !== null && this.layout?.kind !== 'funnel'
    return !!(this.hoverId || this.selectedId || this.hoverGroup) || focusHold || this.cam.zoomT > ZOOM_HOLD
  }

  /**
   * Advance by `dt` ms. Returns what still moves on its own: 'fast' (a
   * flick, zoom, fly-to or layout transition), 'orbit' (only the idle
   * orbit), or null (still: the loop stops; a drag redraws on pointer moves).
   */
  private step(dt: number, snap: boolean): 'fast' | 'orbit' | null {
    const c = this.cam
    const ease = (rate: number) => (snap ? 1 : easeAmt(rate, dt))
    let fast = false
    let orbiting = false

    if (!this.dragging) {
      if (this.anim.active) {
        const a = ease(0.08)
        c.rotY += (this.anim.rotY - c.rotY) * a
        c.rotX += (this.anim.rotX - c.rotX) * a
        if (Math.abs(this.anim.rotY - c.rotY) < 0.003 && Math.abs(this.anim.rotX - c.rotX) < 0.003) {
          c.rotY = this.anim.rotY; c.rotX = this.anim.rotX
          this.anim.active = false
        } else fast = true
        this.orbit = 0
      } else {
        // A flick: exponential decay on elapsed time.
        if (this.spinY || this.spinX) {
          if (snap) { this.spinX = 0; this.spinY = 0 }
          const k = Math.exp(-dt / FLING_TAU)
          c.rotY += this.spinY * FLING_TAU * (1 - k)
          const rx = c.rotX + this.spinX * FLING_TAU * (1 - k)
          c.rotX = clamp(rx, -1.25, 1.25)
          if (c.rotX !== rx) this.spinX = 0
          this.spinY *= k
          this.spinX *= k
          if (Math.abs(this.spinY) < FLING_MIN) this.spinY = 0
          if (Math.abs(this.spinX) < FLING_MIN) this.spinX = 0
          if (this.spinY || this.spinX) fast = true
          // Hover waited for the spin to slow down: pick where the pointer is
          // (cards move under a still pointer; DOM work only on a change).
          if (this.pointerInside && Math.hypot(this.spinX, this.spinY) < PICK_SPIN_MAX) this.queuePick(this.lastPointer.x, this.lastPointer.y, false)
        }
        // The idle orbit eases out while something is looked at, back in after.
        // A hidden document holds still (one settled frame, no orbit).
        const awake = performance.now() - this.lastInput < ORBIT_IDLE_MS
        const want = this.autoRotate && !this.reducedMotion && !this.holding && awake ? ORBIT_RATE * this.orbitDir : 0
        if (!snap && this.orbit !== want) {
          this.orbit += (want - this.orbit) * (1 - Math.exp(-dt / (want ? ORBIT_TAU_IN : ORBIT_TAU_OUT)))
          if (Math.abs(this.orbit - want) < ORBIT_RATE * 0.02) this.orbit = want
        }
        if (this.orbit && !snap) { c.rotY += this.orbit * dt; orbiting = true }
      }
    }

    // Zoom: ease the distance in log space (equal ratios feel equally fast).
    if (c.D !== c.DT) {
      if (snap) c.D = c.DT
      else {
        const lD = Math.log(c.D), lT = Math.log(c.DT)
        const next = lT + (lD - lT) * Math.exp(-dt / ZOOM_TAU)
        c.D = Math.exp(next)
        if (Math.abs(c.D - c.DT) < 0.5) c.D = c.DT
        else fast = true
      }
    }
    // Screen zoom, also eased in log space. About a pointer (wheel, pinch, double-click) the pan moves with
    // each step so the point under the pointer stays put: every projected point scales about it by the same
    // ratio. A reset or a focus glides pan and zoom to their targets instead.
    if (c.zoom !== c.zoomT || this.panAnim) {
      const before = c.zoom
      if (snap) c.zoom = c.zoomT
      else {
        const lz = Math.log(c.zoom), lt = Math.log(c.zoomT)
        c.zoom = Math.exp(lt + (lz - lt) * Math.exp(-dt / ZOOM_TAU))
        if (Math.abs(c.zoom - c.zoomT) < c.zoomT * 0.0005) c.zoom = c.zoomT
      }
      if (this.panAnim) {
        const a = ease(0.12)
        c.panX += (c.panTX - c.panX) * a
        c.panY += (c.panTY - c.panY) * a
        if (Math.abs(c.panTX - c.panX) + Math.abs(c.panTY - c.panY) < 0.3) { c.panX = c.panTX; c.panY = c.panTY }
        if (c.zoom === c.zoomT && c.panX === c.panTX && c.panY === c.panTY) this.panAnim = false
      } else if (c.zoom !== before) {
        const k = c.zoom / before
        c.panX += (this.zoomAt.x - this.W / 2 - c.panX) * (1 - k)
        c.panY += (this.zoomAt.y - this.H * CENTER_Y - c.panY) * (1 - k)
      }
      if (c.zoom !== c.zoomT || this.panAnim) fast = true
    }
    const z = ease(0.09)
    const dx = c.ttx - c.tx, dy = c.tty - c.ty, dz = c.ttz - c.tz
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 0.5) {
      c.tx += dx * z; c.ty += dy * z; c.tz += dz * z
      fast = true
    } else { c.tx = c.ttx; c.ty = c.tty; c.tz = c.ttz }

    const pe = ease(0.075), ve = ease(0.1)
    let removed = false
    for (let i = 0; i < this.list.length; i++) {
      const n = this.list[i]
      const dv = n.visT - n.vis
      if (Math.abs(dv) > 0.004) { n.vis += dv * ve; fast = true } else n.vis = n.visT
      const ex = n.tgt.x - n.cur.x, ey = n.tgt.y - n.cur.y, ez = n.tgt.z - n.cur.z
      if (Math.abs(ex) + Math.abs(ey) + Math.abs(ez) > 0.6) {
        n.cur.x += ex * pe; n.cur.y += ey * pe; n.cur.z += ez * pe
        fast = true
      } else { n.cur.x = n.tgt.x; n.cur.y = n.tgt.y; n.cur.z = n.tgt.z }
      if (n.visT === 0 && n.vis === 0 && !this.layoutHas(n.id)) removed = true
    }
    if (removed) {
      this.list = this.list.filter(n => {
        const keep = !(n.visT === 0 && n.vis === 0 && !this.layoutHas(n.id))
        if (!keep) this.nodes.delete(n.id)
        return keep
      })
    }
    return fast ? 'fast' : orbiting ? 'orbit' : null
  }

  private layoutHas(id: string): boolean {
    return !!this.layout && (this.layout.targets.has(id) || this.layout.hidden.has(id))
  }

  // ── Projection ───────────────────────────────────────────────────────────

  /** Project into this.P; false when behind the camera. */
  private project(x: number, y: number, z: number): boolean {
    const c = this.cam
    x -= c.tx; y -= c.ty; z -= c.tz
    const X = x * this.cyR - z * this.syR
    const Z1 = x * this.syR + z * this.cyR
    const Y = y * this.cxR - Z1 * this.sxR
    const Z = y * this.sxR + Z1 * this.cxR
    const zc = Z + c.D
    if (zc < 40) return false
    const s = (c.f * c.zoom) / zc
    const P = this.P
    P.px = this.W / 2 + X * s + c.panX
    P.py = this.H * CENTER_Y + Y * s + c.panY
    P.zc = zc
    P.s = s
    return true
  }

  /** Screen offset of the look-at point: the funnel sits left of center so
   *  its lane labels get the right-hand side (the legend owns the bottom left). */
  private offsetX(L: SpaceLayout): number {
    return L.labels === 'side' ? -this.W * 0.09 : 0
  }

  /** Points that must stay on screen: cards, label anchors, axis ends. */
  private fitPoints(L: SpaceLayout): Vec3[] {
    const pts: Vec3[] = []
    if (L.guides.kind === 'axes') {
      const e = L.guides.L * 1.06
      for (const x of [-e, e]) for (const y of [-e, e]) for (const z of [-e, e]) pts.push({ x, y, z })
      return pts
    }
    const all = [...L.targets.entries()].filter(([id]) => !L.hidden.has(id)).map(([, p]) => p)
    const step = Math.max(1, Math.ceil(all.length / 400))
    for (let i = 0; i < all.length; i += step) pts.push(all[i])
    if (L.labels === 'above') for (const c of L.clusters) if (c.ids.length) pts.push(c.labelAt)
    if (L.guides.kind === 'funnel') {
      const f = L.guides.profile
      for (const y of [f.yTop, f.yTop + (f.yNeck - f.yTop) * 0.35, f.yNeck, f.yBottom]) {
        const r = funnelRadius(f, y)
        for (let a = 0; a < 8; a++) {
          const t = (a / 8) * Math.PI * 2
          pts.push({ x: Math.sin(t) * r, y, z: Math.cos(t) * r })
        }
      }
    }
    if (!pts.length) pts.push({ x: 0, y: 0, z: 0 })
    return pts
  }

  /**
   * Camera distance that frames the layout: the smallest distance at which
   * every fit point (plus a card's half size) lands inside the margins,
   * checked at the layout's tilt over the azimuths the orbit will visit.
   * Margins leave room for the KPI strip (top left), the legend (bottom
   * left) and, for the funnel, the lane labels beside the bands.
   */
  private computeFit(L: SpaceLayout): number {
    const { W, H } = this
    if (!W || !H) return 2000
    const pts = this.fitPoints(L)
    const f = this.cam.f
    const card = 50 * L.sizeScale
    const side = L.labels === 'side'
    // the lane labels' column: 250px on a wide canvas, 40% of a phone's (the labels shorten to fit)
    const left = W * 0.04, right = side ? (W < 560 ? Math.max(140, W * 0.4) : Math.max(250, W * 0.22)) : W * 0.05
    const cx0 = W / 2 + this.offsetX(L)
    const top = Math.max(58, H * 0.09), bottom = Math.max(46, H * 0.07)
    const azimuths = L.rotY !== null ? [L.rotY] : Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2)
    const sx = Math.sin(L.rotX), cx = Math.cos(L.rotX)
    const fitsAt = (a: number, D: number) => {
      const sy = Math.sin(a), cy = Math.cos(a)
      for (const p of pts) {
        const X = p.x * cy - p.z * sy
        const Z1 = p.x * sy + p.z * cy
        const Y = p.y * cx - Z1 * sx
        const zc = p.y * sx + Z1 * cx + D
        if (zc < 60) return false
        const s = f / zc
        const px = cx0 + X * s, py = H * CENTER_Y + Y * s, r = card * s
        if (px - r < left || px + r > W - right || py - r < top || py + r > H - bottom) return false
      }
      return true
    }
    // Per azimuth, the closest distance that fits; frame at the 75th
    // percentile so one lopsided angle doesn't shrink every other one.
    const ds = azimuths.map(a => {
      let lo = 300, hi = 40000
      if (!fitsAt(a, hi)) return hi
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) / 2
        if (fitsAt(a, mid)) hi = mid
        else lo = mid
      }
      return hi
    }).sort((x, y) => x - y)
    return ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.75))]
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  /** The pre-scaled bitmap nearest the card's size in device pixels (never
   *  sampled from more than ~2x larger, so small cards stay clean). */
  private level(th: Thumb, w: number, h: number) {
    const need = Math.max(w, h) * this.DPR * 0.9
    const lv = th.levels
    let pick = lv[0]
    for (let i = 1; i < lv.length; i++) {
      if (Math.max(lv[i].w, lv[i].h) >= need) pick = lv[i]
      else break
    }
    return pick
  }

  private setFont(font: string) {
    if (this.curFont !== font) { this.ctx.font = font; this.curFont = font }
  }

  /** Text width at `px`: measured at `px` rounded to MEASURE_STEP and
   *  cached per weight, size and text (label sizes follow depth, so exact
   *  sizes never repeat; the rounding keeps the cache small), then scaled
   *  the last fraction of a pixel. */
  private measure(weight: number, s: string, px: number): number {
    const mpx = Math.max(MEASURE_STEP, Math.round(px / MEASURE_STEP) * MEASURE_STEP)
    const k = weight + '|' + mpx + '|' + s
    let w = this.textW.get(k)
    if (w === undefined) {
      this.setFont(`${weight} ${mpx}px ${SANS}`)
      w = this.ctx.measureText(s).width
      if (this.textW.size > 2000) this.textW.clear()
      this.textW.set(k, w)
    }
    return (w * px) / mpx
  }

  private draw(fast: boolean) {
    const { ctx, W, H, DPR } = this
    const c = this.cam
    this.drewFast = fast
    this.syR = Math.sin(c.rotY); this.cyR = Math.cos(c.rotY)
    this.sxR = Math.sin(c.rotX); this.cxR = Math.cos(c.rotX)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H)
    this.labelRects.length = 0

    this.drawGuideLines()

    // Cards, back to front. Drawn entries are pooled across frames.
    const pool = this.drawn
    let count = 0
    const P = this.P
    for (let i = 0; i < this.list.length; i++) {
      const n = this.list[i]
      if (n.vis < 0.01) continue
      if (!this.project(n.cur.x, n.cur.y, n.cur.z) || P.zc < 90) continue
      const base = n.size * P.s * n.vis
      const th = this.cb.getThumb(n.id)
      const ar = th ? th.ar : 0.8
      const w = ar >= 1 ? base : base * ar
      const h = ar >= 1 ? base / ar : base
      // Off screen, card size included.
      if (P.px + w / 2 < -8 || P.px - w / 2 > W + 8 || P.py + h / 2 < -8 || P.py - h / 2 > H + 8) continue
      let d = pool[count]
      if (!d) { d = { n, sx: 0, sy: 0, w: 0, h: 0, zc: 0, th: undefined, a: 1, hi: false }; pool[count] = d }
      d.n = n; d.sx = P.px; d.sy = P.py; d.w = w; d.h = h; d.zc = P.zc; d.th = th
      count++
    }
    this.drawnCount = count
    // Sort only this frame's entries (the pool's tail is stale).
    if (pool.length > count) pool.length = count
    pool.sort(byDepth)

    // Full resolution only for the largest few big cards (see HIRES_PER_FRAME).
    const frame = ++this.frameNo
    const hiCand = this.hiCand
    hiCand.length = 0
    for (let i = 0; i < count; i++) {
      const d = pool[i]
      d.hi = !!d.th && Math.max(d.w, d.h) * DPR > HIRES_AT
      if (d.hi) hiCand.push(d)
    }
    if (hiCand.length > HIRES_PER_FRAME) {
      hiCand.sort((a, b) => b.w * b.h - a.w * a.h)
      for (let i = HIRES_PER_FRAME; i < hiCand.length; i++) hiCand[i].hi = false
    }
    hiCand.length = 0

    const spot = this.spotlight
    const dimOthers = this.hoverGroup !== null ? 0.15 : this.isolated !== null ? 0.07 : FOCUS_DIM
    // While focused, other groups' cards between the camera and the framed group thin out to nothing as they
    // near the camera (from 75% of the look-at distance down to 35%), so none covers it.
    const nearFade = this.focused !== null && spot !== null
    const fadeFar = c.D * 0.75, fadeNear = c.D * 0.35
    const fitAlpha = DEPTH_ALPHA * this.fitD
    const pal = this.pal
    const axes = this.layout?.kind === 'axes'
    const sb = this.spotBox
    sb.n = 0; sb.x0 = Infinity; sb.y0 = Infinity; sb.x1 = -Infinity; sb.y1 = -Infinity
    for (let i = 0; i < count; i++) {
      const d = pool[i]
      const n = d.n
      let alpha = Math.min(1, Math.max(0.28, fitAlpha / d.zc)) * n.vis
      if (spot !== null && n.group !== spot) {
        alpha *= dimOthers
        if (nearFade && d.zc < fadeFar) alpha *= clamp((d.zc - fadeNear) / (fadeFar - fadeNear), 0, 1)
      } else if (axes && spot !== null && n.vis > 0.5) {
        // The axes draw no group labels; the spotlit group gets one above its cards (drawClusterLabels).
        sb.n++
        sb.x0 = Math.min(sb.x0, d.sx - d.w / 2); sb.x1 = Math.max(sb.x1, d.sx + d.w / 2)
        sb.y0 = Math.min(sb.y0, d.sy - d.h / 2); sb.y1 = Math.max(sb.y1, d.sy + d.h / 2)
      }
      d.a = alpha
      if (alpha < 0.004) continue
      const x = d.sx - d.w / 2, y = d.sy - d.h / 2
      const radius = Math.max(1.5, d.w * CARD_RADIUS)
      // Contact shadow: an offset fill, not shadowBlur. Skipped in motion
      // (it's barely visible there) and back on the first still frame.
      if (!fast && d.w >= 14) {
        ctx.globalAlpha = alpha
        ctx.beginPath(); ctx.roundRect(x - 0.5, y + 1, d.w + 1, d.h + 0.75, radius + 0.5)
        ctx.fillStyle = pal.shadow; ctx.fill()
      }
      ctx.globalAlpha = alpha
      if (d.th) {
        // Zoomed in on a card: the full-resolution image once it has decoded, the baked sizes until then.
        const lv = (d.hi && hiResThumb(d.th, this.invalidate, frame)) || this.level(d.th, d.w, d.h)
        ctx.drawImage(lv.img, x, y, d.w, d.h)
      } else {
        // Neutral card: still loading, or no image we can show without a Meta call.
        ctx.beginPath(); ctx.roundRect(x, y, d.w, d.h, radius)
        ctx.fillStyle = pal.emptyCard; ctx.fill()
      }
      // Hairline edge; dashed in the group color when the placement is an
      // estimate (funnel position read from frequency and CPMr).
      if (d.w >= 6) {
        ctx.beginPath(); ctx.roundRect(x + 0.25, y + 0.25, d.w - 0.5, d.h - 0.5, radius)
        if (n.dashed) {
          ctx.setLineDash([3, 2.5]); ctx.strokeStyle = n.color; ctx.lineWidth = 1
          ctx.stroke(); ctx.setLineDash([])
        } else {
          ctx.strokeStyle = pal.hairline; ctx.lineWidth = 0.75
          ctx.stroke()
        }
      }
      // Group color: a small dot in the top-left corner, on a white ring. In the axes the color is the only
      // sign of a card's group and most cards are small, so the dot goes down to small cards there.
      if (d.w >= 18 || (axes && d.w >= 9)) {
        const r = d.w >= 18 ? clamp(d.w * 0.036, 2.25, 4) : 1.75
        const inset = d.w >= 18 ? clamp(d.w * 0.05, 3.5, 6) : 2.25
        const cx = x + inset + r, cy = y + inset + r
        if (!fast) {
          ctx.beginPath(); ctx.arc(cx, cy, r + 1.25, 0, 7)
          ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill()
        }
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7)
        ctx.fillStyle = n.color; ctx.fill()
      }
      if (n.video && d.w >= 22) {
        const r = clamp(d.w * 0.06, 3.5, 7)
        const bx = x + d.w - r - clamp(d.w * 0.05, 3.5, 6), by = y + r + clamp(d.w * 0.05, 3.5, 6)
        ctx.globalAlpha = alpha * 0.9
        ctx.beginPath(); ctx.arc(bx, by, r, 0, 7)
        ctx.fillStyle = 'rgba(26,26,26,.55)'; ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.moveTo(bx - r * 0.26, by - r * 0.4)
        ctx.lineTo(bx - r * 0.26, by + r * 0.4)
        ctx.lineTo(bx + r * 0.46, by)
        ctx.fill()
      }
      // The same visual in several ads: an "N×" pill in the bottom-right corner (the drawer steps through them).
      if (n.count > 1 && d.w >= 26) {
        const fs = clamp(d.w * 0.1, 8, 12)
        const label = `${n.count}×`
        this.setFont(`600 ${fs}px ${SANS}`)
        const tw = ctx.measureText(label).width
        const ph = fs + 5, pw = Math.max(ph, tw + fs * 0.9)
        const inset = clamp(d.w * 0.05, 3.5, 6)
        const px = x + d.w - inset - pw, py = y + d.h - inset - ph
        ctx.globalAlpha = alpha * 0.92
        ctx.beginPath(); ctx.roundRect(px, py, pw, ph, ph / 2)
        ctx.fillStyle = 'rgba(26,26,26,.62)'; ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(label, px + pw / 2, py + ph / 2 + 0.5)
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
      }
      // Hover and selection: a ring offset outside the card, never a fat edge.
      const selected = n.id === this.selectedId
      if (selected || n.id === this.hoverId) {
        const o = 2.5
        ctx.globalAlpha = Math.max(alpha, 0.85)
        ctx.beginPath(); ctx.roundRect(x - o, y - o, d.w + o * 2, d.h + o * 2, radius + o)
        ctx.strokeStyle = selected ? pal.ink : pal.hoverRing
        ctx.lineWidth = selected ? 1.5 : 1
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    this.drawGuideLabels()
    this.drawClusterLabels()
  }

  /** A horizontal ring's on-screen extremes; with `path`, its outline is
   *  also added to the current path (no per-point allocation). */
  private ring(r: number, y: number, path = false): Rim {
    let lx = Infinity, ly = 0, rx = -Infinity, ry = 0
    const ctx = this.ctx
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * Math.PI * 2
      if (!this.project(Math.sin(a) * r, y, Math.cos(a) * r)) return null
      const px = this.P.px, py = this.P.py
      if (path) { if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py) }
      if (px < lx) { lx = px; ly = py }
      if (px > rx) { rx = px; ry = py }
    }
    return { left: [lx, ly], right: [rx, ry] }
  }

  private line(a: Vec3, b: Vec3) {
    if (!this.project(a.x, a.y, a.z)) return
    const px = this.P.px, py = this.P.py
    if (!this.project(b.x, b.y, b.z)) return
    this.ctx.beginPath(); this.ctx.moveTo(px, py); this.ctx.lineTo(this.P.px, this.P.py); this.ctx.stroke()
  }

  /** Heights down the funnel wall for its lines: dense through the bowl, a few down the spout. */
  private funnelHeights(f: FunnelProfile): number[] {
    const ys: number[] = []
    for (let i = 0; i <= 28; i++) ys.push(f.yTop + ((f.yNeck - f.yTop) * i) / 28)
    for (let i = 1; i <= 3; i++) ys.push(f.yNeck + ((f.yBottom - f.yNeck) * i) / 3)
    return ys
  }

  /**
   * The funnel as lines (Peter, Oct 2 2026: "the funnel 3d line visual ... a circular 3d funnel"): lines running
   * down the wall from the mouth to the spout, rings across it (the mouth's rim, where each lane begins in its
   * colour, the neck and the spout's end) and the outline. The half of the wall facing away is fainter, so it reads
   * as a solid shape while it turns. Drawn under the cards.
   */
  private drawFunnel(f: FunnelProfile, bands: Array<{ key: string; y0: number; color: string }>) {
    const ctx = this.ctx
    const ink = this.pal.silhouette
    const ys = this.funnelHeights(f)
    // lines down the wall
    ctx.lineWidth = 1
    ctx.strokeStyle = ink
    const M = 20
    for (let m = 0; m < M; m++) {
      const th = (m / M) * Math.PI * 2
      const sn = Math.sin(th), cs = Math.cos(th)
      const away = sn * this.syR + cs * this.cyR > 0
      ctx.globalAlpha = away ? 0.38 : 0.7
      ctx.beginPath()
      let on = false
      for (const y of ys) {
        const r = funnelRadius(f, y)
        if (!this.project(sn * r, y, cs * r)) { on = false; continue }
        if (on) ctx.lineTo(this.P.px, this.P.py)
        else { ctx.moveTo(this.P.px, this.P.py); on = true }
      }
      ctx.stroke()
    }
    // faint rings down the bowl
    ctx.globalAlpha = 0.42
    for (let i = 0; i < ys.length; i++) {
      if (i % 4 !== 0 && i !== ys.length - 1) continue
      ctx.beginPath()
      if (this.ring(funnelRadius(f, ys[i]), ys[i], true)) ctx.stroke()
    }
    // the outline: the wall's true silhouette from where the camera stands
    ctx.globalAlpha = 1
    this.strokeSilhouette(f)
    // the mouth's rim, the neck and the spout's end, firmer
    ctx.lineWidth = 1.25
    for (const y of [f.yTop, f.yNeck, f.yBottom]) {
      ctx.beginPath()
      if (this.ring(funnelRadius(f, y), y, true)) ctx.stroke()
    }
    // where each lane begins, in its colour (the first starts at the mouth)
    ctx.lineWidth = 1.5
    ctx.globalAlpha = 0.6
    for (const b of bands.slice(1)) {
      ctx.strokeStyle = b.color
      ctx.beginPath()
      if (this.ring(funnelRadius(f, b.y0), b.y0, true)) ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  /**
   * The funnel's outline: the true silhouette (contour) of the wall seen from the camera. On a surface of
   * revolution the contour at height y is where the wall's normal is square to the line of sight, which solves
   * to cos(th - phi) = (r - r'(y) (y - Cy)) / rho, with rho and phi the camera's distance from the axis and its
   * azimuth. From the side that is the wall's left and right edge; looking down into the bowl it shrinks to
   * nothing, since the rim is the outline there. (It used to join each ring's leftmost and rightmost points,
   * right only at a level view: from above those points made two jagged spokes across the bowl that jumped as
   * the view turned.) Pan and screen zoom are 2D, so they never move the contour.
   */
  private strokeSilhouette(f: FunnelProfile) {
    const c = this.cam
    // The camera in world space: project()'s translate and two rotations, inverted.
    const Cx = c.tx - c.D * this.cxR * this.syR
    const Cy = c.ty - c.D * this.sxR
    const Cz = c.tz - c.D * this.cxR * this.cyR
    const rho = Math.hypot(Cx, Cz)
    if (rho < 1e-6) return
    const phi = Math.atan2(Cx, Cz)
    const hs: number[] = []
    for (let i = 0; i <= 64; i++) hs.push(f.yTop + ((f.yNeck - f.yTop) * i) / 64)
    for (let i = 1; i <= 4; i++) hs.push(f.yNeck + ((f.yBottom - f.yNeck) * i) / 4)
    const ctx = this.ctx
    for (const side of [1, -1]) {
      ctx.beginPath()
      let on = false
      for (const y of hs) {
        const r = funnelRadius(f, y)
        const q = (r - funnelSlope(f, y) * (y - Cy)) / rho
        if (q < -1 || q > 1) { on = false; continue }
        const th = phi + side * Math.acos(q)
        if (!this.project(Math.sin(th) * r, y, Math.cos(th) * r)) { on = false; continue }
        if (on) ctx.lineTo(this.P.px, this.P.py)
        else { ctx.moveTo(this.P.px, this.P.py); on = true }
      }
      ctx.stroke()
    }
  }

  private drawGuideLines() {
    const g = this.layout?.guides
    if (!g || g.kind === 'none') return
    const ctx = this.ctx
    if (g.kind === 'funnel') {
      this.drawFunnel(g.profile, g.bands)
      return
    }
    // Metric axes: the cube's edges, a floor grid, then the three axes.
    const L = g.L
    const P = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
    ctx.lineWidth = 1
    ctx.strokeStyle = this.pal.grid
    for (const t of [0.25, 0.5, 0.75]) {
      const v = -L + 2 * L * t
      this.line(P(v, L, -L), P(v, L, L))
      this.line(P(-L, L, v), P(L, L, v))
    }
    ctx.strokeStyle = this.pal.edge
    const cs = [-L, L]
    for (const a of cs) for (const b of cs) {
      this.line(P(-L, a, b), P(L, a, b))
      this.line(P(a, -L, b), P(a, L, b))
      this.line(P(a, b, -L), P(a, b, L))
    }
    ctx.strokeStyle = this.pal.axis
    ctx.lineWidth = 1
    const O = P(-L, L, -L)
    this.line(O, P(L, L, -L))
    this.line(O, P(-L, -L, -L))
    this.line(O, P(-L, L, L))
  }

  private text(s: string, x: number, y: number, opts: { font: string; color: string; align?: CanvasTextAlign; halo?: boolean }) {
    const ctx = this.ctx
    this.setFont(opts.font)
    ctx.textAlign = opts.align || 'center'
    ctx.textBaseline = 'middle'
    if (opts.halo) {
      ctx.lineWidth = 3.5
      ctx.lineJoin = 'round'
      ctx.strokeStyle = this.pal.halo
      ctx.strokeText(s, x, y)
    }
    ctx.fillStyle = opts.color
    ctx.fillText(s, x, y)
  }

  private drawGuideLabels() {
    const g = this.layout?.guides
    if (!g || g.kind !== 'axes') return
    const L = g.L
    const O: Vec3 = { x: -L, y: L, z: -L }
    const dir: Record<string, Vec3> = { x: { x: 2 * L, y: 0, z: 0 }, y: { x: 0, y: -2 * L, z: 0 }, z: { x: 0, y: 0, z: 2 * L } }
    // Tick labels sit just outside the cube, away from the other two axes.
    const off: Record<string, Vec3> = { x: { x: 0, y: 44, z: -44 }, y: { x: -46, y: 0, z: -46 }, z: { x: -44, y: 44, z: 0 } }
    this.ctx.globalAlpha = 1
    for (const ax of g.axes) {
      const d = dir[ax.dim], o = off[ax.dim]
      for (const t of ax.ticks) {
        if (!this.project(O.x + d.x * t.t + o.x, O.y + d.y * t.t + o.y, O.z + d.z * t.t + o.z)) continue
        this.text(t.text, this.P.px, this.P.py, { font: `400 10px ${SANS}`, color: this.pal.muted, halo: true })
      }
      if (this.project(O.x + d.x * 1.13 + o.x * 1.7, O.y + d.y * 1.13 + o.y * 1.7, O.z + d.z * 1.13 + o.z * 1.7)) {
        this.text(`${ax.dim.toUpperCase()}  ${truncate(ax.title, 26)}`, this.P.px, this.P.py, {
          font: `600 11px ${SANS}`, color: this.pal.ink, halo: true,
        })
      }
    }
  }

  /**
   * A cluster label: color dot, name in small semibold sans, the count in
   * muted tabular figures, all on a halo in the canvas color (no filled
   * pill, no border). The hit rect still covers the whole label.
   */
  private label(
    name: string, count: string, color: string, cx: number, cy: number, fs: number, alpha: number,
    align: 'center' | 'right' | 'left', key: string, hit = true,
  ) {
    const ctx = this.ctx
    const countPx = Math.round(fs * 0.85 * 10) / 10
    const nameFont = `600 ${fs}px ${SANS}`
    const countFont = `500 ${countPx}px ${SANS}`
    const tw = this.measure(600, name, fs)
    const dotR = Math.max(2.5, fs * 0.22)
    const g1 = fs * 0.42, g2 = fs * 0.5
    const bw = this.labelWidth(name, count, fs)
    const bh = fs * 1.7
    const bx = align === 'center' ? cx - bw / 2 : align === 'right' ? cx - bw : cx
    const by = cy - bh / 2
    ctx.globalAlpha = alpha
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.beginPath(); ctx.arc(bx + dotR, cy, dotR + 1.75, 0, 7)
    ctx.fillStyle = this.pal.halo; ctx.fill()
    ctx.beginPath(); ctx.arc(bx + dotR, cy, dotR, 0, 7)
    ctx.fillStyle = color; ctx.fill()
    const tx = bx + dotR * 2 + g1
    const cx2 = tx + tw + g2
    // Both halos first, then both fills, so the count's halo can never paint
    // over the end of the name.
    ctx.lineWidth = 4
    ctx.strokeStyle = this.pal.halo
    this.setFont(nameFont)
    ctx.strokeText(name, tx, cy)
    this.setFont(countFont)
    ctx.strokeText(count, cx2, cy)
    ctx.fillStyle = this.pal.muted
    ctx.fillText(count, cx2, cy)
    this.setFont(nameFont)
    ctx.fillStyle = this.pal.ink
    ctx.fillText(name, tx, cy)
    ctx.globalAlpha = 1
    if (hit) this.labelRects.push({ x: bx, y: by, w: bw, h: bh, key })
    return { bx, by, bw, bh }
  }

  /** A label's drawn width (label() lays it out the same way). */
  private labelWidth(name: string, count: string, fs: number): number {
    const countPx = Math.round(fs * 0.85 * 10) / 10
    return Math.max(2.5, fs * 0.22) * 2 + fs * 0.42 + this.measure(600, name, fs) + fs * 0.5 + this.measure(500, count, countPx)
  }

  private visibleCount(c: Cluster | undefined): number {
    let n = 0
    if (c) for (const id of c.ids) if (this.layout && !this.layout.hidden.has(id)) n++
    return n
  }

  /** How strongly a label not in the spotlight shows: faint beside a hovered or isolated group, half way beside
   *  a focused one (the labels stay there to click on to the next group). */
  private get labelDim(): number {
    return this.hoverGroup === null && this.isolated === null ? 0.55 : 0.25
  }

  private drawClusterLabels() {
    const L = this.layout
    if (!L) return
    if (L.labels === 'none') {
      // The axes have no group labels (a group runs all through the cube), but a spotlit group (a hovered
      // legend row, an isolated or focused group) gets one just above its cards, to click to let it go or
      // right-click for its menu.
      const key = this.spotlight, sb = this.spotBox
      const c = key !== null ? this.clusterByKey.get(key) : undefined
      if (L.kind !== 'axes' || !c || !sb.n) return
      const fs = 12
      const name = truncate(c.name, 34), count = String(this.visibleCount(c))
      const w = this.labelWidth(name, count, fs)
      const x = clamp((sb.x0 + sb.x1) / 2, w / 2 + OVERLAY_INSET, this.W - w / 2 - OVERLAY_INSET)
      const y = clamp(sb.y0 - 14, Math.max(58, this.H * 0.09), this.H - 60)
      this.label(name, count, c.color, x, y, fs, 1, 'center', c.key)
      return
    }
    if (L.labels === 'side' && L.guides.kind === 'funnel') {
      // Funnel: one column of pills beside the funnel, each at its band's
      // height. The bands are centered on the orbit axis, so their screen
      // width doesn't change as it turns. Measured on the widest rim (real
      // on-screen extremes, perspective widens the near side), padded by a
      // card so no pill sits on the cards.
      const bands = L.guides.bands.map(b => {
        const yMid = (b.y0 + b.y1) / 2
        const ok = this.project(0, yMid, 0)
        const p = ok ? { py: this.P.py, s: this.P.s, zc: this.P.zc } : null
        return { b, p, rim: this.ring(b.r * 1.03, yMid) }
      })
      let minLeft = Infinity, maxRight = -Infinity, sMax = 0
      for (const x of bands) {
        if (!x.rim || !x.p) continue
        minLeft = Math.min(minLeft, x.rim.left[0])
        maxRight = Math.max(maxRight, x.rim.right[0])
        sMax = Math.max(sMax, x.p.s)
      }
      // Right of the funnel by default: the legend owns the bottom left.
      const pad = 22 + 60 * sMax
      const useLeft = maxRight + pad + 200 > this.W && minLeft - pad >= 150
      const subMax = this.W < 560 ? 20 : 36
      // The column's width (names, counts and sub lines): close up on a lane, the wide rims above it reach far
      // past the canvas, so the column is held inside it wherever the rims put it.
      type Item = { c: Cluster; fs: number; y: number; step: number }
      const items: Item[] = []
      let colW = 0
      for (const { b, p, rim } of bands) {
        const c = this.clusterByKey.get(b.key)
        if (!c) continue
        // Close up on a low lane, the wide rims above it reach behind the camera: their pills stay, at the top.
        const fs = p && rim ? clamp(22000 / p.zc, 10.5, 12.5) : 10.5
        colW = Math.max(colW, this.labelWidth(c.name, String(this.visibleCount(c)), fs))
        if (c.sub) colW = Math.max(colW, this.measure(400, truncate(c.sub, subMax), 10))
        items.push({ c, fs, y: p && rim ? p.py - 7 : -Infinity, step: c.sub ? 36 : 24 })
      }
      if (!Number.isFinite(maxRight)) { minLeft = this.W * 0.5; maxRight = this.W * 0.5 }
      // Each pill at its lane's height, held inside the canvas (below the arrange control, above the canvas
      // controls) and pushed down just enough that it never sits on the one above (lanes near the neck are thin
      // and close together); then, from the bottom, pushed back up if the column ran off the end. A lane out of
      // view keeps its pill at the edge nearest it, so the next lane is always a click away.
      const yTop = 56, yBot = this.H - 60
      let floor = -Infinity
      for (const it of items) {
        it.y = Math.max(clamp(it.y, yTop, yBot), floor)
        floor = it.y + it.step
      }
      for (let i = items.length - 1, ceil = yBot; i >= 0; i--) {
        items[i].y = Math.min(items[i].y, ceil)
        if (i) ceil = items[i].y - items[i - 1].step
      }
      // The rims are measured at each lane's middle; up close the near cards stand out past them. The column
      // also clears any card drawn level with a pill (on its side of the funnel).
      let anchor = useLeft ? minLeft - pad : maxRight + pad
      for (let i = 0; i < this.drawnCount; i++) {
        const d = this.drawn[i]
        if (d.a < 0.2) continue
        const top = d.sy - d.h / 2, bot = d.sy + d.h / 2
        if (!items.some(it => bot > it.y - 12 && top < it.y + it.step - 8)) continue
        if (useLeft) { if (d.sx < this.W / 2) anchor = Math.min(anchor, d.sx - d.w / 2 - 10) }
        else if (d.sx > this.W / 2) anchor = Math.max(anchor, d.sx + d.w / 2 + 10)
      }
      anchor = useLeft ? Math.max(anchor, colW + OVERLAY_INSET) : Math.min(anchor, this.W - colW - OVERLAY_INSET)
      const align: 'right' | 'left' = useLeft ? 'right' : 'left'
      for (const { c, fs, y } of items) {
        const n = this.visibleCount(c)
        // An empty lane (a stage no ad name carries) still marks its stretch of the funnel, faintly, and takes no click.
        const dim = this.spotlight !== null && this.spotlight !== c.key
        const alpha = !n ? 0.45 : dim ? this.labelDim : 1
        const hit = n > 0 && (this.isolated === null || this.isolated === c.key)
        const r = this.label(c.name, String(n), c.color, anchor, y, fs, alpha, align, c.key, hit)
        if (c.sub) {
          this.ctx.globalAlpha = Math.min(alpha, 0.9)
          this.text(truncate(c.sub, subMax), align === 'right' ? r.bx + r.bw : r.bx, r.by + r.bh + 4, {
            font: `400 10px ${SANS}`, color: this.pal.muted, align: align === 'right' ? 'right' : 'left', halo: true,
          })
          this.ctx.globalAlpha = 1
        }
      }
      return
    }
    // Biggest groups first. A label that would land on one already drawn steps up, twice at most, then down,
    // before it gives way: at the ring's tilt a back cluster's label projects onto a front one's, bins sit close
    // in a row, and a narrow canvas (a phone) packs the clusters close.
    const taken: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
    const order = L.clusters.filter(c => c.ids.length && this.visibleCount(c)).sort((a, b) => this.visibleCount(b) - this.visibleCount(a))
    for (const c of order) {
      if (!this.project(c.labelAt.x, c.labelAt.y, c.labelAt.z) || this.P.zc < 120) continue
      const fs = clamp(22000 / this.P.zc, 10.5, 13)
      const name = truncate(c.name, 34), count = String(this.visibleCount(c))
      const w = this.measure(600, name, fs) + this.measure(500, count, fs * 0.85) + fs * 1.6 + 6
      const h = fs * 1.7
      // Held inside the canvas (below the KPI strip and the arrange control): a cluster off to one side, close
      // up on another, keeps its label at that edge, whole and clickable.
      const px = clamp(this.P.px, w / 2 + 4, Math.max(w / 2 + 4, this.W - w / 2 - 4))
      const py0 = clamp(this.P.py, 58, Math.max(58, this.H - h / 2 - 6))
      let box: { x0: number; y0: number; x1: number; y1: number } | null = null
      for (const k of [0, -1, -2, 1]) {
        const py = py0 + k * (h + 6)
        const b = { x0: px - w / 2 - 3, y0: py - h / 2 - 2, x1: px + w / 2 + 3, y1: py + h / 2 + 2 }
        if (k && (b.y0 < 46 || b.y1 > this.H - 4)) continue
        if (!taken.some(t => b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0)) { box = b; break }
      }
      if (!box) continue
      taken.push(box)
      const dim = this.spotlight !== null && this.spotlight !== c.key
      this.label(name, count, c.color, px, (box.y0 + box.y1) / 2, fs, dim ? this.labelDim : 1, 'center', c.key,
        this.isolated === null || this.isolated === c.key)
    }
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private onScroll = () => { this.rectDirty = true }

  /** Pointer position in canvas pixels, from the cached client rect. */
  private local(e: PointerEvent | MouseEvent) {
    const now = e.timeStamp || 0
    if (this.rectDirty || now - this.rectAt > 1000 || now < this.rectAt) {
      const r = this.canvas.getBoundingClientRect()
      this.rect.left = r.left; this.rect.top = r.top
      this.rectDirty = false
      this.rectAt = now
    }
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top }
  }

  /** The group label under (x, y). While a group is isolated the darkened groups' labels take no clicks, as
   *  their cards don't. */
  private labelHit(x: number, y: number): string | null {
    for (const L of this.labelRects) {
      if (this.isolated !== null && L.key !== this.isolated) continue
      if (x >= L.x && x <= L.x + L.w && y >= L.y && y <= L.y + L.h) return L.key
    }
    return null
  }

  private setHover(id: string | null, x = 0, y = 0) {
    const changed = id !== this.hoverId
    this.hoverId = id
    this.cb.onHover(id ? { id, x, y } : null)
    if (changed) this.invalidate()
  }

  /** Hit test at (x, y). The hover callback (DOM work in the hover card)
   *  runs when the card under the pointer changes, or the pointer moved. */
  private pick(x: number, y: number, moved = true) {
    let hit: string | null = null
    // Group labels draw over the cards: on a label the label wins, for hover as for a click.
    const onLabel = this.labelHit(x, y) !== null
    // A lit card wins over a faded one drawn in front of it (a focused group's neighbours, the near side of a
    // ring thinning out): a faded card only takes the pointer when nothing lit is under it.
    let faded: string | null = null
    for (let i = this.drawnCount - 1; i >= 0 && !onLabel; i--) {
      const d = this.drawn[i]
      if (!d || d.n.visT === 0 || d.a < 0.03) continue
      if (this.isolated !== null && d.n.group !== this.isolated) continue
      if (x >= d.sx - d.w / 2 && x <= d.sx + d.w / 2 && y >= d.sy - d.h / 2 && y <= d.sy + d.h / 2) {
        if (d.a >= PICK_LIT) { hit = d.n.id; break }
        if (faded === null) faded = d.n.id
      }
    }
    if (hit === null) hit = faded
    if (hit !== this.hoverId || (hit && moved)) this.setHover(hit, x, y)
    const cursor = hit || onLabel ? 'pointer' : this.dragging ? 'grabbing' : 'grab'
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor
  }

  /** Hover hit test at most once a frame, and not while the view spins fast. */
  private queuePick(x: number, y: number, moved = true) {
    const prev = this.pendingPick
    this.pendingPick = { x, y, moved: moved || !!prev?.moved }
    if (this.pickRaf || this.destroyed) return
    this.pickRaf = requestAnimationFrame(() => {
      this.pickRaf = 0
      const p = this.pendingPick
      this.pendingPick = null
      if (!p || this.dragging || !this.pointerInside) return
      if (Math.hypot(this.spinX, this.spinY) >= PICK_SPIN_MAX) return
      this.pick(p.x, p.y, p.moved)
    })
  }

  private sample(e: PointerEvent) {
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    if (list.length) for (const ce of list) this.samples.push([ce.timeStamp, ce.clientX, ce.clientY])
    else this.samples.push([e.timeStamp, e.clientX, e.clientY])
    const cutoff = e.timeStamp - FLING_WINDOW * 2
    let drop = 0
    while (drop < this.samples.length - 2 && this.samples[drop][0] < cutoff) drop++
    if (drop) this.samples.splice(0, drop)
  }

  /** Pointer velocity (px/ms) over the last FLING_WINDOW ms, or zero when
   *  the pointer stood still before letting go. */
  private releaseVelocity(upT: number): { vx: number; vy: number } {
    const s = this.samples
    if (s.length < 2) return { vx: 0, vy: 0 }
    const last = s[s.length - 1]
    if (upT - last[0] > FLING_HOLD) return { vx: 0, vy: 0 }
    let i = s.length - 1
    while (i > 0 && last[0] - s[i - 1][0] <= FLING_WINDOW) i--
    const first = s[i]
    const span = last[0] - first[0]
    if (span < 8) return { vx: 0, vy: 0 }
    return { vx: (last[1] - first[1]) / span, vy: (last[2] - first[2]) / span }
  }

  /** Pointer or wheel input on the space: restarts a wound-down idle orbit. */
  private touch() {
    const wasIdle = performance.now() - this.lastInput >= ORBIT_IDLE_MS
    this.lastInput = performance.now()
    if (wasIdle) this.invalidate()
  }

  private onPointerEnter = () => { this.pointerInside = true; this.rectDirty = true; this.touch() }

  private onPointerDown = (e: PointerEvent) => {
    this.touch()
    try { this.canvas.setPointerCapture(e.pointerId) } catch { /* not capturable */ }
    this.rectDirty = true
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
      this.dragged = true
      this.spinX = 0; this.spinY = 0
      return
    }
    this.dragging = true
    this.dragged = false
    this.dragDist = 0
    this.ctxSeen = false
    this.cancelMenu()
    this.panMode = e.shiftKey || e.button === 1 || e.button === 2
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.anim.active = false
    // Catching a spinning view stops it, like a hand on a globe.
    this.spinX = 0; this.spinY = 0
    this.samples.length = 0
    this.sample(e)
    this.canvas.style.cursor = 'grabbing'
  }

  private onPointerMove = (e: PointerEvent) => {
    this.touch()
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (this.pinchDist > 0 && d > 0) {
        // Zoom about the midpoint of the two fingers.
        const r = this.local(e)
        const mx = (a.x + b.x) / 2 - (e.clientX - r.x), my = (a.y + b.y) / 2 - (e.clientY - r.y)
        this.zoomAbout(mx, my, d / this.pinchDist)
      }
      this.pinchDist = d
      return
    }
    if (!this.dragging) {
      const { x, y } = this.local(e)
      this.lastPointer.x = x; this.lastPointer.y = y
      this.pointerInside = true
      this.queuePick(x, y)
      return
    }
    const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.dragDist += Math.abs(dx) + Math.abs(dy)
    if (this.dragDist > 4) this.dragged = true
    if (!this.panMode) this.sample(e)
    if (!this.dragged) return
    if (this.hoverId) this.setHover(null)
    if (this.panMode) { this.cam.panX += dx; this.cam.panY += dy }
    else {
      this.cam.rotY += dx * ROT_PER_PX
      this.cam.rotX = clamp(this.cam.rotX + dy * ROT_PER_PX, -1.25, 1.25)
    }
    this.invalidate()
  }

  private endPointer(e: PointerEvent) {
    this.pointers.delete(e.pointerId)
    try { this.canvas.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    if (this.pointers.size < 2) this.pinchDist = 0
  }

  private onPointerUp = (e: PointerEvent) => {
    this.endPointer(e)
    if (!this.dragging) return
    this.dragging = false
    const { x, y } = this.local(e)
    this.lastPointer.x = x; this.lastPointer.y = y
    if (!this.dragged && e.button === 0) {
      // A group label draws over the cards, so it takes the click before the card under it.
      this.pick(x, y)
      const key = this.labelHit(x, y)
      if (key) {
        if (this.cb.onGroupClick) this.cb.onGroupClick(key)
        else this.focus(key)
      } else if (this.hoverId) this.cb.onOpen(this.hoverId)
    } else if (!this.dragged && e.button === 2) {
      // A right-click (no drag) on a group label, or on a card for its group: the group menu.
      this.pick(x, y)
      const key = this.labelHit(x, y) || (this.hoverId ? this.nodes.get(this.hoverId)?.group : null)
      if (key) this.openGroupMenu(key, e.clientX, e.clientY)
    } else if (this.dragged && !this.panMode) {
      // The flick: angular speed from the release velocity, capped.
      const { vx, vy } = this.releaseVelocity(e.timeStamp)
      let sy = vx * ROT_PER_PX, sx = vy * ROT_PER_PX
      const mag = Math.hypot(sx, sy)
      if (mag > FLING_MAX) { sx *= FLING_MAX / mag; sy *= FLING_MAX / mag }
      if (Math.hypot(sx, sy) >= FLING_MIN * 5) {
        this.spinY = sy
        this.spinX = sx
        // The orbit resumes in the direction the view was thrown.
        if (Math.abs(sy) > ORBIT_RATE) this.orbitDir = Math.sign(sy)
      }
      this.orbit = 0
    }
    this.samples.length = 0
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab'
    this.invalidate()
  }

  private onPointerCancel = (e: PointerEvent) => {
    this.endPointer(e)
    this.dragging = false
    this.samples.length = 0
    this.canvas.style.cursor = 'grab'
    this.invalidate()
  }

  private onPointerLeave = () => {
    this.pointerInside = false
    this.pendingPick = null
    if (!this.dragging && this.hoverId) this.setHover(null)
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.touch()
    let dy = e.deltaY
    if (e.deltaMode === 1) dy *= 16
    else if (e.deltaMode === 2) dy *= this.H || 600
    // One event never jumps more than a big mouse-wheel notch.
    dy = clamp(dy, -160, 160)
    // ctrlKey: a trackpad pinch (Chrome, Safari and Firefox send it this way). Zooms about the pointer.
    const k = Math.exp(-dy * (e.ctrlKey ? PINCH_ZOOM : WHEEL_ZOOM))
    const { x, y } = this.local(e)
    this.zoomAbout(x, y, k)
  }

  /** Double-click zooms in about the pointer, onto a card or anywhere (Shift: out). The reset button
   *  brings the whole view back. */
  private onDblClick = (e: MouseEvent) => {
    this.touch()
    const { x, y } = this.local(e)
    // A group label's first click already flies to the group: zooming on top of that glide would cut it short.
    if (this.labelHit(x, y)) return
    this.zoomAbout(x, y, e.shiftKey ? 1 / DBL_ZOOM : DBL_ZOOM)
  }

  /** How many of a group's cards were drawn on screen in the last frame (0: none in view). */
  onScreenCount(key: string): number {
    let n = 0
    for (let i = 0; i < this.drawnCount; i++) if (this.drawn[i]?.n.group === key) n++
    return n
  }

  /**
   * The group menu for a right-click. Mac Chrome sends contextmenu as the button goes down, Windows (and
   * Linux) as it comes up, after pointerup: a menu opened at pointerup there reads that late contextmenu as a
   * click away and closes at once. So until this press has had its contextmenu, the menu waits for it (or a
   * short timeout, when none comes). The card's hover card hides first, it would sit under the menu.
   */
  private openGroupMenu(key: string, x: number, y: number) {
    this.pendingPick = null
    this.setHover(null)
    const open = () => this.cb.onGroupMenu?.(key, x, y)
    this.cancelMenu()
    if (this.ctxSeen) { open(); return }
    this.pendingMenu = open
    this.menuTimer = window.setTimeout(() => {
      const f = this.pendingMenu
      this.pendingMenu = null; this.menuTimer = 0
      f?.()
    }, 300)
  }

  private cancelMenu() {
    if (this.menuTimer) { clearTimeout(this.menuTimer); this.menuTimer = 0 }
    this.pendingMenu = null
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    this.ctxSeen = true
    const f = this.pendingMenu
    if (f) { this.cancelMenu(); f() }
  }
}
