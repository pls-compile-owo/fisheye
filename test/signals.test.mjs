// test/signals.test.mjs — 两路信号（低活跃检测 + 广告词高光）
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectLowActivity, adKeywordHits, AD_KEYWORD } from '../lib/danmaku.mjs'

// 构造一条 600s 视频的弹幕：中段（200-300s）密度明显低于其它段
function makeDanmaku() {
  const dm = []
  for (let t = 0; t < 600; t += 1) {
    if (t >= 200 && t < 300) continue // 200-300s 低活跃（无弹幕）
    dm.push({ t, text: `弹幕 ${t}` })
  }
  return dm
}

test('detectLowActivity：空 / 短视频返回空', () => {
  assert.deepEqual(detectLowActivity([], 300), [])
  assert.deepEqual(detectLowActivity([{ t: 1, text: 'x' }], 60), [])
})

test('detectLowActivity：密度低谷段被检出（含 sample 证据）', () => {
  const segs = detectLowActivity(makeDanmaku(), 600)
  assert.ok(segs.length >= 1, '应有低活跃段')
  const seg = segs[0]
  // 低活跃段应覆盖 200-300s 的无弹幕区间（扩展 ±15s 后边界略外扩）
  assert.ok(seg.from <= 200 && seg.to >= 300, `低活跃段应覆盖 200-300 无弹幕区间，实际 ${seg.from}-${seg.to}`)
  assert.equal(seg.lowDensity, true)
  assert.ok(Array.isArray(seg.sample), 'sample 应为数组（结论配证据）')
  assert.ok(seg.dur >= 45, '低活跃段应 ≥45s')
})

test('adKeywordHits：匹配广告词 + 去重 + 限量', () => {
  const dm = [
    { t: 10, text: '感谢金主' },
    { t: 20, text: '感谢金主' }, // 重复 → 去重
    { t: 30, text: '这期恰饭了' },
    { t: 40, text: '正常弹幕' },
  ]
  const hits = adKeywordHits(dm)
  assert.equal(hits.length, 2, '应去重（感谢金主只留一条）')
  assert.equal(hits[0].text, '感谢金主')
})

test('adKeywordHits：限量 50 条', () => {
  const dm = []
  for (let i = 0; i < 100; i++) dm.push({ t: i, text: `下单 ${i}` })
  const hits = adKeywordHits(dm)
  assert.equal(hits.length, 50)
})

test('adKeywordHits：自定义 adKeyword（平台专属词）', () => {
  const dm = [{ t: 5, text: '鱼油欧米伽三' }]
  assert.equal(adKeywordHits(dm).length, 0, '默认词表不含鱼油')
  assert.equal(adKeywordHits(dm, /鱼油|欧米伽/).length, 1, '自定义词表应命中')
})

test('AD_KEYWORD：导出且为正则', () => {
  assert.ok(AD_KEYWORD instanceof RegExp)
  assert.ok(AD_KEYWORD.test('感谢金主'))
})
