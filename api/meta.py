"""Meta Graph API client. Every call goes through `requests`, which the
governor wraps, so pacing, budget, breaker and the read-only rule always apply.

An ads pull runs three steps, one call after another:
  1. /act_X/insights level=ad              (metrics, names; 500 ads per page)
  2. /act_X/insights breakdowns=user_segment_key   (spend by customer segment;
     about 3 rows per ad, 500 rows per page)
  3. /act_X/ads filtered to the ad ids from step 1, 50 per call (creative fields)
For N ads that is about ceil(N/500) + ceil(3N/500) + ceil(N/50) calls: 3 for 50
ads, 5 for 150, 9 for 300, 28 for 1,000. Step 3 is skipped for ads whose nodes
were fetched in the last 6 hours (any date range), so a range change on a 300
ad account usually costs 3 calls.
"""
from __future__ import annotations

import json
import re
from typing import Iterable, Optional

import requests

from . import governor
from .governor import MetaAuthError, MetaThrottled, MetaWriteBlocked, scrub

GRAPH_VERSION = "v24.0"
GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"

governor.install()

PAGE_LIMIT = 500
SMALL_PAGE_LIMIT = 100
ADS_CHUNK = 50
MAX_PAGES = 40
THUMB_W, THUMB_H = 640, 800

ACCOUNT_FIELDS = "id,name,currency,account_status,timezone_name"

INSIGHTS_FIELDS = ",".join([
    "ad_id", "ad_name", "adset_id", "adset_name", "campaign_id", "campaign_name",
    "spend", "impressions", "clicks", "reach", "frequency", "ctr", "cpm", "cpc",
    "inline_link_clicks", "outbound_clicks", "actions", "action_values",
    "video_thruplay_watched_actions", "video_p25_watched_actions", "video_p50_watched_actions",
    "video_p75_watched_actions", "video_p100_watched_actions",
])

CREATIVE_FIELDS = (
    f"creative.thumbnail_width({THUMB_W}).thumbnail_height({THUMB_H})"
    "{id,image_url,image_hash,video_id,thumbnail_url,title,body,call_to_action_type,"
    "effective_object_story_id,effective_instagram_media_id,instagram_permalink_url,"
    "asset_feed_spec{images{url,hash},videos{video_id,thumbnail_url},bodies{text},titles{text}}}"
)
AD_FIELDS = "id,name,effective_status,created_time,adset_id,campaign_id," + CREATIVE_FIELDS

# Every status the /ads edge accepts, so paused and archived ads that spent in
# the range still come back. Not DELETED: the edge refuses it (code 100,
# subcode 1815001, "Requesting for deleted objects is not supported"). A
# deleted ad that spent still has its insights row, so it shows as a card
# without creative details.
ALL_EFFECTIVE_STATUSES = [
    "ACTIVE", "PAUSED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED",
    "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ARCHIVED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES",
]

# Action type precedence. The FIRST type present wins and the rest are ignored,
# because Meta reports the same purchase under several types (pixel, omni,
# plain) and summing them double counts.
PURCHASE_TYPES = ("offsite_conversion.fb_pixel_purchase", "omni_purchase", "purchase",
                  "onsite_web_purchase", "onsite_conversion.purchase")
ADD_TO_CART_TYPES = ("offsite_conversion.fb_pixel_add_to_cart", "omni_add_to_cart", "add_to_cart")
CHECKOUT_TYPES = ("offsite_conversion.fb_pixel_initiate_checkout", "omni_initiated_checkout", "initiate_checkout")
LEAD_TYPES = ("lead", "offsite_conversion.fb_pixel_lead", "onsite_web_lead", "leadgen_grouped",
              "onsite_conversion.lead_grouped")
LPV_TYPES = ("landing_page_view", "omni_landing_page_view")


class MetaError(Exception):
    def __init__(self, message: str, code: int = 0, subcode: Optional[int] = None, http_status: int = 502):
        super().__init__(message)
        self.message = message
        self.code = code
        self.subcode = subcode
        self.http_status = http_status


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------
def _url(path: str) -> str:
    return path if path.startswith("http") else f"{GRAPH}/{path.lstrip('/')}"


def graph_get(token: str, path: str, params: Optional[dict] = None, timeout: int = 60) -> dict:
    """One governed GET. Raises MetaThrottled, MetaAuthError or MetaError."""
    headers = {"Authorization": f"OAuth {token}"}
    try:
        resp = requests.get(_url(path), params=params or {}, headers=headers, timeout=timeout)
    except (MetaThrottled, MetaAuthError, MetaWriteBlocked):
        raise
    except requests.RequestException as e:
        raise MetaError(f"Could not reach Meta ({type(e).__name__}).", http_status=502) from None
    try:
        data = resp.json()
    except ValueError:
        raise MetaError(f"Meta returned an unreadable response (HTTP {resp.status_code}).") from None
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        err = data["error"]
        try:
            code = int(err.get("code", 0) or 0)
        except (TypeError, ValueError):
            code = 0
        sub = err.get("error_subcode")
        msg = scrub(err.get("error_user_msg") or err.get("message") or "Meta returned an error.")
        if code in governor.THROTTLE_CODES:
            raise MetaThrottled(f"Meta rate limit: {msg}")
        if code in governor.AUTH_CODES:
            raise MetaAuthError(msg)
        raise MetaError(msg, code=code, subcode=sub, http_status=resp.status_code or 502)
    if not isinstance(data, dict):
        raise MetaError("Meta returned an unexpected response.")
    return data


def is_reduce_data_error(e: MetaError) -> bool:
    """Meta's "Please reduce the amount of data you're asking for" (code 1,
    sometimes subcode 99). The fix is a smaller page, not a failure."""
    return e.code == 1 or "reduce the amount of data" in (e.message or "").lower()


def paged(token: str, path: str, params: dict, max_pages: int = MAX_PAGES,
          small_limit: int = SMALL_PAGE_LIMIT) -> list:
    """Follow `after` cursors. On a reduce-data error, retry that page ONCE
    with a smaller limit; a second refusal is raised."""
    params = dict(params)
    rows: list = []
    after: Optional[str] = None
    for _ in range(max_pages):
        p = dict(params)
        if after:
            p["after"] = after
        try:
            data = graph_get(token, path, p)
        except MetaError as e:
            if not is_reduce_data_error(e) or int(params.get("limit", 0) or 0) <= small_limit:
                raise
            params["limit"] = small_limit
            p["limit"] = small_limit
            data = graph_get(token, path, p)
        rows.extend(data.get("data") or [])
        paging = data.get("paging") or {}
        after = (paging.get("cursors") or {}).get("after")
        if not after or not paging.get("next"):
            break
    return rows


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------
def normalize_account_id(raw) -> Optional[str]:
    s = str(raw or "").strip()
    if s.startswith("act_"):
        s = s[4:]
    return f"act_{s}" if s.isdigit() else None


def normalize_account(raw: dict) -> dict:
    acct_id = normalize_account_id(raw.get("id") or raw.get("account_id")) or str(raw.get("id") or "")
    status = raw.get("account_status")
    try:
        status = int(status) if status is not None else None
    except (TypeError, ValueError):
        status = None
    return {
        "id": acct_id,
        "name": raw.get("name") or acct_id,
        "currency": raw.get("currency") or "USD",
        "account_status": status,
        "timezone_name": raw.get("timezone_name"),
    }


def me(token: str) -> dict:
    return graph_get(token, "me", {"fields": "id,name"})


def list_ad_accounts(token: str) -> list:
    rows = paged(token, "me/adaccounts", {"fields": ACCOUNT_FIELDS, "limit": 200}, max_pages=5)
    return [normalize_account(r) for r in rows]


def get_account(token: str, account_id: str) -> dict:
    return normalize_account(graph_get(token, account_id, {"fields": ACCOUNT_FIELDS}))


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------
def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def pick_action(actions, chain: Iterable[str]) -> tuple:
    """(value, action_type) for the FIRST type in `chain` present in a Meta
    action list, else (0.0, None). Never sums across types."""
    by_type = {}
    for a in actions or []:
        if isinstance(a, dict) and a.get("action_type") is not None:
            by_type.setdefault(a["action_type"], _num(a.get("value")))
    for t in chain:
        if t in by_type:
            return by_type[t], t
    return 0.0, None


def sum_action_list(arr) -> float:
    """Sum an action-style list (Meta's video_* fields carry one bucket)."""
    if isinstance(arr, (int, float, str)):
        return _num(arr)
    return sum(_num(a.get("value")) for a in (arr or []) if isinstance(a, dict))


def _ratio(n: float, d: float, mult: float = 1.0, nd: int = 2) -> Optional[float]:
    return round(n / d * mult, nd) if d else None


def parse_insights_row(r: dict) -> dict:
    """Metrics for one ad-level insights row, in the Ad contract's names."""
    actions = r.get("actions") or []
    values = r.get("action_values") or []
    spend = _num(r.get("spend"))
    impressions = int(_num(r.get("impressions")))
    clicks = int(_num(r.get("clicks")))
    reach = int(_num(r.get("reach")))

    purchases, ptype = pick_action(actions, PURCHASE_TYPES)
    if ptype:
        rev_by_type = {a.get("action_type"): _num(a.get("value")) for a in values if isinstance(a, dict)}
        revenue = rev_by_type.get(ptype)
        if revenue is None:
            revenue, _ = pick_action(values, PURCHASE_TYPES)
    else:
        revenue, _ = pick_action(values, PURCHASE_TYPES)

    link_clicks = int(_num(r.get("inline_link_clicks"))) if r.get("inline_link_clicks") is not None \
        else int(pick_action(actions, ("link_click",))[0])
    outbound = r.get("outbound_clicks")
    outbound_clicks = int(sum_action_list(outbound)) if outbound is not None \
        else int(pick_action(actions, ("outbound_click",))[0])

    purchases_i = int(round(purchases))
    return {
        "spend": round(spend, 2),
        "impressions": impressions,
        "clicks": clicks,
        "ctr": _ratio(clicks, impressions, 100.0, 4),
        "cpm": _ratio(spend, impressions, 1000.0),
        "cpc": _ratio(spend, clicks),
        "reach": reach,
        "frequency": _ratio(impressions, reach, 1.0, 4),
        "purchases": purchases_i,
        "revenue": round(revenue, 2),
        "roas": _ratio(revenue, spend, 1.0, 4),
        "cost_per_purchase": _ratio(spend, purchases_i),
        "link_clicks": link_clicks,
        "outbound_clicks": outbound_clicks,
        "landing_page_views": int(pick_action(actions, LPV_TYPES)[0]),
        "add_to_cart": int(pick_action(actions, ADD_TO_CART_TYPES)[0]),
        "initiate_checkout": int(pick_action(actions, CHECKOUT_TYPES)[0]),
        "leads": int(pick_action(actions, LEAD_TYPES)[0]),
        "video_3s_views": int(pick_action(actions, ("video_view",))[0]),
        "thruplays": int(sum_action_list(r.get("video_thruplay_watched_actions"))),
        "video_p25": int(sum_action_list(r.get("video_p25_watched_actions"))),
        "video_p50": int(sum_action_list(r.get("video_p50_watched_actions"))),
        "video_p75": int(sum_action_list(r.get("video_p75_watched_actions"))),
        "video_p100": int(sum_action_list(r.get("video_p100_watched_actions"))),
        "post_reactions": int(pick_action(actions, ("post_reaction", "like"))[0]),
        "post_comments": int(pick_action(actions, ("comment",))[0]),
        "post_shares": int(pick_action(actions, ("post", "share"))[0]),
    }


def segment_bucket(raw: Optional[str]) -> str:
    """Map a Meta `user_segment_key` value to prospecting | engaged |
    existing | unknown. Loose prefix / substring matching so Meta relabels
    still land; anything unrecognized is `unknown` (never redistributed)."""
    s = (raw or "").strip().lower()
    if not s or s in ("unknown", "none", "n/a", "not_available"):
        return "unknown"
    if s.startswith("prospect") or s.startswith("new") or "acquisition" in s:
        return "prospecting"
    if s.startswith("engag") or "consider" in s:
        return "engaged"
    if (s.startswith("exist") or s.startswith("repeat") or "purchas" in s
            or "customer" in s or "return" in s or "retention" in s or "loyal" in s):
        return "existing"
    return "unknown"


def empty_segment_spend() -> dict:
    return {"prospecting": 0.0, "engaged": 0.0, "existing": 0.0, "unknown": 0.0}


def build_segment_spend(rows: list) -> dict:
    """{ad_id: {prospecting, engaged, existing, unknown}} from breakdown rows."""
    out: dict = {}
    for r in rows:
        ad_id = str(r.get("ad_id") or "")
        if not ad_id:
            continue
        seg = segment_bucket(r.get("user_segment_key"))
        entry = out.setdefault(ad_id, empty_segment_spend())
        entry[seg] += _num(r.get("spend"))
    for entry in out.values():
        for k in entry:
            entry[k] = round(entry[k], 2)
    return out


def _creative_details(node: dict) -> dict:
    """Flatten an ad node's creative, filling gaps from asset_feed_spec
    (dynamic creative) and choosing the thumbnail source."""
    c = dict(node.get("creative") or {})
    afs = c.get("asset_feed_spec") if isinstance(c.get("asset_feed_spec"), dict) else {}
    imgs = afs.get("images") or []
    vids = afs.get("videos") or []
    if not c.get("image_url") and imgs:
        c["image_url"] = (imgs[0] or {}).get("url")
    if not c.get("image_hash") and imgs:
        c["image_hash"] = (imgs[0] or {}).get("hash")
    if not c.get("video_id") and vids:
        c["video_id"] = (vids[0] or {}).get("video_id")
        c["thumbnail_url"] = c.get("thumbnail_url") or (vids[0] or {}).get("thumbnail_url")
    if not c.get("body") and afs.get("bodies"):
        c["body"] = (afs["bodies"][0] or {}).get("text")
    if not c.get("title") and afs.get("titles"):
        c["title"] = (afs["titles"][0] or {}).get("text")
    # Videos: the creative thumbnail (sized 640x800 in the request) is the
    # video's poster frame. Statics: the full image keeps its own aspect.
    if c.get("video_id"):
        thumb_src = c.get("thumbnail_url") or c.get("image_url")
    else:
        thumb_src = c.get("image_url") or c.get("thumbnail_url")
    c["_thumb_src"] = thumb_src
    return c


def ads_manager_url(account_id: str, ad_id: str) -> str:
    digits = account_id[4:] if account_id.startswith("act_") else account_id
    return f"https://adsmanager.facebook.com/adsmanager/manage/ads?act={digits}&selected_ad_ids={ad_id}"


def build_ad(account_id: str, row: dict, node: Optional[dict], segments: Optional[dict]) -> tuple:
    """(Ad dict, index entry) for one ad."""
    ad_id = str(row.get("ad_id") or (node or {}).get("id") or "")
    node = node or {}
    c = _creative_details(node) if node else {}
    image_hash = c.get("image_hash") or None
    video_id = str(c["video_id"]) if c.get("video_id") else None
    creative_id = str(c["id"]) if c.get("id") else None
    ad = {
        "ad_id": ad_id,
        "ad_name": node.get("name") or row.get("ad_name") or ad_id,
        "adset_id": str(row.get("adset_id") or node.get("adset_id") or "") or None,
        "adset_name": row.get("adset_name"),
        "campaign_id": str(row.get("campaign_id") or node.get("campaign_id") or "") or None,
        "campaign_name": row.get("campaign_name"),
        "effective_status": node.get("effective_status"),
        "created_time": node.get("created_time"),
        "creative_id": creative_id,
        "creative_hash": image_hash or video_id or creative_id or ad_id,
        "image_hash": image_hash,
        "video_id": video_id,
        "is_video": bool(video_id),
        "thumbnail_url": f"/api/thumb/{ad_id}",
        "image_url": f"/api/thumb/{ad_id}",
        "title": c.get("title") or None,
        "body": c.get("body") or None,
        "call_to_action_type": c.get("call_to_action_type"),
        "account_id": account_id,
        "effective_object_story_id": c.get("effective_object_story_id"),
        "instagram_permalink_url": c.get("instagram_permalink_url"),
        "ads_manager_url": ads_manager_url(account_id, ad_id),
    }
    ad.update(parse_insights_row(row))
    ad["segment_spend"] = None if segments is None else segments.get(ad_id)
    thumb_alt = c.get("thumbnail_url") if c.get("thumbnail_url") != c.get("_thumb_src") else None
    index = {
        "account": account_id,
        "thumb_src": c.get("_thumb_src"),
        "thumb_alt": thumb_alt,
        "thumb_key": image_hash or video_id or creative_id,
        "story_id": c.get("effective_object_story_id"),
        "ig_media_id": c.get("effective_instagram_media_id"),
        "ig_permalink": c.get("instagram_permalink_url"),
        "has_node": bool(node),
    }
    return ad, index


# ---------------------------------------------------------------------------
# The ads pull
# ---------------------------------------------------------------------------
def is_status_filter_error(e: MetaError) -> bool:
    """The /ads edge refusing the effective_status filter (or a status in it)."""
    m = (e.message or "").lower()
    return e.code == 100 and (e.subcode == 1815001 or "deleted" in m or "effective_status" in m)


class _NoCheckpoint:
    """fetch_ads without saving anything between attempts."""

    def load(self, step):
        return None

    def save(self, step, value):
        pass

    def nodes(self, ids):
        return {}

    def save_nodes(self, nodes):
        pass


def fetch_ad_nodes(token: str, account_id: str, ids: list, notes: list) -> dict:
    """{ad_id: node} for the ids, 50 per call. Learns once per pull: after a
    "reduce the amount of data" refusal every later chunk is 25 ids (one
    page each); after a refusal of the status filter, later chunks go
    without it. A chunk that fails for another reason is noted and skipped.
    Nodes fetched before an exception (a pause, a dead token) are kept in
    `nodes_so_far` on the exception so the caller can save them."""
    nodes: dict = {}
    statuses: Optional[list] = list(ALL_EFFECTIVE_STATUSES)
    size = ADS_CHUNK
    i = 0
    try:
        while i < len(ids):
            chunk = ids[i:i + size]
            # On the /ads edge the id filter field is "id" ("ad.id" is the
            # insights spelling).
            base = {
                "fields": AD_FIELDS,
                "filtering": json.dumps([{"field": "id", "operator": "IN", "value": chunk}]),
                "limit": len(chunk),
            }
            if statuses:
                base["effective_status"] = json.dumps(statuses)
            try:
                got = paged(token, f"{account_id}/ads", base, max_pages=2, small_limit=len(chunk))
            except MetaError as e:
                if statuses and is_status_filter_error(e):
                    statuses = None
                    continue  # the same ids again, without the filter
                if is_reduce_data_error(e) and size > 25:
                    size = 25
                    continue  # the same ids again, in smaller chunks
                msg = f"Some creative details could not be loaded ({e.message[:120]})."
                if msg not in notes:
                    notes.append(msg)
                i += len(chunk)
                continue
            for n in got:
                if n.get("id"):
                    nodes[str(n["id"])] = n
            i += len(chunk)
    except Exception as e:
        try:
            e.nodes_so_far = nodes  # type: ignore[attr-defined]
        except AttributeError:
            pass
        raise
    return nodes


def fetch_ads(token: str, account_id: str, since: str, until: str, checkpoint=None) -> tuple:
    """(ads, index, notes). Sequential, governed, cheap.

    `checkpoint` (optional) saves each finished step and every fetched ad
    node, and hands them back on the next attempt, so a pull a pause
    interrupted continues where it stopped (see main._PullCheckpoint)."""
    cp = checkpoint or _NoCheckpoint()
    time_range = json.dumps({"since": since, "until": until})
    notes: list = []

    # 1. Metrics per ad.
    rows = cp.load("rows")
    if not isinstance(rows, list):
        rows = paged(token, f"{account_id}/insights", {
            "level": "ad",
            "time_range": time_range,
            "fields": INSIGHTS_FIELDS,
            "use_account_attribution_setting": "true",
            "limit": PAGE_LIMIT,
        })
        rows = [r for r in rows if r.get("ad_id")]
        cp.save("rows", rows)
    if not rows:
        return [], {}, notes

    # 2. Spend by customer segment. Optional: a refusal leaves it null.
    saved = cp.load("segments")
    if isinstance(saved, dict):
        segments = saved.get("segments")
        if saved.get("note"):
            notes.append(saved["note"])
    else:
        note = None
        try:
            seg_rows = paged(token, f"{account_id}/insights", {
                "level": "ad",
                "time_range": time_range,
                "fields": "ad_id,spend",
                "breakdowns": "user_segment_key",
                "use_account_attribution_setting": "true",
                "limit": PAGE_LIMIT,
            })
            segments = build_segment_spend(seg_rows)
        except MetaError as e:
            segments = None
            note = f"Meta did not return customer segments for this account ({e.message[:120]})."
            notes.append(note)
        cp.save("segments", {"segments": segments, "note": note})

    # 3. Names, status and creative fields, only for ads not fetched lately.
    ids = [str(r["ad_id"]) for r in rows]
    nodes = cp.nodes(ids)
    missing = [i for i in ids if i not in nodes]
    if missing:
        try:
            fresh = fetch_ad_nodes(token, account_id, missing, notes)
        except Exception as e:
            cp.save_nodes(getattr(e, "nodes_so_far", None) or {})
            raise
        cp.save_nodes(fresh)
        nodes.update(fresh)

    ads, index = [], {}
    for r in rows:
        ad, idx = build_ad(account_id, r, nodes.get(str(r["ad_id"])), segments)
        ads.append(ad)
        index[ad["ad_id"]] = idx
    ads.sort(key=lambda a: a["spend"], reverse=True)
    return ads, index, notes


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------
_PAGE_TOKENS: dict = {}       # page_id to page token (memory only, never on disk)
_FB_BLOCKED: dict = {}        # page_id or "*" to reason


def clear_memory() -> None:
    _PAGE_TOKENS.clear()
    _FB_BLOCKED.clear()


def _is_permission_error(e: MetaError) -> bool:
    m = (e.message or "").lower()
    return e.code in (10, 200) or any(t in m for t in (
        "permission", "pages_read", "page public content access", "not authorized", "does not have access"))


def _page_token(token: str, page_id: str) -> Optional[str]:
    if page_id in _PAGE_TOKENS:
        return _PAGE_TOKENS[page_id]
    try:
        data = graph_get(token, page_id, {"fields": "access_token"})
        tok = data.get("access_token") or None
    except MetaError:
        tok = None
    _PAGE_TOKENS[page_id] = tok
    return tok


def normalize_fb_comment(raw: dict) -> dict:
    return {
        "id": str(raw.get("id") or ""),
        "platform": "facebook",
        "author": ((raw.get("from") or {}).get("name")) or None,
        "text": raw.get("message") or "",
        "created_time": raw.get("created_time") or "",
        "like_count": int(_num(raw.get("like_count"))),
        "permalink": raw.get("permalink_url") or None,
    }


def normalize_ig_comment(raw: dict, media_permalink: Optional[str] = None) -> dict:
    return {
        "id": str(raw.get("id") or ""),
        "platform": "instagram",
        "author": raw.get("username") or None,
        "text": raw.get("text") or "",
        "created_time": raw.get("timestamp") or "",
        "like_count": int(_num(raw.get("like_count"))),
        "permalink": media_permalink,
    }


def fetch_comments(token: str, ad_id: str, known: Optional[dict] = None) -> dict:
    """Comments on the ad's Facebook post and Instagram media.
    `known` is the ad's index entry (post ids from the last ads pull), which
    saves the lookup call."""
    known = known or {}
    story_id = known.get("story_id")
    ig_media_id = known.get("ig_media_id")
    ig_permalink = known.get("ig_permalink")
    if not known.get("has_node"):
        node = graph_get(token, ad_id, {
            "fields": "creative{effective_object_story_id,effective_instagram_media_id,instagram_permalink_url}"})
        c = node.get("creative") or {}
        story_id = c.get("effective_object_story_id")
        ig_media_id = c.get("effective_instagram_media_id")
        ig_permalink = c.get("instagram_permalink_url")

    comments: list = []
    counts = {"facebook": 0, "instagram": 0}
    notes: list = []

    if ig_media_id:
        try:
            data = graph_get(token, f"{ig_media_id}/comments",
                             {"fields": "id,text,username,timestamp,like_count", "limit": 100})
            got = [normalize_ig_comment(c, ig_permalink) for c in data.get("data") or []]
            comments.extend(got)
            counts["instagram"] = len(got)
        except MetaError as e:
            if _is_permission_error(e):
                notes.append("Instagram comments need the instagram_basic and pages_read_engagement "
                             "permissions on this token.")
            else:
                notes.append(f"Instagram comments could not be loaded ({e.message[:120]}).")

    if story_id:
        page_id = story_id.split("_", 1)[0] if "_" in story_id else None
        if "*" in _FB_BLOCKED or (page_id and page_id in _FB_BLOCKED):
            notes.append(_FB_BLOCKED.get("*") or _FB_BLOCKED.get(page_id))
        else:
            use = (_page_token(token, page_id) if page_id else None) or token
            try:
                data = graph_get(use, f"{story_id}/comments", {
                    "fields": "id,message,from{name},created_time,like_count,permalink_url",
                    "limit": 100, "order": "reverse_chronological"})
                got = [normalize_fb_comment(c) for c in data.get("data") or []]
                comments.extend(got)
                counts["facebook"] = len(got)
            except MetaAuthError:
                raise
            except MetaError as e:
                if _is_permission_error(e):
                    msg = ("Facebook comments could not be read: Meta requires the pages_read_engagement "
                           "permission on the Page (and for some Pages, Page Public Content Access).")
                    m = (e.message or "").lower()
                    _FB_BLOCKED["*" if ("pages_read_user_content" in m or "page public content" in m)
                                else (page_id or "*")] = msg
                    notes.append(msg)
                else:
                    notes.append(f"Facebook comments could not be loaded ({e.message[:120]}).")

    if not story_id and not ig_media_id:
        notes.append("This ad does not point to a single published post (for example dynamic creative or a "
                     "catalog ad), so there is no comment thread to read.")

    comments.sort(key=lambda c: c.get("created_time") or "", reverse=True)
    return {"ad_id": ad_id, "comments": comments, "counts": counts,
            "note": " ".join(n for n in notes if n) or None}


_SAFE_ID = re.compile(r"^\d{1,40}$")


def is_numeric_id(s: str) -> bool:
    return bool(_SAFE_ID.match(str(s or "")))


# ---------------------------------------------------------------------------
# Ad charts (the drawer's Charts tab)
# ---------------------------------------------------------------------------
# One insights call per chart, filtered to the ad, or to every ad that runs
# the same creative when the space stacks them (one ad.id IN filter, so a
# stack costs the same single call). Rows go through parse_insights_row, so
# purchases and revenue match the ads pull, then they are summed per day or
# per breakdown key here. More than one call only when a long range or a big
# stack needs a second page.

CHART_MAX_ADS = 50

CHART_SUM_FIELDS = (
    "spend", "impressions", "clicks", "reach", "purchases", "revenue", "link_clicks", "outbound_clicks",
    "landing_page_views", "add_to_cart", "initiate_checkout", "leads", "video_3s_views", "thruplays",
    "video_p25", "video_p50", "video_p75", "video_p100", "post_reactions", "post_comments", "post_shares",
)
_MONEY_FIELDS = ("spend", "revenue")

DAILY_FIELDS = ",".join([
    "ad_id", "spend", "impressions", "clicks", "reach", "inline_link_clicks", "outbound_clicks",
    "actions", "action_values", "video_thruplay_watched_actions", "video_p25_watched_actions",
    "video_p50_watched_actions", "video_p75_watched_actions", "video_p100_watched_actions",
])
BREAKDOWN_FIELDS = "ad_id,spend,impressions,clicks,reach,inline_link_clicks,actions,action_values"
# The user_segment_key breakdown takes a narrower field set (Atelier's, which
# works in production): no clicks, so clicks come from ctr x impressions.
SEGMENT_FIELDS = "ad_id,spend,impressions,reach,ctr,actions,action_values"
CURVE_FIELDS = "ad_id,video_play_curve_actions,video_play_actions"

# Chart kind to Meta's breakdowns parameter.
BREAKDOWNS = {
    "age": "age",
    "gender": "gender",
    "age_gender": "age,gender",
    "placement": "publisher_platform,platform_position",
    "platform": "publisher_platform",
    "device": "impression_device",
    "segment": "user_segment_key",
}

# Fields Meta leaves out when a breakdown does not report them (clicks by
# customer segment, video quartiles on a static image). A chart field whose
# raw source never came back on any row is dropped, so a gap never reads as
# a zero. Fields read from the action lists are always kept: an empty list
# is a real zero.
_OPTIONAL_SOURCES = {
    "clicks": ("clicks", "ctr"),
    "reach": ("reach",),
    "link_clicks": ("inline_link_clicks", "actions"),
    "outbound_clicks": ("outbound_clicks",),
    "thruplays": ("video_thruplay_watched_actions",),
    "video_p25": ("video_p25_watched_actions",),
    "video_p50": ("video_p50_watched_actions",),
    "video_p75": ("video_p75_watched_actions",),
    "video_p100": ("video_p100_watched_actions",),
}

AGE_ORDER = ("13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+", "unknown")
GENDER_ORDER = ("female", "male", "unknown")
SEGMENT_ORDER = ("prospecting", "engaged", "existing", "unknown")
SEGMENT_LABEL = {"prospecting": "New (prospecting)", "engaged": "Engaged", "existing": "Existing",
                 "unknown": "Unknown"}
PLATFORM_LABEL = {
    "facebook": "Facebook", "instagram": "Instagram", "audience_network": "Audience Network",
    "messenger": "Messenger", "threads": "Threads", "whatsapp": "WhatsApp", "unknown": "Unknown",
}
POSITION_LABEL = {
    "feed": "Feed", "story": "Stories", "facebook_stories": "Stories", "instagram_stories": "Stories",
    "instagram_reels": "Reels", "facebook_reels": "Reels", "facebook_reels_overlay": "Reels overlay",
    "instagram_explore": "Explore", "instagram_explore_grid_home": "Explore home",
    "instagram_profile_feed": "Profile feed", "instagram_profile_reels": "Profile reels",
    "profile_feed": "Profile feed", "instream_video": "In-stream video", "video_feeds": "Video feeds",
    "marketplace": "Marketplace", "search": "Search", "right_hand_column": "Right column",
    "an_classic": "Classic", "rewarded_video": "Rewarded video", "messenger_inbox": "Inbox",
    "messenger_stories": "Stories", "notification": "Notifications", "unknown": "Unknown",
}
DEVICE_LABEL = {
    "iphone": "iPhone", "ipad": "iPad", "ipod": "iPod", "android_smartphone": "Android phone",
    "android_tablet": "Android tablet", "desktop": "Desktop", "other": "Other", "unknown": "Unknown",
}

# Meta's video_play_curve_actions has 22 entries: seconds 0 to 14, then the
# ranges 15-20, 20-25, 25-30, 30-40, 40-50 and 50-60 seconds, then 60 seconds
# and over. Each point is placed at the second its range starts.
CURVE_SECONDS = tuple(range(15)) + (15, 20, 25, 30, 40, 50, 60)


def _title(raw: str) -> str:
    s = str(raw or "").replace("_", " ").strip()
    return s[:1].upper() + s[1:] if s else "Unknown"


def platform_label(p: str) -> str:
    return PLATFORM_LABEL.get(p) or _title(p)


def position_label(p: str) -> str:
    if p in POSITION_LABEL:
        return POSITION_LABEL[p]
    return _title(re.sub(r"^(instagram|facebook|messenger|an|threads)_", "", p or ""))


def chart_ratios(row: dict) -> dict:
    """Round the money and (re)compute the contract's ratios from the row's
    own sums. A ratio over zero is None; a ratio whose input Meta did not
    report (no clicks, no reach) is None too."""
    spend = _num(row.get("spend"))
    imp = _num(row.get("impressions"))
    clicks = row.get("clicks")
    reach = row.get("reach")
    rev = _num(row.get("revenue"))
    for f in _MONEY_FIELDS:
        if f in row:
            row[f] = round(_num(row[f]), 2)
    row["ctr"] = _ratio(_num(clicks), imp, 100.0, 4) if clicks is not None else None
    row["cpm"] = _ratio(spend, imp, 1000.0)
    row["cpc"] = _ratio(spend, _num(clicks)) if clicks is not None else None
    row["frequency"] = _ratio(imp, _num(reach), 1.0, 4) if reach is not None else None
    row["roas"] = _ratio(rev, spend, 1.0, 4)
    row["cost_per_purchase"] = _ratio(spend, _num(row.get("purchases")))
    return row


def sum_chart_rows(rows: list, dims: Iterable[str] = ()) -> dict:
    """One row: the summed fields (only those the rows carry), the `dims`
    copied from the leading row, then the ratios."""
    out: dict = {}
    if rows:
        for d in dims:
            out[d] = rows[0].get(d)
    for f in CHART_SUM_FIELDS:
        if not any(f in r for r in rows):
            continue
        total = sum(_num(r.get(f)) for r in rows)
        out[f] = round(total, 2) if f in _MONEY_FIELDS else int(round(total))
    return chart_ratios(out)


def _present_sources(raw_rows: list) -> set:
    keys: set = set()
    for r in raw_rows:
        if isinstance(r, dict):
            keys.update(k for k, v in r.items() if v is not None)
    return keys


def parse_chart_rows(raw_rows: list) -> list:
    """parse_insights_row for each row, minus the fields Meta never reported."""
    present = _present_sources(raw_rows)
    absent = [f for f, src in _OPTIONAL_SOURCES.items() if not any(s in present for s in src)]
    out = []
    for r in raw_rows:
        m = parse_insights_row(r)
        for f in absent:
            m.pop(f, None)
        out.append({f: m[f] for f in CHART_SUM_FIELDS if f in m})
    return out


def _next_day(d: str) -> str:
    from datetime import date, timedelta
    return (date.fromisoformat(d) + timedelta(days=1)).isoformat()


def combine_days(rows: list) -> list:
    """Rows with a `date` (one per ad per day) summed per day, sorted, with
    the days between the first and the latest delivery day filled with
    zeros, so a pause shows as a dip and never as a line drawn across it."""
    by_day: dict = {}
    for r in rows:
        d = str(r.get("date") or "")[:10]
        if d:
            by_day.setdefault(d, []).append(r)
    if not by_day:
        return []
    fields = [f for f in CHART_SUM_FIELDS if any(f in r for r in rows)]
    days = sorted(by_day)
    out, d = [], days[0]
    while d <= days[-1]:
        group = by_day.get(d) or [{f: 0 for f in fields}]
        out.append({"date": d, **sum_chart_rows(group)})
        d = _next_day(d)
    return out


def breakdown_key(kind: str, r: dict) -> tuple:
    """(key, dims) for one raw breakdown row (or a demo row carrying the
    same Meta fields)."""
    if kind in ("age", "gender", "age_gender"):
        age = str(r.get("age") or "unknown")
        gender = str(r.get("gender") or "unknown").lower()
        if kind == "age":
            return age, {"age": age}
        if kind == "gender":
            return gender, {"gender": gender}
        return f"{age}|{gender}", {"age": age, "gender": gender}
    if kind in ("placement", "platform"):
        plat = str(r.get("publisher_platform") or "unknown")
        if kind == "platform":
            return plat, {"platform": plat}
        pos = str(r.get("platform_position") or "unknown")
        return f"{plat}/{pos}", {"platform": plat, "position": pos}
    if kind == "device":
        dev = str(r.get("impression_device") or "unknown")
        return dev, {"device": dev}
    if kind == "segment":
        seg = segment_bucket(r.get("user_segment_key"))
        return seg, {"segment": seg}
    raise ValueError(f"unknown breakdown kind {kind!r}")


def _label(kind: str, row: dict) -> dict:
    if kind == "age":
        return {"label": row["age"] if row["age"] != "unknown" else "Unknown"}
    if kind == "gender":
        return {"label": _title(row["gender"])}
    if kind == "age_gender":
        return {"label": f"{row['age'] if row['age'] != 'unknown' else 'Unknown'}, {_title(row['gender'])}"}
    if kind == "placement":
        pl, po = platform_label(row["platform"]), position_label(row["position"])
        return {"label": f"{pl} {po}", "platform_label": pl, "position_label": po}
    if kind == "platform":
        return {"label": platform_label(row["platform"])}
    if kind == "device":
        return {"label": DEVICE_LABEL.get(row["device"]) or _title(row["device"])}
    return {"label": SEGMENT_LABEL.get(row["segment"], "Unknown")}


def _order(seq: tuple, v: str) -> int:
    return seq.index(v) if v in seq else len(seq)


def combine_breakdown(kind: str, keyed: list) -> list:
    """`keyed` is [(key, dims, metrics)] (one per ad per breakdown cell).
    Returns one row per key: {key, label, dims..., sums..., ratios...}."""
    groups: dict = {}
    for key, dims, m in keyed:
        g = groups.setdefault(key, (dims, []))
        g[1].append(m)
    rows = []
    for key, (dims, ms) in groups.items():
        row = {"key": key, **dims, **sum_chart_rows(ms)}
        row.update(_label(kind, row))
        rows.append(row)
    if kind == "age":
        rows.sort(key=lambda r: _order(AGE_ORDER, r["age"]))
    elif kind == "gender":
        rows.sort(key=lambda r: _order(GENDER_ORDER, r["gender"]))
    elif kind == "age_gender":
        rows.sort(key=lambda r: (_order(AGE_ORDER, r["age"]), _order(GENDER_ORDER, r["gender"])))
    elif kind == "segment":
        rows.sort(key=lambda r: _order(SEGMENT_ORDER, r["segment"]))
    else:
        rows.sort(key=lambda r: -_num(r.get("spend")))
    return rows


def curve_values(curve_actions) -> list:
    """The first curve in a video_play_curve_actions list, as numbers."""
    for entry in curve_actions or []:
        if not isinstance(entry, dict):
            continue
        raw = entry.get("value") if entry.get("value") is not None else entry.get("values")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = None
        if isinstance(raw, list) and raw:
            return [_num(v) for v in raw]
    return []


def combine_curves(curves: list) -> list:
    """Weighted mean of percent curves, [(values, plays)]: each ad counts by
    its video plays (equally when no plays are known)."""
    curves = [(v, max(0.0, _num(w))) for v, w in curves if v]
    if not curves:
        return []
    if not any(w > 0 for _, w in curves):
        curves = [(v, 1.0) for v, _ in curves]
    n = max(len(v) for v, _ in curves)
    total = sum(w for _, w in curves)
    return [sum((v[i] if i < len(v) else 0.0) * w for v, w in curves) / total for i in range(n)]


def curve_points(values: list) -> list:
    """[{index, second, label, pct}] with pct = share of plays still watching
    (the curve's peak is 100). Trailing zeros past the end of the video go."""
    vals = [max(0.0, _num(v)) for v in values or []]
    while len(vals) > 1 and vals[-1] == 0:
        vals.pop()
    peak = max(vals) if vals else 0.0
    if peak <= 0:
        return []
    bucketed = len(values or []) <= len(CURVE_SECONDS)
    out = []
    for i, v in enumerate(vals):
        sec = CURVE_SECONDS[i] if bucketed else i
        label = "1:00+" if bucketed and i == len(CURVE_SECONDS) - 1 else f"{sec // 60}:{sec % 60:02d}"
        out.append({"index": i, "second": sec, "label": label, "pct": round(v / peak * 100.0, 2)})
    return out


def _ad_filter(ad_ids: list) -> str:
    return json.dumps([{"field": "ad.id", "operator": "IN", "value": [str(i) for i in ad_ids]}])


def fetch_ad_daily(token: str, account_id: str, ad_ids: list, since: str, until: str) -> list:
    """Per-day rows for the ads, summed per day (one insights call)."""
    raw = paged(token, f"{account_id}/insights", {
        "level": "ad",
        "time_range": json.dumps({"since": since, "until": until}),
        "time_increment": 1,
        "filtering": _ad_filter(ad_ids),
        "fields": DAILY_FIELDS,
        "use_account_attribution_setting": "true",
        "limit": PAGE_LIMIT,
    })
    raw = [r for r in raw if r.get("date_start")]
    parsed = parse_chart_rows(raw)
    return combine_days([{"date": str(r["date_start"])[:10], **m} for r, m in zip(raw, parsed)])


def _clicks_from_ctr(r: dict) -> dict:
    if r.get("clicks") is None and r.get("ctr") is not None:
        return {**r, "clicks": str(int(round(_num(r.get("ctr")) / 100.0 * _num(r.get("impressions")))))}
    return r


def fetch_ad_breakdown(token: str, account_id: str, ad_ids: list, kind: str, since: str, until: str) -> list:
    """One breakdown for the ads, summed per breakdown key (one insights call)."""
    raw = paged(token, f"{account_id}/insights", {
        "level": "ad",
        "time_range": json.dumps({"since": since, "until": until}),
        "filtering": _ad_filter(ad_ids),
        "fields": SEGMENT_FIELDS if kind == "segment" else BREAKDOWN_FIELDS,
        "breakdowns": BREAKDOWNS[kind],
        "use_account_attribution_setting": "true",
        "limit": PAGE_LIMIT,
    })
    if kind == "segment":
        raw = [_clicks_from_ctr(r) for r in raw]
    parsed = parse_chart_rows(raw)
    return combine_breakdown(kind, [(*breakdown_key(kind, r), m) for r, m in zip(raw, parsed)])


def fetch_ad_video_curve(token: str, account_id: str, ad_ids: list, since: str, until: str) -> list:
    """Meta's retention curve for the ads (one insights call), the ads'
    curves averaged by their video plays."""
    raw = paged(token, f"{account_id}/insights", {
        "level": "ad",
        "time_range": json.dumps({"since": since, "until": until}),
        "filtering": _ad_filter(ad_ids),
        "fields": CURVE_FIELDS,
        "limit": PAGE_LIMIT,
    })
    curves = [(curve_values(r.get("video_play_curve_actions")), sum_action_list(r.get("video_play_actions")))
              for r in raw]
    return curve_points(combine_curves(curves))
