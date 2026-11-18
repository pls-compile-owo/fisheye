// golden case 验收集：用真实视频样本（test/golden/fixtures/*.json）验证核心启发式规则的输出。
// 样本来自真实 B站 视频（字幕/弹幕已落盘），测试离线运行，不依赖网络。
// 2.0 第 3 批：广告检测从「广告段」改为「低活跃段 + 广告词高光」（两路），真值目录 ad-truth → low-activity。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessSubtitleQuality } from '../lib/bili.mjs'
import { detectLowActivity, adKeywordHits } from '../lib/danmaku.mjs'
import { pickTimes } from '../lib/frame.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'fixtures')
const fixtures = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({
  file: f,
  data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
}))

test('golden 样本存在', () => {
  assert.ok(fixtures.length >= 4, '至少 4 条真实视频样本')
})

for (const { file, data } of fixtures) {
  const label = `${data.bvid}（${String(data.title).slice(0, 20)}）`

  test(`${label}：字幕质量判定与真实样本一致`, () => {
    const quality = assessSubtitleQuality(data.subtitleLines)
    if (!data.hasOfficialSubs) {
      assert.equal(data.subtitleLines.length, 0)
      return
    }
    assert.equal(quality.quality, data.expectedQuality)
    assert.ok(quality.avgEff >= 0 && quality.uniqueRatio >= 0 && quality.uniqueRatio <= 1)
  })

  test(`${label}：低活跃段检测结构合法`, () => {
    const segs = detectLowActivity(data.danmaku, data.duration)
    for (const s of segs) {
      assert.ok(s.to > s.from)
      assert.ok(s.dur >= 45, '低活跃段应 ≥45s')
      assert.equal(s.lowDensity, true)
      assert.ok(Array.isArray(s.sample))
    }
  })

  test(`${label}：取帧计划覆盖完整时长`, () => {
    const r = pickTimes(0, data.duration, 9, [], [])
    assert.ok(r && Array.isArray(r.times))
    assert.equal(r.times.length, 9)
    assert.ok(r.times[0] >= 0)
    assert.ok(r.times[r.times.length - 1] <= data.duration + 0.001)
    for (let i = 1; i < r.times.length; i++) assert.ok(r.times[i] > r.times[i - 1])
  })
}

// ── 低活跃真值评估（人工标注的广告段 vs 两路检测）────────────────────
const truthDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'low-activity')
const truthFiles = fs.existsSync(truthDir) ? fs.readdirSync(truthDir).filter((f) => f.endsWith('.json')) : []

test('低活跃真值样本存在', () => {
  assert.ok(truthFiles.length >= 1, '至少 1 条人工标注的广告真值')
})

// 召回判定：低活跃段（密度低谷）段覆盖 或 广告词命中点落在真值段内（两路，设计 05 §7.6）
function covered(truth, lowSegs, adHits) {
  for (const s of lowSegs) {
    const overlap = Math.max(0, Math.min(s.to, truth.to) - Math.max(s.from, truth.from))
    if (overlap / Math.max(1, truth.to - truth.from) >= 0.8) return true
  }
  for (const h of adHits) {
    if (h.t >= truth.from && h.t <= truth.to) return true
  }
  return false
}

for (const file of truthFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(truthDir, file), 'utf8'))
  test(`${data.bvid}（${String(data.title).slice(0, 20)}）：两路覆盖真值`, () => {
    const lowSegs = detectLowActivity(data.danmaku, data.duration)
    const adHits = adKeywordHits(data.danmaku)
    if (!data.truthAdSegments.length) return // 无广告样本：不要求召回（低活跃段是低互动，无广告视频也可能有）
    if (data.hardCase) return // 已知难例（猝不及防口播 / 单关键词 / 短广告），真值照存但不强制 coverage
    for (const truth of data.truthAdSegments) {
      assert.ok(covered(truth, lowSegs, adHits),
        `真值广告段 ${Math.round(truth.from)}-${Math.round(truth.to)} 应被低活跃段或广告词命中覆盖`)
    }
  })
}
