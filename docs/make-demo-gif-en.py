#!/usr/bin/env python3
"""Generate fisheye demo GIF (English, for Show HN): video -> process -> grid -> summary."""
import os
from PIL import Image, ImageDraw, ImageFont

WORK = os.environ.get("GIF_WORK", os.path.join(os.environ.get("TEMP", "."), "fisheye-gif"))
OUT = os.environ.get("GIF_OUT", os.path.join(os.path.expanduser("~"), "Desktop", "fisheye-demo.gif"))

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
MONO = r"C:\Windows\Fonts\simsun.ttc"

def load(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

f_title = load(FONT_B, 32)
f_sub = load(FONT, 19)
f_body = load(FONT, 17)
f_mono = load(MONO, 15)
f_label = load(FONT_B, 15)

def card(d, x, y, w, h, r=12):
    d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=CARD, outline=BORDER, width=1)

def baseline():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((40, 24), "fisheye", font=f_title, fill=FG)
    d.text((170, 34), "video understanding for AI agents, token budget first", font=f_sub, fill=DIM)
    d.line([40, 74, W - 40, 74], fill=BORDER, width=1)
    return img, d

frames = []

# ── Frame 1: input ──
img, d = baseline()
d.text((40, 100), "1. Input: any video (Bilibili / local file / any URL)", font=f_sub, fill=BLUE)
card(d, 40, 140, 400, 300)
thumb = Image.open(os.path.join(WORK, "input.jpg")).convert("RGB")
thumb.thumbnail((380, 240))
img.paste(thumb, (50, 150))
d.text((50, 400), "30s cat short - 1280x720", font=f_body, fill=DIM)
card(d, 480, 140, 440, 300)
d.text((500, 160), "Why not just sample 1 fps?", font=f_label, fill=YELLOW)
d.text((500, 195), "1 fps on a 40-min video", font=f_body, fill=FG)
d.text((500, 225), "~2,400 frames ~= 600k tokens", font=f_mono, fill=RED)
d.text((500, 270), "fisheye instead:", font=f_body, fill=FG)
d.text((500, 300), "1) official subtitles first (a few hundred tokens)", font=f_body, fill=DIM)
d.text((500, 330), "2) frame grids only when needed", font=f_body, fill=DIM)
d.text((500, 360), "3) full-res close-ups for key moments only", font=f_body, fill=DIM)
d.text((40, 500), "next: plan the frames  ->", font=f_sub, fill=GREEN)
frames.append(img)

# ── Frame 2: process ──
img, d = baseline()
d.text((40, 100), "2. Processing: auto plan + frame grids", font=f_sub, fill=BLUE)
card(d, 40, 140, 880, 410)
y = 165
lines = [
    ("$ ", "$ node fisheye.mjs auto BV1Cc411Q78T --budget 20000", FG),
    ("", "", FG),
    ("[subs] ", "[subs] official zh, 6 lines / 52 chars ~= 52 tokens -> skip burnt-in band", GREEN),
    ("[danmaku] ", "[danmaku] 2 comments, audience peak moments", GREEN),
    ("[density] ", "[density] target <=13s/frame (derived from content rate)", FG),
    ("[grids] ", "[grids] density needs 1, budget allows 7 -> use 1", FG),
    ("[budget] ", "[budget] 20000 tokens ~= subs 52 + grids 1200 + close-ups 2600", FG),
    ("[grid] ", "[grid] 1/1 00:00-00:30  9 frames -> BV1Cc411Q78T-c00_3x3.jpg", BLUE),
]
for tag, text, color in lines:
    if tag:
        d.text((60, y), tag, font=f_mono, fill=DIM)
        d.text((60 + d.textlength(tag, font=f_mono), y), text[len(tag):], font=f_mono, fill=color)
    else:
        d.text((60, y), text, font=f_mono, fill=color)
    y += 34
d.text((40, 510), "next: hand the grid to the model  ->", font=f_sub, fill=GREEN)
frames.append(img)

# ── Frame 3: artifact ──
img, d = baseline()
d.text((40, 100), "3. Artifact: one 3x3 grid = 9 keyframes (~1,200 tokens)", font=f_sub, fill=BLUE)
card(d, 40, 140, 500, 470)
sheet = Image.open(os.path.join(WORK, "sheet.jpg")).convert("RGB")
sheet.thumbnail((470, 440))
img.paste(sheet, (55, 155))
card(d, 570, 140, 350, 220)
d.text((590, 160), "What the grid does", font=f_label, fill=YELLOW)
d.text((590, 195), "One image covers 9 moments", font=f_body, fill=FG)
d.text((590, 225), "timestamps left->right, top->bottom", font=f_body, fill=DIM)
d.text((590, 255), "model locates them via manifest", font=f_body, fill=DIM)
card(d, 570, 380, 350, 230)
d.text((590, 400), "Close-up (optional)", font=f_label, fill=YELLOW)
d.text((590, 435), "blurry cells -> refine", font=f_body, fill=FG)
d.text((590, 465), "full-res cost only where it matters", font=f_body, fill=DIM)
d.text((590, 495), "blurry subtitles are auto-suggested", font=f_body, fill=DIM)
frames.append(img)

# ── Frame 4: summary ──
img, d = baseline()
d.text((40, 100), "4. Output: the summary the model writes after reading the grid", font=f_sub, fill=BLUE)
card(d, 40, 140, 880, 380)
y = 165
summary = [
    ("[summary] Wake up, honey, kisses + like/coin/fav - a cat short", FG, f_label),
    ("", FG, f_body),
    ("An animation + live-action cat short. Two cats are still in bed", FG, f_body),
    ("in the morning, then the white-brown cat snuggles up to the brown", FG, f_body),
    ("one - matching the title's wake up / kiss. The middle is dim", FG, f_body),
    ("live-action: a real cat on the bed with an animated cat overlaid.", FG, f_body),
    ("The ending returns to animation: like/coin/fav icons, a small cat", FG, f_body),
    ("dives down and snatches the star; the cats guard the coins -", FG, f_body),
    ("clearly begging for a like.", FG, f_body),
    ("", FG, f_body),
    ("sources: official subs (6 lines) + danmaku peaks (2) + 9-frame grid", DIM, f_body),
    ("cost: ~7,239 tokens for the whole 30s clip", DIM, f_body),
]
for text, color, font in summary:
    d.text((60, y), text, font=font, fill=color)
    y += 30
d.text((40, 550), "fisheye - one command from video to summary", font=f_sub, fill=GREEN)
frames.append(img)

frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=1800, loop=0, optimize=True)
print(f"GIF: {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB, {len(frames)} frames)")
