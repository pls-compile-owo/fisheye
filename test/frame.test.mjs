// frame 模块单测：广告剔除 / 取帧时间点选择（纯函数部分）
import test from 'node:test'
import assert from 'node:assert/strict'
import { subtractAds, pickTimes } from '../lib/frame.mjs'

test('subtractAds：无广告返回整段', () => {
  assert.deepEqual(subtractAds(0, 100, []), [{ a: 0, b: 100 }])
})

test('subtractAds：中间广告被剔除', () => {
  const out = subtractAds(0, 100, [{ from: 40, to: 60 }])
  assert.deepEqual(out, [{ a: 0, b: 40 }, { a: 60, b: 100 }])
})

test('subtractAds：整段都是广告 → 空', () => {
  assert.deepEqual(subtractAds(0, 100, [{ from: -5, to: 105 }]), [])
})

test('pickTimes：返回 n 个递增时间点', () => {
  const r = pickTimes(0, 100, 9, [], [])
  assert.ok(r && Array.isArray(r.times))
  assert.equal(r.times.length, 9)
  for (let i = 1; i < r.times.length; i++) assert.ok(r.times[i] > r.times[i - 1])
  for (const t of r.times) assert.ok(t >= 0 && t <= 100)
})

test('pickTimes：时间点不落在广告段内', () => {
  const r = pickTimes(0, 100, 9, [], [{ from: 20, to: 80 }])
  assert.ok(r && Array.isArray(r.times))
  for (const t of r.times) assert.ok(t <= 20 || t >= 80, `time ${t} 落在广告段内部`)
})

test('pickTimes：整段广告返回 null', () => {
  assert.equal(pickTimes(0, 100, 9, [], [{ from: -1, to: 101 }]), null)
})
