#!/usr/bin/env python3
"""Rebuild the synthetic demo brand (api/demo/demo.json).

Pure stdlib. Deterministic: the same script always writes the same demo.json.

    python3 api/demo/build_demo.py                   # regenerate demo.json
    python3 api/demo/build_demo.py --render-thumbs   # also redraw thumbs/ (needs Pillow and
                                                     # the macOS system fonts; see render_thumbs.py)

Everything here is invented, the images included: each thumbnail is drawn from the demo's
own copy (headline, product, angle, format), with no photos and no real brand. Dates are
stored as day offsets from "today" so the demo always looks current; demo_data.py turns
them into real dates at request time.
"""
from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
THUMBS = HERE / "thumbs"
OUT = HERE / "demo.json"
SEED = 20261005

# The angle of each creative concept, in order. Concept i (1-based) is drawn as
# thumbs/cr_{i:03d}.jpg by render_thumbs.py: every image is generated from the demo's own
# invented copy, no photos and no real brand.
_ANGLE_CODES = {"SP": "SocialProof", "OF": "Offer", "BA": "BeforeAfter", "IN": "Ingredient",
                "PS": "ProblemSolution"}
ANGLES = [_ANGLE_CODES[c] for c in (
    "SP OF OF OF BA BA SP SP OF IN IN BA IN IN IN OF PS OF SP IN OF IN SP OF IN OF BA OF SP IN OF IN "
    "IN IN IN OF IN OF IN OF OF PS OF OF BA IN OF IN OF PS OF IN BA OF OF IN OF BA SP IN PS IN PS IN "
    "IN IN BA OF IN IN SP IN OF OF IN PS SP BA IN IN OF IN OF SP IN BA IN IN OF OF BA PS SP IN SP OF "
    "IN IN OF IN PS PS OF OF SP IN IN OF OF OF OF SP IN OF IN PS PS BA IN BA SP PS BA OF SP IN OF OF "
    "OF OF OF SP PS OF SP IN OF IN PS SP OF IN OF OF IN OF SP OF BA OF IN IN PS IN OF BA OF OF OF"
).split()]

# ---------------------------------------------------------------- vocab
ANGLE_LABEL = {
    "ProblemSolution": "Problem Solution", "SocialProof": "Social Proof", "Ingredient": "Ingredient",
    "Offer": "Offer", "BeforeAfter": "Before After",
}
PERSONAS = ["BusyMom", "Over40", "SkinSkeptic", "GiftGiver", "GlowSeeker"]
PERSONA_LABEL = {"BusyMom": "Busy Mom", "Over40": "Over 40", "SkinSkeptic": "Skin Skeptic",
                 "GiftGiver": "Gift Giver", "GlowSeeker": "Glow Seeker"}
FORMATS = ["UGC", "Studio", "Founder", "Graphic", "Lifestyle"]
VIDEO_FORMAT_W = {"UGC": 5, "Founder": 3, "Studio": 2, "Lifestyle": 2, "Graphic": 1}
IMAGE_FORMAT_W = {"Graphic": 5, "Studio": 4, "Lifestyle": 2, "UGC": 2, "Founder": 1}
FUNNEL_BY_ANGLE = {
    "ProblemSolution": {"TOF": 7, "MOF": 2, "BOF": 1},
    "Ingredient": {"TOF": 5, "MOF": 4, "BOF": 1},
    "BeforeAfter": {"TOF": 5, "MOF": 4, "BOF": 1},
    "SocialProof": {"TOF": 2, "MOF": 6, "BOF": 2},
    "Offer": {"TOF": 1, "MOF": 3, "BOF": 6},
}

PRODUCTS = ["Barrier Repair Serum", "Daily Glow Cream", "Overnight Renewal Oil", "Gentle Clay Cleanser",
            "Mineral SPF 40", "Brightening Eye Balm", "Hydration Duo", "The Full Routine Kit"]

HEADLINES = {
    "ProblemSolution": ["Dry, tight skin by noon?", "Skincare that fits a 2 minute morning",
                        "Your skin barrier called. It wants help.", "Stop layering 9 products"],
    "Ingredient": ["Ceramides, squalane and nothing weird", "Why we use 5% niacinamide",
                   "Clean formula, clinical results", "Three ingredients doing the heavy lifting"],
    "BeforeAfter": ["28 days, no filter", "Real customers, real texture change",
                    "Week 1 vs week 4", "Same light, same phone, 30 days later"],
    "SocialProof": ["Rated 4.8 by 12,000+ customers", "The serum with a waitlist",
                    "\"I finally threw out my other moisturizers\"", "Loved by sensitive skin"],
    "Offer": ["20% off your first routine", "Free gift with every kit this week",
              "Bundle and save 25%", "Subscribe and save, cancel anytime"],
}
BODIES = {
    "ProblemSolution": "Most routines ask too much of you. Ours is three steps, takes two minutes, and leaves skin calm and bouncy all day. Made for real mornings.",
    "Ingredient": "Ceramides to rebuild, squalane to seal, niacinamide to even tone. Fragrance free and dermatologist tested, so even sensitive skin can join in.",
    "BeforeAfter": "No filters, no retouching. These are customer photos from day 1 and day 28, using the same routine twice a day. Results vary, but the reviews speak for themselves.",
    "SocialProof": "Over 12,000 five star reviews and counting. Find out why customers call it the only moisturizer they repurchase.",
    "Offer": "Build your routine and save. Free shipping over $40, 60 day happiness guarantee, and a free travel size with every kit.",
}
CTA = {"ProblemSolution": "SHOP_NOW", "Ingredient": "LEARN_MORE", "BeforeAfter": "SHOP_NOW",
       "SocialProof": "SHOP_NOW", "Offer": "GET_OFFER"}

MESSY_NAMES = [
    "new serum ugc jess testimonial FINAL", "Copy of glow cream static", "BF promo v3 (dup)",
    "kit bundle carousel test", "founder story long cut", "spf launch reel", "Copy of Copy of offer static 2",
    "eye balm hook test B", "winner rework oct", "cleanser asmr", "routine unboxing new hook",
    "barrier serum 30s edit", "gifting static blue bg", "review compilation v2",
]

# campaign key, name, monthly budget, ad sets, ad count, kind
CAMPAIGNS = [
    ("pros", "Prospecting | Broad", 36000, ["Broad | US | 25-65 F", "Broad | US | All", "Interest | Skincare"], 58, "prospecting"),
    ("asc", "Advantage+ Shopping", 50000, ["ASC | Evergreen", "ASC | Offers", "ASC | New Creative"], 48, "asc"),
    ("lal", "Prospecting | Lookalike", 15000, ["LAL 1% Purchasers", "LAL 3% Purchasers", "Broad | US | All"], 26, "prospecting"),
    ("rt", "Retargeting | Engaged 30d", 13000, ["Engaged 30d | Video Viewers", "Engaged 30d | Site Visitors", "ATC 14d"], 40, "retargeting"),
    ("test", "Creative Testing", 9000, ["Test | Batch 14", "Test | Batch 15", "Test | Batch 16", "Interest | Skincare"], 56, "testing"),
    ("exist", "Existing Customers | Replenish", 6000, ["Purchasers 60-180d", "Subscribers | Upsell"], 22, "existing"),
]
FUNNEL_PREF = {
    "prospecting": {"TOF": 6, "MOF": 2, "BOF": 1},
    "testing": {"TOF": 5, "MOF": 3, "BOF": 1},
    "asc": {"TOF": 3, "MOF": 4, "BOF": 3},
    "retargeting": {"TOF": 1, "MOF": 4, "BOF": 5},
    "existing": {"TOF": 1, "MOF": 2, "BOF": 6},
}
# (lo, hi) ranges per campaign kind
KIND = {
    "prospecting": dict(cpm=(12, 22), ctr=(0.6, 1.6), roas=(0.35, 1.9), freq=(1.1, 1.6), age=(10, 200),
                        seg=dict(prospecting=(0.72, 0.88), engaged=(0.07, 0.18), existing=(0.02, 0.06), unknown=(0.01, 0.03))),
    "testing": dict(cpm=(12, 24), ctr=(0.6, 1.8), roas=(0.3, 1.8), freq=(1.1, 1.45), age=(3, 70),
                    seg=dict(prospecting=(0.75, 0.9), engaged=(0.06, 0.15), existing=(0.02, 0.05), unknown=(0.01, 0.03))),
    "asc": dict(cpm=(15, 26), ctr=(0.8, 1.9), roas=(0.8, 2.6), freq=(1.3, 2.1), age=(14, 220),
                seg=dict(prospecting=(0.45, 0.6), engaged=(0.25, 0.36), existing=(0.08, 0.15), unknown=(0.01, 0.03))),
    "retargeting": dict(cpm=(22, 38), ctr=(1.2, 2.5), roas=(1.6, 4.2), freq=(2.2, 3.8), age=(20, 240),
                        seg=dict(prospecting=(0.04, 0.1), engaged=(0.76, 0.88), existing=(0.04, 0.1), unknown=(0.01, 0.03))),
    "existing": dict(cpm=(25, 40), ctr=(1.0, 2.3), roas=(2.2, 4.6), freq=(2.6, 4.0), age=(30, 240),
                     seg=dict(prospecting=(0.02, 0.06), engaged=(0.1, 0.2), existing=(0.7, 0.85), unknown=(0.01, 0.03))),
}

# ---------------------------------------------------------------- comments
FIRST = ["jess", "kara", "mari", "dani", "lex", "nina", "sam", "tori", "bree", "alana", "chloe", "maya",
         "priya", "rose", "elle", "kim", "tess", "gabi", "liv", "jo", "ruth", "ana", "beth", "carly",
         "dee", "fran", "gwen", "hana", "isla", "june", "lena", "mel", "nora", "pia", "quinn", "rae"]
LAST = ["m", "r", "k", "b", "w", "t", "l", "s", "h", "p", "d", "c"]
IG_SUFFIX = ["", ".skin", "_glows", ".daily", "_xo", "88", "_beauty", ".makes", "_rn", "_does_skincare", ".k", "_"]
FB_FIRST = ["Dana", "Karen", "Melissa", "Tara", "Jen", "Lori", "Stacy", "Amy", "Rachel", "Heather",
            "Monica", "Brenda", "Kelly", "Tina", "Shannon", "Erin", "Angela", "Nicole", "Paula", "Wendy"]
FB_LAST = ["Holt", "Rivera", "Park", "Nolan", "Fisher", "Ortega", "Lyle", "Barrett", "Cho", "Delgado",
           "Hughes", "Monroe", "Sato", "Quinlan", "Avery", "Brandt"]

C_QUESTIONS = [
    "How long does shipping take to Canada?", "Do you ship to the UK?", "Is this safe while pregnant?",
    "Is it fragrance free?", "Does this work for oily skin?", "Will this break me out? I have super sensitive skin",
    "What size is the bottle? How long does it last?", "How much is it without the discount?",
    "Is it cruelty free?", "Can I use this with retinol?", "Does it pill under makeup?",
    "Is the subscription easy to cancel?", "What's the difference between the serum and the cream?",
    "Any rosacea folks tried this?", "Is this ok for teens?", "How many oz is the cream?",
    "Does the 20% stack with the bundle?", "Is there niacinamide in this? It makes me red",
    "Do you have a travel size?", "How fast did you see results?", "Is it vegan?",
    "Where are you made?", "Does it smell like anything?", "Can men use it too?",
]
C_PRAISE = [
    "Obsessed with the serum, on my third bottle", "My skin has never been this calm",
    "Bought it for my mom and now she won't stop texting me about it", "Honestly worth every penny",
    "The cream is so good under makeup", "Came fast and the packaging is gorgeous",
    "Six weeks in and my redness is way down", "This is the only thing that fixed my dry patches",
    "I was skeptical but wow", "Repurchased 4 times now", "My husband steals mine",
    "Love that it doesn't smell like perfume", "Holy grail status", "My esthetician asked what I changed",
    "Finally a routine I actually stick to", "The glow is real",
]
C_SKEPTIC = [
    "Every brand says this", "Looks like a filter to me", "$48 for a tiny bottle? pass",
    "Tried it, didn't do much for me tbh", "Results vary is doing a lot of work here",
    "How is this different from the drugstore stuff?", "These before and afters are always lighting",
    "Took forever to ship", "Broke me out the first week, not sure if I should keep going",
]
C_TAG = [
    "{t} you need this", "{t} this is the one I told you about", "{t} for your birthday??",
    "{t} look", "{t} we should split the bundle", "{t} remember your dry skin rant", "{t} 👀",
]
C_REPLY_EMOJI = ["😍😍", "🙌", "need", "ordered!", "🔥", "yes please", "adding to cart"]


def wchoice(rng: random.Random, weights: dict):
    keys = list(weights)
    return rng.choices(keys, weights=[weights[k] for k in keys], k=1)[0]


def handle(rng: random.Random) -> str:
    return f"{rng.choice(FIRST)}_{rng.choice(LAST)}{rng.choice(IG_SUFFIX)}".rstrip("_") or "anon"


def make_comments(rng: random.Random, n: int, ad_age_days: int, angle: str) -> list:
    out = []
    for i in range(n):
        platform = "instagram" if rng.random() < 0.6 else "facebook"
        author = handle(rng) if platform == "instagram" else f"{rng.choice(FB_FIRST)} {rng.choice(FB_LAST)}"
        r = rng.random()
        skeptic_w = 0.22 if angle == "BeforeAfter" else 0.12
        if r < 0.36:
            text = rng.choice(C_QUESTIONS)
        elif r < 0.36 + 0.3:
            text = rng.choice(C_PRAISE)
        elif r < 0.66 + skeptic_w:
            text = rng.choice(C_SKEPTIC)
        elif r < 0.95:
            tag = "@" + handle(rng) if platform == "instagram" else rng.choice(FB_FIRST) + " " + rng.choice(FB_LAST)
            text = rng.choice(C_TAG).format(t=tag)
        else:
            text = rng.choice(C_REPLY_EMOJI)
        hours_ago = rng.uniform(1, max(2, ad_age_days * 24 - 1))
        likes = int(rng.paretovariate(1.6)) - 1 if rng.random() < 0.6 else 0
        out.append({"i": i, "platform": platform, "author": author, "text": text,
                    "hours_ago": round(hours_ago, 2), "like_count": min(likes, 140)})
    out.sort(key=lambda c: c["hours_ago"])
    for j, c in enumerate(out):
        c["id"] = f"c{j:02d}"
        del c["i"]
    return out


# ---------------------------------------------------------------- build
def build(capture: list = None, require_thumbs: bool = True) -> dict:
    """The demo payload. `capture`, when given, receives every creative
    concept (what render_thumbs.py draws)."""
    rng = random.Random(SEED)
    n_thumbs = len(ANGLES)
    missing = [i for i in range(1, n_thumbs + 1) if not (THUMBS / f"cr_{i:03d}.jpg").exists()]
    if missing and require_thumbs:
        raise SystemExit(f"missing thumbs: {missing[:5]}... run with --render-thumbs first")

    # One creative concept per thumbnail.
    concepts = []
    for i, angle in enumerate(ANGLES, 1):
        is_video = rng.random() < 0.4
        fmt = wchoice(rng, VIDEO_FORMAT_W if is_video else IMAGE_FORMAT_W)
        persona = rng.choice(PERSONAS)
        funnel = wchoice(rng, FUNNEL_BY_ANGLE[angle])
        version = rng.choices([1, 2, 3, 4], weights=[5, 3, 2, 1])[0]
        r = rng.random()
        style = "std" if r < 0.8 else ("kv" if r < 0.95 else "messy")
        typ = "Video" if is_video else "Static"
        if style == "std":
            name = f"{funnel}_{angle}_{persona}_{fmt}_{typ}_v{version}"
        elif style == "kv":
            name = (f"FP:{funnel}-AN:{ANGLE_LABEL[angle]}-PE:{PERSONA_LABEL[persona]}"
                    f"-FO:{fmt}-TY:{typ}")
        else:
            name = MESSY_NAMES[i % len(MESSY_NAMES)]
            if rng.random() < 0.5:
                name += f" {rng.randint(2, 9)}"
        quality = rng.lognormvariate(0, 0.35)  # creative strength, drives ROAS and spend share
        concepts.append(dict(
            idx=i, thumb=f"cr_{i:03d}.jpg", angle=angle, persona=persona, format=fmt, funnel=funnel,
            is_video=is_video, name=name, quality=quality,
            creative_id=str(23850000000000000 + i * 7919),
            image_hash=None if is_video else f"{rng.getrandbits(128):032x}",
            video_id=str(1100000000000000 + i * 104729) if is_video else None,
            story_id=f"100000000000001_{1200000000000000 + i * 15485863}",
            title=rng.choice(HEADLINES[angle]), body=BODIES[angle].replace("routine", rng.choice(["routine", PRODUCTS[i % len(PRODUCTS)]]), 1),
            cta=CTA[angle], product=PRODUCTS[i % len(PRODUCTS)],
        ))
    if capture is not None:
        capture.extend(dict(c) for c in concepts)

    # Assign concepts to campaign slots: every concept used once, the strongest reused.
    slots = []
    for ci, (ckey, cname, budget, adsets, count, kind) in enumerate(CAMPAIGNS):
        for k in range(count):
            slots.append((ci, kind))
    rng.shuffle(slots)
    pool = list(range(len(concepts)))
    rng.shuffle(pool)
    assign = []
    used = set()
    # first pass: place each concept in a slot whose kind fits its funnel tag
    free_slots = list(range(len(slots)))
    for cidx in pool:
        c = concepts[cidx]
        best, best_w = None, -1.0
        for s in free_slots[:40]:
            w = FUNNEL_PREF[slots[s][1]][c["funnel"]] + rng.random() * 3
            if w > best_w:
                best, best_w = s, w
        free_slots.remove(best)
        assign.append((best, cidx))
        used.add(cidx)
    # second pass: remaining slots get reused winners (stacked creatives)
    ranked = sorted(range(len(concepts)), key=lambda j: -concepts[j]["quality"])
    for s in free_slots:
        cidx = ranked[int(rng.paretovariate(1.2) * 6) % 70]
        assign.append((s, cidx))
    assign.sort()

    ads = []
    stories_comments = {}
    camp_ads = {ci: [] for ci in range(len(CAMPAIGNS))}
    for n, (s, cidx) in enumerate(assign):
        ci, kind = slots[s]
        camp_ads[ci].append((n, cidx))

    ad_counter = 0
    for ci, (ckey, cname, budget, adsets, count, kind) in enumerate(CAMPAIGNS):
        K = KIND[kind]
        campaign_id = str(120210000000000000 + (ci + 1) * 1000003)
        members = camp_ads[ci]
        weights = []
        seen_in_campaign = {}
        rows = []
        for (_n, cidx) in members:
            c = concepts[cidx]
            ad_counter += 1
            adset_i = rng.randrange(len(adsets))
            # keep a reused concept out of the ad set it already lives in, when possible
            key = (cidx, adset_i)
            if key in seen_in_campaign and len(adsets) > 1:
                adset_i = (adset_i + 1) % len(adsets)
            seen_in_campaign[(cidx, adset_i)] = True
            adset_name = adsets[adset_i]
            adset_id = str(120211000000000000 + (ci + 1) * 100003 + adset_i * 17)
            ad_id = str(120212000000000000 + ad_counter * 7741 + ci)
            status = "ACTIVE" if rng.random() < (0.8 if kind != "testing" else 0.62) else "PAUSED"
            age = rng.randint(*K["age"])
            stopped_ago = None
            if status == "PAUSED":
                stopped_ago = rng.randint(1, max(1, age - 2))
            w = rng.paretovariate(1.0) * c["quality"] ** 2
            if status == "PAUSED":
                w *= 0.35
            if kind == "testing":
                w *= 0.6 + rng.random()
            weights.append(w)
            ad_name = c["name"]
            if any(r["concept"] == cidx for r in rows) or any(cidx == a["concept"] for a in ads):
                if rng.random() < 0.3:
                    ad_name += rng.choice([" - Copy", " copy", " (2)"])
            cpm = rng.uniform(*K["cpm"])
            ctr = rng.uniform(*K["ctr"]) * (1.1 if c["is_video"] else 1.0)
            roas = min(5.0, max(0.3, rng.uniform(*K["roas"]) * c["quality"]))
            freq30 = rng.uniform(*K["freq"])
            # The same visual often runs with other copy: a reused concept gets an alternate headline (and
            # sometimes body) from its own generator, so the main sequence and every other number stay put.
            title_v, body_v = c["title"], c["body"]
            if any(r["concept"] == cidx for r in rows):
                crng = random.Random(f"copy:{cidx}:{ad_counter}")
                if crng.random() < 0.55:
                    title_v = crng.choice([h for h in HEADLINES[c["angle"]] if h != c["title"]])
                    if crng.random() < 0.4:
                        body_v = BODIES[c["angle"]].replace("routine", crng.choice(PRODUCTS), 1)
            seg = None
            if rng.random() >= 0.08:
                seg = {b: rng.uniform(*K["seg"][b]) for b in ("prospecting", "engaged", "existing", "unknown")}
            spend_share = 0.0
            rows.append(dict(
                ad_id=ad_id, ad_name=ad_name, adset_id=adset_id, adset_name=adset_name,
                campaign_id=campaign_id, campaign_name=cname, campaign_kind=kind,
                effective_status=status, created_days_ago=age, stopped_days_ago=stopped_ago,
                concept=cidx, thumb=c["thumb"], creative_id=c["creative_id"], image_hash=c["image_hash"],
                video_id=c["video_id"], is_video=c["is_video"], title=title_v, body=body_v,
                call_to_action_type=c["cta"], effective_object_story_id=c["story_id"],
                base30=dict(cpm=round(cpm, 2), ctr=round(ctr, 3), roas=round(roas, 3), freq=round(freq30, 3),
                            aov=round(rng.uniform(44, 64), 2), lpv_rate=round(rng.uniform(0.7, 0.86), 3),
                            atc_rate=round(rng.uniform(0.07, 0.16), 3),
                            hook=round(rng.uniform(0.18, 0.42), 3) if c["is_video"] else 0.0,
                            hold=round(rng.uniform(0.22, 0.4), 3) if c["is_video"] else 0.0,
                            react=round(rng.uniform(0.0008, 0.003), 5), share=round(rng.uniform(0.00005, 0.0004), 6)),
                segment_mix=seg,
            ))
        tot = sum(weights)
        for r, w in zip(rows, weights):
            r["base30"]["spend"] = round(budget * w / tot, 2)
        ads.extend(rows)

    # Comments: one thread per post (story id), shared by ads that reuse the concept.
    for a in ads:
        sid = a["effective_object_story_id"]
        if sid in stories_comments:
            continue
        c = concepts[a["concept"]]
        sp = sum(x["base30"]["spend"] for x in ads if x["effective_object_story_id"] == sid)
        base = 1.0 + 9.0 * math.log10(1 + sp / 80)
        n = max(0, min(25, int(rng.gauss(base, 3.5))))
        if rng.random() < 0.1:
            n = 0
        age = max(x["created_days_ago"] for x in ads if x["effective_object_story_id"] == sid)
        crng = random.Random(f"{SEED}:{sid}")
        stories_comments[sid] = make_comments(crng, n, age, c["angle"])

    for a in ads:
        a["comment_count"] = len(stories_comments[a["effective_object_story_id"]])
        del a["concept"]

    return {
        "version": 1,
        "seed": SEED,
        "note": "Synthetic demo brand. All names, ids, numbers, comments and images are invented.",
        "account": {"id": "act_demo", "name": "Demo Brand", "currency": "USD", "account_status": 1,
                    "timezone_name": "America/Los_Angeles"},
        "ads": ads,
        "comments": stories_comments,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-thumbs", action="store_true",
                    help="redraw every thumbnail from the demo's own copy (needs Pillow)")
    args = ap.parse_args()
    if args.render_thumbs:
        from render_thumbs import render_all  # dev only: Pillow is not an app dependency
        concepts: list = []
        build(capture=concepts, require_thumbs=False)
        render_all(concepts, THUMBS)
    data = build()
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT.name}: {len(data['ads'])} ads, {sum(len(v) for v in data['comments'].values())} comments")


if __name__ == "__main__":
    main()
