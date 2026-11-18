// lib/subs-digest.mjs — 字幕摘要（2.0 设计文档 02-字幕链路 / 字幕链路-设计.md）
//
// 目标：把 40 分钟视频的数万 token 字幕压成每段 ~45~140 token 的「骨架」，让 agent 用几百 token
// 判断「哪段值得读」，按需再取全文（全文永远落盘，不翻译、不改写）。
//
// 摘要四铁律（实测校准，缺一不可）：
//   ① 关键词用 TF-IDF（不用词频）  ② 停用词表完整（中英 200+）
//   ③ 广告句踢出摘要（复用 adKeywords）  ④ head/info 截断 60 字（中）/ 110 字符（英）
//
// fact/op 双通道：fact = head/info/keywords/claims/numbers（事实）；op = 观点句（复用 emotion.mjs 的 opinion 词表）。

import { hasOpinion } from './emotion.mjs'

// ── 停用词表（英文 200+，中文 200+）─────────────────────────────────
export const STOP_EN = new Set(`
the a an of to and in that is was were be been being are am it its this these those
for on with as at by from or not but if then than so we you they he she i his her their our your my me us them
which who whom what when where why how all any both each few more most other some such no nor only own same too very
can will would could should may might must shall do does did done doing have has had having
there here about into over under again further once during before after above below between through
because while although though since until unless whether either neither
just also even still yet already ever never always often sometimes usually
one two three four five six seven eight nine ten up down out off away back
got get gets getting make makes made making said says say saying like really actually basically literally
now then thus hence therefore however moreover furthermore meanwhile mr mrs ms dr prof sir madam
ok okay yes no yeah good bad great big small many much little people person thing things way ways time times year years day days
first second third last next new old today tomorrow yesterday week month today's where's what's that's it's
`.split(/\s+/).filter(Boolean))

export const STOP_ZH = new Set(`
的 了 吗 呢 啊 吧 呀 哦 嗯 是 在 有 和 与 或 及 而 也 都 就 才 又 再 还 很 更 最 太 挺 比较 非常 十分 相当 稍微
这 那 这个 那个 这些 那些 这样 那样 这种 那种 这里 那里 什么 怎么 为什么 如何 谁 哪 哪些 哪个
我 你 他 她 它 我们 你们 他们 她们 它们 自己 大家 别人 人家
然后 所以 但是 可是 不过 而且 并且 或者 虽然 因为 如果 由于 于是 接着 后来 当时 之后 之前 现在 已经 曾经 正在
一个 一些 一样 一直 一点 一下 一起 一切 一般 一定 一种 一些
可以 可能 应该 需要 想要 觉得 认为 知道 看到 听到 说 讲 做 用 让 把 被 给 对 从 到 向 往 跟 同 关于 对于
时候 时间 地方 东西 事情 问题 情况 方面 部分 内容 过程 结果 原因 关系 感觉 想法 意思
其实 真的 确实 当然 毕竟 反正 居然 竟然 甚至 尤其 特别
就是 还是 不是 没有 只是 只有 还要 还有 这个 那个 这样 那样 这种
出来 起来 下来 上去 下去 进来 进去 过来 过去 回来 回去
开始 结束 进行 出现 发生 变成 成为 叫做 叫作 表示 说明 包括 比如 例如
多少 多少 怎么样 怎么办 为什么 什么时候 什么地方 什么人
`.split(/\s+/).filter(Boolean))

// ── 广告词（平台化；通用中文默认，调用方可传 adKeywords 覆盖）──────
// 0.3 抽检发现「鱼油/欧米伽/海力生」类 UP 主口播词漏掉——这类词随视频变化，由平台适配器的 adKeywords 补。
export const DEFAULT_AD_KEYWORD = /(金主|恰饭|商单|硬广|软广|赞助|推广|接广|带货|下单|优惠码|优惠券|购买|链接|橱窗|薅|福利|抽奖|品牌|合作)/i

// ── 结构抽取（结论 / 转折）─────────────────────────────────────────
const CONCL_ZH = /(所以|因此|总之|这就是|由此可见|换句话说|总而言之|也就是说|归根结底)/
const CONCL_EN = /(^|\s)(so |therefore|thus|in short|that's why|in other words|as a result)/i
const TURN_ZH = /(但是|然而|不过|其实|可是|反而|没想到|结果)/
const TURN_EN = /(^|\s)(but |however|actually|instead|unfortunately)/i

// ── 语言检测 ────────────────────────────────────────────────────────
export function detectLang(lines) {
  const sample = (Array.isArray(lines) ? lines : []).slice(0, 20)
    .map((l) => String(l?.content ?? l?.text ?? '')).join('')
  const zh = (sample.match(/[\u4e00-\u9fa5]/g) ?? []).length
  const en = (sample.match(/[a-zA-Z]/g) ?? []).length
  return zh > en ? 'zh' : 'en'
}

// ── 分句合并（设计 02 §3.2）────────────────────────────────────────
// 中文：相邻两句总长 ≤ 40 字且前句不以句末标点结尾 → 合并；英文 ≤ 30 词同理。时间戳取前句起点。
export function mergeSentences(lines, lang = detectLang(lines)) {
  const out = []
  for (const l of (Array.isArray(lines) ? lines : [])) {
    const text = String(l?.content ?? l?.text ?? '').trim()
    if (!text) continue
    const from = Number(l?.from ?? l?.t ?? 0) || 0
    const prev = out[out.length - 1]
    const joined = prev ? prev.text + ' ' + text : ''
    const tooLong = lang === 'zh' ? joined.length > 40 : joined.split(/\s+/).length > 30
    const prevEnds = prev ? /[。！？；.!?;]$/.test(prev.text) : true
    if (prev && !prevEnds && !tooLong) prev.text = joined
    else out.push({ from, text })
  }
  return out
}

// ── 分词 ────────────────────────────────────────────────────────────
// 中文：char-bigram（3~4 字窗口，去停用词）；英文：单词（去停用词 + 小写 + 去 's）
export function tokenize(text, lang) {
  if (lang === 'zh') {
    const clean = String(text).replace(/[a-zA-Z0-9]/g, '')
    const out = []
    for (let n = 3; n <= 4; n++) {
      for (let i = 0; i + n <= clean.length; i++) {
        const w = clean.slice(i, i + n)
        if (!STOP_ZH.has(w)) out.push(w)
      }
    }
    return out
  }
  const words = String(text).toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []
  return words.map((w) => w.replace(/'s$/, '')).filter((w) => w.length >= 2 && !STOP_EN.has(w))
}

// ── TF-IDF 关键词（设计 02 §4.2 铁律 1）───────────────────────────
// 排除全片高频泛词（df > 段数 × 1.5），按 tf×idf 排序取 topN，去重叠（短词被长词包含则丢弃）。
export function tfidfKeywords(sentences, lang, segCount, topN = 6) {
  const df = new Map()
  for (const s of sentences) {
    for (const t of new Set(tokenize(s.text, lang))) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = Math.max(1, sentences.length)
  const idf = (t) => Math.log((N + 1) / (1 + (df.get(t) ?? 0))) + 1

  const tf = new Map()
  for (const s of sentences) for (const t of tokenize(s.text, lang)) tf.set(t, (tf.get(t) ?? 0) + 1)

  const cand = [...tf.entries()]
    .filter(([t]) => (df.get(t) ?? 0) <= segCount * 1.5)
    .map(([t, c]) => [t, c * idf(t)])
    .sort((a, b) => b[1] - a[1])
  const kws = []
  for (const [w] of cand) {
    if (kws.some((k) => k.includes(w) || w.includes(k))) continue
    kws.push(w)
    if (kws.length >= topN) break
  }
  return kws
}

// ── 截断（设计 02 §4.2 铁律 4：中 60 字 / 英 110 字符）─────────────
export function clip(text, lang) {
  const s = String(text ?? '')
  const limit = lang === 'zh' ? 60 : 110
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

// ── 段摘要（fact + op 双通道）───────────────────────────────────────
/**
 * @param {Array<{from:number,text:string}>} sentences 段内合并句
 * @param {string} lang
 * @param {object} opts { kws, adKeyword }
 * @returns {{head, info, keywords, claims, numbers, op, chars}}
 */
export function summarizeSegment(sentences, lang, opts = {}) {
  const kws = opts.kws ?? []
  const adKeyword = opts.adKeyword ?? DEFAULT_AD_KEYWORD
  const isAd = (text) => adKeyword.test(text)

  const score = (s) => {
    const toks = tokenize(s.text, lang)
    const kwHit = toks.filter((t) => kws.includes(t)).length
    const nums = (s.text.match(/\d+/g) ?? []).length
    const claim = (lang === 'zh' ? CONCL_ZH : CONCL_EN).test(s.text) ? 2 : 0
    const turn = (lang === 'zh' ? TURN_ZH : TURN_EN).test(s.text) ? 1 : 0
    const ad = isAd(s.text) ? 5 : 0
    const lenPenalty = lang === 'zh' && s.text.length > 50 ? -1 : 0
    return kwHit * 2 + nums * 2 + claim + turn + lenPenalty - ad
  }

  const ranked = [...sentences].sort((a, b) => score(b) - score(a))
  // P0：head/info 必须排除广告句——ad 扣 5 分不够，广告句带数字+关键词仍可能排第一（0.3 实测鱼油广告口播漏进 head）
  const nonAd = ranked.filter((s) => !isAd(s.text))
  const head = nonAd[0] ?? null
  const info = nonAd[1] ?? null
  // 骨架句子带秒级时间戳（设计 01 §3.8：agent 要能定位「12:34 那个细节」）
  const stamped = (s) => (s ? { t: Number(s.from) || 0, text: clip(s.text, lang) } : null)
  const claims = ranked.filter((s) => (lang === 'zh' ? CONCL_ZH : CONCL_EN).test(s.text) && !isAd(s.text)).slice(0, 2).map((s) => stamped(s))
  const op = ranked.filter((s) => hasOpinion(s.text) && !isAd(s.text)).slice(0, 2).map((s) => stamped(s))
  const numbers = [...new Set(
    (sentences.map((s) => s.text).join(' ').match(/\b(1[89]\d{2}|20\d{2})\b|\d{2,4}(?=万吨|年|美元|亿|万)/g) ?? []),
  )].slice(0, 8)
  const chars = sentences.reduce((a, s) => a + s.text.length, 0)

  return {
    head: stamped(head),
    info: stamped(info),
    keywords: kws,
    claims,
    numbers,
    op,
    chars,
    lang,
  }
}

// ── 可压缩性判定（字幕链路-设计 §3.8：质量 ≠ 可压缩）───────────────
// 命中 ≥3 条 → compressible: false（字幕字全对但摘不出信息：梗/拟声/押韵）。
export function assessCompressibility(sentences, lang) {
  const list = (Array.isArray(sentences) ? sentences : []).filter((s) => String(s?.text ?? '').trim())
  if (!list.length) return { compressible: false, reasons: ['empty'], sample: [] }

  const texts = list.map((s) => s.text)
  const hits = []

  // 1. 平均句长过短（<10 字）
  const avgLen = texts.reduce((a, t) => a + t.length, 0) / texts.length
  if (avgLen < 10) hits.push('short-sentences')

  // 2. 实词比过低（<40%）：实词 = 去停用词后的 token 占比
  const totalTok = texts.reduce((a, t) => a + (lang === 'zh' ? t.length : t.split(/\s+/).length), 0)
  const contentTok = texts.reduce((a, t) => a + tokenize(t, lang).length, 0)
  const contentRatio = totalTok ? contentTok / totalTok : 0
  if (contentRatio < 0.4) hits.push('low-content-ratio')

  // 3. 无数字 / 无专名
  const hasNumber = texts.some((t) => /\d{2,4}/.test(t))
  const hasProper = lang === 'zh' ? false : texts.some((t) => /[A-Z][a-z]{3,}/.test(t))
  if (!hasNumber && !hasProper) hits.push('no-number-proper')

  // 4. 句间语义连贯性低（char-bigram 相似度中位数 < 0.1）
  let lowCohesion = false
  if (texts.length >= 2) {
    // 用轻量 char-bigram 相似度（内联，避免引入 semantic-core 依赖）
    const sims = []
    for (let i = 0; i < texts.length - 1; i++) {
      sims.push(_bigramSim(texts[i], texts[i + 1]))
    }
    sims.sort((a, b) => a - b)
    const median = sims[Math.floor(sims.length / 2)]
    if (median < 0.1) lowCohesion = true
  }
  if (lowCohesion) hits.push('low-cohesion')

  return {
    compressible: hits.length < 3,
    reasons: hits,
    sample: texts.slice(0, 3),
  }
}

function _bigramSim(a, b) {
  const va = _bigrams(a)
  const vb = _bigrams(b)
  let dot = 0, na = 0, nb = 0
  for (const [k, v] of va) { dot += v * (vb.get(k) || 0); na += v * v }
  for (const v of vb.values()) nb += v * v
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}

function _bigrams(text) {
  const m = new Map()
  const chars = Array.from(String(text)).filter((c) => c.trim() !== '')
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i] + chars[i + 1]
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}

// ── 主入口：整条字幕 → 每段摘要 ──────────────────────────────────────
/**
 * @param {Array<{from:number,content:string}>} lines 带时间戳字幕行（主轨或翻译轨）
 * @param {object} opts { lang?, segSec=240, duration?, adKeyword? }
 * @returns {{lang, segSec, segments: Array, compressible}}
 */
export function digestSubs(lines, opts = {}) {
  const lang = opts.lang ?? detectLang(lines)
  const segSec = opts.segSec ?? 240
  const duration = opts.duration ?? _maxFrom(lines)
  const merged = mergeSentences(lines, lang)
  const segCount = Math.max(1, Math.ceil(duration / segSec))

  const segments = []
  for (let from = 0; from < duration; from += segSec) {
    const to = Math.min(from + segSec, duration)
    const inSeg = merged.filter((s) => s.from >= from && s.from < to)
    if (!inSeg.length) continue
    const kws = tfidfKeywords(inSeg, lang, segCount)
    const sum = summarizeSegment(inSeg, lang, { kws, adKeyword: opts.adKeyword })
    segments.push({ from, to, ...sum })
  }

  return {
    lang,
    segSec,
    segments,
    compressible: assessCompressibility(merged, lang),
  }
}

function _maxFrom(lines) {
  const arr = (Array.isArray(lines) ? lines : [])
  const max = arr.reduce((m, l) => Math.max(m, Number(l?.from ?? 0) || 0), 0)
  return max > 0 ? Math.ceil(max + 60) : 0
}
