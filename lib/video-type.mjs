// lib/video-type.mjs — 视频类型判定（2.0 设计 01-证据体系 §3.5）
//
// adaptive 轨的依据，零成本（只看元数据，不看图）。四类：music / slides / screen / foreign，
// 都不中 → unknown。判定只给「建议」+ evidence（判据命中明细），不做最终判断——agent 可覆盖。
//
// fast 档 changeRate=null 时类型判定无法执行，输出 { type: null, confidence: 0, reason }——
// 不是 'unknown'（unknown 语义是「判了，四类都不中」，fast 是「没法判」，两者必须分开）。

// 类型 → 建议抽帧策略（agent 可覆盖，设计 01 §3.5）
export const TYPE_TRACKS = {
  music: { gapSec: 3, desc: '按变化率密抽（2~4 秒/帧）' },
  slides: { gapSec: null, desc: '每页一张（场景切页去重）' },
  screen: { gapSec: 45, desc: '30~60 秒/帧' },
  foreign: { gapSec: null, desc: '字幕带优先，帧数按字幕带' },
  unknown: { gapSec: 240, desc: '默认 coarse 2 张，先扫一眼再决定' },
}

/**
 * @param {object} meta 元数据
 * @param {number|null} meta.changeRate 内容变化率（次/秒）；fast 档为 null
 * @param {number} [meta.subsChars=0] 字幕字数
 * @param {number} [meta.subsMusicRatio=0] 字幕 ♪/歌词占比 0~1
 * @param {number} [meta.danmakuCount=0] 弹幕数
 * @param {boolean} [meta.hasAudio=true] 是否有音频流
 * @param {number} [meta.avgVolume=0] 平均音量（dB）
 * @param {string} [meta.subsLang] 字幕语言（'zh' / 'en' / ...）
 * @param {boolean} [meta.hasTranslated=false] 是否有中文翻译轨
 * @returns {{type: string|null, confidence: number, evidence: object, reason?: string}}
 */
export function detectVideoType(meta = {}) {
  const {
    changeRate, subsChars = null, subsMusicRatio = null, danmakuCount = null,
    hasAudio = null, avgVolume = null, subsLang = null, hasTranslated = false,
  } = meta

  // fast 档：changeRate=null → 类型判定无法执行（设计 01 §3.5，不是 unknown）
  if (changeRate === null || changeRate === undefined) {
    return { type: null, confidence: 0, evidence: {}, reason: 'changeRate unavailable (fast mode)' }
  }

  // 「缺失」= null（采不到），不触发判据——硬编码 0/true 会让假判据恒命中（审查 P1-①）
  const has = (v) => v !== null && v !== undefined

  const evidence = { changeRate, subsChars, subsMusicRatio, danmakuCount, hasAudio, avgVolume, subsLang, hasTranslated }
  const hits = { music: 0, slides: 0, screen: 0, foreign: 0 }

  // music：字幕全是 ♪/歌词 + 变化率 >1.2 + 弹幕少
  if (has(subsMusicRatio) && subsMusicRatio > 0.5) hits.music++
  if (changeRate > 1.2) hits.music++
  if (has(danmakuCount) && danmakuCount < 50) hits.music++

  // slides：变化率 <0.05 + 字幕少 + 画面静态（变化率低即静态）
  if (changeRate < 0.05) hits.slides++
  if (has(subsChars) && subsChars < 200) hits.slides++
  if (changeRate < 0.1) hits.slides++

  // screen：无音频流 或 平均音量 < -50dB（缺失不触发）
  if (hasAudio === false) hits.screen++
  if (has(avgVolume) && avgVolume < -50) hits.screen++

  // foreign：字幕非中文 且 无翻译轨（设计 01 §3.5 是 AND 复合判据，不是两个独立判据）
  if (has(subsLang) && !/zh/i.test(subsLang) && !hasTranslated) hits.foreign++

  // 取命中数最多的类型；全 0 → unknown
  const scored = Object.entries(hits)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  const [bestType, bestHits] = scored[0] ?? ['unknown', 0]

  // 每类判据数不同，confidence 用「命中数 / 该类判据总数」
  const total = { music: 3, slides: 3, screen: 2, foreign: 1 }
  const confidence = bestType === 'unknown' ? 0 : Number((bestHits / total[bestType]).toFixed(2))

  return {
    type: bestType,
    confidence,
    evidence: { ...evidence, hits },
  }
}
