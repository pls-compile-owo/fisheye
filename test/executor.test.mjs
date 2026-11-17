// executor 单测：几何挑点与精读建议（纯函数，不碰文件系统）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { geometricPick, buildSuggestions, MIN_READABLE_SUBS_PX } from '../lib/executor.mjs'

// 造一个最小 manifest：1 张拼图 9 格，1 个高 scene 格 + 1 个弹幕热区
function makeManifest(overrides = {}) {
  return {
    bvid: 'BV1test',
    title: 'test',
    videoWidth: 1920,
    videoHeight: 1080,
    sheetWidth: 1920,
    subsCovered: true,
    subs: null,
    danmaku: { hot: [{ start: 100, count: 5, samples: ['a', 'b'] }] },
    adSegments: [],
    chunks: [{
      chunk: 1,
      grid: '3x3',
      cells: Array.from({ length: 9 }, (_, i) => ({
        cell: i + 1,
        t: i * 10,
        ts: `00:${String(i * 10).padStart(2, '0')}`,
        scene: i === 3 ? 0.9 : 0.1,
      })),
    }],
    ...overrides,
  }
}

test('geometricPick：高变化格与弹幕热区都入选', () => {
  const picks = geometricPick(makeManifest())
  assert.ok(picks.some((p) => p.source.includes('弹幕热区')), '应有弹幕热区')
  assert.ok(picks.some((p) => p.source.includes('几何规则')), '应有几何规则')
  // 按时间排序
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i].t >= picks[i - 1].t)
})

test('geometricPick：高置信度广告段被排除', () => {
  const manifest = makeManifest({
    adSegments: [{ from: 30, to: 40, confidence: 'high' }],
  })
  const picks = geometricPick(manifest)
  // cell 4 在 t=30（广告段内）→ 不应出现
  assert.ok(!picks.some((p) => Math.round(p.t) >= 30 && Math.round(p.t) <= 40 && p.source.includes('几何规则')))
})

test('geometricPick：最多 8 个点', () => {
  const many = makeManifest()
  many.chunks = [many.chunks[0], { chunk: 2, grid: '3x3', cells: many.chunks[0].cells.map((c) => ({ ...c, t: c.t + 100 })) }]
  assert.ok(geometricPick(many).length <= 8)
})

test('buildSuggestions：几何 + 弹幕热区合并、按时间排序、去重', () => {
  const { geo, dmPicks, suggestions } = buildSuggestions(makeManifest(), [
    { start: 100, count: 5, samples: ['x'] },
  ])
  assert.ok(geo.length > 0)
  assert.equal(dmPicks.length, 1)
  for (let i = 1; i < suggestions.length; i++) assert.ok(suggestions[i].t >= suggestions[i - 1].t)
  const keys = suggestions.map((s) => Math.round(s.t))
  assert.equal(new Set(keys).size, keys.length, '按秒去重')
})

test('buildSuggestions：无热区时只返回几何点', () => {
  const { geo, dmPicks, suggestions } = buildSuggestions(makeManifest(), [])
  assert.equal(dmPicks.length, 0)
  assert.equal(suggestions.length, geo.length)
})

test('MIN_READABLE_SUBS_PX 导出为 12', () => {
  assert.equal(MIN_READABLE_SUBS_PX, 12)
})

// 字幕糊分支：拼图里字幕像素低于 12px 且字幕未被覆盖 → 该帧值得精读（核心价值分支）
test('geometricPick：字幕在拼图里糊掉且未被覆盖时，建议精读', () => {
  // sheetWidth 小 → cellW≈93px → scale≈0.0485 → 字幕高度 0.22*1080*0.0485 ≈ 11.5px < 12px
  const manifest = makeManifest({
    videoWidth: 1920,
    videoHeight: 1080,
    sheetWidth: 280,
    subs: { top: 0.78, bottom: 1.0 },
    subsCovered: false,
  })
  const picks = geometricPick(manifest)
  assert.ok(picks.some((p) => p.reason.includes('字幕在拼图里只剩')), '应给出字幕糊的精读理由')
})

test('geometricPick：字幕已覆盖（官方文本/转写）时，不为字幕糊建议精读', () => {
  const manifest = makeManifest({
    videoWidth: 1920,
    videoHeight: 1080,
    sheetWidth: 280,
    subs: { top: 0.78, bottom: 1.0 },
    subsCovered: true,   // 字幕已到手，不必为糊掉的字幕花原图成本
  })
  const picks = geometricPick(manifest)
  assert.ok(!picks.some((p) => p.reason.includes('字幕在拼图里只剩')), '字幕已覆盖时不应有字幕糊理由')
})
