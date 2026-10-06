/**
 * Data for the drawer's Charts tab (no chart code here, so the main bundle
 * stays light: the charts themselves load on first use).
 *
 *   range      the dates the space shows, set by App on every load (the way
 *              setCurrency works), so a chart always covers the cards' dates
 *   ad ids     a stacked card charts every ad that runs its creative; the
 *              backend sums them per day or per row in one Meta call
 *   fetching   one request per chart, memoized for the session, after a
 *              one second dwell, so clicking through cards never spends Meta
 *              calls on ads nobody stopped to read (the backend also keeps
 *              each answer on disk for 6 hours). Requests that can reach Meta
 *              run one at a time, the newest first, and one that has not
 *              started yet is dropped when its chart closes or the card
 *              changes, so the card the viewer lands on never waits behind
 *              cards already left behind.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError } from './api'
import type { Ad } from './api'

/* ── The date range the space shows ───────────────────────────────────── */

export type ChartRange = { since: string; until: string }

let currentRange: ChartRange | null = null
const rangeListeners = new Set<() => void>()

export function setChartRange(since: string, until: string): void {
  if (currentRange && currentRange.since === since && currentRange.until === until) return
  currentRange = { since, until }
  rangeListeners.forEach(fn => fn())
}

const subscribeRange = (fn: () => void) => {
  rangeListeners.add(fn)
  return () => { rangeListeners.delete(fn) }
}

/** The range the cards were loaded for (null until the first load). */
export function useChartRange(): ChartRange | null {
  return useSyncExternalStore(subscribeRange, () => currentRange, () => currentRange)
}

/* ── Payloads (api/main.py "Ad charts") ───────────────────────────────── */

/** A day or a breakdown row: summed counts plus ratios (null over zero). */
export type ChartRow = Record<string, number | string | null | undefined>

type ChartMeta = {
  ad_id: string
  ad_ids: string[]
  since: string
  until: string
  demo: boolean
  cached: boolean
  fetched_at: string
  note: string | null
}

export type BreakdownKind = 'age' | 'gender' | 'age_gender' | 'placement' | 'platform' | 'device' | 'segment'

export type DailyPayload = ChartMeta & { days: Array<ChartRow & { date: string }> }
export type BreakdownPayload = ChartMeta & { kind: BreakdownKind; rows: Array<ChartRow & { key: string; label: string }> }
export type CurvePoint = { index: number; second: number; label: string; pct: number }
export type CurvePayload = ChartMeta & { points: CurvePoint[] }

/* ── Which ads a chart covers ─────────────────────────────────────────── */

/** The card's ad first, then the other ads that run its creative. */
export function chartAdIds(ad: Pick<Ad, 'ad_id'> & { variants?: Pick<Ad, 'ad_id'>[] }): string[] {
  const out = [ad.ad_id]
  for (const v of ad.variants || []) if (v.ad_id && !out.includes(v.ad_id)) out.push(v.ad_id)
  return out
}

export type ChartSource = 'daily' | 'video-curve' | BreakdownKind

/** The request for one chart. The other ads go sorted, so the URL (and the session memo) is stable. */
export function chartUrl(source: ChartSource, adIds: string[], range: ChartRange, demo: boolean): string {
  const q = new URLSearchParams({ since: range.since, until: range.until })
  if (source !== 'daily' && source !== 'video-curve') q.set('kind', source)
  if (adIds.length > 1) q.set('ids', [...adIds.slice(1)].sort().join(','))
  if (demo) q.set('demo', '1')
  const path = source === 'daily' ? 'daily' : source === 'video-curve' ? 'video-curve' : 'breakdown'
  return `/api/ads/${encodeURIComponent(adIds[0])}/${path}?${q}`
}

/* ── Fetching ─────────────────────────────────────────────────────────── */

const MEMO_MS = 10 * 60_000
const MEMO_MAX = 300
const memo = new Map<string, { at: number; promise: Promise<unknown> }>()

async function getJSON<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch {
    throw new ApiError('Could not reach the local app server. Is it still running?', 0, 'network')
  }
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  if (!res.ok) {
    const b = (body && typeof body === 'object' ? body : {}) as { error?: string; code?: string }
    throw new ApiError(b.error || `Request failed (${res.status})`, res.status, b.code || `http_${res.status}`, b as Record<string, unknown>)
  }
  return body as T
}

const memoHit = (url: string) => {
  const hit = memo.get(url)
  return hit && Date.now() - hit.at < MEMO_MS ? hit : null
}

/* One Meta-backed chart request at a time, newest first. The demo answers
   from the local server at once, so it skips the line. */
type Job = { url: string; users: number; start: () => void }
const waiting: Job[] = []
const waitingByUrl = new Map<string, Job>()
let running = 0
const MAX_RUNNING = 1

const reachesMeta = (url: string) => !/[?&]demo=1(&|$)/.test(url)

function pumpCharts() {
  while (running < MAX_RUNNING && waiting.length) {
    const job = waiting.pop()!
    waitingByUrl.delete(job.url)
    running++
    job.start()
  }
}

function releaseChart(url: string) {
  const job = waitingByUrl.get(url)
  if (!job) return  // started (or done): let it finish, the server keeps the answer
  if (--job.users > 0) return
  waitingByUrl.delete(url)
  const i = waiting.indexOf(job)
  if (i >= 0) waiting.splice(i, 1)
  memo.delete(url)
}

function remember(url: string, promise: Promise<unknown>) {
  memo.set(url, { at: Date.now(), promise })
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value
    if (oldest) memo.delete(oldest)
  }
}

/**
 * One request per URL per session (a failure is never kept). `release` says
 * the caller no longer needs it: a request still waiting in line is dropped.
 */
export function requestChart<T>(url: string): { promise: Promise<T>; release: () => void } {
  const release = () => releaseChart(url)
  const hit = memoHit(url)
  if (hit) {
    const job = waitingByUrl.get(url)
    if (job) job.users++
    return { promise: hit.promise as Promise<T>, release }
  }
  if (!reachesMeta(url)) {
    const promise = getJSON<T>(url).catch(e => { memo.delete(url); throw e })
    remember(url, promise)
    return { promise, release: () => {} }
  }
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  const job: Job = {
    url, users: 1,
    start: () => {
      getJSON<T>(url).then(resolve, e => { memo.delete(url); reject(e) })
        .finally(() => { running--; pumpCharts() })
    },
  }
  waiting.push(job)
  waitingByUrl.set(url, job)
  remember(url, promise)
  pumpCharts()
  return { promise, release }
}

export function fetchChart<T>(url: string): Promise<T> {
  return requestChart<T>(url).promise
}

export type ChartData<T> = {
  data: T | null
  error: Error | null
  loading: boolean
  retry: () => void
}

/**
 * Load one chart's data. `url` null means not asked for (a closed chart):
 * nothing is requested. A request that is not memoized waits `dwellMs`
 * first and is dropped if the chart closes or the ad changes meanwhile.
 */
export function useChartData<T>(url: string | null, dwellMs = 0): ChartData<T> {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: Error | null }>({ url: null, data: null, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!url) return
    let live = true
    let release: (() => void) | null = null
    const run = () => {
      const req = requestChart<T>(url)
      release = req.release
      req.promise.then(
        data => { if (live) setState({ url, data, error: null }) },
        error => { if (live) setState({ url, data: null, error: error instanceof Error ? error : new Error(String(error)) }) },
      )
    }
    const wait = dwellMs > 0 && !memoHit(url)
    const timer = wait ? window.setTimeout(run, dwellMs) : 0
    if (!wait) run()
    return () => { live = false; if (timer) window.clearTimeout(timer); release?.() }
  }, [url, dwellMs, attempt])
  const done = !!url && state.url === url
  return {
    data: done ? state.data : null,
    error: done ? state.error : null,
    loading: !!url && !done,
    retry: () => {
      if (url) memo.delete(url)
      setState({ url: null, data: null, error: null })
      setAttempt(n => n + 1)
    },
  }
}

/** How long to wait before a Meta-backed chart asks (none for the demo brand). */
export const chartDwell = (demo: boolean) => (demo ? 0 : 1000)
