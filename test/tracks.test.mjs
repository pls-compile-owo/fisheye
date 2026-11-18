// test/tracks.test.mjs — 画面三轨（单档吸附 / w=0.3 降权 / 帧时间）
import test from 'node:test'
import assert from 'node:assert/strict'
import { weightSegments, pickTimesSingle, trackFrameTimes } from '../lib/tracks.mjs'

test('weightSegments：低活跃段降权 w=0.3，内容段 w=1', () => {
  const segs = weightSegments(0, 240, [{ from: 60, to: 120 }], 0.3)
  // 60-120 是低活跃（w=0.3），其余 w=1
  assert.equal(segs.length, 3)
  assert.deepEqual(segs[0], { a: 0, b: 60, w: 1 })
  assert.equal(segs[1].a, 60)
  assert.equal(segs[1].b, 120)
  assert.ok(Math.abs(segs[1].w - 0.3) < 1e-9)
  assert.equal(segs[2].w, 1)
})

test('pickTimesSingle：单档吸附 0.3，低活跃段帧变稀', () => {
  // 无变化点 → 等间隔骨架；有低活跃段 → 那段分到的帧少
  const scenes = [{ t: 10, score: 0.5 }, { t: 130, score: 0.6 }]
  const r = pickTimesSingle(0, 240, 9, scenes, [{ from: 60, to: 180 }], 0.3, 0.3)
  assert.equal(r.times.length, 9)
  // 吸附：10s 和 130s 附近有变化点，应吸过去
  assert.ok(r.snapped >= 1, `应有吸附，实际 snapped=${r.snapped}`)
})

test('pickTimesSingle：变化点稀疏时 0.3 吸附不足，仍返回 9 帧（等间隔兜底）', () => {
  const r = pickTimesSingle(0, 240, 9, [], [], 0.3, 0.3)
  assert.equal(r.times.length, 9)
  assert.equal(r.snapped, 0)
})

test('trackFrameTimes coarse：4 分钟/帧，不吸附不降权', () => {
  const times = trackFrameTimes('coarse', { from: 0, to: 2400, n: 9 })
  assert.ok(times.length >= 9)
  assert.equal(times.length, 10) // 2400/240 = 10 帧
  // 等间隔：相邻帧差 240s
  for (let i = 1; i < times.length; i++) assert.ok(Math.abs(times[i] - times[i - 1] - 240) < 0.01)
})

test('trackFrameTimes algorithm：等间隔 + 单档吸附', () => {
  const scenes = [{ t: 100, score: 0.5 }]
  const times = trackFrameTimes('algorithm', { from: 0, to: 240, n: 9, scenes, lowSegs: [] })
  assert.equal(times.length, 9)
  // 100s 附近有变化点，应被吸附
  assert.ok(times.some((t) => Math.abs(t - 100) < 30), '应有帧吸附到 100s 附近')
})

test('trackFrameTimes adaptive：按类型密度（screen 45s/帧）', () => {
  const times = trackFrameTimes('adaptive', { from: 0, to: 240, n: 9, scenes: [], type: 'screen' })
  assert.ok(times.length >= 4)
  assert.ok(times.length <= 6) // 240/45 ≈ 5 帧
})

test('trackFrameTimes：未知 track 返回空', () => {
  assert.deepEqual(trackFrameTimes('nope', { from: 0, to: 240 }), [])
})
