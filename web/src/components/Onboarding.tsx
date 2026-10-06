/**
 * Connect flow: 1) welcome and consent, 2) connect with the Meta Ads CLI or
 * an access token, 3) pick ONE ad account, 4) done. Based on the setup wizard
 * in odylic-lens (stepper, required consent gate, Meta walkthrough copy).
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, Copy, KeyRound, Search, ShieldCheck, Terminal } from 'lucide-react'
import { api, ApiError, type Account, type Status } from '../lib/api'
import { BTN_PRIMARY, BTN_SECONDARY } from '../ui/theme'
import { Segmented } from '../ui/Segmented'
import { Wordmark } from './Header'

type Step = 1 | 2 | 3 | 4
const STEPS: Array<{ id: Step; title: string }> = [
  { id: 1, title: 'Welcome' },
  { id: 2, title: 'Connect' },
  { id: 3, title: 'Ad account' },
  { id: 4, title: 'Done' },
]

const ACCOUNT_STATUS: Record<number, string> = {
  1: 'Active', 2: 'Disabled', 3: 'Unsettled', 7: 'Pending review', 8: 'Pending settlement',
  9: 'In grace period', 100: 'Pending closure', 101: 'Closed', 201: 'Any active', 202: 'Any closed',
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function Stepper({ step, reached, onStep }: { step: Step; reached: Step; onStep: (s: Step) => void }) {
  return (
    <ol className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-5" aria-label="Steps">
      {STEPS.map(s => {
        const active = s.id === step
        const done = s.id < step
        const can = s.id <= reached && s.id !== 4
        return (
          <li key={s.id} className="min-w-0 flex">
            <button type="button" disabled={!can} onClick={() => onStep(s.id)}
              aria-current={active ? 'step' : undefined}
              className={`w-full h-8 px-3 rounded-full text-[13px] flex items-center gap-1.5 truncate transition-colors ${
                active ? 'ody-chip ody-chip-on text-text-primary'
                  : done ? 'ody-chip text-text-secondary'
                    : 'text-text-muted'
              } disabled:cursor-default`}>
              <span className="opacity-70 shrink-0">{done ? <Check size={12} /> : `${s.id}.`}</span>
              <span className="truncate">{s.title}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="atelier-section !p-5 sm:!p-7">{children}</div>
}

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="font-display text-[22px] leading-tight text-text-primary mb-2.5">{children}</h2>
}

function CopyCode({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex items-center gap-2 bg-surface-recessed border border-line rounded-lg pl-3 pr-1 py-1 min-w-0">
      <span className="flex-1 text-[12px] font-mono text-text-primary overflow-x-auto whitespace-nowrap">{text}</span>
      <button type="button" className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-hover shrink-0"
        title="Copy" aria-label={`Copy ${text}`}
        onClick={() => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200) }).catch(() => {}) }}>
        {done ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] leading-relaxed text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">{children}</div>
}

// ── Step 1 ────────────────────────────────────────────────────────────────

function StepWelcome({ consented, onNext }: { consented: boolean; onNext: () => void }) {
  const [agreed, setAgreed] = useState(consented)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true); setError(null)
    try { await api.consent(); onNext() } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Card>
      <H>See every ad in your funnel</H>
      <div className="fv-prose text-[13px] text-text-secondary leading-relaxed">
        <p>
          Constellation lays out every ad of one Meta ad account in a 3D space, grouped by where Meta actually
          delivers it: new people, people who engaged, or existing customers. Click any ad for its numbers.
        </p>
        <p>It runs only on this Mac. Your token and ad data go only to Meta, never anywhere else.</p>
      </div>

      <div className="mt-5 border border-line rounded-xl px-4 py-3.5 bg-surface-recessed">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.06em] text-text-muted mb-1.5">
          <ShieldCheck size={12} /> Terms and risk
        </div>
        <ul className="text-[12.5px] text-text-secondary leading-relaxed list-disc pl-4 flex flex-col gap-1">
          <li>You connect with <strong>your own</strong> Meta access (your token or your Meta Ads CLI login) and you are bound by
            Meta's <a className="text-accent-ink underline" href="https://developers.facebook.com/terms" target="_blank" rel="noreferrer">Platform Terms</a>.</li>
          <li>The app is <strong>read-only</strong>: it never creates, edits or pauses anything in your account.</li>
          <li>Meta may throttle or restrict apps and tokens that call its API too often. A built-in rate governor caps calls
            (180 an hour by default), spaces them out and backs off when Meta signals load, but no tool can rule out action by Meta.</li>
          <li>Provided as is, with no warranty. The authors accept no liability for account actions, data loss or other damages.</li>
          <li>Not affiliated with, endorsed by or sponsored by Meta Platforms, Inc.</li>
        </ul>
        <label className="flex items-start gap-2.5 mt-3.5 cursor-pointer text-[13px] text-text-primary leading-snug">
          <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)}
            className="mt-0.5 shrink-0" />
          <span>I understand the risks, I use my own Meta access at my own discretion, and I agree to the terms above.</span>
        </label>
      </div>
      {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
      <div className="flex justify-end mt-5">
        <button type="button" className={BTN_PRIMARY} disabled={!agreed || busy} onClick={go}>
          {busy ? 'Saving...' : 'Continue'}
        </button>
      </div>
    </Card>
  )
}

// ── Step 2 ────────────────────────────────────────────────────────────────

type Method = 'cli' | 'token'

// The one permission the viewer needs. Ad accounts come from /me/adaccounts,
// which ads_read covers, so business_management is not asked for.
const PERMISSIONS = [
  ['ads_read', 'read your ads, their numbers and the ad accounts assigned to you'],
] as const

function StepConnect({ status, onConnected, onBack }: {
  status: Status | null
  onConnected: (accounts: Account[], preselect: string | null) => void
  onBack: () => void
}) {
  const cli = status?.cli
  const [method, setMethod] = useState<Method>(cli?.installed ? 'cli' : 'token')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)

  const run = async (fn: () => Promise<{ accounts: Account[]; default_account?: string | null }>) => {
    setBusy(true); setError(null)
    try {
      const r = await fn()
      onConnected(r.accounts || [], r.default_account ?? null)
    } catch (e) {
      setError({ code: e instanceof ApiError ? e.code : 'error', message: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <H>Connect your Meta ads</H>
      <p className="text-[13px] text-text-secondary mb-4">Pick one way in. Both stay read-only and on this Mac.</p>
      <Segmented<Method> ariaLabel="How to connect" value={method} onChange={m => { setMethod(m); setError(null) }}
        options={[
          { value: 'cli', label: 'Meta Ads CLI', icon: <Terminal size={12} />, title: 'Recommended if you already use it' },
          { value: 'token', label: 'Access token', icon: <KeyRound size={12} /> },
        ]} />

      {method === 'cli' ? (
        <div className="mt-5 flex flex-col gap-3 text-[13px] text-text-secondary leading-relaxed fv-prose">
          <p>
            <strong className="text-text-primary">Recommended if you already use it.</strong> The official Meta Ads CLI keeps
            your login in <code>ACCESS_TOKEN</code> and <code>AD_ACCOUNT_ID</code> (your shell environment or a <code>.env</code>
            file such as <code>~/.env</code>). Constellation reads them the same way the CLI does.
          </p>
          <div className="text-[12px] flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${cli?.installed ? 'bg-success-solid' : 'bg-neutral-400'}`} />
            {cli?.installed
              ? <span>CLI found{cli.path ? <> at <code>{cli.path}</code></> : null}{cli.has_credentials ? ', with credentials' : ', but no ACCESS_TOKEN yet'}.</span>
              : <span>CLI not found on this Mac.</span>}
          </div>
          {!cli?.installed && (
            <>
              <div className="text-[12px]">Install it with pip or Homebrew:</div>
              <CopyCode text="pip install meta-ads" />
              <CopyCode text="brew tap facebook/fb && brew install meta-ads" />
            </>
          )}
          <p className="text-[12px]">Then sign in with the CLI (or set <code>ACCESS_TOKEN</code>) and press Connect.</p>
          {error && (
            <ErrorBox>
              {error.message}
              {error.code === 'cli_no_credentials' && <> Set <code>ACCESS_TOKEN</code> (and optionally <code>AD_ACCOUNT_ID</code>) in <code>~/.env</code>, or use an access token instead.</>}
            </ErrorBox>
          )}
          <div className="flex justify-between mt-2">
            <button type="button" className={BTN_SECONDARY} onClick={onBack}><ArrowLeft size={13} /> Back</button>
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => run(api.connectCli)}>
              {busy ? 'Checking...' : 'Connect with the CLI'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-3 text-[13px] text-text-secondary leading-relaxed fv-prose">
          <p>A system user token from your Business Manager does not expire. About five minutes:</p>
          <ol className="list-decimal pl-5 flex flex-col gap-1.5 text-[12.5px]">
            <li>Open <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noreferrer">Business Settings, Users, System users</a>.</li>
            <li>Add a system user (the Employee role is enough).</li>
            <li>Assign assets: your ad account with <strong>view performance</strong> access.</li>
            <li>Generate a new token. Pick an app of your business (if none is listed, create one at <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com</a> with the Business type), set expiry to Never, and tick only:
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {PERMISSIONS.map(([p, why]) => (
                  <li key={p} className="text-[12px]"><code>{p}</code> <span className="text-text-muted">{why}</span></li>
                ))}
              </ul>
            </li>
            <li>Copy the token and paste it here.</li>
          </ol>
          <textarea value={token} onChange={e => setToken(e.target.value)} rows={3} spellCheck={false} autoComplete="off"
            placeholder="Paste your access token" aria-label="Access token"
            className="w-full border rounded-lg px-3 py-2 text-[12px] font-mono focus:outline-none resize-none" />
          <p className="text-[11px] text-text-muted">Stored only in this Mac's app folder (owner-only file), never sent anywhere but Meta.</p>
          {error && <ErrorBox>{error.message}</ErrorBox>}
          <div className="flex justify-between mt-1">
            <button type="button" className={BTN_SECONDARY} onClick={onBack}><ArrowLeft size={13} /> Back</button>
            <button type="button" className={BTN_PRIMARY} disabled={busy || token.trim().length < 20}
              onClick={() => run(() => api.connectToken(token.trim()))}>
              {busy ? 'Checking...' : 'Connect'}
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Step 3 ────────────────────────────────────────────────────────────────

function StepAccount({ accounts, preselect, onPicked, onBack }: {
  accounts: Account[]
  preselect: string | null
  onPicked: (a: Account) => void
  onBack: () => void
}) {
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<string | null>(() => {
    if (preselect) {
      const id = preselect.startsWith('act_') ? preselect : `act_${preselect}`
      if (accounts.some(a => a.id === id)) return id
    }
    return accounts.length === 1 ? accounts[0].id : null
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? accounts.filter(a => a.name.toLowerCase().includes(n) || a.id.includes(n)) : accounts
  }, [accounts, q])
  const save = async () => {
    if (!pick) return
    setBusy(true); setError(null)
    try { const r = await api.setAccount(pick); onPicked(r.account) } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Card>
      <H>Pick one ad account</H>
      <p className="text-[13px] text-text-secondary mb-4">
        The viewer shows one account at a time. You can switch later from the settings menu.
      </p>
      {accounts.length > 6 && (
        <div className="flex items-center gap-2 bg-surface-recessed border border-line rounded-lg px-2.5 py-1.5 mb-2">
          <Search size={13} className="text-text-muted" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${accounts.length} accounts`}
            className="flex-1 bg-transparent text-[12.5px] outline-none text-text-primary" autoFocus />
        </div>
      )}
      {!accounts.length && (
        <ErrorBox>This token can't see any ad accounts. Assign an ad account to the system user (step 3 of the token guide), then connect again.</ErrorBox>
      )}
      <div role="radiogroup" aria-label="Ad accounts" className="flex flex-col max-h-[340px] overflow-y-auto border border-line rounded-xl divide-y divide-line">
        {shown.map(a => {
          const on = a.id === pick
          const st = a.account_status != null ? ACCOUNT_STATUS[a.account_status] || `Status ${a.account_status}` : null
          return (
            <button key={a.id} type="button" role="radio" aria-checked={on} onClick={() => setPick(a.id)}
              className={`flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${on ? 'bg-select' : 'hover:bg-hover'}`}>
              <span className="w-3.5 h-3.5 rounded-full border-[1.5px] flex items-center justify-center shrink-0"
                style={{ borderColor: on ? 'var(--color-text-primary)' : 'var(--color-line-hover)' }}>
                {on && <span className="w-1.5 h-1.5 rounded-full bg-text-primary" />}
              </span>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-[13px] text-text-primary truncate">{a.name}</span>
                <span className="text-[11px] text-text-muted tabular-nums truncate">{a.id}{a.timezone_name ? `, ${a.timezone_name}` : ''}</span>
              </span>
              <span className="text-[11px] text-text-secondary shrink-0">{a.currency}</span>
              {st && (
                <span className={`text-[10.5px] shrink-0 ${a.account_status === 1 ? 'text-success' : 'text-text-muted'}`}>{st}</span>
              )}
            </button>
          )
        })}
        {accounts.length > 0 && !shown.length && <div className="px-3 py-4 text-[12px] text-text-muted text-center">No account matches.</div>}
      </div>
      {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
      <div className="flex justify-between mt-5">
        <button type="button" className={BTN_SECONDARY} onClick={onBack}><ArrowLeft size={13} /> Back</button>
        <button type="button" className={BTN_PRIMARY} disabled={!pick || busy} onClick={save}>
          {busy ? 'Saving...' : 'Use this account'}
        </button>
      </div>
    </Card>
  )
}

// ── Step 4 ────────────────────────────────────────────────────────────────

function StepDone({ account, onFinish }: { account: Account | null; onFinish: () => void }) {
  return (
    <Card>
      <H>You're set</H>
      <p className="text-[13px] text-text-secondary leading-relaxed">
        {account ? <><strong className="text-text-primary">{account.name}</strong> is connected. </> : null}
        The viewer opens on the last 14 days. A first pull of a big account can take up to a minute; after that, loads
        come from a local cache for 6 hours unless you press refresh.
      </p>
      <div className="flex justify-end mt-5">
        <button type="button" className={BTN_PRIMARY} onClick={onFinish}>Open my funnel</button>
      </div>
    </Card>
  )
}

// ── Flow ──────────────────────────────────────────────────────────────────

export function Onboarding({ status, startAt, onDone, onCancel }: {
  status: Status | null
  /** 'account' opens on the account list (change account), else the welcome step. */
  startAt: 'welcome' | 'account'
  onDone: (account: Account | null) => void
  onCancel: () => void
}) {
  const [step, setStep] = useState<Step>(1)
  const [reached, setReached] = useState<Step>(1)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [preselect, setPreselect] = useState<string | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  // Change account: list the accounts the saved token reads, else connect again.
  const [resolving, setResolving] = useState(startAt === 'account')
  const go = (s: Step) => { setStep(s); setReached(r => (s > r ? s : r)) }

  useEffect(() => {
    if (startAt !== 'account') return
    let live = true
    api.accounts()
      .then(r => { if (live) { setAccounts(r.accounts); setPreselect(status?.account?.id ?? null); go(3) } })
      .catch(() => { if (live) go(2) })
      .finally(() => { if (live) setResolving(false) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAt])

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="fv-topbar flex items-center gap-3 px-4 sm:px-5 py-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top, 0px))' }}>
        <Wordmark />
        <button type="button" className={`${BTN_SECONDARY} ml-auto`} onClick={onCancel}>
          <ArrowLeft size={13} /> {status?.connected ? 'Back to my funnel' : 'Back to the demo'}
        </button>
      </header>
      <main className="flex-1 w-full max-w-[680px] mx-auto px-4 py-6 sm:py-10">
        <Stepper step={step} reached={reached} onStep={go} />
        {resolving && (
          <Card>
            <div className="fv-progress mb-4"><span /></div>
            <p className="text-[13px] text-text-secondary">Loading your ad accounts...</p>
          </Card>
        )}
        {!resolving && step === 1 && <StepWelcome consented={!!status?.consent} onNext={() => go(2)} />}
        {!resolving && step === 2 && (
          <StepConnect status={status} onBack={() => go(1)}
            onConnected={(list, def) => { setAccounts(list); setPreselect(def); go(3) }} />
        )}
        {!resolving && step === 3 && (
          <StepAccount key={accounts.map(a => a.id).join(',')} accounts={accounts} preselect={preselect}
            onBack={() => go(2)} onPicked={a => { setAccount(a); go(4) }} />
        )}
        {step === 4 && <StepDone account={account} onFinish={() => onDone(account)} />}
      </main>
    </div>
  )
}
