#!/usr/bin/env python3
"""Draw the demo brand's ad thumbnails (api/demo/thumbs/cr_NNN.jpg).

Every image is generated here from the demo's own invented data: the concept's
headline, product, angle and format. No photos, no templates and no real brand,
so the demo can ship under the repo's license. Deterministic: the same concepts
always give the same pictures (on the same Pillow and fonts).

Dev only, run through the demo builder:

    /usr/bin/python3 api/demo/build_demo.py --render-thumbs

Needs Pillow and the macOS system fonts (Avenir Next, Georgia, Helvetica Neue).
Also writes thumbs/MANIFEST (sha256 per file), which a test checks, so an image
swapped in by hand fails the suite.
"""
from __future__ import annotations

import hashlib
import random
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 2  # draw at twice the size, then downsample, for smooth edges
BRAND = "DEMO BRAND"

FONT_FILES = {
    "bold": ("/System/Library/Fonts/Avenir Next.ttc", 0),
    "demi": ("/System/Library/Fonts/Avenir Next.ttc", 2),
    "medium": ("/System/Library/Fonts/Avenir Next.ttc", 5),
    "regular": ("/System/Library/Fonts/Avenir Next.ttc", 7),
    "heavy": ("/System/Library/Fonts/Avenir Next.ttc", 8),
    "condensed": ("/System/Library/Fonts/HelveticaNeue.ttc", 4),
    "serif": ("/System/Library/Fonts/Supplemental/Georgia.ttf", 0),
    "serif_italic": ("/System/Library/Fonts/Supplemental/Georgia Italic.ttf", 0),
}
_FONTS: dict = {}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    key = (kind, int(size))
    if key not in _FONTS:
        path, index = FONT_FILES[kind]
        _FONTS[key] = ImageFont.truetype(path, int(size), index=index)
    return _FONTS[key]


# bg, ink, accent, product body, product cap/label ink
PALETTES = {
    "cream": ("#F3EDE4", "#2B2622", "#C9744A", "#FFFFFF", "#2B2622"),
    "blush": ("#F4D9D0", "#3A2A2A", "#B5536B", "#FBF4F1", "#B5536B"),
    "sage": ("#DCE5D5", "#24332A", "#5E7F5F", "#F7F6F0", "#24332A"),
    "sky": ("#D7E6F2", "#1F2D3D", "#3C6E9F", "#FFFFFF", "#1F2D3D"),
    "butter": ("#F6E7B8", "#3B2F14", "#C77D12", "#FFFDF5", "#3B2F14"),
    "lilac": ("#E5DDF0", "#2E2540", "#7B5EA7", "#FFFFFF", "#2E2540"),
    "mint": ("#D3EEE3", "#173A31", "#2E8B6E", "#FFFFFF", "#173A31"),
    "terracotta": ("#C9744A", "#FFF8F0", "#FFE3C7", "#FFF8F0", "#3A1F12"),
    "cobalt": ("#2F4FA2", "#FFFFFF", "#FFD166", "#F2F5FF", "#2F4FA2"),
    "forest": ("#2F4A3A", "#F4F1E8", "#D9C38A", "#F4F1E8", "#2F4A3A"),
    "plum": ("#5B2E4F", "#FBEFF5", "#F2A6C3", "#FBEFF5", "#5B2E4F"),
    "charcoal": ("#262423", "#F5F1EA", "#E8B48A", "#F5F1EA", "#262423"),
}
SOFT = ["cream", "blush", "sage", "sky", "butter", "lilac", "mint"]
BOLD = ["terracotta", "cobalt", "forest", "plum", "charcoal"]

INGREDIENTS = ["Ceramides", "Squalane", "Niacinamide"]
BENEFITS = ["3 steps", "2 minutes", "Fragrance free"]


def hex_rgb(h) -> tuple:
    if isinstance(h, tuple):
        return h[:3]
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t: float) -> tuple:
    a, b = (hex_rgb(a) if isinstance(a, str) else a), (hex_rgb(b) if isinstance(b, str) else b)
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgradient(w: int, h: int, top, bottom) -> Image.Image:
    top, bottom = (hex_rgb(top) if isinstance(top, str) else top), (hex_rgb(bottom) if isinstance(bottom, str) else bottom)
    col = Image.new("RGB", (1, 256))
    for y in range(256):
        col.putpixel((0, y), mix(top, bottom, y / 255))
    return col.resize((w, h), Image.BILINEAR)


# ---------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------
def wrap(text: str, f: ImageFont.FreeTypeFont, max_w: float) -> list:
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if f.getlength(trial) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def fit(text: str, kind: str, max_w: float, max_h: float, hi: int, lo: int, leading: float = 1.12):
    """The biggest font size (hi down to lo) whose wrapped lines fit the box."""
    size = hi
    while True:
        f = font(kind, size)
        lines = wrap(text, f, max_w)
        line_h = size * leading
        if (len(lines) * line_h <= max_h and all(f.getlength(ln) <= max_w for ln in lines)) or size <= lo:
            return f, lines, line_h
        size = max(lo, int(size * 0.92))


def draw_lines(d: ImageDraw.ImageDraw, x: float, y: float, lines: list, f, line_h: float, fill,
               align: str = "left", width: float = 0) -> float:
    for ln in lines:
        lx = x
        if align == "center":
            lx = x + (width - f.getlength(ln)) / 2
        d.text((lx, y), ln, font=f, fill=fill)
        y += line_h
    return y


def spaced(d: ImageDraw.ImageDraw, x: float, y: float, text: str, f, fill, tracking: float, anchor_center=False):
    total = sum(f.getlength(ch) for ch in text) + tracking * (len(text) - 1)
    if anchor_center:
        x -= total / 2
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += f.getlength(ch) + tracking
    return total


# ---------------------------------------------------------------------------
# Products: simple packaging shapes with a label
# ---------------------------------------------------------------------------
def _spaced_w(text: str, f, tracking: float) -> float:
    return sum(f.getlength(ch) for ch in text) + tracking * (len(text) - 1)


def _label(d, box, ink, short: str, unit: float):
    """A monogram and the product's short name, sized to the label, never wider."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    cx = (x0 + x1) / 2
    mono = font("bold", max(6, int(min(unit * 0.15, bw * 0.4, bh * 0.28))))
    spaced(d, cx, y0 + bh * 0.06, "DB", mono, ink, mono.size * 0.06, anchor_center=True)
    words = short.upper().split()[:2]
    fs = int(min(unit * 0.09, bh * 0.15))
    while fs > 5 and any(_spaced_w(w, font("demi", fs), fs * 0.1) > bw * 0.9 for w in words):
        fs -= 1
    if fs <= 5:
        return
    f = font("demi", fs)
    ty = y0 + bh * 0.5
    for w in words:
        spaced(d, cx, ty, w, f, ink, fs * 0.1, anchor_center=True)
        ty += fs * 1.25


def draw_product(img: Image.Image, kind: int, cx: float, base_y: float, unit: float, body, cap, ink,
                 shadow: bool = True) -> None:
    """Packaging `kind` (the product index) standing on base_y, centered on cx.
    `unit` is roughly the product's height."""
    d = ImageDraw.Draw(img)
    if shadow:
        sh = Image.new("L", img.size, 0)
        ImageDraw.Draw(sh).ellipse((cx - unit * 0.42, base_y - unit * 0.05, cx + unit * 0.42, base_y + unit * 0.06),
                                   fill=90)
        sh = sh.filter(ImageFilter.GaussianBlur(unit * 0.05))
        img.paste((0, 0, 0), mask=sh.point(lambda v: int(v * 0.55)))
    body, cap, ink = hex_rgb(body), hex_rgb(cap), hex_rgb(ink)
    edge = mix(body, (0, 0, 0), 0.12)

    def bottle(x, w, h, neck_w, neck_h, top: str, short: str):
        y1 = base_y
        y0 = y1 - h
        d.rounded_rectangle((x - w / 2, y0, x + w / 2, y1), radius=w * 0.16, fill=body, outline=edge, width=max(1, int(unit * 0.006)))
        d.rectangle((x - neck_w / 2, y0 - neck_h, x + neck_w / 2, y0 + 2), fill=body, outline=edge)
        if top == "dropper":
            d.rounded_rectangle((x - neck_w * 0.75, y0 - neck_h - unit * 0.07, x + neck_w * 0.75, y0 - neck_h + 2),
                                radius=unit * 0.02, fill=cap)
            d.rounded_rectangle((x - neck_w * 0.45, y0 - neck_h - unit * 0.2, x + neck_w * 0.45, y0 - neck_h - unit * 0.05),
                                radius=neck_w * 0.45, fill=cap)
        elif top == "pump":
            d.rectangle((x - neck_w * 0.7, y0 - neck_h - unit * 0.05, x + neck_w * 0.7, y0 - neck_h + 2), fill=cap)
            d.rectangle((x - neck_w * 0.18, y0 - neck_h - unit * 0.13, x + neck_w * 0.18, y0 - neck_h - unit * 0.04), fill=cap)
            d.rounded_rectangle((x - neck_w * 0.2, y0 - neck_h - unit * 0.17, x + neck_w * 1.1, y0 - neck_h - unit * 0.12),
                                radius=unit * 0.02, fill=cap)
        _label(d, (x - w * 0.36, y0 + h * 0.22, x + w * 0.36, y0 + h * 0.8), ink, short, unit)

    def jar(x, w, h, short: str):
        y1 = base_y
        lid_h = h * 0.32
        d.rounded_rectangle((x - w / 2, y1 - h + lid_h - 2, x + w / 2, y1), radius=w * 0.1, fill=body, outline=edge,
                            width=max(1, int(unit * 0.006)))
        d.rounded_rectangle((x - w * 0.52, y1 - h, x + w * 0.52, y1 - h + lid_h), radius=w * 0.08, fill=cap)
        _label(d, (x - w * 0.34, y1 - h + lid_h + h * 0.08, x + w * 0.34, y1 - h * 0.08), ink, short, unit * 0.8)

    def tube(x, w, h, short: str):
        y1 = base_y
        cap_h = h * 0.16
        d.rounded_rectangle((x - w * 0.3, y1 - cap_h, x + w * 0.3, y1), radius=w * 0.06, fill=cap)
        top_y = y1 - h
        d.polygon([(x - w / 2, top_y), (x + w / 2, top_y), (x + w * 0.34, y1 - cap_h), (x - w * 0.34, y1 - cap_h)],
                  fill=body, outline=edge)
        d.rectangle((x - w / 2, top_y, x + w / 2, top_y + h * 0.05), fill=edge)
        _label(d, (x - w * 0.3, top_y + h * 0.16, x + w * 0.3, y1 - cap_h - h * 0.12), ink, short, unit * 0.85)

    if kind == 0:  # serum
        bottle(cx, unit * 0.34, unit * 0.62, unit * 0.11, unit * 0.06, "dropper", "Repair Serum")
    elif kind == 1:  # cream
        jar(cx, unit * 0.62, unit * 0.46, "Glow Cream")
    elif kind == 2:  # oil
        bottle(cx, unit * 0.3, unit * 0.72, unit * 0.1, unit * 0.07, "pump", "Renewal Oil")
    elif kind == 3:  # cleanser
        tube(cx, unit * 0.36, unit * 0.86, "Clay Cleanser")
    elif kind == 4:  # SPF
        tube(cx, unit * 0.34, unit * 0.78, "Mineral SPF")
    elif kind == 5:  # eye balm
        jar(cx, unit * 0.46, unit * 0.32, "Eye Balm")
    elif kind == 6:  # duo
        bottle(cx - unit * 0.2, unit * 0.3, unit * 0.58, unit * 0.1, unit * 0.06, "dropper", "Serum")
        jar(cx + unit * 0.22, unit * 0.44, unit * 0.34, "Cream")
    else:  # kit
        tube(cx - unit * 0.34, unit * 0.26, unit * 0.62, "Cleanser")
        bottle(cx, unit * 0.28, unit * 0.6, unit * 0.09, unit * 0.06, "dropper", "Serum")
        jar(cx + unit * 0.34, unit * 0.36, unit * 0.3, "Cream")


# ---------------------------------------------------------------------------
# Angle pieces
# ---------------------------------------------------------------------------
def offer_badge_text(title: str) -> tuple:
    m = re.search(r"(\d+)%", title)
    t = title.lower()
    if m and "off" in t:
        return f"{m.group(1)}%", "OFF"
    if m:
        return "SAVE", f"{m.group(1)}%"
    if "free" in t:
        return "FREE", "GIFT"
    return "SUB &", "SAVE"


def draw_badge(d, cx, cy, r, title, fill, ink):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=hex_rgb(fill))
    a, b = offer_badge_text(title)
    fa = font("heavy", int(r * 0.62))
    fb = font("demi", int(r * 0.34))
    d.text((cx, cy - r * 0.12), a, font=fa, fill=hex_rgb(ink), anchor="ms")
    d.text((cx, cy + r * 0.38), b, font=fb, fill=hex_rgb(ink), anchor="ms")


def draw_stars(d, x, y, size, fill, n=5):
    for i in range(n):
        cx, cy = x + i * size * 1.15 + size / 2, y + size / 2
        pts = []
        for k in range(10):
            import math
            ang = -math.pi / 2 + k * math.pi / 5
            rr = size / 2 if k % 2 == 0 else size * 0.21
            pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
        d.polygon(pts, fill=hex_rgb(fill))
    return n * size * 1.15


def draw_check(d, x, y, size, fill):
    w = max(2, int(size * 0.16))
    d.line([(x, y + size * 0.55), (x + size * 0.38, y + size * 0.9), (x + size, y + size * 0.12)],
           fill=hex_rgb(fill), width=w, joint="curve")


def skin_panel(w: int, h: int, rng: random.Random, smooth: bool) -> Image.Image:
    tone = rng.choice(["#E8C4A8", "#D9A88A", "#C68E6E", "#F0D2BC", "#B47A5A"])
    img = vgradient(w, h, mix(tone, "#FFFFFF", 0.18), mix(tone, "#000000", 0.08))
    d = ImageDraw.Draw(img)
    if not smooth:
        for _ in range(int(w * h / 900)):
            x, y = rng.uniform(0, w), rng.uniform(0, h)
            r = rng.uniform(w * 0.004, w * 0.016)
            d.ellipse((x - r, y - r, x + r, y + r), fill=mix(tone, "#9C3B2E", rng.uniform(0.15, 0.4)))
        img = img.filter(ImageFilter.GaussianBlur(w * 0.004))
    else:
        glow = Image.new("L", (w, h), 0)
        ImageDraw.Draw(glow).ellipse((w * 0.15, h * 0.1, w * 0.85, h * 0.6), fill=110)
        glow = glow.filter(ImageFilter.GaussianBlur(w * 0.12))
        img.paste((255, 255, 255), mask=glow)
    return img


def pill(d, x, y, text, f, fill, ink, pad_x, pad_y, center=False):
    tw = f.getlength(text)
    bh = f.size * 1.0 + pad_y * 2
    bw = tw + pad_x * 2
    if center:
        x -= bw / 2
    d.rounded_rectangle((x, y, x + bw, y + bh), radius=bh / 2, fill=hex_rgb(fill))
    d.text((x + pad_x, y + bh / 2), text, font=f, fill=hex_rgb(ink), anchor="lm")
    return bw, bh


# ---------------------------------------------------------------------------
# Scenes (one per format)
# ---------------------------------------------------------------------------
def person(img, cx, top, scale, skin, shirt, rng: random.Random):
    """Head and shoulders, cut off by the bottom of the frame, like a selfie video."""
    d = ImageDraw.Draw(img)
    W, H = img.size
    head_r = scale * 0.2
    hair = rng.choice(["#1E1410", "#3B2416", "#6B4423", "#A8794A", "#2A2A2A", "#C9A26B"])
    style = rng.choice(["short", "long", "bun", "long"])
    hx0, hy0, hx1, hy1 = cx - head_r, top, cx + head_r, top + head_r * 2.3
    if style == "long":
        d.rounded_rectangle((hx0 - head_r * 0.22, hy0 - head_r * 0.1, hx1 + head_r * 0.22, hy1 + head_r * 0.9),
                            radius=head_r * 0.9, fill=hex_rgb(hair))
    sy = hy1 - head_r * 0.25
    d.rounded_rectangle((cx - scale * 0.52, sy + head_r * 0.35, cx + scale * 0.52, H + scale * 0.4),
                        radius=scale * 0.3, fill=hex_rgb(shirt))
    d.rounded_rectangle((cx - head_r * 0.38, sy - head_r * 0.2, cx + head_r * 0.38, sy + head_r * 0.7),
                        radius=head_r * 0.2, fill=mix(skin, "#000000", 0.08))
    d.ellipse((hx0, hy0, hx1, hy1), fill=hex_rgb(skin))
    d.chord((hx0 - head_r * 0.06, hy0 - head_r * 0.12, hx1 + head_r * 0.06, hy0 + head_r * 1.5), 180, 360,
            fill=hex_rgb(hair))
    if style == "bun":
        d.ellipse((cx - head_r * 0.42, hy0 - head_r * 0.62, cx + head_r * 0.42, hy0 + head_r * 0.1), fill=hex_rgb(hair))


def caption_bubbles(d, cx, y, text, max_w, size):
    f = font("demi", size)
    lines = wrap(text, f, max_w)
    for ln in lines:
        tw = f.getlength(ln)
        pad = size * 0.4
        bh = size * 1.35
        d.rounded_rectangle((cx - tw / 2 - pad, y, cx + tw / 2 + pad, y + bh), radius=size * 0.3, fill=(255, 255, 255))
        d.text((cx, y + bh / 2), ln, font=f, fill=(20, 20, 20), anchor="mm")
        y += bh + size * 0.12
    return y


def wordmark(d, x, y, size, ink, center=False, width=0):
    f = font("demi", size)
    if center:
        spaced(d, x + width / 2, y, BRAND, f, hex_rgb(ink), size * 0.28, anchor_center=True)
    else:
        spaced(d, x, y, BRAND, f, hex_rgb(ink), size * 0.28)


def render(c: dict, size: tuple) -> Image.Image:
    rng = random.Random(f"demo-thumb:{c['idx']}")
    W, H = size[0] * SS, size[1] * SS
    angle, fmt, title = c["angle"], c["format"], c["title"]
    pool = BOLD + ["butter"] if angle == "Offer" else (SOFT * 2 + BOLD)
    bg, ink, accent, body, cap = PALETTES[rng.choice(pool)]
    product = int(c["idx"]) % 8
    tall = H / W > 1.5
    m = W * 0.07  # margin

    if angle == "BeforeAfter":
        img = Image.new("RGB", (W, H), hex_rgb(bg))
        d = ImageDraw.Draw(img)
        band = H * (0.22 if tall else 0.26)
        if tall:
            ph = (H - band) / 2
            panels = [(0, 0, W, ph), (0, ph, W, ph * 2)]
        else:
            pw = W / 2
            panels = [(0, 0, pw, H - band), (pw, 0, W, H - band)]
        labels = ("WEEK 1", "WEEK 4") if "week" in title.lower() else ("DAY 1", "DAY 28")
        for k, (x0, y0, x1, y1) in enumerate(panels):
            p = skin_panel(int(x1 - x0), int(y1 - y0), rng, smooth=k == 1)
            img.paste(p, (int(x0), int(y0)))
            pill(d, x0 + m * 0.6, y0 + m * 0.6, labels[k], font("bold", int(W * 0.036)), "#FFFFFF", "#1E1E1E",
                 W * 0.025, W * 0.012)
        if not tall:
            d.line([(W / 2, 0), (W / 2, H - band)], fill=(255, 255, 255), width=max(2, int(W * 0.006)))
        else:
            d.line([(0, (H - band) / 2), (W, (H - band) / 2)], fill=(255, 255, 255), width=max(2, int(W * 0.006)))
        y0 = H - band
        f, lines, lh = fit(title, "bold", W - m * 2, band * 0.58, int(W * 0.075), int(W * 0.04))
        ty = y0 + (band - len(lines) * lh) / 2 - band * 0.08
        draw_lines(d, m, ty, lines, f, lh, hex_rgb(ink), align="center", width=W - m * 2)
        wordmark(d, 0, H - band * 0.2, int(W * 0.024), mix(ink, bg, 0.35), center=True, width=W)
        return img

    if fmt in ("UGC", "Founder"):
        room_a, room_b = rng.choice([("#E9DCCB", "#B89F86"), ("#D8DEE4", "#8C98A3"), ("#EADBD6", "#A98A82"),
                                     ("#DCE3D3", "#8E9A82"), ("#E6D9EC", "#9C8AA6")])
        img = vgradient(W, H, room_a, room_b)
        # soft background lights
        glow = Image.new("L", (W, H), 0)
        gd = ImageDraw.Draw(glow)
        for _ in range(5):
            x, y, r = rng.uniform(0, W), rng.uniform(0, H * 0.6), rng.uniform(W * 0.08, W * 0.2)
            gd.ellipse((x - r, y - r, x + r, y + r), fill=rng.randint(40, 90))
        img.paste((255, 250, 240), mask=glow.filter(ImageFilter.GaussianBlur(W * 0.05)))
        skin = rng.choice(["#E8C4A8", "#D9A88A", "#B47A5A", "#8D5A3F", "#F0D2BC"])
        shirt = rng.choice([accent, ink, cap, "#F5F1EA", "#3B4A5A", "#7A8C6E"])
        scale = W * (0.66 if fmt == "Founder" else 0.6)
        top = H * (0.36 if tall else 0.3)
        px = W * (0.5 if fmt == "Founder" else 0.42)
        person(img, px, top, scale, skin, shirt, rng)
        # The product held up next to the face.
        unit = scale * (0.62 if tall else 0.56)
        hold_x = px + scale * 0.5
        base = top + scale * 0.2 * 2.3 + unit * 0.55
        draw_product(img, product % 6, hold_x, base, unit, body, cap, cap, shadow=False)
        d = ImageDraw.Draw(img)
        hand = mix(skin, "#000000", 0.04)
        d.rounded_rectangle((hold_x - unit * 0.2, base - unit * 0.2, hold_x + unit * 0.2, base + unit * 0.12),
                            radius=unit * 0.1, fill=hand)
        d.rounded_rectangle((hold_x - unit * 0.12, base + unit * 0.05, hold_x + unit * 0.12, H + unit),
                            radius=unit * 0.1, fill=hex_rgb(shirt))
        cap_text = title if len(title) < 44 else title[:42].rsplit(" ", 1)[0]
        caption_bubbles(d, W / 2, H * (0.1 if tall else 0.07), cap_text, W * 0.8, int(W * (0.058 if tall else 0.05)))
        if fmt == "Founder":
            f = font("demi", int(W * 0.036))
            pill(d, m, H * (0.86 if tall else 0.84), "Founder, Demo Brand", f, "#FFFFFF", "#1E1E1E", W * 0.03, W * 0.016)
        if c.get("is_video"):
            y = H - W * 0.035
            d.rounded_rectangle((m, y - W * 0.008, W - m, y), radius=W * 0.004, fill=mix(shirt, "#FFFFFF", 0.55))
            d.rounded_rectangle((m, y - W * 0.008, m + (W - 2 * m) * rng.uniform(0.15, 0.6), y), radius=W * 0.004,
                                fill=(255, 255, 255))
        return img

    if fmt == "Studio":
        img = vgradient(W, H, mix(bg, "#FFFFFF", 0.35), hex_rgb(bg))
        d = ImageDraw.Draw(img)
        wordmark(d, 0, m * 0.9, int(W * 0.028), ink, center=True, width=W)
        unit = min(W * 0.62, H * 0.5)
        draw_product(img, product, W / 2, H * (0.7 if tall else 0.74), unit, body, cap, cap)
        d = ImageDraw.Draw(img)
        f, lines, lh = fit(title, "medium", W - m * 2.4, H * (0.16 if tall else 0.17), int(W * 0.062), int(W * 0.036))
        draw_lines(d, m * 1.2, H * (0.79 if tall else 0.8), lines, f, lh, hex_rgb(ink), align="center",
                   width=W - m * 2.4)
        _angle_extras(img, c, W, H, m, accent, ink, bg, cap, compact=True)
        return img

    if fmt == "Lifestyle":
        img = vgradient(W, H, mix(bg, "#FFFFFF", 0.2), mix(bg, "#000000", 0.08))
        d = ImageDraw.Draw(img)
        shelf_y = H * 0.78
        d.rectangle((0, shelf_y, W, H), fill=mix(bg, "#6B4E3A", 0.35))
        d.rectangle((0, shelf_y, W, shelf_y + H * 0.012), fill=mix(bg, "#6B4E3A", 0.5))
        # a potted plant
        px = W * 0.2
        leaf = mix("#5E7F5F", bg, 0.15)
        for k in range(7):
            lx = px + rng.uniform(-W * 0.09, W * 0.09)
            ly = shelf_y - H * rng.uniform(0.16, 0.34)
            r = W * rng.uniform(0.05, 0.08)
            d.ellipse((lx - r, ly - r * 1.6, lx + r, ly + r * 1.6), fill=mix(leaf, "#1E3A28", rng.uniform(0, 0.35)))
        d.polygon([(px - W * 0.08, shelf_y - H * 0.13), (px + W * 0.08, shelf_y - H * 0.13),
                   (px + W * 0.06, shelf_y), (px - W * 0.06, shelf_y)], fill=mix("#C9744A", bg, 0.2))
        unit = min(W * 0.5, H * 0.42)
        draw_product(img, product, W * 0.64, shelf_y + H * 0.01, unit, body, cap, cap)
        d = ImageDraw.Draw(img)
        f, lines, lh = fit(title, "bold", W - m * 2, H * 0.24, int(W * 0.08), int(W * 0.045))
        y = draw_lines(d, m, m * 1.1, lines, f, lh, hex_rgb(ink))
        wordmark(d, m, H - m * 0.9, int(W * 0.026), ink)
        _angle_extras(img, c, W, H, m, accent, ink, bg, cap, compact=True, text_bottom=y)
        return img

    # Graphic: flat, type led
    img = Image.new("RGB", (W, H), hex_rgb(bg))
    d = ImageDraw.Draw(img)
    wordmark(d, m, m * 0.9, int(W * 0.028), ink)
    quote = title.startswith('"')
    kind = "serif_italic" if quote else "heavy"
    f, lines, lh = fit(title, kind, W - m * 2, H * (0.34 if tall else 0.36), int(W * 0.11), int(W * 0.05),
                       leading=1.06)
    y = draw_lines(d, m, m * 2.2, lines, f, lh, hex_rgb(ink))
    unit = min(W * 0.5, H * (0.36 if tall else 0.42))
    draw_product(img, product, W * 0.66, H - m * 0.9, unit, body, cap, cap)
    _angle_extras(img, c, W, H, m, accent, ink, bg, cap, compact=False, text_bottom=y)
    return img


LIGHT_ACCENTS = ("#FFE3C7", "#FFD166", "#D9C38A", "#F2A6C3", "#E8B48A")


def _angle_extras(img, c, W, H, m, accent, ink, bg, cap, compact: bool, text_bottom: float = 0):
    """The angle's own piece, placed under the headline (text_bottom) when the
    headline is on top, else under the wordmark."""
    d = ImageDraw.Draw(img)
    angle = c["angle"]
    on_accent = cap if accent in LIGHT_ACCENTS else "#FFFFFF"  # dark text on a light accent
    below = (text_bottom + m * 0.45) if text_bottom else m * 2.0
    if angle == "Offer":
        r = W * (0.12 if compact else 0.15)
        room = H - m - below
        r = max(W * 0.08, min(r, room * 0.42))
        if compact:
            cx, cy = W - m - r, max(H * 0.42, below + r)
        else:
            cx, cy = m + r, below + r
        draw_badge(d, cx, cy, r, c["title"], accent, on_accent)
    elif angle == "SocialProof":
        s = W * (0.045 if compact else 0.055)
        x = (W - 5 * s * 1.15) / 2 if compact and not text_bottom else m
        draw_stars(d, x, below, s, accent)
        f = font("demi", int(W * 0.03))
        d.text((x, below + s * 1.45), "4.8 from 12,000+ reviews", font=f, fill=hex_rgb(ink))
    elif angle == "Ingredient":
        f = font("demi", int(W * (0.03 if compact else 0.034)))
        x, y = m, below
        if compact and not text_bottom:
            names = INGREDIENTS[:2]
            total = sum(f.getlength(n) + W * 0.048 for n in names) + W * 0.02
            x = (W - total) / 2
        for name in INGREDIENTS[: 2 if compact else 3]:
            bw, bh = pill(d, x, y, name, f, accent, on_accent, W * 0.024, W * 0.012)
            if compact:
                x += bw + W * 0.02
            else:
                y += bh + W * 0.018
    elif angle == "ProblemSolution" and not compact:
        f = font("medium", int(W * 0.04))
        y = below
        for b in BENEFITS:
            draw_check(d, m, y + W * 0.006, W * 0.036, accent)
            d.text((m + W * 0.06, y), b, font=f, fill=hex_rgb(ink))
            y += W * 0.062


# ---------------------------------------------------------------------------
def size_for(c: dict) -> tuple:
    if c.get("is_video"):
        return 360, 640          # 9:16, a Reels or Stories poster
    return (432, 540) if int(c["idx"]) % 4 == 0 else (540, 540)


def render_all(concepts: list, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for c in concepts:
        w, h = size_for(c)
        img = render(c, (w, h)).resize((w, h), Image.LANCZOS)
        p = out_dir / c["thumb"]
        img.save(p, "JPEG", quality=84, optimize=True, progressive=True)
        manifest.append(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}")
    keep = {c["thumb"] for c in concepts}
    for p in out_dir.glob("*.jpg"):
        if p.name not in keep:
            p.unlink()
    (out_dir / "MANIFEST").write_text("\n".join(sorted(manifest, key=lambda s: s[-11:])) + "\n")
    print(f"drew {len(concepts)} thumbnails in {out_dir}")
