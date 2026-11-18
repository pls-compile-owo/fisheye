// test/video-type.test.mjs — 视频类型判定（四类 + fast null 语义）
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectVideoType } from '../lib/video-type.mjs'

test('fast 档：changeRate=null → type null + reason（不是 unknown）', () => {
  const r = detectVideoType({ changeRate: null })
  assert.equal(r.type, null)
  assert.equal(r.confidence, 0)
  assert.match(r.reason, /changeRate unavailable/)
})

test('music：♪ 歌词多 + 变化率 >1.2 + 弹幕少', () => {
  const r = detectVideoType({ changeRate: 1.5, subsMusicRatio: 0.8, danmakuCount: 10, subsLang: 'zh' })
  assert.equal(r.type, 'music')
  assert.ok(r.confidence > 0)
})

test('slides：变化率 <0.05 + 字幕少', () => {
  const r = detectVideoType({ changeRate: 0.02, subsChars: 50, subsMusicRatio: 0, danmakuCount: 100, subsLang: 'zh' })
  assert.equal(r.type, 'slides')
})

test('screen：无音频流', () => {
  const r = detectVideoType({ changeRate: 0.3, subsChars: 500, subsMusicRatio: 0, danmakuCount: 100, hasAudio: false, subsLang: 'zh' })
  assert.equal(r.type, 'screen')
})

test('foreign：非中文 + 无翻译轨', () => {
  const r = detectVideoType({ changeRate: 0.3, subsChars: 500, subsMusicRatio: 0, danmakuCount: 100, subsLang: 'en', hasTranslated: false })
  assert.equal(r.type, 'foreign')
})

test('unknown：四类都不中', () => {
  const r = detectVideoType({ changeRate: 0.5, subsChars: 1000, subsMusicRatio: 0, danmakuCount: 500, subsLang: 'zh', hasTranslated: true })
  assert.equal(r.type, 'unknown')
  assert.equal(r.confidence, 0)
})

test('evidence：带判据命中明细', () => {
  const r = detectVideoType({ changeRate: 1.5, subsMusicRatio: 0.8, danmakuCount: 10, subsLang: 'zh' })
  assert.ok(r.evidence.hits, '应有 hits 明细')
  assert.ok(r.evidence.hits.music >= 1)
})

test('foreign：中文 + 无翻译轨 → 不误报 foreign（P1-② 回归）', () => {
  // 最常见场景：中文视频 + 无翻译轨，不应因「无翻译」独立累加误判 foreign
  const r = detectVideoType({ changeRate: 0.3, subsChars: 1000, subsMusicRatio: 0, danmakuCount: 500, subsLang: 'zh', hasTranslated: false })
  assert.notEqual(r.type, 'foreign', '中文+无翻译不应判 foreign')
  assert.equal(r.evidence.hits.foreign, 0)
})

test('缺失值（null）不触发判据（P1-① 回归）', () => {
  // 只有 changeRate 真实，其余元数据缺失（null）→ 不因缺失硬编码误判
  const r = detectVideoType({ changeRate: 0.3 })
  assert.equal(r.evidence.hits.screen, 0, 'hasAudio null 不应触发 screen')
  assert.equal(r.evidence.hits.music, 0, 'danmakuCount/subsMusicRatio null 不应触发 music')
  assert.equal(r.evidence.hits.slides, 0, 'subsChars null 不应触发 slides')
})
