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
