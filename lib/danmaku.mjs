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
  const hits = danmaku.filter((d) => AD_SEGMENT_SIGNAL.test(d.text))
  // 关键词聚类（补充信号）：广告口播段观众常刷「金主/恰饭/商单」等，且此时弹幕密度
  // 未必低谷（观众在吐槽广告）——只看密度会漏掉 40-60s 的短广告。
  const hitTimes = hits.map((h) => h.t).sort((a, b) => a - b)
  const kwSpans = []
  for (const tt of hitTimes) {
    const last = kwSpans[kwSpans.length - 1]
    if (last && tt - last.to <= 60) last.to = tt
    else kwSpans.push({ from: tt, to: tt })
  }
  const kwCandidates = kwSpans.filter(
    (s) => s.to - s.from >= 10 && hitTimes.filter((x) => x >= s.from && x <= s.to).length >= 2)

  // 低置信度段的最小长度：45s（覆盖 40-60s 的短广告；更短的段不判，宁漏勿错）
  const long = spans.filter((x) => x.to - x.from >= 45)
  if (!long.length && !kwCandidates.length) return []

  // 合并候选：密度低谷段 ∪ 关键词聚类段（重叠或相近的并成一段）
  const candidates = []
  for (const sp of [...long, ...kwCandidates]) {
    const last = candidates.find((c) => sp.from <= c.to + 30 && sp.to >= c.from - 30)
    if (last) {
      last.from = Math.min(last.from, sp.from)
      last.to = Math.max(last.to, sp.to)
    } else candidates.push({ from: sp.from, to: sp.to })
  }
  // 片头广告：视频开头 90s 内出现「接广/金主/恰饭」等强信号弹幕（哪怕只有 1 条），
  // 视为片头口播广告候选（0 到信号时间+20s）。片头广告常无密度低谷（观众刚到还在刷弹幕）。
  const STRONG_AD = /金主|恰饭|商单|接广|硬广|软广|赞助/i
  const headStrong = danmaku.filter((d) => d.t < 90 && STRONG_AD.test(d.text))
  if (headStrong.length) {
    // 片头广告通常覆盖整个片头（30-60s 口播），固定 0-60s 段
    const headEnd = 60
    if (headEnd > 0) candidates.push({ from: 0, to: headEnd, headAd: true })
  }

  const out = candidates.map((sp) => {
    const near = hits.filter((h) => h.t >= sp.from - 20 && h.t <= sp.to + 20)
    // dens 是「30s 窗、10s 步长」的滑窗，同一条弹幕会被相邻 3 个桶各计一次。
    // 分母必须用「实际桶数」而不是 (时长/bucketSec)，否则 ratio 虚高约 3 倍
    // （出现 lowDensity = -25% 的负值，因为 ratio > 1）
    const segBuckets = dens.filter((d) => d.s >= sp.from && d.s < sp.to)
    const total = segBuckets.reduce((s, d) => s + d.n, 0)
    const ratio = segBuckets.length ? total / segBuckets.length / median : 0
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
  // 片头/片尾 60s 内的「低置信度」段丢弃：开头结尾弹幕本来就少，不是广告信号。
  // 高置信度（有广告关键词）不受此限——片头口播广告仍是广告。
  // 低置信度段截断到 [60s, duration-60s] 再判定：密度低谷可能延伸进片头/片尾的正常低弹幕区，
  // 整段丢弃会连带丢掉中间的真实广告（首次真值样本 BV1qdb16eEF5 暴露）。
  const clamped = out.map((s) => {
    if (s.confidence === 'high') return s
    // 向两侧各扩 15s：广告口播开始前观众还没反应，低密度段会比真实广告短
    const from = Math.max(s.from - 15, 60)
    const to = Math.min(s.to + 15, duration - 60)
    return { ...s, from, to, dur: to - from, ts: `${fmt(from)}-${fmt(to)}` }
  })
  return clamped.filter((s) => s.confidence === 'high' || s.dur >= 45)
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
