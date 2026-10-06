/**
 * Ad detail drawer: the creative, its names and status, a metrics grid and
 * the ads that run the same creative. Slides in from the right; full width on
 * a phone.
 */
import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Play, X } from 'lucide-react'
import { thumbUrl } from '../lib/api'
import type { SpaceAd } from '../lib/adModel'
import { ALL_METRICS, type MetricDef } from '../lib/metrics'
import { fmtCell } from '../lib/format'
import { deliveryStatus } from '../space/deliveryStatus'
import { FUNNEL_LANE_LABEL, type FunnelPlacement } from '../space/funnelPosition'
import { Segmented } from '../ui/Segmented'
import { VariationStepper } from './VariationStepper'
import { AdCharts } from './charts/AdCharts'
import { BTN_ICON, EYEBROW, PILL, ROW_LABEL, ROW_VALUE } from '../ui/theme'

type Tab = 'overview' | 'charts'

const STATUS_DOT: Record<string, string> = {
  Live: 'bg-success-solid',
  Paused: 'bg-neutral-500',
  'In review': 'bg-warning-solid',
  Issues: 'bg-error-solid',
  Archived: 'bg-neutral-400',
}

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function SpecRow({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[5px] border-b border-line last:border-b-0 min-w-0" title={title}>
      <span className={ROW_LABEL}>{label}</span>
      <span className={`${ROW_VALUE} text-right truncate max-w-[62%]`}>{value}</span>
    </div>
  )
}

function MetricsGrid({ ad }: { ad: SpaceAd }) {
  const video = !!(ad.is_video || ad.video_id)
  const groups = useMemo(() => {
    const out = new Map<string, MetricDef[]>()
    for (const m of ALL_METRICS) {
      if (m.group === 'Video' && !video) continue
      if (m.group === 'Customer segment' && !ad.segment_spend) continue
      const list = out.get(m.group) || []
      list.push(m)
      out.set(m.group, list)
    }
    return [...out.entries()]
  }, [video, ad.segment_spend])
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([group, defs]) => (
        <section key={group}>
          <div className={`${EYEBROW} mb-1`}>{group}</div>
          <div className="grid grid-cols-1 min-[440px]:grid-cols-2 gap-x-5">
            {defs.map(d => (
              <SpecRow key={d.key} label={d.label} value={fmtCell(ad[d.key], d.format)} title={d.description} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function AdDrawer({ ad, demo, placement, onClose }: {
  ad: SpaceAd
  demo: boolean
  placement: FunnelPlacement | undefined
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const [imgOk, setImgOk] = useState(true)
  useEffect(() => { setImgOk(true) }, [ad.ad_id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const status = deliveryStatus(ad.effective_status) || ad.effective_status || 'Unknown'
  const video = !!(ad.is_video || ad.video_id)

  return (
    <aside className="fv-drawer fixed z-50 right-0 bottom-0 w-full sm:w-[440px] bg-surface-raised border-l border-line shadow-modal flex flex-col"
      style={{ top: 'var(--fv-header-h, 56px)' }} aria-label="Ad details">
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] || 'bg-neutral-400'}`} />
            {status}
            {placement && <span>· {FUNNEL_LANE_LABEL[placement.lane]}{placement.estimated ? ' (estimated)' : ''}</span>}
          </div>
          <h2 className="font-display text-[18px] leading-snug text-text-primary mt-1 break-words line-clamp-3">{ad.ad_name || ad.ad_id}</h2>
        </div>
        <button type="button" className={BTN_ICON} onClick={onClose} aria-label="Close" title="Close (Esc)"><X size={16} /></button>
      </div>
      <div className="px-4">
        <Segmented<Tab> variant="underline" ariaLabel="Ad detail" value={tab} onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'charts', label: 'Charts' },
          ]} />
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {tab === 'overview' ? (
          <div className="flex flex-col gap-5">
            <div className="relative rounded-xl bg-surface-recessed border border-line flex items-center justify-center overflow-hidden" style={{ minHeight: 180 }}>
              {imgOk ? (
                <img src={thumbUrl(ad.ad_id, demo, ad.creative_hash)} alt="" className="max-h-[360px] w-auto max-w-full object-contain" onError={() => setImgOk(false)} />
              ) : (
                <span className="text-[11px] text-text-muted py-16">No preview for this creative</span>
              )}
              {video && (
                <span className="absolute left-2 top-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-media-scrim text-on-media">
                  <Play size={9} fill="currentColor" /> Video
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {ad.ads_manager_url && (
                <a href={ad.ads_manager_url} target="_blank" rel="noreferrer" className={PILL}>
                  <ExternalLink size={12} /> Open in Ads Manager
                </a>
              )}
              {ad.instagram_permalink_url && (
                <a href={ad.instagram_permalink_url} target="_blank" rel="noreferrer" className={PILL}>
                  <ExternalLink size={12} /> View on Instagram
                </a>
              )}
            </div>

            <section>
              <div className={`${EYEBROW} mb-1`}>Ad</div>
              <SpecRow label="Campaign" value={ad.campaign_name || 'n/a'} title={ad.campaign_name} />
              <SpecRow label="Ad set" value={ad.adset_name || 'n/a'} title={ad.adset_name} />
              <SpecRow label="Ad ID" value={ad.ad_id} />
              <SpecRow label="Type" value={video ? 'Video' : 'Image'} />
              {ad.created_time && <SpecRow label="Created" value={fmtDate(ad.created_time)} />}
              {placement && (
                <SpecRow label="Funnel position"
                  value={`${FUNNEL_LANE_LABEL[placement.lane]}${placement.estimated ? ' (estimated)' : ''}`}
                  title={placement.estimated ? 'No segment delivery from Meta: placed by frequency and CPMr' : 'From Meta customer-segment delivery'} />
              )}
              {ad.call_to_action_type && <SpecRow label="Call to action" value={ad.call_to_action_type.replace(/_/g, ' ').toLowerCase()} />}
            </section>

            {/* Copy versions and the ads running this visual, with arrows to step through them. */}
            <VariationStepper ad={ad} />

            <MetricsGrid ad={ad} />
          </div>
        ) : <AdCharts ad={ad} demo={demo} />}
      </div>
    </aside>
  )
}
