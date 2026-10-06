import json

import pytest
import requests

from api import governor
from api.governor import MetaAuthError, MetaThrottled, MetaWriteBlocked


def test_spacing_waits_at_least_one_second(clock):
    governor.acquire()
    t0 = clock()
    governor.acquire()
    assert clock() - t0 >= governor.MIN_INTERVAL_SEC
    assert governor.status()["calls_last_hour"] == 2


def test_rolling_hour_cap(clock, monkeypatch):
    monkeypatch.setenv("ODYLIC_META_MAX_PER_HOUR", "3")
    for _ in range(3):
        governor.acquire()
    with pytest.raises(MetaThrottled) as ei:
        governor.acquire()
    assert ei.value.until is not None
    st = governor.status()
    assert st["cap"] == 3 and st["calls_last_hour"] == 3 and st["paused_until"]
    clock.t += governor.WINDOW_SEC + 1
    governor.acquire()  # window rolled
    assert governor.status()["calls_last_hour"] == 1


def test_escalating_ladder_and_decay(clock):
    expected = [300, 1800, 7200, 21600, 21600]
    for secs in expected:
        governor.note_throttle(4, "Application request limit reached")
        with pytest.raises(MetaThrottled):
            governor.acquire()
        clock.t += secs - 1
        with pytest.raises(MetaThrottled):
            governor.acquire()
        clock.t += 2
        governor.acquire()
    # After a quiet spell longer than the decay, the ladder starts over.
    clock.t += governor.STRIKE_DECAY_SEC + 10
    governor.note_throttle(17, "user limit")
    clock.t += 301
    governor.acquire()


def test_regain_time_from_error_body(clock):
    body = {"error": {"code": 80004, "message": "too many calls",
                      "error_data": {"estimated_time_to_regain_access": 12}}}
    governor.observe_error_body(body, None)
    clock.t += 11 * 60
    with pytest.raises(MetaThrottled):
        governor.acquire()
    clock.t += 61
    governor.acquire()


def test_usage_headers_back_off(clock):
    governor.observe_headers({"x-business-use-case-usage": json.dumps(
        {"123": [{"type": "ads_insights", "call_count": 10, "total_cputime": 5, "total_time": 4,
                  "estimated_time_to_regain_access": 0}]}
    )})
    governor.acquire()  # 10% is fine
    governor.observe_headers({"x-ad-account-usage": json.dumps({"acc_id_util_pct": 55})})
    with pytest.raises(MetaThrottled):
        governor.acquire()
    clock.t += 301
    governor.acquire()
    governor.observe_headers({"x-fb-ads-insights-throttle": json.dumps({"app_id_util_pct": 92, "acc_id_util_pct": 1})})
    clock.t += 900
    with pytest.raises(MetaThrottled):
        governor.acquire()  # 90%+ is a 30 minute pause
    clock.t += 901
    governor.acquire()


def test_header_regain_is_obeyed(clock):
    governor.observe_headers({"x-business-use-case-usage": json.dumps(
        {"9": [{"call_count": 1, "estimated_time_to_regain_access": 20}]})})
    clock.t += 19 * 60
    with pytest.raises(MetaThrottled):
        governor.acquire()
    clock.t += 61
    governor.acquire()


def test_auth_error_blocks_only_that_token(clock):
    fp = governor.token_fingerprint("EAAbadtoken0000000000000000")
    governor.observe_error_body({"error": {"code": 190, "message": "expired"}}, fp)
    with pytest.raises(MetaAuthError):
        governor.acquire(token_fp=fp)
    governor.acquire(token_fp=governor.token_fingerprint("EAAothertoken000000000000000"))
    clock.t += governor.AUTH_BLOCK_SEC + 1
    governor.acquire(token_fp=fp)


def test_corrupt_state_fails_closed(clock):
    governor.acquire()
    (governor._state_path()).write_text("{not json")
    with pytest.raises(MetaThrottled):
        governor.acquire()
    clock.t += 61
    governor.acquire()


def test_unwritable_state_fails_closed(clock, monkeypatch):
    monkeypatch.setattr(governor, "_write_state", lambda s: False)
    with pytest.raises(MetaThrottled):
        governor.acquire()


def test_write_methods_blocked_before_network(clock):
    governor.install()
    for method in ("POST", "DELETE", "PUT"):
        with pytest.raises(MetaWriteBlocked):
            requests.request(method, "https://graph.facebook.com/v24.0/act_1/ads", timeout=1)
    assert governor.status()["calls_last_hour"] == 0


def _fake_transport(monkeypatch, body=b'{"id": "1"}', headers=None):
    governor.install()
    seen = []

    def fake_send(self, request, *a, **k):
        seen.append({"url": request.url, "auth": request.headers.get("Authorization")})
        r = requests.Response()
        r.status_code = 200
        r._content = body
        r.headers["Content-Type"] = "application/json"
        for k2, v in (headers or {}).items():
            r.headers[k2] = v
        r.request = request
        return r

    monkeypatch.setitem(governor._originals, "send", fake_send)
    return seen


def test_get_through_chokepoint_is_counted_and_token_moved(clock, monkeypatch):
    seen = _fake_transport(monkeypatch)
    requests.get("https://graph.facebook.com/v24.0/me", params={"access_token": "EAAsecretsecretsecret123"}, timeout=1)
    assert "access_token" not in seen[0]["url"]
    assert seen[0]["auth"] == "OAuth EAAsecretsecretsecret123"
    assert governor.status()["calls_last_hour"] == 1
    # Non-Meta hosts are not counted.
    requests.get("https://scontent.xx.fbcdn.net/x.jpg", timeout=1)
    assert governor.status()["calls_last_hour"] == 1


def test_throttle_response_trips_breaker_through_chokepoint(clock, monkeypatch):
    _fake_transport(monkeypatch, body=b'{"error": {"code": 4, "message": "Application request limit reached"}}')
    requests.get("https://graph.facebook.com/v24.0/me", headers={"Authorization": "OAuth x"}, timeout=1)
    with pytest.raises(MetaThrottled):
        requests.get("https://graph.facebook.com/v24.0/me", headers={"Authorization": "OAuth x"}, timeout=1)
    st = governor.status()
    assert st["paused_until"] and "code 4" in st["reason"]


def test_non_meta_hosts_pass_through():
    assert not governor.is_meta_url("https://scontent.xx.fbcdn.net/x.jpg")
    assert governor.is_meta_url("https://graph.facebook.com/v24.0/me")
    assert governor.is_meta_url("https://graph-video.facebook.com/v24.0/1")


def test_scrub_removes_tokens():
    s = governor.scrub("GET https://graph.facebook.com/me?access_token=EAAB123abc&x=1 OAuth EAAB1234567890abcdef "
                       "raw EAABwzLixnjYBO0123456789abcdefABCDEF")
    assert "EAAB123abc" not in s and "EAAB1234567890abcdef" not in s and "EAABwzLixnjYBO" not in s
    assert "access_token=REDACTED" in s


def test_install_wraps_every_requests_send_path(clock, monkeypatch):
    """The call-volume guarantee rests on requests' internals: if a new
    requests release renamed or bypassed these, a Meta call could go out
    uncounted. Fail loudly instead."""
    import requests
    import requests.adapters
    import requests.sessions
    governor.install()
    assert requests.sessions.Session.request.__name__ == "guarded_request"
    assert requests.adapters.HTTPAdapter.send.__name__ == "guarded_send"
    sent = []
    monkeypatch.setitem(governor._originals, "send", lambda self, req, *a, **k: sent.append(req.url) or _ok(req))
    before = governor.status()["calls_last_hour"]
    s = requests.Session()  # a shared Session (the thumbnail pool) still goes through the chokepoint
    s.get("https://graph.facebook.com/v24.0/me", params={"access_token": "EAA" + "z" * 30})
    requests.get("https://graph.facebook.com/v24.0/me")
    assert governor.status()["calls_last_hour"] == before + 2
    assert all("access_token" not in u for u in sent)


def _ok(req):
    import requests
    r = requests.Response()
    r.status_code, r._content, r.request = 200, b"{}", req
    r.headers["Content-Type"] = "application/json"
    return r
