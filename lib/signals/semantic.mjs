// lib/signals/semantic.mjs — 广告段语义仲裁（可选能力，零依赖 / 零 token 默认开销）
//
// 定位：语义判定是「仲裁器」不是「信号源」——不产出新候选段，只对确定性信号
// （密度/关键词/打点…）已产出的候选段做二次判决，改写 confidence。
// 这样语义挂了/乱判，最坏是置信度标错，不会漏段、不会崩确定性结果。
//
// 省 token 的关键：只对「悬而未决」的段调用外部 judge——
//   · low 段（纯密度低谷，无关键词命中）：正是「密度低谷型广告 vs 低互动段」难分处
//   · high 但仅 1 次关键词命中：剩余误报大多卡在这（单次「赞助/下单/金主」是调侃还是真口播）
// 已很有把握的段（多关键词命中 / 台词族命中）不调语义，零额外开销。
//
// judge 契约（由调用方注入，如平台适配器 / CLI 外部进程 / 本地模型）：
//   judge(segment, texts, ctx) => { isAd: 'yes'|'no'|'uncertain', reason? }  （同步或 async）
//   · segment = { from, to, confidence, keywords, lowDensity }
//   · texts   = 该段窗口内拼好的文字（弹幕 + 字幕/台词），judge 只看这个就能判
//   · ctx     = 完整工作上下文（danmaku/dens/hits/subLines…），留给想用更多信号的实现

// 悬而未决：low 段，或 high 但关键词命中 ≤1 次
export function isPendingSegment(s) {
  return s.confidence === 'low' || (s.confidence === 'high' && (s.keywords?.length ?? 0) <= 1)
}

// 收集段窗口内文字：弹幕 + 字幕/台词，按上限截断（默认 2000 字）
export function collectSegmentTexts(s, ctx, limit = 2000) {
  const from = (s.from ?? 0) - 15
  const to = (s.to ?? 0) + 15
  const dm = (Array.isArray(ctx?.danmaku) ? ctx.danmaku : [])
    .filter((d) => d && d.t >= from && d.t <= to).map((d) => d.text)
  const sub = (Array.isArray(ctx?.subLines) ? ctx.subLines : [])
    .filter((l) => l && (Number(l.from) || 0) >= from && (Number(l.from) || 0) <= to)
    .map((l) => l.content ?? '')
  let out = ''
  for (const t of [...dm, ...sub]) {
    if (!t) continue
    out += (out ? '\n' : '') + t
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

/**
 * 语义仲裁：对「悬而未决」的候选段调用 judge 二次判定，改写 confidence。
 * @param {Array} segments detectAdSegmentsCore 的产出（含 confidence/keywords）
 * @param {object} ctx 工作上下文（danmaku / subLines…）
 * @param {Function|null} judge 外部判定器；null → 原样返回（零开销）
 * @returns {Promise<Array>} 仲裁后的段列表（judge 返回 yes/no 改写，uncertain/抛错/无 judge 原样）
 */
export async function arbitrateAdSegments(segments, ctx, judge) {
  if (typeof judge !== 'function') return segments
  const out = []
  for (const s of segments) {
    if (!isPendingSegment(s)) { out.push(s); continue }
    const texts = collectSegmentTexts(s, ctx)
    let r = null
    try { r = await judge(s, texts, ctx) } catch { /* judge 抛错 → 原样，不打断 */ }
    if (r?.isAd === 'yes') out.push({ ...s, confidence: 'high', semantic: { judge: 'yes', reason: r.reason } })
    else if (r?.isAd === 'no') out.push({ ...s, confidence: 'low', semantic: { judge: 'no', reason: r.reason } })
    else out.push(s)
  }
  return out
}
