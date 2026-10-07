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
import ipaddress
import json
import os
import secrets
import shlex
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
from .platform_support import windows_listener_pids, windows_process_details

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
        if sys.platform == "win32" and isinstance(e.reason, TimeoutError):
            endpoint = urlsplit(url)
            try:
                local = endpoint.hostname == "localhost" or ipaddress.ip_address(endpoint.hostname).is_loopback
            except ValueError:
                local = False
            # Windows may time out before reporting WSAECONNREFUSED on an empty
            # loopback port. An actual listener (even ambiguous) remains foreign.
            if local:
                owners = _windows_listener_pids(endpoint.port or 80)
                refused = owners is not None and not owners
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
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        timeout = 15 if sys.platform == "win32" else 5
        return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, check=False,
                              stdin=subprocess.DEVNULL, creationflags=flags).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _windows_listener_pids(port: int) -> Optional[set[int]]:
    native = windows_listener_pids(port)
    if native is not None:
        return native
    # netstat is shipped with Windows, including editions without PowerShell 7.
    # Match the local port exactly: 8777 must never match 18777.
    output = _run(["netstat.exe", "-ano", "-p", "tcp"])
    if not output.strip():  # A failed process inspection must not count as a free port.
        return None
    pids = set()
    for line in output.splitlines():
        cols = line.split()
        if (len(cols) == 5 and cols[0].upper() == "TCP" and
                cols[3].upper() == "LISTENING" and cols[4].isdigit()):
            try:
                if int(cols[1].rsplit(":", 1)[1]) == port:
                    pids.add(int(cols[4]))
            except (ValueError, IndexError):
                continue
    return pids


def listening_pid(port: int) -> Optional[int]:
    if sys.platform == "win32":
        pids = _windows_listener_pids(port)
        # An ambiguous bind is refused rather than guessing which process owns it.
        if pids is None:
            return None
        return next(iter(pids)) if len(pids) == 1 else None
    out = _run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"]).split()
    return int(out[0]) if out and out[0].isdigit() else None


def process_command(pid: int) -> str:
    if sys.platform == "win32":
        native = windows_process_details(pid)
        if native.get("command"):
            return native["command"]
        return _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                     "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
                     f"(Get-CimInstance Win32_Process -Filter 'ProcessId = {int(pid)}').CommandLine"]).strip()
    return _run(["ps", "-o", "command=", "-p", str(pid)])


def _windows_parent_command(pid: int) -> str:
    native = windows_process_details(pid)
    if native.get("parent_pid"):
        parent = windows_process_details(native["parent_pid"])
        if parent.get("command"):
            return parent["command"]
    return _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                 "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
                 f"$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {int(pid)}'; "
                 "if ($p) { (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $p.ParentProcessId)).CommandLine }"]).strip()


def _windows_arguments(command: str) -> list[str]:
    try:
        return [arg.strip('"') for arg in shlex.split(command, posix=False)]
    except ValueError:
        return []


def _windows_executable_matches(args: list[str], executable: Path) -> bool:
    if not args:
        return False
    candidate = args[0].replace("/", "\\").casefold()
    expected = str(executable).replace("/", "\\").casefold()
    if candidate == expected:
        return True
    # uv-managed Python versions can use a directory junction (3.14 -> 3.14.4).
    # Resolve existing files before comparing, while still rejecting foreign paths.
    if os.name == "nt":
        try:
            return Path(args[0]).resolve(strict=True) == executable.resolve(strict=True)
        except OSError:
            return False
    return False


def _uvicorn_arguments(args: list[str]) -> bool:
    return any(args[i:i + 3] == ["-m", "uvicorn", "api.main:app"] for i in range(len(args) - 2))


def runs_from_here(pid: int) -> bool:
    """The process is this app's uvicorn, started from this install's folder."""
    command = process_command(pid)
    if sys.platform == "win32":
        args = _windows_arguments(command)
        image = windows_process_details(pid).get("executable")
        frozen = getattr(sys, "frozen", False)
        executable = Path(sys.executable).resolve() if frozen else APP_DIR / ".venv" / "Scripts" / "python.exe"
        if frozen:
            return (_windows_executable_matches(args, executable) and "--serve" in args[1:] and
                    (not image or _windows_executable_matches([image], executable)))
        if not _uvicorn_arguments(args):
            return False
        if _windows_executable_matches(args, executable):
            return not image or _windows_executable_matches([image], executable)
        # Windows venv executables are redirectors: netstat sees the base
        # interpreter child, while its parent is this install's venv launcher.
        # Verify both, so a different install using the same Python is refused.
        base = Path(getattr(sys, "_base_executable", sys.executable)).resolve()
        if not _windows_executable_matches(args, base):
            return False
        if image and not _windows_executable_matches([image], base):
            return False
        parent = _windows_arguments(_windows_parent_command(pid))
        return _windows_executable_matches(parent, executable) and _uvicorn_arguments(parent)
    if "api.main:app" not in command:
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
    if sys.platform == "win32" and not runs_from_here(pid):
        return False
    if sys.platform != "win32" and state in ("ours", "stale") and "api.main:app" not in process_command(pid):
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
