/**
 * Slideshow: one group's creatives one at a time, big, with their metrics.
 * Arrow keys or the side buttons step through; Space plays and pauses; the
 * filmstrip jumps; Inspect opens the ad drawer. Sits over the space like the
 * plain view, so Back returns to the 3D view exactly as it was.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, ScanSearch } from 'lucide-react'
import type { SpaceAd } from '../lib/adModel'
import { thumbUrl } from '../lib/api'
import { fmtCell } from '../lib/format'
import { METRICS_BY_KEY, SEGMENT_LABELS } from '../lib/metrics'
import { BTN_ICON, BTN_PRIMARY, BTN_SECONDARY, EYEBROW, seriesColor } from '../ui/theme'

const SLIDE_MS = 4000
const STRIP_MAX = 200

const TILE_KEYS = ['spend', 'revenue', 'roas', 'purchases', 'cost_per_purchase', 'ctr', 'cpm', 'frequency', 'cost_per_1k_reached', 'aov']
const VIDEO_KEYS = ['hook_rate', 'hold_rate', 'video_completion_rate']
const MORE_KEYS = ['impressions', 'reach', 'link_clicks', 'ctr_link', 'cpc_link', 'landing_page_views', 'add_to_cart', 'initiate_checkout', 'conversion_rate']

function Tile({ k, ad }: { k: string; ad: SpaceAd }) {
  const d = METRICS_BY_KEY[k]
  if (!d) return null
  return (
    <div className="rounded-lg border border-line bg-surface-raised px-2.5 py-2 min-w-0 ody-tile" title={d.description}>
      <div className="text-[10px] text-text-muted truncate">{d.label}</div>
      <div className="font-display text-[15px] leading-tight tabular-nums text-text-primary truncate mt-0.5">{fmtCell(ad[k], d.format)}</div>
    </div>
  )
}

function SegmentBar({ ad }: { ad: SpaceAd }) {
  const seg = ad.segment_spend
  if (!seg) return null
  const parts = (['prospecting', 'engaged', 'existing', 'unknown'] as const)
    .map((k, i) => ({ k, v: Number(seg[k]) || 0, color: seriesColor(i) }))
  const total = parts.reduce((s, p) => s + p.v, 0)
  if (total <= 0) return null
  return (
    <section>
      <div className={`${EYEBROW} mb-1.5`}>Who Meta showed it to</div>
      <div className="flex h-2 rounded-full overflow-hidden bg-surface-recessed">
        {parts.filter(p => p.v > 0).map(p => (
          <span key={p.k} style={{ width: `${(p.v / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px]">
        {parts.map(p => (
          <span key={p.k} className="flex items-center gap-1.5 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: p.color }} />
            <span className="text-text-muted truncate">{SEGMENT_LABELS[p.k]}</span>
            <span className="ml-auto tabular-nums text-text-primary">{Math.round((p.v / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </section>
  )
}

export function GroupSlideshow({ name, color, ads, demo, startAdId, keysPaused, onBack, onInspect }: {
  name: string
  color: string
  /** Already in the order to show. */
  ads: SpaceAd[]
  demo: boolean
  startAdId: string | null
  /** True while the ad drawer is open over the slideshow: keys belong to it then. */
  keysPaused: boolean
  onBack: () => void
  onInspect: (adId: string) => void
}) {
  const [idx, setIdx] = useState(() => Math.max(0, ads.findIndex(a => a.ad_id === startAdId)))
  const [playing, setPlaying] = useState(false)
  const [imgOk, setImgOk] = useState(true)
  const count = ads.length
  const i = count ? Math.min(idx, count - 1) : 0
  const ad = ads[i]
  const go = (d: number) => { if (count) setIdx(v => (Math.min(v, count - 1) + d + count) % count) }

  useEffect(() => { setImgOk(true) }, [ad?.ad_id])

  // Autoplay: one creative every few seconds, round and round.
  useEffect(() => {
    if (!playing || count < 2) return
    const t = window.setInterval(() => setIdx(v => (v + 1) % count), SLIDE_MS)
    return () => window.clearInterval(t)
  }, [playing, count])

  const keysRef = useRef({ keysPaused, onBack })
  useEffect(() => { keysRef.current = { keysPaused, onBack } })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keysRef.current.keysPaused) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight') { e.preventDefault(); setIdx(v => (v + 1) % Math.max(1, count)) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setIdx(v => (v - 1 + Math.max(1, count)) % Math.max(1, count)) }
      else if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p) }
      else if (e.key === 'Escape') keysRef.current.onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [count])

  // Warm the neighbours so stepping never waits on an image.
  useEffect(() => {
    for (const d of [1, -1, 2]) {
      const n = ads[(i + d + count) % Math.max(1, count)]
      if (n) { const im = new Image(); im.src = thumbUrl(n.ad_id, demo, n.creative_hash) }
    }
  }, [i, ads, count, demo])

  // Keep the active filmstrip thumb in view.
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [i])

  const video = !!(ad?.is_video || ad?.video_id)
  const variants = ad?.variants?.length || 1
  const strip = useMemo(() => ads.slice(0, STRIP_MAX), [ads])

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface ody-slideshow">
      <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-2.5 border-b border-line">
        <button type="button" className={BTN_SECONDARY} onClick={onBack} title="Back to the model (Esc)">
          <ChevronLeft size={14} /> Back
        </button>
        <div className="min-w-0 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
          <span className="font-display text-[15px] text-text-primary truncate">{name}</span>
        </div>
        <span className="text-[11px] text-text-muted tabular-nums">{count ? `${i + 1} of ${count}` : 'No creatives'}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" className={BTN_SECONDARY} onClick={() => setPlaying(p => !p)} disabled={count < 2}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? 'Pause' : 'Play'}
          </button>
          {ad && (
            <button type="button" className={BTN_PRIMARY} onClick={() => onInspect(ad.ad_id)} title="Open this ad's details">
              <ScanSearch size={14} /> Inspect
            </button>
          )}
        </div>
      </div>

      {ad ? (
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          {/* The creative, as big as the stage allows */}
          <div className="relative flex-1 min-h-[240px] min-w-0 flex flex-col">
            <div className="relative flex-1 min-h-0 flex items-center justify-center p-4 sm:p-6">
              {imgOk ? (
                <img key={ad.ad_id} src={thumbUrl(ad.ad_id, demo, ad.creative_hash)} alt=""
                  className="max-h-full max-w-full object-contain rounded-xl shadow-popover bg-white"
                  onError={() => setImgOk(false)} />
              ) : (
                <span className="text-[12px] text-text-muted">No preview for this creative</span>
              )}
              <div className="absolute left-3 top-3 flex gap-1.5">
                {video && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-media-scrim text-on-media">
                    <Play size={9} fill="currentColor" /> Video
                  </span>
                )}
                {variants > 1 && (
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-media-scrim text-on-media" title={`This visual runs in ${variants} ads; Inspect steps through them`}>
                    {variants}× visual
                  </span>
                )}
              </div>
              {count > 1 && (
                <>
                  <button type="button" onClick={() => go(-1)} aria-label="Previous creative" title="Previous (Left arrow)"
                    className={`${BTN_ICON} absolute left-2 top-1/2 -translate-y-1/2 !p-2 !rounded-full bg-surface-overlay/80 border border-line shadow-control`}>
                    <ChevronLeft size={18} />
                  </button>
                  <button type="button" onClick={() => go(1)} aria-label="Next creative" title="Next (Right arrow)"
                    className={`${BTN_ICON} absolute right-2 top-1/2 -translate-y-1/2 !p-2 !rounded-full bg-surface-overlay/80 border border-line shadow-control`}>
                    <ChevronRight size={18} />
                  </button>
                </>
              )}
            </div>
            {count > 1 && (
              <div ref={stripRef} className="shrink-0 flex gap-1.5 overflow-x-auto px-3 pb-3" role="tablist" aria-label="Creatives">
                {strip.map((a, k) => (
                  <button key={a.ad_id} type="button" data-i={k} onClick={() => setIdx(k)} role="tab" aria-selected={k === i}
                    className={`shrink-0 w-10 h-12 rounded-md overflow-hidden border bg-surface-recessed transition-opacity ${
                      k === i ? 'border-text-primary opacity-100' : 'border-line opacity-60 hover:opacity-100'
                    }`}
                    title={a.ad_name || a.ad_id}>
                    <img src={thumbUrl(a.ad_id, demo, a.creative_hash)} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Its metrics */}
          <div className="md:w-[340px] shrink-0 border-t md:border-t-0 md:border-l border-line overflow-y-auto overscroll-contain px-4 py-4 flex flex-col gap-4">
            <div className="min-w-0">
              <h3 className="font-display text-[15px] leading-snug text-text-primary break-words">{ad.ad_name || ad.ad_id}</h3>
              <div className="text-[11px] text-text-muted mt-1 break-words">{[ad.campaign_name, ad.adset_name].filter(Boolean).join(' / ')}</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {TILE_KEYS.map(k => <Tile key={k} k={k} ad={ad} />)}
              {video && VIDEO_KEYS.map(k => <Tile key={k} k={k} ad={ad} />)}
            </div>
            <SegmentBar ad={ad} />
            <section>
              <div className={`${EYEBROW} mb-1`}>More</div>
              {MORE_KEYS.map(k => {
                const d = METRICS_BY_KEY[k]
                return d ? (
                  <div key={k} className="flex items-baseline justify-between gap-3 py-[4px] border-b border-line last:border-b-0">
                    <span className="text-[11px] text-text-muted truncate">{d.label}</span>
                    <span className="text-[11.5px] font-medium tabular-nums text-text-primary">{fmtCell(ad[k], d.format)}</span>
                  </div>
                ) : null
              })}
            </section>
            {(ad.title || ad.body) && (
              <section>
                <div className={`${EYEBROW} mb-1`}>Copy</div>
                {ad.title && <p className="text-[12px] font-medium text-text-primary mb-1">{ad.title}</p>}
                {ad.body && <p className="text-[11.5px] text-text-secondary whitespace-pre-wrap leading-relaxed line-clamp-[10]">{ad.body}</p>}
              </section>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-[12px] text-text-muted">No creatives in this group for these dates.</div>
      )}
    </div>
  )
}
