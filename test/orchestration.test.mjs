// 编排层测试：collectSignals 采集契约 + stageAuto 分支行为。
// 用 mock 平台 source + 临时生成的假视频（需要 ffmpeg；没有则 skip，不影响 CI 主套件）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../lib/env.mjs'
import { collectSignals, detectLowActivityFor } from '../lib/collect.mjs'

// 生成一个 3 秒、64x64 的测试视频（无字幕、无音轨）
function makeFakeVideo() {
  if (!FFMPEG) return null
  const file = path.join(os.tmpdir(), `fisheye-orchestration-${process.pid}.mp4`)
  if (fs.existsSync(file)) return file
  const r = spawnSync(FFMPEG, ['-hide_banner', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=64x64:rate=5', '-pix_fmt', 'yuv420p', '-y', file], { stdio: 'ignore', timeout: 30000 })
  return r.status === 0 && fs.existsSync(file) ? file : null
}

function mockSource(overrides = {}) {
  const file = makeFakeVideo()
  return {
    id: 'test-src', kind: 'local', label: 'fake.mp4',
    async meta() {
      return {
        title: 'fake', duration: 3, owner: null, dimension: { width: 64, height: 64 },
        pages: [{ cid: null, duration: 3, part: '' }],
      }
    },
    async media() { return file },
    async subtitles() { return null },
    async danmaku() { return [{ t: 1, text: '666' }, { t: 2, text: '哈哈' }] },
    adDetector: null,
    ...overrides,
  }
}

const video = makeFakeVideo()
const skip = video ? false : '本地没有 ffmpeg，跳过编排集成测试'

test('collectSignals：无字幕无弹幕的本地视频——基础 ctx 字段齐全', { skip }, async () => {
  const ctx = await collectSignals(mockSource(), {})
  assert.equal(ctx.fullDuration, 3)
  assert.equal(ctx.duration, 3)
  assert.equal(ctx.range, null)
  assert.equal(ctx.official, null)
  assert.equal(ctx.transcript, '')
  assert.equal(ctx.hasSubs, false)          // 64x64 无字幕假视频：detectBand（纯 JS）检不出字幕带
  assert.ok(Array.isArray(ctx.scenes))
  assert.ok(Array.isArray(ctx.danmaku))
  assert.ok(Array.isArray(ctx.dmHot))
  assert.ok(Array.isArray(ctx.lowActivitySegs))
  assert.ok(Array.isArray(ctx.adHits))
  assert.equal(ctx.pageNo, 1)
})

test('collectSignals：有官方字幕时 official 生效、不再走字幕带', { skip }, async () => {
  const subs = {
    quality: 'ok', chars: 10, lines: 2, lanDoc: '中文',
    txt: path.join(os.tmpdir(), 'x.txt'), plain: path.join(os.tmpdir(), 'y.txt'),
    head: ['[00:01] 你好'], body: [{ from: 1, content: '你好' }],
  }
  const ctx = await collectSignals(mockSource({ subtitles: async () => subs }), {})
  assert.ok(ctx.official)
  assert.equal(ctx.official.quality, 'ok')
  assert.equal(ctx.hasSubs, false) // 有官方字幕就不烧字幕带
})

test('collectSignals：官方字幕质量差（noisy）时 official 为 null', { skip }, async () => {
  const subs = { quality: 'noisy', chars: 5, lines: 3, avgEff: 0.5, uniqueRatio: 0.2, txt: 'x', head: [], body: [] }
  const ctx = await collectSignals(mockSource({ subtitles: async () => subs }), {})
  assert.equal(ctx.official, null)
})

test('collectSignals：--from 超出时长抛错', { skip }, async () => {
  await assert.rejects(() => collectSignals(mockSource(), { from: 999 }), /超出视频时长/)
})

test('collectSignals：--to <= --from 抛错', { skip }, async () => {
  await assert.rejects(() => collectSignals(mockSource(), { from: 2, to: 2 }), /必须大于/)
})

test('collectSignals：合法区间生成 range 与区间时长', { skip }, async () => {
  const ctx = await collectSignals(mockSource(), { from: 1, to: 3 })
  assert.deepEqual(ctx.range, { from: 1, to: 3 })
  assert.equal(ctx.duration, 2)
})

test('detectLowActivityFor：adDetector 为 null 时不判', async () => {
  const segs = await detectLowActivityFor({ adDetector: null }, { danmaku: [], duration: 100 })
  assert.deepEqual(segs, [])
})

test('detectLowActivityFor：自定义 detect 函数会被调用', async () => {
  const fake = [{ from: 10, to: 20, ts: '00:10-00:20', dur: 10, lowDensity: true, sample: [] }]
  const segs = await detectLowActivityFor(
    { adDetector: { detect: async () => fake } },
    { danmaku: [], duration: 100 }
  )
  assert.deepEqual(segs, fake)
})

test('detectLowActivityFor：无自定义 detect 时走核心密度低谷（无弹幕 → 空）', async () => {
  const segs = await detectLowActivityFor(
    { adDetector: { adKeywords: /金主/ } },
    { danmaku: [], duration: 100 }
  )
  assert.deepEqual(segs, [])
})
