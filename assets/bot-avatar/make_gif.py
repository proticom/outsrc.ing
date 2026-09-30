"""outsrc.ing bot avatar: light-gray mochi body (from the site favicon), sphere-mapped black pill eyes
and smile, long holds, short blinks, body tilt toward the gaze. Transparent 256x256 looping GIF."""
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = 256
HI = 1024                      # working resolution (4x supersample)
K = HI / OUT
BODY = (233, 233, 236)
EDGE = (150, 150, 160)           # rim color at the silhouette edge
EDGE_SOFT = 22                   # rim softness at working res (~5 px at 256)
BLACK = (20, 20, 24)
GLINT = (250, 250, 252)

# ---------- body: dome over a slightly wider soft base, ~88% of the canvas wide ----------
mask = Image.new("L", (HI, HI), 0)
d = ImageDraw.Draw(mask)
d.ellipse((512 - 378, 148, 512 + 378, 861), fill=255)                 # dome
d.rounded_rectangle((512 - 400, 470, 512 + 400, 888), radius=190, fill=255)  # base
mask = mask.filter(ImageFilter.GaussianBlur(44)).point(lambda v: 255 if v >= 128 else 0)
# soft darker rim inside the silhouette so the light body still reads on light backgrounds
inside = np.array(mask.filter(ImageFilter.GaussianBlur(EDGE_SOFT)), dtype=np.float64)
rim = np.clip((255 - inside) / 127, 0, 1) ** 0.8          # 1 at the edge, fading to 0 inward
rgb = np.array(BODY, float) * (1 - rim[..., None]) + np.array(EDGE, float) * rim[..., None]
face = Image.fromarray(np.dstack([rgb, np.array(mask)]).astype(np.uint8), "RGBA")
INNER = np.array(mask.filter(ImageFilter.MinFilter(41))) >= 128   # keep features off the silhouette edge

# ---------- features live on a virtual sphere centered in the dome ----------
SR = 103                        # sphere radius in px at 256
RS = SR * K
SPHERE_CY = 134 * K            # sphere center, px down the canvas
EYE_LON = math.asin(41 / SR)   # eye centers ~82 px apart
EYE_LAT = math.asin(-7 / SR)   # eye line ~50% down the canvas
EYE_HW = 14 / SR               # ~28 px wide
EYE_HH = 24 / SR               # ~48 px tall
GLINT_R = 4.5 / SR             # eye highlight radius
GLINT_DX, GLINT_DY = 4 / SR, 10 / SR   # highlight offset right and up from the eye center
MOUTH_LAT = 24 / SR            # mouth line sits below the eyes
MOUTH_T = 3 / SR               # stroke half thickness


class Mouth(tuple):
    """Mouth shape in px at 256: half width, end rise, open depth, right-end skew, 'o' radii."""
    __slots__ = ()

    def __new__(cls, hw=18, rise=5, open=0, skew=0, orx=0, ory=0):
        return super().__new__(cls, (hw, rise, open, skew, orx, ory))

    def mix(self, other, t):
        return Mouth(*(a + (b - a) * t for a, b in zip(self, other)))


SMILE = Mouth()                                  # the favicon's small smile
BIG_SMILE = Mouth(hw=22, rise=8)                 # wider closed smile, content
OOH = Mouth(hw=0, rise=0, orx=9, ory=11)         # small surprised "o"
SMIRK = Mouth(hw=16, rise=3, skew=7)             # right corner hitched up
WRY = Mouth(hw=14, rise=-2, skew=-6)             # lopsided, left corner up over a slight frown
WRY_MIRROR = Mouth(hw=14, rise=-2, skew=6)       # same, right corner up
MAX_YAW, MAX_PITCH = 0.5, 0.32

ys, xs = np.mgrid[0:HI, 0:HI].astype(np.float64)
NX = (xs + 0.5 - HI / 2) / RS
NY = (ys + 0.5 - SPHERE_CY) / RS
R2 = NX ** 2 + NY ** 2
ON_SPHERE = R2 < 1
NZ = np.sqrt(np.clip(1 - R2, 0, 1))


def feature_mask(gx, gy, lid, mouth):
    """Pixels covered by eyes and smile after rotating the pattern over the sphere toward (gx, gy)."""
    yaw, pitch = gx * MAX_YAW, -gy * MAX_PITCH
    cy, sy = math.cos(-yaw), math.sin(-yaw)
    x1, z1 = NX * cy + NZ * sy, -NX * sy + NZ * cy
    cp, sp = math.cos(pitch), math.sin(pitch)
    y2, z2 = NY * cp + z1 * sp, -NY * sp + z1 * cp
    lon = np.arctan2(x1, z2)
    lat = np.arcsin(np.clip(y2, -1, 1))

    r = min(EYE_HW, EYE_HH * lid)
    lx, ly = EYE_HW - r, EYE_HH * lid - r
    m = np.zeros_like(ON_SPHERE)
    glint = np.zeros_like(ON_SPHERE)
    for c in (-EYE_LON, EYE_LON):
        dx = np.maximum(np.abs(lon - c) - lx, 0)
        dy = np.maximum(np.abs(lat - EYE_LAT) - ly, 0)
        eye = dx * dx + dy * dy <= r * r
        m |= eye
        if lid > 0.6:   # the favicon's highlight, upper right of each eye; hidden mid-blink
            glint |= eye & ((lon - c - GLINT_DX) ** 2 + (lat - EYE_LAT + GLINT_DY) ** 2 <= GLINT_R ** 2)

    hw, rise, depth, skew, orx, ory = (v / SR for v in mouth)
    if hw > 0.5 / SR:
        # stroke: a thick arc with round caps; skew lifts the right end
        u = np.clip(lon / hw, -1, 1)
        top = MOUTH_LAT - rise * u ** 2 - skew * (u + 1) / 2
        m |= (lon - u * hw) ** 2 + (lat - top) ** 2 <= MOUTH_T ** 2
        if depth > 0:
            inside = np.abs(lon) <= hw
            m |= inside & (lat >= top) & (lat <= top + depth * (1 - u ** 2))
    if orx > 0:
        m |= (lon / orx) ** 2 + ((lat - MOUTH_LAT - 2 / SR) / ory) ** 2 <= 1
    visible = ON_SPHERE & (z2 > 0) & INNER
    return m & visible, glint & visible


def perspective_coeffs(dst, src):
    A, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        b += [u, v]
    return np.linalg.solve(np.array(A, float), np.array(b, float)).tolist()


def tilt(im, yaw, pitch, roll):
    h = HI / 2
    ya, pa, ra = map(math.radians, (yaw, pitch, roll))
    f = HI * 2.4
    dst = []
    for x, y in [(-h, -h), (h, -h), (h, h), (-h, h)]:
        x, y = x * math.cos(ra) - y * math.sin(ra), x * math.sin(ra) + y * math.cos(ra)
        x, z = x * math.cos(ya), -x * math.sin(ya)
        y, z = y * math.cos(pa) - z * math.sin(pa), y * math.sin(pa) + z * math.cos(pa)
        s = f / (f + z)
        dst.append((h + x * s, h + y * s))
    return im.transform((HI, HI), Image.PERSPECTIVE,
                        perspective_coeffs(dst, [(0, 0), (HI, 0), (HI, HI), (0, HI)]), Image.BICUBIC)


def render(gx, gy, lid, mouth):
    arr = np.array(face)
    ink, glint = feature_mask(gx, gy, lid, mouth)
    arr[ink] = BLACK + (255,)
    arr[glint] = GLINT + (255,)
    im = tilt(Image.fromarray(arr, "RGBA"), yaw=-gx * 18, pitch=gy * 14, roll=gx * gy * -7)
    return im.resize((OUT, OUT), Image.LANCZOS)


# ---------- timeline: long holds, short eased glances, quick blinks ----------
steps = []                      # (gx, gy, lid, mouth, ms)
pose = [0.0, 0.0]
face_now = [SMILE]


def hold(ms):
    steps.append((pose[0], pose[1], 1.0, face_now[0], ms))


def blink():
    for lid, ms in ((0.45, 40), (0.0, 110), (0.45, 50)):
        steps.append((pose[0], pose[1], lid, face_now[0], ms))


def look(gx=None, gy=None, mouth=None, n=5, ms=40):
    """Ease the gaze and/or the mouth to a new target together."""
    x0, y0 = pose
    gx, gy = (x0 if gx is None else gx), (y0 if gy is None else gy)
    m0, m1 = face_now[0], mouth or face_now[0]
    for i in range(1, n + 1):
        t = i / n
        e = t * t * (3 - 2 * t)
        steps.append((x0 + (gx - x0) * e, y0 + (gy - y0) * e, 1.0, m0.mix(m1, e), ms))
    pose[:] = [gx, gy]
    face_now[0] = m1


if __name__ == "__main__":
    hold(1800); blink(); hold(1300)
    look(0.7, -0.6, SMIRK); hold(1600)                           # up-right: smirk
    look(-0.8, 0.7, OOH, n=6); hold(700); blink(); hold(1000)    # down-left: "oh!"
    look(-1.0, 0.0, WRY_MIRROR); hold(1400)                      # left: wry, right corner up
    look(1.0, 0.1, WRY, n=6); hold(1500); blink(); hold(700)     # right: wry
    look(0.0, 0.0, SMILE); hold(1500); blink(); hold(160); blink(); hold(300)
    look(mouth=BIG_SMILE, n=4); hold(700); look(mouth=SMILE, n=4); hold(900)   # content beat before the loop

    frames = [render(*s[:4]) for s in steps]
    durs = [s[4] for s in steps]

    sample = Image.new("RGB", (OUT * len(frames), OUT))
    for k, f in enumerate(frames):
        sample.paste(f.convert("RGB"), (k * OUT, 0))
    pal = sample.quantize(31, dither=Image.NONE).getpalette()[: 31 * 3]
    ref = Image.new("P", (1, 1))
    ref.putpalette([255, 0, 255] + pal + [0, 0, 0] * (256 - 32))

    gif = []
    for f in frames:
        arr = np.array(f.convert("RGB").quantize(palette=ref, dither=Image.NONE))
        arr[np.array(f.getchannel("A")) < 128] = 0
        q = Image.fromarray(arr.astype(np.uint8), "P")
        q.putpalette(ref.getpalette())
        gif.append(q)

    gif[0].save("outsrc-bot-eyes.gif", save_all=True, append_images=gif[1:], duration=durs,
                loop=0, disposal=2, transparency=0, optimize=False)

    picks = list(range(0, len(frames), max(1, len(frames) // 12)))[:12]
    sheet = Image.new("RGB", (len(picks) * 40, 80))
    for i, k in enumerate(picks):
        small = frames[k].resize((32, 32), Image.LANCZOS)
        for row, bg in enumerate(((30, 30, 30), (240, 240, 240))):
            tile = Image.new("RGB", (40, 40), bg)
            tile.paste(small, (4, 4), small)
            sheet.paste(tile, (i * 40, row * 40))
    sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST).save("preview-32px.png")
    print(f"{len(frames)} frames, {sum(durs) / 1000:.1f}s loop")
