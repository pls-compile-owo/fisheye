// 字幕摘要 demo v2：TF-IDF 关键词 + 完整停用词 + 广告句过滤 + 数字清洗
import fs from 'node:fs'
const { getView, getOfficialSubs } = await import('' + new URL('../lib/bili.mjs', import.meta.url).href + '')

const BV = process.argv[2] ?? 'BV1WhaA6hE7s'
const SEG_SEC = Number(process.argv[3] ?? 240)
const v = await getView(BV)
const subs = await getOfficialSubs(BV, v.pages[0].cid)
const body = subs.body
const lang = /[\u4e00-\u9fa5]/.test(body.slice(0, 20).map((l) => l.content).join('')) ? 'zh' : 'en'

// 英文功能词（200+）：介词/冠词/代词/助动词/连词/时间副词
const STOP_EN = new Set(`the a an of to and in that is was were be been being are am it its this these those
for on with as at by from or not but if then than so we you they he she i his her their our your my me us them
which who whom what when where why how all any both each few more most other some such no nor only own same too very
can will would could should may might must shall do does did done doing have has had having
there here about into over under again further once during before after above below between through
because while although though since until unless whether either neither
just also even still yet already ever never always often sometimes usually
these those this that what who whom whose
one two three four five six seven eight nine ten
up down out off away back
got get gets getting got make makes made making
said says say saying
like just really actually basically literally
now then thus hence therefore however moreover furthermore meanwhile
mr mrs ms dr prof
sir madam
ok okay yes no yeah
good bad great big small many much little
people person thing things way ways time times year years day days
first second third last next
new old
here there
` .split(/\s+/).filter(Boolean))

const STOP_ZH = new Set('的 了 吗 呢 啊 吧 然后 所以 但是 其实 那个 就是说 这个 我们 你们 他们 一个 什么 怎么 因为 如果 可以 就是 还是 不是 没有 已经 现在 这样 那样 这种 时候 东西 事情 问题 地方 大家 自己 别人 一些 这些 那些 而且 并且 或者 虽然 不过 因此 于是 接着 后来 当时 之后 之前 里面 外面 上面 下面'.split(' '))

const CONCL = /(所以|因此|总之|这就是|由此可见|so |therefore|thus|in short|that's why)/i
const TURN = /(但是|然而|不过|其实|but |however|actually)/i
// 广告/口播标记：出现就当广告句，不进 claim
const AD = /(sponsor|simpcare|subscribe|order now|link in|patreon|merch|promo|discount|affiliate)/i

function splitSentences(lines) {
  const out = []
  for (const l of lines) {
    const t = String(l.content ?? '').trim()
    if (!t) continue
    out.push({ from: Number(l.from ?? 0), text: t })
  }
  return out
}

function mergeShort(sents) {
  const out = []
  for (const s of sents) {
    const prev = out[out.length - 1]
    const joined = prev ? prev.text + ' ' + s.text : ''
    if (prev && !/[.!?。！？]$/.test(prev.text) && joined.length < (lang === 'zh' ? 40 : 220)) {
      prev.text = joined
    } else out.push({ ...s })
  }
  return out
}

function tokens(text) {
  return lang === 'zh'
    ? [...text.matchAll(/[\u4e00-\u9fa5]{2,4}/g)].map((m) => m[0])
    : (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [])
}

const all = mergeShort(splitSentences(body))

// 全局 df（用于 TF-IDF）
const df = new Map()
for (const s of all) for (const t of new Set(tokens(s.text))) if (!STOP_EN.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
const N = all.length
const idf = (t) => Math.log((N + 1) / (1 + (df.get(t) ?? 0))) + 1

const segs = []
for (let from = 0; from < v.duration; from += SEG_SEC) {
  const to = Math.min(from + SEG_SEC, v.duration)
  const inSeg = all.filter((s) => s.from >= from && s.from < to)
  if (!inSeg.length) continue

  // 段内词频
  const tf = new Map()
  for (const s of inSeg) for (const t of tokens(s.text)) if (!STOP_EN.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1)
  // TF-IDF 关键词：排除全片高频泛词（df > 50% 段数视为背景词）
  const segCount = Math.ceil(v.duration / SEG_SEC)
  const kws = [...tf.entries()]
    .filter(([t]) => (df.get(t) ?? 0) <= segCount * 1.5) // 不是全片都出现的词
    .map(([t, c]) => [t, c * idf(t)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([t]) => t)

  // 句子评分：TF-IDF 关键词命中 × 2 + 年份/专名 × 2 + 结论 × 1 - 广告 × 5
  const score = (s) => {
    const toks = tokens(s.text)
    const kwHit = toks.filter((t) => kws.includes(t)).length
    const nums = (s.text.match(/\b(1[89]\d{2}|20\d{2})\b/g) ?? []).length
    const caps = (s.text.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).length
    const claim = CONCL.test(s.text) ? 1 : TURN.test(s.text) ? 0.5 : 0
    const ad = AD.test(s.text) ? 5 : 0
    return kwHit * 2 + nums * 2 + caps * 0.3 + claim - ad
  }
  const ranked = [...inSeg].sort((a, b) => score(b) - score(a))
  const head = ranked[0]
  const info = ranked[1] ?? null
  const claims = ranked.filter((s) => CONCL.test(s.text) && !AD.test(s.text)).slice(0, 2).map((s) => s.text)

  // 数字：只留年份（4 位 18xx/19xx/20xx）和 ≥2 位有效数字（排除 000 这类片段）
  const nums = [...new Set((inSeg.map((s) => s.text).join(' ').match(/\b(1[89]\d{2}|20\d{2})\b/g) ?? []))].slice(0, 8)

  segs.push({ from, to, chars: inSeg.reduce((a, s) => a + s.text.length, 0), head: head.text, info: info?.text ?? '', claims, numbers: nums, keywords: kws })
}

let totalTok = 0
console.log(`# ${v.title} (${v.duration}s, ${lang}, 合并后 ${all.length} 句)`)
for (const [i, s] of segs.entries()) {
  const approx = Math.round((s.head.length + s.info.length + s.keywords.join(' ').length + s.claims.join(' ').length + s.numbers.join(' ').length) / 4)
  totalTok += approx
  console.log(`\n--- 段 ${i + 1}  ${fmt(s.from)}-${fmt(s.to)}  ${s.chars} 字  ~${approx} token ---`)
  console.log('head :', s.head.slice(0, 190))
  console.log('info :', s.info.slice(0, 190))
  console.log('kw   :', s.keywords.join(', '))
  console.log('num  :', s.numbers.join(', '))
  if (s.claims.length) console.log('claim:', s.claims[0].slice(0, 150))
}
console.log(`\n# 合计 ~${totalTok} token / 原文 ${body.length} 行 ${body.reduce((a, l) => a + String(l.content).length, 0)} 字`)

function fmt(s) {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
