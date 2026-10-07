"""Windows process ownership, private storage, and real cross-process budgeting."""
import json
import os
import socket
import subprocess
import sys
import urllib.error
from pathlib import Path

import pytest

from api import healthcheck, platform_support, store


@pytest.mark.parametrize("owners, expected", [(set(), "down"), ({42}, "foreign"), ({42, 43}, "foreign"), (None, "foreign")])
def test_windows_loopback_timeout_checks_listener_ownership(monkeypatch, owners, expected):
    monkeypatch.setattr(healthcheck.sys, "platform", "win32")
    def timeout(*args, **kwargs):
        raise urllib.error.URLError(TimeoutError("timed out"))
    monkeypatch.setattr(healthcheck.urllib.request, "urlopen", timeout)
    monkeypatch.setattr(healthcheck, "_windows_listener_pids", lambda port: owners)
    assert healthcheck.probe("http://127.0.0.1:8777")[0] == expected
    # A remote timeout never turns into a claim that a local port is empty.
    assert healthcheck.probe("http://example.org:8777")[0] == "foreign"


def test_netstat_matches_exact_port_and_refuses_ambiguous_owners(monkeypatch):
    monkeypatch.setattr(healthcheck.sys, "platform", "win32")
    monkeypatch.setattr(healthcheck, "windows_listener_pids", lambda port: None)
    monkeypatch.setattr(healthcheck, "_run", lambda args: """
  TCP    0.0.0.0:18777    0.0.0.0:0     LISTENING  99
  TCP    127.0.0.1:8777   0.0.0.0:0     LISTENING  42
  TCP    [::1]:8777       [::]:0        LISTENING  42
  TCP    127.0.0.1:8777   127.0.0.1:55  ESTABLISHED 17
""")
    assert healthcheck.listening_pid(8777) == 42
    assert healthcheck.listening_pid(18777) == 99
    assert healthcheck.listening_pid(8778) is None
    monkeypatch.setattr(healthcheck, "_run", lambda args:
                        "TCP 127.0.0.1:8777 0.0.0.0:0 LISTENING 42\n"
                        "TCP [::1]:8777 [::]:0 LISTENING 43")
    assert healthcheck.listening_pid(8777) is None


@pytest.mark.parametrize("different_install, suffix, expected", [
    (False, '-m uvicorn api.main:app --port 8777', True),
    (True, '-m uvicorn api.main:app --port 8777', False),
    (False, '-c "print(\'api.main:app\')"', False),
    (False, '-m uvicorn api.main:app.evil', False),
])
def test_source_server_requires_this_installs_python(monkeypatch, different_install, suffix, expected):
    monkeypatch.setattr(healthcheck.sys, "platform", "win32")
    executable = healthcheck.APP_DIR / ".venv" / "Scripts" / "python.exe"
    if different_install:
        executable = Path("C:/other-install/.venv/Scripts/python.exe")
    monkeypatch.setattr(healthcheck, "process_command", lambda pid: f'"{executable}" {suffix}')
    assert healthcheck.runs_from_here(42) is expected


def test_frozen_server_requires_exact_executable_and_serve_flag(monkeypatch):
    monkeypatch.setattr(healthcheck.sys, "platform", "win32")
    monkeypatch.setattr(healthcheck.sys, "frozen", True, raising=False)
    monkeypatch.setattr(healthcheck, "process_command", lambda pid: f'"{sys.executable}" --serve --port 8777')
    assert healthcheck.runs_from_here(42)
    monkeypatch.setattr(healthcheck, "process_command", lambda pid: f'"{sys.executable}" --stop')
    assert not healthcheck.runs_from_here(42)
    monkeypatch.setattr(healthcheck, "process_command", lambda pid: '"C:/someone-else/Constellation.exe" --serve')
    assert not healthcheck.runs_from_here(42)


def test_frozen_server_refuses_a_spoofed_argv_executable(monkeypatch):
    monkeypatch.setattr(healthcheck.sys, "platform", "win32")
    monkeypatch.setattr(healthcheck.sys, "frozen", True, raising=False)
    monkeypatch.setattr(healthcheck, "process_command", lambda pid: f'"{sys.executable}" --serve')
    monkeypatch.setattr(healthcheck, "windows_process_details", lambda pid: {"executable": "C:/other-app.exe"})
    assert not healthcheck.runs_from_here(42)


def test_windows_venv_redirector_requires_exact_parent_install(monkeypatch):
    monkeypatch.setattr(healthcheck.sys, "platform", "win32")
    # Preserve any uv-managed directory junction in the actual command line.
    base = Path(getattr(sys, "_base_executable", sys.executable))
    python = healthcheck.APP_DIR / ".venv" / "Scripts" / "python.exe"
    monkeypatch.setattr(healthcheck, "process_command", lambda pid: f'"{base}" -m uvicorn api.main:app --port 8777')
    monkeypatch.setattr(healthcheck, "_windows_parent_command", lambda pid: f'"{python}" -m uvicorn api.main:app --port 8777')
    assert healthcheck.runs_from_here(42)
    monkeypatch.setattr(healthcheck, "_windows_parent_command", lambda pid: '"C:/another/.venv/Scripts/python.exe" -m uvicorn api.main:app')
    assert not healthcheck.runs_from_here(42)


def test_even_a_proven_server_cannot_stop_an_unrelated_process(monkeypatch):
    monkeypatch.setattr(healthcheck.sys, "platform", "win32")
    monkeypatch.setattr(healthcheck, "listening_pid", lambda port: 42)
    monkeypatch.setattr(healthcheck, "runs_from_here", lambda pid: False)
    killed = []
    monkeypatch.setattr(healthcheck.os, "kill", lambda pid, signal: killed.append(pid))
    assert healthcheck.stop("http://127.0.0.1:8777", "ours") is False
    assert killed == []


@pytest.mark.skipif(sys.platform != "win32", reason="Actual Windows ACL and lock checks")
def test_windows_storage_is_private_and_atomic(temp_data_dir):
    store.update_config(token="test-token", mode="token")
    store.update_config(token="updated-token")
    assert store.get_token() == "updated-token"
    assert not list(temp_data_dir.glob("*.tmp"))
    # Read the real DACL, rather than mistaking chmod's readonly bit for privacy.
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        "$acl = Get-Acl -LiteralPath $env:ODYLIC_TEST_ACL; "
        "[pscustomobject]@{Protected=$acl.AreAccessRulesProtected; "
        "Sids=@($acl.Access | ForEach-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value})} | ConvertTo-Json -Compress"],
        env={**os.environ, "ODYLIC_TEST_ACL": str(store.config_path())},
        capture_output=True, text=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    acl = json.loads(result.stdout)
    assert acl["Protected"] is True
    assert set(acl["Sids"]) == {platform_support._windows_user_sid(), "S-1-5-18"}


def test_rate_budget_is_shared_by_real_processes(temp_data_dir):
    # All processes compete for the same three slots, with pacing disabled only
    # in these isolated test children. Locking and on-disk accounting remain real.
    code = (
        "from api import governor\n"
        "governor.MIN_INTERVAL_SEC = 0\n"
        "try:\n"
        "    governor.acquire()\n"
        "except governor.MetaThrottled:\n"
        "    raise SystemExit(23)\n"
    )
    environment = {**os.environ, "ODYLIC_META_MAX_PER_HOUR": "3"}
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    children = [subprocess.Popen([sys.executable, "-c", code], env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags) for _ in range(6)]
    exits = []
    for child in children:
        output, error = child.communicate(timeout=30)
        assert child.returncode in (0, 23), (output, error)
        exits.append(child.returncode)
    assert exits.count(0) == 3
    assert exits.count(23) == 3
    state = json.loads((temp_data_dir / "governor_state.json").read_text(encoding="utf-8"))
    assert len(state["calls"]) == 3


@pytest.mark.skipif(sys.platform != "win32", reason="Actual native Windows process APIs")
def test_native_listener_and_command_details():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        assert platform_support.windows_listener_pids(port) == {os.getpid()}
    assert platform_support.windows_listener_pids(port) == set()
    info = platform_support.windows_process_details(os.getpid())
    assert Path(info["executable"]).resolve() == Path(sys.executable).resolve() or Path(info["executable"]).resolve() == Path(sys._base_executable).resolve()
    assert "pytest" in info["command"]
    assert info["parent_pid"] > 0
