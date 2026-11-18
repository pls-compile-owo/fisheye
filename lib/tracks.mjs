// lib/tracks.mjs — 画面三轨（2.0 设计 01-证据体系 §3.4）
//
//   coarse    ：4 分钟/帧（1~2 张/40 分钟），3x3，等间隔，不吸附不降权 —— 兜底筛查，永远可用
//   algorithm ：等间隔 + 单档吸附（score≥0.3）+ 低活跃降权（w=0.3）—— 默认渲染档，有字幕/弹幕
//   adaptive  ：按视频类型定制密度 —— 无文本证据的视频，两源低置信 + 授权后
//
// 0.2 验证结论：吸附三档阶梯（0.3/0.15/0.08）93% 段不降档、7% 降档信息量差异不明显 → 砍成单档 0.3。
// w=0.3 只在 render 的 algorithm 轨生效（低活跃段采样密度 ×0.3），纯文本链路不用 w。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { FFMPEG, OUT } from './env.mjs'
import { grabFrame } from './frame.mjs'
import { TYPE_TRACKS } from './video-type.mjs'

// ── 三轨参数 ─────────────────────────────────────────────────────────
export const TRACK_PARAMS = {
  coarse: { gapSec: 240, snap: false, weight: null, grid: '3x3' },
  algorithm: { gapSec: null, snap: 0.3, weight: 0.3, grid: '3x3' },
  adaptive: { gapSec: null, snap: false, weight: null, grid: '3x3' },
}

export const LOW_ACTIVITY_WEIGHT = 0.3 // FISHEYE_LOW_ACTIVITY_WEIGHT 默认（设计 05 §7.3）

// ── 低活跃降权：把 [from,to] 按低活跃段切成加权子段（内容 w=1，低活跃 w=0.3）──
export function weightSegments(from, to, lowSegs, w = LOW_ACTIVITY_WEIGHT) {
  let segs = [{ a: from, b: to, w: 1 }]
  for (const low of (Array.isArray(lowSegs) ? lowSegs : [])) {
    const next = []
    for (const s of segs) {
      if (low.to <= s.a || low.from >= s.b) { next.push(s); continue }
      if (low.from > s.a) next.push({ a: s.a, b: low.from, w: s.w })
      next.push({ a: Math.max(low.from, s.a), b: Math.min(low.to, s.b), w: s.w * w })
      if (low.to < s.b) next.push({ a: low.to, b: s.b, w: s.w })
    }
    segs = next
  }
  return segs.filter((s) => s.b - s.a > 0.5)
}

// ── 单档吸附 + 低活跃降权（复刻 frame.mjs pickTimes 但固定 th=0.3、降权而非跳过）──
export function pickTimesSingle(from, to, n, scenes, lowSegs = [], th = 0.3, w = LOW_ACTIVITY_WEIGHT) {
  const segs = (Array.isArray(lowSegs) && lowSegs.length) ? weightSegments(from, to, lowSegs, w) : [{ a: from, b: to, w: 1 }]
  const totalEff = segs.reduce((s, x) => s + (x.b - x.a) * x.w, 0)
  if (totalEff <= 0) return { times: [], base: [], snapped: 0, dedup: 0 }

  // 基准点按加权时长分配（低活跃段权重低 → 分到的帧少）
  const base = []
  for (let i = 0; i < n; i++) {
    let rem = ((i + 0.5) / n) * totalEff
    let t = segs[segs.length - 1].b
    for (const s of segs) {
      const d = (s.b - s.a) * s.w
      if (rem <= d) { t = s.a + rem / s.w; break }
      rem -= d
    }
    base.push(t)
  }

  const half = totalEff / n / 2
  const minGap = (totalEff / n) * 0.4
  const cands = (Array.isArray(scenes) ? scenes : []).filter((s) => s.score >= th)
  const raw = base.map((b) => {
    const near = cands.filter((s) => Math.abs(s.t - b) <= half)
    if (!near.length) return b
    return near.reduce((x, s) => (s.score > x.score ? s : x)).t
  })
  const snapped = raw.filter((t, i) => Math.abs(t - base[i]) > 1e-6).length
  const times = raw.slice()
  for (let i = 1; i < times.length; i++) {
    if (Math.abs(times[i] - times[i - 1]) < minGap) times[i] = base[i]
  }
  let dedup = 0
  for (let i = 1; i < times.length; i++) {
    if (Math.abs(raw[i] - times[i]) > 1e-6) dedup++
  }
  return { times, base, snapped, dedup }
}

// ── 三轨帧时间计算 ───────────────────────────────────────────────────
/**
 * @param {'coarse'|'algorithm'|'adaptive'} track
 * @param {object} opts { from, to, n, scenes, lowSegs, type }
 * @returns {Array<number>} 帧时间（秒）
 */
export function trackFrameTimes(track, opts = {}) {
  const { from = 0, to = 0, n = 9, scenes = [], lowSegs = [], type = 'unknown' } = opts
  if (track === 'coarse') {
    // 4 分钟/帧，等间隔，不吸附不降权
    const gap = TRACK_PARAMS.coarse.gapSec
    const times = []
    for (let t = from + gap / 2; t < to; t += gap) times.push(t)
    return times
  }
  if (track === 'algorithm') {
    return pickTimesSingle(from, to, n, scenes, lowSegs, TRACK_PARAMS.algorithm.snap, TRACK_PARAMS.algorithm.weight).times
  }
  if (track === 'adaptive') {
    const gap = TYPE_TRACKS[type]?.gapSec ?? 240
    if (gap === null) {
      // slides：每页一张 → 用场景切页（取显著变化点，去重）
      const strong = scenes.filter((s) => s.score >= 0.3 && s.t >= from && s.t < to)
      const deduped = []
      for (const s of strong) {
        if (!deduped.length || s.t - deduped[deduped.length - 1] >= 5) deduped.push(s.t)
      }
      return deduped.length ? deduped : trackFrameTimes('coarse', opts)
    }
    const times = []
    for (let t = from + gap / 2; t < to; t += gap) times.push(t)
    return times
  }
  return []
}

// ── 渲染：抽帧 + 拼图 ────────────────────────────────────────────────
/**
 * 抽一轨帧并拼成一张图（复用 frame.mjs grabFrame + ffmpeg tile）。
 * @param {string} mp4 视频文件
 * @param {Array<number>} times 帧时间（秒）
 * @param {object} opts { grid='3x3', outName, quality=3, label? }
 * @returns {string|null} 拼图路径（不足 1 帧返回 null）
 */
export function renderTrack(mp4, times, opts = {}) {
  const grid = opts.grid ?? '3x3'
  const [cols, rows] = grid.split('x').map(Number)
  const N = cols * rows
  const list = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t))
  if (!list.length) return null

  const name = opts.outName ?? `track-${Date.now()}`
  const tmp = path.join(OUT, `.t-${name}`)
  fs.mkdirSync(tmp, { recursive: true })
  const files = []
  try {
    for (let i = 0; i < list.length; i++) {
      const f = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)
      if (!grabFrame(mp4, list[i], f, opts.quality ?? 3)) {
        if (files.length) fs.copyFileSync(files[files.length - 1], f)
        else continue // 第一帧失败 → 留空，后续拼图时按数量不足处理
      }
      files.push(f)
    }
    if (!files.length) return null

    const sheet = path.join(OUT, `${name}_${grid}.jpg`)
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, `f%02d.jpg`), '-vf',
      `scale=640:-1,tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '3', sheet], { stdio: 'ignore' })
    return sheet
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
