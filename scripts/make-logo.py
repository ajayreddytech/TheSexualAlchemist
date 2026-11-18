"""Generates The Sexual Alchemist logo: a yogi in meditation, counting a japamala (108-bead mala).
He glows from within: a golden aura, an emerald light at the heart (inner happiness, rejuvenation),
and light sparkles around him.

Outputs:
  icons/logo.svg               vector logo used in the app header and splash
  icons/icon-512.png           app icon
  icons/icon-192.png           app icon
  icons/icon-maskable-512.png  Android adaptive icon (artwork kept inside the safe zone)
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
FIG_TOP = (255, 240, 190)
FIG_BOTTOM = (214, 150, 66)
EMERALD = (16, 217, 138)
EMERALD_LIGHT = (155, 255, 214)

# Design space is 512x512. Figure parts:
HEAD = (256, 158, 30)                 # cx, cy, r
HALO_R = 50
TORSO = (256, 262, 70, 84)            # cx, cy, rx, ry
LOTUS = (256, 334, 128, 38)           # crossed legs
ARM_L = [(192, 222), (152, 292), (206, 284)]
ARM_R = [(320, 222), (360, 292), (306, 284)]
ARM_W = 22
HEART = (256, 250)

BEAD_COUNT = 27
GURU = (256, 352)
SPARKLES = [(118, 150, 13), (394, 146, 11), (96, 318, 9), (420, 322, 11), (256, 80, 8)]


def mala_point(t):
    """Japamala string: a gentle drape from the left hand, dipping to the guru bead at the centre."""
    x = 196 + (316 - 196) * t
    u = (x - 256) / 60.0
    y = 286 + 66 * (1 - u * u)
    return x, y


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

    def S(r):
        return r * scale * k

    def paste(color, mask):
        img.paste(Image.new("RGB", (W, W), color), mask=mask)

    def new_mask():
        return Image.new("L", (W, W), 0)

    def ellipse(d, cx, cy, rx, ry, fill=255):
        x, y = P(cx, cy)
        d.ellipse([x - S(rx), y - S(ry), x + S(rx), y + S(ry)], fill=fill)

    def polyline(d, pts, width, fill=255):
        ps = [P(x, y) for x, y in pts]
        d.line(ps, fill=fill, width=int(S(width)), joint="curve")
        r = S(width) / 2
        for x, y in (ps[0], ps[-1]):
            d.ellipse([x - r, y - r, x + r, y + r], fill=fill)

    img = vertical_gradient(W, BG_TOP, BG_BOTTOM)

    # Alchemical rings
    ring = new_mask()
    rd = ImageDraw.Draw(ring)
    cx = cy = W / 2
    r_out = S(200)
    rd.ellipse([cx - r_out, cy - r_out, cx + r_out, cy + r_out], outline=255, width=int(S(14)))
    r_in = S(178)
    rd.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in], outline=110, width=max(1, int(S(3))))
    paste(GOLD, ring)

    # Golden aura around the whole figure
    aura = new_mask()
    ellipse(ImageDraw.Draw(aura), HEART[0], HEART[1] + 10, 200, 200, fill=120)
    paste(GOLD, aura.filter(ImageFilter.GaussianBlur(50 * k)))

    # Emerald light at the heart: inner happiness and renewal
    heart = new_mask()
    ellipse(ImageDraw.Draw(heart), HEART[0], HEART[1], 46, 46, fill=230)
    paste(EMERALD, heart.filter(ImageFilter.GaussianBlur(22 * k)))
    core = new_mask()
    ellipse(ImageDraw.Draw(core), HEART[0], HEART[1], 12, 12)
    paste(EMERALD_LIGHT, core.filter(ImageFilter.GaussianBlur(3 * k)))

    # Figure silhouette, filled with a warm gold gradient
    fig = new_mask()
    fd = ImageDraw.Draw(fig)
    ellipse(fd, HEAD[0], HEAD[1], HEAD[2], HEAD[2])
    ellipse(fd, TORSO[0], TORSO[1], TORSO[2], TORSO[3])
    ellipse(fd, LOTUS[0], LOTUS[1], LOTUS[2], LOTUS[3])
    polyline(fd, ARM_L, ARM_W)
    polyline(fd, ARM_R, ARM_W)
    img.paste(vertical_gradient(W, FIG_TOP, FIG_BOTTOM), mask=fig)

    # Halo around the head
    halo = new_mask()
    hx, hy = P(HEAD[0], HEAD[1])
    hr = S(HALO_R)
    ImageDraw.Draw(halo).ellipse([hx - hr, hy - hr, hx + hr, hy + hr], outline=170, width=max(1, int(S(3))))
    paste(GOLD_LIGHT, halo)

    # Japamala: 27 beads visible along the drape, with the emerald guru bead
    string = new_mask()
    pts = [mala_point(i / 60.0) for i in range(61)]
    polyline(ImageDraw.Draw(string), pts, 2.5)
    paste(GOLD, string)
    beads = new_mask()
    bd = ImageDraw.Draw(beads)
    for i in range(BEAD_COUNT):
        x, y = mala_point(i / (BEAD_COUNT - 1))
        ellipse(bd, x, y, 5.5, 5.5)
    paste(GOLD_LIGHT, beads)
    guru = new_mask()
    ellipse(ImageDraw.Draw(guru), GURU[0], GURU[1], 11, 11)
    paste(EMERALD, guru)

    # Light sparkles: the glow of renewal
    spark = new_mask()
    sd = ImageDraw.Draw(spark)
    for x, y, r in SPARKLES:
        px, py = P(x, y)
        rr = S(r)
        q = rr * 0.28
        sd.polygon([(px, py - rr), (px + q, py - q), (px + rr, py), (px + q, py + q),
                    (px, py + rr), (px - q, py + q), (px - rr, py), (px - q, py - q)], fill=255)
    paste(GOLD_LIGHT, spark.filter(ImageFilter.GaussianBlur(1.2 * k)))

    return img.resize((size, size), Image.LANCZOS)


def write_svg(path):
    def sparkle(x, y, r):
        q = r * 0.28
        pts = [(x, y - r), (x + q, y - q), (x + r, y), (x + q, y + q),
               (x, y + r), (x - q, y + q), (x - r, y), (x - q, y - q)]
        return "M " + " L ".join(f"{px:.1f} {py:.1f}" for px, py in pts) + " Z"

    mala = [mala_point(i / 60.0) for i in range(61)]
    mala_d = " ".join(f"{x:.1f},{y:.1f}" for x, y in mala)
    beads = "\n    ".join(
        f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5.5"/>'
        for x, y in (mala_point(i / (BEAD_COUNT - 1)) for i in range(BEAD_COUNT)))
    arm_l = " ".join(f"{x},{y}" for x, y in ARM_L)
    arm_r = " ".join(f"{x},{y}" for x, y in ARM_R)
    sparkles = "\n  ".join(f'<path d="{sparkle(x, y, r)}" fill="#f6dd96"/>' for x, y, r in SPARKLES)

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="The Sexual Alchemist logo: a yogi meditating with a japamala">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f2b21"/>
      <stop offset="1" stop-color="#050706"/>
    </linearGradient>
    <linearGradient id="fig" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff0be"/>
      <stop offset="1" stop-color="#d6963e"/>
    </linearGradient>
    <radialGradient id="aura" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#d9b25f" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#d9b25f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="heart" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#9bffd6"/>
      <stop offset="0.45" stop-color="#10d98a" stop-opacity="0.8"/>
      <stop offset="1" stop-color="#10d98a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="200" fill="none" stroke="#d9b25f" stroke-width="14"/>
  <circle cx="256" cy="256" r="178" fill="none" stroke="#5a4620" stroke-width="3"/>
  <circle cx="256" cy="260" r="200" fill="url(#aura)"/>
  <circle cx="256" cy="{HEART[1]}" r="60" fill="url(#heart)"/>
  <g fill="url(#fig)" stroke="url(#fig)" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="{HEAD[0]}" cy="{HEAD[1]}" r="{HEAD[2]}" stroke="none"/>
    <ellipse cx="{TORSO[0]}" cy="{TORSO[1]}" rx="{TORSO[2]}" ry="{TORSO[3]}" stroke="none"/>
    <ellipse cx="{LOTUS[0]}" cy="{LOTUS[1]}" rx="{LOTUS[2]}" ry="{LOTUS[3]}" stroke="none"/>
    <polyline points="{arm_l}" fill="none" stroke-width="{ARM_W}"/>
    <polyline points="{arm_r}" fill="none" stroke-width="{ARM_W}"/>
  </g>
  <circle cx="{HEAD[0]}" cy="{HEAD[1]}" r="{HALO_R}" fill="none" stroke="#f6dd96" stroke-opacity="0.67" stroke-width="3"/>
  <polyline points="{mala_d}" fill="none" stroke="#d9b25f" stroke-width="2.5" stroke-linecap="round"/>
  <g fill="#f6dd96">
    {beads}
  </g>
  <circle cx="{GURU[0]}" cy="{GURU[1]}" r="11" fill="#10d98a"/>
  {sparkles}
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
