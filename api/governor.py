"""Meta rate governor: ONE throttle for every Graph API call this app makes.

Meta suspends apps that hammer its API. This module makes that hard to do by
accident, no matter which code path makes the call:

* Chokepoint. `install()` wraps `requests.adapters.HTTPAdapter.send`, the last
  stop before the socket, for Meta Graph hosts only. Every request to Graph is
  paced, counted and checked here, retries included. Other hosts pass through.
* Cross-process. A lock file plus a JSON state file in DATA_DIR, so two server
  processes (or the server and a script) share one budget, and a restart can
  not reset it.
* Rolling 60-minute window, default cap 180 calls/hr
  (ODYLIC_META_MAX_PER_HOUR), at least 1.0s between calls.
* Usage headers (x-business-use-case-usage, x-ad-account-usage,
  x-fb-ads-insights-throttle, x-app-usage): calls slow down as usage climbs,
  and at 50% or more everything pauses (5 min, 15 min at 75%, 30 min at 90%).
* Meta's own `estimated_time_to_regain_access` is obeyed literally.
* Throttle codes {4, 17, 32, 613, 80000-80014} trip an escalating pause:
  5 min, 30 min, 2 h, then 6 h. Strikes decay after 12 h without one.
* A token Meta rejects (codes 190, 102) is refused locally for 30 minutes so a
  dead token can never loop. A different token is not affected.
* Read only: any method other than GET to a Graph host is refused before any
  network I/O.
* Fails closed: if the lock or the state file can not be used, calls are
  refused instead of going out uncounted.
* Tokens never reach logs: access_token is moved from the URL into an
  Authorization header, and `scrub()` cleans any text shown to a user.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from . import store

# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------
DEFAULT_CAP = 180
MIN_INTERVAL_SEC = 1.0
WINDOW_SEC = 3600
USAGE_BACKOFF_PCT = 50
# Usage at or above each line pauses everything for that many seconds.
USAGE_PAUSES = ((90, 1800), (75, 900), (50, 300))
THROTTLE_CODES = frozenset({4, 17, 32, 613} | set(range(80000, 80015)))
LADDER = (300, 1800, 7200, 21600)  # 5m, 30m, 2h, 6h
STRIKE_DECAY_SEC = 12 * 3600  # longer than the top step, so the ladder holds there
AUTH_CODES = frozenset({190, 102})
AUTH_BLOCK_SEC = 1800
ACQUIRE_TIMEOUT_SEC = 30.0

META_HOSTS = frozenset({"graph.facebook.com", "graph-video.facebook.com", "graph.instagram.com"})

# Indirection so tests can drive a fake clock.
_now = time.time
_sleep = time.sleep


def cap() -> int:
    try:
        v = int(os.environ.get("ODYLIC_META_MAX_PER_HOUR", DEFAULT_CAP))
    except ValueError:
        v = DEFAULT_CAP
    return max(1, min(v, 2000))


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class MetaThrottled(RuntimeError):
    """The governor is paused or out of budget. Try later, never right away."""

    def __init__(self, reason: str, until: Optional[float] = None):
        super().__init__(reason)
        self.reason = reason
        self.until = until


class MetaAuthError(RuntimeError):
    """Meta rejected the token. Needs a new token, never a retry loop."""


class MetaWriteBlocked(PermissionError):
    """A non-GET call to Meta. This app is read only."""


# ---------------------------------------------------------------------------
# Token hygiene
# ---------------------------------------------------------------------------
_TOKEN_PATTERNS = (
    (re.compile(r"(access_token|input_token|client_secret)=[^&\s\"'<>]+", re.I), r"\1=REDACTED"),
    (re.compile(r"(OAuth|Bearer)\s+[A-Za-z0-9._\-|]{12,}", re.I), r"\1 REDACTED"),
    (re.compile(r"\bEA[A-Za-z0-9]{20,}"), "REDACTED"),
)


def scrub(text) -> str:
    """Remove anything that looks like a Meta token from text bound for a log,
    an error message or an API response."""
    s = str(text)
    for pat, rep in _TOKEN_PATTERNS:
        s = pat.sub(rep, s)
    return s


def token_fingerprint(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def _log(msg: str) -> None:
    print(f"[governor] {scrub(msg)}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Cross-process state
# ---------------------------------------------------------------------------
def _state_path() -> Path:
    return store.data_dir() / "governor_state.json"


def _lock_path() -> Path:
    return store.data_dir() / "governor.lock"


_thread_lock = threading.RLock()


@contextmanager
def _locked():
    """Thread lock plus an fcntl lock file shared by every process."""
    with _thread_lock:
        try:
            import fcntl
            fh = open(_lock_path(), "a")
            fcntl.flock(fh, fcntl.LOCK_EX)
        except (OSError, ImportError) as e:
            raise MetaThrottled(f"Rate governor lock unavailable ({e}); Meta calls are refused for safety.") from e
        try:
            yield
        finally:
            try:
                fcntl.flock(fh, fcntl.LOCK_UN)
                fh.close()
            except Exception:
                pass


def _read_state() -> dict:
    p = _state_path()
    try:
        raw = p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as e:
        raise MetaThrottled(f"Rate governor state unreadable ({e}); Meta calls are refused for safety.") from e
    try:
        s = json.loads(raw) if raw.strip() else {}
        if not isinstance(s, dict):
            raise ValueError("not an object")
        return s
    except ValueError:
        now = _now()
        try:
            os.replace(p, p.with_name(f"{p.name}.corrupt-{int(now)}"))
        except OSError:
            pass
        _log("state file was corrupt; moved aside and restarted with a one minute pause")
        fresh = {"paused_until": now + 60, "pause_reason": "Rate governor state was reset; waiting one minute."}
        _write_state(fresh)
        return fresh


def _write_state(s: dict) -> bool:
    p = _state_path()
    try:
        tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(s), encoding="utf-8")
        os.replace(tmp, p)
        return True
    except Exception as e:
        _log(f"could not save state: {e}")
        return False


def _prune(s: dict, now: float) -> list:
    calls = [float(t) for t in (s.get("calls") or []) if now - float(t) < WINDOW_SEC and float(t) <= now + 1]
    s["calls"] = calls
    auth = {k: v for k, v in (s.get("auth_blocked") or {}).items() if float(v) > now}
    s["auth_blocked"] = auth
    return calls


def _interval(s: dict) -> float:
    """Spacing grows with Meta's reported usage: 1s at 0%, about 3s near 50%."""
    try:
        pct = float(s.get("last_usage_pct", 0) or 0)
    except (TypeError, ValueError):
        pct = 0.0
    pct = max(0.0, min(pct, USAGE_BACKOFF_PCT))
    return MIN_INTERVAL_SEC * (1.0 + pct / 25.0)


def _iso(ts: Optional[float]) -> Optional[str]:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


iso = _iso


# ---------------------------------------------------------------------------
# Public controls
# ---------------------------------------------------------------------------
def acquire(token_fp: Optional[str] = None, timeout: float = ACQUIRE_TIMEOUT_SEC) -> None:
    """Reserve one call slot or raise. Waits only for call spacing (seconds);
    a pause or a spent budget raises MetaThrottled right away."""
    deadline = _now() + timeout
    while True:
        with _locked():
            s = _read_state()
            now = _now()
            calls = _prune(s, now)

            until = max(float(s.get("paused_until", 0) or 0), float(s.get("hard_until", 0) or 0))
            if now < until:
                hard = float(s.get("hard_until", 0) or 0) >= float(s.get("paused_until", 0) or 0)
                reason = (s.get("hard_reason") if hard else s.get("pause_reason")) or "Meta calls are paused."
                raise MetaThrottled(reason, until)

            if token_fp and float((s.get("auth_blocked") or {}).get(token_fp, 0) or 0) > now:
                raise MetaAuthError("Meta rejected this access token recently. Connect again with a new token.")

            limit = cap()
            if len(calls) >= limit:
                until = min(calls) + WINDOW_SEC
                raise MetaThrottled(
                    f"Hourly safety budget of {limit} Meta calls is used up; it frees up as the hour rolls.",
                    until,
                )

            last = float(s.get("last_call", 0) or 0)
            if last > now + 1:
                last = 0.0  # clock stepped back
            wait = last + _interval(s) - now
            if wait <= 0:
                calls.append(now)
                s["calls"] = calls
                s["last_call"] = now
                if not _write_state(s):
                    raise MetaThrottled("Rate governor could not save its state (disk full or read only?); "
                                        "Meta calls are refused for safety.")
                return
        if _now() + wait > deadline:
            raise MetaThrottled("Waited too long for a Meta call slot.", _now() + wait)
        _sleep(min(max(wait, 0.01), 5.0))


def pause(seconds: float, reason: str, hard: bool = False) -> None:
    """Pause every Meta call. hard=True marks a wait Meta asked for."""
    now = _now()
    until = now + float(seconds)
    with _locked():
        s = _read_state()
        _prune(s, now)
        fu, fr = ("hard_until", "hard_reason") if hard else ("paused_until", "pause_reason")
        if until > float(s.get(fu, 0) or 0):
            s[fu], s[fr] = until, reason
        _write_state(s)
    _log(f"paused {int(seconds)}s: {reason}")


def _block_token(token_fp: Optional[str]) -> None:
    if not token_fp:
        return
    now = _now()
    with _locked():
        s = _read_state()
        _prune(s, now)
        s.setdefault("auth_blocked", {})[token_fp] = now + AUTH_BLOCK_SEC
        _write_state(s)


def unblock_token(token_fp: Optional[str]) -> None:
    """Drop a local auth block (used when a token is explicitly replaced)."""
    if not token_fp:
        return
    try:
        with _locked():
            s = _read_state()
            (s.get("auth_blocked") or {}).pop(token_fp, None)
            _write_state(s)
    except MetaThrottled:
        pass


def status() -> dict:
    """The /api/governor object."""
    try:
        with _locked():
            s = _read_state()
            now = _now()
            calls = _prune(s, now)
    except MetaThrottled as e:
        return {"calls_last_hour": 0, "cap": cap(), "paused_until": None, "reason": e.reason}
    limit = cap()
    until = max(float(s.get("paused_until", 0) or 0), float(s.get("hard_until", 0) or 0))
    reason = None
    paused_until = None
    if now < until:
        hard = float(s.get("hard_until", 0) or 0) >= float(s.get("paused_until", 0) or 0)
        reason = (s.get("hard_reason") if hard else s.get("pause_reason")) or "Meta calls are paused."
        paused_until = _iso(until)
    elif len(calls) >= limit:
        paused_until = _iso(min(calls) + WINDOW_SEC)
        reason = f"Hourly safety budget of {limit} Meta calls is used up."
    return {"calls_last_hour": len(calls), "cap": limit, "paused_until": paused_until, "reason": reason}


def paused_until_iso() -> Optional[str]:
    return status().get("paused_until")


def slots_free_at(n: int) -> Optional[float]:
    """When `n` calls could all start: None if they could start now (no pause
    and at least n slots left in the rolling hour), else the timestamp when
    they could. A pull that needs n calls waits for this instead of starting,
    spending the one slot that frees up and failing on the next call."""
    try:
        with _locked():
            s = _read_state()
            now = _now()
            calls = sorted(_prune(s, now))
    except MetaThrottled as e:
        return e.until or (_now() + 60)
    limit = cap()
    n = max(1, min(int(n), limit))
    t = now
    until = max(float(s.get("paused_until", 0) or 0), float(s.get("hard_until", 0) or 0))
    if until > t:
        t = until
    must_expire = len(calls) - (limit - n)
    if must_expire > 0:
        t = max(t, calls[must_expire - 1] + WINDOW_SEC)
    return None if t <= now else t


# ---------------------------------------------------------------------------
# Reading Meta's signals
# ---------------------------------------------------------------------------
def _usage_values(e: dict) -> list:
    out = []
    for f in ("call_count", "total_cputime", "total_time", "acc_id_util_pct", "app_id_util_pct"):
        try:
            out.append(float(e.get(f, 0) or 0))
        except (TypeError, ValueError):
            pass
    return out


def _header_json(headers, key: str):
    try:
        raw = headers.get(key)
    except Exception:
        return None
    if not raw:
        return None
    try:
        blob = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return blob if isinstance(blob, dict) else None


def observe_headers(headers) -> None:
    """React to Meta's usage headers. Never raises."""
    try:
        worst = 0.0
        regain_min = 0
        buc = _header_json(headers, "x-business-use-case-usage") or {}
        for v in buc.values():
            for e in (v if isinstance(v, list) else [v]):
                if not isinstance(e, dict):
                    continue
                vals = _usage_values(e)
                if vals:
                    worst = max(worst, max(vals))
                try:
                    regain_min = max(regain_min, int(e.get("estimated_time_to_regain_access", 0) or 0))
                except (TypeError, ValueError):
                    pass
        for key in ("x-ad-account-usage", "x-fb-ads-insights-throttle", "x-app-usage"):
            blob = _header_json(headers, key)
            if blob:
                vals = _usage_values(blob)
                if vals:
                    worst = max(worst, max(vals))
                try:
                    regain_min = max(regain_min, int(blob.get("estimated_time_to_regain_access", 0) or 0))
                except (TypeError, ValueError):
                    pass
        if not buc and worst == 0 and regain_min == 0:
            return
        with _locked():
            s = _read_state()
            s["last_usage_pct"] = round(worst, 2)
            _write_state(s)
        if regain_min > 0:
            pause(regain_min * 60, f"Meta asked for a {regain_min} minute cooldown.", hard=True)
            return
        for line, secs in USAGE_PAUSES:
            if worst >= line:
                pause(secs, f"Meta reports {worst:.0f}% API usage; pausing {secs // 60} min to stay well clear of its limit.")
                break
    except MetaThrottled:
        pass
    except Exception as e:  # governance must never break a working request
        _log(f"header check failed: {e}")


def _regain_seconds(err: dict) -> int:
    try:
        mins = int((err.get("error_data") or {}).get("estimated_time_to_regain_access", 0) or 0)
        return mins * 60 if mins > 0 else 0
    except (TypeError, ValueError, AttributeError):
        return 0


def note_throttle(code: int, message: str, regain_sec: int = 0) -> None:
    """Escalating breaker for a throttle error."""
    now = _now()
    with _locked():
        s = _read_state()
        _prune(s, now)
        if now - float(s.get("last_strike", 0) or 0) > STRIKE_DECAY_SEC:
            s["strikes"] = 0
        strikes = int(s.get("strikes", 0) or 0) + 1
        s["strikes"] = strikes
        s["last_strike"] = now
        _write_state(s)
    if regain_sec > 0:
        pause(regain_sec, f"Meta rate limit (code {code}); Meta asked for {regain_sec // 60} min.", hard=True)
    else:
        secs = LADDER[min(strikes - 1, len(LADDER) - 1)]
        label = f"{secs // 3600} h" if secs >= 3600 else f"{secs // 60} min"
        pause(secs, f"Meta rate limit (code {code}, strike {strikes}); pausing {label}. {scrub(message)[:120]}")


def observe_error_body(body, token_fp: Optional[str]) -> None:
    """Feed a Graph error body to the breaker. Never raises."""
    try:
        err = body.get("error") if isinstance(body, dict) else None
        if not isinstance(err, dict):
            return
        code = int(err.get("code", 0) or 0)
        if code in THROTTLE_CODES:
            note_throttle(code, str(err.get("message", "")), _regain_seconds(err))
        elif code in AUTH_CODES:
            _block_token(token_fp)
    except MetaThrottled:
        pass
    except Exception as e:
        _log(f"error check failed: {e}")


# ---------------------------------------------------------------------------
# The chokepoint
# ---------------------------------------------------------------------------
_INSTALLED = False
_install_lock = threading.Lock()
# The unwrapped transport, looked up at call time (tests swap in a fake).
_originals: dict = {}


def is_meta_url(url) -> bool:
    try:
        host = (urlsplit(str(url)).hostname or "").lower()
    except Exception:
        return False
    return host in META_HOSTS or (host.startswith("graph") and host.endswith(".facebook.com"))


def check_write(method: str, url) -> None:
    if str(method).upper() != "GET":
        raise MetaWriteBlocked(
            f"Blocked a {str(method).upper()} to Meta ({scrub(str(url).split('?', 1)[0])[:80]}). "
            "This app only reads from Meta."
        )


def _token_to_header(url, kwargs):
    """Move access_token out of the URL / params / form body into an
    Authorization header, so it can not leak through exception text or logs."""
    token = None
    params = kwargs.get("params")
    if isinstance(params, dict) and "access_token" in params:
        params = dict(params)
        token = params.pop("access_token")
        kwargs["params"] = params
    elif isinstance(params, (list, tuple)):
        kept = []
        for kv in params:
            if isinstance(kv, (list, tuple)) and len(kv) == 2 and kv[0] == "access_token":
                token = token or kv[1]
            else:
                kept.append(kv)
        kwargs["params"] = kept
    u = urlsplit(str(url))
    if "access_token=" in u.query:
        q = parse_qsl(u.query, keep_blank_values=True)
        token = token or next((v for k, v in q if k == "access_token"), None)
        url = urlunsplit(u._replace(query=urlencode([(k, v) for k, v in q if k != "access_token"])))
    if token:
        headers = dict(kwargs.get("headers") or {})
        if not any(str(k).lower() == "authorization" for k in headers):
            headers["Authorization"] = f"OAuth {token}"
        kwargs["headers"] = headers
    return url, kwargs


def _strip_prepared_token(request) -> None:
    try:
        u = urlsplit(request.url)
        if "access_token=" not in u.query:
            return
        q = parse_qsl(u.query, keep_blank_values=True)
        token = next((v for k, v in q if k == "access_token"), None)
        request.url = urlunsplit(u._replace(query=urlencode([(k, v) for k, v in q if k != "access_token"])))
        if token and not any(k.lower() == "authorization" for k in request.headers):
            request.headers["Authorization"] = f"OAuth {token}"
    except Exception:
        pass


def _request_token_fp(request) -> Optional[str]:
    try:
        auth = request.headers.get("Authorization") or ""
    except Exception:
        return None
    bits = auth.split(None, 1)
    return token_fingerprint(bits[1].strip()) if len(bits) == 2 else None


def _observe_response(resp, token_fp: Optional[str], stream: bool) -> None:
    try:
        observe_headers(resp.headers)
        if stream:
            return
        ctype = resp.headers.get("Content-Type") or ""
        if "json" not in ctype and "javascript" not in ctype and resp.status_code < 400:
            return
        try:
            body = resp.json()
        except ValueError:
            return
        observe_error_body(body, token_fp)
    except Exception:
        pass


def install() -> None:
    """Route every Meta Graph request made through `requests` via the governor."""
    global _INSTALLED
    with _install_lock:
        if _INSTALLED:
            return
        import requests.adapters as _adapters
        import requests.sessions as _sessions

        _originals["request"] = _sessions.Session.request
        _originals["send"] = _adapters.HTTPAdapter.send

        def guarded_request(self, method, url, *args, **kwargs):
            if not is_meta_url(url):
                return _originals["request"](self, method, url, *args, **kwargs)
            check_write(method, url)
            url, kwargs = _token_to_header(url, kwargs)
            return _originals["request"](self, method, url, *args, **kwargs)

        def guarded_send(self, request, *args, **kwargs):
            if not is_meta_url(request.url):
                return _originals["send"](self, request, *args, **kwargs)
            check_write(request.method, request.url)
            _strip_prepared_token(request)
            fp = _request_token_fp(request)
            acquire(token_fp=fp)
            resp = _originals["send"](self, request, *args, **kwargs)
            _observe_response(resp, fp, bool(kwargs.get("stream")))
            return resp

        _sessions.Session.request = guarded_request
        _adapters.HTTPAdapter.send = guarded_send
        _INSTALLED = True
