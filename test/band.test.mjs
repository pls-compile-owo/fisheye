// band 模块单测：字幕带定位的纯 JS 数值工具 + PGM 解析（不依赖 ffmpeg/python）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { percentile, smooth3, readPgm, rowGradientProfile, analyzeProfiles } from '../lib/band.mjs'

test('percentile：numpy linear 插值', () => {
  assert.equal(percentile([1, 2, 3, 4], 0), 1)
  assert.equal(percentile([1, 2, 3, 4], 25), 1.75)
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5)
  assert.equal(percentile([1, 2, 3, 4], 100), 4)
  assert.equal(percentile([5], 50), 5) // 单元素
  assert.equal(percentile([], 50), 0) // 空数组
})

test('smooth3：中心滑动平均 + 边界少一点仍除以 3（numpy convolve same）', () => {
  // y[0]=(1+2)/3=1, y[1]=(1+2+3)/3=2, y[2]=3, y[3]=4, y[4]=(4+5)/3=3
  assert.deepEqual(Array.from(smooth3([1, 2, 3, 4, 5])), [1, 2, 3, 4, 3])
  // L<=3 时原样返回
  assert.deepEqual(Array.from(smooth3([1, 2, 3])), [1, 2, 3])
})

test('readPgm：解析 P5 灰度 PGM', () => {
  const header = Buffer.from('P5\n2 2\n255\n', 'latin1')
  const pixels = Buffer.from([0, 127, 128, 255])
  const r = readPgm(Buffer.concat([header, pixels]))
  assert.equal(r.w, 2)
  assert.equal(r.h, 2)
  assert.deepEqual(Array.from(r.gray), [0, 127, 128, 255])
})

test('readPgm：非 P5 / 16bit 返回 null', () => {
  assert.equal(readPgm(Buffer.from('P4\n1 1\n255\n\x00', 'latin1')), null)
  assert.equal(readPgm(Buffer.from('P5\n1 1\n65535\n', 'latin1')), null)
})

test('rowGradientProfile：均匀灰度梯度为 0，阶梯梯度非 0', () => {
  const flat = new Uint8Array(16).fill(100)
  const p1 = rowGradientProfile(flat, 4, 4, 2) // 从第 2 行开始，长度 2
  assert.equal(p1.length, 2)
  assert.equal(p1[0], 0)
  assert.equal(p1[1], 0)

  const step = new Uint8Array(16)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) step[y * 4 + x] = x >= 2 ? 255 : 0
  const p2 = rowGradientProfile(step, 4, 4, 0)
  // 每行 [0,0,255,255]：diff abs = [0,255,0]，mean = 255/3 = 85
  assert.equal(p2[0], 85)
})

test('analyzeProfiles：无帧返回失败', () => {
  assert.equal(analyzeProfiles([], 720).ok, false)
})

test('analyzeProfiles：构造带明显字幕带的 profile 能定位', () => {
  const H = 100
  const y0 = Math.floor(H * 0.55) // 55
  const L = H - y0 // 45
  const profiles = []
  for (let f = 0; f < 3; f++) {
    const prof = new Float64Array(L)
    for (let i = 0; i < L; i++) prof[i] = (i >= 28 && i <= 34) ? 5.0 : 0.1
    profiles.push(prof)
  }
  const r = analyzeProfiles(profiles, H)
  assert.equal(r.ok, true)
  assert.equal(r.videoH, 100)
  assert.equal(r.frames, 3)
  // 字幕带应在 y0+28~y0+34 附近（约 83~89），留 5px 容差
  assert.ok(r.region.top >= 78 && r.region.top <= 90, `top=${r.region.top}`)
  assert.ok(r.region.bottom >= 85 && r.region.bottom <= 95, `bottom=${r.region.bottom}`)
  assert.equal(r.confidence, 1) // 每帧字幕带都明显强于背景
})
