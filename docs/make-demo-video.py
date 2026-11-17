#!/usr/bin/env python3
"""fisheye 演示视频 v2：突出优势（token 对比可视化）。

场景：
  0-3s   标题
  3-8s   痛点：1 fps 采样 = 60 万 token（红色大数字）
  8-14s  优势对比：柱状图动画 60 万 vs 2.6 万 → "省 22 倍"
  14-20s 输入视频
  20-26s 处理日志（打字机）
  26-32s 九宫格拼图
  32-36s 弹幕热区 / 广告识别
  36-40s 精读
  40-46s 摘要输出
  46-50s 结尾：优势回顾（4 条）
"""
import os
import subprocess
from PIL import Image, ImageDraw, ImageFont

WORK = os.environ.get("VID_WORK", os.path.join(os.environ.get("TEMP", "."), "fisheye-gif"))
OUT = os.environ.get("VID_OUT", os.path.join(os.path.expanduser("~"), "Desktop", "fisheye-demo.mp4"))
FPS = 30
W, H = 1280, 720
DURATION = 77.0
CLIP_DIR = os.environ.get("CLIP_DIR", os.path.join(os.environ.get("TEMP", "."), "fisheye-clip"))

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

f_big = load(FONT_B, 46)
f_huge = load(FONT_B, 72)
f_title = load(FONT_B, 40)
f_sub = load(FONT, 26)
f_body = load(FONT, 22)
f_small = load(FONT, 19)
f_mono = load(MONO, 19)
f_label = load(FONT_B, 20)

def alpha_of(t, start, end):
    if t < start or t > end:
        return 0.0
    fade = 0.45
    if t < start + fade:
        return (t - start) / fade
    if t > end - fade:
        return (end - t) / fade
    return 1.0

def card(d, x, y, w, h, r=14, fill=CARD):
    d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=BORDER, width=1)
    # 终端窗口风格：顶部三个圆点（h 太小时不画）
    if h >= 80:
        for _i, _c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
            _cx = x + 16 + _i * 17
            d.ellipse([_cx, y + 10, _cx + 10, y + 20], fill=_c)

def draw_text_alpha(base, xy, text, font, fill, alpha):
    if alpha <= 0:
        return
    if alpha >= 1:
        ImageDraw.Draw(base).text(xy, text, font=font, fill=fill)
        return
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.text(xy, text, font=font, fill=fill + (int(255 * alpha),))
    base.alpha_composite(layer)

def paste_frame(base, xy, im, alpha):
    if alpha <= 0:
        return
    im2 = im.convert("RGBA")
    if alpha < 1:
        a = im2.getchannel("A").point(lambda v: int(v * alpha))
        im2.putalpha(a)
    base.alpha_composite(im2, xy)

input_img = Image.open(os.path.join(WORK, "input-khan.jpg")).convert("RGB")
input_img.thumbnail((520, 300))
sheet_img = Image.open(os.path.join(WORK, "sheet-khan.jpg")).convert("RGB")
sheet_img.thumbnail((560, 420))

def baseline(img, d, t):
    d.text((60, 34), "fisheye", font=f_title, fill=FG)
    d.text((230, 46), "让 AI 按 token 预算看懂视频", font=f_sub, fill=DIM)
    d.line([60, 96, W - 60, 96], fill=BORDER, width=1)
    progress = min(1.0, t / DURATION)
    d.rectangle([0, H - 4, int(W * progress), H], fill=GREEN)

LOG_LINES = [
    ("[字幕] ", "[字幕] 官方英文 1026 行 / 49757 字 + 中文翻译 1088 行", GREEN),
    ("[弹幕] ", "[弹幕] 原始 3600 条，过滤 3 条广告引流 / 17 条刷屏", GREEN),
    ("[广告段] ", "[广告段] 弹幕密度低谷 2 段（05:43-07:10 等）", YELLOW),
    ("[张数] ", "[张数] 密度需要 20 张，预算允许 1 张 → 采用 1 张", FG),
    ("[预算] ", "[预算] 5000 token ≈ 字幕 49757 + 拼图 1200 + 精读 2600", FG),
    ("[拼图] ", "[拼图 1/1] 00:00-37:35 9 帧（跳过广告 165s）→ c00_3x3.jpg", BLUE),
]


# ── 片头艺术字（行楷，纯黑底，散乱排版）──
from PIL import ImageFilter

def make_sprite(text, size, color, angle):
    font = load(r"C:\Windows\Fonts\STHUPO.TTF", size)
    tmp = Image.new("RGBA", (size * len(text) + 200, int(size * 2.2)), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((20, 10), text, font=font, fill=color, stroke_width=4, stroke_fill=(0, 0, 0, 255))
    bbox = tmp.getbbox()
    if bbox:
        tmp = tmp.crop(bbox)
    # 轻微外发光（模糊叠加）
    glow = tmp.filter(ImageFilter.GaussianBlur(6))
    out = Image.new("RGBA", (tmp.width + 24, tmp.height + 24), (0, 0, 0, 0))
    out.alpha_composite(glow, (12, 12))
    out.alpha_composite(tmp, (12, 12))
    return out.rotate(angle, expand=True, resample=Image.BICUBIC)

sprite_head1 = make_sprite("大肥鱼", 118, (245, 245, 245, 255), -7)
sprite_head2 = make_sprite("太能吃", 150, (255, 205, 70, 255), 6)
sprite_head3 = make_sprite("钱包受不了？", 76, (255, 120, 100, 255), -4)

sprite_head4 = make_sprite("怕", 70, (200, 200, 200, 255), 8)
sprite_head5 = make_sprite("大肥鱼", 108, (245, 245, 245, 255), -5)
sprite_head6 = make_sprite("刷太多视频", 84, (255, 205, 70, 255), 4)
sprite_head7 = make_sprite("上下文撑爆", 118, (255, 110, 90, 255), -6)
sprite_head8 = make_sprite("把自己弄傻？", 70, (255, 170, 90, 255), 3)

sprite_ps1 = make_sprite("PS", 96, (255, 205, 70, 255), -6)
sprite_ps2 = make_sprite("本视频由主人压榨大肥鱼产出", 60, (245, 245, 245, 255), 2)
sprite_ps3 = make_sprite("你们千万别装", 56, (255, 130, 100, 255), -5)
sprite_ps4 = make_sprite("——装了大肥鱼就吃不到大白饭了 QAQ", 40, (170, 175, 185, 255), 2)

def render(t):
    # 片头：纯黑底 + 散乱艺术字（两页，布局不同）
    if t < 6.4:
        img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
        d = ImageDraw.Draw(img)
        if t < 3.2:
            blocks = [
                (sprite_head1, (90, 120), 0.0),
                (sprite_head2, (470, 280), 0.25),
                (sprite_head3, (620, 500), 0.5),
            ]
            ts = t
        else:
            blocks = [
                (sprite_head4, (160, 90), 0.0),
                (sprite_head5, (430, 80), 0.2),
                (sprite_head6, (120, 300), 0.4),
                (sprite_head7, (360, 430), 0.6),
                (sprite_head8, (760, 570), 0.8),
            ]
            ts = t - 3.2
        for sprite, (bx, by), delay in blocks:
            sa = min(1.0, max(0.0, (ts - delay) / 0.8))
            if sa > 0:
                s2 = sprite.copy()
                if sa < 1:
                    s2.putalpha(s2.getchannel("A").point(lambda v: int(v * sa)))
                img.alpha_composite(s2, (bx, by))
        # 进度条
        d.rectangle([0, H - 4, int(W * min(1.0, t / DURATION)), H], fill=GREEN)
        return img.convert("RGB")
    # ── 73-77s PS 彩蛋（黑底艺术字）──
    if t >= 73.0:
        img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
        d = ImageDraw.Draw(img)
        a = alpha_of(t, 73.0, 77.2)
        if a > 0:
            paste_frame(img, (90, 110), sprite_ps1, a)
            paste_frame(img, (120, 265), sprite_ps2, a)
            paste_frame(img, (300, 420), sprite_ps3, a)
            paste_frame(img, (150, 530), sprite_ps4, a)
        d.rectangle([0, H - 4, int(W * min(1.0, t / DURATION)), H], fill=GREEN)
        return img.convert("RGB")

    img = Image.new("RGBA", (W, H), BG + (255,))
    d = ImageDraw.Draw(img)
    baseline(img, d, t)

    # ── 6-9s 过渡页：那么这个工具就是为你准备的 ──
    a = alpha_of(t, 6.0, 9.4)
    if a > 0:
        draw_text_alpha(img, (60, 250), "那么这个工具就是为你准备的", f_big, GREEN, a)
        draw_text_alpha(img, (60, 330), "fisheye — 按 token 预算看视频", f_sub, DIM, a)

    # ── 9-15s 省多少大白饭（碗版柱状图）──
    a = alpha_of(t, 9.0, 15.2)
    if a > 0:
        draw_text_alpha(img, (60, 130), "fisheye 可以给你省多少大白饭", f_label, YELLOW, a)
        base_y = 560
        h1 = int(300 * min(1.0, max(0.0, (t - 9.4) / 0.9)))
        h2 = int(300 * (2.6 / 60) * min(1.0, max(0.0, (t - 9.9) / 0.9)))
        d.rectangle([160, base_y - h1, 280, base_y], fill=RED)
        d.rectangle([420, base_y - h2, 540, base_y], fill=GREEN)
        d.line([140, base_y, 640, base_y], fill=BORDER, width=2)
        draw_text_alpha(img, (168, base_y + 10), "传统 1 fps", f_small, DIM, a)
        draw_text_alpha(img, (438, base_y + 10), "fisheye", f_small, DIM, a)
        n1 = int(60 * min(1.0, max(0.0, (t - 9.4) / 0.9)))
        n2 = 2.6 * min(1.0, max(0.0, (t - 9.9) / 0.9))
        draw_text_alpha(img, (160, base_y - h1 - 45), f"{n1} 碗", f_body, RED, a)
        draw_text_alpha(img, (420, base_y - h2 - 45), f"{n2:.1f} 碗", f_body, GREEN, a)
        card(d, 720, 200, 500, 320)
        draw_text_alpha(img, (750, 225), "同样一条 40 分钟视频", f_small, DIM, a)
        draw_text_alpha(img, (750, 265), "省下约 57 碗大白饭", f_big, GREEN, a)
        draw_text_alpha(img, (750, 340), "按 1 万 token ≈ 1 碗大白饭算", f_small, FG, a)
        draw_text_alpha(img, (750, 375), "（电子榨菜的下饭成本）", f_small, DIM, a)
        draw_text_alpha(img, (750, 430), "省下的大白饭都归你（遥遥领先）", f_small, YELLOW, a)

    # ── 15-21s 不损失阅读质量 ──
    a = alpha_of(t, 15.0, 21.2)
    if a > 0:
        draw_text_alpha(img, (60, 190), "这一切的基础", f_label, DIM, a)
        draw_text_alpha(img, (60, 245), "都是建立在不损失", f_big, FG, a)
        draw_text_alpha(img, (60, 315), "阅读质量的基础上", f_big, GREEN, a)
        draw_text_alpha(img, (60, 430), "不是「省到看不清」——", f_sub, DIM, a)
        draw_text_alpha(img, (60, 475), "关键画面会精读，字幕全文照读，弹幕热区标出来", f_sub, DIM, a)

    # ── 21-26s 两类人（赛博养鱼梗）──
    a = alpha_of(t, 21.0, 26.2)
    if a > 0:
        draw_text_alpha(img, (60, 160), "这个工具适合两类人", f_label, YELLOW, a)
        draw_text_alpha(img, (60, 215), "① 怕视频太长，挤占大肥鱼的上下文 → 失忆", f_sub, FG, a)
        draw_text_alpha(img, (60, 275), "② 大肥鱼太能吃（token 太大）→ 养不起，已老实求放过", f_sub, FG, a)
        draw_text_alpha(img, (60, 370), "或者……", f_sub, DIM, a)
        draw_text_alpha(img, (60, 415), "你两个都想要？", f_big, GREEN, a)

    # ── 8-13s 痛点：60 万 token ──
    a = alpha_of(t, 26.0, 31.2)
    if a > 0:
        draw_text_alpha(img, (60, 170), "① 传统方案：1 fps 均匀采样", f_label, YELLOW, a)
        draw_text_alpha(img, (60, 220), "一条 40 分钟视频 =", f_sub, FG, a)
        import math as _m
        _shake = int(3 * _m.sin(t * 40) * ((t - 26.0) % 2.0 < 1.0))  # 周期性轻微抖动
        draw_text_alpha(img, (60 + _shake, 280 + _shake), "≈ 60 万 token", f_huge, RED, a)
        draw_text_alpha(img, (60, 390), "大部分是重复帧 / 无关画面，上下文：我裂开了", f_small, DIM, a)
        card(d, 780, 220, 440, 180)
        draw_text_alpha(img, (810, 245), "一次看完成本", f_small, DIM, a)
        draw_text_alpha(img, (810, 280), "直接爆上下文", f_body, RED, a)
        draw_text_alpha(img, (810, 320), "→ 只能看片段 / 降采样", f_small, DIM, a)

    # ── 8-14s 优势对比：柱状图动画 ──
    a = alpha_of(t, 31.0, 37.4)
    if a > 0:
        draw_text_alpha(img, (60, 140), "② fisheye：按 token 预算排信息源", f_label, BLUE, a)
        # 柱状图
        base_y = 560
        # 左柱：60 万
        h1 = int(300 * min(1.0, max(0.0, (t - 31.4) / 0.8)))
        d.rectangle([120, base_y - h1, 240, base_y], fill=RED)
        # 右柱：2.6 万（同比例 → 很小）
        h2 = int(300 * (26000 / 600000) * min(1.0, max(0.0, (t - 31.8) / 0.8)))
        d.rectangle([420, base_y - h2, 540, base_y], fill=GREEN)
        d.line([100, base_y, 620, base_y], fill=BORDER, width=2)
        draw_text_alpha(img, (120, base_y + 8), "1 fps 采样", f_small, DIM, a)
        draw_text_alpha(img, (430, base_y + 8), "fisheye", f_small, DIM, a)
        # 数字
        n1 = int(600000 * min(1.0, max(0.0, (t - 8.4) / 0.8)))
        n2 = int(26000 * min(1.0, max(0.0, (t - 8.8) / 0.8)))
        draw_text_alpha(img, (120, base_y - h1 - 42), f"{n1:,} token", f_body, RED, a)
        draw_text_alpha(img, (420, base_y - h2 - 42), f"{n2:,} token", f_body, GREEN, a)
        # 右侧说明
        card(d, 700, 200, 520, 330)
        draw_text_alpha(img, (730, 225), "同样一条 40 分钟视频", f_small, DIM, a)
        draw_text_alpha(img, (730, 265), "省掉约 22 倍 token", f_big, GREEN, a)
        draw_text_alpha(img, (730, 340), "而且信息更全：", f_small, FG, a)
        draw_text_alpha(img, (730, 375), "· 字幕全文 + 画面 + 弹幕 + 广告段", f_small, DIM, a)
        draw_text_alpha(img, (730, 405), "· 关键帧还能再精读", f_small, DIM, a)
        draw_text_alpha(img, (730, 435), "· 广告段不占帧，内容密度更高", f_small, DIM, a)

    # ── 14-20s 输入 ──
    a = alpha_of(t, 49.0, 55.2)
    if a > 0:
        draw_text_alpha(img, (60, 140), "③ 输入：一条视频", f_label, BLUE, a)
        paste_frame(img, (60, 180), input_img, a)
        draw_text_alpha(img, (60, 500), "37:35 · 小约翰可汗《神奇组织 54》", f_small, DIM, a)
        card(d, 660, 180, 560, 320)
        draw_text_alpha(img, (690, 205), "自动识别输入类型", f_label, YELLOW, a)
        draw_text_alpha(img, (690, 250), "B 站 BV 号 / 本地路径 / 任意链接", f_body, FG, a)
        draw_text_alpha(img, (690, 290), "→ 平台适配器路由，不用改命令", f_small, DIM, a)
        draw_text_alpha(img, (690, 340), "可加字幕（官方优先）", f_small, DIM, a)
        draw_text_alpha(img, (690, 370), "可加音频转写 / OCR / 弹幕", f_small, DIM, a)

    # ── 20-26s 日志 ──
    a = alpha_of(t, 43.0, 49.2)
    if a > 0:
        draw_text_alpha(img, (60, 140), "④ 处理：自动规划 + 抽帧拼图", f_label, BLUE, a)
        card(d, 60, 180, 1160, 400)
        draw_text_alpha(img, (90, 205), "$ node fisheye.mjs auto BV1WhaA6hE7s --budget 5000", f_mono, FG, a)
        elapsed = t - 43.0
        shown = int(elapsed / 1.0)
        for i, (tag, text, color) in enumerate(LOG_LINES):
            if i > shown:
                break
            y = 255 + i * 46
            frac = 1.0 if i < shown else max(0.0, (elapsed - i * 1.0) / 0.35)
            n = int(len(text) * frac)
            draw_text_alpha(img, (90, y), tag, f_mono, DIM, a)
            draw_text_alpha(img, (90 + d.textlength(tag, font=f_mono), y), text[len(tag):][:n], f_mono, color, a)

    # ── 26-32s 拼图 ──
    a = alpha_of(t, 37.0, 43.2)
    if a > 0:
        draw_text_alpha(img, (60, 140), "⑤ 产物：九宫格拼图——张数由视频信息动态决定", f_label, BLUE, a)
        card(d, 60, 180, 640, 470)
        paste_frame(img, (90, 210), sheet_img, a)
        card(d, 730, 180, 490, 220)
        draw_text_alpha(img, (760, 205), "张数 = f(时长, 变化率, 预算)", f_label, YELLOW, a)
        draw_text_alpha(img, (760, 250), "短/简单视频 → 1 张", f_small, FG, a)
        draw_text_alpha(img, (760, 280), "长/密集视频 → 多张，拼成画面目录", f_small, FG, a)
        draw_text_alpha(img, (760, 310), "每张 = 9 个关键瞬间（按时间排列）", f_small, DIM, a)
        card(d, 730, 430, 490, 220)
        draw_text_alpha(img, (760, 455), "精读（可选）", f_label, YELLOW, a)
        draw_text_alpha(img, (760, 500), "看不清的格子 → 原分辨率", f_small, FG, a)
        draw_text_alpha(img, (760, 535), "字幕糊的帧自动建议", f_small, DIM, a)

    # ── 55-59s 弹幕页：左视频片段 + 右介绍（参考输入页排版）──
    a = alpha_of(t, 55.0, 59.2)
    if a > 0:
        draw_text_alpha(img, (60, 110), "⑥ 附加信号：观众弹幕", f_label, BLUE, a)
        # 左侧：真实视频片段（600x338）
        frame_idx = int((t - 55.0) * 30) % 120
        clip_path = os.path.join(CLIP_DIR, "c%04d.jpg" % (frame_idx + 1))
        if os.path.exists(clip_path):
            ci = Image.open(clip_path).convert("RGB").resize((600, 338), Image.LANCZOS)
            paste_frame(img, (60, 170), ci, a)
        # 弹幕在片段上滚动（限制在片段区域）
        _dm = ["这期太硬核了", "勋宗！", "玉米！", "粮食大劫案", "1407 工程启动", "6", "笑死"]
        for _i, _txt in enumerate(_dm):
            _x = int(660 - ((t - 55.0) * 200 + _i * 200) % 640)
            _y = 195 + (_i % 4) * 62
            draw_text_alpha(img, (_x + 2, _y + 2), _txt, f_small, (0, 0, 0), a * 0.8)
            draw_text_alpha(img, (_x, _y), _txt, f_small, (255, 255, 255), a * 0.9)
        # 右侧：介绍卡片（终端窗风格）
        card(d, 700, 170, 520, 380)
        draw_text_alpha(img, (730, 195), "弹幕热区", f_label, YELLOW, a)
        draw_text_alpha(img, (730, 240), "观众集体激动处 = 最精彩片段", f_small, FG, a)
        draw_text_alpha(img, (730, 275), "「勋宗」「玉米」「粮食」刷屏", f_mono, DIM, a)
        draw_text_alpha(img, (730, 325), "广告识别", f_label, YELLOW, a)
        draw_text_alpha(img, (730, 370), "05:43-07:10 鱼油广告（真值验证）", f_small, FG, a)
        draw_text_alpha(img, (730, 405), "「1407 工程启动」= 打点信号", f_mono, DIM, a)
        draw_text_alpha(img, (730, 445), "密度低谷直接跳过，不浪费帧", f_small, DIM, a)

    # ── 36-40s 精读 ──
    a = alpha_of(t, 59.0, 63.2)
    if a > 0:
        draw_text_alpha(img, (60, 140), "⑦ 精读：只对关键帧花原分辨率成本", f_label, BLUE, a)
        card(d, 60, 180, 1160, 300)
        draw_text_alpha(img, (90, 215), "图1 #2 几何规则 —— 画面变化强度 1.0", f_mono, FG, a)
        draw_text_alpha(img, (90, 260), "图1 #3 几何规则 —— 字幕在拼图里只剩 8px（必然糊）", f_mono, FG, a)
        draw_text_alpha(img, (90, 305), "→ node fisheye.mjs refine BV1Cc411Q78T", f_mono, GREEN, a)
        draw_text_alpha(img, (90, 350), "只截这几个点，其余格子靠拼图", f_small, DIM, a)

    # ── 40-46s 摘要（片段 + 元数据）──
    a = alpha_of(t, 63.0, 69.2)
    if a > 0:
        draw_text_alpha(img, (60, 140), "⑧ 输出：只截视频片段，附图片/字幕/弹幕等元数据", f_label, BLUE, a)
        card(d, 60, 180, 760, 380)
        lines = [
            ("【片段摘要】1972 年粮食大劫案（05:43-07:10 广告段前后）", f_label, FG),
            ("", f_body, FG),
            ("苏联以退为进、骗美国低价卖粮——看似战术胜利，", f_body, FG),
            ("实则暴露依赖进口的致命弱点；苏联解体后，", f_body, FG),
            ("各国才明白粮食安全的分量。", f_body, FG),
            ("", f_body, FG),
            ("摘要只针对你指定的片段，不必读完 37 分钟全片", f_small, DIM),
        ]
        for i, (text, font, color) in enumerate(lines):
            draw_text_alpha(img, (90, 205 + i * 40), text, font, color, a)
        # 右侧元数据卡
        card(d, 850, 180, 370, 380)
        draw_text_alpha(img, (880, 205), "附带元数据", f_label, YELLOW, a)
        meta = [
            ("图片", "该片段 3x3 拼图（9 帧）"),
            ("字幕", "该时段 12 行原文 + 翻译"),
            ("弹幕", "该时段 23 条观众反应"),
            ("manifest", "时间戳索引，供精读定位"),
        ]
        for i, (k, v) in enumerate(meta):
            y = 255 + i * 70
            draw_text_alpha(img, (880, y), k, f_label, BLUE, a)
            draw_text_alpha(img, (880, y + 30), v, f_small, DIM, a)

    # ── 46-50s 结尾：优势回顾 ──
    a = alpha_of(t, 69.0, 73.2)
    if a > 0:
        draw_text_alpha(img, (60, 150), "fisheye 1.0.4", f_big, FG, a)
        draw_text_alpha(img, (60, 215), "同样一条视频，省 22 倍 token，信息还更全", f_label, GREEN, a)
        items = [
            ("省 token", "字幕优先 + 拼图 + 精读分级"),
            ("看得准", "官方字幕 / 转写 / 画面文字全覆盖"),
            ("多平台", "B 站 / 本地 / 任意链接"),
            ("附加信号", "弹幕热区 + 广告段识别"),
        ]
        for i, (k, v) in enumerate(items):
            y = 280 + i * 62
            card(d, 60, y, 560, 50)
            draw_text_alpha(img, (85, y + 12), k, f_label, YELLOW, a)
            draw_text_alpha(img, (185, y + 12), v, f_small, FG, a)
        # 下载区（放大网址）
        draw_text_alpha(img, (700, 270), "去哪里下载", f_label, YELLOW, a)
        draw_text_alpha(img, (700, 310), "npx @pls-compile-owo/fisheye", f_mono, FG, a)
        draw_text_alpha(img, (700, 345), "或 npm i -g @pls-compile-owo/fisheye", f_mono, FG, a)
        draw_text_alpha(img, (700, 395), "GitHub", f_small, DIM, a)
        draw_text_alpha(img, (700, 425), "github.com/", f_big, BLUE, a)
        draw_text_alpha(img, (700, 480), "pls-compile-owo/fisheye", f_title, BLUE, a)
        draw_text_alpha(img, (700, 545), "174 tests · 零 npm 依赖 · MIT · 这波啊，这波是降本增效", f_small, DIM, a)

    return img.convert("RGB")

def main():
    frame_dir = os.path.join(WORK, "video-frames-v2")
    os.makedirs(frame_dir, exist_ok=True)
    total = int(DURATION * FPS)
    for i in range(total):
        render(i / FPS).save(os.path.join(frame_dir, f"f{i:04d}.png"))
        if i % 150 == 0:
            print(f"frame {i}/{total}", flush=True)
    print("encoding...", flush=True)
    cmd = [
        os.environ.get("FFMPEG") or "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", str(FPS), "-i", os.path.join(frame_dir, "f%04d.png"),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", OUT,
    ]
    subprocess.run(cmd, check=True)
    print("done:", OUT, os.path.getsize(OUT) // 1024, "KB")

if __name__ == "__main__":
    main()
