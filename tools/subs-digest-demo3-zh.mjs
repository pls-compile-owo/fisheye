// 字幕摘要 demo v3（中文轨）：B站 中文翻译轨 + 中文停用词 + char-bigram TF-IDF
import fs from 'node:fs'
const { getView, getOfficialSubs } = await import('' + new URL('../lib/bili.mjs', import.meta.url).href + '')

const BV = process.argv[2] ?? 'BV1WhaA6hE7s'
const SEG_SEC = Number(process.argv[3] ?? 240)
const v = await getView(BV)
const subs = await getOfficialSubs(BV, v.pages[0].cid)

// 翻译轨结构：{ body: [{from, content}], file }
const tr = subs?.translated
const body = (tr && Array.isArray(tr.body) && tr.body.length ? tr.body : subs.body)
const lang = body === subs.body ? 'en' : 'zh'
console.log(`# 轨: ${lang === 'zh' ? '中文翻译轨' : '原文轨'}（${body.length} 行）`)

const STOP_ZH = new Set(`的 了 吗 呢 啊 吧 呀 哦 嗯 是 在 有 和 与 或 及 而 也 都 就 才 又 再 还 很 更 最 太 挺 比较
这 那 这个 那个 这些 那些 这样 那样 这种 那种 这里 那里 什么 怎么 为什么 如何 谁 哪 哪些
我 你 他 她 它 我们 你们 他们 她们 它们 自己 大家 别人 人家
然后 所以 但是 可是 不过 而且 并且 或者 虽然 因为 如果 由于 于是 接着 后来 当时 之后 之前 现在 已经
一个 一些 一样 一直 一点 一下 一起 一切 一般 一定 一种 一样
可以 可能 应该 需要 想要 觉得 认为 知道 看到 听到 说 讲 做 用 让 把 被 给 对 从 到 向 往 跟 同
时候 时间 地方 东西 事情 问题 情况 方面 部分 内容 过程 结果 原因
其实 真的 确实 当然 毕竟 反正 居然 竟然 甚至 尤其 特别 比较 非常 十分 特别 相当 稍微
` .split(/\s+/).filter(Boolean))

const CONCL = /(所以|因此|总之|这就是|由此可见|换句话说|总而言之)/
const TURN = /(但是|然而|不过|其实|可是|反而)/
const AD = /(赞助|恰饭|商单|广告|下单|优惠|链接|橱窗|带货|推荐|薅|福利|抽奖|购买|品牌|合作|控油|洁面|痘痘|精华|面膜|护肤|成分|配方|功效|长效|源头抑制)/

function splitSentences(lines) {
  const out = []
  for (const l of lines) {
    const t = String(l.content ?? '').trim()
    if (!t) continue
    // 中文按标点切句（字幕本身常一句一行，拆分后合并）
    for (const part of t.split(/(?<=[。！？；])/)) {
      if (part.trim()) out.push({ from: Number(l.from ?? 0), text: part.trim() })
    }
  }
  return out
}

function mergeShort(sents) {
  const out = []
  for (const s of sents) {
    const prev = out[out.length - 1]
    const joined = prev ? prev.text + s.text : ''
    if (prev && !/[。！？；]$/.test(prev.text) && joined.length <= 60) {
      prev.text = joined
    } else out.push({ ...s })
  }
  return out
}

// 中文 char-bigram（2~4 字窗口），过滤停用词
function tokens(text) {
  const clean = text.replace(/[a-zA-Z0-9]/g, '')
  const out = []
  for (let n = 3; n <= 4; n++) {
    for (let i = 0; i + n <= clean.length; i++) {
      const w = clean.slice(i, i + n)
      if (!STOP_ZH.has(w)) out.push(w)
    }
  }
  return out
}

const all = mergeShort(splitSentences(body))
const df = new Map()
for (const s of all) for (const t of new Set(tokens(s.text))) df.set(t, (df.get(t) ?? 0) + 1)
const N = all.length
const idf = (t) => Math.log((N + 1) / (1 + (df.get(t) ?? 0))) + 1
const segCount = Math.ceil(v.duration / SEG_SEC)

const segs = []
for (let from = 0; from < v.duration; from += SEG_SEC) {
  const to = Math.min(from + SEG_SEC, v.duration)
  const inSeg = all.filter((s) => s.from >= from && s.from < to)
  if (!inSeg.length) continue

  const tf = new Map()
  for (const s of inSeg) for (const t of tokens(s.text)) tf.set(t, (tf.get(t) ?? 0) + 1)
  // 关键词：只取 3~4 字窗口（中文实体词通常 2~4 字），并去掉被更长词包含的子串
  const cand = [...tf.entries()]
    .filter(([t]) => (df.get(t) ?? 0) <= segCount * 1.5 && t.length >= 3)
    .map(([t, c]) => [t, c * idf(t)])
    .sort((a, b) => b[1] - a[1])
  const kws = []
  for (const [w] of cand) {
    if (kws.some((k) => k.includes(w) || w.includes(k))) continue  // 去重叠
    kws.push(w)
    if (kws.length >= 6) break
  }

  const score = (s) => {
    const toks = tokens(s.text)
    const kwHit = toks.filter((t) => kws.includes(t)).length
    const nums = (s.text.match(/\d+/g) ?? []).length
    const claim = CONCL.test(s.text) ? 1 : TURN.test(s.text) ? 0.5 : 0
    const ad = AD.test(s.text) ? 5 : 0
    const lenPenalty = s.text.length > 50 ? -1 : 0   // 中文 >50 字扣分
    return kwHit * 2 + nums * 2 + claim + lenPenalty - ad
  }
  const ranked = [...inSeg].sort((a, b) => score(b) - score(a))
  const head = ranked[0]
  const info = ranked[1] ?? null
  const claims = ranked.filter((s) => CONCL.test(s.text) && !AD.test(s.text)).slice(0, 2).map((s) => s.text)
  const nums = [...new Set((inSeg.map((s) => s.text).join(' ').match(/\b(1[89]\d{2}|20\d{2})\b|\d{2,4}(?=万吨|年|美元|亿)/g) ?? []))].slice(0, 8)

  const clip = (x) => (x.length > 60 ? x.slice(0, 60) + '…' : x)
  segs.push({ from, to, chars: inSeg.reduce((a, s) => a + s.text.length, 0), head: clip(head.text), info: clip(info?.text ?? ''), claims: claims.map(clip), numbers: nums, keywords: kws })
}

let totalTok = 0
for (const [i, s] of segs.entries()) {
  const approx = Math.round((s.head.length + s.info.length + s.keywords.join(' ').length + s.claims.join(' ').length + s.numbers.join(' ').length) / 1.5)
  totalTok += approx
  console.log(`\n--- 段 ${i + 1}  ${fmt(s.from)}-${fmt(s.to)}  ${s.chars} 字  ~${approx} token ---`)
  console.log('head :', s.head.slice(0, 120))
  console.log('info :', s.info.slice(0, 120))
  console.log('kw   :', s.keywords.join(', '))
  console.log('num  :', s.numbers.join(', '))
  if (s.claims.length) console.log('claim:', s.claims[0].slice(0, 110))
}
console.log(`\n# 合计 ~${totalTok} token / 轨 ${body.length} 行 ${body.reduce((a, l) => a + String(l.content).length, 0)} 字`)

function fmt(s) {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
