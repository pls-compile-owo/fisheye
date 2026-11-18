#!/usr/bin/env python3
"""生成 fisheye 演示 GIF：输入视频 → 处理 → 拼图 → 摘要。"""
import os
from PIL import Image, ImageDraw, ImageFont

WORK = os.environ.get("GIF_WORK", os.path.join(os.environ.get("TEMP", "."), "fisheye-gif"))
OUT = os.environ.get("GIF_OUT", os.path.join(os.path.expanduser("~"), "Desktop", "fisheye-demo-zh.gif"))

W, H = 960, 640
BG = (13, 17, 23)          # 深色背景
CARD = (22, 27, 34)        # 卡片
BORDER = (48, 54, 61)
FG = (230, 237, 243)       # 主文字
DIM = (139, 148, 158)      # 次要文字
GREEN = (63, 185, 80)      # OK
BLUE = (88, 166, 255)      # 强调
YELLOW = (210, 153, 34)    # 提示

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

def draw_arrow(d, x1, y, x2, color=DIM):
    d.line([x1, y, x2 - 8, y], fill=color, width=2)
    d.polygon([(x2, y), (x2 - 10, y - 5), (x2 - 10, y + 5)], fill=color)

def baseline():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # 顶部标题栏
    d.text((40, 24), "fisheye", font=f_title, fill=FG)
    d.text((160, 34), "让 AI 看懂视频 · token 预算优先", font=f_sub, fill=DIM)
    d.line([40, 74, W - 40, 74], fill=BORDER, width=1)
    return img, d

frames = []

# ── 帧 1：输入视频 ──
img, d = baseline()
d.text((40, 100), "① 输入：任意视频（B站 / 本地 / 任意链接）", font=f_sub, fill=BLUE)
card(d, 40, 140, 400, 300)
thumb = Image.open(os.path.join(WORK, "input.jpg")).convert("RGB")
thumb.thumbnail((380, 240))
img.paste(thumb, (50, 150))
d.text((50, 400), "30s 萌宠动画 · 1280x720", font=f_body, fill=DIM)
# 右侧对比卡
card(d, 480, 140, 440, 300)
d.text((500, 160), "为什么不能直接均匀抽帧？", font=f_label, fill=YELLOW)
d.text((500, 195), "1 fps 采样 40 分钟视频", font=f_body, fill=FG)
d.text((500, 225), "≈ 2400 帧 ≈ 60 万 token", font=f_mono, fill=(248, 81, 73))
d.text((500, 270), "fisheye 的思路：", font=f_body, fill=FG)
d.text((500, 300), "① 官方字幕优先（几百 token）", font=f_body, fill=DIM)
d.text((500, 330), "② 没字幕再抽帧拼图", font=f_body, fill=DIM)
d.text((500, 360), "③ 只对关键帧做原分辨率精读", font=f_body, fill=DIM)
d.text((40, 500), "下一步：规划抽帧  →", font=f_sub, fill=GREEN)
frames.append(img)

# ── 帧 2：命令与处理日志 ──
img, d = baseline()
d.text((40, 100), "② 处理：fisheye 自动规划 + 抽帧拼图", font=f_sub, fill=BLUE)
card(d, 40, 140, 880, 410)
y = 160
lines = [
    ("$ ", "$ node fisheye.mjs auto BV1Cc411Q78T --budget 20000", FG),
    ("", "", FG),
    ("[字幕] ", "[字幕] 官方中文 6 行 / 52 字 ≈ 52 token → 跳过字幕带", GREEN),
    ("[弹幕] ", "[弹幕] 2 条，观众最激动的时段：", GREEN),
    ("[密度] ", "[密度] 目标 ≤13s/帧（按变化率推导）", FG),
    ("[张数] ", "[张数] 密度需要 1 张，预算允许 7 张 → 采用 1 张", FG),
    ("[预算] ", "[预算] 20000 token ≈ 字幕 52 + 拼图 1200 + 精读预留 2600", FG),
    ("[拼图] ", "[拼图 1/1] 00:00-00:30  9 帧 → BV1Cc411Q78T-c00_3x3.jpg", BLUE),
]
for tag, text, color in lines:
    if tag:
        d.text((60, y), tag, font=f_mono, fill=(139, 148, 158))
        d.text((60 + d.textlength(tag, font=f_mono), y), text[len(tag):], font=f_mono, fill=color)
    else:
        d.text((60, y), text, font=f_mono, fill=color)
    y += 34
d.text((40, 510), "下一步：把拼图交给模型读  →", font=f_sub, fill=GREEN)
frames.append(img)

# ── 帧 3：拼图产物 ──
img, d = baseline()
d.text((40, 100), "③ 产物：网格拼图——张数按视频动态决定（1~38 张）", font=f_sub, fill=BLUE)
card(d, 40, 140, 500, 470)
sheet = Image.open(os.path.join(WORK, "sheet.jpg")).convert("RGB")
sheet.thumbnail((470, 440))
img.paste(sheet, (55, 155))
# 右侧说明
card(d, 570, 140, 350, 220)
d.text((590, 160), "拼图的作用", font=f_label, fill=YELLOW)
d.text((590, 195), "每张网格 3x3=9 / 4x4=16 / 5x5=25 帧", font=f_body, fill=FG)
d.text((590, 225), "张数 = f(时长, 变化率, token 预算)", font=f_body, fill=DIM)
d.text((590, 255), "示例这条 30s 视频只用了 1 张", font=f_body, fill=DIM)
card(d, 570, 380, 350, 230)
d.text((590, 400), "精读（可选）", font=f_label, fill=YELLOW)
d.text((590, 435), "看不清的格子 → refine", font=f_body, fill=FG)
d.text((590, 465), "只对少数点花原分辨率成本", font=f_body, fill=DIM)
d.text((590, 495), "字幕糊的帧会自动建议精读", font=f_body, fill=DIM)
frames.append(img)

# ── 帧 4：输出摘要 ──
img, d = baseline()
d.text((40, 100), "④ 输出：AI 读完拼图写出的摘要", font=f_sub, fill=BLUE)
card(d, 40, 140, 880, 380)
y = 165
summary = [
    ("【摘要】起床，老婆，亲亲，三连【返场真喵真事】", FG, f_label),
    ("", FG, f_body),
    ("画面是动画+实拍混剪的萌宠短片：早上两只猫还赖在床上，", FG, f_body),
    ("随后白棕猫凑到棕猫身边趴下——对应标题的「起床、老婆、亲亲」。", FG, f_body),
    ("中段是昏暗室内实拍，真猫趴床，右下角叠着动画猫。", FG, f_body),
    ("结尾回到动画：点赞/币/收藏图标，小猫扑下来叼走星星，", FG, f_body),
    ("猫猫守着币和星星闪闪发光——明显在讨「三连」。", FG, f_body),
    ("", FG, f_body),
    ("信息源：官方字幕 6 行 + 弹幕热区 2 处 + 9 帧拼图", DIM, f_body),
    ("成本：约 7,239 token（整片 30 秒）", DIM, f_body),
]
for text, color, font in summary:
    d.text((60, y), text, font=font, fill=color)
    y += 30
d.text((40, 550), "fisheye · 从视频到摘要，一个命令", font=f_sub, fill=GREEN)
frames.append(img)

# 输出 GIF
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=1800, loop=0, optimize=True)
size = os.path.getsize(OUT)
print(f"GIF: {OUT} ({size / 1024:.0f} KB, {len(frames)} 帧)")
