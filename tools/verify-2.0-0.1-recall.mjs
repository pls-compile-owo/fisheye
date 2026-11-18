// tools/verify-2.0-0.1-recall.mjs — 第 0 批验证 0.1：两路 vs 七路广告召回对比
// 只读 test/golden/ad-truth/*.json（27 条人工真值），离线运行，不改任何产品代码。
// 两种召回口径：
//   high-only = 只看 confidence=high 的段（= 关键词/台词族命中）
//   all       = high + low 全算（= 关键词命中 + 密度低谷，对应 2.0「两路」= density+keywords 的完整产出）
// 命中分三档：✓ overlap≥0.8，△ 0<overlap<0.8，✗ 0
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectAdSegmentsCore } from '../lib/danmaku.mjs'
import { resolveKeywords } from '../lib/signals/partitions.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', 'test', 'golden', 'ad-truth')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()

const SEVEN = ['danmaku-density', 'danmaku-keywords', 'mark', 'head', 'buy', 'sub-keywords', 'sub-patterns']
const TWO = ['danmaku-density', 'danmaku-keywords']

function run(data, signals) {
  const kw = resolveKeywords(data.tid_v2)
  return detectAdSegmentsCore({ danmaku: data.danmaku, duration: data.duration }, kw, signals)
}

function bestOverlap(truth, segs, onlyHigh) {
  let best = 0
  for (const s of segs) {
    if (onlyHigh && s.confidence !== 'high') continue
    const overlap = Math.max(0, Math.min(s.to, truth.to) - Math.max(s.from, truth.from))
    const ratio = overlap / Math.max(1, truth.to - truth.from)
    if (ratio > best) best = ratio
  }
  return best
}

const mark = (v) => (v >= 0.8 ? '✓' : v > 0 ? '△' : '✗')

const rows = []
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  const seven = run(data, SEVEN)
  const two = run(data, TWO)
  const truths = data.truthAdSegments || []
  const density = data.danmakuCount / Math.max(1, data.duration)
  const cleared = /乱码已清空|GBK 乱码/.test(data.truthNote || '')
  rows.push({
    bvid: data.bvid,
    title: String(data.title || '').slice(0, 18),
    dur: data.duration,
    dm: data.danmakuCount,
    density: +density.toFixed(2),
    cleared,
    hard: !!data.hardCase,
    truths,
    seven,
    two,
    n7high: seven.filter((s) => s.confidence === 'high').length,
    n7low: seven.filter((s) => s.confidence === 'low').length,
    n2high: two.filter((s) => s.confidence === 'high').length,
    n2low: two.filter((s) => s.confidence === 'low').length,
  })
}

console.log('=== 逐条明细（命中 = 覆盖≥0.8；上排 high-only，下排 high+low 全算）===')
for (const r of rows) {
  const t = r.truths.map((x) => `${Math.round(x.from)}-${Math.round(x.to)}`).join(';') || '(无广告)'
  const hi7 = r.truths.map((x) => mark(bestOverlap(x, r.seven, true))).join('')
  const hi2 = r.truths.map((x) => mark(bestOverlap(x, r.two, true))).join('')
  const all7 = r.truths.map((x) => mark(bestOverlap(x, r.seven, false))).join('')
  const all2 = r.truths.map((x) => mark(bestOverlap(x, r.two, false))).join('')
  console.log(`${r.bvid}  ${r.cleared ? '乱码' : '正常'} ${r.hard ? 'HARD' : '    '} ${r.title}`)
  console.log(`  真值=${t}  七路 high=${r.n7high} low=${r.n7low}  两路 high=${r.n2high} low=${r.n2low}`)
  console.log(`  high-only: 七路=${hi7 || '-'} 两路=${hi2 || '-'}`)
  console.log(`  all段:     七路=${all7 || '-'} 两路=${all2 || '-'}`)
}

// ── 汇总 ──
const hasAd = rows.filter((r) => r.truths.length > 0 && !r.hard)
const noAd = rows.filter((r) => r.truths.length === 0)
const hard = rows.filter((r) => r.hard)

function agg(list, onlyHigh) {
  const seven = { hit: 0, part: 0, miss: 0 }
  const two = { hit: 0, part: 0, miss: 0 }
  for (const r of list) {
    for (const t of r.truths) {
      const v7 = bestOverlap(t, r.seven, onlyHigh)
      const v2 = bestOverlap(t, r.two, onlyHigh)
      if (v7 >= 0.8) seven.hit++; else if (v7 > 0) seven.part++; else seven.miss++
      if (v2 >= 0.8) two.hit++; else if (v2 > 0) two.part++; else two.miss++
    }
  }
  return { seven, two }
}

function fmtAgg(a) {
  const tot7 = a.seven.hit + a.seven.part + a.seven.miss
  const tot2 = a.two.hit + a.two.part + a.two.miss
  const recall7 = tot7 ? +((a.seven.hit / tot7) * 100).toFixed(0) : 0
  const recall2 = tot2 ? +((a.two.hit / tot2) * 100).toFixed(0) : 0
  const ratio = recall7 ? Math.round((recall2 / recall7) * 100) : 0
  return { tot7, tot2, recall7, recall2, ratio, hit7: a.seven.hit, hit2: a.two.hit }
}

function report(name, list) {
  const hi = fmtAgg(agg(list, true))
  const all = fmtAgg(agg(list, false))
  console.log(`\n${name}（${list.length} 条 / truth 段 ${all.tot7} 个）`)
  console.log(`  high-only 口径: 七路 ${hi.recall7}%(${hi.hit7}/${hi.tot7})  两路 ${hi.recall2}%(${hi.hit2}/${hi.tot2})  两路/七路=${hi.ratio}%`)
  console.log(`  all 段 口径:    七路 ${all.recall7}%(${all.hit7}/${all.tot7})  两路 ${all.recall2}%(${all.hit2}/${all.tot2})  两路/七路=${all.ratio}%`)
}

report('=== 有广告样本（非 hard）===', hasAd)

const falsePos7 = noAd.reduce((s, r) => s + r.n7high, 0)
const falsePos2 = noAd.reduce((s, r) => s + r.n2high, 0)
console.log(`\n无广告样本 ${noAd.length} 条：七路 high 误报 ${falsePos7} 条，两路 high 误报 ${falsePos2} 条`)

console.log('\n=== 分组：按弹幕文本可用性（all 段口径）===')
for (const [label, pred] of [['正常文本', (r) => !r.cleared], ['乱码清空(仅密度)', (r) => r.cleared]]) {
  const list = hasAd.filter(pred)
  if (!list.length) continue
  const a = fmtAgg(agg(list, false))
  console.log(`  ${label}（${list.length} 条）：七路 ${a.recall7}%(${a.hit7}/${a.tot7})  两路 ${a.recall2}%(${a.hit2}/${a.tot2})  比值 ${a.ratio}%`)
}
