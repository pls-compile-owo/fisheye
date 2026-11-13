// danmaku 模块单测：广告段检测 / 热区摘要 / 过滤规则
import test from 'node:test'
import assert from 'node:assert/strict'
import { AD_SEGMENT_SIGNAL, detectAdSegments, summarizeDanmaku } from '../lib/danmaku.mjs'
import { spamReason, filterDanmaku } from '../danmaku-filter.mjs'

test('AD_SEGMENT_SIGNAL：命中广告关键词', () => {
  assert.ok(AD_SEGMENT_SIGNAL.test('感谢金主爸爸'))
  assert.ok(AD_SEGMENT_SIGNAL.test('本期恰饭'))
  assert.ok(AD_SEGMENT_SIGNAL.test('优惠码在评论区'))
  assert.ok(!AD_SEGMENT_SIGNAL.test('这个视频真好看'))
})

test('detectAdSegments：空 / 短视频返回空数组', () => {
  assert.deepEqual(detectAdSegments([], 300), [])
  assert.deepEqual(detectAdSegments([{ t: 1, text: 'x' }], 60), [])
})

test('detectAdSegments：密度低谷 + 广告词 → 识别出段', () => {
  // 300 秒视频：中段 100~160s 弹幕稀少，其余密集
  const danmaku = []
  for (let t = 0; t < 300; t += 2) {
    if (t >= 100 && t < 160) continue
    danmaku.push({ t, text: '666' })
  }
  danmaku.push({ t: 120, text: '恰饭时间' })
  const segs = detectAdSegments(danmaku, 300)
  assert.ok(Array.isArray(segs))
  assert.ok(segs.length >= 1)
  for (const s of segs) {
    assert.ok(s.to > s.from)
    assert.ok(s.ts.includes('-'))
    assert.ok(['high', 'low'].includes(s.confidence))
  }
})

test('summarizeDanmaku：空输入返回 null', () => {
  assert.equal(summarizeDanmaku([]), null)
})

test('summarizeDanmaku：按时间桶聚合，返回时间与样本', () => {
  const list = [
    { t: 1, text: '666' },
    { t: 2, text: '666' },
    { t: 3, text: '哈哈' },
    { t: 11, text: '好' }
  ]
  const out = summarizeDanmaku(list, 5, 6)
  assert.ok(Array.isArray(out))
  assert.equal(out.length, 2)
  assert.equal(out[0].start, 0)
  assert.equal(out[0].count, 3)
  assert.ok(out[0].samples.includes('666×2'))
  assert.equal(out[1].start, 10)
})

test('danmaku-filter：只过滤明确引流，不碰梗', () => {
  assert.ok(spamReason('加微信领取福利'))
  assert.ok(spamReason('私信我'))
  assert.ok(!spamReason('666'))
  assert.ok(!spamReason('awsl'))
  assert.ok(!spamReason('哈哈哈哈'))
  const { kept, dropped } = filterDanmaku([
    { t: 1, text: '666' },
    { t: 2, text: '加微信' },
    { t: 3, text: '前面高能' }
  ])
  assert.equal(kept.length, 2)
  assert.ok(dropped.ad >= 1)
})
