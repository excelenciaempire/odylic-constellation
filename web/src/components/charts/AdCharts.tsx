/**
 * The drawer's Charts tab. Light on purpose: the tiles and recharts load on
 * first use in their own chunk (AdChartsPanel), so the space's first paint
 * carries none of it. The dates are the ones the cards were loaded for
 * (lib/adCharts setChartRange), unless the caller passes its own.
 */
import { lazy, Suspense, useMemo } from 'react'
import type { SpaceAd } from '../../lib/adModel'
import { useChartRange } from '../../lib/adCharts'

const AdChartsPanel = lazy(() => import('./AdChartsPanel'))

/** Start loading the chart chunk early (e.g. when the drawer opens), without rendering it. */
export const preloadAdCharts = () => { void import('./AdChartsPanel') }

export function AdCharts({ ad, demo, since, until }: { ad: SpaceAd; demo: boolean; since?: string; until?: string }) {
  const loaded = useChartRange()
  const range = useMemo(() => (since && until ? { since, until } : loaded), [since, until, loaded])
  if (!range) {
    return <div className="text-[12px] text-text-muted py-8 text-center">The charts show once the ads have loaded.</div>
  }
  return (
    <Suspense fallback={<ChartsLoading />}>
      <AdChartsPanel ad={ad} demo={demo} range={range} />
    </Suspense>
  )
}

function ChartsLoading() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the charts">
      {[260, 120, 44, 44].map((h, i) => (
        <div key={i} className="rounded-xl border border-line ac-thumb-skeleton" style={{ height: h }} />
      ))}
    </div>
  )
}
