// 弹幕分析：广告段检测 / 热区摘要（过滤规则在 danmaku-filter.mjs）
import { fmt } from './util.mjs'


export const AD_SEGMENT_SIGNAL = /金主|恰饭|商单|硬广|软广|赞助|推广|接广|带货|下单|同款|优惠码/i;

export function detectAdSegments(danmaku, duration, bucketSec = 30, stepSec = 10, subs = null) {
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

  // 数字打点（观众自发的广告结束时间标记）：广告开始时常见「1407工程启动」「1408工程」
  // —— 4 位数字是 MM:SS 格式的广告结束时间（1407 = 14:07）。只认带「工程/启动/广告/结束」
  // 上下文的数字，避免普通数字弹幕误报。
  const MARK_CTX = /工程|启动|打点|广告|结束时间|恰饭|广告时间|分\d{2}|侠|提醒/
  const markCandidates = []
  for (const d of danmaku) {
    if (!MARK_CTX.test(d.text)) continue
    // 支持 1407 / 450 / 4:50 / 4.55 / 4；50 等格式（3 位数字按 MM:SS 解析，如 450=4:50）
    const m = d.text.match(/(\d{1,2})[.．:：；;](\d{2})|(\d{3,4})|(\d{1,2})分(\d{2})/)
    if (!m) continue
    let T = null
    if (m[1] !== undefined) T = Number(m[1]) * 60 + Number(m[2])
    else if (m[4] !== undefined) T = Number(m[4]) * 60 + Number(m[5])
    else {
      const v = Number(m[3])
      const mm = Math.floor(v / 100)
      const ss = v % 100
      if (mm <= 59 && ss <= 59) T = mm * 60 + ss
    }
    if (T === null || T > duration) continue
    const dist = Math.abs(T - d.t)
    // 打点弹幕和广告结束点通常相距几分钟（广告开始→结束）
    if (dist < 30 || dist > 600) continue
    markCandidates.push({ from: Math.max(0, Math.min(d.t, T) - 15), to: Math.min(duration, Math.max(d.t, T) + 15) })
  }

  // 片头广告：视频开头 90s 内出现「接广/金主/恰饭」等强信号弹幕（哪怕只有 1 条），
  // 视为片头口播广告候选（0-60s）。片头广告常无密度低谷（观众刚到还在刷弹幕）。
  const STRONG_AD = /金主|恰饭|商单|接广|硬广|软广|赞助/i
  const headStrong = danmaku.filter((d) => d.t < 90 && STRONG_AD.test(d.text))
  const headCandidates = headStrong.length ? [{ from: 0, to: 60 }] : []

  // 消费信号回溯：观众在广告刚结束时刷「已下单/买了/到货」，信号之前 120s 就是广告口播。
  // 用严格购买词（避免「好想买」这类非购买表达）限制误报。
  const BUY_SIGNAL = /已下单|下单了|已经买了|已购买|到货了|真香了/
  const buyHits = danmaku.filter((d) => BUY_SIGNAL.test(d.text))
  const buyCandidates = buyHits
    .filter((h) => buyHits.filter((x) => x.t >= h.t - 120 && x.t <= h.t + 20).length >= 2)
    .map((h) => ({ from: Math.max(0, h.t - 120), to: Math.min(duration, h.t + 20) }))

  // 合并候选：六路信号各自的段（重叠或相近的并成一段，记录来源）
  const candidates = []
  const markKind = (c, k) => { c.sources = c.sources ?? []; if (!c.sources.includes(k)) c.sources.push(k) }
  const tagged = [...long.map((s) => [s, 'density']), ...kwCandidates.map((s) => [s, 'keyword']), ...buyCandidates.map((s) => [s, 'buy']), ...markCandidates.map((s) => [s, 'mark']), ...headCandidates.map((s) => [s, 'head'])]
  for (const [sp, kind] of tagged) {
    const last = candidates.find((c) => sp.from <= c.to + 30 && sp.to >= c.from - 30)
    if (last) {
      last.from = Math.min(last.from, sp.from)
      last.to = Math.max(last.to, sp.to)
      markKind(last, kind)
    } else { const c = { from: sp.from, to: sp.to }; markKind(c, kind); candidates.push(c) }
  }
  // 字幕关键词信号（最可靠）：口播广告的字幕里必含「下单/链接/优惠/这款/价格」等词。
  // 弹幕可能不刷广告词（观众在讨论别的），但字幕不会骗人。需要调用方传入 official.body。
  const SUB_AD = /下单|链接|优惠|购买|价格|这款|橱窗|店铺|点击|评论区|领券|折扣|好物|优惠券|拍下/
  if (Array.isArray(subs) && subs.length) {
    const subHits = subs.filter((l) => SUB_AD.test(l.content)).map((l) => Number(l.from) || 0)
    const subSpans = []
    for (const tt of subHits.sort((a, b) => a - b)) {
      const last = subSpans[subSpans.length - 1]
      if (last && tt - last.to <= 60) last.to = tt
      else subSpans.push({ from: tt, to: tt })
    }
    for (const sp of subSpans) {
      const count = subHits.filter((x) => x >= sp.from && x <= sp.to).length
      if (count >= 2 || sp.to - sp.from >= 20) {
        candidates.push({ from: Math.max(0, sp.from - 15), to: Math.min(duration, sp.to + 30), subAd: true, sources: ['sub'] })
      }
    }
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
      lowDensity: Number(Math.max(0, 1 - ratio).toFixed(2)),
      confidence: ((sp.sources ?? []).some((k) => ['sub', 'mark', 'buy', 'head'].includes(k)) || near.length) ? 'high' : 'low',
      sources: sp.sources ?? [],
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
