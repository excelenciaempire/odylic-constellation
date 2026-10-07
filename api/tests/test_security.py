"""The local-only guard (Host, Origin, Sec-Fetch-Site, JSON-only writes), the
thumbnail host allowlist, the LAN refusal and the launcher identity proof.
No network."""
import hashlib
import hmac
import json
import os
import stat
import sys
import types

import pytest
from fastapi.testclient import TestClient

from api import build_id, main, store
from api.tests.conftest import LOCAL
from api.tests.test_routes import TOKEN, client  # noqa: F401  (fixture)


@pytest.fixture
def demo_client():
    return TestClient(main.app, base_url=LOCAL)


def _cfg(temp_data_dir):
    return json.loads((temp_data_dir / "config.json").read_text())


# ---------------------------------------------------------------------------
# Host header (DNS rebinding)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("host", ["attacker.example:8777", "rebind-attacker.test", "192.168.1.5:8777",
                                  "127.0.0.1.attacker.example", "localhost.attacker.example:8777", ""])
def test_foreign_host_is_refused_everywhere(demo_client, host):
    for method, path in (("GET", "/api/status"), ("GET", "/api/accounts"), ("GET", "/"),
                         ("GET", "/api/thumb/1"), ("POST", "/api/account")):
        r = demo_client.request(method, path, headers={"Host": host},
                                json={"account_id": "act_2"} if method == "POST" else None)
        assert r.status_code == 400 and r.json()["code"] == "bad_host", (method, path, host)


@pytest.mark.parametrize("host", ["127.0.0.1:8777", "localhost:5177", "localhost", "[::1]:8777", "LOCALHOST:5190"])
def test_loopback_hosts_are_served(demo_client, host):
    r = demo_client.get("/api/health", headers={"Host": host})
    assert r.status_code == 200 and r.json()["ok"] is True


def test_rebound_page_cannot_switch_the_account(client, temp_data_dir):  # noqa: F811
    client.post("/api/connect/token", json={"access_token": TOKEN})
    client.post("/api/account", json={"account_id": "act_5"})
    # Same-origin from the browser's point of view: the rebound page's own domain.
    r = client.post("/api/account", json={"account_id": "act_2"},
                    headers={"Host": "rebind-attacker.test:8777", "Origin": "http://rebind-attacker.test:8777",
                             "Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 400 and r.json()["code"] == "bad_host"
    assert _cfg(temp_data_dir)["account"]["id"] == "act_5"


def test_custom_bind_host_is_allowed(demo_client, monkeypatch):
    monkeypatch.setenv("ODYLIC_HOST", "10.0.0.7")
    assert demo_client.get("/api/health", headers={"Host": "10.0.0.7:8777"}).status_code == 200
    monkeypatch.setenv("ODYLIC_HOST", "0.0.0.0")
    assert demo_client.get("/api/health", headers={"Host": "10.0.0.7:8777"}).status_code == 400
    monkeypatch.setenv("ODYLIC_ALLOWED_HOSTS", "10.0.0.7, mac.local")
    assert demo_client.get("/api/health", headers={"Host": "mac.local:8777"}).status_code == 200


def test_split_host():
    assert main.split_host("127.0.0.1:8777") == ("127.0.0.1", "8777")
    assert main.split_host("[::1]:8777") == ("::1", "8777")
    assert main.split_host("[::1]") == ("::1", None)
    assert main.split_host("LocalHost") == ("localhost", None)
    assert main.split_host("::1") == ("", None)
    assert main.split_host("[::1") == ("", None)


# ---------------------------------------------------------------------------
# Cross-site requests (CSRF, forced Meta pulls)
# ---------------------------------------------------------------------------
def test_cross_site_get_cannot_force_a_pull(client):  # noqa: F811
    client.post("/api/connect/token", json={"access_token": TOKEN})
    client.post("/api/account", json={"account_id": "act_5"})
    n = len(client.graph.calls)
    for headers in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
                    {"Origin": "https://evil.example"}, {"Origin": "null"},
                    {"Origin": "http://localhost:8777"}):  # another origin on this machine
        r = client.get("/api/ads?since=2026-09-01&until=2026-09-30&refresh=1", headers=headers)
        assert r.status_code == 403 and r.json()["code"] == "cross_site", headers
        r = client.get("/api/ads/1/daily?refresh=1", headers=headers)
        assert r.status_code == 403
    assert len(client.graph.calls) == n  # not one Meta call


def test_cross_site_posts_are_refused(client, temp_data_dir):  # noqa: F811
    client.post("/api/connect/token", json={"access_token": TOKEN})
    attempts = [
        ({"Origin": "https://evil.example", "Content-Type": "text/plain"}, ""),
        ({"Origin": "https://evil.example", "Content-Type": "application/json"}, "{}"),
        ({"Sec-Fetch-Site": "cross-site", "Content-Type": "application/x-www-form-urlencoded"}, "a=1"),
        ({"Content-Type": "text/plain"}, ""),  # a no-cors fetch from a browser without Sec-Fetch headers
        ({}, ""),
    ]
    for headers, body in attempts:
        for path in ("/api/disconnect", "/api/connect/cli", "/api/consent"):
            r = client.post(path, content=body, headers=headers)
            assert r.status_code in (403, 415), (path, headers, r.status_code)
    cfg = _cfg(temp_data_dir)
    assert cfg["token"] == TOKEN and cfg["consent"] is None


def test_same_origin_requests_still_work(client):  # noqa: F811
    same = {"Origin": "http://127.0.0.1:8777", "Sec-Fetch-Site": "same-origin"}
    assert client.post("/api/consent", json={"accepted": True}, headers=same).status_code == 200
    dev = {"Host": "localhost:5177", "Origin": "http://localhost:5177", "Sec-Fetch-Site": "same-origin"}
    assert client.post("/api/consent", json={"accepted": True}, headers=dev).status_code == 200
    assert client.get("/api/status", headers={"Sec-Fetch-Site": "none"}).status_code == 200
    assert client.post("/api/disconnect", json={}).status_code == 200  # curl-style, no browser headers


def test_security_headers(demo_client):
    for path in ("/", "/api/status", "/api/nope"):
        r = demo_client.get(path)
        assert r.headers["x-frame-options"] == "DENY"
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'"
        assert r.headers["referrer-policy"] == "no-referrer"
    assert demo_client.get("/api/status").headers["cross-origin-resource-policy"] == "same-origin"
    r = demo_client.get("/api/status", headers={"Host": "evil.example"})
    assert r.status_code == 400 and r.headers["x-frame-options"] == "DENY"


# ---------------------------------------------------------------------------
# Thumbnail proxy: Meta's image hosts only, https only
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("src,ok", [
    ("https://scontent-lax3-1.xx.fbcdn.net/v/t45/1.jpg?oe=1", True),
    ("https://scontent.cdninstagram.com/a.jpg", True),
    ("https://external.fbsbx.com/x", True),
    ("http://scontent.xx.fbcdn.net/1.jpg", False),
    ("https://fbcdn.net.evil.example/1.jpg", False),
    ("https://evilfbcdn.net/1.jpg", False),
    ("https://127.0.0.1/1.jpg", False),
    ("https://169.254.169.254/latest", False),
    ("file:///etc/passwd", False),
    ("", False),
])
def test_thumb_host_allowlist(src, ok):
    assert main._thumb_host_ok(src) is ok


def test_thumb_download_refuses_other_hosts_without_a_request(client, monkeypatch):  # noqa: F811
    called = []
    monkeypatch.setattr(main._thumb_session, "get", lambda *a, **k: called.append(a) or None)
    assert main._download_thumb("1", "https://evil.example/x.jpg") == (None, "bad")
    assert main._download_thumb("1", "http://scontent.xx.fbcdn.net/x.jpg") == (None, "bad")
    assert called == []


# ---------------------------------------------------------------------------
# Never listen beyond this machine by accident
# ---------------------------------------------------------------------------
def test_run_refuses_a_lan_host_without_opt_in(monkeypatch):
    ran = []
    monkeypatch.setitem(sys.modules, "uvicorn", types.SimpleNamespace(run=lambda *a, **k: ran.append(k)))
    monkeypatch.setenv("ODYLIC_HOST", "0.0.0.0")
    monkeypatch.delenv("ODYLIC_ALLOW_LAN", raising=False)
    with pytest.raises(SystemExit):
        main.run()
    assert ran == []
    monkeypatch.setenv("ODYLIC_ALLOW_LAN", "1")
    main.run()
    assert ran and ran[0]["host"] == "0.0.0.0"
    ran.clear()
    monkeypatch.setenv("ODYLIC_HOST", "127.0.0.1")
    monkeypatch.delenv("ODYLIC_ALLOW_LAN")
    main.run()
    assert ran[0]["host"] == "127.0.0.1"


# ---------------------------------------------------------------------------
# /api/health identity for the launchers
# ---------------------------------------------------------------------------
def test_health_identity_proof(demo_client, temp_data_dir):
    r = demo_client.get("/api/health").json()
    assert r["app"] == "odylic-constellation" and r["build"] == build_id() and "proof" not in r
    c = "a1" * 16
    r = demo_client.get(f"/api/health?c={c}").json()
    secret = (temp_data_dir / "install_secret").read_text().strip()
    assert r["proof"] == hmac.new(secret.encode(), c.encode(), hashlib.sha256).hexdigest()
    assert secret not in json.dumps(r)
    if sys.platform != "win32":
        assert stat.S_IMODE(os.stat(temp_data_dir / "install_secret").st_mode) == 0o600
    assert demo_client.get("/api/health?c=short").status_code == 400
    # The secret survives a disconnect (it identifies the install, not the account).
    store.clear_connection()
    assert (temp_data_dir / "install_secret").read_text().strip() == secret
