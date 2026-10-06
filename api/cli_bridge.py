"""Bridge to the official Meta Ads CLI (`pip install meta-ads`, binary `meta`).

The CLI authenticates only through two environment variables, ACCESS_TOKEN and
AD_ACCOUNT_ID, which it also reads from a .env file via python-dotenv. We look
for those credentials the same way (process env, ./.env, ~/.env), then check
the token and do every data pull with our own governed Graph client. The `meta`
binary itself is never run: its Graph calls would happen in another process,
out of the rate governor's sight (no pacing by Meta's usage headers, no strike
on a throttle, no block on a dead token).

Credentials are never logged or returned; only whether they exist.
"""
from __future__ import annotations

import glob
import os
import shutil
from pathlib import Path
from typing import Optional

from dotenv import dotenv_values


def _candidate_paths(home: Path) -> list:
    pats = [
        str(home / ".local" / "bin" / "meta"),
        str(home / ".local" / "pipx" / "venvs" / "meta-ads" / "bin" / "meta"),
        "/opt/homebrew/bin/meta",
        "/usr/local/bin/meta",
        str(home / "Library" / "Python" / "3.*" / "bin" / "meta"),
        "/Library/Frameworks/Python.framework/Versions/3.*/bin/meta",
        "/opt/homebrew/opt/python@3.*/bin/meta",
    ]
    out = []
    for p in pats:
        out.extend(sorted(glob.glob(p), reverse=True) if "*" in p else [p])
    return out


def find_binary(home: Optional[Path] = None) -> Optional[str]:
    """Path to the `meta` CLI, or None. PATH first, then common install dirs
    (pipx, Homebrew, pip --user), because a Finder-launched app has a bare PATH."""
    found = shutil.which("meta")
    if found:
        return found
    for p in _candidate_paths(home or Path.home()):
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _clean(v) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip().strip('"').strip("'").strip()
    return s or None


def normalize_account(raw: Optional[str]) -> Optional[str]:
    s = _clean(raw)
    if not s:
        return None
    if s.startswith("act_"):
        s = s[4:]
    return f"act_{s}" if s.isdigit() else None


def discover_credentials(environ: Optional[dict] = None, cwd: Optional[Path] = None,
                         home: Optional[Path] = None) -> dict:
    """{"token": str|None, "account_id": "act_..."|None, "token_source": str|None}.

    Each key resolves on its own, in the order the CLI itself would see it:
    process environment, then ./.env, then ~/.env."""
    environ = os.environ if environ is None else environ
    cwd = Path.cwd() if cwd is None else Path(cwd)
    home = Path.home() if home is None else Path(home)

    sources = [("environment", dict(environ))]
    seen = set()
    for label, path in (("./.env", cwd / ".env"), ("~/.env", home / ".env")):
        try:
            rp = path.resolve()
        except OSError:
            continue
        if rp in seen or not path.is_file():
            continue
        seen.add(rp)
        try:
            sources.append((label, dict(dotenv_values(path))))
        except Exception:
            continue

    token = account = token_source = None
    for label, vals in sources:
        if token is None and _clean(vals.get("ACCESS_TOKEN")):
            token, token_source = _clean(vals.get("ACCESS_TOKEN")), label
        if account is None and _clean(vals.get("AD_ACCOUNT_ID")):
            account = normalize_account(vals.get("AD_ACCOUNT_ID"))
    return {"token": token, "account_id": account, "token_source": token_source}


def summary() -> dict:
    """The /api/status `cli` block. Cheap: no subprocess, no network."""
    binary = find_binary()
    creds = discover_credentials()
    return {
        "installed": bool(binary),
        "path": binary,
        "has_credentials": bool(creds["token"]),
        "default_account": creds["account_id"],
    }
