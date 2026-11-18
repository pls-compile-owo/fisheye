// test/segments.test.mjs — 段卡片（4 分钟切段 + 证据并置 + needsFrames）
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSegments } from '../lib/segments.mjs'

const subsLines = []
for (let i = 0; i < 60; i++) {
  subsLines.push({ from: i * 30, content: `第${i}句：苏联农业与粮食问题 ${i % 10 === 0 ? '所以这就是结论' : ''}` })
}
const danmaku = []
for (let i = 0; i < 100; i++) danmaku.push({ t: i * 6, text: i % 5 === 0 ? '哈哈哈' : '讲得不错' })

test('makeSegments：40 分钟 → 10 段', () => {
  const { segments } = makeSegments({ duration: 2400, segSec: 240, subsLines, danmaku })
  assert.equal(segments.length, 10)
  assert.equal(segments[0].from, 0)
  assert.equal(segments[0].to, 240)
  assert.equal(segments[0].dur, 240)
})

test('段卡片结构：subs 带秒级时间戳、danmaku 带情绪、frames 带成本', () => {
  const { segments } = makeSegments({ duration: 2400, subsLines, danmaku })
  const s = segments[0]
  assert.ok(s.subs, '有字幕骨架')
  assert.ok(s.subs.head && typeof s.subs.head.t === 'number' && s.subs.head.text, 'head 带 {t, text}')
  assert.ok(Array.isArray(s.subs.keywords))
  assert.ok(s.danmaku, '有弹幕情绪')
  assert.equal(typeof s.danmaku.emotion.value, 'number')
  assert.ok(s.frames.coarse.cost > 0, 'frames 有成本')
})

test('adKeywordHits 同段并置', () => {
  const hits = [{ t: 100, text: '已下单' }, { t: 500, text: '已下单' }]
  const { segments } = makeSegments({ duration: 2400, subsLines, danmaku, adKeywordHits: hits })
  assert.equal(segments[0].adKeywordHits.length, 1)
  assert.equal(segments[2].adKeywordHits.length, 1)
})

test('lowActivity 映射到段', () => {
  const low = [{ from: 0, to: 200, lowDensity: 0.6 }]
  const { segments } = makeSegments({ duration: 2400, subsLines, danmaku, lowActivitySegs: low })
  assert.equal(segments[0].lowActivity, true)
  assert.equal(segments[1].lowActivity, false)
})

test('needsFrames：字幕+弹幕都低置信时 true', () => {
  // 无字幕 + 无弹幕 → 两源都低置信
  const { segments } = makeSegments({ duration: 2400 })
  assert.equal(segments[0].needsFrames, true)
  assert.equal(segments[0].subs, null)
  assert.equal(segments[0].danmaku, null)
})

test('弹幕情绪 level：跨段中位数 + 绝对下限', () => {
  // 前段情绪弹幕密集，后段几乎没有 → 前段 level 应更高
  const dm = []
  for (let i = 0; i < 200; i++) dm.push({ t: i * 2 + 10, text: i < 100 ? '哈哈哈' : '平淡' })
  const { segments } = makeSegments({ duration: 480, segSec: 240, subsLines, danmaku: dm })
  const lv0 = segments[0].danmaku?.emotion.level
  const lv1 = segments[1].danmaku?.emotion.level
  assert.ok(lv0 && lv1, '两段都应有情绪 level')
})

test('textTokens：只读文本成本有估算且 >0', () => {
  const { textTokens } = makeSegments({ duration: 2400, subsLines, danmaku })
  assert.ok(textTokens > 0)
  assert.ok(textTokens < 3000, `40 分钟字幕摘要应 ≤3k token，实际 ${textTokens}`)
})
