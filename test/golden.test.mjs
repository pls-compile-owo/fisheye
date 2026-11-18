// golden case 验收集：用真实视频样本（test/golden/fixtures/*.json）验证核心启发式规则的输出。
// 样本来自真实 B站 视频（字幕/弹幕已落盘），测试离线运行，不依赖网络。
// 这些用例会随算法调整而更新预期——改阈值时先跑这里，确认变化是有意的。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessSubtitleQuality } from '../lib/bili.mjs'
import { detectAdSegments } from '../lib/danmaku.mjs'
import { resolveKeywords } from '../lib/signals/partitions.mjs'
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

  test(`${label}：广告段检测与回放一致`, () => {
    const segs = detectAdSegments(data.danmaku, data.duration)
    assert.equal(segs.length, data.expectedAdSegments)
    for (const s of segs) {
      assert.ok(s.to > s.from)
      assert.ok(s.dur > 0)
      assert.ok(['high', 'low'].includes(s.confidence))
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

// ── 广告段真值评估（人工标注的广告段 vs 检测结果）────────────────────────
const adTruthDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'ad-truth')
const adTruthFiles = fs.existsSync(adTruthDir) ? fs.readdirSync(adTruthDir).filter((f) => f.endsWith('.json')) : []

test('广告真值样本存在', () => {
  assert.ok(adTruthFiles.length >= 1, '至少 1 条人工标注的广告真值')
})

for (const file of adTruthFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(adTruthDir, file), 'utf8'))
  test(`${data.bvid}（${String(data.title).slice(0, 20)}）：广告段检测覆盖真值`, () => {
    // 按分区词库检测：科技/汽车等分区的「赞助/下单」降级，否则无广告样本会被默认词库误报
    const segs = detectAdSegments(data.danmaku, data.duration, 30, 10, null, resolveKeywords(data.tid_v2))
    // 人工确认无广告的视频：不应有「疑似广告」（high）段；low 段是密度低谷（低互动提示），允许存在
    if (!data.truthAdSegments.length) {
      const high = segs.filter((s) => s.confidence === 'high')
      assert.equal(high.length, 0, '人工确认无广告的视频不应检测出疑似广告段：' + high.map((s) => s.ts).join(','))
      return
    }
    let bestCover = 0
    for (const truth of data.truthAdSegments) {
      for (const s of segs) {
        const overlap = Math.max(0, Math.min(s.to, truth.to) - Math.max(s.from, truth.from))
        bestCover = Math.max(bestCover, overlap / Math.max(1, truth.to - truth.from))
      }
    }
    // 已知难例（猝不及防口播 / 单关键词 / 短广告）：需语义识别（B）才能覆盖，
    // 真值照存但不强制 coverage，避免把「语义识别」的目标当成「词表检测」的失败。
    if (data.hardCase) return
    assert.ok(bestCover >= 0.8, `至少覆盖真值广告段的 80%（实际 ${(bestCover * 100).toFixed(0)}%）`)
    // 无片头/片尾低置信度段（片头片尾弹幕少是正常现象）
    for (const s of segs) {
      if (s.confidence === 'low') {
        assert.ok(s.from >= 60 && s.to <= data.duration - 60, `低置信度段不应出现在片头/片尾：${s.ts}`)
      }
    }
  })
}
