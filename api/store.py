"""Local config, token and cache store.

Everything lives in DATA_DIR:
  macOS:  ~/Library/Application Support/Odylic Constellation
  other:  ~/.odylic-constellation
ODYLIC_FUNNEL_DATA_DIR overrides it (tests, portable installs).

config.json holds the access token, so it is written with mode 0600 and the
directory with 0700. The token never leaves this module except to the Graph
client; nothing here logs or returns it.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional

_LOCK = threading.RLock()

CONFIG_KEYS = ("token", "mode", "account", "accounts", "consent")


def data_dir() -> Path:
    """Resolved on every call so tests can point it at a temp dir."""
    override = os.environ.get("ODYLIC_FUNNEL_DATA_DIR")
    if override:
        d = Path(override).expanduser()
    elif sys.platform == "darwin":
        d = Path.home() / "Library" / "Application Support" / "Odylic Constellation"
    else:
        d = Path.home() / ".odylic-constellation"
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


def config_path() -> Path:
    return data_dir() / "config.json"


def cache_dir() -> Path:
    d = data_dir() / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def thumbs_dir() -> Path:
    d = data_dir() / "thumbs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def load_config() -> dict:
    with _LOCK:
        p = config_path()
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            cfg = raw if isinstance(raw, dict) else {}
        except FileNotFoundError:
            cfg = {}
        except (OSError, ValueError):
            cfg = {}
        try:
            if p.exists() and (p.stat().st_mode & 0o077):
                os.chmod(p, 0o600)
        except OSError:
            pass
        return {k: cfg.get(k) for k in CONFIG_KEYS}


def save_config(cfg: dict) -> None:
    with _LOCK:
        clean = {k: cfg.get(k) for k in CONFIG_KEYS}
        _atomic_write(config_path(), json.dumps(clean, indent=2), 0o600)


def update_config(**changes: Any) -> dict:
    with _LOCK:
        cfg = load_config()
        cfg.update({k: v for k, v in changes.items() if k in CONFIG_KEYS})
        save_config(cfg)
        return cfg


def get_token() -> Optional[str]:
    tok = load_config().get("token")
    return tok if isinstance(tok, str) and tok else None


def clear_connection() -> None:
    """Wipe token, mode, account and every cache. Consent is kept."""
    with _LOCK:
        cfg = load_config()
        save_config({"consent": bool(cfg.get("consent"))})
        clear_caches()


def clear_caches() -> None:
    with _LOCK:
        for d in (data_dir() / "cache", data_dir() / "thumbs"):
            shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------
# JSON disk cache
# ---------------------------------------------------------------------------
def _cache_file(bucket: str, key: str) -> Path:
    d = cache_dir() / bucket
    d.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    return d / f"{h}.json"


def cache_get(bucket: str, key: str, ttl: Optional[float]) -> Optional[dict]:
    """Return the cached value, or None when missing or older than ttl.
    ttl=None ignores age (used to serve stale data while Meta is paused)."""
    p = _cache_file(bucket, key)
    try:
        blob = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(blob, dict) or blob.get("key") != key:
        return None
    if ttl is not None and time.time() - float(blob.get("saved_at", 0)) > ttl:
        return None
    return blob.get("value")


def cache_put(bucket: str, key: str, value: Any) -> None:
    p = _cache_file(bucket, key)
    _atomic_write(p, json.dumps({"key": key, "saved_at": time.time(), "value": value}), 0o600)


def cache_delete(bucket: str, key: str) -> None:
    try:
        _cache_file(bucket, key).unlink()
    except OSError:
        pass


def clear_bucket(bucket: str) -> None:
    shutil.rmtree(cache_dir() / bucket, ignore_errors=True)


# ---------------------------------------------------------------------------
# Ad nodes (name, status, creative) by ad id, one file per account. These do
# not depend on the date range, so a range change or a new day only fetches
# the ads not seen in the last ADS_TTL. Entries: {ad_id: [saved_at, node]}.
# ---------------------------------------------------------------------------
def _fresh_nodes(blob, ttl: float, now: float) -> dict:
    out = {}
    if isinstance(blob, dict):
        for k, v in blob.items():
            if (isinstance(v, list) and len(v) == 2 and isinstance(v[1], dict)
                    and now - float(v[0] or 0) <= ttl):
                out[k] = v
    return out


def nodes_get(account: str, ids, ttl: float) -> dict:
    with _LOCK:
        blob = _fresh_nodes(cache_get("nodes", account, None), ttl, time.time())
    return {i: blob[i][1] for i in ids if i in blob}


def nodes_put(account: str, nodes: dict, ttl: float) -> None:
    if not nodes:
        return
    with _LOCK:
        now = time.time()
        blob = _fresh_nodes(cache_get("nodes", account, None), ttl, now)
        for k, n in nodes.items():
            if isinstance(n, dict):
                blob[str(k)] = [now, n]
        cache_put("nodes", account, blob)


# ---------------------------------------------------------------------------
# Disk prune. Date presets roll with the calendar, so yesterday's cache files
# are never read again, and thumbnails pile up as ads come and go. At startup
# and at most once an hour after that: cache files older than CACHE_MAX_AGE,
# thumbnails not served for THUMB_MAX_AGE, then the oldest thumbnails past
# THUMBS_MAX_BYTES, and ad index entries not seen for INDEX_MAX_AGE.
# ---------------------------------------------------------------------------
CACHE_MAX_AGE = 7 * 86400
THUMB_MAX_AGE = 60 * 86400
THUMBS_MAX_BYTES = 300 * 1024 * 1024
INDEX_MAX_AGE = 60 * 86400
INDEX_MAX_ENTRIES = 20000
PRUNE_EVERY_SEC = 3600
_last_prune = 0.0
_prune_lock = threading.Lock()


def maybe_prune(force: bool = False) -> None:
    global _last_prune
    now = time.time()
    if not force and now - _last_prune < PRUNE_EVERY_SEC:
        return
    if not _prune_lock.acquire(blocking=False):
        return
    try:
        _last_prune = now
        _prune(now)
    except Exception as e:  # housekeeping must never break a request
        print(f"[store] prune failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
    finally:
        _prune_lock.release()


def _prune(now: float) -> None:
    base = data_dir() / "cache"
    if base.is_dir():
        for bucket in base.iterdir():
            if not bucket.is_dir():
                continue
            for f in bucket.glob("*.json"):
                try:
                    if now - f.stat().st_mtime > CACHE_MAX_AGE:
                        f.unlink()
                except OSError:
                    pass
    tdir = data_dir() / "thumbs"
    if tdir.is_dir():
        files = []
        for f in tdir.iterdir():
            try:
                st = f.stat()
            except OSError:
                continue
            if not f.is_file():
                continue
            if now - st.st_mtime > (3600 if f.name.startswith(".") else THUMB_MAX_AGE):
                try:
                    f.unlink()
                except OSError:
                    pass
                continue
            files.append((st.st_mtime, st.st_size, f))
        total = sum(sz for _, sz, _ in files)
        for _, sz, f in sorted(files, key=lambda x: x[0]):
            if total <= THUMBS_MAX_BYTES:
                break
            try:
                f.unlink()
                total -= sz
            except OSError:
                pass
    with _LOCK:
        idx = load_index()
        keep = {k: v for k, v in idx.items()
                if isinstance(v, dict) and now - float(v.get("seen_at") or now) <= INDEX_MAX_AGE}
        if len(keep) > INDEX_MAX_ENTRIES:
            ranked = sorted(keep.items(), key=lambda kv: float(kv[1].get("seen_at") or 0), reverse=True)
            keep = dict(ranked[:INDEX_MAX_ENTRIES])
        if len(keep) != len(idx):
            _atomic_write(_index_path(), json.dumps(keep), 0o600)


# ---------------------------------------------------------------------------
# Install secret: lets the launchers tell this install's server apart from
# anything else listening on the port (see /api/health). Never returned.
# ---------------------------------------------------------------------------
def _secret_path() -> Path:
    return data_dir() / "install_secret"


def install_secret() -> bytes:
    with _LOCK:
        p = _secret_path()
        try:
            raw = p.read_text(encoding="utf-8").strip()
            if len(raw) >= 32:
                return raw.encode("utf-8")
        except OSError:
            pass
        raw = secrets.token_hex(32)
        _atomic_write(p, raw, 0o600)
        return raw.encode("utf-8")


def install_proof(challenge: str) -> str:
    return hmac.new(install_secret(), challenge.encode("utf-8"), hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------
# Per-ad index: where each ad's thumbnail and posts live. Filled by every
# ads pull, read by the thumb and comments routes so they skip a lookup call.
# ---------------------------------------------------------------------------
def _index_path() -> Path:
    return cache_dir() / "ad_index.json"


def load_index() -> dict:
    with _LOCK:
        try:
            raw = json.loads(_index_path().read_text(encoding="utf-8"))
            return raw if isinstance(raw, dict) else {}
        except (OSError, ValueError):
            return {}


def merge_index(entries: dict) -> None:
    with _LOCK:
        idx = load_index()
        now = round(time.time())
        idx.update({k: {**v, "seen_at": now} for k, v in entries.items() if isinstance(v, dict)})
        _atomic_write(_index_path(), json.dumps(idx), 0o600)
