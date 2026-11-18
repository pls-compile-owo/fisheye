// 广告段语义仲裁插槽测试：悬而未决判定 / 文字收集 / yes-no-uncertain 改写 / 省 token 触发时机。
// 注意：本文件测 lib/signals/semantic.mjs（广告仲裁），与 test/semantic.test.mjs（语义切分）不同。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isPendingSegment,
  collectSegmentTexts,
  arbitrateAdSegments,
} from '../lib/signals/semantic.mjs'

test('isPendingSegment：low 段与 ≤1 关键词 high 段悬而未决，多关键词 high 段不调', () => {
  assert.equal(isPendingSegment({ confidence: 'low' }), true)
  assert.equal(isPendingSegment({ confidence: 'high', keywords: [] }), true)
  assert.equal(isPendingSegment({ confidence: 'high', keywords: ['赞助'] }), true)
  assert.equal(isPendingSegment({ confidence: 'high', keywords: ['金主', '下单'] }), false)
})

test('collectSegmentTexts：收集段窗口内弹幕 + 字幕，按上限截断', () => {
  const ctx = {
    danmaku: [{ t: 100, text: '感谢金主' }, { t: 200, text: '片外' }],
    subLines: [{ from: 110, content: '本期由XX赞助' }],
  }
  const texts = collectSegmentTexts({ from: 100, to: 120 }, ctx)
  assert.ok(texts.includes('感谢金主'))
  assert.ok(texts.includes('本期由XX赞助'))
  assert.ok(!texts.includes('片外'), '窗口外弹幕不应收集')
  assert.ok(collectSegmentTexts({ from: 0, to: 0 }, null, 5).length <= 5, '空 ctx 不崩')
})

test('arbitrateAdSegments：无 judge → 原样返回（零开销）', async () => {
  const segs = [{ confidence: 'low' }, { confidence: 'high', keywords: ['赞助'] }]
  const out = await arbitrateAdSegments(segs, {}, null)
  assert.equal(out, segs, '无 judge 应返回同一引用')
})

test('arbitrateAdSegments：yes 改 high、no 改 low、uncertain/抛错原样', async () => {
  const segs = [{ from: 100, to: 120, confidence: 'low', keywords: [] }]
  const yes = await arbitrateAdSegments(segs, {}, async () => ({ isAd: 'yes', reason: '口播' }))
  assert.equal(yes[0].confidence, 'high')
  assert.deepEqual(yes[0].semantic, { judge: 'yes', reason: '口播' })

  const no = await arbitrateAdSegments(segs, {}, async () => ({ isAd: 'no', reason: '客套' }))
  assert.equal(no[0].confidence, 'low')
  assert.deepEqual(no[0].semantic, { judge: 'no', reason: '客套' })

  const unc = await arbitrateAdSegments(segs, {}, async () => ({ isAd: 'uncertain' }))
  assert.equal(unc[0].confidence, 'low', 'uncertain 应保持原 confidence')
  assert.equal(unc[0].semantic, undefined)

  const err = await arbitrateAdSegments(segs, {}, async () => { throw new Error('boom') })
  assert.equal(err[0].confidence, 'low', 'judge 抛错应原样')
})

test('arbitrateAdSegments：省 token——多关键词 high 段不调 judge', async () => {
  const segs = [
    { from: 100, to: 120, confidence: 'high', keywords: ['金主', '下单'] }, // 有把握，不调
    { from: 200, to: 220, confidence: 'low', keywords: [] },                 // 悬而未决，调
  ]
  let calls = 0
  await arbitrateAdSegments(segs, {}, async () => { calls++; return { isAd: 'no' } })
  assert.equal(calls, 1, '只有悬而未决段调用 judge')
})
