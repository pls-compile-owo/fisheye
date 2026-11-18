// test/emotion.test.mjs — 情绪双分数（√压缩 / suspect / 词表分层 / level）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  danmakuEmotion, subsEmotion, emotionLevel, hasOpinion, EMOTION_RE,
} from '../lib/emotion.mjs'

test('danmakuEmotion：无弹幕 → null（不是 0）', () => {
  assert.equal(danmakuEmotion([]), null)
  assert.equal(danmakuEmotion(null), null)
})

test('danmakuEmotion：√压缩刷屏（同文本 4 次贡献 2 而非 4）', () => {
  const dm = [
    { t: 0, text: '哈哈哈' }, { t: 1, text: '哈哈哈' },
    { t: 2, text: '哈哈哈' }, { t: 3, text: '哈哈哈' },
    { t: 4, text: '讲得好' },
  ]
  const r = danmakuEmotion(dm)
  // 分子 = √4 = 2；分母 = 5；value = 0.4
  assert.equal(r.value, 0.4)
  assert.equal(r.samples, 5)
  assert.equal(r.unique, 2)
})

test('danmakuEmotion：重复度高 → suspect spam-heavy', () => {
  const dm = []
  for (let i = 0; i < 20; i++) dm.push({ t: i, text: i < 15 ? '哈哈哈' : `正常弹幕${i}` })
  const r = danmakuEmotion(dm)
  assert.ok(r.dupRatio > 0.4)
  assert.equal(r.suspect, 'spam-heavy')
})

test('danmakuEmotion：样本量 <20 → confidence low', () => {
  const dm = [{ t: 0, text: '哈哈哈' }, { t: 1, text: '笑了' }]
  const r = danmakuEmotion(dm)
  assert.equal(r.confidence, 'low')
})

test('danmakuEmotion：top 给 3 条去重后的情绪弹幕原文', () => {
  const dm = [
    { t: 0, text: '哈哈哈' }, { t: 1, text: '哈哈哈' },
    { t: 2, text: '笑死' }, { t: 3, text: '泪目' },
  ]
  const r = danmakuEmotion(dm)
  assert.ok(r.top.length >= 1)
  assert.ok(r.top.length <= 3)
  assert.ok(new Set(r.top.map((x) => x.text)).size === r.top.length, 'top 不应重复')
})

test('subsEmotion：情绪句占比 + top 原文', () => {
  const lines = [
    { from: 0, content: '讲苏联农业' },
    { from: 1, content: '哈哈哈哈笑死' },
    { from: 2, content: '这也太离谱了' },
  ]
  const r = subsEmotion(lines)
  assert.ok(r.value > 0)
  assert.equal(r.samples, 3)
})

test('hasOpinion：草/牛 需非汉字边界（草原/牛顿不误报）', () => {
  assert.equal(hasOpinion('牛啊'), true)
  assert.equal(hasOpinion('草原'), false)
  assert.equal(hasOpinion('牛顿'), false)
  assert.equal(hasOpinion('这属于是离谱了'), true)
})

test('emotionLevel：分位数 + 绝对下限（全片平坦时全判 low）', () => {
  const median = 0.05
  const floor = 0.08
  assert.equal(emotionLevel(0.1, median, floor), 'high')  // > median 且 > floor
  assert.equal(emotionLevel(0.06, median, floor), 'low')  // > median 但 < floor
  assert.equal(emotionLevel(0.04, median, floor), 'low')  // < median
})
