// lib/emotion.mjs — 情绪双分数（字幕 / 弹幕）
//
// 2.0 设计文档 03-弹幕链路。给「观众/UP 反应」这个看不见的证据一个量级：
//   · 只给量级（value + level），不追求精确——agent 拿原始数兜底
//   · 缺失给 null（不是 0）；样本量决定 confidence
//   · 刷屏用 √压缩（分母仍用原始条数）；重复度高标 suspect
//   · 情绪词分层：emotion（纯情绪）→ 情绪分；opinion（观点）→ 字幕摘要的 op 通道
//
// 段级函数只算 value/样本数/top，不判 level——level 需要「全片中位数 + 绝对下限」跨段比较，
// 由 segments.mjs 统一算（设计 03 §5.2：level = value > 全片中位数 && value > floor ? high : low）。

// ── 情绪词分层（设计 03 §5.3）────────────────────────────────────────
// emotion（纯情绪）：独立成句或句尾，不用单字（避免「草原→草」类误报）
export const EMOTION_RE = /(哈{2,}|笑死|泪目|卧槽|awsl|破防|绷不住|蚌埠住了|呜呜|啊{2,}|好耶|太强了|太牛了|厉害了|？？？|？？|！！！|！！)/i

// opinion（观点）：可子串，但「草/牛」这类单字需非汉字边界（避免「草原→草」「牛顿→牛」）
export const OP_RE = /(属于是|我请问|好家伙|绝了|离谱|这玩意|什么概念|对吧|真就|开香槟|麻了|你品|你细品|不是哥们|没绷住|笑不活了)/i
// 单字「草/牛」后接语气词（啊呀哦呢了罢吧吗）或非汉字或结尾视为边界（「牛啊」匹配、「牛顿」不匹配）
export const OP_SINGLE_RE = /(?:[^\u4e00-\u9fa5]|^)(草|牛)(?=[^\u4e00-\u9fa5]|[啊呀哦呢了罢吧吗]|$)/

export const hasOpinion = (text) => OP_RE.test(text) || OP_SINGLE_RE.test(text)

// ── 工具 ────────────────────────────────────────────────────────────
function normalize(text) {
  return String(text ?? '').trim()
}

// √压缩：同文本 n 次 → 贡献 √n（设计 03 §5.4）
function sqrtCompress(list, keyOf = (x) => x.text) {
  const freq = new Map()
  for (const x of list) {
    const k = keyOf(x)
    freq.set(k, (freq.get(k) ?? 0) + 1)
  }
  return [...freq.values()].reduce((s, n) => s + Math.sqrt(n), 0)
}

// 去重后各取 1 条，取前 topN 条代表性原文（数字不可信时看这个，设计 03 §5.1）
function topSamples(list, topN = 3, keyOf = (x) => x.text) {
  const seen = new Set()
  const out = []
  for (const x of list) {
    const k = keyOf(x)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
    if (out.length >= topN) break
  }
  return out
}

// ── 弹幕情绪（段级）─────────────────────────────────────────────────
/**
 * @param {Array<{t:number, text:string}>} danmaku 段内弹幕
 * @returns {null | {value, samples, unique, dupRatio, suspect, confidence, top}}
 *   value     情绪浓度（√压缩后情绪弹幕 / 原始条数）
 *   samples   原始条数
 *   unique    去重文本数
 *   dupRatio  重复度（1 - unique/samples），>0.4 判 spam-heavy
 *   suspect   异常标记（spam-heavy | null）
 *   confidence 样本量决定（<20 条 → low）
 *   top       3 条代表性情绪弹幕原文（去重后各取 1）
 */
export function danmakuEmotion(danmaku) {
  const list = (Array.isArray(danmaku) ? danmaku : []).map((d) => ({
    t: Number(d?.t) || 0,
    text: normalize(d?.text),
  })).filter((d) => d.text)
  if (!list.length) return null

  const emo = list.filter((d) => EMOTION_RE.test(d.text))
  const unique = new Set(list.map((d) => d.text)).size
  const dupRatio = list.length ? Number((1 - unique / list.length).toFixed(2)) : 0
  const value = list.length ? Number((sqrtCompress(emo) / list.length).toFixed(3)) : 0

  return {
    value,
    samples: list.length,
    unique,
    dupRatio,
    suspect: dupRatio > 0.4 ? 'spam-heavy' : null,
    confidence: list.length < 20 ? 'low' : 'ok',
    top: topSamples(emo, 3).map((d) => ({ t: d.t, text: d.text })),
  }
}

// ── 字幕情绪（段级）─────────────────────────────────────────────────
/**
 * @param {Array<{from:number, content:string}>} lines 段内字幕行
 * @returns {null | {value, samples, confidence, top}}
 *   value      情绪句占比（情绪句数 / 总句数）
 *   samples    总句数
 *   confidence 样本量决定（<20 句 → low）
 *   top        3 条代表性情绪句原文
 */
export function subsEmotion(lines) {
  const list = (Array.isArray(lines) ? lines : []).map((l) => ({
    from: Number(l?.from) || 0,
    text: normalize(l?.content),
  })).filter((l) => l.text)
  if (!list.length) return null

  const emo = list.filter((l) => EMOTION_RE.test(l.text))
  const value = Number((emo.length / list.length).toFixed(3))

  return {
    value,
    samples: list.length,
    confidence: list.length < 20 ? 'low' : 'ok',
    top: topSamples(emo, 3, (x) => x.text).map((l) => ({ t: l.from, text: l.text })),
  }
}

// ── level 判定（跨段用，设计 03 §5.2）──────────────────────────────
/**
 * 给定全片各段的 value 与绝对下限，判 level。
 * @param {number} value 本段情绪值
 * @param {number} median 全片各段 value 的中位数
 * @param {number} floor 绝对下限（danmaku 0.08 / subs 0.02，占位值需实测校准）
 * @returns {'high'|'low'}
 */
export function emotionLevel(value, median, floor) {
  return (value > median && value > floor) ? 'high' : 'low'
}
