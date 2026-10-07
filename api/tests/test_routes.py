"""Connected-mode routes against a fake Graph + CDN transport. No network."""
import io
import json
import os
import stat
import sys
from urllib.parse import urlsplit

import pytest
import requests
from fastapi.testclient import TestClient

from api import governor, main, meta
from api.tests.conftest import LOCAL
from api.tests.test_pull import FakeGraph

TOKEN = "EAA" + "x" * 40


class FakeAccountGraph(FakeGraph):
    def respond(self, request):
        u = urlsplit(request.url)
        path = u.path.split("/v24.0/", 1)[-1]
        if u.hostname.endswith("fbcdn.net"):
            self.calls.append(("cdn", {}))
            return "IMAGE"
        if path == "me":
            self.calls.append((path, {}))
            if request.headers.get("Authorization") != f"OAuth {TOKEN}":
                return {"error": {"code": 190, "message": "Invalid OAuth access token."}}
            return {"id": "1", "name": "Tester"}
        if path == "me/adaccounts":
            self.calls.append((path, {}))
            return {"data": [{"id": "act_5", "name": "Shop", "currency": "EUR", "account_status": 1,
                              "timezone_name": "Europe/Berlin"}]}
        return super().respond(request)


@pytest.fixture
def client(clock, monkeypatch):
    governor.install()
    g = FakeAccountGraph(n_ads=60)

    def send(self, request, *a, **k):
        body = g.respond(request)
        r = requests.Response()
        r.request = request
        if body == "IMAGE":
            r.status_code = 200
            r.raw = io.BytesIO(b"\xff\xd8\xff\xe0fakejpeg")
            r.headers["Content-Type"] = "image/jpeg"
            return r
        r.status_code = 400 if "error" in body else 200
        r._content = json.dumps(body).encode()
        r.headers["Content-Type"] = "application/json"
        return r

    monkeypatch.setitem(governor._originals, "send", send)
    monkeypatch.setattr(main, "REFRESH_FLOOR_SEC", 0)  # refresh=1 always pulls (the floor has its own test)
    monkeypatch.setattr(main, "_demo", lambda: None)  # prove connected mode never touches demo
    meta.clear_memory()
    c = TestClient(main.app, base_url=LOCAL)
    c.graph = g
    return c


def test_full_connected_flow(client, temp_data_dir):
    r = client.post("/api/connect/token", json={"access_token": "EAA" + "y" * 40})
    assert r.status_code == 401 and r.json()["code"] == "invalid_token"

    r = client.post("/api/connect/token", json={"access_token": f"  {TOKEN}\n"})
    assert r.status_code == 200, r.text
    assert r.json()["accounts"][0]["id"] == "act_5"
    cfg_path = temp_data_dir / "config.json"
    if sys.platform != "win32":  # Windows privacy is enforced by ACL, tested in test_windows.py.
        assert stat.S_IMODE(os.stat(cfg_path).st_mode) == 0o600

    st = client.get("/api/status").json()
    assert st["connected"] and st["mode"] == "token" and st["account"] is None
    assert TOKEN not in json.dumps(st)

    r = client.post("/api/account", json={"account_id": "5"})
    assert r.status_code == 200 and r.json()["account"]["currency"] == "EUR"
    n_before = len(client.graph.calls)  # account came from the saved list: no call

    r = client.get("/api/ads?since=2026-09-01&until=2026-09-30")
    body = r.json()
    assert r.status_code == 200 and body["demo"] is False and body["cached"] is False
    assert body["currency"] == "EUR" and len(body["ads"]) == 60
    assert len(client.graph.calls) - n_before == 4  # insights + segments + 2 ad chunks

    r = client.get("/api/ads?since=2026-09-01&until=2026-09-30")
    assert r.json()["cached"] is True
    assert len(client.graph.calls) - n_before == 4

    r = client.get("/api/thumb/1")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    r = client.get("/api/thumb/1")  # disk cache
    assert sum(1 for p, _ in client.graph.calls if p == "cdn") == 1

    r = client.get("/api/ads/1/comments")
    assert r.status_code == 200 and r.json()["counts"]["instagram"] == 1
    calls = len(client.graph.calls)
    client.get("/api/ads/1/comments")
    assert len(client.graph.calls) == calls  # cached

    assert client.get("/api/ads/abc/comments").json()["code"] == "bad_ad_id"

    r = client.post("/api/disconnect", json={})
    assert r.json() == {"ok": True}
    cfg = json.loads(cfg_path.read_text())
    assert not cfg.get("token") and not cfg.get("account")
    assert not (temp_data_dir / "cache").exists() and not (temp_data_dir / "thumbs").exists()


def test_throttled_pull_serves_stale_cache_then_errors(client, clock):
    client.post("/api/connect/token", json={"access_token": TOKEN})
    client.post("/api/account", json={"account_id": "act_5"})
    assert client.get("/api/ads?since=2026-09-01&until=2026-09-30").status_code == 200
    governor.pause(600, "test pause")
    r = client.get("/api/ads?since=2026-09-01&until=2026-09-30&refresh=1")
    assert r.status_code == 200 and r.json()["cached"] is True and r.json()["note"]
    r = client.get("/api/ads?since=2026-08-01&until=2026-08-30")
    assert r.status_code == 429 and r.json()["code"] == "throttled" and r.json()["paused_until"]


def test_demo_unavailable_is_clean_error(client):
    r = client.get("/api/ads?demo=1")
    assert r.status_code == 503 and r.json() == {"error": "The demo brand is not available in this build.",
                                                 "code": "demo_unavailable"}


def test_cli_connect_without_binary_uses_env_credentials(client, monkeypatch, tmp_path):
    from api import cli_bridge
    monkeypatch.setattr(cli_bridge, "find_binary", lambda home=None: None)
    monkeypatch.setenv("ACCESS_TOKEN", TOKEN)
    monkeypatch.setenv("AD_ACCOUNT_ID", "5")
    r = client.post("/api/connect/cli", json={})
    body = r.json()
    assert r.status_code == 200, body
    assert body["default_account"] == "act_5" and body["accounts"][0]["id"] == "act_5" and body["note"]
    assert client.get("/api/status").json()["mode"] == "cli"
    monkeypatch.delenv("ACCESS_TOKEN")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    r = client.post("/api/connect/cli", json={})
    assert r.json()["code"] == "cli_not_found"


def _connect(client, account="act_5"):
    assert client.post("/api/connect/token", json={"access_token": TOKEN}).status_code == 200
    assert client.post("/api/account", json={"account_id": account}).status_code == 200


def test_range_change_reuses_ad_nodes(client):
    _connect(client)
    n = len(client.graph.calls)
    client.get("/api/ads?since=2026-09-01&until=2026-09-30")
    assert len(client.graph.calls) - n == 4
    n = len(client.graph.calls)
    r = client.get("/api/ads?since=2026-09-02&until=2026-09-30")
    assert r.status_code == 200 and len(r.json()["ads"]) == 60 and r.json()["ads"][0]["creative_id"]
    assert len(client.graph.calls) - n == 2  # insights + segments; the /ads nodes came from disk
    n = len(client.graph.calls)
    client.get("/api/ads?since=2026-09-03&until=2026-09-30&refresh=1")
    assert len(client.graph.calls) - n == 4  # refresh=1 fetches nodes again


def test_refresh_floor(client, monkeypatch):
    _connect(client)
    monkeypatch.setattr(main, "REFRESH_FLOOR_SEC", 120)
    client.get("/api/ads?since=2026-09-01&until=2026-09-30")
    n = len(client.graph.calls)
    for _ in range(5):
        r = client.get("/api/ads?since=2026-09-01&until=2026-09-30&refresh=1")
        assert r.status_code == 200 and r.json()["cached"] is True
    assert len(client.graph.calls) == n


def test_switching_accounts_keeps_the_cache(client):
    _connect(client)
    client.get("/api/ads?since=2026-09-01&until=2026-09-30")
    client.get("/api/thumb/1")
    other = {"id": "act_6", "name": "Other", "currency": "USD", "account_status": 1, "timezone_name": None}
    from api import store
    store.update_config(accounts=[*store.load_config()["accounts"], other])
    assert client.post("/api/account", json={"account_id": "act_6"}).status_code == 200
    assert client.post("/api/account", json={"account_id": "act_5"}).status_code == 200
    n = len(client.graph.calls)
    assert client.get("/api/ads?since=2026-09-01&until=2026-09-30").json()["cached"] is True
    assert client.get("/api/thumb/1").status_code == 200
    assert len(client.graph.calls) == n


def test_queued_pull_for_an_abandoned_range_is_dropped(client):
    import threading
    _connect(client)
    out = {}
    main._ads_lock.acquire()
    try:
        t = threading.Thread(target=lambda: out.setdefault("r", client.get("/api/ads?since=2026-08-01&until=2026-08-31")))
        t.start()
        for _ in range(200):
            if main._wanted.get("act_5") == "act_5|2026-08-01|2026-08-31":
                break
            threading.Event().wait(0.01)
        main._wanted["act_5"] = "act_5|2026-07-01|2026-07-31"  # the page moved on meanwhile
        n = len(client.graph.calls)
    finally:
        main._ads_lock.release()
    t.join(5)
    assert out["r"].status_code == 409 and out["r"].json()["code"] == "superseded"
    assert len(client.graph.calls) == n


def test_retry_waits_until_the_rest_of_the_pull_fits(client, clock, monkeypatch):
    _connect(client)
    monkeypatch.setenv("ODYLIC_META_MAX_PER_HOUR", "5")  # 2 used by connecting; insights + segments + 1 chunk
    r = client.get("/api/ads?since=2026-09-01&until=2026-09-30")
    assert r.status_code == 429 and r.json()["paused_until"]
    n = len(client.graph.calls)
    clock.t += 1800  # nothing has aged out of the hour yet: the retry must not start
    r = client.get("/api/ads?since=2026-09-01&until=2026-09-30")
    assert r.status_code == 429 and "needs about 1 Meta call," in r.json()["error"] and r.json()["paused_until"]
    assert len(client.graph.calls) == n
    clock.t += 1801
    r = client.get("/api/ads?since=2026-09-01&until=2026-09-30")
    assert r.status_code == 200 and len(r.json()["ads"]) == 60 and all(a["creative_id"] for a in r.json()["ads"])
    assert len(client.graph.calls) - n == 1  # just the chunk that was missing
