// 分区词库测试：resolveKeywords 的字段级覆盖 + 分区降级端到端效果。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_KEYWORDS, detectAdSegmentsCore } from '../lib/danmaku.mjs'
import { resolveKeywords, PARTITION_OVERRIDES, TID_V2_PARTITION } from '../lib/signals/partitions.mjs'

test('resolveKeywords：未知 tid_v2 返回 DEFAULT_KEYWORDS（零回归）', () => {
  assert.equal(resolveKeywords(undefined), DEFAULT_KEYWORDS)
  assert.equal(resolveKeywords(999999), DEFAULT_KEYWORDS)
  assert.equal(resolveKeywords('不存在的分区'), DEFAULT_KEYWORDS)
})

test('resolveKeywords：字段级覆盖——只改 ad，其余字段沿用默认', () => {
  const tech = resolveKeywords(2100) // 科技
  assert.notEqual(tech.ad, DEFAULT_KEYWORDS.ad, '科技区 ad 词表应被覆盖')
  assert.equal(tech.strong, DEFAULT_KEYWORDS.strong)
  assert.equal(tech.mark, DEFAULT_KEYWORDS.mark)
  assert.equal(tech.buy, DEFAULT_KEYWORDS.buy)
  assert.equal(tech.sub, DEFAULT_KEYWORDS.sub)
  assert.equal(tech.pattern, DEFAULT_KEYWORDS.pattern)
})

test('分区覆盖词表：科技区去掉「商单/赞助/下单」，保留「金主/接广」', () => {
  const tech = resolveKeywords(2100)
  assert.equal(tech.ad.test('一加商单'), false, '科技区「商单」应降级')
  assert.equal(tech.ad.test('我个人赞助了5台'), false, '科技区「赞助」应降级')
  assert.equal(tech.ad.test('马上下单'), false, '科技区「下单」应降级')
  assert.equal(tech.ad.test('感谢金主'), true, '科技区「金主」应保留')
  assert.equal(tech.ad.test('恭喜接广'), true, '科技区「接广」应保留')
})

test('分区覆盖词表：汽车区去掉「赞助」，保留「下单/商单」', () => {
  const car = resolveKeywords(2107)
  assert.equal(car.ad.test('啤酒赞助汽车运动'), false, '汽车区「赞助」应降级')
  assert.equal(car.ad.test('已下单'), true, '汽车区「下单」应保留')
  assert.equal(car.ad.test('商单'), true, '汽车区「商单」应保留')
})

test('端到端：科技区「一加商单 + 火星人下单」默认词库命中、分区词库不命中', () => {
  const danmaku = [
    { t: 100, text: '一加商单' },
    { t: 115, text: '火星人下单' },
  ]
  const segsDefault = detectAdSegmentsCore(
    { danmaku, duration: 300 }, DEFAULT_KEYWORDS, ['danmaku-keywords'])
  const segsTech = detectAdSegmentsCore(
    { danmaku, duration: 300 }, resolveKeywords(2100), ['danmaku-keywords'])
  assert.ok(segsDefault.length >= 1, '默认词库应命中（商单/下单 都在）')
  assert.deepEqual(segsTech, [], '科技区词库应不命中（商单/下单 已降级）')
})

test('分区映射完整性：样本覆盖的 6 个粗分区都能命中', () => {
  const found = new Set(Object.values(TID_V2_PARTITION))
  for (const p of ['知识', '科技', '汽车', '美食', '生活', '影视']) {
    assert.ok(found.has(p), `缺分区 ${p}`)
  }
})

test('只降级需要降级的分区：科技/汽车有覆盖，其余走默认词库', () => {
  assert.ok(PARTITION_OVERRIDES['科技'], '科技区应有覆盖词库')
  assert.ok(PARTITION_OVERRIDES['汽车'], '汽车区应有覆盖词库')
  // 知识/美食/生活/影视 无需降级 → resolveKeywords 返回 DEFAULT_KEYWORDS
  for (const p of ['知识', '美食', '生活', '影视']) {
    const tid = Object.keys(TID_V2_PARTITION).find((k) => TID_V2_PARTITION[k] === p)
    assert.ok(tid, `分区 ${p} 缺映射`)
    assert.equal(resolveKeywords(tid), DEFAULT_KEYWORDS, `${p} 不应有降级词库`)
  }
})
