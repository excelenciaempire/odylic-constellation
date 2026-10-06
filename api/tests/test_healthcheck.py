"""The launchers' identity check (api/healthcheck.py) against the real app,
a squatter and a closed port. No network: urlopen is routed in process."""
import io
import json
import urllib.error

import pytest
from fastapi.testclient import TestClient

from api import healthcheck, main
from api.tests.conftest import LOCAL


def _route(monkeypatch, handler):
    def fake_urlopen(url, timeout=None):
        return handler(url)
    monkeypatch.setattr(healthcheck.urllib.request, "urlopen", fake_urlopen)


def _ours(url):
    r = TestClient(main.app, base_url=LOCAL).get(url.split("8777", 1)[1])
    return io.BytesIO(r.content)


def test_this_install_is_recognized(monkeypatch):
    _route(monkeypatch, _ours)
    assert healthcheck.probe("http://127.0.0.1:8777")[0] == "ours"
    monkeypatch.setattr(healthcheck, "build_id", lambda: "something-newer")
    assert healthcheck.probe("http://127.0.0.1:8777")[0] == "stale"


@pytest.mark.parametrize("body", [
    {"ok": True, "app": "odylic-constellation", "version": "1.0.0", "build": "x", "proof": "0" * 64},
    {"ok": True, "app": "odylic-constellation", "version": "1.0.0", "build": "x"},
    {"ok": True},
    {"status": "fine"},
])
def test_a_squatter_is_foreign(monkeypatch, body):
    _route(monkeypatch, lambda url: io.BytesIO(json.dumps(body).encode()))
    assert healthcheck.probe("http://127.0.0.1:8777")[0] == "foreign"


def test_another_users_server_is_foreign(monkeypatch, tmp_path):
    _route(monkeypatch, _ours)
    state = {}

    def other_secret(url):
        # The app answers with its own secret; the launcher checks with a different one.
        out = _ours(url)
        monkeypatch.setenv("ODYLIC_FUNNEL_DATA_DIR", str(tmp_path / "someone-else"))
        state["swapped"] = True
        return out

    _route(monkeypatch, other_secret)
    assert healthcheck.probe("http://127.0.0.1:8777")[0] == "foreign" and state["swapped"]


def test_closed_port_and_errors(monkeypatch, capsys):
    def refused(url):
        raise urllib.error.URLError(ConnectionRefusedError(61, "Connection refused"))
    _route(monkeypatch, refused)
    assert healthcheck.probe("http://127.0.0.1:8777")[0] == "down"

    def http_error(url):
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
    _route(monkeypatch, http_error)
    assert healthcheck.probe("http://127.0.0.1:8777")[0] == "foreign"

    _route(monkeypatch, lambda url: io.BytesIO(json.dumps({"ok": True, "version": "0.9"}).encode()))
    assert healthcheck.probe("http://127.0.0.1:8777")[0] == "legacy"
    monkeypatch.setattr(healthcheck, "runs_from_here", lambda pid: False)
    monkeypatch.setattr(healthcheck, "listening_pid", lambda port: 4242)
    killed = []
    monkeypatch.setattr(healthcheck.os, "kill", lambda pid, sig: killed.append(pid))
    assert healthcheck.main(["http://127.0.0.1:8777", "--stop-stale"]) == 0
    assert capsys.readouterr().out.strip() == "foreign" and killed == []  # never kills what it can not verify
