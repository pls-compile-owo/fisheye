// tools/verify-2.0-0.1-density.mjs — 深挖 5 条「乱码清空」样本：密度信号为何没召回真值
// 复刻 densitySignal 的桶计算（bucketSec=30, stepSec=10），输出全片中位数、真值段内密度，
// 判断真值段是否满足「n < median*0.45」的低谷条件、是否够 45s 连续长度。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', 'test', 'golden', 'ad-truth')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()

const BUCKET = 30
const STEP = 10
const TH = 0.45

for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  if (!/乱码已清空|GBK 乱码/.test(data.truthNote || '')) continue
  if (!data.truthAdSegments?.length) continue
  const { danmaku, duration } = data

  // 密度桶
  const dens = []
  for (let s = 0; s + BUCKET <= duration; s += STEP) {
    let n = 0
    for (const d of danmaku) if (d.t >= s && d.t < s + BUCKET) n++
    dens.push({ s, n })
  }
  const nums = dens.map((d) => d.n).sort((a, b) => a - b)
  const median = nums[Math.floor(nums.length / 2)] || 1
  const lowLine = median * TH

  console.log(`\n${data.bvid}  dur=${duration}s dm=${danmaku.length}  median=${median} 低谷线(<${lowLine.toFixed(1)})`)
  for (const t of data.truthAdSegments) {
    const segBuckets = dens.filter((d) => d.s >= t.from && d.s < t.to)
    const ns = segBuckets.map((d) => d.n)
    const maxN = Math.max(...ns)
    const below = segBuckets.filter((d) => d.n < lowLine).length
    const truthDur = t.to - t.from
    console.log(`  真值 ${t.from}-${t.to}（${truthDur}s）`)
    console.log(`    段内桶数=${segBuckets.length} 密度范围=[${Math.min(...ns)}..${maxN}] 低于低谷线的桶=${below}/${segBuckets.length} 中位密度=${median}`)
    console.log(`    段内密度明细: ${ns.map((n, i) => `${segBuckets[i].s}s:${n}`).join(' ')}`)
    console.log(`    判定: 段内最大密度 ${maxN} ${maxN < lowLine ? '<' : '≥'} ${lowLine.toFixed(1)}（低谷线）→ ${maxN < lowLine ? '整段都是低谷' : '段内有桶高于低谷线，非纯低谷'}`)
    console.log(`    时长: ${truthDur}s ${truthDur >= 45 ? '≥45s(可通过)' : '<45s(被≥45s门槛过滤)'}`)
  }
}
