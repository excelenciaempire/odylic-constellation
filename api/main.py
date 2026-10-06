"""Odylic Constellation API. Serves /api/* and the built web app (web/dist)
on one port (127.0.0.1:8777 by default).

Run:  uvicorn api.main:app --host 127.0.0.1 --port 8777
"""
from __future__ import annotations

import math
import mimetypes
import os
import re
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

import requests
import requests.adapters
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__, build_id, cli_bridge, governor, meta, store
from .governor import MetaAuthError, MetaThrottled, MetaWriteBlocked, scrub
from .meta import MetaError

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "web" / "dist"

ADS_TTL = 6 * 3600
COMMENTS_TTL = 3600
MAX_RANGE_DAYS = 37 * 31
THUMB_MAX_BYTES = 12 * 1024 * 1024
THUMB_HOST_SUFFIXES = ("fbcdn.net", "facebook.com", "cdninstagram.com", "fbsbx.com", "instagram.com")

@asynccontextmanager
async def _lifespan(_app):
    # Trim old cache files and thumbnails in the background at startup.
    threading.Thread(target=store.maybe_prune, kwargs={"force": True}, daemon=True).start()
    yield


app = FastAPI(title="Odylic Constellation", version=__version__, docs_url=None, redoc_url=None,
              lifespan=_lifespan)

# One ads pull at a time, and one chart pull at a time, on separate locks: the
# governor spaces every call anyway, parallel pulls of the same range would only
# spend budget twice, and a one-call chart never waits behind a whole ads pull.
_ads_lock = threading.Lock()
_chart_lock = threading.Lock()
# The range each account's page asked for last. A queued ads pull for a range
# the page has already moved past is dropped before it spends any Meta call.
_wanted: dict = {}

# A refresh=1 within this many seconds of the last pull of the same key serves
# that pull: a double click, or a page that loops refresh=1, costs no Meta call.
REFRESH_FLOOR_SEC = 120


# ---------------------------------------------------------------------------
# Local-only guard. The server listens on 127.0.0.1, but any web page the user
# opens can still aim requests at it, and a DNS rebinding page can even read
# the answers. So before any route runs:
#   * the Host header must name this machine (stops DNS rebinding);
#   * on /api, a request another site started is refused: Sec-Fetch-Site
#     cross-site or same-site, or an Origin that is not this page's own;
#   * on /api, anything but GET/HEAD/OPTIONS must be JSON, which a plain form
#     or a no-cors fetch from another page can not send.
# Requests with neither header (curl, scripts) still work.
# ---------------------------------------------------------------------------
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_SECURITY_HEADERS = (
    (b"x-frame-options", b"DENY"),
    (b"content-security-policy", b"frame-ancestors 'none'"),
    (b"referrer-policy", b"no-referrer"),
)
_API_HEADERS = ((b"cross-origin-resource-policy", b"same-origin"), (b"x-content-type-options", b"nosniff"))


def split_host(value: str) -> tuple:
    """(hostname, port or None) from a Host header or an Origin's netloc,
    lowercased. ("", None) when it can not be parsed."""
    v = (value or "").strip().lower()
    if v.startswith("["):
        end = v.find("]")
        if end < 0:
            return "", None
        host, rest = v[1:end], v[end + 1:]
        if rest and not rest.startswith(":"):
            return "", None
        return host, (rest[1:] or None) if rest else None
    if v.count(":") > 1:
        return "", None  # a bare IPv6 literal is not a valid Host
    host, _, port = v.partition(":")
    return host, (port or None)


def allowed_hosts() -> frozenset:
    """Loopback names, plus ODYLIC_HOST when it names one address, plus any
    ODYLIC_ALLOWED_HOSTS (comma separated) for a deliberate LAN setup."""
    out = set(LOOPBACK_HOSTS)
    bind = (os.environ.get("ODYLIC_HOST") or "").strip().lower().strip("[]")
    if bind and bind not in ("0.0.0.0", "::"):
        out.add(bind)
    for h in (os.environ.get("ODYLIC_ALLOWED_HOSTS") or "").split(","):
        h = h.strip().lower().strip("[]")
        if h:
            out.add(h)
    return frozenset(out)


def guard_problem(method: str, path: str, headers: dict) -> Optional[tuple]:
    """(status, code, message) when the request must be refused, else None.
    `headers` has lowercased names."""
    host_header = headers.get("host", "")
    host, _port = split_host(host_header)
    if not host or host not in allowed_hosts():
        return 400, "bad_host", ("This server only answers requests for 127.0.0.1 or localhost. "
                                 "Open http://127.0.0.1:8777 instead.")
    if not (path == "/api" or path.startswith("/api/")):
        return None
    site = headers.get("sec-fetch-site", "").strip().lower()
    if site and site not in ("same-origin", "none"):
        return 403, "cross_site", "Requests from other websites are refused."
    origin = headers.get("origin")
    if origin is not None:
        o = urlsplit(origin.strip())
        o_host, o_port = split_host(o.netloc)
        h_host, h_port = split_host(host_header)
        if (o.scheme not in ("http", "https") or not o_host or o_host not in allowed_hosts()
                or (o_host, o_port) != (h_host, h_port)):
            return 403, "cross_site", "Requests from other websites are refused."
    if method.upper() not in _SAFE_METHODS:
        ctype = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if ctype != "application/json":
            return 415, "bad_content_type", "Send JSON (Content-Type: application/json)."
    return None


_refusals_logged: dict = {}


def _log_refusal(method: str, path: str, code: str) -> None:
    """One log line per kind of refusal per minute, so a page that loops
    requests at the server can not grow the log without bound."""
    now = time.monotonic()
    if now - _refusals_logged.get(code, -1e9) < 60:
        return
    _refusals_logged[code] = now
    print(f"[api] refused {method} {path}: {code} (more of these are not logged for a minute)", flush=True)


class LocalGuard:
    """Pure ASGI middleware around every route (see guard_problem), which also
    adds the anti-framing and referrer headers to every response."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {}
        for k, v in scope.get("headers") or []:
            headers[k.decode("latin-1").lower()] = v.decode("latin-1")
        path = scope.get("path") or ""
        problem = guard_problem(scope.get("method") or "GET", path, headers)
        is_api = path == "/api" or path.startswith("/api/")
        extra = _SECURITY_HEADERS + (_API_HEADERS if is_api else ())
        if problem:
            status, code, message = problem
            _log_refusal(str(scope.get("method")), path, code)
            if scope["type"] != "http":
                return
            resp = JSONResponse({"error": message, "code": code}, status_code=status)
            resp.raw_headers.extend(extra)
            await resp(scope, receive, send)
            return

        async def send_with_headers(message):
            if message.get("type") == "http.response.start":
                message = dict(message)
                message["headers"] = list(message.get("headers") or []) + list(extra)
            await send(message)

        await self.app(scope, receive, send_with_headers)


app.add_middleware(LocalGuard)


# ---------------------------------------------------------------------------
# Errors: always {"error": "...", "code": "..."}
# ---------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: Optional[dict] = None, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra
        self.headers = headers


def _err(status: int, code: str, message: str, headers: Optional[dict] = None, **extra) -> JSONResponse:
    body = {"error": scrub(message), "code": code}
    body.update(extra)
    return JSONResponse(body, status_code=status, headers=headers)


@app.exception_handler(ApiError)
async def _api_error(_req: Request, exc: ApiError):
    return _err(exc.status, exc.code, exc.message, headers=exc.headers, **exc.extra)


@app.exception_handler(RequestValidationError)
async def _validation_error(_req: Request, exc: RequestValidationError):
    first = (exc.errors() or [{}])[0]
    where = ".".join(str(x) for x in first.get("loc", []) if x not in ("body", "query"))
    msg = first.get("msg") or "Invalid request."
    return _err(400, "bad_request", f"{where}: {msg}" if where else msg)


@app.exception_handler(StarletteHTTPException)
async def _http_error(_req: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        return _err(404, "not_found", "Not found.")
    if exc.status_code == 405:
        return _err(405, "method_not_allowed", "Method not allowed.")
    return _err(exc.status_code, "http_error", str(exc.detail))


@app.exception_handler(Exception)
async def _unhandled(_req: Request, exc: Exception):
    print(f"[api] unhandled {type(exc).__name__}: {scrub(exc)}", flush=True)
    resp = _err(500, "internal_error", "Something went wrong on the local server. Check the terminal log.")
    # This handler runs outside the guard's send wrapper, so the security headers go on here.
    for k, v in _SECURITY_HEADERS + _API_HEADERS:
        resp.headers[k.decode()] = v.decode()
    return resp


def _meta_failure(e: Exception) -> ApiError:
    """Turn a Meta / governor exception into a clean API error."""
    if isinstance(e, MetaThrottled):
        until = governor.iso(e.until) if getattr(e, "until", None) else governor.paused_until_iso()
        when = ""
        if until:
            try:
                local = datetime.fromisoformat(until.replace("Z", "+00:00")).astimezone()
                when = f" Try again after {local.strftime('%H:%M')}."
            except ValueError:
                pass
        return ApiError(429, "throttled", f"{e.reason if hasattr(e, 'reason') else e}{when}", paused_until=until)
    if isinstance(e, MetaAuthError):
        return ApiError(401, "invalid_token",
                        f"Meta rejected the access token: {scrub(e)} Connect again with a fresh token.")
    if isinstance(e, MetaWriteBlocked):
        return ApiError(500, "write_blocked", str(e))
    if isinstance(e, MetaError):
        if e.code in (10, 200, 272, 803):
            return ApiError(403, "permission_denied",
                            f"Meta refused access: {e.message} The token needs ads_read on this ad account.")
        return ApiError(502, "meta_error", f"Meta returned an error: {e.message}")
    return ApiError(500, "internal_error", f"Unexpected error: {scrub(e)}")


# ---------------------------------------------------------------------------
# Demo (owned by another module; loaded lazily so the server runs without it)
# ---------------------------------------------------------------------------
def _demo():
    try:
        from . import demo_data  # noqa: WPS433
        return demo_data
    except Exception as e:  # missing module or a bug inside it
        print(f"[api] demo data unavailable: {type(e).__name__}: {e}", flush=True)
        return None


def _demo_or_error():
    d = _demo()
    if d is None:
        raise ApiError(503, "demo_unavailable", "The demo brand is not available in this build.")
    return d


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _connection() -> tuple:
    """(token, account dict) or (None, None)."""
    cfg = store.load_config()
    token = cfg.get("token") if isinstance(cfg.get("token"), str) and cfg.get("token") else None
    account = cfg.get("account") if isinstance(cfg.get("account"), dict) else None
    return token, account


def _truthy(v: Optional[str]) -> bool:
    return str(v or "").strip().lower() in ("1", "true", "yes", "on")


def _parse_range(since: Optional[str], until: Optional[str]) -> tuple:
    today = date.today()
    try:
        u = date.fromisoformat(until) if until else today - timedelta(days=1)
        s = date.fromisoformat(since) if since else u - timedelta(days=29)
    except ValueError:
        raise ApiError(400, "bad_date", "Dates must look like YYYY-MM-DD.")
    if s > u:
        raise ApiError(400, "bad_date", "The start date is after the end date.")
    if u > today + timedelta(days=1):
        raise ApiError(400, "bad_date", "The end date is in the future.")
    if (u - s).days > MAX_RANGE_DAYS:
        raise ApiError(400, "bad_date", "Meta only reports up to 37 months at a time.")
    return s.isoformat(), u.isoformat()


def _require_token() -> str:
    token = store.get_token()
    if not token:
        raise ApiError(409, "not_connected", "Connect a Meta account first.")
    return token


# ---------------------------------------------------------------------------
# Status, consent, governor
# ---------------------------------------------------------------------------
@app.get("/api/status")
def status():
    cfg = store.load_config()
    token = cfg.get("token")
    return {
        "connected": bool(token),
        "mode": cfg.get("mode") if token else None,
        "account": cfg.get("account") if token and isinstance(cfg.get("account"), dict) else None,
        "cli": cli_bridge.summary(),
        "consent": bool(cfg.get("consent")),
        "governor": governor.status(),
    }


class ConsentBody(BaseModel):
    accepted: bool


@app.post("/api/consent")
def consent(body: ConsentBody):
    store.update_config(consent=bool(body.accepted))
    return {"ok": True}


@app.get("/api/governor")
def governor_status():
    return governor.status()


APP_ID = "odylic-constellation"
BUILD = build_id()


@app.get("/api/health")
def health(c: Optional[str] = None):
    """Liveness plus identity for the launchers: `build` changes whenever the
    backend code on disk changes, and `proof` (when a challenge `c` is sent) is
    an HMAC of it with this install's secret, which only this install's own
    server can produce. The secret itself is never returned."""
    out = {"ok": True, "app": APP_ID, "version": __version__, "build": BUILD}
    if c is not None:
        if not re.fullmatch(r"[A-Za-z0-9]{16,128}", c):
            raise ApiError(400, "bad_challenge", "The challenge must be 16 to 128 letters or digits.")
        out["proof"] = store.install_proof(c)
    return out


# ---------------------------------------------------------------------------
# Connect
# ---------------------------------------------------------------------------
class TokenBody(BaseModel):
    access_token: str


def _save_connection(token: str, mode: str, accounts: list) -> None:
    cfg = store.load_config()
    if cfg.get("token") != token:
        store.clear_caches()
        meta.clear_memory()
        cfg["account"] = None
    cfg.update(token=token, mode=mode, accounts=accounts)
    store.save_config(cfg)


@app.post("/api/connect/token")
def connect_token(body: TokenBody):
    token = re.sub(r"\s+", "", body.access_token or "")
    if len(token) < 20 or not re.fullmatch(r"[A-Za-z0-9._\-|]+", token):
        raise ApiError(400, "bad_token", "That does not look like a Meta access token. Paste the whole token.")
    try:
        meta.me(token)
        accounts = meta.list_ad_accounts(token)
    except (MetaThrottled, MetaAuthError, MetaWriteBlocked, MetaError) as e:
        raise _meta_failure(e)
    _save_connection(token, "token", accounts)
    return {"ok": True, "accounts": accounts}


@app.post("/api/connect/cli")
def connect_cli():
    binary = cli_bridge.find_binary()
    creds = cli_bridge.discover_credentials()
    token = creds["token"]
    if not token:
        if not binary:
            raise ApiError(400, "cli_not_found",
                           "The Meta Ads CLI was not found. Install it with: pip install meta-ads "
                           "(Python 3.12 or newer), then set ACCESS_TOKEN and AD_ACCOUNT_ID in your "
                           "environment or in a .env file in your home folder.")
        raise ApiError(400, "cli_no_credentials",
                       "The Meta Ads CLI is installed but no credentials were found. Set ACCESS_TOKEN "
                       "(and optionally AD_ACCOUNT_ID) in your environment, in ./.env, or in ~/.env, "
                       "then try again.")

    # The token is checked with this app's own governed client, never through
    # `meta` subprocesses: their calls would bypass the rate governor (its
    # pacing, Meta's usage headers and the 30 minute block on a dead token).
    note = None if binary else "The meta command was not found, so this connected with the credentials it would use."
    try:
        meta.me(token)
        accounts = meta.list_ad_accounts(token)
    except (MetaThrottled, MetaAuthError, MetaWriteBlocked, MetaError) as e:
        raise _meta_failure(e)
    _save_connection(token, "cli", accounts)
    return {"ok": True, "accounts": accounts, "default_account": creds["account_id"], "note": note}


class AccountBody(BaseModel):
    account_id: str


@app.post("/api/account")
def choose_account(body: AccountBody):
    token = _require_token()
    acct_id = meta.normalize_account_id(body.account_id)
    if not acct_id:
        raise ApiError(400, "bad_account", "Account ids look like act_1234567890.")
    cfg = store.load_config()
    known = next((a for a in (cfg.get("accounts") or []) if isinstance(a, dict) and a.get("id") == acct_id), None)
    if known:
        account = known
    else:
        try:
            account = meta.get_account(token, acct_id)
        except (MetaThrottled, MetaAuthError, MetaWriteBlocked, MetaError) as e:
            raise _meta_failure(e)
    # No cache wipe on a switch: every cache key carries the account id and
    # every account in the list is readable by the same token, so switching
    # back to an account within 6 hours costs no Meta call. A new token or a
    # disconnect still wipes everything (_save_connection, clear_connection).
    store.update_config(account=account)
    return {"ok": True, "account": account}


@app.get("/api/accounts")
def accounts(refresh: Optional[str] = None):
    """The ad accounts this token can read, for "Change account". Served from
    the list saved at connect time (no Meta call) unless refresh=1."""
    token = _require_token()
    cfg = store.load_config()
    saved = [a for a in (cfg.get("accounts") or []) if isinstance(a, dict)]
    if saved and not _truthy(refresh):
        return {"accounts": saved}
    try:
        fresh = meta.list_ad_accounts(token)
    except (MetaThrottled, MetaAuthError, MetaWriteBlocked, MetaError) as e:
        raise _meta_failure(e)
    store.update_config(accounts=fresh)
    return {"accounts": fresh}


@app.post("/api/disconnect")
def disconnect():
    governor.unblock_token(governor.token_fingerprint(store.get_token()))
    store.clear_connection()
    meta.clear_memory()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Ads
# ---------------------------------------------------------------------------
class _PullCheckpoint:
    """Keeps the finished steps of an ads pull (and every creative node it
    fetched) on disk, so when a pause interrupts a pull, the retry continues
    where it stopped instead of paying for the same Meta calls again.
    `fresh` (refresh=1) ignores what is saved, but still saves."""

    def __init__(self, account_id: str, key: str, fresh: bool):
        self.account_id, self.key, self.fresh = account_id, key, fresh
        self._memo: dict = {}

    def load(self, step: str):
        if self.fresh:
            return None
        if step not in self._memo:
            self._memo[step] = store.cache_get("ads_steps", f"{self.key}|{step}", ADS_TTL)
        return self._memo[step]

    def save(self, step: str, value) -> None:
        self._memo.pop(step, None)
        store.cache_put("ads_steps", f"{self.key}|{step}", value)

    def nodes(self, ids: list) -> dict:
        return {} if self.fresh else store.nodes_get(self.account_id, ids, ADS_TTL)

    def save_nodes(self, nodes: dict) -> None:
        store.nodes_put(self.account_id, nodes, ADS_TTL)

    def clear(self) -> None:
        for step in ("rows", "segments"):
            store.cache_delete("ads_steps", f"{self.key}|{step}")

    def remaining_calls(self) -> Optional[int]:
        """Meta calls the rest of an interrupted pull needs, or None when no
        step of this pull is saved yet (nothing to estimate from)."""
        rows = self.load("rows")
        if not isinstance(rows, list):
            return None
        n = len(rows)
        est = 0
        if self.load("segments") is None:
            est += max(1, math.ceil(3 * n / meta.PAGE_LIMIT))
        have = self.nodes([str(r.get("ad_id")) for r in rows if isinstance(r, dict)])
        est += math.ceil(max(0, n - len(have)) / meta.ADS_CHUNK)
        return est


@app.get("/api/ads")
def ads(since: Optional[str] = None, until: Optional[str] = None,
        demo: Optional[str] = None, refresh: Optional[str] = None):
    s, u = _parse_range(since, until)
    token, account = _connection()

    if _truthy(demo) or not token or not account:
        d = _demo_or_error()
        acct = d.demo_account()
        return {
            "account": acct, "since": s, "until": u, "currency": acct.get("currency") or "USD",
            "demo": True, "fetched_at": _now_iso(), "cached": False, "ads": d.demo_ads(s, u),
        }

    key = f"{account['id']}|{s}|{u}"
    fresh = _truthy(refresh)
    ttl = REFRESH_FLOOR_SEC if fresh else ADS_TTL
    hit = store.cache_get("ads", key, ttl)
    if hit:
        return {**hit, "account": account, "cached": True}

    _wanted[account["id"]] = key
    with _ads_lock:
        if _wanted.get(account["id"]) != key:
            # The page moved on to another range while this one waited.
            raise ApiError(409, "superseded", "A newer date range replaced this request. Reload to try again.")
        hit = store.cache_get("ads", key, ttl)
        if hit:
            return {**hit, "account": account, "cached": True}
        checkpoint = _PullCheckpoint(account["id"], key, fresh)
        try:
            # A retry after a pause waits until the rest of the pull fits in
            # the hourly budget, instead of spending the one slot that just
            # freed and failing on the next call.
            need = checkpoint.remaining_calls()
            if need and need <= governor.cap():
                free_at = governor.slots_free_at(need)
                if free_at:
                    raise MetaThrottled(
                        f"The rest of this load needs about {need} Meta call{'' if need == 1 else 's'}, more "
                        "than the hourly safety budget has left right now.", free_at)
            rows, index, notes = meta.fetch_ads(token, account["id"], s, u, checkpoint=checkpoint)
        except (MetaThrottled, MetaAuthError, MetaWriteBlocked, MetaError) as e:
            err = _meta_failure(e)
            stale = store.cache_get("ads", key, None)
            if stale and err.code == "throttled":
                return {**stale, "account": account, "cached": True,
                        "note": "Showing saved data: Meta calls are paused right now."}
            raise err
        payload = {
            "account": account, "since": s, "until": u, "currency": account.get("currency") or "USD",
            "demo": False, "fetched_at": _now_iso(), "cached": False, "ads": rows,
            "note": " ".join(notes) or None,
        }
        store.merge_index(index)
        store.cache_put("ads", key, payload)
        checkpoint.clear()
    store.maybe_prune()
    return payload


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------
@app.get("/api/ads/{ad_id}/comments")
def comments(ad_id: str, demo: Optional[str] = None, refresh: Optional[str] = None):
    token, account = _connection()
    if _truthy(demo) or not token or not account:
        d = _demo_or_error()
        payload = d.demo_comments(ad_id)
        if payload is None:
            raise ApiError(404, "not_found", "No demo ad with that id.")
        return payload
    if not meta.is_numeric_id(ad_id):
        raise ApiError(400, "bad_ad_id", "Ad ids are numbers.")
    key = f"{account['id']}|{ad_id}"
    hit = store.cache_get("comments", key, REFRESH_FLOOR_SEC if _truthy(refresh) else COMMENTS_TTL)
    if hit:
        return hit
    known = store.load_index().get(ad_id)
    try:
        payload = meta.fetch_comments(token, ad_id, known)
    except (MetaThrottled, MetaAuthError, MetaWriteBlocked, MetaError) as e:
        raise _meta_failure(e)
    store.cache_put("comments", key, payload)
    return payload


# ---------------------------------------------------------------------------
# Thumbnails: downloaded once from Meta's image CDN (never the Graph API, so
# no Meta call), then served from disk. Files are named by ad and creative,
# so an ad whose creative was edited gets its new image. Up to four
# downloads run at once over one kept-alive connection pool; two requests for
# the same ad share one download; a link that failed is not retried until the
# next ads pull renews it.
# ---------------------------------------------------------------------------
_THUMB_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
THUMB_TIMEOUT = (5, 15)          # connect, then each read
THUMB_DEADLINE_SEC = 30.0        # the whole download
THUMB_PARALLEL = 4
THUMB_GONE_SEC = 3600            # a 403/404/410 link is skipped this long (or until it changes)
THUMB_BAD_SEC = 7 * 86400        # too big or not an image: skipped until the link changes
_NO_THUMB_HEADERS = {"Cache-Control": "private, max-age=300"}

_thumb_session = requests.Session()
_thumb_session.mount("https://", requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=8))
_thumb_slots = threading.BoundedSemaphore(THUMB_PARALLEL)
_thumb_locks: dict = {}          # ad_id to [Lock, users]
_thumb_locks_guard = threading.Lock()
_thumb_dead: dict = {}           # (ad_id, src) to the time it may be tried again


@contextmanager
def _thumb_ad_lock(ad_id: str):
    with _thumb_locks_guard:
        entry = _thumb_locks.setdefault(ad_id, [threading.Lock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _thumb_locks_guard:
            entry[1] -= 1
            if entry[1] <= 0 and _thumb_locks.get(ad_id) is entry:
                del _thumb_locks[ad_id]


def _thumb_name(ad_id: str, key) -> str:
    k = re.sub(r"[^A-Za-z0-9]", "", str(key or ""))[:40]
    return f"{ad_id}_{k}" if k else ad_id


def _cached_thumb(name: str) -> Optional[Path]:
    for ext in (".jpg", ".png", ".webp", ".gif"):
        p = store.thumbs_dir() / f"{name}{ext}"
        if p.is_file() and p.stat().st_size > 0:
            return p
    return None


def _thumb_response(p: Path) -> FileResponse:
    # Recently served downloads survive the disk prune; demo thumbs in the install folder are left alone.
    if store.thumbs_dir() in p.parents:
        try:
            os.utime(p)
        except OSError:
            pass
    mt = mimetypes.guess_type(p.name)[0] or "image/jpeg"
    return FileResponse(p, media_type=mt, headers={"Cache-Control": "private, max-age=86400"})


def _thumb_host_ok(src: str) -> bool:
    u = urlsplit(src or "")
    host = (u.hostname or "").lower()
    return u.scheme == "https" and any(host == h or host.endswith("." + h) for h in THUMB_HOST_SUFFIXES)


def _download_thumb(name: str, src: str) -> tuple:
    """(path, None) on success, else (None, why): "gone" (403/404/410),
    "bad" (not an allowed host, not an image, or too big) or "error"
    (anything worth trying again later)."""
    if not _thumb_host_ok(src):
        return None, "bad"
    d = store.thumbs_dir()
    tmp = d / f".{name}.{os.getpid()}.{threading.get_ident()}.tmp"
    deadline = time.monotonic() + THUMB_DEADLINE_SEC
    try:
        with _thumb_slots:
            with _thumb_session.get(src, timeout=THUMB_TIMEOUT, stream=True) as r:
                if r.status_code in (403, 404, 410):
                    return None, "gone"
                if r.status_code != 200:
                    return None, "error"
                ctype = (r.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip().lower()
                if not ctype.startswith("image/"):
                    return None, "bad"
                try:
                    declared = int(r.headers.get("Content-Length") or 0)
                except ValueError:
                    declared = 0
                if declared > THUMB_MAX_BYTES:
                    return None, "bad"
                size = 0
                with open(tmp, "wb") as fh:
                    for chunk in r.iter_content(64 * 1024):
                        size += len(chunk)
                        if size > THUMB_MAX_BYTES:
                            return None, "bad"
                        if time.monotonic() > deadline:
                            return None, "error"
                        fh.write(chunk)
        if not size:
            return None, "error"
        p = d / f"{name}{_THUMB_EXT.get(ctype, '.jpg')}"
        os.replace(tmp, p)
        return p, None
    except (requests.RequestException, OSError, MetaThrottled, MetaAuthError, MetaWriteBlocked):
        return None, "error"
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _drop_old_thumbs(ad_id: str, keep: Path) -> None:
    """Older files of the same ad (an earlier creative, or the old naming)."""
    d = store.thumbs_dir()
    for p in [*d.glob(f"{ad_id}.*"), *d.glob(f"{ad_id}_*")]:
        if p != keep and not p.name.startswith("."):
            try:
                p.unlink()
            except OSError:
                pass


def _thumb_dead_until(ad_id: str, src: str) -> float:
    return float(_thumb_dead.get((ad_id, src), 0))


def _mark_thumb_dead(ad_id: str, src: str, why: Optional[str]) -> None:
    if why not in ("gone", "bad"):
        return
    now = time.time()
    if len(_thumb_dead) > 5000:
        for k in [k for k, t in _thumb_dead.items() if t <= now]:
            _thumb_dead.pop(k, None)
    _thumb_dead[(ad_id, src)] = now + (THUMB_GONE_SEC if why == "gone" else THUMB_BAD_SEC)


def _fetch_thumb(ad_id: str, name: str, entry: dict) -> Optional[Path]:
    """Download the ad's image, falling back to Meta's 640x800 thumbnail
    when the full image is gone, too big or not an image."""
    now = time.time()
    for src in (entry.get("thumb_src"), entry.get("thumb_alt")):
        if not src or _thumb_dead_until(ad_id, src) > now:
            continue
        p, why = _download_thumb(name, src)
        if p:
            _drop_old_thumbs(ad_id, p)
            return p
        _mark_thumb_dead(ad_id, src, why)
        if why == "error":
            return None
    return None


@app.get("/api/thumb/{ad_id}")
def thumb(ad_id: str, demo: Optional[str] = None, v: Optional[str] = None):
    """`v` (the ad's creative key) is only there so the browser fetches again
    after a creative changes; the file is chosen from the ad index."""
    token, account = _connection()
    if _truthy(demo) or not token or not account:
        d = _demo_or_error()
        p = d.demo_thumb_path(ad_id)
        if not p or not Path(p).is_file():
            raise ApiError(404, "no_thumbnail", "No thumbnail for this demo ad.")
        return _thumb_response(Path(p))
    if not meta.is_numeric_id(ad_id):
        raise ApiError(400, "bad_ad_id", "Ad ids are numbers.")
    entry = store.load_index().get(ad_id) or {}
    name = _thumb_name(ad_id, entry.get("thumb_key"))
    p = _cached_thumb(name)
    if p:
        return _thumb_response(p)
    if not entry.get("thumb_src") and not entry.get("thumb_alt"):
        raise ApiError(404, "no_thumbnail", "No thumbnail is known for this ad. Load the ads first.")
    with _thumb_ad_lock(ad_id):
        p = _cached_thumb(name) or _fetch_thumb(ad_id, name, entry)
    if not p:
        raise ApiError(404, "no_thumbnail",
                       "The thumbnail could not be downloaded. Meta image links expire; refresh the ads to renew them.",
                       headers=_NO_THUMB_HEADERS)
    store.maybe_prune()
    return _thumb_response(p)


# ---------------------------------------------------------------------------
# Ad charts (the drawer's Charts tab). Lazy: a chart asks for its data only
# when it is opened. Each is one governed insights call for the ad, or for
# every ad that runs the same creative (`ids`), run one pull at a time and
# kept on disk for 6 hours per (account, ads, since, until, kind).
# ---------------------------------------------------------------------------
CHART_TTL = 6 * 3600


def _chart_ad_ids(ad_id: str, ids: Optional[str]) -> list:
    """The ad plus the other ads of a stacked card, deduped, the ad leading."""
    out: list = []
    for x in [ad_id, *str(ids or "").split(",")]:
        x = x.strip()
        if x and x not in out:
            out.append(x)
    if not all(meta.is_numeric_id(x) for x in out):
        raise ApiError(400, "bad_ad_id", "Ad ids are numbers.")
    if len(out) > meta.CHART_MAX_ADS:
        raise ApiError(400, "too_many_ads", f"A chart combines at most {meta.CHART_MAX_ADS} ads.")
    return out


def _chart_response(bucket: str, label: str, ad_id: str, ids: Optional[str], since: Optional[str],
                    until: Optional[str], demo: Optional[str], refresh: Optional[str], field: str,
                    from_demo, from_meta, extra: Optional[dict] = None) -> dict:
    """Shared by the chart routes: demo or connected, disk cache, the chart
    lock, stale data while Meta is paused, and the error mapping."""
    s, u = _parse_range(since, until)
    ad_ids = _chart_ad_ids(ad_id, ids)
    head = {"ad_id": ad_id, "ad_ids": ad_ids, **(extra or {}), "since": s, "until": u}
    token, account = _connection()
    if _truthy(demo) or not token or not account:
        value = from_demo(_demo_or_error(), ad_ids, s, u)
        return {**head, "demo": True, "fetched_at": _now_iso(), "cached": False, "note": None, field: value}

    key = f"{account['id']}|{','.join(sorted(ad_ids))}|{s}|{u}|{label}"
    ttl = REFRESH_FLOOR_SEC if _truthy(refresh) else CHART_TTL
    hit = store.cache_get(bucket, key, ttl)
    if hit:
        return {**hit, "ad_id": ad_id, "ad_ids": ad_ids, "cached": True}
    with _chart_lock:
        hit = store.cache_get(bucket, key, ttl)
        if hit:
            return {**hit, "ad_id": ad_id, "ad_ids": ad_ids, "cached": True}
        try:
            value = from_meta(token, account["id"], ad_ids, s, u)
        except (MetaThrottled, MetaAuthError, MetaWriteBlocked, MetaError) as e:
            err = _meta_failure(e)
            stale = store.cache_get(bucket, key, None)
            if stale and err.code == "throttled":
                return {**stale, "ad_id": ad_id, "ad_ids": ad_ids, "cached": True,
                        "note": "Showing saved data: Meta calls are paused right now."}
            raise err
        payload = {**head, "demo": False, "fetched_at": _now_iso(), "cached": False, "note": None, field: value}
        store.cache_put(bucket, key, payload)
        return payload


def _demo_rows(fn, ad_ids: list, s: str, u: str) -> list:
    out: list = []
    for i in ad_ids:
        rows = fn(i, s, u)
        if rows is None:
            raise ApiError(404, "not_found", "No demo ad with that id.")
        out.extend(rows)
    return out


@app.get("/api/ads/{ad_id}/daily")
def ad_daily(ad_id: str, since: Optional[str] = None, until: Optional[str] = None, ids: Optional[str] = None,
             demo: Optional[str] = None, refresh: Optional[str] = None):
    """Per-day metrics for the ad (a stacked card's ads summed per day)."""
    return _chart_response(
        "ad_daily", "daily", ad_id, ids, since, until, demo, refresh, "days",
        lambda d, ad_ids, s, u: meta.combine_days(_demo_rows(d.demo_daily, ad_ids, s, u)),
        meta.fetch_ad_daily,
    )


@app.get("/api/ads/{ad_id}/breakdown")
def ad_breakdown(ad_id: str, kind: Optional[str] = None, since: Optional[str] = None, until: Optional[str] = None,
                 ids: Optional[str] = None, demo: Optional[str] = None, refresh: Optional[str] = None):
    """One breakdown (age, gender, age_gender, placement, platform, device or
    segment) for the ad, a stacked card's ads summed per row."""
    kind = (kind or "").strip().lower()
    if kind not in meta.BREAKDOWNS:
        raise ApiError(400, "bad_kind", "kind must be one of: " + ", ".join(meta.BREAKDOWNS) + ".")

    def from_demo(d, ad_ids, s, u):
        rows = _demo_rows(lambda i, a, b: d.demo_breakdown(i, kind, a, b), ad_ids, s, u)
        return meta.combine_breakdown(kind, [(*meta.breakdown_key(kind, r), r) for r in rows])

    return _chart_response(
        "ad_breakdown", kind, ad_id, ids, since, until, demo, refresh, "rows", from_demo,
        lambda token, account_id, ad_ids, s, u: meta.fetch_ad_breakdown(token, account_id, ad_ids, kind, s, u),
        extra={"kind": kind},
    )


@app.get("/api/ads/{ad_id}/video-curve")
def ad_video_curve(ad_id: str, since: Optional[str] = None, until: Optional[str] = None, ids: Optional[str] = None,
                   demo: Optional[str] = None, refresh: Optional[str] = None):
    """Meta's video retention curve for the ad (a stacked card's ads averaged
    by their plays): [{index, second, label, pct}]."""
    def from_demo(d, ad_ids, s, u):
        curves = []
        for i in ad_ids:
            c = d.demo_video_curve(i, s, u)
            if c is None:
                raise ApiError(404, "not_found", "No demo ad with that id.")
            curves.append((c["values"], c["plays"]))
        return meta.curve_points(meta.combine_curves(curves))

    return _chart_response("ad_curve", "video_curve", ad_id, ids, since, until, demo, refresh, "points",
                           from_demo, meta.fetch_ad_video_curve)


# ---------------------------------------------------------------------------
# Web app (web/dist) with SPA fallback
# ---------------------------------------------------------------------------
_NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Odylic Constellation</title>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.5">
<h1>The web app is not built yet</h1>
<p>Run <code>npm ci &amp;&amp; npm run build</code> inside the <code>web</code> folder, then reload.
The API is running: <a href="/api/status">/api/status</a>.</p></body>"""


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path.startswith("api/") or path == "api":
        return _err(404, "not_found", "Not found.")
    index = DIST / "index.html"
    if path:
        target = (DIST / path).resolve()
        try:
            target.relative_to(DIST.resolve())
        except ValueError:
            return _err(404, "not_found", "Not found.")
        if target.is_file():
            headers = {"Cache-Control": "public, max-age=31536000, immutable"} if path.startswith("assets/") else {}
            return FileResponse(target, headers=headers)
    if index.is_file():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return HTMLResponse(_NOT_BUILT, status_code=200)


def is_loopback(host: str) -> bool:
    h = (host or "").strip().lower().strip("[]")
    return h in LOOPBACK_HOSTS or h.startswith("127.")


def run() -> None:
    import sys

    import uvicorn
    host = os.environ.get("ODYLIC_HOST", "127.0.0.1")
    port = int(os.environ.get("ODYLIC_PORT", "8777"))
    if not is_loopback(host):
        if os.environ.get("ODYLIC_ALLOW_LAN") != "1":
            print(f"  Refusing to listen on {host}: the API has no login, so anyone on your network could "
                  "read your ad data and use your Meta token. Set ODYLIC_ALLOW_LAN=1 to do it anyway.",
                  file=sys.stderr, flush=True)
            raise SystemExit(2)
        print(f"  WARNING: listening on {host}. Anyone who can reach this address can read your ad data "
              "and use your Meta token. Requests must name an address listed in ODYLIC_HOST or "
              "ODYLIC_ALLOWED_HOSTS.", file=sys.stderr, flush=True)
    uvicorn.run("api.main:app", host=host, port=port, log_level="warning")


if __name__ == "__main__":
    run()
