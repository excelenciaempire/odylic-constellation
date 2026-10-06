/**
 * Plain view: one group's creatives in a simple grid, over the space (the 3D
 * view keeps its state underneath, so Back returns exactly where it was).
 * Click a card to inspect it in the drawer.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Play, Presentation } from 'lucide-react'
import type { SpaceAd } from '../lib/adModel'
import { thumbUrl } from '../lib/api'
import { fmtCell, fmtMoney } from '../lib/format'
import { Select } from '../ui/Select'
import { BTN_SECONDARY } from '../ui/theme'
import { GROUP_SORTS, groupTotals, sortGroupAds, type GroupSort } from './groupViews'

function GridCard({ ad, demo, selected, onOpen }: { ad: SpaceAd; demo: boolean; selected: boolean; onOpen: () => void }) {
  const [ok, setOk] = useState(true)
  const count = ad.variants?.length || 1
  const video = !!(ad.is_video || ad.video_id)
  return (
    <button type="button" onClick={onOpen}
      className={`group text-left rounded-xl border bg-surface-raised overflow-hidden transition-shadow hover:shadow-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rust-500 ody-card ${
        selected ? 'border-text-primary' : 'border-line'
      }`}
      title={ad.ad_name || ad.ad_id}>
      <div className="relative bg-surface-recessed flex items-center justify-center" style={{ aspectRatio: '4 / 5' }}>
        {ok ? (
          <img src={thumbUrl(ad.ad_id, demo, ad.creative_hash)} alt="" loading="lazy" decoding="async"
            className="w-full h-full object-contain" onError={() => setOk(false)} />
        ) : (
          <span className="text-[10.5px] text-text-muted">No preview</span>
        )}
        {video && (
          <span className="absolute left-1.5 top-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-media-scrim text-on-media">
            <Play size={8} fill="currentColor" /> Video
          </span>
        )}
        {count > 1 && (
          <span className="absolute right-1.5 bottom-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-media-scrim text-on-media tabular-nums"
            title={`This visual runs in ${count} ads`}>
            {count}×
          </span>
        )}
      </div>
      <div className="px-2.5 pt-2 pb-2.5">
        <div className="text-[11.5px] font-medium text-text-primary leading-snug line-clamp-2 break-words min-h-[2.5em]">{ad.ad_name || ad.ad_id}</div>
        <div className="mt-1.5 flex items-baseline gap-2 text-[10.5px] tabular-nums whitespace-nowrap overflow-hidden">
          <span className="text-text-primary font-medium">{fmtMoney(Number(ad.spend) || 0)}</span>
          <span className="text-text-muted">{ad.roas != null ? `${Number(ad.roas).toFixed(2)} ROAS` : 'no sales'}</span>
          <span className="text-text-muted hidden min-[400px]:inline">{fmtCell(ad.ctr, 'percent')} CTR</span>
        </div>
      </div>
    </button>
  )
}

export function GroupGrid({ name, color, groupLabel, ads, demo, selectedId, onBack, onOpen, onSlideshow }: {
  name: string
  color: string
  /** What the groups are, e.g. "Funnel position". */
  groupLabel: string
  ads: SpaceAd[]
  demo: boolean
  selectedId: string | null
  onBack: () => void
  onOpen: (adId: string) => void
  onSlideshow: (startAdId: string | null) => void
}) {
  const [sort, setSort] = useState<GroupSort>('spend')
  const sorted = useMemo(() => sortGroupAds(ads, sort), [ads, sort])
  const t = useMemo(() => groupTotals(ads), [ads])

  // Esc goes back to the model, as Back says. Not while the drawer is open over the grid or the sort menu is
  // open: those take Esc first.
  const rootRef = useRef<HTMLDivElement>(null)
  const backRef = useRef(onBack)
  useEffect(() => { backRef.current = onBack })
  useEffect(() => {
    if (selectedId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (rootRef.current?.querySelector('[role="listbox"]')) return
      backRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId])

  return (
    <div ref={rootRef} className="absolute inset-0 z-20 flex flex-col bg-surface ody-plainview">
      <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-2.5 border-b border-line">
        <button type="button" className={BTN_SECONDARY} onClick={onBack} title="Back to the model (Esc)">
          <ChevronLeft size={14} /> Back
        </button>
        <div className="min-w-0 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
          <div className="min-w-0">
            <div className="text-[10.5px] text-text-muted leading-none">{groupLabel}</div>
            <div className="font-display text-[15px] text-text-primary truncate leading-tight mt-0.5">{name}</div>
          </div>
        </div>
        <div className="flex items-baseline gap-3 text-[11px] tabular-nums text-text-muted whitespace-nowrap">
          <span><span className="text-text-primary font-medium">{t.n}</span> creatives</span>
          <span><span className="text-text-primary font-medium">{fmtMoney(t.spend)}</span> spend</span>
          <span className="hidden min-[480px]:inline"><span className="text-text-primary font-medium">{t.roas != null ? t.roas.toFixed(2) : 'n/a'}</span> ROAS</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select value={sort} options={GROUP_SORTS} onChange={v => setSort(v as GroupSort)} ariaLabel="Sort" title="Sort" compact />
          <button type="button" className={BTN_SECONDARY} onClick={() => onSlideshow(sorted[0]?.ad_id ?? null)} title="Step through these one at a time">
            <Presentation size={14} /> Slideshow
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4">
        {sorted.length ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {sorted.map(ad => (
              <GridCard key={ad.ad_id} ad={ad} demo={demo} selected={ad.ad_id === selectedId} onOpen={() => onOpen(ad.ad_id)} />
            ))}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-[12px] text-text-muted">No creatives in this group for these dates.</div>
        )}
      </div>
    </div>
  )
}
