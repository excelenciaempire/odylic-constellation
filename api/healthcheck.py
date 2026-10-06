"""Who is answering on the app's port? Used by the launchers (start.sh, the
generated app launcher, install.sh), never by the server itself.

    .venv/bin/python -m api.healthcheck http://127.0.0.1:8777 [--stop-stale | --stop-ours]

Prints one word:
    ours      this install's server, running the code on disk
    stale     this install's server, running an older build
    foreign   something else answers on the port (or a server we can not verify)
    down      nothing answers
    stopped   (with --stop-stale or --stop-ours) our server was running and is now stopped

"Ours" is proven, not assumed: the server answers a random challenge with an
HMAC keyed by this install's secret (DATA_DIR/install_secret, mode 0600), which
another program on the port, or another user's server, can not produce. A
server is only ever stopped when it proves it is ours, or when it is an older
build of this app running from this very folder.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from . import build_id, store

APP_ID = "odylic-constellation"
APP_DIR = Path(__file__).resolve().parent.parent


def probe(url: str, timeout: float = 2.0) -> tuple:
    """(state, body): state is ours, stale, legacy, foreign or down."""
    challenge = secrets.token_hex(16)
    try:
        with urllib.request.urlopen(f"{url.rstrip('/')}/api/health?c={challenge}", timeout=timeout) as r:
            body = json.loads(r.read(65536).decode("utf-8"))
    except urllib.error.HTTPError:
        return "foreign", None
    except urllib.error.URLError as e:
        refused = isinstance(e.reason, ConnectionRefusedError) or "refused" in str(e.reason).lower()
        return ("down" if refused else "foreign"), None
    except ConnectionRefusedError:
        return "down", None
    except (OSError, ValueError):
        return "foreign", None
    if not isinstance(body, dict) or body.get("ok") is not True:
        return "foreign", body
    if body.get("app") != APP_ID:
        # A build from before the identity check: only a process check can tell.
        return ("legacy" if "version" in body and "app" not in body else "foreign"), body
    expected = hmac.new(store.install_secret(), challenge.encode("utf-8"), hashlib.sha256).hexdigest()
    if not isinstance(body.get("proof"), str) or not hmac.compare_digest(body["proof"], expected):
        return "foreign", body
    return ("ours" if body.get("build") == build_id() else "stale"), body


def _run(args: list) -> str:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=5, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def listening_pid(port: int) -> Optional[int]:
    out = _run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"]).split()
    return int(out[0]) if out and out[0].isdigit() else None


def runs_from_here(pid: int) -> bool:
    """The process is this app's uvicorn, started from this install's folder."""
    if "api.main:app" not in _run(["ps", "-o", "command=", "-p", str(pid)]):
        return False
    for line in _run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"]).splitlines():
        if line.startswith("n"):
            try:
                return Path(line[1:]).resolve() == APP_DIR
            except OSError:
                return False
    return False


def stop(url: str, state: str) -> bool:
    port = urlsplit(url).port or 80
    pid = listening_pid(port)
    if not pid:
        return False
    # A proven server of ours may be stopped; an unproven older one only when
    # it runs from this folder.
    if state != "ours" and state != "stale" and not runs_from_here(pid):
        return False
    if state in ("ours", "stale") and "api.main:app" not in _run(["ps", "-o", "command=", "-p", str(pid)]):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    for _ in range(50):
        time.sleep(0.1)
        if listening_pid(port) != pid:
            return True
    return False


def main(argv: list) -> int:
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    url = argv[0]
    state, _ = probe(url)
    if "--stop-ours" in argv and state in ("ours", "stale", "legacy"):
        state = "stopped" if stop(url, state) else state
    elif "--stop-stale" in argv and state in ("stale", "legacy"):
        state = "stopped" if stop(url, state) else state
    if state == "legacy":
        state = "foreign"
    print(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
