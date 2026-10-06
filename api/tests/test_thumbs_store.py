"""Thumbnail downloads (parallel, deduped, failures remembered, versioned by
creative), the disk prune and the governor's slot forecast. No network."""
import io
import os
import threading
import time

import pytest
import requests
from fastapi.testclient import TestClient

from api import governor, main, store
from api.tests.conftest import LOCAL

CDN = "https://scontent.xx.fbcdn.net"


@pytest.fixture
def cdn(monkeypatch):
    """A fake CDN behind the thumbnail session, plus a connected config and an
    ad index, without touching Meta."""
    governor.install()
    state = {"hits": [], "routes": {}, "barrier": None}

    def send(self, request, *a, **k):
        state["hits"].append(request.url)
        if state["barrier"] is not None:
            state["barrier"].wait(timeout=3)
        status, ctype, body = state["routes"].get(request.url, (200, "image/jpeg", b"\xff\xd8jpeg"))
        r = requests.Response()
        r.request, r.status_code, r.raw = request, status, io.BytesIO(body)
        r.headers["Content-Type"] = ctype
        return r

    monkeypatch.setitem(governor._originals, "send", send)
    store.update_config(token="EAA" + "t" * 40, mode="token",
                        account={"id": "act_5", "name": "Shop", "currency": "USD"})
    main._thumb_dead.clear()
    state["client"] = TestClient(main.app, base_url=LOCAL)
    return state


def _index(**entries):
    store.merge_index({k: {"account": "act_5", **v} for k, v in entries.items()})


def test_different_ads_download_in_parallel(cdn):
    _index(**{"1": {"thumb_src": f"{CDN}/1.jpg", "thumb_key": "h1"},
              "2": {"thumb_src": f"{CDN}/2.jpg", "thumb_key": "h2"}})
    cdn["barrier"] = threading.Barrier(2)  # each download waits for the other: serial would time out
    out = {}
    ts = [threading.Thread(target=lambda i=i: out.setdefault(i, cdn["client"].get(f"/api/thumb/{i}"))) for i in ("1", "2")]
    [t.start() for t in ts]
    [t.join(10) for t in ts]
    assert out["1"].status_code == 200 and out["2"].status_code == 200
    assert not cdn["barrier"].broken


def test_same_ad_downloads_once(cdn):
    _index(**{"1": {"thumb_src": f"{CDN}/1.jpg", "thumb_key": "h1"}})
    ts = [threading.Thread(target=lambda: cdn["client"].get("/api/thumb/1")) for _ in range(4)]
    [t.start() for t in ts]
    [t.join(10) for t in ts]
    assert cdn["hits"].count(f"{CDN}/1.jpg") == 1


def test_dead_link_is_not_retried_until_it_changes(cdn):
    _index(**{"1": {"thumb_src": f"{CDN}/gone.jpg", "thumb_key": "h1"}})
    cdn["routes"][f"{CDN}/gone.jpg"] = (403, "text/plain", b"expired")
    for _ in range(3):
        r = cdn["client"].get("/api/thumb/1")
        assert r.status_code == 404 and r.headers["cache-control"] == "private, max-age=300"
    assert cdn["hits"].count(f"{CDN}/gone.jpg") == 1
    _index(**{"1": {"thumb_src": f"{CDN}/renewed.jpg", "thumb_key": "h1"}})  # the next ads pull renews it
    assert cdn["client"].get("/api/thumb/1").status_code == 200


def test_transient_errors_are_retried(cdn):
    _index(**{"1": {"thumb_src": f"{CDN}/flaky.jpg", "thumb_key": "h1"}})
    cdn["routes"][f"{CDN}/flaky.jpg"] = (503, "text/plain", b"busy")
    assert cdn["client"].get("/api/thumb/1").status_code == 404
    del cdn["routes"][f"{CDN}/flaky.jpg"]
    assert cdn["client"].get("/api/thumb/1").status_code == 200


def test_oversize_image_falls_back_to_the_small_thumbnail(cdn, monkeypatch):
    monkeypatch.setattr(main, "THUMB_MAX_BYTES", 16)
    _index(**{"1": {"thumb_src": f"{CDN}/huge.png", "thumb_alt": f"{CDN}/small.jpg", "thumb_key": "h1"}})
    cdn["routes"][f"{CDN}/huge.png"] = (200, "image/png", b"x" * 100)
    cdn["routes"][f"{CDN}/small.jpg"] = (200, "image/jpeg", b"\xff\xd8small")
    r = cdn["client"].get("/api/thumb/1")
    assert r.status_code == 200 and r.content == b"\xff\xd8small"
    assert not list(store.thumbs_dir().glob(".*.tmp"))


def test_an_edited_creative_gets_its_new_image(cdn):
    _index(**{"1": {"thumb_src": f"{CDN}/old.jpg", "thumb_key": "oldhash"}})
    cdn["routes"][f"{CDN}/old.jpg"] = (200, "image/jpeg", b"\xff\xd8old")
    assert cdn["client"].get("/api/thumb/1").content == b"\xff\xd8old"
    _index(**{"1": {"thumb_src": f"{CDN}/new.jpg", "thumb_key": "newhash"}})
    cdn["routes"][f"{CDN}/new.jpg"] = (200, "image/jpeg", b"\xff\xd8new")
    assert cdn["client"].get("/api/thumb/1?v=newhash").content == b"\xff\xd8new"
    assert [p.name for p in store.thumbs_dir().iterdir()] == ["1_newhash.jpg"]


def test_prune_drops_old_files_and_caps_thumbs(monkeypatch):
    now = time.time()
    store.cache_put("ads", "old", {"x": 1})
    store.cache_put("ads", "new", {"x": 2})
    old_file = store._cache_file("ads", "old")
    os.utime(old_file, (now - 8 * 86400, now - 8 * 86400))
    t = store.thumbs_dir()
    for i, age in enumerate((90, 10, 5, 1)):
        f = t / f"{i}.jpg"
        f.write_bytes(b"x" * 1000)
        os.utime(f, (now - age * 86400, now - age * 86400))
    store.merge_index({"9": {"thumb_src": "a"}, "8": {"thumb_src": "b"}})
    idx = store.load_index()
    idx["9"]["seen_at"] = now - 90 * 86400
    store._atomic_write(store._index_path(), __import__("json").dumps(idx))
    monkeypatch.setattr(store, "THUMBS_MAX_BYTES", 2500)
    store.maybe_prune(force=True)
    assert not old_file.exists() and store.cache_get("ads", "new", None) == {"x": 2}
    assert sorted(p.name for p in t.iterdir()) == ["2.jpg", "3.jpg"]  # 90 days gone, then oldest past the cap
    assert set(store.load_index()) == {"8"}


def test_slots_free_at(clock, monkeypatch):
    monkeypatch.setenv("ODYLIC_META_MAX_PER_HOUR", "10")
    assert governor.slots_free_at(10) is None
    starts = []
    for _ in range(8):
        starts.append(clock.t)
        governor.acquire()
        clock.t += 60
    assert governor.slots_free_at(2) is None
    assert governor.slots_free_at(3) == pytest.approx(starts[0] + 3600)
    assert governor.slots_free_at(5) == pytest.approx(starts[2] + 3600)
    governor.pause(7200, "test")
    assert governor.slots_free_at(1) == pytest.approx(clock.t + 7200)
