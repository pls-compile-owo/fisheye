// tools/verify-2.0-0.2-snap.mjs — 第 0 批验证 0.2：吸附单档(0.3) vs 三档(0.3/0.15/0.08)对比
// 8 条 golden 视频（从 low-activity 选，覆盖长短快慢）：
//   下载 → 场景检测 → 整片/分段取 9 帧，对比两种吸附策略的「最终阈值 / 吸附数 / 去重数 / 帧位差」。
// 不改产品代码：单档逻辑在此脚本内复刻 frame.mjs pickTimes 的 tryThreshold(0.3)。
import { ensureMp4 } from '../lib/bili.mjs'
import { detectScenes, pickTimes } from '../lib/frame.mjs'
import { probeDuration } from '../lib/platforms/_probe.mjs'

const BVS = [
  'BV1WhaA6hE7s', // 可汗 历史解说 2255s
  'BV1i4W86zEUS', // 可汗 历史解说 2385s
  'BV17WZ4YsEiX', // 电脑故障指南(疑似录屏) 3474s
  'BV1tnZqYTEx6', // 手机续航横评(评测) 1190s
  'BV1EhZhYKEuU', // 小米SU7事故(新闻) 239s
  'BV1mbZnYoEks', // 娱乐短剧 978s
  'BV1Cgpd6pEBR', // 神奇组织 解说 2620s
  'BV1AiZEY5Etd', // 虎门抽烟 短视频 132s
]

// 单档：复刻 pickTimes 的 tryThreshold，固定 th=0.3，不做阶梯降档
function singleThreshold(from, to, n, scenes, th = 0.3) {
  const totalEff = to - from
  const base = []
  for (let i = 0; i < n; i++) base.push(from + ((i + 0.5) / n) * totalEff)
  const half = totalEff / n / 2
  const minGap = (totalEff / n) * 0.4
  const cands = scenes.filter((s) => s.score >= th)
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
  return { times, th, snapped, dedup }
}

// 两条策略最终帧位差（秒）：max 偏差 + 平均偏差 + 不同位置的帧数
function diff(timesA, timesB) {
  let maxD = 0, sumD = 0, changed = 0
  for (let i = 0; i < timesA.length; i++) {
    const d = Math.abs(timesA[i] - timesB[i])
    sumD += d
    if (d > 0.5) changed++
    if (d > maxD) maxD = d
  }
  return { changed, maxD: +maxD.toFixed(1), avgD: +(sumD / timesA.length).toFixed(1) }
}

const N = 9
const SEG = 240 // 4 分钟/段

console.log('=== 0.2 吸附单档(0.3) vs 三档(0.3/0.15/0.08) ===\n')
const summary = []
for (const bv of BVS) {
  try {
    const mp4 = await ensureMp4(bv)
    const scenes = detectScenes(mp4)
    const dur = probeDuration(mp4) ?? (Math.max(...scenes.map((s) => s.t), 0) + 30)

    // 分段（4 分钟/段），每段对比
    let segs3 = 0, segsSnapSame = 0, totalChanged = 0, maxChanged = 0
    let allSameTh = 0, downgraded = 0
    for (let from = 0; from < dur; from += SEG) {
      const to = Math.min(from + SEG, dur)
      if (to - from < 30) continue
      const three = pickTimes(from, to, N, scenes, [])
      const one = singleThreshold(from, to, N, scenes, 0.3)
      segs3++
      if (three.th === 0.3) allSameTh++
      else downgraded++
      const d = diff(three.times, one.times)
      totalChanged += d.changed
      if (d.changed > maxChanged) maxChanged = d.changed
    }
    const sc = scenes.length
    const line = {
      bv, dur: Math.round(dur), scenes: sc,
      segs: segs3, sameTh0_3: allSameTh, downgraded,
      totalChanged, maxChanged,
      snapRate: segs3 ? '—' : '—',
    }
    console.log(`${bv}  ${dur}s  场景点 ${sc}  段 ${segs3}（th=0.3 的段 ${allSameTh}，降档段 ${downgraded}）  帧位变化 总计 ${totalChanged} / 单段最多 ${maxChanged}`)
    summary.push(line)
  } catch (e) {
    console.log(`${bv}  失败：${String(e.message).split('\n')[0].slice(0, 80)}`)
  }
}

console.log('\n=== 汇总 ===')
const totalSegs = summary.reduce((s, l) => s + l.segs, 0)
const sameTh = summary.reduce((s, l) => s + l.sameTh0_3, 0)
const down = summary.reduce((s, l) => s + l.downgraded, 0)
console.log(`总段数 ${totalSegs}，其中三档停在 0.3（=单档，无差别）${sameTh} 段，发生降档 ${down} 段`)
console.log(`降档段占比 ${(down / totalSegs * 100).toFixed(1)}%；降档后帧位变化最多 ${Math.max(...summary.map((s) => s.maxChanged), 0)} 帧`)
