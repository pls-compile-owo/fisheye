#!/usr/bin/env python3
"""合成 50 秒 lo-fi BGM（v4：减少电子感）。

音色改造：
- 和弦用「钢琴式」包络（短 attack + 指数衰减 + 轻微 strum 错开），不是持续 sine pad
- 低音用软贝斯（正弦 + 极轻谐波，慢衰减）
- 鼓点：kick 带音高下滑、snare 带通噪声、hat 软噪声
- 全局一阶低通（削高频毛刺）+ 轻微音高抖动（非完美音高更像真实演奏）
"""
import math
import os
import random
import struct
import wave

OUT = os.environ.get("BGM_OUT", os.path.join(os.environ.get("TEMP", "."), "fisheye-bgm.wav"))
DUR = 77.0
RATE = 22050
BPM = 88.0
BEAT = 60.0 / BPM
random.seed(7)

CHORDS = [
    (220.00, 261.63, 329.63),   # Am
    (174.61, 220.00, 261.63),   # F
    (261.63, 329.63, 392.00),   # C
    (196.00, 246.94, 293.66),   # G
    (261.63, 311.13, 392.00),   # Cmaj7
    (164.81, 196.00, 246.94),   # Em7
    (220.00, 261.63, 329.63),   # Am
    (174.61, 220.00, 261.63),   # F
    (146.83, 174.61, 220.00),   # Dm
    (196.00, 246.94, 293.66),   # G
    (220.00, 261.63, 329.63),   # Am
    (174.61, 220.00, 261.63),   # F
    (130.81, 164.81, 196.00),   # C
    (146.83, 174.61, 220.00),   # Dm
    (196.00, 246.94, 293.66),   # G
    (220.00, 261.63, 329.63),   # Am
]
ROOTS = [c[0] / 2 for c in CHORDS]

def piano_note(freq, dur, amp=0.12, detune=0.0):
    """钢琴式：短 attack + 指数衰减 + 少量泛音。"""
    n = int(dur * RATE)
    out = [0.0] * n
    f = freq * (1 + detune)
    # 泛音结构（1,2,3，高次衰减快）
    harm = [(1, 0.85, 2.2), (2, 0.35, 3.0), (3, 0.12, 4.0)]
    release = 0.06  # 60ms 释放淡出，避免波形硬截断产生咔哒声
    for i in range(n):
        t = i / RATE
        attack = min(1.0, t / 0.008)
        rel = 1.0 if t < dur - release else max(0.0, (dur - t) / release)
        v = 0.0
        for k, a, dk in harm:
            v += math.sin(2 * math.pi * f * k * t) * a * math.exp(-t * dk)
        out[i] = v * amp * attack * rel
    return out

def bass_note(freq, dur, amp=0.10):
    n = int(dur * RATE)
    out = [0.0] * n
    release = 0.06
    for i in range(n):
        t = i / RATE
        attack = min(1.0, t / 0.02)
        rel = 1.0 if t < dur - release else max(0.0, (dur - t) / release)
        v = math.sin(2 * math.pi * freq * t) * 0.9 + math.sin(2 * math.pi * freq * 2 * t) * 0.1
        out[i] = v * amp * attack * rel * math.exp(-t * 1.2)
    return out

def kick(amp=0.20):
    """kick：60Hz→45Hz 下滑 + 指数衰减。"""
    n = int(0.22 * RATE)
    out = [0.0] * n
    for i in range(n):
        t = i / RATE
        f = 60 - 15 * min(1.0, t / 0.12)
        rel = min(1.0, (0.22 - t) / 0.02)
        out[i] = math.sin(2 * math.pi * f * t) * amp * math.exp(-t / 0.06) * rel
    return out

def snare(amp=0.05):
    n = int(0.16 * RATE)
    out = [0.0] * n
    prev = 0.0
    for i in range(n):
        t = i / RATE
        x = random.uniform(-1, 1)
        # 一阶高通（去低频）+ 衰减
        y = 0.7 * x - 0.7 * prev
        prev = x
        rel = min(1.0, (0.16 - t) / 0.015)
        out[i] = y * amp * math.exp(-t / 0.045) * rel
    return out

def hat(amp=0.012):
    n = int(0.05 * RATE)
    out = [0.0] * n
    prev = 0.0
    for i in range(n):
        t = i / RATE
        x = random.uniform(-1, 1)
        y = x - prev  # 高通
        prev = x
        rel = min(1.0, (0.05 - t) / 0.008)
        out[i] = y * amp * math.exp(-t / 0.012) * rel
    return out

def mix(dst, src, offset):
    o = int(offset * RATE)
    for i, v in enumerate(src):
        if 0 <= o + i < len(dst):
            dst[o + i] += v

total = int(DUR * RATE)
buf = [0.0] * total

# ── 和弦：钢琴式，每和弦 2 拍，音符轻微错开（strum）+ 音高微扰 ──
t = 0.0
idx = 0
while t < DUR - 0.5:
    ch = CHORDS[idx % len(CHORDS)]
    strum = 0.0
    for f in ch:
        detune = random.uniform(-0.002, 0.002)  # ±0.2% 音高抖动
        amp = 0.06 if t < 8 else 0.05
        mix(buf, piano_note(f, min(2.0, BEAT * 2), amp=amp, detune=detune), t + strum)
        strum += 0.022
    # 根音（低八度，轻）
    mix(buf, piano_note(ch[0] / 2, BEAT * 2, amp=0.03, detune=0.0), t)
    t += BEAT * 2
    idx += 1

# ── 低音线（10s 后）──
t = 10.0
while t < DUR - 4:
    root = ROOTS[int(t / (BEAT * 2)) % len(ROOTS)]
    mix(buf, bass_note(root, BEAT * 1.6, amp=0.075), t)
    t += BEAT * 2

# ── 鼓点 ──
t = 0.0
while t < DUR - 0.5:
    beat = int(round(t / BEAT))
    build = 9.0 <= t < 22.0
    full = 22.0 <= t < 60.0
    outro = 60.0 <= t < 70.0
    if build or full or outro:
        mix(buf, kick(amp=0.30 if full else 0.24), t)
    if build or full:
        if beat % 4 in (1, 3):
            mix(buf, snare(amp=0.075 if full else 0.06), t)
    if full:
        for off in (0.0, 0.5):
            mix(buf, hat(amp=0.02), t + off * BEAT)
    elif build:
        mix(buf, hat(amp=0.014), t)
    t += BEAT

# ── 全局一阶低通（削高频毛刺，更温暖）──
alpha = 0.35
prev = 0.0
for i in range(len(buf)):
    prev = prev + alpha * (buf[i] - prev)
    buf[i] = prev

# ── 音量 + 淡入淡出 ──
fade = int(1.2 * RATE)
peak = 0.0
for i in range(len(buf)):
    v = buf[i]
    if i < fade:
        v *= i / fade
    if i > len(buf) - fade:
        v *= (len(buf) - i) / fade
    buf[i] = v
    peak = max(peak, abs(v))
scale = 0.5 / peak if peak > 0 else 1.0
for i in range(len(buf)):
    buf[i] = max(-1.0, min(1.0, buf[i] * scale))

with wave.open(OUT, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b"".join(struct.pack("<h", int(v * 32767)) for v in buf))
print("BGM v4:", OUT, round(os.path.getsize(OUT) / 1024), "KB")
