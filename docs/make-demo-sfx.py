#!/usr/bin/env python3
"""为 fisheye 演示视频合成音效轨（转场 whoosh / 数字 pop / 痛点 boom / 弹幕 ding / 键盘声），
并与 BGM 混合成最终音轨。

时间轴（73s）：
  0 3 6 9 15 21 26 31 37 43 49 55 59 63 69 → 页面切换 whoosh
  9.4 9.9 → 柱状图增长的 pop
  12 → 省 57 碗数字出现的 ding
  26.5 → 60 万 token 的 boom
  43.5~48.5 → 打字机键盘声
  55.5 56.5 57.5 58.5 → 弹幕 ding
"""
import math
import os
import random
import struct
import wave

RATE = 22050
DUR = 77.0
BGM = os.environ.get("BGM_IN", os.path.join(os.environ.get("TEMP", "."), "fisheye-bgm6.wav"))
OUT = os.environ.get("SFX_OUT", os.path.join(os.environ.get("TEMP", "."), "fisheye-audio-final.wav"))
random.seed(11)

W, H = None, None
buf = [0.0] * int(DUR * RATE)

def add(samples, at, amp_scale=1.0):
    o = int(at * RATE)
    for i, v in enumerate(samples):
        if 0 <= o + i < len(buf):
            buf[o + i] += v * amp_scale

def whoosh(dur=0.3, amp=0.30):
    n = int(dur * RATE)
    out = []
    prev = 0.0
    for i in range(n):
        t = i / RATE
        x = random.uniform(-1, 1)
        y = x - prev
        prev = x
        env = math.sin(math.pi * t / dur) ** 2
        out.append(y * amp * env)
    return out

def ding(freq=1300, dur=0.2, amp=0.20):
    n = int(dur * RATE)
    out = []
    for i in range(n):
        t = i / RATE
        v = math.sin(2 * math.pi * freq * t) * 0.7 + math.sin(2 * math.pi * freq * 2 * t) * 0.2
        out.append(v * amp * math.exp(-t / 0.05))
    return out

def pop(f0=240, f1=560, dur=0.12, amp=0.26):
    n = int(dur * RATE)
    out = []
    for i in range(n):
        t = i / RATE
        f = f0 + (f1 - f0) * (t / dur)
        out.append(math.sin(2 * math.pi * f * t) * amp * math.exp(-t / 0.06))
    return out

def boom(dur=0.55, amp=0.38):
    n = int(dur * RATE)
    out = []
    for i in range(n):
        t = i / RATE
        f = 70 - 30 * (t / dur)
        out.append(math.sin(2 * math.pi * f * t) * amp * math.exp(-t / 0.15))
    return out

def key(amp=0.10):
    n = int(0.03 * RATE)
    out = []
    prev = 0.0
    for i in range(n):
        x = random.uniform(-1, 1)
        y = x - prev
        prev = x
        out.append(y * amp * math.exp(-i / (0.008 * RATE)))
    return out

# ── 痛点 boom ──
add(boom(), 26.5)
add(ding(900, 0.25), 26.2, 0.7)

# ── 打字机键盘声：跟随单字弹出（与视频打字机对齐）──
# 视频：日志页 43-49s，6 行，每行 1.0s，0.35s 内逐字打出；每 3 个字配一声键盘
LOG_TEXTS = [
    "[字幕] 官方英文 1026 行 / 49757 字 + 中文翻译 1088 行",
    "[弹幕] 原始 3600 条，过滤 3 条广告引流 / 17 条刷屏",
    "[广告段] 弹幕密度低谷 2 段（05:43-07:10 等）",
    "[张数] 密度需要 20 张，预算允许 1 张 → 采用 1 张",
    "[预算] 5000 token ≈ 字幕 49757 + 拼图 1200 + 精读 2600",
    "[拼图] [拼图 1/1] 00:00-37:35 9 帧（跳过广告 165s）→ c00_3x3.jpg",
]
for _i, _line in enumerate(LOG_TEXTS):
    _L = len(_line)
    _t0 = 43.0 + _i * 1.0
    for _j in range(0, _L, 3):
        add(key(0.085), _t0 + (_j / _L) * 0.35, 0.9)

# ── 弹幕 ding ──
for t0 in [55.5, 56.5, 57.5, 58.5, 49.5]:
    add(ding(1200 + random.randint(-100, 100), 0.15, 0.15), t0, 0.9)

# ── 读 BGM（转 float）并循环平铺到视频长度 ──
with wave.open(BGM, "rb") as w:
    nch = w.getnchannels()
    frames = w.readframes(w.getnframes())
raw = struct.unpack("<" + "h" * (len(frames) // 2), frames)
bgm = [raw[i] / 32768.0 for i in range(0, len(raw), nch)]  # 取左声道，转 -1..1
total = len(buf)
bgm_loop = [bgm[i % len(bgm)] for i in range(total)] if bgm else [0.0] * total

# 音效轨 + BGM 叠加（float 统一量纲）
n = total
mixed = [buf[i] * 0.9 + bgm_loop[i] * 0.65 for i in range(n)]
peak = max(abs(v) for v in mixed) if mixed else 1
scale = 0.9 / peak if peak > 0 else 1.0
mixed = [max(-32767, min(32767, int(v * scale * 32767))) for v in mixed]

with wave.open(OUT, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(struct.pack("<" + "h" * len(mixed), *mixed))
print("final audio:", OUT, round(os.path.getsize(OUT) / 1024), "KB")
