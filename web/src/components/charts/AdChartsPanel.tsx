/**
 * The drawer's Charts tab body: Atelier's ad-level charts for one card, in
 * Atelier's order. Loaded lazily (AdCharts.tsx) with recharts in its own
 * chunk. By day and Customer segment start open; Age × gender, Placements
 * and Video retention open on a click, and every tile remembers its state.
 * A closed tile asks Meta for nothing; an open one asks once per card and
 * date range (the backend keeps the answer for 6 hours).
 */
import { useMemo } from 'react'
import type { SpaceAd } from '../../lib/adModel'
import { chartAdIds, type ChartRange } from '../../lib/adCharts'
import { EYEBROW } from '../../ui/theme'
import { AgeGenderChart } from './AgeGenderChart'
import type { ChartCtx } from './ChartKit'
import { DailyChart, PlacementChart, RetentionChart } from './PerformanceCharts'
import { SegmentMixTile } from './SegmentMixTile'
import './charts.css'

export default function AdChartsPanel({ ad, demo, range }: { ad: SpaceAd; demo: boolean; range: ChartRange }) {
  const adIds = useMemo(() => chartAdIds(ad), [ad])
  const video = !!(ad.is_video || ad.video_id)
  const spend = Number(ad.spend) || 0
  const ctx = useMemo<ChartCtx>(() => ({ adIds, range, demo, video, spend }), [adIds, range, demo, video, spend])
  return (
    <div className="fv-charts flex flex-col gap-3">
      {adIds.length > 1 && (
        <div className={EYEBROW}>Same creative in {adIds.length} ads (the charts add them up)</div>
      )}
      <DailyChart ctx={ctx} />
      <SegmentMixTile ad={ad} ctx={ctx} />
      <AgeGenderChart ctx={ctx} />
      <PlacementChart ctx={ctx} />
      {video && <RetentionChart ctx={ctx} />}
    </div>
  )
}
