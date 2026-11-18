// lib/segments.mjs — 段卡片（2.0 设计文档 01-证据体系 §3.8/3.9、04-语义切分）
//
// 4 分钟切段（40 分钟 → 10 段），每段产一张「段卡片」：把字幕骨架、弹幕情绪、广告词命中、
// 语义切换点、低活跃标记、画面成本按段并置。判断（哪段重要）归 agent，这里只做「证据对齐」。
//
// 两级定位：段（4 分钟）用于选择，句子时间戳（秒）用于精确引用（设计 01 §3.8）。

import { digestSubs } from './subs-digest.mjs'
import { danmakuEmotion, subsEmotion, emotionLevel } from './emotion.mjs'

// 情绪绝对下限（设计 03 §5.2 占位值，需实测校准）
export const FLOOR_DANMAKU = 0.08
export const FLOOR_SUBS = 0.02

/**
 * @param {object} opts
 * @param {number} opts.duration 视频时长（秒）
 * @param {number} [opts.segSec=240] 段长（4 分钟）
 * @param {Array<{from:number,content:string}>} [opts.subsLines] 字幕行（主轨或翻译轨）
 * @param {Array<{t:number,text:string}>} [opts.danmaku] 弹幕
 * @param {Array<{t:number,text:string}>} [opts.adKeywordHits] 广告词命中（纯线索，不参与决策）
 * @param {Array<{t:number,confidence:number,signals:string[]}>} [opts.semanticShifts] 语义切换点
 * @param {Array<{from:number,to:number,lowDensity:number}>} [opts.lowActivitySegs] 低活跃段
 * @param {RegExp} [opts.adKeyword] 广告词（踢出字幕摘要）
 * @param {number} [opts.perImage=1024] 单图 token（0.5 重定：官方 Flash 上限）
 * @returns {{segments: Array, median: {subs:number, danmaku:number}, textTokens: number}}
 */
export function makeSegments(opts = {}) {
  const duration = Number(opts.duration) || 0
  const segSec = opts.segSec ?? 240
  const subsLines = Array.isArray(opts.subsLines) ? opts.subsLines : []
  const danmaku = Array.isArray(opts.danmaku) ? opts.danmaku : []
  const adHits = Array.isArray(opts.adKeywordHits) ? opts.adKeywordHits : []
  const shifts = Array.isArray(opts.semanticShifts) ? opts.semanticShifts : []
  const lowSegs = Array.isArray(opts.lowActivitySegs) ? opts.lowActivitySegs : []
  const perImage = opts.perImage ?? 1024

  // 字幕骨架（每 4 分钟段）
  const digest = subsLines.length ? digestSubs(subsLines, { segSec, duration, adKeyword: opts.adKeyword }) : null

  // 先算每段的两个情绪值（level 需跨段中位数，见下）
  const rows = []
  const segCount = Math.max(1, Math.ceil(duration / segSec))
  for (let i = 0; i < segCount; i++) {
    const from = i * segSec
    const to = Math.min(from + segSec, duration)
    const segSubs = subsLines.filter((l) => Number(l?.from ?? 0) >= from && Number(l?.from ?? 0) < to)
    const segDm = danmaku.filter((d) => Number(d?.t ?? 0) >= from && Number(d?.t ?? 0) < to)
    rows.push({
      i, from, to,
      subsLines: segSubs,
      subsEmo: subsEmotion(segSubs),
      dmEmo: danmakuEmotion(segDm),
      segDm,
    })
  }

  // 全片中位数（只统计有值的段）
  const medianOf = (arr) => {
    const vals = arr.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b)
    return vals.length ? vals[Math.floor(vals.length / 2)] : 0
  }
  const medianSubs = medianOf(rows.map((r) => r.subsEmo?.value))
  const medianDanmaku = medianOf(rows.map((r) => r.dmEmo?.value))

  const segments = rows.map((r) => {
    const ds = digest?.segments?.find((s) => s.from === r.from) ?? null

    // 弹幕情绪（level 用全片中位数 + 绝对下限）
    const dmEmo = r.dmEmo
    if (dmEmo) dmEmo.level = emotionLevel(dmEmo.value, medianDanmaku, FLOOR_DANMAKU)

    // 字幕情绪
    const subsEmo = r.subsEmo
    if (subsEmo) subsEmo.level = emotionLevel(subsEmo.value, medianSubs, FLOOR_SUBS)

    // 同段并置：广告词命中 + 语义切换 + 低活跃
    const segAdHits = adHits.filter((h) => Number(h?.t ?? 0) >= r.from && Number(h?.t ?? 0) < r.to)
    const segShifts = shifts.filter((s) => Number(s?.t ?? 0) >= r.from && Number(s?.t ?? 0) < r.to)
    const lowActivity = lowSegs.some((s) => s.from < r.to && s.to > r.from)

    // 证据可用性：字幕/弹幕都低置信 → needsFrames（两源低置信 → 建议读图）
    const subsLow = !ds || (ds.compressible === false)
    const dmLow = !dmEmo || dmEmo.confidence === 'low'
    const needsFrames = subsLow && dmLow

    return {
      i: r.i,
      from: r.from,
      to: r.to,
      dur: r.to - r.from,
      subs: ds ? {
        lang: ds.lang,
        chars: ds.chars,
        head: ds.head,            // {t, text} 秒级
        info: ds.info,
        keywords: ds.keywords,
        claims: ds.claims,
        numbers: ds.numbers,
        op: ds.op,
        confidence: ds.compressible === false ? 'none' : 'ok',
      } : null,
      danmaku: dmEmo ? {
        emotion: { value: dmEmo.value, level: dmEmo.level, samples: dmEmo.samples },
        hits: dmEmo.top,          // 3 条代表性情绪弹幕（结论配证据）
        confidence: dmEmo.confidence,
      } : null,
      subsEmotion: subsEmo ? { value: subsEmo.value, level: subsEmo.level } : null,
      adKeywordHits: segAdHits,
      lowActivity,
      shifts: segShifts,
      needsFrames,
      frames: {
        coarse: { cost: perImage },
        adaptive: { cost: perImage, enabled: false },
        fine: { cost: perImage },
      },
    }
  })

  // text token 估算：骨架（head/info/keywords/claims/numbers/op）+ 弹幕 top，按字符数折算
  let textTokens = 0
  for (const s of segments) {
    const strs = []
    if (s.subs) {
      strs.push(s.subs.head?.text ?? '', s.subs.info?.text ?? '', s.subs.keywords.join(' '))
      for (const c of s.subs.claims) strs.push(c.text)
      for (const o of s.subs.op) strs.push(o.text)
    }
    for (const h of s.danmaku?.hits ?? []) strs.push(h.text)
    textTokens += Math.round(strs.join(' ').length / (s.subs?.lang === 'en' ? 4 : 1.5))
  }

  return { segments, median: { subs: medianSubs, danmaku: medianDanmaku }, textTokens }
}
