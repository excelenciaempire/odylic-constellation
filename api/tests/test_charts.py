"""Ad charts: the demo generators, the chart routes in demo mode, and the
connected routes against a fake Graph transport (no network)."""
import io
import json
from datetime import date, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
import requests
from fastapi.testclient import TestClient

from api import demo_data, governor, main, meta
from api.tests.conftest import LOCAL

TOKEN = "EAA" + "c" * 40

ADDITIVE = ("spend", "impressions", "clicks", "purchases", "revenue", "link_clicks", "outbound_clicks",
            "landing_page_views", "add_to_cart", "initiate_checkout", "leads", "video_3s_views", "thruplays",
            "video_p25", "video_p50", "video_p75", "video_p100", "post_reactions", "post_comments", "post_shares")


def _range(days: int, end_offset: int = 1):
    u = date.today() - timedelta(days=end_offset)
    return (u - timedelta(days=days - 1)).isoformat(), u.isoformat()


def _cents(v) -> int:
    return int(round(float(v) * 100))


def _assert_totals(rows, ad):
    for f in ADDITIVE:
        got = sum(r[f] for r in rows)
        if f in ("spend", "revenue"):
            assert _cents(got) == _cents(ad[f]), f
        else:
            assert got == ad[f], f


def _pick_ads(since, until):
    ads = demo_data.demo_ads(since, until)
    picks = {
        "top": ads[0],
        "video_seg": next(a for a in ads if a["is_video"] and a["segment_spend"]),
        "paused": next(a for a in ads if a["effective_status"] == "PAUSED"),
        "small": ads[-1],
    }
    return picks


# ---------------------------------------------------------------------------
# Demo generators
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("days", [7, 30, 90])
def test_demo_daily_reconciles_with_demo_ads(days):
    s, u = _range(days)
    for name, ad in _pick_ads(s, u).items():
        rows = demo_data.demo_daily(ad["ad_id"], s, u)
        assert rows, name
        _assert_totals(rows, ad)
        dates = [r["date"] for r in rows]
        assert dates == sorted(dates) and s <= dates[0] and dates[-1] <= u
        for a, b in zip(dates, dates[1:]):
            assert date.fromisoformat(b) - date.fromisoformat(a) == timedelta(days=1)
        for r in rows:
            assert r["reach"] <= r["impressions"]
            assert r["impressions"] >= r["video_3s_views"] >= r["video_p25"] >= r["video_p50"] >= r["video_p75"] >= r["video_p100"]
            assert r["video_3s_views"] >= r["thruplays"]
            assert r["clicks"] >= r["link_clicks"] >= r["outbound_clicks"] and r["link_clicks"] >= r["landing_page_views"]
            assert r["add_to_cart"] >= r["initiate_checkout"] >= r["purchases"]
        # Reach repeats across days: the days add up to at least the range's reach.
        assert sum(r["reach"] for r in rows) >= ad["reach"]
        assert demo_data.demo_daily(ad["ad_id"], s, u) == rows  # deterministic


def test_demo_daily_shapes():
    s, u = _range(90)
    ad = _pick_ads(s, u)["video_seg"]
    rows = demo_data.demo_daily(ad["ad_id"], s, u)
    assert len({r["spend"] for r in rows}) > len(rows) // 2  # the days differ
    roas = [r["roas"] for r in rows if r["roas"] is not None]
    assert max(roas) > min(roas)
    assert demo_data.demo_daily("999", s, u) is None
    assert demo_data.demo_daily(ad["ad_id"], u, s) == []  # an empty range


@pytest.mark.parametrize("kind", ["age", "gender", "age_gender", "placement", "platform", "device", "segment"])
def test_demo_breakdowns_reconcile(kind):
    s, u = _range(30)
    for name, ad in _pick_ads(s, u).items():
        rows = demo_data.demo_breakdown(ad["ad_id"], kind, s, u)
        if kind == "segment" and not ad["segment_spend"]:
            assert rows == []
            continue
        assert rows, (name, kind)
        _assert_totals(rows, ad)
        if kind in ("age", "gender", "age_gender", "segment"):
            assert sum(r["reach"] for r in rows) == ad["reach"]  # each person sits in one row
        else:
            assert sum(r["reach"] for r in rows) >= ad["reach"]
        assert demo_data.demo_breakdown(ad["ad_id"], kind, s, u) == rows


def test_demo_breakdown_mix_and_consistency():
    s, u = _range(30)
    ad = _pick_ads(s, u)["video_seg"]
    cross = demo_data.demo_breakdown(ad["ad_id"], "age_gender", s, u)
    ages = demo_data.demo_breakdown(ad["ad_id"], "age", s, u)
    for row in ages:
        assert _cents(row["spend"]) == _cents(sum(r["spend"] for r in cross if r["age"] == row["age"]))
    share = {r["age"]: r["spend"] / ad["spend"] for r in ages}
    assert share["25-34"] + share["35-44"] > 0.45  # skincare skews 25 to 44
    genders = {r["gender"]: r["spend"] for r in demo_data.demo_breakdown(ad["ad_id"], "gender", s, u)}
    assert genders["female"] > 2 * genders["male"]
    seg = {meta.segment_bucket(r["user_segment_key"]): r for r in demo_data.demo_breakdown(ad["ad_id"], "segment", s, u)}
    assert {k: _cents(v["spend"]) for k, v in seg.items()} == {k: _cents(v) for k, v in ad["segment_spend"].items()}
    assert seg["existing"]["roas"] > seg["prospecting"]["roas"]
    places = demo_data.demo_breakdown(ad["ad_id"], "placement", s, u)
    reels = sum(r["spend"] for r in places if "reels" in r["platform_position"])
    assert reels > 0.2 * ad["spend"]  # a video leans on Reels
    with pytest.raises(ValueError):
        demo_data.demo_breakdown(ad["ad_id"], "region", s, u)


def test_demo_video_curve():
    s, u = _range(30)
    picks = _pick_ads(s, u)
    vid = picks["video_seg"]
    c = demo_data.demo_video_curve(vid["ad_id"], s, u)
    vals = c["values"]
    assert len(vals) == 22 and vals[0] == 100.0 and c["plays"] == vid["video_3s_views"]
    nonzero = [v for v in vals if v > 0]
    assert nonzero == sorted(nonzero, reverse=True)
    still = [v for v in vals if v > 0]
    assert vals[: len(still)] == still  # zeros only after the end of the video
    static = next(a for a in demo_data.demo_ads(s, u) if not a["is_video"])
    assert demo_data.demo_video_curve(static["ad_id"], s, u) == {"values": [], "plays": 0}
    assert demo_data.demo_video_curve("999", s, u) is None


def test_curve_points_use_meta_buckets():
    pts = meta.curve_points([100, 80, 70, 60, 55, 50, 45, 40, 38, 36, 34, 32, 30, 28, 26, 24, 20, 16, 12, 8, 4, 2])
    assert [p["second"] for p in pts] == list(range(15)) + [15, 20, 25, 30, 40, 50, 60]
    assert pts[0]["label"] == "0:00" and pts[16]["label"] == "0:20" and pts[-1]["label"] == "1:00+"
    trimmed = meta.curve_points([200, 100, 50, 0, 0])
    assert [p["pct"] for p in trimmed] == [100.0, 50.0, 25.0]  # normalized to the peak, trailing zeros gone
    assert meta.curve_points([0, 0]) == [] and meta.curve_points([]) == []
    long = meta.curve_points(list(range(30, 0, -1)))
    assert long[-1]["second"] == 29  # not Meta's 22 buckets: one point per second
    assert meta.combine_curves([([100, 50], 3), ([100, 10], 1)]) == [100.0, 40.0]


# ---------------------------------------------------------------------------
# Routes, demo mode
# ---------------------------------------------------------------------------
@pytest.fixture
def demo_client():
    return TestClient(main.app, base_url=LOCAL)


def test_demo_routes(demo_client):
    s, u = _range(30)
    ads = demo_client.get(f"/api/ads?demo=1&since={s}&until={u}").json()["ads"]
    a, b = ads[0], ads[1]
    r = demo_client.get(f"/api/ads/{a['ad_id']}/daily?demo=1&since={s}&until={u}")
    body = r.json()
    assert r.status_code == 200 and body["demo"] is True and body["ad_ids"] == [a["ad_id"]]
    assert _cents(sum(d["spend"] for d in body["days"])) == _cents(a["spend"])
    assert {"date", "spend", "impressions", "clicks", "reach", "purchases", "revenue", "roas", "ctr", "cpm", "cpc",
            "frequency", "link_clicks", "add_to_cart", "video_3s_views", "thruplays", "video_p25",
            "video_p100"} <= set(body["days"][0])

    # A stacked card: both ads, summed per day.
    r = demo_client.get(f"/api/ads/{a['ad_id']}/daily?demo=1&since={s}&until={u}&ids={b['ad_id']},{a['ad_id']}")
    body = r.json()
    assert body["ad_ids"] == [a["ad_id"], b["ad_id"]]
    assert _cents(sum(d["spend"] for d in body["days"])) == _cents(a["spend"]) + _cents(b["spend"])
    assert sum(d["purchases"] for d in body["days"]) == a["purchases"] + b["purchases"]

    r = demo_client.get(f"/api/ads/{a['ad_id']}/breakdown?kind=age_gender&demo=1&since={s}&until={u}")
    rows = r.json()["rows"]
    assert r.status_code == 200 and r.json()["kind"] == "age_gender"
    assert rows[0]["key"] == "18-24|female" and rows[0]["label"] == "18-24, Female"
    assert _cents(sum(x["spend"] for x in rows)) == _cents(a["spend"])

    r = demo_client.get(f"/api/ads/{a['ad_id']}/breakdown?kind=placement&demo=1&since={s}&until={u}")
    rows = r.json()["rows"]
    assert rows == sorted(rows, key=lambda x: -x["spend"])
    assert all(x["key"] == f"{x['platform']}/{x['position']}" and x["platform_label"] and x["position_label"] for x in rows)

    video = next(x for x in ads if x["is_video"])
    r = demo_client.get(f"/api/ads/{video['ad_id']}/video-curve?demo=1&since={s}&until={u}")
    pts = r.json()["points"]
    assert r.status_code == 200 and pts[0] == {"index": 0, "second": 0, "label": "0:00", "pct": 100.0}
    static = next(x for x in ads if not x["is_video"])
    assert demo_client.get(f"/api/ads/{static['ad_id']}/video-curve?demo=1").json()["points"] == []


def test_chart_route_errors(demo_client):
    r = demo_client.get("/api/ads/1/breakdown?kind=region&demo=1")
    assert r.status_code == 400 and r.json()["code"] == "bad_kind"
    assert demo_client.get("/api/ads/1/breakdown?demo=1").json()["code"] == "bad_kind"
    r = demo_client.get("/api/ads/999/daily?demo=1")
    assert r.status_code == 404 and r.json()["code"] == "not_found"
    assert demo_client.get("/api/ads/abc/daily?demo=1").json()["code"] == "bad_ad_id"
    assert demo_client.get("/api/ads/1/daily?demo=1&ids=2,x").json()["code"] == "bad_ad_id"
    many = ",".join(str(i) for i in range(2, 60))
    assert demo_client.get(f"/api/ads/1/daily?demo=1&ids={many}").json()["code"] == "too_many_ads"
    assert demo_client.get("/api/ads/1/daily?demo=1&since=2026-09-10&until=2026-09-01").json()["code"] == "bad_date"


# ---------------------------------------------------------------------------
# Routes, connected, against a fake Graph
# ---------------------------------------------------------------------------
def _actions(n):
    # Meta reports one purchase under several types; only the pixel one counts.
    return [{"action_type": "offsite_conversion.fb_pixel_purchase", "value": str(n)},
            {"action_type": "omni_purchase", "value": str(n)},
            {"action_type": "link_click", "value": str(4 * n)},
            {"action_type": "add_to_cart", "value": str(3 * n)}]


def _values(n):
    return [{"action_type": "offsite_conversion.fb_pixel_purchase", "value": str(50 * n)},
            {"action_type": "omni_purchase", "value": str(50 * n)}]


class FakeChartGraph:
    def __init__(self):
        self.calls = []
        self.error = None

    def insights(self, q):
        ids = json.loads(q["filtering"])[0]["value"]
        if self.error:
            return {"error": self.error}
        if "video_play_curve_actions" in q["fields"]:
            return {"data": [
                {"ad_id": "1", "video_play_curve_actions": [{"action_type": "video_view", "value": [100, 50, 20, 0]}],
                 "video_play_actions": [{"action_type": "video_view", "value": "300"}]},
                {"ad_id": "2", "video_play_curve_actions": [{"action_type": "video_view", "value": [100, 90, 60, 30]}],
                 "video_play_actions": [{"action_type": "video_view", "value": "100"}]},
            ][: len(ids)]}
        bd = q.get("breakdowns")
        if q.get("time_increment") == "1":
            data = []
            for i, aid in enumerate(ids):
                for d in ("2026-09-01", "2026-09-02", "2026-09-04"):  # no delivery on Sep 3
                    data.append({"ad_id": aid, "date_start": d, "date_stop": d, "spend": str(10 + i),
                                 "impressions": "1000", "clicks": "20", "reach": "800", "inline_link_clicks": "8",
                                 "actions": _actions(1 + i), "action_values": _values(1 + i)})
            return {"data": data}
        if bd == "user_segment_key":
            return {"data": [{"ad_id": aid, "user_segment_key": seg, "spend": "5", "impressions": "1000",
                              "reach": "900", "ctr": "1.5", "actions": _actions(1), "action_values": _values(1)}
                             for aid in ids for seg in ("prospecting", "existing_customers")]}
        if bd == "age,gender":
            return {"data": [{"ad_id": aid, "age": age, "gender": g, "spend": "3", "impressions": "300",
                              "clicks": "6", "reach": "250", "actions": _actions(1), "action_values": _values(1)}
                             for aid in ids for age in ("35-44", "25-34") for g in ("male", "female")]}
        if bd == "publisher_platform,platform_position":
            return {"data": [{"ad_id": aid, "publisher_platform": p, "platform_position": pos, "spend": sp,
                              "impressions": "500", "clicks": "5", "reach": "400"}
                             for aid in ids for p, pos, sp in (("instagram", "instagram_reels", "7"),
                                                                ("facebook", "feed", "9"))]}
        return {"data": [{"ad_id": aid, bd: "x", "spend": "1", "impressions": "10", "clicks": "1", "reach": "9"}
                         for aid in ids]}

    def respond(self, request):
        u = urlsplit(request.url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = u.path.split("/v24.0/", 1)[-1]
        self.calls.append((path, q))
        if path == "me":
            return {"id": "1", "name": "Tester"}
        if path == "me/adaccounts":
            return {"data": [{"id": "act_5", "name": "Shop", "currency": "USD", "account_status": 1}]}
        if path == "act_5/insights":
            return self.insights(q)
        return {"error": {"code": 803, "message": "unknown path"}}


@pytest.fixture
def live(clock, monkeypatch):
    governor.install()
    g = FakeChartGraph()

    def send(self, request, *a, **k):
        assert request.method == "GET" and "access_token=" not in request.url
        body = g.respond(request)
        r = requests.Response()
        r.request = request
        r.status_code = 400 if "error" in body else 200
        r._content = json.dumps(body).encode()
        r.headers["Content-Type"] = "application/json"
        r.raw = io.BytesIO(b"")
        return r

    monkeypatch.setitem(governor._originals, "send", send)
    monkeypatch.setattr(main, "REFRESH_FLOOR_SEC", 0)  # refresh=1 always pulls (the floor has its own test)
    monkeypatch.setattr(main, "_demo", lambda: None)  # connected mode never touches the demo
    meta.clear_memory()
    c = TestClient(main.app, base_url=LOCAL)
    assert c.post("/api/connect/token", json={"access_token": TOKEN}).status_code == 200
    assert c.post("/api/account", json={"account_id": "act_5"}).status_code == 200
    c.graph = g
    return c


def _insights(g):
    return [q for p, q in g.calls if p == "act_5/insights"]


def test_daily_is_one_governed_call_and_cached(live):
    g = live.graph
    before = governor.status()["calls_last_hour"]
    r = live.get("/api/ads/1/daily?since=2026-09-01&until=2026-09-30&ids=2")
    body = r.json()
    assert r.status_code == 200 and body["demo"] is False and body["cached"] is False
    calls = _insights(g)
    assert len(calls) == 1 and governor.status()["calls_last_hour"] == before + 1
    q = calls[0]
    assert q["level"] == "ad" and q["time_increment"] == "1" and q["use_account_attribution_setting"] == "true"
    assert json.loads(q["filtering"]) == [{"field": "ad.id", "operator": "IN", "value": ["1", "2"]}]
    assert json.loads(q["time_range"]) == {"since": "2026-09-01", "until": "2026-09-30"}
    assert q["fields"] == meta.DAILY_FIELDS and "breakdowns" not in q

    days = body["days"]
    assert [d["date"] for d in days] == ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]
    d1 = days[0]
    assert d1["spend"] == 21.0 and d1["impressions"] == 2000 and d1["clicks"] == 40 and d1["link_clicks"] == 16
    assert d1["purchases"] == 3 and d1["revenue"] == 150.0  # pixel type only, never pixel + omni
    assert d1["roas"] == round(150 / 21, 4) and d1["ctr"] == 2.0 and d1["cpm"] == 10.5
    gap = days[2]
    assert gap["spend"] == 0 and gap["roas"] is None and gap["ctr"] is None
    assert "video_p25" not in d1  # Meta never sent quartiles: dropped, not zero

    # Cached on disk, whichever ad of the stack leads the request.
    r = live.get("/api/ads/2/daily?since=2026-09-01&until=2026-09-30&ids=1")
    assert r.json()["cached"] is True and r.json()["ad_id"] == "2" and len(_insights(g)) == 1
    r = live.get("/api/ads/1/daily?since=2026-09-01&until=2026-09-30&ids=2&refresh=1")
    assert r.json()["cached"] is False and len(_insights(g)) == 2


@pytest.mark.parametrize("kind,breakdowns", list(meta.BREAKDOWNS.items()))
def test_breakdown_params(live, kind, breakdowns):
    r = live.get(f"/api/ads/1/breakdown?kind={kind}&since=2026-09-01&until=2026-09-30")
    assert r.status_code == 200, r.text
    q = _insights(live.graph)[-1]
    assert q["breakdowns"] == breakdowns and q["level"] == "ad" and "time_increment" not in q
    assert q["fields"] == (meta.SEGMENT_FIELDS if kind == "segment" else meta.BREAKDOWN_FIELDS)
    assert json.loads(q["filtering"])[0]["value"] == ["1"]
    assert r.json()["kind"] == kind and r.json()["rows"]


def test_breakdown_rows(live):
    rows = live.get("/api/ads/1/breakdown?kind=age_gender&since=2026-09-01&until=2026-09-30&ids=2").json()["rows"]
    assert [x["key"] for x in rows] == ["25-34|female", "25-34|male", "35-44|female", "35-44|male"]
    assert rows[0]["spend"] == 6.0 and rows[0]["purchases"] == 2 and rows[0]["label"] == "25-34, Female"

    seg = live.get("/api/ads/1/breakdown?kind=segment&since=2026-09-01&until=2026-09-30").json()["rows"]
    assert [x["key"] for x in seg] == ["prospecting", "existing"]
    assert seg[0]["clicks"] == 15 and seg[0]["label"] == "New (prospecting)"  # from ctr x impressions

    places = live.get("/api/ads/1/breakdown?kind=placement&since=2026-09-01&until=2026-09-30").json()["rows"]
    assert [x["label"] for x in places] == ["Facebook Feed", "Instagram Reels"]  # by spend
    assert "purchases" in places[0] and "video_p25" not in places[0]


def test_video_curve_combines_by_plays(live):
    body = live.get("/api/ads/1/video-curve?since=2026-09-01&until=2026-09-30&ids=2").json()
    q = _insights(live.graph)[-1]
    assert q["fields"] == meta.CURVE_FIELDS
    assert [p["pct"] for p in body["points"]] == [100.0, 60.0, 30.0, 7.5]  # weighted 3:1 by plays
    assert [p["label"] for p in body["points"]] == ["0:00", "0:01", "0:02", "0:03"]


def test_chart_errors_and_stale_cache(live):
    g = live.graph
    url = "/api/ads/1/breakdown?kind=device&since=2026-09-01&until=2026-09-30"
    assert live.get(url).status_code == 200
    governor.pause(600, "test pause")
    r = live.get(url + "&refresh=1")
    assert r.status_code == 200 and r.json()["cached"] is True and r.json()["note"]
    r = live.get("/api/ads/1/daily?since=2026-08-01&until=2026-08-30")
    assert r.status_code == 429 and r.json()["code"] == "throttled"
    governor.unblock_token(None)
    with open(governor._state_path(), "w") as fh:
        fh.write("{}")
    g.error = {"code": 200, "message": "(#200) Permissions error"}
    r = live.get("/api/ads/1/daily?since=2026-07-01&until=2026-07-30")
    assert r.status_code == 403 and r.json()["code"] == "permission_denied"
    assert TOKEN not in r.text
