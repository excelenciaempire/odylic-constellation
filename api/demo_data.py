"""Synthetic demo brand for Odylic Constellation.

Reads api/demo/demo.json once (built by api/demo/build_demo.py) and turns its per-30-day base
numbers into full Ad dicts for any date range. Pure stdlib, deterministic for a given
(since, until, today).
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Optional

DEMO_DIR = Path(__file__).resolve().parent / "demo"
THUMBS_DIR = DEMO_DIR / "thumbs"
_DATA: Optional[dict] = None
_BY_ID: dict = {}


def _data() -> dict:
    global _DATA, _BY_ID
    if _DATA is None:
        _DATA = json.loads((DEMO_DIR / "demo.json").read_text(encoding="utf-8"))
        _BY_ID = {a["ad_id"]: a for a in _DATA["ads"]}
    return _DATA


def _today() -> date:
    return date.today()


def _parse(d: str) -> date:
    return datetime.strptime(d, "%Y-%m-%d").date()


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S+0000")


def _rng(*parts) -> random.Random:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def _div(a: float, b: float, mult: float = 1.0):
    return round(a / b * mult, 4) if b else None


def demo_account() -> dict:
    return dict(_data()["account"])


def _created_dt(base: dict, today: date) -> datetime:
    d = today - timedelta(days=base["created_days_ago"])
    r = _rng(base["ad_id"], "created")
    return datetime.combine(d, time(r.randint(8, 21), r.randint(0, 59), r.randint(0, 59)), tzinfo=timezone.utc)


def _build_ad(base: dict, since: date, until: date, today: date) -> Optional[dict]:
    created = _created_dt(base, today)
    if created.date() > until:
        return None
    start = max(since, created.date())
    end = until
    if base.get("stopped_days_ago") is not None:
        end = min(end, today - timedelta(days=base["stopped_days_ago"]))
    days = (end - start).days + 1
    if days <= 0:
        return None

    b = base["base30"]
    r = _rng(base["ad_id"], since.isoformat(), until.isoformat())
    spend = round(b["spend"] * days / 30.0 * r.uniform(0.82, 1.18), 2)
    if spend <= 0:
        return None
    cpm = b["cpm"] * r.uniform(0.92, 1.08)
    ctr = b["ctr"] * r.uniform(0.9, 1.1)
    roas_t = min(5.0, b["roas"] * r.uniform(0.85, 1.15))
    impressions = max(1, int(round(spend / cpm * 1000)))
    clicks = int(round(impressions * ctr / 100))
    link_clicks = int(round(clicks * r.uniform(0.55, 0.7)))
    outbound = int(round(link_clicks * r.uniform(0.92, 0.98)))
    lpv = int(round(link_clicks * b["lpv_rate"]))
    aov = b["aov"] * r.uniform(0.95, 1.05)
    purchases = int(round(spend * roas_t / aov))
    revenue = round(purchases * aov, 2)
    atc = max(int(round(lpv * b["atc_rate"])), int(round(purchases * r.uniform(2.4, 3.6))))
    ic = max(purchases, int(round(atc * r.uniform(0.42, 0.6))))
    freq = 1.0 + (b["freq"] - 1.0) * (days / 30.0) ** 0.6
    freq = max(1.0, freq * r.uniform(0.95, 1.05))
    reach = max(1, int(round(impressions / freq)))
    freq = impressions / reach

    if base["is_video"]:
        v3 = int(round(impressions * b["hook"]))
        thru = int(round(v3 * b["hold"]))
        p25 = int(round(v3 * r.uniform(0.5, 0.62)))
        p50 = int(round(p25 * r.uniform(0.55, 0.68)))
        p75 = int(round(p50 * r.uniform(0.6, 0.72)))
        p100 = int(round(p75 * r.uniform(0.55, 0.7)))
    else:
        v3 = thru = p25 = p50 = p75 = p100 = 0

    seg = None
    mix = base.get("segment_mix")
    if mix:
        keys = ("prospecting", "engaged", "existing", "unknown")
        w = {k: mix[k] * r.uniform(0.92, 1.08) for k in keys}
        tot = sum(w.values())
        seg = {k: round(spend * w[k] / tot, 2) for k in keys}
        big = max(keys, key=lambda k: seg[k])
        seg[big] = round(seg[big] + (spend - sum(seg.values())), 2)

    vid = base["video_id"]
    return {
        "ad_id": base["ad_id"],
        "ad_name": base["ad_name"],
        "adset_id": base["adset_id"],
        "adset_name": base["adset_name"],
        "campaign_id": base["campaign_id"],
        "campaign_name": base["campaign_name"],
        "effective_status": base["effective_status"],
        "created_time": _iso(created),
        "creative_id": base["creative_id"],
        "creative_hash": base["image_hash"] or vid or base["creative_id"],
        "image_hash": base["image_hash"],
        "video_id": vid,
        "is_video": bool(base["is_video"]),
        "thumbnail_url": f"/api/thumb/{base['ad_id']}",
        "image_url": f"/api/thumb/{base['ad_id']}",
        "title": base["title"],
        "body": base["body"],
        "call_to_action_type": base["call_to_action_type"],
        "account_id": "act_demo",
        "effective_object_story_id": base["effective_object_story_id"],
        "instagram_permalink_url": None,
        "ads_manager_url": None,
        "spend": spend,
        "impressions": impressions,
        "clicks": clicks,
        "ctr": _div(clicks, impressions, 100),
        "cpm": _div(spend, impressions, 1000),
        "cpc": _div(spend, clicks),
        "reach": reach,
        "frequency": round(freq, 4),
        "purchases": purchases,
        "revenue": revenue,
        "roas": _div(revenue, spend),
        "cost_per_purchase": _div(spend, purchases),
        "link_clicks": link_clicks,
        "outbound_clicks": outbound,
        "landing_page_views": lpv,
        "add_to_cart": atc,
        "initiate_checkout": ic,
        "leads": 0,
        "video_3s_views": v3,
        "thruplays": thru,
        "video_p25": p25,
        "video_p50": p50,
        "video_p75": p75,
        "video_p100": p100,
        "post_reactions": int(round(impressions * b["react"])),
        "post_comments": base["comment_count"],
        "post_shares": int(round(impressions * b["share"])),
        "segment_spend": seg,
    }


def demo_ads(since: str, until: str) -> list:
    today = _today()
    s, u = _parse(since), _parse(until)
    if u > today:
        u = today
    if s > u:
        return []
    out = []
    for base in _data()["ads"]:
        ad = _build_ad(base, s, u, today)
        if ad is not None:
            out.append(ad)
    out.sort(key=lambda a: -a["spend"])
    return out


def demo_comments(ad_id: str) -> dict:
    data = _data()
    base = _BY_ID.get(str(ad_id))
    if base is None:
        return {"ad_id": ad_id, "comments": [], "counts": {"facebook": 0, "instagram": 0},
                "note": "This demo ad was not found."}
    now = datetime.combine(_today(), time(12, 0), tzinfo=timezone.utc)
    raw = data["comments"].get(base["effective_object_story_id"], [])
    comments = []
    for c in raw:
        comments.append({
            "id": f"{base['effective_object_story_id']}_{c['id']}",
            "platform": c["platform"],
            "author": c["author"],
            "text": c["text"],
            "created_time": _iso(now - timedelta(hours=c["hours_ago"])),
            "like_count": c["like_count"],
            "permalink": None,
        })
    counts = {"facebook": sum(1 for c in comments if c["platform"] == "facebook"),
              "instagram": sum(1 for c in comments if c["platform"] == "instagram")}
    return {"ad_id": ad_id, "comments": comments, "counts": counts, "note": None}


def demo_thumb_path(ad_id: str) -> Optional[Path]:
    _data()
    base = _BY_ID.get(str(ad_id))
    if base is None:
        return None
    p = THUMBS_DIR / base["thumb"]
    return p if p.exists() else None


# ---------------------------------------------------------------------------
# Ad charts: per-day series, breakdowns and the video retention curve.
# Every additive number is the ad's own demo_ads() total for the same range,
# split across days or breakdown rows with exact whole-number (and whole-cent)
# allocation, so a chart always adds up to what the drawer shows. Reach adds
# up only where each person sits in one row (age, gender, customer segment);
# across days, placements and devices people repeat, so those rows add up to
# more than the ad's reach, as Meta's do.
# ---------------------------------------------------------------------------
_CHART_SUMS = ("spend", "impressions", "clicks", "reach", "purchases", "revenue", "link_clicks",
               "outbound_clicks", "landing_page_views", "add_to_cart", "initiate_checkout", "leads",
               "video_3s_views", "thruplays", "video_p25", "video_p50", "video_p75", "video_p100",
               "post_reactions", "post_comments", "post_shares")

# Day of week, Monday first. Spend leans to the weekend, CPM is lowest on
# Tuesday and highest on Sunday, and people click more on weekends; ROAS
# has no weekday pattern beyond noise.
_SPEND_DOW = (1.0, 0.97, 0.98, 1.0, 0.96, 1.05, 1.07)
_CPM_DOW = (1.0, 0.975, 0.99, 1.0, 1.005, 1.015, 1.025)
_CTR_DOW = (1.0, 1.0, 0.99, 1.0, 1.01, 1.05, 1.06)

# A skincare buyer: mostly 25 to 44 and female; older buyers convert a little better.
_AGES = ("18-24", "25-34", "35-44", "45-54", "55-64", "65+")
_AGE_MIX = (0.10, 0.30, 0.28, 0.18, 0.09, 0.05)
_AGE_EFF = (0.72, 0.95, 1.1, 1.18, 1.08, 0.92)
_AGE_CPM = (0.86, 0.95, 1.0, 1.05, 1.08, 1.1)
_AGE_CTR = (1.15, 1.06, 1.0, 0.95, 0.9, 0.86)
_GENDERS = ("female", "male", "unknown")
_GENDER_MIX = (0.78, 0.19, 0.03)
_GENDER_EFF = (1.06, 0.78, 0.9)
_GENDER_CPM = (1.04, 0.9, 0.95)
_GENDER_CTR = (1.03, 0.92, 0.95)
# (platform, position, share for an image, share for a video, cpm, ctr, efficiency):
# feeds lead for images, Reels and Stories for videos.
_PLACEMENTS = (
    ("facebook", "feed", 0.27, 0.17, 1.05, 1.0, 1.06),
    ("instagram", "feed", 0.25, 0.16, 1.15, 0.95, 1.1),
    ("instagram", "instagram_stories", 0.14, 0.17, 0.85, 0.82, 0.95),
    ("instagram", "instagram_reels", 0.12, 0.24, 0.8, 0.86, 0.9),
    ("facebook", "facebook_reels", 0.04, 0.08, 0.7, 0.76, 0.8),
    ("facebook", "facebook_stories", 0.04, 0.05, 0.8, 0.8, 0.85),
    ("instagram", "instagram_explore", 0.04, 0.03, 0.92, 0.9, 0.9),
    ("facebook", "video_feeds", 0.0, 0.04, 0.72, 0.7, 0.75),
    ("facebook", "marketplace", 0.03, 0.02, 0.76, 1.05, 0.7),
    ("audience_network", "an_classic", 0.02, 0.02, 0.4, 1.45, 0.35),
    ("messenger", "messenger_inbox", 0.01, 0.0, 0.6, 0.6, 0.6),
)
# (impression_device, share, cpm, ctr, efficiency)
_DEVICES = (
    ("iphone", 0.57, 1.08, 1.0, 1.08),
    ("android_smartphone", 0.30, 0.86, 1.02, 0.82),
    ("desktop", 0.07, 1.2, 0.85, 1.2),
    ("ipad", 0.04, 1.0, 0.9, 1.05),
    ("android_tablet", 0.02, 0.8, 0.88, 0.75),
)
# Meta's user_segment_key values per bucket, with how each converts.
_SEGMENTS = (
    ("prospecting", "prospecting", 0.8, 1.0, 1.0),
    ("engaged", "engaged_audience", 1.55, 1.25, 1.3),
    ("existing", "existing_customers", 2.4, 1.4, 1.45),
    ("unknown", "unknown", 1.0, 1.1, 1.0),
)
# Seconds at which Meta's 22 retention entries start (see api/meta.py).
_CURVE_SECONDS = tuple(range(15)) + (15, 20, 25, 30, 40, 50, 60)


def _alloc(total, weights, caps=None) -> list:
    """Split a whole number across slots in proportion to `weights` (largest
    remainder), never above `caps` when the caps can hold the total. The
    result always adds up to `total` exactly."""
    n = len(weights)
    total = int(total)
    if n == 0:
        return []
    if total <= 0:
        return [0] * n
    if caps is not None and total > sum(caps):
        caps = None
    w = [max(0.0, float(x)) for x in weights]
    if caps is not None:
        w = [x if c > 0 else 0.0 for x, c in zip(w, caps)]
        if sum(w) <= 0:
            w = [float(c) for c in caps]
    if sum(w) <= 0:
        w = [1.0] * n
    out = [0] * n
    rem = total
    for _ in range(8):
        live = [i for i in range(n) if w[i] > 0 and (caps is None or out[i] < caps[i])]
        if rem <= 0 or not live:
            break
        s = sum(w[i] for i in live)
        raw = {i: rem * w[i] / s for i in live}
        for i in live:
            give = int(raw[i])
            if caps is not None:
                give = min(give, caps[i] - out[i])
            out[i] += give
            rem -= give
        for i in sorted(live, key=lambda j: (-(raw[j] - int(raw[j])), -w[j], j)):
            if rem <= 0:
                break
            if caps is None or out[i] < caps[i]:
                out[i] += 1
                rem -= 1
    for i in range(n):  # every weighted slot is full: any slot with room takes the rest
        if rem <= 0:
            break
        take = min(rem, (caps[i] - out[i]) if caps is not None else rem)
        if take > 0:
            out[i] += take
            rem -= take
    return out


def _chart_ratios(row: dict) -> dict:
    sp, im, cl, re_ = row["spend"], row["impressions"], row["clicks"], row["reach"]
    row["spend"] = round(sp, 2)
    row["revenue"] = round(row["revenue"], 2)
    row["ctr"] = _div(cl, im, 100)
    row["cpm"] = _div(sp, im, 1000)
    row["cpc"] = _div(sp, cl)
    row["frequency"] = _div(im, re_)
    row["roas"] = _div(row["revenue"], sp)
    row["cost_per_purchase"] = _div(sp, row["purchases"])
    return row


def _sum_rows(rows: list, dims: tuple) -> dict:
    out = {d: rows[0][d] for d in dims}
    for f in _CHART_SUMS:
        out[f] = sum(r[f] for r in rows)
    return _chart_ratios(out)


def _split(ad: dict, spend_w: list, cpm_f: list, ctr_f: list, eff_f: list, hook_f: list, noise: list,
           freq_u: Optional[list] = None, spend_cents: Optional[list] = None) -> list:
    """Split one ad's range totals across slots (days or breakdown cells).
    Nested counts (clicks within impressions, quartiles within 3-second
    plays, purchases within link clicks) never exceed their parent in any
    slot. freq_u None: reach adds up across the slots; else each slot's
    reach is its impressions over a frequency between 1 and the ad's."""
    ad_spend_cents = int(round(ad["spend"] * 100))
    cents = list(spend_cents) if spend_cents is not None else _alloc(ad_spend_cents, spend_w)
    impr = _alloc(ad["impressions"], [c / f for c, f in zip(cents, cpm_f)])
    clicks = _alloc(ad["clicks"], [i * f for i, f in zip(impr, ctr_f)], caps=impr)
    link = _alloc(ad["link_clicks"], [c * x for c, x in zip(clicks, noise)], caps=clicks)
    outbound = _alloc(ad["outbound_clicks"], link, caps=link)
    lpv = _alloc(ad["landing_page_views"], link, caps=link)
    purchases = _alloc(ad["purchases"], [c * e for c, e in zip(cents, eff_f)], caps=link)
    revenue = _alloc(int(round(ad["revenue"] * 100)), [p * x for p, x in zip(purchases, noise)])
    extra_ic = _alloc(max(0, ad["initiate_checkout"] - ad["purchases"]), [lp + p for lp, p in zip(lpv, purchases)])
    ic = [p + x for p, x in zip(purchases, extra_ic)]
    extra_atc = _alloc(max(0, ad["add_to_cart"] - ad["initiate_checkout"]), [lp + 2 * p for lp, p in zip(lpv, purchases)])
    atc = [c + x for c, x in zip(ic, extra_atc)]
    v3 = _alloc(ad["video_3s_views"], [i * h for i, h in zip(impr, hook_f)], caps=impr)
    thru = _alloc(ad["thruplays"], v3, caps=v3)
    p25 = _alloc(ad["video_p25"], v3, caps=v3)
    p50 = _alloc(ad["video_p50"], p25, caps=p25)
    p75 = _alloc(ad["video_p75"], p50, caps=p50)
    p100 = _alloc(ad["video_p100"], p75, caps=p75)
    if freq_u is None:
        reach = _alloc(ad["reach"], [i * x for i, x in zip(impr, noise)], caps=impr)
    else:
        f_ad = max(1.0, float(ad["frequency"] or 1.0))
        reach = [min(i, max(1 if i else 0, int(round(i / (1.0 + (f_ad - 1.0) * u))))) for i, u in zip(impr, freq_u)]
    react = _alloc(ad["post_reactions"], impr)
    comments = _alloc(ad["post_comments"], impr)
    shares = _alloc(ad["post_shares"], impr)
    rows = []
    for k in range(len(cents)):
        rows.append(_chart_ratios({
            "spend": cents[k] / 100.0, "impressions": impr[k], "clicks": clicks[k], "reach": reach[k],
            "purchases": purchases[k], "revenue": revenue[k] / 100.0, "link_clicks": link[k],
            "outbound_clicks": outbound[k], "landing_page_views": lpv[k], "add_to_cart": atc[k],
            "initiate_checkout": ic[k], "leads": 0, "video_3s_views": v3[k], "thruplays": thru[k],
            "video_p25": p25[k], "video_p50": p50[k], "video_p75": p75[k], "video_p100": p100[k],
            "post_reactions": react[k], "post_comments": comments[k], "post_shares": shares[k],
        }))
    return rows


def _range_ad(ad_id: str, since: str, until: str):
    """(base, the ad as demo_ads() builds it for the range or None, since,
    until clamped to today, today), or None for an unknown ad."""
    _data()
    base = _BY_ID.get(str(ad_id))
    if base is None:
        return None
    today = _today()
    s, u = _parse(since), _parse(until)
    if u > today:
        u = today
    ad = _build_ad(base, s, u, today) if s <= u else None
    return base, ad, s, u, today


def _active_days(base: dict, s: date, u: date, today: date) -> list:
    """The days the ad delivered in the range (the span _build_ad counts)."""
    start = max(s, _created_dt(base, today).date())
    end = u
    if base.get("stopped_days_ago") is not None:
        end = min(end, today - timedelta(days=base["stopped_days_ago"]))
    out = []
    d = start
    while d <= end:
        out.append(d)
        d += timedelta(days=1)
    return out


def demo_daily(ad_id: str, since: str, until: str) -> Optional[list]:
    """Per-day rows for one demo ad, None for an unknown ad. The spend ramps
    up over the first days after launch, wobbles by weekday and decays as the
    ad ages; CTR and ROAS fade with age (fatigue), CPM creeps up, and a
    paused ad tapers off before it stops."""
    hit = _range_ad(ad_id, since, until)
    if hit is None:
        return None
    base, ad, s, u, today = hit
    if ad is None:
        return []
    days = _active_days(base, s, u, today)
    if not days:
        return []
    created = _created_dt(base, today).date()
    stop = (today - timedelta(days=base["stopped_days_ago"])) if base.get("stopped_days_ago") is not None else None
    life = _rng(base["ad_id"], "life")
    tau_spend, tau_eff, tau_ctr = life.uniform(70, 140), life.uniform(40, 90), life.uniform(35, 70)
    spend_w, eff_f, cpm_f, ctr_f, hook_f, noise, freq_u = [], [], [], [], [], [], []
    for d in days:
        r = _rng(base["ad_id"], "day", d.isoformat())
        age = (d - created).days
        ramp = min(1.0, (age + 1) / 4.0)
        taper = 0.55 + 0.09 * (stop - d).days if stop is not None and (stop - d).days < 5 else 1.0
        dow = d.weekday()
        spend_w.append(ramp * taper * (0.5 + 0.5 * math.exp(-age / tau_spend)) * _SPEND_DOW[dow] * r.uniform(0.84, 1.16))
        eff_f.append((0.72 + 0.56 * math.exp(-age / tau_eff)) * (0.8 + 0.2 * ramp) * r.uniform(0.7, 1.3))
        cpm_f.append((1.0 + 0.3 * (1.0 - math.exp(-age / 120.0))) * _CPM_DOW[dow] * r.uniform(0.93, 1.07))
        ctr_f.append((0.75 + 0.5 * math.exp(-age / tau_ctr)) * _CTR_DOW[dow] * r.uniform(0.88, 1.12))
        hook_f.append((0.86 + 0.28 * math.exp(-age / 60.0)) * r.uniform(0.93, 1.07))
        noise.append(r.uniform(0.9, 1.1))
        freq_u.append(r.uniform(0.12, 0.35))
    rows = _split(ad, spend_w, cpm_f, ctr_f, eff_f, hook_f, noise, freq_u=freq_u)
    return [{"date": d.isoformat(), **row} for d, row in zip(days, rows)]


def _jitter(ad_id: str, *keys) -> random.Random:
    return _rng(ad_id, "breakdown", *keys)


def _cells(ad: dict, base: dict, specs: list, additive_reach: bool, spend_cents: Optional[list] = None) -> list:
    """specs: [(dims, mix, cpm, ctr, efficiency)] to rows carrying the dims."""
    js = [_jitter(base["ad_id"], *sorted(d.values())) for d, *_ in specs]
    spend_w = [mix * j.uniform(0.8, 1.2) for (_, mix, *_), j in zip(specs, js)]
    cpm_f = [cpm * j.uniform(0.92, 1.08) for (_, _, cpm, _, _), j in zip(specs, js)]
    ctr_f = [ctr * j.uniform(0.9, 1.1) for (_, _, _, ctr, _), j in zip(specs, js)]
    eff_f = [eff * j.uniform(0.85, 1.15) for (*_, eff), j in zip(specs, js)]
    hook_f = [j.uniform(0.85, 1.15) for j in js]
    noise = [j.uniform(0.9, 1.1) for j in js]
    freq_u = None if additive_reach else [j.uniform(0.45, 0.95) for j in js]
    rows = _split(ad, spend_w, cpm_f, ctr_f, eff_f, hook_f, noise, freq_u=freq_u, spend_cents=spend_cents)
    return [{**d, **row} for (d, *_), row in zip(specs, rows)]


def demo_breakdown(ad_id: str, kind: str, since: str, until: str) -> Optional[list]:
    """Rows for one breakdown of one demo ad, shaped like Meta's insights rows
    (age, gender, publisher_platform, platform_position, impression_device or
    user_segment_key on each row). None for an unknown ad."""
    hit = _range_ad(ad_id, since, until)
    if hit is None:
        return None
    base, ad, _s, _u, _today = hit
    if ad is None:
        return []
    if kind in ("age", "gender", "age_gender"):
        specs = [({"age": a, "gender": g}, am * gm, ac * gc, at * gt, ae * ge)
                 for a, am, ae, ac, at in zip(_AGES, _AGE_MIX, _AGE_EFF, _AGE_CPM, _AGE_CTR)
                 for g, gm, ge, gc, gt in zip(_GENDERS, _GENDER_MIX, _GENDER_EFF, _GENDER_CPM, _GENDER_CTR)]
        cross = _cells(ad, base, specs, additive_reach=True)
        if kind == "age_gender":
            return cross
        dim = "age" if kind == "age" else "gender"
        order = _AGES if kind == "age" else _GENDERS
        return [_sum_rows([r for r in cross if r[dim] == v], (dim,)) for v in order]
    if kind in ("placement", "platform"):
        video = bool(base["is_video"])
        specs = [({"publisher_platform": p, "platform_position": q}, vm if video else im, c, t, e)
                 for p, q, im, vm, c, t, e in _PLACEMENTS if (vm if video else im) > 0]
        cells = _cells(ad, base, specs, additive_reach=False)
        if kind == "placement":
            return cells
        plats = []
        for r in cells:
            if r["publisher_platform"] not in plats:
                plats.append(r["publisher_platform"])
        return [_sum_rows([r for r in cells if r["publisher_platform"] == p], ("publisher_platform",)) for p in plats]
    if kind == "device":
        specs = [({"impression_device": dev}, mix, c, t, e) for dev, mix, c, t, e in _DEVICES]
        return _cells(ad, base, specs, additive_reach=False)
    if kind == "segment":
        seg = ad.get("segment_spend")
        if not seg:
            return []
        total = int(round(ad["spend"] * 100))
        cents = [int(round(seg[b] * 100)) for b, *_ in _SEGMENTS]
        cents[max(range(len(cents)), key=lambda i: cents[i])] += total - sum(cents)
        specs = [({"user_segment_key": raw}, max(c, 0) / 100.0, cpm, ctr, eff)
                 for (b, raw, eff, cpm, ctr), c in zip(_SEGMENTS, cents)]
        return _cells(ad, base, specs, additive_reach=True, spend_cents=cents)
    raise ValueError(f"unknown breakdown kind {kind!r}")


def demo_video_curve(ad_id: str, since: str, until: str) -> Optional[dict]:
    """{values, plays}: Meta's 22-entry retention curve (percent of plays
    still watching) for one demo video, None for an unknown ad. A steep drop
    over the first 3 seconds, then a slope that keeps the ad's own hold rate
    of 3-second viewers at 15 seconds, then zero past the end of the video."""
    hit = _range_ad(ad_id, since, until)
    if hit is None:
        return None
    base, ad, *_ = hit
    if ad is None or not base["is_video"] or not ad["video_3s_views"]:
        return {"values": [], "plays": 0}
    r = _rng(base["ad_id"], "curve")
    length = r.randint(14, 52)
    hold = max(0.04, min(0.9, ad["thruplays"] / ad["video_3s_views"]))
    step = hold ** (1.0 / 12.0)
    at = {0: 100.0, 1: 100.0 * r.uniform(0.55, 0.72)}
    at[2] = at[1] * r.uniform(0.8, 0.9)
    at[3] = at[2] * r.uniform(0.84, 0.92)
    for sec in range(4, 61):
        f = step * r.uniform(0.985, 1.012) if sec <= 15 else step ** 0.35 * r.uniform(0.99, 1.005)
        at[sec] = min(at[sec - 1], at[sec - 1] * f)
    values = [round(at[sec], 2) if sec <= length else 0.0 for sec in _CURVE_SECONDS]
    return {"values": values, "plays": ad["video_3s_views"]}
