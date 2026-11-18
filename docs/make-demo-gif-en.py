#!/usr/bin/env python3
"""Generate the fisheye 2.0 demo GIF: input video → fast text mode → segment cards → on-demand render.

2.0 produces text evidence only by default (no render); images are rendered only when the agent asks.
Assets (input.jpg / sheet.jpg) live in GIF_WORK (default %TEMP%/fisheye-gif).
Output defaults to the project's docs/demo-en.gif (never the Desktop).
"""
import os
from PIL import Image, ImageDraw, ImageFont

WORK = os.environ.get("GIF_WORK", os.path.join(os.environ.get("TEMP", "."), "fisheye-gif"))
PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("GIF_OUT", os.path.join(PKG, "docs", "demo-en.gif"))

W, H = 960, 640
BG = (13, 17, 23)
CARD = (22, 27, 34)
BORDER = (48, 54, 61)
FG = (230, 237, 243)
DIM = (139, 148, 158)
GREEN = (63, 185, 80)
BLUE = (88, 166, 255)
YELLOW = (210, 153, 34)
RED = (248, 81, 73)

FONT = r"C:\Windows\Fonts\msyh.ttc"
FONT_B = r"C:\Windows\Fonts\msyhbd.ttc"
MONO = r"C:\Windows\Fonts\consola.ttf"

def load(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

f_title = load(FONT_B, 32)
f_sub = load(FONT, 19)
f_body = load(FONT, 17)
f_mono = load(MONO, 16)
f_label = load(FONT_B, 15)

def card(d, x, y, w, h, r=12, fill=CARD, outline=BORDER):
    d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=outline, width=1)

def baseline():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((40, 24), "fisheye", font=f_title, fill=FG)
    d.text((180, 34), "compress video into evidence + cost; judgment stays with the agent", font=f_sub, fill=DIM)
    d.line([40, 74, W - 40, 74], fill=BORDER, width=1)
    return img, d

frames = []

# ── Frame 1: input + why ──
img, d = baseline()
d.text((40, 100), "1) Input: any video (Bilibili / local / any URL)", font=f_sub, fill=BLUE)
card(d, 40, 140, 400, 300)
thumb = Image.open(os.path.join(WORK, "input.jpg")).convert("RGB")
thumb.thumbnail((380, 240))
img.paste(thumb, (50, 150))
d.text((50, 400), "30s pet animation, 1280x720", font=f_body, fill=DIM)
card(d, 480, 140, 440, 300)
d.text((500, 160), "Why not read everything?", font=f_label, fill=YELLOW)
d.text((500, 195), "1 fps sampling of a 40-min video", font=f_body, fill=FG)
d.text((500, 225), "= 2400 frames = ~600k tokens", font=f_mono, fill=RED)
d.text((500, 270), "2.0 default (text only):", font=f_body, fill=FG)
d.text((500, 300), "1) subtitle fallback: translated -> original -> transcript", font=f_body, fill=DIM)
d.text((500, 330), "2) segment cards: 4-min skeleton + danmaku emotion", font=f_body, fill=DIM)
d.text((500, 360), "3) images only on render (never by default)", font=f_body, fill=DIM)
d.text((40, 500), "Next: auto defaults to fast text mode  ->", font=f_sub, fill=GREEN)
frames.append(img)

# ── Frame 2: fast command and log ──
img, d = baseline()
d.text((40, 100), "2) Process: auto produces text only (<5s, zero render)", font=f_sub, fill=BLUE)
card(d, 40, 140, 880, 400)
y = 160
lines = [
    ("$ ", "$ node fisheye.mjs auto BV1Cc411Q78T", FG),
    ("", "", FG),
    ("[subs] ", "[subs] official zh 6 lines / 52 chars (translation track preferred)", GREEN),
    ("[danmaku] ", "[danmaku] 2 comments, 1 low-activity segment", GREEN),
    ("", "=== done (fast text mode, nothing rendered) ===", FG),
    ("", "text only ~= 230 tokens (1 segment skeleton)", FG),
    ("MANIFEST: ", "MANIFEST: out/BV1Cc411Q78T-manifest.json", BLUE),
    ("PLAN: ", "PLAN: out/BV1Cc411Q78T-plan.json", BLUE),
    ("REPORT: ", "REPORT: out/BV1Cc411Q78T-report.html", BLUE),
]
for tag, text, color in lines:
    if tag:
        d.text((60, y), tag, font=f_mono, fill=DIM)
        d.text((60 + d.textlength(tag, font=f_mono), y), text[len(tag):], font=f_mono, fill=color)
    else:
        d.text((60, y), text, font=f_mono, fill=color)
    y += 34
d.text((40, 560), "stdout = paths only (for the agent); logs go to stderr (for humans)", font=f_sub, fill=GREEN)
frames.append(img)

# ── Frame 3: segment cards (text evidence) ──
img, d = baseline()
d.text((40, 100), "3) Output: segment cards (manifest schemaVersion 2)", font=f_sub, fill=BLUE)
card(d, 40, 140, 880, 400)
y = 162
seg = [
    ("segment 1  00:00-00:30   dur 30s", f_label, FG),
    ("", f_body, FG),
    ("subs.head : \"wake up, honey, kiss, like\"", f_mono, FG),
    ("subs.keywords: [wake, honey, kiss]", f_mono, DIM),
    ("subs.lang : zh    subs.chars: 52", f_mono, DIM),
    ("danmaku.emotion: 0.16 (low)   samples: 2   confidence: low", f_mono, DIM),
    ("adKeywordHits : []", f_mono, DIM),
    ("lowActivity : false    needsFrames: false", f_mono, DIM),
    ("frames.coarse.cost: 1024    frames.fine.cost: 1024", f_mono, DIM),
]
for text, font, color in seg:
    d.text((60, y), text, font=font, fill=color)
    y += 30
card(d, 40, 560, 880, 60)
d.text((60, 578), "Quote: text 2000 / coarse 1024 / fine 1024 (Flash vision cap per image)", font=f_body, fill=GREEN)
frames.append(img)

# ── Frame 4: on-demand render (optional) ──
img, d = baseline()
d.text((40, 100), "4) On demand: render only when the agent wants pixels", font=f_sub, fill=BLUE)
card(d, 40, 140, 500, 400)
sheet = Image.open(os.path.join(WORK, "sheet.jpg")).convert("RGB")
sheet.thumbnail((470, 380))
img.paste(sheet, (55, 155))
card(d, 570, 140, 350, 180)
d.text((590, 158), "$ node fisheye.mjs render \\", font=f_mono, fill=FG)
d.text((590, 186), "    BV1Cc411Q78T --track coarse", font=f_mono, fill=FG)
d.text((590, 222), "[coarse] 1 frame -> 1 grid", font=f_mono, fill=GREEN)
d.text((590, 250), "SHEET: ...-coarse-0_3x3.jpg", font=f_mono, fill=BLUE)
card(d, 570, 340, 350, 200)
d.text((590, 360), "Why no render by default", font=f_label, fill=YELLOW)
d.text((590, 395), "Saves disk: auto writes 0 jpg", font=f_body, fill=DIM)
d.text((590, 425), "Saves tokens: 1024 only when needed", font=f_body, fill=DIM)
d.text((590, 455), "visualTrack: on / ask / off", font=f_body, fill=DIM)
d.text((40, 570), "fisheye - compress video into evidence + cost", font=f_sub, fill=GREEN)
frames.append(img)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=2200, loop=0, optimize=True)
size = os.path.getsize(OUT)
print(f"GIF: {OUT} ({size / 1024:.0f} KB, {len(frames)} frames)")
