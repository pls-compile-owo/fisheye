// lib/band.mjs — 烧录字幕带定位（纯 JS，零 python）
//
// 复刻 analyze_subs.py 的算法：ffmpeg 把帧输出成 P5 灰度 PGM（自带宽高头），
// JS 读字节算每行水平梯度 → 跨帧取低分位 → 平滑 → 找峰值 → 向两侧扩展得到字幕带。
//
// 为什么能去掉 python：
//   - Pillow 的图解码 → 换成 ffmpeg 的 raw 灰度输出（P5 格式，头部 "P5\nW H\n255\n" 后就是像素字节）
//   - numpy 的 diff/percentile/convolve/argmax → 几十行纯数值运算
//
// 沙箱约束（同 audio/ocr/ytdlp）：子进程不能捕获 stdout 管道，抽帧写临时文件再读。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { FFMPEG, OUT } from './env.mjs'

// --- 数值工具（对齐 numpy 语义） ---

// numpy.percentile 默认 'linear' 插值：idx=(n-1)*q/100，取 lo/hi 线性插值
export function percentile(arr, q) {
  const a = [...arr].sort((x, y) => x - y)
  const n = a.length
  if (n === 0) return 0
  if (n === 1) return a[0]
  const idx = ((n - 1) * q) / 100
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return a[lo]
  return a[lo] + (a[hi] - a[lo]) * (idx - lo)
}

// np.convolve(x, ones(3)/3, 'same')：3 点滑动平均，边界用「少一点但仍除以 3」
export function smooth3(x) {
  const L = x.length
  if (L <= 3) return x.slice()
  const y = new Float64Array(L)
  y[0] = (x[0] + x[1]) / 3
  for (let i = 1; i < L - 1; i++) y[i] = (x[i - 1] + x[i] + x[i + 1]) / 3
  y[L - 1] = (x[L - 2] + x[L - 1]) / 3
  return y
}

const pyRound = (x, d) => Math.round(x * 10 ** d) / 10 ** d

// --- 灰度帧读取 ---

// 解析 P5 灰度 PGM：返回 { w, h, gray: Uint8Array }，失败返回 null
export function readPgm(buf) {
  const isSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
  let i = 0
  const tokens = []
  while (tokens.length < 4) {
    while (i < buf.length && isSpace(buf[i])) i++
    if (i >= buf.length) return null
    if (buf[i] === 0x23) { // '#'
      while (i < buf.length && buf[i] !== 0x0a) i++
      continue
    }
    const start = i
    while (i < buf.length && !isSpace(buf[i]) && buf[i] !== 0x23) i++
    tokens.push(buf.toString('latin1', start, i))
  }
  if (tokens[0] !== 'P5') return null
  const w = parseInt(tokens[1], 10)
  const h = parseInt(tokens[2], 10)
  const maxval = parseInt(tokens[3], 10)
  if (!w || !h || maxval !== 255) return null // 只支持 8bit 灰度
  while (i < buf.length && isSpace(buf[i])) i++ // 跳过 maxval 后的分隔符
  const gray = buf.subarray(i, i + w * h)
  if (gray.length < w * h) return null
  return { w, h, gray }
}

// 抽一帧灰度 PGM 到文件；失败返回 false（t 越界 / 解码失败都可能发生）
export function grabFrameGray(mp4, t, outFile) {
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', mp4,
      '-an', '-frames:v', '1', '-pix_fmt', 'gray', outFile], { stdio: 'ignore' })
    return fs.existsSync(outFile)
  } catch {
    return false
  }
}

// 一帧的每行水平梯度均值（对应 np.abs(np.diff(band, axis=1)).mean(axis=1)）
// 只算 y0 行到底部（字幕只在画面下半部）；返回长度 h-y0 的数组
export function rowGradientProfile(gray, w, h, y0) {
  const prof = new Float64Array(h - y0)
  for (let y = y0; y < h; y++) {
    const base = y * w
    let sum = 0
    for (let x = 0; x < w - 1; x++) sum += Math.abs(gray[base + x + 1] - gray[base + x])
    prof[y - y0] = sum / (w - 1)
  }
  return prof
}

// --- 字幕带分析（复刻 analyze_subs.py 的 analyze() 后半段，纯函数可单测） ---
// profiles: 每帧一个行梯度数组（都从 y0 行开始）；H: 帧高
export function analyzeProfiles(profiles, H) {
  if (!profiles.length) return { ok: false, reason: '没有帧' }
  const y0 = Math.floor(H * 0.55)
  const L = Math.min(...profiles.map((p) => p.length))
  if (L <= 0) return { ok: false, reason: '帧高度异常' }
  const P = profiles.map((p) => p.slice(0, L)) // (n, L)

  // stable = np.percentile(P, 30, axis=0)：每行的跨帧低分位
  const stable = new Float64Array(L)
  for (let row = 0; row < L; row++) {
    const col = new Array(P.length)
    for (let f = 0; f < P.length; f++) col[f] = P[f][row]
    stable[row] = percentile(col, 30)
  }

  const smooth = smooth3(stable)

  // 字幕几乎总在画面底部，先限定搜索区（底部 40%）
  let searchLo = Math.max(0, Math.floor(smooth.length * 0.25))
  let region = smooth.slice(searchLo)
  if (region.length === 0) {
    region = smooth
    searchLo = 0
  }

  // 找峰值（局部尖峰），不套绝对阈值
  const base = percentile(region, 20)
  let peakLocal = 0
  for (let i = 1; i < region.length; i++) if (region[i] > region[peakLocal]) peakLocal = i
  const peakVal = region[peakLocal]
  const thr = base + (peakVal - base) * 0.4
  const peakIdx = searchLo + peakLocal

  // 从峰向两侧扩展（允许 25 行间隙：中文/日文行之间通常隔 20~30px）
  const gapAllow = 25
  let s = peakIdx
  let e = peakIdx
  let gap = 0
  for (let i = peakIdx - 1; i >= 0; i--) {
    if (smooth[i] > thr) { s = i; gap = 0 } else if (gap >= gapAllow) break
    else gap++
  }
  gap = 0
  for (let i = peakIdx + 1; i < smooth.length; i++) {
    if (smooth[i] > thr) { e = i; gap = 0 } else if (gap >= gapAllow) break
    else gap++
  }
  e += 1

  // 高度上限：字幕带不该超过搜索区的 1/4（竖屏踩过：把画面中部整片连进来）
  const maxH = Math.max(4, Math.floor(smooth.length / 4))
  if (e - s > maxH) {
    const half = Math.floor(maxH / 2)
    s = Math.max(0, peakIdx - half)
    e = Math.min(smooth.length, s + maxH)
  }
  if (e - s < 2) { // 兜底：最底部 20%
    s = Math.max(0, L - Math.floor(L * 0.44))
    e = L
  }

  // 置信度：区间里「每帧都明显比画面自身更强」的帧占比（75 分位 vs 50 分位）
  let confidence = 0.0
  if (e > s) {
    const peaks = P.map((frame) => percentile(frame.slice(s, e), 75))
    const bases = P.map((frame) => percentile(frame, 50))
    let cnt = 0
    for (let f = 0; f < P.length; f++) if (peaks[f] > bases[f] * 1.5) cnt++
    confidence = cnt / P.length
  }

  const pad = 3 // 上下留余量，别切到笔画
  s = Math.max(0, s - pad)
  e = Math.min(L, e + pad)

  const top = y0 + s
  const bot = y0 + e
  return {
    ok: true,
    videoH: H,
    frames: profiles.length,
    region: { top, bottom: bot },
    topRatio: pyRound(top / H, 4),
    botRatio: pyRound(bot / H, 4),
    bandRatio: pyRound((bot - top) / H, 4),
    confidence: pyRound(confidence, 3),
    threshold: pyRound(thr, 2),
    profile: Array.from(smooth, (x) => pyRound(x, 2)), // 调试用
  }
}

// --- 完整流程：抽 24 帧灰度 → 分析字幕带 ---
export function detectBand(mp4, duration) {
  const probe = path.join(OUT, `.probe-${Date.now()}`)
  try {
    fs.mkdirSync(probe, { recursive: true })
    // 逐帧快速 seek 抽 24 帧（fps 滤镜虽只输出 24 帧但必须全片解码，长视频慢一个数量级）
    // 必须跨全片采样：字幕位置是视频级属性，只看区间时峰值会被画面边缘抢走
    const profiles = []
    let H = null
    let W = null
    for (let i = 0; i < 24; i++) {
      const t = ((i + 0.5) * Math.max(duration, 1)) / 24
      const f = path.join(probe, `f${String(i).padStart(2, '0')}.pgm`)
      if (!grabFrameGray(mp4, t, f)) continue
      const frame = readPgm(fs.readFileSync(f))
      fs.rmSync(f, { force: true }) // 立即删，省磁盘
      if (!frame) continue
      if (H === null) { H = frame.h; W = frame.w }
      profiles.push(rowGradientProfile(frame.gray, W, H, Math.floor(H * 0.55)))
    }
    if (!profiles.length) return { ok: false, reason: '没有帧' }
    const r = analyzeProfiles(profiles, H)
    return r.ok ? r : null
  } catch (e) {
    // 抽帧失败 / 分析报错 —— 一律降级为「没有字幕」，不能让整个流程崩掉
    console.warn(`[字幕] 检测失败（将按无字幕处理）：${String(e.message).split('\n')[0].slice(0, 80)}`)
    return null
  } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }) } catch {}
  }
}
