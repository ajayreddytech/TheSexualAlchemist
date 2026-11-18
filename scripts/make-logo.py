"""Generates The Sexual Alchemist logo: a rising flame of life energy, held by an alchemical ring.
The emerald core is the preserved energy; the gold flame is that energy rising for betterment.

Outputs:
  icons/logo.svg               vector logo used in the app header and splash
  icons/icon-512.png           app icon
  icons/icon-192.png           app icon
  icons/icon-maskable-512.png  Android adaptive icon (content kept inside the safe zone)
Run: python scripts/make-logo.py
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ICONS = os.path.join(ROOT, "icons")

BG_TOP = (15, 43, 33)
BG_BOTTOM = (5, 7, 6)
GOLD = (217, 178, 95)
GOLD_LIGHT = (246, 221, 150)
EMBER = (194, 87, 26)
EMERALD = (16, 217, 138)
EMERALD_LIGHT = (155, 255, 214)

# Flame outline, drawn in a 512x512 design space (tip at top, rounded base).
FLAME = [
    (256, 104), (288, 160), (326, 214), (343, 284), (324, 348), (290, 382),
    (256, 398), (222, 382), (188, 348), (169, 284), (182, 222), (206, 176), (226, 138),
]
CORE = (256, 322, 34, 52)  # cx, cy, rx, ry
SPARKS = [(190, 118, 6), (322, 112, 5), (256, 70, 4)]


def smooth_closed(points, steps=24):
    """Catmull-Rom spline through the points, returned as a dense closed polyline."""
    out = []
    n = len(points)
    for i in range(n):
        p0, p1, p2, p3 = points[(i - 1) % n], points[i], points[(i + 1) % n], points[(i + 2) % n]
        for k in range(steps):
            t = k / steps
            t2, t3 = t * t, t * t * t
            pt = []
            for a in range(2):
                v = 0.5 * (
                    2 * p1[a]
                    + (-p0[a] + p2[a]) * t
                    + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2
                    + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3
                )
                pt.append(v)
            out.append(tuple(pt))
    return out


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def vertical_gradient(size, top, bottom):
    g = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(g)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(top, bottom, y / max(1, size - 1)))
    return g


def render(size, maskable=False, ss=4):
    W = size * ss
    scale = 0.74 if maskable else 1.0  # shrink the artwork so it survives the Android circle mask
    k = W / 512.0

    def P(x, y):
        return ((256 + (x - 256) * scale) * k, (256 + (y - 256) * scale) * k)

    img = vertical_gradient(W, BG_TOP, BG_BOTTOM)

    # outer and inner alchemical rings
    ring = Image.new("L", (W, W), 0)
    rd = ImageDraw.Draw(ring)
    r_out = 200 * scale * k
    cx = cy = W / 2
    rd.ellipse([cx - r_out, cy - r_out, cx + r_out, cy + r_out], outline=255, width=int(14 * scale * k))
    r_in = 178 * scale * k
    rd.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in], outline=110, width=int(3 * scale * k))
    img.paste(Image.new("RGB", (W, W), GOLD), mask=ring)

    # warm glow behind the flame
    glow = Image.new("L", (W, W), 0)
    gd = ImageDraw.Draw(glow)
    gx, gy = P(256, 270)
    gr = 170 * scale * k
    gd.ellipse([gx - gr, gy - gr, gx + gr, gy + gr], fill=120)
    glow = glow.filter(ImageFilter.GaussianBlur(40 * k))
    img.paste(Image.new("RGB", (W, W), EMBER), mask=glow)

    # flame body: gold at the tip, ember at the base
    flame_pts = [P(x, y) for x, y in smooth_closed(FLAME)]
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).polygon(flame_pts, fill=255)
    grad = vertical_gradient(W, GOLD_LIGHT, EMBER)
    img.paste(grad, mask=mask)

    # emerald core: the preserved life energy
    ccx, ccy = P(CORE[0], CORE[1])
    crx, cry = CORE[2] * scale * k, CORE[3] * scale * k
    core_glow = Image.new("L", (W, W), 0)
    ImageDraw.Draw(core_glow).ellipse([ccx - crx * 1.5, ccy - cry * 1.3, ccx + crx * 1.5, ccy + cry * 1.3], fill=200)
    core_glow = core_glow.filter(ImageFilter.GaussianBlur(18 * k))
    img.paste(Image.new("RGB", (W, W), EMERALD), mask=core_glow)
    core = Image.new("L", (W, W), 0)
    ImageDraw.Draw(core).ellipse([ccx - crx, ccy - cry, ccx + crx, ccy + cry], fill=255)
    img.paste(Image.new("RGB", (W, W), EMERALD), mask=core)
    hi = Image.new("L", (W, W), 0)
    hx, hy = P(CORE[0] - 8, CORE[1] - 18)
    ImageDraw.Draw(hi).ellipse([hx - crx * 0.35, hy - cry * 0.35, hx + crx * 0.35, hy + cry * 0.35], fill=230)
    img.paste(Image.new("RGB", (W, W), EMERALD_LIGHT), mask=hi.filter(ImageFilter.GaussianBlur(4 * k)))

    # rising sparks
    sd = Image.new("L", (W, W), 0)
    sdraw = ImageDraw.Draw(sd)
    for x, y, r in SPARKS:
        px, py = P(x, y)
        rr = r * scale * k
        sdraw.ellipse([px - rr, py - rr, px + rr, py + rr], fill=255)
    img.paste(Image.new("RGB", (W, W), GOLD_LIGHT), mask=sd)

    return img.resize((size, size), Image.LANCZOS)


def write_svg(path):
    flame = smooth_closed(FLAME)
    d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in flame) + " Z"
    cx, cy, rx, ry = CORE
    sparks = "\n  ".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#f6dd96"/>' for x, y, r in SPARKS)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="The Sexual Alchemist logo">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f2b21"/>
      <stop offset="1" stop-color="#050706"/>
    </linearGradient>
    <linearGradient id="flame" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6dd96"/>
      <stop offset="1" stop-color="#c2571a"/>
    </linearGradient>
    <radialGradient id="core" cx="0.4" cy="0.35" r="0.7">
      <stop offset="0" stop-color="#9bffd6"/>
      <stop offset="0.5" stop-color="#10d98a"/>
      <stop offset="1" stop-color="#067a50"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="0" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="200" fill="none" stroke="#d9b25f" stroke-width="14"/>
  <circle cx="256" cy="256" r="178" fill="none" stroke="#5a4620" stroke-width="3"/>
  <path d="{d}" fill="url(#flame)"/>
  <ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="url(#core)"/>
  {sparks}
</svg>
'''
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)


if __name__ == "__main__":
    os.makedirs(ICONS, exist_ok=True)
    render(512).save(os.path.join(ICONS, "icon-512.png"))
    render(192).save(os.path.join(ICONS, "icon-192.png"))
    render(512, maskable=True).save(os.path.join(ICONS, "icon-maskable-512.png"))
    write_svg(os.path.join(ICONS, "logo.svg"))
    print("logo written")
