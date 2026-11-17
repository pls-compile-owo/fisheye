// 弹幕分析：广告段检测（多信号源）/ 热区摘要（过滤规则在 danmaku-filter.mjs）
import { fmt } from './util.mjs'

// 默认中文关键词库（B 站零回归基准；各平台 / 语言可换自己的词库）
export const DEFAULT_KEYWORDS = {
  ad: /金主|恰饭|商单|硬广|软广|赞助|推广|接广|带货|下单|同款|优惠码/i,
  strong: /金主|恰饭|商单|接广|硬广|软广|赞助/i,
  mark: /工程|启动|打点|广告|结束时间|恰饭|广告时间|分\d{2}|侠|提醒/,
  buy: /已下单|下单了|已经买了|已购买|到货了|真香了/,
  sub: /下单|链接|优惠|购买|价格|这款|橱窗|店铺|点击|评论区|领券|折扣|好物|优惠券|拍下/,
  pattern: /点击(下方|链接)|领券|下单立减|评论区(置顶|链接)|限时|同款链接/i,
}

// 兼容旧导出（bilibili 适配器与旧测试仍 import 它）
export const AD_SEGMENT_SIGNAL = DEFAULT_KEYWORDS.ad

// 默认信号：现有六路（弹幕族 + 字幕关键词），保证零回归
export const DEFAULT_SIGNALS = ['danmaku-density', 'danmaku-keywords', 'mark', 'head', 'buy', 'sub-keywords']

const has = (signals, name) => signals.includes(name)

/**
 * 旧签名（零回归）：detectAdSegments(danmaku, duration, bucketSec, stepSec, subs)。
 * 等价于 detectAdSegmentsCore({ danmaku, duration, bucketSec, stepSec, subtitles: subs })。
 */
export function detectAdSegments(danmaku, duration, bucketSec = 30, stepSec = 10, subs = null, keywords = DEFAULT_KEYWORDS, signals = DEFAULT_SIGNALS) {
  return detectAdSegmentsCore({ danmaku, duration, bucketSec, stepSec, subtitles: subs }, keywords, signals)
}

/**
 * 多信号源入口（平台化 + 无弹幕增强）。
 * @param {{danmaku?, duration, bucketSec?, stepSec?, subtitles?, transcript?}} input
 *   subtitles / transcript 均为「带时间戳台词行」[{ from, content }]，可空。
 * @param {object} keywords 平台 / 语言关键词库（默认中文）
 * @param {string[]} signals 启用信号列表（默认六路弹幕族 + 字幕关键词）
 */
export function detectAdSegmentsCore(input, keywords = DEFAULT_KEYWORDS, signals = DEFAULT_SIGNALS) {
  const { danmaku, duration, bucketSec = 30, stepSec = 10, subtitles = null, transcript = null } = input
  const dm = Array.isArray(danmaku) ? danmaku : []
  const hasDm = dm.length > 0

  // 密度信号启用时：无弹幕 / 短视频 / 太稀疏 → 直接返回空（与旧行为一致，零回归）
  const useDensity = has(signals, 'danmaku-density')
  if (useDensity) {
    if (!hasDm || duration < 120) return []
    if (dm.length / duration < 0.2) return []
  }

  // 弹幕广告关键词命中：既供关键词聚类，也供最终置信度判断（有弹幕就无条件算）
  const hits = hasDm ? dm.filter((d) => keywords.ad.test(d.text)) : []

  // —— 密度低谷（信号①）——
  const dens = []
  let median = 1
  if (useDensity) {
    for (let s = 0; s + bucketSec <= duration; s += stepSec) {
      let n = 0
      for (const d of dm) if (d.t >= s && d.t < s + bucketSec) n++
      dens.push({ s, n })
    }
    if (dens.length) {
      const nums = dens.map((d) => d.n).sort((a, b) => a - b)
      median = nums[Math.floor(nums.length / 2)] || 1
    }
  }

  // —— 密度低谷段（信号① 的候选）——
  const long = []
  if (useDensity && dens.length) {
    const spans = []
    for (const d of dens) {
      if (d.n >= median * 0.45) continue
      const last = spans[spans.length - 1]
      if (last && d.s - last.to <= stepSec * 2) last.to = d.s + bucketSec
      else spans.push({ from: d.s, to: d.s + bucketSec, count: 0 })
    }
    long.push(...spans.filter((x) => x.to - x.from >= 45))
  }

  // —— 关键词聚类（信号②）——
  const kwCandidates = []
  if (hasDm && has(signals, 'danmaku-keywords')) {
    const hitTimes = hits.map((h) => h.t).sort((a, b) => a - b)
    const kwSpans = []
    for (const tt of hitTimes) {
      const last = kwSpans[kwSpans.length - 1]
      if (last && tt - last.to <= 60) last.to = tt
      else kwSpans.push({ from: tt, to: tt })
    }
    kwCandidates.push(...kwSpans.filter(
      (s) => s.to - s.from >= 10 && hitTimes.filter((x) => x >= s.from && x <= s.to).length >= 2))
  }

  // 主信号门槛（零回归）：密度 + 关键词都没结果 → 早退，mark/head/buy/sub 不再补充。
  // 无弹幕增强（只开台词族、不开密度/关键词）时，此门槛不生效。
  const mainSignals = useDensity || has(signals, 'danmaku-keywords')
  if (mainSignals && !long.length && !kwCandidates.length) return []

  // —— 数字打点（信号③）——
  const markCandidates = []
  if (hasDm && has(signals, 'mark')) {
    for (const d of dm) {
      if (!keywords.mark.test(d.text)) continue
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
      if (dist < 30 || dist > 600) continue
      markCandidates.push({ from: Math.max(0, Math.min(d.t, T) - 15), to: Math.min(duration, Math.max(d.t, T) + 15) })
    }
  }

  // —— 片头强信号（信号④）——
  const headCandidates = []
  if (hasDm && has(signals, 'head')) {
    const headStrong = dm.filter((d) => d.t < 90 && keywords.strong.test(d.text))
    if (headStrong.length) headCandidates.push({ from: 0, to: 60 })
  }

  // —— 消费回溯（信号⑤）——
  const buyCandidates = []
  if (hasDm && has(signals, 'buy')) {
    buyCandidates.push(...dm.filter((d) => keywords.buy.test(d.text))
      .map((h) => ({ from: Math.max(0, h.t - 120), to: Math.min(duration, h.t + 20) })))
  }

  // 合并弹幕族候选
  const candidates = []
  for (const sp of [...long, ...kwCandidates, ...buyCandidates, ...markCandidates, ...headCandidates]) {
    const last = candidates.find((c) => sp.from <= c.to + 30 && sp.to >= c.from - 30)
    if (last) {
      last.from = Math.min(last.from, sp.from)
      last.to = Math.max(last.to, sp.to)
    } else candidates.push({ from: sp.from, to: sp.to })
  }

  // —— 台词族：字幕关键词（⑥）+ 字幕句式（⑦），不依赖弹幕（无弹幕增强主力）——
  const subLines = Array.isArray(subtitles) ? subtitles
    : (Array.isArray(transcript) ? transcript : null)
  if (subLines && subLines.length && (has(signals, 'sub-keywords') || has(signals, 'sub-patterns'))) {
    const pushSubSpans = (regex, kind) => {
      // 门槛区分：句式（精确）≥2 命中即可；关键词（泛，正文吐槽/举例易误伤）需 ≥3 命中或持续 ≥30s
      const minCount = kind === 'pattern' ? 2 : 3
      const minSpan = kind === 'pattern' ? 10 : 30
      const subHits = subLines.filter((l) => regex.test(l.content)).map((l) => Number(l.from) || 0)
      const subSpans = []
      for (const tt of subHits.sort((a, b) => a - b)) {
        const last = subSpans[subSpans.length - 1]
        if (last && tt - last.to <= 60) last.to = tt
        else subSpans.push({ from: tt, to: tt })
      }
      for (const sp of subSpans) {
        const count = subHits.filter((x) => x >= sp.from && x <= sp.to).length
        if (count >= minCount || sp.to - sp.from >= minSpan) {
          candidates.push({ from: Math.max(0, sp.from - 15), to: Math.min(duration, sp.to + 30), subAd: true, subKind: kind })
        }
      }
    }
    if (has(signals, 'sub-keywords')) pushSubSpans(keywords.sub, 'keyword')
    if (has(signals, 'sub-patterns')) pushSubSpans(keywords.pattern, 'pattern')
  }

  // —— 视觉族（⑧⑨）与平台元数据族（⑩）：后续接入（frame-ocr / scene-rhythm / platform-marks）——

  const out = candidates.map((sp) => {
    const near = hits.filter((h) => h.t >= sp.from - 20 && h.t <= sp.to + 20)
    const segBuckets = dens.filter((d) => d.s >= sp.from && d.s < sp.to)
    const total = segBuckets.reduce((s, d) => s + d.n, 0)
    const ratio = segBuckets.length ? total / segBuckets.length / median : 0
    return {
      from: sp.from,
      to: sp.to,
      dur: sp.to - sp.from,
      ts: `${fmt(sp.from)}-${fmt(sp.to)}`,
      lowDensity: Number((1 - ratio).toFixed(2)),
      confidence: (near.length || sp.subAd) ? 'high' : 'low',
      keywords: near.slice(0, 3).map((h) => h.text),
    }
  })
  // 片头/片尾 60s 内的「低置信度」段丢弃；高置信度不受此限
  const clamped = out.map((s) => {
    if (s.confidence === 'high') return s
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
