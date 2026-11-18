// 情绪耦合 demo v2：用分位数（相对高低）而不是固定阈值
import fs from 'node:fs'
const { getView, getOfficialSubs, getDanmaku } = await import('' + new URL('../lib/bili.mjs', import.meta.url).href + '')

const BV = process.argv[2] ?? 'BV1WhaA6hE7s'
const SEG = Number(process.argv[3] ?? 240)
const v = await getView(BV)
const subs = await getOfficialSubs(BV, v.pages[0].cid)
const tr = subs?.translated
const lines = (tr && Array.isArray(tr.body) && tr.body.length) ? tr.body : subs.body
const dms = await getDanmaku(v.pages[0].cid)

const SUBS_EMO = /(我请问|他妈|tmd|属于是|好家伙|蚌埠住了|祖坟|什么概念|这玩意|离谱|绝了|真就|笑死|开香槟|绷不住|麻了|草|？？？|！{2,}|对吧|你说|是不是)/gi
const DM_EMO = /(哈{2,}|草{1,}|笑死|泪目|？{2,}|\?{2,}|！{2,}|啊啊啊|awsl|破防|绷不住|蚌埠住了|绝了|牛|妙|厉害|呜呜)/i

const rows = []
for (let from = 0; from < v.duration; from += SEG) {
  const to = Math.min(from + SEG, v.duration)
  const segSubs = lines.filter((l) => Number(l.from) >= from && Number(l.from) < to)
  const segDms = (dms ?? []).filter((d) => Number(d.t) >= from && Number(d.t) < to)
  if (!segSubs.length) continue
  const subsHits = (segSubs.map((l) => String(l.content)).join('').match(SUBS_EMO) ?? []).length
  const dmHits = segDms.filter((d) => DM_EMO.test(String(d.text))).length
  // 每句情绪词数 / 情绪弹幕占比
  const subsEmo = Math.min(1, subsHits / Math.max(1, segSubs.length))
  const dmEmo = Math.min(1, dmHits / Math.max(1, segDms.length))
  rows.push({ from, to, dms: segDms.length, subsEmo: +subsEmo.toFixed(3), dmEmo: +dmEmo.toFixed(3) })
}

const med = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const mS = med(rows.map((r) => r.subsEmo))
const mD = med(rows.map((r) => r.dmEmo))

console.log(`# ${v.title} (${v.duration}s)`)
console.log(`# 中位数：字幕情绪 ${mS.toFixed(3)} / 弹幕情绪 ${mD.toFixed(3)}（高于中位数 = 高）`)
console.log('段      弹幕数  字幕情绪  弹幕情绪  判定')
const tally = { 都高: 0, 字幕高: 0, 弹幕高: 0, 都低: 0 }
for (const [i, r] of rows.entries()) {
  const hiS = r.subsEmo > mS
  const hiD = r.dmEmo > mD
  const tag = hiS && hiD ? '① 都高' : hiS ? '② 字幕高' : hiD ? '③ 弹幕高' : '④ 都低'
  tally[tag.slice(2)] = (tally[tag.slice(2)] ?? 0) + 1
  console.log(`${String(i + 1).padStart(2)}  ${fmt(r.from)}-${fmt(r.to)}  ${String(r.dms).padStart(5)}  ${r.subsEmo.toFixed(3).padStart(7)}  ${r.dmEmo.toFixed(3).padStart(7)}  ${tag}`)
}
console.log(`\n# ${JSON.stringify(tally)}`)

function fmt(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
