// 弹幕分析：广告段检测 / 热区摘要（过滤规则在 danmaku-filter.mjs）
import { fmt } from './util.mjs'


export const AD_SEGMENT_SIGNAL = /金主|恰饭|商单|硬广|软广|赞助|推广|接广|带货|下单|同款|优惠码/i;

export function detectAdSegments(danmaku, duration, bucketSec = 30, stepSec = 10) {
  if (!danmaku?.length || duration < 120) return []
  // 弹幕太稀疏（如艺术短片 127 条 / 856s ≈ 0.15 条/s）时密度统计不可靠：
  // 中位数本身极低，「低于中位数 45%」的段落只会是「观众不爱发弹幕的正常段落」。
  // 低于 0.2 条/秒直接不判广告（宁漏勿错，低互动段标签也会误导）。
  if (danmaku.length / duration < 0.2) return []
  const dens = []
  for (let s = 0; s + bucketSec <= duration; s += stepSec) {
    let n = 0
    for (const d of danmaku) if (d.t >= s && d.t < s + bucketSec) n++
    dens.push({ s, n })
  }
  if (!dens.length) return []
  const nums = dens.map((d) => d.n).sort((a, b) => a - b)
  const median = nums[Math.floor(nums.length / 2)] || 1
  // 低密度：低于中位数的 45%
  const spans = []
  for (const d of dens) {
    if (d.n >= median * 0.45) continue
    const last = spans[spans.length - 1]
    if (last && d.s - last.to <= stepSec * 2) last.to = d.s + bucketSec
    else spans.push({ from: d.s, to: d.s + bucketSec, count: 0 })
  }
  const long = spans.filter((x) => x.to - x.from >= 60)
  if (!long.length) return []

  const hits = danmaku.filter((d) => AD_SEGMENT_SIGNAL.test(d.text))
  return long.map((sp) => {
    const near = hits.filter((h) => h.t >= sp.from - 20 && h.t <= sp.to + 20)
    // dens 是「30s 窗、10s 步长」的滑窗，同一条弹幕会被相邻 3 个桶各计一次。
    // 分母必须用「实际桶数」而不是 (时长/bucketSec)，否则 ratio 虚高约 3 倍
    // （出现 lowDensity = -25% 的负值，因为 ratio > 1）
    const segBuckets = dens.filter((d) => d.s >= sp.from && d.s < sp.to)
    const total = segBuckets.reduce((s, d) => s + d.n, 0)
    const ratio = total / Math.max(1, segBuckets.length) / median
    return {
      from: sp.from,
      to: sp.to,
      dur: sp.to - sp.from,
      ts: `${fmt(sp.from)}-${fmt(sp.to)}`,
      lowDensity: Number((1 - ratio).toFixed(2)),
      confidence: near.length ? 'high' : 'low',
      keywords: near.slice(0, 3).map((h) => h.text),
    }
  })
}

// 按时间桶聚合，找「观众最激动」的时段。
// 高频重复的弹幕最能代表那里在刷什么（梗 / 共鸣），所以每个热区取前 3 条并标出现次数。

export function summarizeDanmaku(list, bucketSec = 5, topN = 6) {
  if (!list?.length) return null
  const buckets = new Map()
  for (const d of list) {
    const k = Math.floor(d.t / bucketSec) * bucketSec
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(d.text)
  }
  return [...buckets.entries()]
    .map(([start, texts]) => ({ start, texts }))
    .sort((a, b) => b.texts.length - a.texts.length)   // 先按密度挑出最热的 N 个桶
    .slice(0, topN)
    .sort((a, b) => a.start - b.start)                  // 再按时间顺序展示
    .map(({ start, texts }) => {
      const freq = new Map()
      for (const t of texts) freq.set(t, (freq.get(t) ?? 0) + 1)
      const samples = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, n]) => (n > 1 ? `${t}×${n}` : t))
      return { start, end: start + bucketSec, ts: fmt(start), count: texts.length, samples }
    })
}
