#!/usr/bin/env python3
"""生成 fisheye 2.0 演示 GIF：输入视频 → fast 文本模式 → 段卡片 → 按需 render。

2.0 默认只产文本证据（不渲染）；画面由 agent 决定时才 render。
素材（input.jpg / sheet.jpg）放在 GIF_WORK（默认 %TEMP%/fisheye-gif）。
输出默认写到项目 docs/demo-zh.gif（不写桌面）。
"""
import os
from PIL import Image, ImageDraw, ImageFont

WORK = os.environ.get("GIF_WORK", os.path.join(os.environ.get("TEMP", "."), "fisheye-gif"))
PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("GIF_OUT", os.path.join(PKG, "docs", "demo-zh.gif"))

W, H = 960, 640
BG = (13, 17, 23)          # 深色背景
CARD = (22, 27, 34)        # 卡片
BORDER = (48, 54, 61)
FG = (230, 237, 243)       # 主文字
DIM = (139, 148, 158)      # 次要文字
GREEN = (63, 185, 80)      # OK
BLUE = (88, 166, 255)      # 强调
YELLOW = (210, 153, 34)    # 提示
RED = (248, 81, 73)        # 警告

FONT = r"C:\Windows\Fonts\msyh.ttc"
FONT_B = r"C:\Windows\Fonts\msyhbd.ttc"
MONO = r"C:\Windows\Fonts\simsun.ttc"  # 宋体（中文等宽感；Consolas 不含中文会变方块）

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
    d.text((160, 34), "把视频压成证据 + 成本 · 判断归 agent", font=f_sub, fill=DIM)
    d.line([40, 74, W - 40, 74], fill=BORDER, width=1)
    return img, d

frames = []

# ── 帧 1：输入 + 为什么 ──
img, d = baseline()
d.text((40, 100), "① 输入：任意视频（B站 / 本地 / 任意链接）", font=f_sub, fill=BLUE)
card(d, 40, 140, 400, 300)
thumb = Image.open(os.path.join(WORK, "input.jpg")).convert("RGB")
thumb.thumbnail((380, 240))
img.paste(thumb, (50, 150))
d.text((50, 400), "30s 萌宠动画 · 1280x720", font=f_body, fill=DIM)
card(d, 480, 140, 440, 300)
d.text((500, 160), "为什么不能全读？", font=f_label, fill=YELLOW)
d.text((500, 195), "1 fps 采样 40 分钟视频", font=f_body, fill=FG)
d.text((500, 225), "≈ 2400 帧 ≈ 60 万 token", font=f_mono, fill=RED)
d.text((500, 270), "2.0 的做法（默认只产文本）：", font=f_body, fill=FG)
d.text((500, 300), "① 字幕降级链：翻译轨 → 原文 → 转写", font=f_body, fill=DIM)
d.text((500, 330), "② 段卡片：每 4 分钟一段的骨架 + 弹幕情绪", font=f_body, fill=DIM)
d.text((500, 360), "③ 画面只在 agent 要时 render（默认不渲染）", font=f_body, fill=DIM)
d.text((40, 500), "下一步：auto 默认 fast 文本模式  →", font=f_sub, fill=GREEN)
frames.append(img)

# ── 帧 2：fast 命令与日志 ──
img, d = baseline()
d.text((40, 100), "② 处理：auto 默认只产文本（<5s，零渲染）", font=f_sub, fill=BLUE)
card(d, 40, 140, 880, 400)
y = 160
lines = [
    ("$ ", "$ node fisheye.mjs auto BV1Cc411Q78T", FG),
    ("", "", FG),
    ("[字幕] ", "[字幕] 官方中文 6 行 / 52 字（翻译轨优先）", GREEN),
    ("[弹幕] ", "[弹幕] 2 条，低活跃 1 段", GREEN),
    ("", "=== 完成（fast 文本模式，未渲染任何画面）===", FG),
    ("", "只读文本 ≈ 230 token（1 段骨架）", FG),
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
d.text((40, 560), "stdout 只留路径（agent 读）；日志走 stderr（人看）", font=f_sub, fill=GREEN)
frames.append(img)

# ── 帧 3：段卡片（文本证据） ──
img, d = baseline()
d.text((40, 100), "③ 产物：段卡片（manifest schemaVersion 2）", font=f_sub, fill=BLUE)
card(d, 40, 140, 880, 400)
y = 162
seg = [
    ("段 1  00:00-00:30   dur 30s", f_label, FG),
    ("", f_body, FG),
    ("subs.head : \"起床，老婆，亲亲，三连【返场真喵真事】\"", f_mono, FG),
    ("subs.keywords: [返场, 真喵, 三连]", f_mono, DIM),
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
d.text((60, 578), "报价：text 2000  /  coarse 1024  /  fine 1024（官方 Flash 每图上限）", font=f_body, fill=GREEN)
frames.append(img)

# ── 帧 4：按需 render（可选） ──
img, d = baseline()
d.text((40, 100), "④ 按需：agent 决定读图才 render（默认不渲染）", font=f_sub, fill=BLUE)
card(d, 40, 140, 500, 400)
sheet = Image.open(os.path.join(WORK, "sheet.jpg")).convert("RGB")
sheet.thumbnail((470, 380))
img.paste(sheet, (55, 155))
card(d, 570, 140, 350, 180)
d.text((590, 158), "$ node fisheye.mjs render \\", font=f_mono, fill=FG)
d.text((590, 186), "    BV1Cc411Q78T --track coarse", font=f_mono, fill=FG)
d.text((590, 222), "[coarse] 全片 1 帧 → 1 张", font=f_mono, fill=GREEN)
d.text((590, 250), "SHEET: ...-coarse-0_3x3.jpg", font=f_mono, fill=BLUE)
card(d, 570, 340, 350, 200)
d.text((590, 360), "默认不渲染的意义", font=f_label, fill=YELLOW)
d.text((590, 395), "省磁盘：auto 零 jpg", font=f_body, fill=DIM)
d.text((590, 425), "省 token：只有要画面才花 1024/张", font=f_body, fill=DIM)
d.text((590, 455), "可声明 visualTrack：on/ask/off", font=f_body, fill=DIM)
d.text((40, 570), "fisheye · 把视频压成证据 + 成本，判断归 agent", font=f_sub, fill=GREEN)
frames.append(img)

# 输出 GIF
os.makedirs(os.path.dirname(OUT), exist_ok=True)
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=2200, loop=0, optimize=True)
size = os.path.getsize(OUT)
print(f"GIF: {OUT} ({size / 1024:.0f} KB, {len(frames)} 帧)")
