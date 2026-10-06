"""The ads pull and comments flow against a fake Graph transport. No network."""
import json
from urllib.parse import parse_qs, urlsplit

import pytest
import requests

from api import governor, meta


class FakeGraph:
    def __init__(self, n_ads=120, reduce_once=False, segment_error=False):
        self.calls = []
        self.n_ads = n_ads
        self.reduce_once = reduce_once
        self.segment_error = segment_error

    def respond(self, request):
        u = urlsplit(request.url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = u.path.split("/v24.0/", 1)[1]
        self.calls.append((path, q))
        if path.endswith("/insights") and "breakdowns" not in q:
            if self.reduce_once and int(q.get("limit", 0)) > 100:
                self.reduce_once = False
                return {"error": {"code": 1, "message": "Please reduce the amount of data you're asking for"}}
            ids = list(range(1, self.n_ads + 1))
            start = int(q.get("after", 0))
            limit = int(q["limit"])
            page = ids[start:start + limit]
            body = {"data": [{"ad_id": str(i), "ad_name": f"Ad {i}", "adset_id": "7", "adset_name": "S",
                              "campaign_id": "9", "campaign_name": "C", "spend": str(i), "impressions": "1000",
                              "clicks": "10", "reach": "500"} for i in page]}
            if start + limit < len(ids):
                body["paging"] = {"cursors": {"after": str(start + limit)}, "next": "https://graph.facebook.com/x"}
            return body
        if path.endswith("/insights"):
            if self.segment_error:
                return {"error": {"code": 100, "message": "(#100) breakdowns user_segment_key is not supported"}}
            return {"data": [{"ad_id": "1", "user_segment_key": "prospecting", "spend": "0.6"},
                             {"ad_id": "1", "user_segment_key": "existing_customers", "spend": "0.4"}]}
        if path.endswith("/ads"):
            ids = json.loads(q["filtering"])[0]["value"]
            assert len(ids) <= 50
            return {"data": [{"id": i, "name": f"Node {i}", "effective_status": "ACTIVE",
                              "creative": {"id": f"c{i}", "image_hash": f"h{i}",
                                           "image_url": f"https://scontent.fbcdn.net/{i}.jpg",
                                           "effective_object_story_id": f"55_{i}",
                                           "effective_instagram_media_id": f"77{i}"}} for i in ids]}
        if path.endswith("/comments") and path.startswith("77"):
            return {"data": [{"id": "ig1", "text": "love it", "username": "amy", "timestamp": "2026-09-02T10:00:00+0000"}]}
        if path.endswith("/comments"):
            return {"error": {"code": 10, "message": "(#10) This endpoint requires the 'pages_read_engagement' permission"}}
        if path == "55":
            return {"error": {"code": 200, "message": "(#200) Permissions error"}}
        return {"error": {"code": 803, "message": "unknown path"}}


@pytest.fixture
def fake_graph(clock, monkeypatch):
    governor.install()
    holder = {}

    def send(self, request, *a, **k):
        assert request.method == "GET"
        assert "access_token=" not in request.url
        body = holder["g"].respond(request)
        r = requests.Response()
        r.status_code = 400 if "error" in body else 200
        r._content = json.dumps(body).encode()
        r.headers["Content-Type"] = "application/json"
        r.request = request
        return r

    monkeypatch.setitem(governor._originals, "send", send)
    meta.clear_memory()
    return holder


def test_pull_is_cheap_and_complete(fake_graph):
    g = fake_graph["g"] = FakeGraph(n_ads=120)
    ads, index, notes = meta.fetch_ads("tok_" + "x" * 20, "act_5", "2026-09-01", "2026-09-30")
    assert len(ads) == 120 and not notes
    # 1 insights page + 1 segment page + 3 ad chunks of <=50
    assert len(g.calls) == 5
    assert ads[0]["ad_id"] == "120"  # sorted by spend
    a1 = next(a for a in ads if a["ad_id"] == "1")
    assert a1["segment_spend"] == {"prospecting": 0.6, "engaged": 0.0, "existing": 0.4, "unknown": 0.0}
    assert next(a for a in ads if a["ad_id"] == "2")["segment_spend"] is None
    assert a1["ad_name"] == "Node 1" and a1["creative_hash"] == "h1"
    assert index["1"]["thumb_src"] == "https://scontent.fbcdn.net/1.jpg"
    assert governor.status()["calls_last_hour"] == 5


def test_reduce_data_retries_once_with_smaller_pages(fake_graph):
    g = fake_graph["g"] = FakeGraph(n_ads=150, reduce_once=True)
    ads, _, _ = meta.fetch_ads("tok_" + "x" * 20, "act_5", "2026-09-01", "2026-09-30")
    assert len(ads) == 150
    limits = [int(q["limit"]) for p, q in g.calls if p.endswith("/insights") and "breakdowns" not in q]
    assert limits == [500, 100, 100]


def test_segment_refusal_leaves_null(fake_graph):
    fake_graph["g"] = FakeGraph(n_ads=3, segment_error=True)
    ads, _, notes = meta.fetch_ads("tok_" + "x" * 20, "act_5", "2026-09-01", "2026-09-30")
    assert all(a["segment_spend"] is None for a in ads) and notes


def test_comments_use_index_and_explain_fb_gap(fake_graph):
    g = fake_graph["g"] = FakeGraph()
    known = {"has_node": True, "story_id": "55_1", "ig_media_id": "771", "ig_permalink": "https://instagram.com/p/a"}
    out = meta.fetch_comments("tok_" + "x" * 20, "1", known)
    assert out["counts"] == {"facebook": 0, "instagram": 1}
    assert out["comments"][0]["platform"] == "instagram" and out["comments"][0]["permalink"] == "https://instagram.com/p/a"
    assert out["note"] and "pages_read_engagement" in out["note"]
    n = len(g.calls)
    # The refusal is remembered: a second ad on the same Page skips the FB call.
    meta.fetch_comments("tok_" + "x" * 20, "2", {**known, "story_id": "55_2"})
    assert len(g.calls) == n + 1


class StrictAdsGraph(FakeGraph):
    """The /ads edge as Meta runs it: DELETED in effective_status is refused
    (code 100, subcode 1815001), and optionally any page over 25 ads is too
    much data."""

    def __init__(self, n_ads=300, max_ads_page=None, refuse_status=False, **kw):
        super().__init__(n_ads=n_ads, **kw)
        self.max_ads_page = max_ads_page
        self.refuse_status = refuse_status

    def respond(self, request):
        u = urlsplit(request.url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path.endswith("/ads"):
            statuses = json.loads(q.get("effective_status", "[]"))
            if "DELETED" in statuses or (self.refuse_status and statuses):
                self.calls.append((u.path.split("/v24.0/", 1)[1], q))
                return {"error": {"code": 100, "error_subcode": 1815001,
                                  "message": "(#100) Requesting for deleted objects is not supported in this endpoint"}}
            if self.max_ads_page and int(q["limit"]) > self.max_ads_page:
                self.calls.append((u.path.split("/v24.0/", 1)[1], q))
                return {"error": {"code": 1, "message": "Please reduce the amount of data you're asking for"}}
        return super().respond(request)


def _ads_calls(g):
    return [q for p, q in g.calls if p.endswith("/ads")]


def test_ads_edge_never_asks_for_deleted(fake_graph):
    assert "DELETED" not in meta.ALL_EFFECTIVE_STATUSES and "ARCHIVED" in meta.ALL_EFFECTIVE_STATUSES
    g = fake_graph["g"] = StrictAdsGraph(n_ads=120)
    ads, _, notes = meta.fetch_ads("tok_" + "x" * 20, "act_5", "2026-09-01", "2026-09-30")
    assert not notes and all(a["creative_id"] for a in ads)
    assert len(_ads_calls(g)) == 3


def test_status_filter_refusal_is_learned_once(fake_graph):
    g = fake_graph["g"] = StrictAdsGraph(n_ads=300, refuse_status=True)
    ads, _, notes = meta.fetch_ads("tok_" + "x" * 20, "act_5", "2026-09-01", "2026-09-30")
    assert not notes and all(a["creative_id"] for a in ads)
    calls = _ads_calls(g)
    assert len(calls) == 7  # one refusal, then 6 chunks without the filter
    assert sum(1 for q in calls if "effective_status" in q) == 1


def test_smaller_chunks_after_one_reduce_data_refusal(fake_graph):
    g = fake_graph["g"] = StrictAdsGraph(n_ads=300, max_ads_page=25)
    ads, _, notes = meta.fetch_ads("tok_" + "x" * 20, "act_5", "2026-09-01", "2026-09-30")
    assert not notes and all(a["creative_id"] for a in ads)
    limits = [int(q["limit"]) for q in _ads_calls(g)]
    assert limits == [50] + [25] * 12  # one refusal for the whole pull


def test_other_chunk_errors_are_noted_once(fake_graph):
    class Broken(FakeGraph):
        def respond(self, request):
            if urlsplit(request.url).path.endswith("/ads"):
                self.calls.append(("x/ads", {}))
                return {"error": {"code": 2, "message": "Service temporarily unavailable"}}
            return super().respond(request)

    fake_graph["g"] = Broken(n_ads=150)
    ads, _, notes = meta.fetch_ads("tok_" + "x" * 20, "act_5", "2026-09-01", "2026-09-30")
    assert len(ads) == 150 and len(notes) == 1 and "creative details" in notes[0]


class MemoryCheckpoint:
    def __init__(self):
        self.steps, self.node_store = {}, {}

    def load(self, step):
        return self.steps.get(step)

    def save(self, step, value):
        self.steps[step] = value

    def nodes(self, ids):
        return {i: self.node_store[i] for i in ids if i in self.node_store}

    def save_nodes(self, nodes):
        self.node_store.update(nodes)


def test_interrupted_pull_resumes_without_paying_twice(fake_graph, clock, monkeypatch):
    g = fake_graph["g"] = FakeGraph(n_ads=300)
    monkeypatch.setenv("ODYLIC_META_MAX_PER_HOUR", "5")  # room for insights, segments and 3 of 6 chunks
    cp = MemoryCheckpoint()
    with pytest.raises(governor.MetaThrottled):
        meta.fetch_ads("tok_" + "x" * 20, "act_5", "2026-09-01", "2026-09-30", checkpoint=cp)
    assert "rows" in cp.steps and "segments" in cp.steps and len(cp.node_store) == 150
    first = len(g.calls)
    clock.t += 3601  # the hour rolls over
    ads, _, _ = meta.fetch_ads("tok_" + "x" * 20, "act_5", "2026-09-01", "2026-09-30", checkpoint=cp)
    assert len(ads) == 300 and all(a["creative_id"] for a in ads)
    assert first == 5 and len(g.calls) - first == 3  # only the 3 chunks still missing
