# analyze_subs.py — 从一批帧里自动找出「字幕带」的纵向范围
#
# 原理：字幕是硬字幕，位置固定、每帧都在；画面内容在动，细节位置不稳定。
#   ① 每帧只看底部 45% 区域，按行算水平梯度（文字=高频边缘）
#   ② 跨帧取 30 分位 —— 字幕行每帧都强，低分位也高；偶发的画面细节被压掉
#   ③ 平滑后找连续的高峰段 = 字幕带
#
# 用法: python analyze_subs.py <帧目录> <输出json>
import sys, os, json, glob
import numpy as np
from PIL import Image


def analyze(frames_dir):
    files = sorted(glob.glob(os.path.join(frames_dir, '*.jpg')))
    if not files:
        return {"ok": False, "reason": "没有帧"}

    profiles, H = [], None
    for f in files:
        g = np.asarray(Image.open(f).convert('L'), dtype=np.float32)
        if H is None:
            H = g.shape[0]
        y0 = int(H * 0.55)                  # 只看底部 45%
        band = g[y0:, :]
        dx = np.abs(np.diff(band, axis=1)).mean(axis=1)   # 每行水平梯度
        profiles.append(dx)

    L = min(len(p) for p in profiles)
    P = np.stack([p[:L] for p in profiles])              # (n, L)
    stable = np.percentile(P, 30, axis=0)                # 跨帧低分位

    k = 3
    smooth = np.convolve(stable, np.ones(k) / k, mode='same') if L > k else stable

    # 字幕几乎总在画面底部，先限定搜索区（底部 40%）
    search_lo = max(0, int(len(smooth) * 0.25))
    region = smooth[search_lo:]
    if len(region) == 0:
        region, search_lo = smooth, 0

    # 找峰值，而不是套绝对阈值 —— 字幕是局部尖峰，画面平台容易抢先命中
    base = float(np.percentile(region, 20))              # 基线
    peak_local = int(region.argmax())
    peak_val = float(region[peak_local])
    thr = base + (peak_val - base) * 0.4                 # 峰高的 40% 作为边界
    peak_idx = search_lo + peak_local

    # 从峰向两侧扩展到强度掉到阈值以下（允许 25 行间隙：中文行和日文行之间通常隔 20~30px）
    gap_allow = 25
    s = e = peak_idx
    gap = 0
    i = peak_idx - 1
    while i >= 0:
        if smooth[i] > thr:
            s, gap = i, 0
        elif gap >= gap_allow:
            break
        else:
            gap += 1
        i -= 1
    gap = 0
    i = peak_idx + 1
    while i < len(smooth):
        if smooth[i] > thr:
            e, gap = i, 0
        elif gap >= gap_allow:
            break
        else:
            gap += 1
        i += 1
    e += 1

    # 高度上限：字幕带不该超过搜索区的 1/4。
    # 竖屏 1080x1920 实测踩过：阈值扩展会一路把画面中部整片内容连进来（检测出 531px，
    # 而字幕只有 ~60px），拼出来 14 行里 11 行是画面。超限时收敛到峰值附近。
    max_h = max(4, len(smooth) // 4)
    if e - s > max_h:
        half = max_h // 2
        s = max(0, peak_idx - half)
        e = min(len(smooth), s + max_h)

    if e - s < 2:                                        # 兜底：最底部 20%
        s, e = max(0, L - int(L * 0.44)), L

    # 置信度：这个区间里「每帧都明显比画面自身更强」的帧占多少。
    # 抖音式动态字幕（位置漂移、不是每帧都有）会得到低分，调用方据此决定要不要用字幕带。
    # 用 75 分位而不是 mean —— 字幕只占带内几十像素，mean 会被画面内容稀释（实测得 0.00）
    if e > s:
        per_frame_peak = np.percentile(P[:, s:e], 75, axis=1)
        per_frame_base = np.percentile(P, 50, axis=1)
        confidence = float((per_frame_peak > per_frame_base * 1.5).mean())
    else:
        confidence = 0.0

    pad = 3                                              # 上下留点余量，别切到笔画
    s = max(0, s - pad)
    e = min(L, e + pad)

    top, bot = y0 + s, y0 + e
    return {
        "ok": True,
        "videoH": int(H),
        "frames": len(files),
        "region": {"top": int(top), "bottom": int(bot)},
        "topRatio": round(top / H, 4),
        "botRatio": round(bot / H, 4),
        "bandRatio": round((bot - top) / H, 4),
        "confidence": round(confidence, 3),   # 这个区间里有多少帧真有东西（<0.5 说明字幕不规律）
        "threshold": round(thr, 2),
        "profile": [round(float(x), 2) for x in smooth],   # 调试用
    }


if __name__ == '__main__':
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(src, 'subs-analysis.json')
    result = analyze(src)
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    if result.get('ok'):
        print(f"字幕带: top={result['topRatio']:.2f} bot={result['botRatio']:.2f} "
              f"高度={result['bandRatio']:.2f} 置信度={result['confidence']:.2f} "
              f"(像素 {result['region']['top']}-{result['region']['bottom']} / {result['videoH']})")
    else:
        print("检测失败:", result.get('reason'))
