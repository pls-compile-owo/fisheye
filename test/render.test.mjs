// test/render.test.mjs — visualRequest / 低置信拼图 / costEstimate 一致性 / 旧 manifest 拒绝
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildVisualRequest, visualTrackConfig, PER_IMAGE } from '../lib/auto-text.mjs'
import { stageRender } from '../lib/render.mjs'
import { OUT } from '../lib/env.mjs'

function seg(i, needsFrames, lowActivity = false) {
  return { i, from: i * 240, to: (i + 1) * 240, needsFrames, lowActivity, subs: null, danmaku: null }
}

test('buildVisualRequest：无 needsFrames 段 → null', () => {
  const r = buildVisualRequest([seg(0, false), seg(1, false)])
  assert.equal(r, null)
})

test('buildVisualRequest：两源低置信 → 标记 coarse 兜底 + costEstimate 一致', () => {
  const r = buildVisualRequest([seg(0, true), seg(1, true)], null, 'ask', PER_IMAGE)
  assert.ok(r)
  assert.equal(r.reason, 'no-subs-no-danmaku')
  assert.equal(r.type, null) // fast 档无类型
  assert.equal(r.suggestedTrack, 'coarse')
  assert.equal(r.suggestedFrames, 2) // 2 个 needsFrames 段
  assert.equal(r.costEstimate, 2 * 1024) // 帧数 × 1024，与报价单一致
  assert.deepEqual(r.segments, [0, 1])
})

test('buildVisualRequest：有类型且 confidence≥0.7 → 建议 adaptive', () => {
  const typeInfo = { type: 'slides', confidence: 0.8 }
  const r = buildVisualRequest([seg(0, true)], typeInfo, 'ask', PER_IMAGE)
  assert.equal(r.suggestedTrack, 'adaptive')
  assert.equal(r.type, 'slides')
  assert.ok(r.costEstimate > 0)
})

test('buildVisualRequest：visualTrack=off → null（永不开启）', () => {
  const r = buildVisualRequest([seg(0, true)], null, 'off', PER_IMAGE)
  assert.equal(r, null)
})

test('visualTrackConfig：默认 ask，非法值回退 ask', () => {
  assert.equal(visualTrackConfig(), 'ask')
})

test('costEstimate 恒为帧数 × 1024（PER_IMAGE）', () => {
  const typeInfo = { type: 'music', confidence: 0.9 }
  const r = buildVisualRequest([seg(0, true), seg(1, true), seg(2, true)], typeInfo, 'on', PER_IMAGE)
  assert.equal(r.costEstimate, r.suggestedFrames * PER_IMAGE)
})

test('render：旧 manifest（schemaVersion 1）被拒绝并提示重跑（第 3 批验收）', async () => {
  const id = 'old-bv-test'
  // 旧 manifest（1.0.29 standard 产物，version: 1，无 schemaVersion）
  fs.writeFileSync(path.join(OUT, `${id}-manifest.json`), JSON.stringify({ version: 1, bvid: id, adSegments: [] }))
  fs.writeFileSync(path.join(OUT, `${id}-plan.json`), '[]')
  try {
    const source = { id, async media() { return 'fake.mp4' }, async meta() { return { duration: 240 } } }
    await assert.rejects(() => stageRender(source, {}), /旧 manifest.*重跑/)
  } finally {
    fs.rmSync(path.join(OUT, `${id}-manifest.json`), { force: true })
    fs.rmSync(path.join(OUT, `${id}-plan.json`), { force: true })
  }
})
