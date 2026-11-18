// 抽帧与时间点选择：场景检测 / 广告剔除 / 取帧计划 / 字幕带定位 / 单帧截取 / 子进程封装
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { FFMPEG, WS, OUT } from './env.mjs'

// 字幕带定位已纯 JS 化（零 python），实现在 lib/band.mjs；这里 re-export 保持调用方不变
export { detectBand } from './band.mjs'

export function detectScenes(file) {
  // 文件名带 pid + 时间戳：两个视频并发跑时不会互相覆盖
  const name = `.scenes-${process.pid}-${Date.now()}.txt`
  const abs = path.join(OUT, name)
  try {
    // OUT 可能还没创建（第一次运行 / 刚清理过）：先幂等创建，否则 ffmpeg 的 cwd 不存在会静默返回 []
    fs.mkdirSync(OUT, { recursive: true })
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true })
    execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-vf',
      `scale=320:-2,select='gt(scene,0.05)',metadata=print:file=${name}`, '-an', '-f', 'null', '-'],
      { stdio: 'ignore', cwd: OUT })
    if (!fs.existsSync(abs)) return []
    const out = fs.readFileSync(abs, 'utf8')
    fs.rmSync(abs, { force: true })
    // 输出是两行一组： "…pts_time:4.1" 紧跟 "lavfi.scene_score=0.42"
    const ents = []
    let cur = null
    for (const line of out.split('\n')) {
      const t = line.match(/pts_time:\s*([0-9.]+)/)
      if (t) { cur = { t: Number(t[1]), score: 0 }; continue }
      const s = line.match(/scene_score=([0-9.]+)/)
      if (s && cur) { cur.score = Number(s[1]); ents.push(cur); cur = null }
    }
    return ents.filter((e) => e.t > 0.2)
  } catch { return [] }
}

// 段内取帧：等间隔骨架 + 吸附变化点（阈值阶梯 + 去重）
// 基准点 ((i+0.5)*dur/n) 让每格的吸附窗口 [base±dur/2n] 恰好铺满整段、且不越界。
// 从 [from,to] 里减掉广告段，返回剩余连续区间（用于「广告不占帧」）

export function subtractAds(from, to, adSegs) {
  let segs = [{ a: from, b: to }]
  for (const ad of adSegs) {
    const next = []
    for (const s of segs) {
      if (ad.to <= s.a || ad.from >= s.b) { next.push(s); continue }
      if (ad.from > s.a) next.push({ a: s.a, b: ad.from })
      if (ad.to < s.b) next.push({ a: ad.to, b: s.b })
    }
    segs = next
  }
  return segs.filter((s) => s.b - s.a > 0.5)
}

export function pickTimes(from, to, n, scenes, adSegs = []) {
  const dur = to - from
  const inAd = (t) => adSegs.some((ad) => t >= ad.from && t <= ad.to)

  // 广告段时间从时间轴上「压缩掉」：在剩余有效时间里等间隔取基准点。
  // 效果 = 帧数不变、广告不占帧、多出来的时长自动分给内容（密度提升）。
  const segs = adSegs.length ? subtractAds(from, to, adSegs) : [{ a: from, b: to }]
  if (!segs.length) return null                      // 整段都是广告 → 调用方跳过这张图
  const totalEff = segs.reduce((s, x) => s + (x.b - x.a), 0)
  const base = []
  for (let i = 0; i < n; i++) {
    let rem = ((i + 0.5) / n) * totalEff
    let t = segs[segs.length - 1].b
    for (const s of segs) {
      const d = s.b - s.a
      if (rem <= d) { t = s.a + rem; break }
      rem -= d
    }
    base.push(t)
  }

  // 吸附窗口/去重下限按「有效时长」算，而不是原始段长。
  // 段里有广告时，内容被压缩得更密，用原始 dur 会让窗口过大 → 多帧吸到同一点后被去重退回
  // （40 分钟视频图2：跳过 118s 广告后 9 帧里有 5 帧被退回）
  const timingBase = totalEff > 0 ? totalEff : dur
  const half = timingBase / n / 2
  const minGap = (timingBase / n) * 0.4 // 去重下限：相邻两帧至少隔这么多

  const tryThreshold = (th) => {
    // 吸附候选也排除广告段：不然帧会被吸到广告里的高变化点（片头/转场）
    const cands = scenes.filter((s) => s.score >= th && !inAd(s.t))
    const raw = base.map((b) => {
      const near = cands.filter((s) => Math.abs(s.t - b) <= half)
      if (!near.length) return b
      // 窗口内可能挤着多个变化点：取「最剧烈」的而不是「最近」的——
      // 时间代表性靠窗口保证（都在 ±half 内），视觉显著性决定落在哪一刻
      return near.reduce((x, s) => (s.score > x.score ? s : x)).t
    })
    // snapped 统计的是「吸附能力」，必须在去重前算 —— 否则被去重退回的帧会被误记成「没吸到」
    const snapped = raw.filter((t, i) => Math.abs(t - base[i]) > 1e-6).length

    // 去重：吸附后若相邻两帧挤得比 minGap 还近，把后一个退回它自己的等间隔基准点
    // （基准点之间间距 = dur/n，永远不会违反 minGap，所以退回一定安全）
    const times = raw.slice()
    for (let i = 1; i < times.length; i++) {
      if (Math.abs(times[i] - times[i - 1]) < minGap) times[i] = base[i]
    }
    let dedup = 0
    for (let i = 1; i < times.length; i++) {
      if (Math.abs(raw[i] - times[i]) > 1e-6) dedup++
    }
    return { times, th, snapped, dedup, base }
  }

  // 阈值阶梯：从严格到宽松，取第一个「≥75% 帧都吸附成功」的档位
  // （段变短后吸附窗口 half 会变小，过半门槛太松，容易留下大量没吸到的帧）
  let fallback = null
  for (const th of [0.3, 0.15, 0.08]) {
    const r = tryThreshold(th)
    if (!fallback) fallback = r
    if (r.snapped >= Math.ceil(n * 0.75)) return r
  }
  return fallback
}

// 字幕行取帧：等间隔骨架 + 吸附变化点（字幕通常在镜头切换时更新，纯等间隔会取到
// 「还没出字幕」的过渡帧——第一条字幕带的行 1 经常是空的）

export function snapSubsTimes(span, count, scenes, start = 0) {
  const base = Array.from({ length: count }, (_, i) => start + ((i + 0.5) * span) / count)
  const cands = scenes.filter((s) => s.score >= 0.15 && s.t >= start && s.t <= start + span)
  if (!cands.length) return base
  const half = span / count / 2
  const minGap = (span / count) * 0.4
  const times = base.map((b) => {
    const near = cands.filter((s) => Math.abs(s.t - b) <= half)
    if (!near.length) return b
    return near.reduce((x, s) => (s.score > x.score ? s : x)).t
  })
  for (let i = 1; i < times.length; i++) {
    if (Math.abs(times[i] - times[i - 1]) < minGap) times[i] = base[i]
  }
  return times
}

// 弹幕：独立于画面和字幕的第三个信息源
// 为什么值得拉：弹幕密集的时段 = 观众真正觉得精彩的地方，可以直接指导精读选点；
// 而且它能看到画面和字幕里都没有的东西——大家在哪一秒笑、在刷什么梗。
// 数据源：https://comment.bilibili.com/<cid>.xml
// 每条 <d p="相对秒,模式,字号,颜色,...,>内容</d>，只取第一段（相对时间）和文本

// 抽一帧；失败返回 false 而不是抛异常（t 越界、解码失败都可能发生）

export function grabFrame(mp4, t, outFile, quality = 3) {
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', mp4,
      '-an', '-frames:v', '1', '-q:v', String(quality), outFile], { stdio: 'ignore' })
    return fs.existsSync(outFile)
  } catch {
    return false
  }
}

export function runCapture(cmd, args, timeoutMs = 15000) {
  const tmp = path.join(WS, `.selftest-${process.pid}-${crypto.randomUUID().slice(0, 8)}.txt`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    // 沙箱禁管道捕获 stdout，所以写到文件再读（和 detectScenes 同样的做法）
    execFileSync(cmd, args, { stdio: ['ignore', fd, 'ignore'], timeout: timeoutMs })
    return { ok: true, out: fs.readFileSync(tmp, 'utf8') }
  } catch (e) {
    return { ok: false, out: '', err: String(e?.message ?? e).split('\n')[0] }
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(tmp) } catch {}
  }
}
