/**
 * Typed fetchers for the local backend (SPEC.md "API contract"). Every call is
 * same-origin: in dev Vite proxies /api to 127.0.0.1:8777, in production the
 * backend serves this app itself.
 */

export type Account = {
  id: string
  name: string
  currency: string
  account_status: number | null
  timezone_name: string | null
}

export type Governor = {
  calls_last_hour: number
  cap: number
  paused_until: string | null
  reason: string | null
}

export type CliInfo = {
  installed: boolean
  path: string | null
  has_credentials: boolean
  default_account: string | null
}

export type Status = {
  connected: boolean
  mode: 'token' | 'cli' | null
  account: Account | null
  cli: CliInfo
  consent: boolean
  governor: Governor
}

export type SegmentSpend = { prospecting: number; engaged: number; existing: number; unknown: number }

export type Ad = {
  ad_id: string
  ad_name: string
  adset_id: string
  adset_name: string
  campaign_id: string
  campaign_name: string
  effective_status: string
  created_time: string | null
  creative_id: string | null
  creative_hash: string | null
  image_hash: string | null
  video_id: string | null
  is_video: boolean
  thumbnail_url: string
  image_url: string
  title: string | null
  body: string | null
  call_to_action_type: string | null
  account_id: string
  effective_object_story_id: string | null
  instagram_permalink_url: string | null
  ads_manager_url: string | null
  spend: number
  impressions: number
  clicks: number
  ctr: number | null
  cpm: number | null
  cpc: number | null
  reach: number
  frequency: number | null
  purchases: number
  revenue: number
  roas: number | null
  cost_per_purchase: number | null
  link_clicks: number
  outbound_clicks: number
  landing_page_views: number
  add_to_cart: number
  initiate_checkout: number
  leads: number
  video_3s_views: number
  thruplays: number
  video_p25: number
  video_p50: number
  video_p75: number
  video_p100: number
  post_reactions: number
  post_comments: number
  post_shares: number
  segment_spend: SegmentSpend | null
}

export type AdsResponse = {
  account: Account
  since: string
  until: string
  currency: string
  demo: boolean
  fetched_at: string
  cached: boolean
  ads: Ad[]
}

/** An API error: the backend's `{error, code}` body, or a network failure. */
export class ApiError extends Error {
  status: number
  code: string
  /** The whole error body (e.g. `paused_until` on a "throttled" error). */
  data: Record<string, unknown>
  constructor(message: string, status: number, code: string, data: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.data = data
  }
}

/** True for the governor's pause (or Meta's own throttle). */
export const isThrottle = (e: unknown) =>
  e instanceof ApiError && (e.code === 'throttled' || e.status === 429 || /paus|throttl/.test(e.code))

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    })
  } catch {
    throw new ApiError('Could not reach the local app server. Is it still running?', 0, 'network')
  }
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  if (!res.ok) {
    const b = (body && typeof body === 'object' ? body : {}) as { error?: string; code?: string; detail?: unknown }
    const msg = b.error || (typeof b.detail === 'string' ? b.detail : '') || `Request failed (${res.status})`
    throw new ApiError(msg, res.status, b.code || `http_${res.status}`, b as Record<string, unknown>)
  }
  return body as T
}

const post = <T>(path: string, data: unknown = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(data) })

export const api = {
  status: () => request<Status>('/api/status'),
  governor: () => request<Governor>('/api/governor'),
  consent: () => post<{ ok: true }>('/api/consent', { accepted: true }),
  connectToken: (access_token: string) => post<{ ok: true; accounts: Account[] }>('/api/connect/token', { access_token }),
  connectCli: () => post<{ ok: true; accounts: Account[]; default_account: string | null }>('/api/connect/cli', {}),
  /** Not in the base contract: lists the accounts the saved token can read. Callers fall back when it 404s. */
  accounts: () => request<{ accounts: Account[] }>('/api/accounts'),
  setAccount: (account_id: string) => post<{ ok: true; account: Account }>('/api/account', { account_id }),
  disconnect: () => post<{ ok: true }>('/api/disconnect', {}),
  ads: (p: { since: string; until: string; demo?: boolean; refresh?: boolean }, signal?: AbortSignal) => {
    const q = new URLSearchParams({ since: p.since, until: p.until })
    if (p.demo) q.set('demo', '1')
    if (p.refresh) q.set('refresh', '1')
    return request<AdsResponse>(`/api/ads?${q}`, { signal })
  },
}

/** Thumbnail URL for an ad (the backend's disk-cached proxy). `version` (the
 *  ad's creative_hash) changes the URL when the creative changes, so the
 *  browser's day-long cache never shows an edited ad's old image. */
export const thumbUrl = (adId: string, demo: boolean, version?: string | null) => {
  const q = new URLSearchParams()
  if (demo) q.set('demo', '1')
  if (version && !demo) q.set('v', version)
  const qs = q.toString()
  return `/api/thumb/${encodeURIComponent(adId)}${qs ? `?${qs}` : ''}`
}
