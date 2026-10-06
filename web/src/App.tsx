/**
 * App shell: a small state machine (no router). `#/connect` shows the
 * connect flow; everything else is the space. Until an account is connected
 * the space shows the demo brand, so a first visit sees value at once.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, isThrottle, type Account, type AdsResponse, type Governor, type Status } from './lib/api'
import { enrichAds, stackAds } from './lib/adModel'
import { setCurrency } from './lib/format'
import { setChartRange } from './lib/adCharts'
import { DEFAULT_PRESET, isPreset, matchPreset, presetRange, type Preset } from './lib/dateRanges'
import { classifyFunnelPositions } from './space/funnelPosition'
import { Header } from './components/Header'
import { AdDrawer } from './components/AdDrawer'
import { Onboarding } from './components/Onboarding'
import { BTN_PRIMARY, BTN_SECONDARY } from './ui/theme'
import { Ground } from './ui/odylic/Ground'

const CreativeSpace3D = lazy(() => import('./space/CreativeSpace3D').then(m => ({ default: m.CreativeSpace3D })))

type Range = { since: string; until: string; preset: Preset | null }
const LS_RANGE = 'fv.range'
const LS_STACK = 'fv.stack'

function loadRange(): Range {
  try {
    const p = JSON.parse(localStorage.getItem(LS_RANGE) || 'null')
    // A saved preset rolls forward with the calendar; a custom range stays put.
    if (p && isPreset(p.preset)) { const r = presetRange(p.preset); return { since: r.start, until: r.end, preset: p.preset } }
    if (p && /^\d{4}-\d{2}-\d{2}$/.test(p.since) && /^\d{4}-\d{2}-\d{2}$/.test(p.until)) return { since: p.since, until: p.until, preset: null }
  } catch { /* storage off */ }
  const r = presetRange(DEFAULT_PRESET)
  return { since: r.start, until: r.end, preset: DEFAULT_PRESET }
}

const route = () => (window.location.hash.startsWith('#/connect') ? 'connect' : 'space')

type LoadError = { message: string; code: string; pausedUntil: string | null }

export function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [view, setView] = useState<'space' | 'connect'>(route)
  const [connectStart, setConnectStart] = useState<'welcome' | 'account'>('welcome')
  const [range, setRange] = useState<Range>(loadRange)
  const [data, setData] = useState<AdsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadStarted, setLoadStarted] = useState(0)
  const [error, setError] = useState<LoadError | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [stack] = useState<boolean>(() => { try { return localStorage.getItem(LS_STACK) !== '0' } catch { return true } })
  const reqId = useRef(0)
  const inflight = useRef<AbortController | null>(null)
  // The load key the cards on screen belong to, and how many times in a row the
  // page has retried by itself after a pause (bounded, so a tab left open
  // never loops unattended).
  const loadedKey = useRef('')
  const autoRetries = useRef(0)

  useEffect(() => {
    const onHash = () => setView(route())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const refreshStatus = useCallback(() => api.status()
    .then(s => { setStatus(s); setStatusError(null); return s })
    .catch(e => { setStatusError(e instanceof Error ? e.message : String(e)); return null }), [])
  useEffect(() => { refreshStatus() }, [refreshStatus])

  const demo = status ? !status.connected : true
  const accountId = status?.account?.id ?? null

  const loadKey = status ? `${status.connected ? accountId : 'demo'}|${range.since}|${range.until}` : ''

  const load = useCallback((refresh = false) => {
    if (!status) return
    const id = ++reqId.current
    const key = loadKey
    // A newer load replaces the old request (the server drops a queued pull
    // for a range the page has moved past).
    inflight.current?.abort()
    const ctl = new AbortController()
    inflight.current = ctl
    setLoading(true); setLoadStarted(Date.now()); setError(null)
    api.ads({ since: range.since, until: range.until, demo: !status.connected, refresh }, ctl.signal)
      .then(r => {
        if (id !== reqId.current) return
        setCurrency(r.currency || r.account?.currency)
        setChartRange(r.since, r.until)
        loadedKey.current = key
        autoRetries.current = 0
        setData(r)
      })
      .catch(async e => {
        if (id !== reqId.current || ctl.signal.aborted) return
        let pausedUntil = e instanceof ApiError && typeof e.data.paused_until === 'string' ? e.data.paused_until : null
        if (isThrottle(e) && !pausedUntil) pausedUntil = await api.governor().then(g => g.paused_until).catch(() => null)
        setError({ message: e instanceof Error ? e.message : String(e), code: e instanceof ApiError ? e.code : 'error', pausedUntil })
      })
      .finally(() => { if (id === reqId.current) setLoading(false) })
  }, [status, range.since, range.until, loadKey])

  // Load when the account, demo state or range changes (not on every status
  // poll), and not when the connect screen closes over cards already loaded
  // for the same key.
  const hasData = !!data
  useEffect(() => {
    if (!loadKey || view !== 'space') return
    if (hasData && loadedKey.current === loadKey) return
    autoRetries.current = 0
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, view])

  const MAX_AUTO_RETRIES = 6
  const autoRetry = useCallback(() => {
    if (autoRetries.current >= MAX_AUTO_RETRIES) return
    autoRetries.current += 1
    load(false)
  }, [load])

  // A different account or the demo: drop the old cards and the open drawer.
  const scope = status?.connected ? `acct:${accountId}` : 'demo'
  const lastScope = useRef(scope)
  useEffect(() => {
    if (lastScope.current !== scope) { lastScope.current = scope; setData(null); setSelected(null) }
  }, [scope])

  const sourceAds = useMemo(() => data?.ads ?? [], [data])
  const cards = useMemo(() => (stack ? stackAds(sourceAds) : enrichAds(sourceAds)), [sourceAds, stack])
  const cardById = useMemo(() => new Map(cards.map(c => [c.ad_id, c])), [cards])
  // Once per load: the drawer and the space's funnel view both read it.
  const funnel = useMemo(() => classifyFunnelPositions(sourceAds), [sourceAds])
  const selectedAd = selected ? cardById.get(selected) : undefined

  const setRangeAndSave = (since: string, until: string, preset: Preset | null) => {
    const p = preset ?? matchPreset({ start: since, end: until })
    setRange({ since, until, preset: p })
    try { localStorage.setItem(LS_RANGE, JSON.stringify({ since, until, preset: p })) } catch { /* storage off */ }
  }

  const openConnect = (start: 'welcome' | 'account') => {
    setConnectStart(start)
    setSelected(null)
    window.location.hash = '#/connect'
  }
  const backToSpace = () => { window.location.hash = '#/' }

  // Header height for the drawer's top (the header wraps on a phone).
  const headerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const set = () => document.documentElement.style.setProperty('--fv-header-h', `${el.getBoundingClientRect().bottom}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [view])

  if (view === 'connect') {
    return (
      <Ground key="connect" className="min-h-dvh flex flex-col">
        <Onboarding status={status} startAt={connectStart} onCancel={backToSpace}
          onDone={async () => {
            await refreshStatus()
            const r = presetRange('Last 14 days')
            setRangeAndSave(r.start, r.end, 'Last 14 days')
            setData(null)
            backToSpace()
          }} />
      </Ground>
    )
  }

  const account: Account | null = status?.account ?? (demo ? data?.account ?? null : null)

  return (
    <Ground key="space" className="h-dvh flex flex-col">
      <div ref={headerRef}>
        <Header demo={demo} account={account} since={range.since} until={range.until} preset={range.preset}
          loading={loading}
          onRange={setRangeAndSave}
          onRefresh={() => load(!demo)}
          onConnect={() => openConnect('welcome')}
          onChangeAccount={() => openConnect('account')}
          onDisconnect={async () => {
            try { await api.disconnect() } catch { /* the status refresh shows what's left */ }
            setData(null); setSelected(null)
            await refreshStatus()
          }} />
      </div>
      <main className="flex-1 min-h-0 px-3 sm:px-5 pb-3 sm:pb-5 flex flex-col">
        {statusError && !status ? (
          <Notice tone="error" title="The local server is not answering">
            <p>{statusError}</p>
            <p>Start it with <code className="fv-code">./start.sh</code> (or reopen the app), then reload this page.</p>
            <button type="button" className={`${BTN_SECONDARY} mt-3`} onClick={() => refreshStatus()}>Try again</button>
          </Notice>
        ) : error && !loading ? (
          <LoadErrorView error={error} demo={demo} onRetry={() => { autoRetries.current = 0; load(false) }}
            onAutoRetry={autoRetries.current < MAX_AUTO_RETRIES ? autoRetry : null}
            onReconnect={() => openConnect('welcome')} />
        ) : !data ? (
          <Loading started={loadStarted} demo={demo} active={loading || !status} />
        ) : !cards.length ? (
          <Notice title="No ads ran in this date range">
            <p>Nothing in this account spent between these dates. Try a longer range.</p>
            <button type="button" className={`${BTN_PRIMARY} mt-3`} onClick={() => { const r = presetRange('Last 90 days'); setRangeAndSave(r.start, r.end, 'Last 90 days') }}>
              Show the last 90 days
            </button>
          </Notice>
        ) : (
          <>
          {demo && <DemoBanner onConnect={() => openConnect('welcome')} />}
          <div className="relative flex-1 min-h-0">
            {loading && (
              <div className="absolute inset-x-0 top-0 z-20 px-3 pt-1.5 pointer-events-none">
                <div className="fv-progress"><span /></div>
              </div>
            )}
            <Suspense fallback={<Loading started={Date.now()} demo={demo} active />}>
              <CreativeSpace3D ads={cards} funnel={funnel} scope={scope} demo={!!data.demo} fetchedAt={data.fetched_at}
                selectedId={selected} onOpen={id => setSelected(id)} />
            </Suspense>
          </div>
          </>
        )}
      </main>
      {selectedAd && (
        <AdDrawer ad={selectedAd} demo={!!data?.demo} placement={funnel.get(selectedAd.ad_id)} onClose={() => setSelected(null)} />
      )}
    </Ground>
  )
}

/** A slim bar above the space while the demo brand shows (never over the canvas). */
function DemoBanner({ onConnect }: { onConnect: () => void }) {
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem('fv.demo.banner') === 'off' } catch { return false } })
  if (hidden) return null
  return (
    // On a phone the header's Demo Brand pill and Connect button say the same, so the bar stays out of the way.
    <div className="ody-glass fv-banner mb-3 hidden sm:flex items-center gap-x-3 gap-y-1.5 flex-wrap px-3.5 py-2" data-gf-rim="s">
      <span className="text-[13px] text-text-secondary leading-snug flex-1 min-w-[200px]">
        You're looking at a <span className="text-text-primary">demo brand</span> with made-up numbers. Connect your Meta ads to see your own funnel.
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <button type="button" className={BTN_PRIMARY} onClick={onConnect}>Connect</button>
        <button type="button" className={BTN_SECONDARY} aria-label="Hide this note"
          onClick={() => { setHidden(true); try { sessionStorage.setItem('fv.demo.banner', 'off') } catch { /* storage off */ } }}>Hide</button>
      </span>
    </div>
  )
}

/**
 * An empty, paused or error state on glass (Atelier's states): the title in
 * the serif, the line under it, at most one or two pill actions. An error
 * carries a small red dot, no icon.
 */
function Notice({ tone, title, children }: { tone?: 'error'; title: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="atelier-section fv-notice max-w-[480px] w-full !p-6 text-[13px] text-text-secondary leading-relaxed fv-prose" role={tone === 'error' ? 'alert' : undefined}>
        <h2 className="font-display text-[20px] leading-tight text-text-primary mb-2 flex items-center gap-2.5">
          {tone === 'error' && <span className="fv-dot-error" aria-hidden="true" />}
          {title}
        </h2>
        {children}
      </div>
    </div>
  )
}

function Loading({ started, demo, active }: { started: number; demo: boolean; active: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  const secs = Math.max(0, Math.round((now - started) / 1000))
  const msg = demo ? 'Loading the demo brand...'
    : secs < 8 ? 'Pulling your ads from Meta...'
      : secs < 30 ? 'Still pulling. A first pull of a big account takes a while: the rate governor spaces out every call to keep your access safe.'
        : 'Almost there. Large accounts can take up to a minute the first time. Later loads come from the local cache.'
  return (
    <div className="flex-1 flex items-center justify-center p-4" aria-live="polite">
      <div className="w-full max-w-[380px] text-center">
        <div className="fv-progress mb-4"><span /></div>
        <p className="text-[13px] text-text-secondary leading-relaxed">{msg}</p>
        {!demo && secs >= 3 && <p className="text-[12px] text-text-muted mt-2 tabular-nums">{secs}s</p>}
      </div>
    </div>
  )
}

function LoadErrorView({ error, demo, onRetry, onAutoRetry, onReconnect }: {
  error: LoadError
  demo: boolean
  onRetry: () => void
  /** Retry by itself once the pause is over; null when the page already did that too often in a row. */
  onAutoRetry: (() => void) | null
  onReconnect: () => void
}) {
  const [gov, setGov] = useState<Governor | null>(null)
  const throttled = error.code === 'throttled' || !!error.pausedUntil
  useEffect(() => { if (throttled) api.governor().then(setGov).catch(() => {}) }, [throttled])
  const until = error.pausedUntil || gov?.paused_until || null
  const untilText = until ? new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null

  // Retry by itself once the pause is over (the server answers with the time
  // the whole rest of the load fits the hourly budget, and keeps what an
  // interrupted load already fetched).
  useEffect(() => {
    if (!until || !onAutoRetry) return
    const ms = new Date(until).getTime() - Date.now()
    if (!(ms > 0) || ms > 6 * 3600e3) return
    const t = setTimeout(onAutoRetry, ms + 1500)
    return () => clearTimeout(t)
  }, [until, onAutoRetry])

  if (throttled) {
    return (
      <Notice title="Meta calls are paused for a bit">
        <p>
          The rate governor paused calls to protect your Meta access{untilText ? <>. They resume at <strong className="text-text-primary">{untilText}</strong></> : null}
          {onAutoRetry ? ', and this page reloads by itself then.' : '.'}
        </p>
        {(gov?.reason || error.message) && <p className="text-[12px] text-text-muted">{gov?.reason || error.message}</p>}
        {gov && <p className="text-[12px] text-text-muted tabular-nums">Meta calls this hour: {gov.calls_last_hour} of {gov.cap}</p>}
        {!onAutoRetry && <button type="button" className={`${BTN_SECONDARY} mt-3`} onClick={onRetry}>Try again</button>}
      </Notice>
    )
  }
  const auth = error.code === 'invalid_token' || error.code === 'permission_denied' || error.code === 'not_connected'
  return (
    <Notice tone="error" title={demo ? 'The demo could not load' : 'Could not load your ads'}>
      <p>{error.message}</p>
      <div className="flex gap-2 mt-3">
        <button type="button" className={BTN_SECONDARY} onClick={onRetry}>Try again</button>
        {auth && <button type="button" className={BTN_PRIMARY} onClick={onReconnect}>Connect again</button>}
      </div>
    </Notice>
  )
}
