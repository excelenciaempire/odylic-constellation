/**
 * App header, on the ground (no band, no rule): the Odylic wordmark with the
 * product name, the account (or the demo brand with a Connect button), the
 * date range, refresh and the settings menu. Its controls are glass.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, ChevronDown, LogOut, Monitor, Moon, RefreshCw, Repeat, Settings, Sun } from 'lucide-react'
import { api, type Account, type Governor } from '../lib/api'
import { rangeLabel, type Preset } from '../lib/dateRanges'
import { getScheme, setScheme, type Scheme } from '../lib/colorScheme'
import { BTN_ICON, BTN_PRIMARY, BTN_SECONDARY, PILL } from '../ui/theme'
import { Popover } from '../ui/Popover'
import { Segmented } from '../ui/Segmented'
import { DatePicker } from './DatePicker'

type Props = {
  demo: boolean
  account: Account | null
  since: string
  until: string
  preset: Preset | null
  loading: boolean
  onRange: (since: string, until: string, preset: Preset | null) => void
  onRefresh: () => void
  onConnect: () => void
  onChangeAccount: () => void
  onDisconnect: () => void
}

/**
 * The lockup: Peter's Odylic wordmark (traced from his file into
 * public/brand/odylic-wordmark.svg, drawn as a mask so it takes the ink of
 * either theme) and "Constellation" on the wordmark's baseline. The logo's
 * box is the ink box of the trace; index.css drops it by its descender depth,
 * so the bottom of O, d, l, i and c sits exactly on the text's baseline.
 */
export function Wordmark() {
  return (
    <span className="fv-wordmark" role="img" aria-label="Odylic Constellation">
      <span className="fv-logo" aria-hidden="true" />
      <span className="fv-wordmark-name" aria-hidden="true">Constellation</span>
    </span>
  )
}

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function GovernorLine({ g }: { g: Governor | null }) {
  if (!g) return <span className="text-text-muted">Checking...</span>
  const paused = g.paused_until && new Date(g.paused_until).getTime() > Date.now()
  return (
    <span className="flex flex-col gap-0.5">
      <span className="tabular-nums text-text-primary">Meta calls this hour: {g.calls_last_hour} of {g.cap}</span>
      {paused && (
        <span className="text-warning">Paused until {fmtTime(g.paused_until!)}{g.reason ? `. ${g.reason}` : ''}</span>
      )}
    </span>
  )
}

/** Header icon buttons: Atelier's 32px glass squares. */
const HEADER_ICON = `${BTN_ICON} h-8 w-8 !p-0 flex items-center justify-center`

function SettingsMenu({ demo, onChangeAccount, onDisconnect, onConnect }: {
  demo: boolean
  onChangeAccount: () => void
  onDisconnect: () => void
  onConnect: () => void
}) {
  const [open, setOpen] = useState(false)
  const [gov, setGov] = useState<Governor | null>(null)
  const [scheme, setSchemeState] = useState<Scheme>(getScheme)
  const [confirm, setConfirm] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) { setConfirm(false); return }
    let live = true
    const load = () => api.governor().then(g => { if (live) setGov(g) }).catch(() => { /* shown as checking */ })
    load()
    const t = setInterval(load, 15000)
    return () => { live = false; clearInterval(t) }
  }, [open])

  const row = 'w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 hover:bg-hover transition-colors text-text-secondary hover:text-text-primary'
  return (
    <>
      <button ref={ref} type="button" className={HEADER_ICON} onClick={() => setOpen(o => !o)} aria-label="Settings" title="Settings" aria-expanded={open}>
        <Settings size={15} strokeWidth={1.75} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} width={288} className="py-1.5">
        <div className="px-3 pt-1 pb-2.5 text-[12px] border-b border-line">
          <div className="text-[12px] text-text-muted mb-1">Rate governor</div>
          <GovernorLine g={gov} />
          <div className="text-[12px] text-text-muted mt-1 leading-snug">
            Every Meta call goes through a local limit that paces requests and backs off when Meta signals load.
          </div>
        </div>
        <div className="px-3 py-2 border-b border-line flex items-center justify-between gap-2">
          <span className="text-[12px] text-text-secondary">Appearance</span>
          <Segmented<Scheme> size="icon" ariaLabel="Appearance" value={scheme}
            onChange={s => { setScheme(s); setSchemeState(s) }}
            options={[
              { value: 'dark', icon: <Moon size={13} />, title: 'Dark' },
              { value: 'light', icon: <Sun size={13} />, title: 'Light' },
              { value: 'system', icon: <Monitor size={13} />, title: 'Match the system' },
            ]} />
        </div>
        <div className="py-1">
          {demo ? (
            <button type="button" className={row} onClick={() => { setOpen(false); onConnect() }}>
              <Repeat size={13} /> Connect your Meta ad account
            </button>
          ) : (
            <>
              <button type="button" className={row} onClick={() => { setOpen(false); onChangeAccount() }}>
                <Repeat size={13} /> Change ad account
              </button>
              {!confirm ? (
                <button type="button" className={row} onClick={() => setConfirm(true)}>
                  <LogOut size={13} /> Disconnect
                </button>
              ) : (
                <div className="px-3 py-2 text-[12px] text-text-secondary">
                  <p className="mb-2 leading-snug">This removes the saved token, the account and every cached pull from this computer.</p>
                  <div className="flex gap-2">
                    <button type="button" className="fv-btn-danger h-7 px-3 rounded-full text-[13px]"
                      onClick={() => { setOpen(false); onDisconnect() }}>Disconnect</button>
                    <button type="button" className={BTN_SECONDARY} onClick={() => setConfirm(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </Popover>
    </>
  )
}

export function Header(p: Props) {
  const [picking, setPicking] = useState(false)
  return (
    <header className="fv-topbar relative z-40" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-4 sm:px-5 py-3">
        <Wordmark />
        <div className="flex items-center gap-2 min-w-0 order-3 sm:order-none w-full sm:w-auto sm:ml-4">
          {p.demo ? (
            <>
              <span className="ody-tag h-7 px-3 rounded-full text-[13px] flex items-center gap-2 shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-rust-500" />
                Demo brand
              </span>
              <button type="button" className={`${BTN_PRIMARY} shrink-0`} onClick={p.onConnect}>
                Connect your Meta
              </button>
            </>
          ) : p.account ? (
            <button type="button" className={`${PILL} min-w-0`} onClick={p.onChangeAccount} title={`${p.account.name} (${p.account.id}). Change ad account`}>
              <span className="w-1.5 h-1.5 rounded-full bg-success-solid shrink-0" />
              <span className="truncate max-w-[200px] text-text-primary">{p.account.name}</span>
              <span className="text-text-muted shrink-0">{p.account.currency}</span>
            </button>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={PILL} onClick={() => setPicking(true)} aria-label="Date range">
            <CalendarDays size={13} className="text-text-muted" />
            <span className="hidden md:inline text-text-muted">{p.preset || 'Custom'}</span>
            <span className="text-text-primary tabular-nums">{rangeLabel(p.since, p.until)}</span>
            <ChevronDown size={11} className="opacity-60" />
          </button>
          <button type="button" className={HEADER_ICON} onClick={p.onRefresh} disabled={p.loading}
            title={p.demo ? 'Reload' : 'Pull fresh numbers from Meta (skips the 6 hour cache)'} aria-label="Refresh">
            <RefreshCw size={15} strokeWidth={1.75} className={p.loading ? 'animate-spin' : ''} />
          </button>
          <SettingsMenu demo={p.demo} onChangeAccount={p.onChangeAccount} onDisconnect={p.onDisconnect} onConnect={p.onConnect} />
        </div>
      </div>
      {/* In a portal, so the fixed overlay spans the window. */}
      {picking && createPortal(
        <DatePicker start={p.since} end={p.until} preset={p.preset}
          onApply={(s, e, pr) => p.onRange(s, e, pr)} onClose={() => setPicking(false)} />,
        document.body,
      )}
    </header>
  )
}
