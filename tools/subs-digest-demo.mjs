// 字幕摘要 demo：用真实字幕验证「每段 45 token」的摘要长什么样
import fs from 'node:fs'
const { getView, getOfficialSubs } = await import('' + new URL('../lib/bili.mjs', import.meta.url).href + '')

const BV = process.argv[2] ?? 'BV1WhaA6hE7s'
const SEG_SEC = Number(process.argv[3] ?? 240)

const v = await getView(BV)
const subs = await getOfficialSubs(BV, v.pages[0].cid)
const body = subs.body
const lang = /[\u4e00-\u9fa5]/.test(body.slice(0, 20).map((l) => l.content).join('')) ? 'zh' : 'en'

const STOP_EN = new Set('the a an of to and in that is it was for on with as at by from this be are or not but if then than so we you they he she i his her their our your its which who whom what when where why how all any both each few more most other some such no nor only own same too very can will just should now'.split(' '))
const STOP_ZH = new Set('的 了 吗 呢 啊 吧 然后 所以 但是 其实 那个 就是说 这个 我们 你们 他们 一个 什么 怎么 因为 所以 如果 可以 就是 还是 不是 没有 已经 现在 这样 那样'.split(' '))
const CONCL = /^(所以|因此|总之|这就是|由此可见|so |therefore|thus|in short|that's why)/i
const TURN = /^(但是|然而|不过|其实|but |however|actually)/i

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
    if (prev && !/[.!?。！？]$/.test(prev.text) && (prev.text + ' ' + s.text).length < (lang === 'zh' ? 40 : 200)) {
      prev.text = prev.text + ' ' + s.text
    } else out.push({ ...s })
  }
  return out
}

function tokens(text) {
  return lang === 'zh'
    ? [...text.matchAll(/[\u4e00-\u9fa5]{2,4}/g)].map((m) => m[0])
    : text.toLowerCase().match(/[a-z]{3,}/g) ?? []
}

function score(s, kwFreq) {
  const toks = tokens(s.text).filter((t) => !(lang === 'zh' ? STOP_ZH : STOP_EN).has(t))
  const kw = toks.reduce((a, t) => a + (kwFreq.get(t) ?? 0), 0)
  const nums = (s.text.match(/\d+|[A-Z]{2,}/g) ?? []).length
  const claim = CONCL.test(s.text) ? 2 : TURN.test(s.text) ? 1 : 0
  return kw * 2 + nums + claim * 2
}

const all = mergeShort(splitSentences(body))
const kwFreq = new Map()
for (const s of all) for (const t of tokens(s.text)) if (!(lang === 'zh' ? STOP_ZH : STOP_EN).has(t)) kwFreq.set(t, (kwFreq.get(t) ?? 0) + 1)

const segs = []
for (let from = 0; from < v.duration; from += SEG_SEC) {
  const to = Math.min(from + SEG_SEC, v.duration)
  const inSeg = all.filter((s) => s.from >= from && s.from < to)
  if (!inSeg.length) continue
  const ranked = [...inSeg].sort((a, b) => score(b, kwFreq) - score(a, kwFreq))
  const head = ranked[0]
  const info = ranked[1] ?? null
  const claims = ranked.filter((s) => CONCL.test(s.text)).slice(0, 2).map((s) => s.text)
  const numbers = [...new Set([...inSeg.flatMap((s) => s.text.match(/\b\d{2,4}\b|[A-Z]{2,5}/g) ?? [])])].slice(0, 8)
  const kws = [...kwFreq.entries()].filter(([t]) => inSeg.some((s) => s.text.includes(t))).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t)
  const chars = inSeg.reduce((a, s) => a + s.text.length, 0)
  segs.push({ from, to, chars, head: head.text, info: info?.text ?? '', claims, numbers, keywords: kws })
}

console.log(`# ${v.title} (${v.duration}s, ${lang}, ${all.length} 句合并后)`)
let totalTok = 0
for (const [i, s] of segs.entries()) {
  const approx = Math.round((s.head.length + s.info.length + s.keywords.join(' ').length + s.claims.join(' ').length + s.numbers.join(' ').length) / 4)
  totalTok += approx
  console.log(`\n--- 段 ${i + 1}  ${fmt(s.from)}-${fmt(s.to)}  ${s.chars} 字  ~${approx} token ---`)
  console.log('head :', s.head.slice(0, 200))
  console.log('info :', s.info.slice(0, 200))
  console.log('kw   :', s.keywords.join(', '))
  console.log('num  :', s.numbers.join(', '))
  if (s.claims.length) console.log('claim:', s.claims[0].slice(0, 160))
}
console.log(`\n# 合计 ~${totalTok} token（原文 ${body.length} 行 / ${body.reduce((a, l) => a + String(l.content).length, 0)} 字）`)

function fmt(s) {
  const m = Math.floor(s / 60)
  const ss = String(Math.floor(s % 60)).padStart(2, '0')
  return `${m}:${ss}`
}
