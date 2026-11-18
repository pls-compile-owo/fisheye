// lib/signals/index.mjs — 广告信号源注册表 + 编排器
//
// 把原来硬编码在 danmaku.mjs 的七路广告信号，拆成可注册的信号源：
//   - 弹幕族五路（density / keywords / mark / head / buy）见 signals/danmaku.mjs
//   - 台词族两路（sub-keywords / sub-patterns）见 signals/subtitle.mjs
//
// 信号源契约：{ group, detect(ctx, keywords) -> [{ from, to, subAd?, subKind? }] }
//   group 决定编排阶段：
//     'primary'   主信号（密度/关键词），开了但没产出 → 早退
//     'secondary' 补充信号（打点/片头/消费），主信号有产出才参与
//     'subtitle'  台词族（不依赖弹幕），独立追加、不参与弹幕族重叠合并
// 加新信号 = 在 signals/ 下加一个文件 + 在 AD_SIGNALS 注册一行 + 平台在 signals 数组里声明。
import { fmt } from '../util.mjs'
import { densitySignal, keywordSignal, markSignal, headSignal, buySignal } from './danmaku.mjs'
import { subKeywordSignal, subPatternSignal } from './subtitle.mjs'

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

// 信号源注册表（可扩展点：加新信号在这里注册一行）
export const AD_SIGNALS = {
  'danmaku-density': { group: 'primary', detect: densitySignal },
  'danmaku-keywords': { group: 'primary', detect: keywordSignal },
  mark: { group: 'secondary', detect: markSignal },
  head: { group: 'secondary', detect: headSignal },
  buy: { group: 'secondary', detect: buySignal },
  'sub-keywords': { group: 'subtitle', detect: subKeywordSignal },
  'sub-patterns': { group: 'subtitle', detect: subPatternSignal },
}

const has = (signals, name) => signals.includes(name)

// 弹幕族候选重叠合并（30s 内合并成一段），顺序对齐旧实现：density → keywords → buy → mark → head
function mergeOverlap(segs) {
  const out = []
  for (const sp of segs) {
    const last = out.find((c) => sp.from <= c.to + 30 && sp.to >= c.from - 30)
    if (last) {
      last.from = Math.min(last.from, sp.from)
      last.to = Math.max(last.to, sp.to)
    } else {
      out.push({ from: sp.from, to: sp.to })
    }
  }
  return out
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

  // 共享工作上下文：广告关键词命中 + 密度桶（供多个信号源与最终置信度复用）
  const hits = hasDm ? dm.filter((d) => keywords.ad.test(d.text)) : []
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
  const subLines = Array.isArray(subtitles) ? subtitles : (Array.isArray(transcript) ? transcript : null)
  const ctx = { danmaku: dm, duration, bucketSec, stepSec, hits, dens, median, subLines }

  // 主信号（density → keywords），开了但没产出 → 早退（mark/head/buy/sub 不补充）
  const primary = []
  if (has(signals, 'danmaku-density')) primary.push(...densitySignal(ctx))
  if (has(signals, 'danmaku-keywords')) primary.push(...keywordSignal(ctx))
  const mainSignals = useDensity || has(signals, 'danmaku-keywords')
  if (mainSignals && !primary.length) return []

  // 补充信号（buy → mark → head，对齐旧合并顺序）
  const secondary = []
  if (has(signals, 'buy')) secondary.push(...buySignal(ctx, keywords))
  if (has(signals, 'mark')) secondary.push(...markSignal(ctx, keywords))
  if (has(signals, 'head')) secondary.push(...headSignal(ctx, keywords))

  // 合并弹幕族候选
  const candidates = mergeOverlap([...primary, ...secondary])

  // 台词族：独立追加（不参与弹幕族重叠合并），subAd 标记 → 最终置信度判 high
  if (subLines?.length && (has(signals, 'sub-keywords') || has(signals, 'sub-patterns'))) {
    if (has(signals, 'sub-keywords')) candidates.push(...subKeywordSignal(ctx, keywords))
    if (has(signals, 'sub-patterns')) candidates.push(...subPatternSignal(ctx, keywords))
  }

  // 最终：低密度比 + 置信度（弹幕关键词命中或台词族命中 → high）+ 片头片尾截断
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
  const clamped = out.map((s) => {
    if (s.confidence === 'high') return s
    const from = Math.max(s.from - 15, 60)
    const to = Math.min(s.to + 15, duration - 60)
    return { ...s, from, to, dur: to - from, ts: `${fmt(from)}-${fmt(to)}` }
  })
  return clamped.filter((s) => s.confidence === 'high' || s.dur >= 45)
}

/**
 * 旧签名（零回归）：detectAdSegments(danmaku, duration, bucketSec, stepSec, subs)。
 * 等价于 detectAdSegmentsCore({ danmaku, duration, bucketSec, stepSec, subtitles: subs })。
 */
export function detectAdSegments(danmaku, duration, bucketSec = 30, stepSec = 10, subs = null, keywords = DEFAULT_KEYWORDS, signals = DEFAULT_SIGNALS) {
  return detectAdSegmentsCore({ danmaku, duration, bucketSec, stepSec, subtitles: subs }, keywords, signals)
}
