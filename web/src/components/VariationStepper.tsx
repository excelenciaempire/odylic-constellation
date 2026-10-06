/**
 * Variations behind one card. A card is one visual; the ads running it can
 * carry different copy. Two small pagers with arrows:
 *   Copy   each distinct headline + primary text, the ads using it, their combined results
 *   Ads    "This visual runs in N ads": all of them combined, then each ad on its own
 * With one ad and one copy it is just the copy.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import type { Ad } from '../lib/api'
import type { SpaceAd } from '../lib/adModel'
import { fmtCell, fmtMoney } from '../lib/format'
import { BTN_ICON, EYEBROW, PILL } from '../ui/theme'

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function totals(ads: Ad[]) {
  let spend = 0, revenue = 0, purchases = 0, clicks = 0, impressions = 0
  // Reach can't be added across ads (the same people see several), so frequency and CPMr for more than one ad
  // are spend-weighted averages of each ad's own, flagged "avg"; for one ad they are exact.
  let freqW = 0, cpmrW = 0, wSpend = 0
  for (const a of ads) {
    const s = num(a.spend), imp = num(a.impressions), reach = num(a.reach)
    spend += s; revenue += num(a.revenue); purchases += num(a.purchases)
    clicks += num(a.clicks); impressions += imp
    if (reach > 0 && s > 0) { freqW += (imp / reach) * s; cpmrW += (s / reach) * 1000 * s; wSpend += s }
  }
  return {
    spend, purchases,
    roas: spend > 0 ? revenue / spend : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpa: purchases > 0 ? spend / purchases : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    frequency: wSpend > 0 ? freqW / wSpend : null,
    cpmr: wSpend > 0 ? cpmrW / wSpend : null,
    averaged: ads.length > 1,
  }
}

type Copy = { key: string; title: string; body: string; ads: Ad[] }

/** Distinct copies (headline + primary text), most spend first. Case and spacing don't make a new copy. */
function distinctCopies(ads: Ad[]): Copy[] {
  const by = new Map<string, Copy>()
  for (const a of ads) {
    const title = (a.title || '').trim(), body = (a.body || '').trim()
    if (!title && !body) continue
    const key = `${title}\n${body}`.toLowerCase().replace(/\s+/g, ' ')
    const c = by.get(key) || { key, title, body, ads: [] }
    c.ads.push(a)
    by.set(key, c)
  }
  return [...by.values()].sort((x, y) => totals(y.ads).spend - totals(x.ads).spend)
}

function Pager({ label, i, n, onStep }: { label: string; i: number; n: number; onStep: (d: number) => void }) {
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <button type="button" className={BTN_ICON} onClick={() => onStep(-1)} aria-label={`Previous ${label}`} title={`Previous ${label}`}>
        <ChevronLeft size={14} />
      </button>
      <span className="text-[10.5px] tabular-nums text-text-muted min-w-[44px] text-center">{i + 1} of {n}</span>
      <button type="button" className={BTN_ICON} onClick={() => onStep(1)} aria-label={`Next ${label}`} title={`Next ${label}`}>
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

function ResultLine({ t }: { t: ReturnType<typeof totals> }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
      <span><span className="text-text-primary font-medium">{fmtMoney(t.spend)}</span> <span className="text-text-muted">spend</span></span>
      <span><span className="text-text-primary font-medium">{t.roas != null ? t.roas.toFixed(2) : 'n/a'}</span> <span className="text-text-muted">ROAS</span></span>
      <span><span className="text-text-primary font-medium">{fmtCell(t.purchases, 'number')}</span> <span className="text-text-muted">purchases</span></span>
      <span><span className="text-text-primary font-medium">{fmtCell(t.cpa, 'dollar')}</span> <span className="text-text-muted">CPA</span></span>
      <span><span className="text-text-primary font-medium">{fmtCell(t.ctr, 'percent')}</span> <span className="text-text-muted">CTR</span></span>
      <span><span className="text-text-primary font-medium">{fmtCell(t.cpm, 'dollar')}</span> <span className="text-text-muted">CPM</span></span>
      <span title={t.averaged ? 'Spend-weighted average of each ad (reach does not add up across ads)' : undefined}>
        <span className="text-text-primary font-medium">{fmtCell(t.cpmr, 'dollar')}</span> <span className="text-text-muted">{t.averaged ? 'CPMr avg' : 'CPMr'}</span>
      </span>
      <span title={t.averaged ? 'Spend-weighted average of each ad (reach does not add up across ads)' : undefined}>
        <span className="text-text-primary font-medium">{fmtCell(t.frequency, 'decimal')}</span> <span className="text-text-muted">{t.averaged ? 'freq avg' : 'frequency'}</span>
      </span>
    </div>
  )
}

export function VariationStepper({ ad }: { ad: SpaceAd }) {
  const variants = ad.variants?.length ? ad.variants : [ad]
  const copies = useMemo(() => distinctCopies(variants), [variants])
  const [ci, setCi] = useState(0)
  // 0 = every ad on this visual combined, then each ad (top spender first).
  const [ai, setAi] = useState(0)
  useEffect(() => { setCi(0); setAi(0) }, [ad.ad_id])

  const copy = copies[Math.min(ci, Math.max(0, copies.length - 1))]
  const pages = variants.length > 1 ? variants.length + 1 : 0
  const page = Math.min(ai, Math.max(0, pages - 1))
  const one = page > 0 ? variants[page - 1] : null
  const step = (set: (f: (v: number) => number) => void, n: number) => (d: number) => set(v => (v + d + n) % n)

  return (
    <>
      {copy && (
        <section>
          <div className="flex items-center gap-2 mb-1 min-h-[26px]">
            <div className={EYEBROW}>{copies.length > 1 ? `Copy, ${copies.length} versions` : 'Copy'}</div>
            {copies.length > 1 && <span className="ml-auto"><Pager label="copy" i={copies.indexOf(copy)} n={copies.length} onStep={step(setCi, copies.length)} /></span>}
          </div>
          {copy.title && <p className="text-[12.5px] font-medium text-text-primary mb-1">{copy.title}</p>}
          {copy.body && <p className="text-[12px] text-text-secondary whitespace-pre-wrap leading-relaxed line-clamp-[12]">{copy.body}</p>}
          {copies.length > 1 && (
            <div className="mt-2 pt-2 border-t border-line flex flex-col gap-1">
              <div className="text-[10.5px] text-text-muted">Used by {copy.ads.length} {copy.ads.length === 1 ? 'ad' : 'ads'} on this visual</div>
              <ResultLine t={totals(copy.ads)} />
            </div>
          )}
        </section>
      )}

      {pages > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-1 min-h-[26px]">
            <div className={EYEBROW}>This visual runs in {variants.length} ads</div>
            <span className="ml-auto"><Pager label="ad" i={page} n={pages} onStep={step(setAi, pages)} /></span>
          </div>
          {one ? (
            <div className="flex flex-col gap-1.5">
              <div className="text-[12px] font-medium text-text-primary break-words">{one.ad_name || one.ad_id}</div>
              <div className="text-[10.5px] text-text-muted break-words">{[one.campaign_name, one.adset_name].filter(Boolean).join(' / ')}</div>
              {(one.title || one.body) && (
                <div className="text-[11px] text-text-secondary line-clamp-2" title={[one.title, one.body].filter(Boolean).join('\n')}>
                  {one.title ? <span className="font-medium text-text-primary">{one.title}. </span> : null}{one.body}
                </div>
              )}
              <ResultLine t={totals([one])} />
              {one.ads_manager_url && (
                <a href={one.ads_manager_url} target="_blank" rel="noreferrer" className={`${PILL} self-start mt-1`}>
                  <ExternalLink size={12} /> Open this ad in Ads Manager
                </a>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] text-text-muted">All {variants.length} combined. Step through to see each ad on its own.</div>
              <ResultLine t={totals(variants)} />
            </div>
          )}
        </section>
      )}
    </>
  )
}
