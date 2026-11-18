// 信号源框架测试：注册表完整性 / transcript 转写路径 / 可插拔组合。
import test from 'node:test'
import assert from 'node:assert/strict'
import { AD_SIGNALS, detectAdSegmentsCore, DEFAULT_KEYWORDS, DEFAULT_SIGNALS } from '../lib/danmaku.mjs'

test('AD_SIGNALS：注册表含全部七路信号，group/detect 齐全', () => {
  const ids = Object.keys(AD_SIGNALS).sort()
  assert.deepEqual(ids, ['buy', 'danmaku-density', 'danmaku-keywords', 'head', 'mark', 'sub-keywords', 'sub-patterns'])
  for (const [id, sig] of Object.entries(AD_SIGNALS)) {
    assert.ok(['primary', 'secondary', 'subtitle'].includes(sig.group), `${id} group 非法：${sig.group}`)
    assert.equal(typeof sig.detect, 'function', `${id} 缺 detect`)
  }
})

test('DEFAULT_SIGNALS：默认六路（弹幕族 + 字幕关键词）零回归', () => {
  assert.deepEqual(DEFAULT_SIGNALS, ['danmaku-density', 'danmaku-keywords', 'mark', 'head', 'buy', 'sub-keywords'])
})

test('detectAdSegmentsCore：transcript 转写台词触发台词族（无弹幕平台广告识别）', () => {
  const transcript = [
    { from: 10, content: '点击下方链接下单' },
    { from: 15, content: '领取优惠券' },
    { from: 20, content: '限时折扣' },
  ]
  const segs = detectAdSegmentsCore(
    { danmaku: [], duration: 300, transcript },
    DEFAULT_KEYWORDS,
    ['sub-keywords'],
  )
  assert.ok(segs.length >= 1, '转写广告词应检测出段')
  for (const s of segs) assert.equal(s.confidence, 'high')
})

test('detectAdSegmentsCore：无弹幕 + 无台词 → 空', () => {
  const segs = detectAdSegmentsCore(
    { danmaku: [], duration: 300 },
    DEFAULT_KEYWORDS,
    ['sub-keywords', 'sub-patterns'],
  )
  assert.deepEqual(segs, [])
})

test('detectAdSegmentsCore：信号可插拔——只开字幕句式也能检测', () => {
  const transcript = [
    { from: 5, content: '点击下方链接' },
    { from: 10, content: '领券下单立减' },
  ]
  const segs = detectAdSegmentsCore(
    { danmaku: [], duration: 300, transcript },
    DEFAULT_KEYWORDS,
    ['sub-patterns'],
  )
  assert.ok(segs.length >= 1, '只开句式信号也应检测出段')
})

test('detectAdSegmentsCore：sub-patterns 句式门槛 ≥2 命中（1 条不够）', () => {
  const transcript = [{ from: 5, content: '点击下方链接' }]
  const segs = detectAdSegmentsCore(
    { danmaku: [], duration: 300, transcript },
    DEFAULT_KEYWORDS,
    ['sub-patterns'],
  )
  assert.deepEqual(segs, [])
})
