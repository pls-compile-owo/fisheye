// test/auto-text.test.mjs — 字幕降级链（四级：翻译轨 → 原文轨 → 转写 → 字幕带）单测
import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSubsLines, buildEvidence, PER_IMAGE } from '../lib/auto-text.mjs'

// ── selectSubsLines：文本三级降级链 ─────────────────────────────────
test('selectSubsLines：有中文翻译轨 → official-translated / zh', () => {
  const official = { lan: 'en', body: [{ from: 0, content: 'hello' }], translated: { body: [{ from: 0, content: '你好' }] } }
  const r = selectSubsLines(official, null)
  assert.equal(r.source, 'official-translated')
  assert.equal(r.lang, 'zh')
  assert.equal(r.lines, official.translated.body)
})

test('selectSubsLines：无翻译轨有原文 → official / lan', () => {
  const official = { lan: 'en', body: [{ from: 0, content: 'hello' }], translated: null }
  const r = selectSubsLines(official, null)
  assert.equal(r.source, 'official')
  assert.equal(r.lang, 'en')
  assert.equal(r.lines, official.body)
})

test('selectSubsLines：无官方有转写 → transcript / audioLang', () => {
  const lines = [{ from: 0, content: '转写台词' }]
  const r = selectSubsLines(null, lines, 'zh')
  assert.equal(r.source, 'transcript')
  assert.equal(r.lang, 'zh')
  assert.equal(r.lines, lines)
})

test('selectSubsLines：全无 → null', () => {
  assert.equal(selectSubsLines(null, null), null)
  assert.equal(selectSubsLines(null, []), null)
})

test('selectSubsLines：translated.body 为空数组 → 落到原文（不因 length 0 误选）', () => {
  const official = { lan: 'en', body: [{ from: 0, content: 'hello' }], translated: { body: [] } }
  const r = selectSubsLines(official, null)
  assert.equal(r.source, 'official')
})

// ── buildEvidence：第四级（字幕带）闭合 ─────────────────────────────
test('buildEvidence：文本字幕（official）→ source=official', () => {
  const ctx = { danmaku: [], duration: 100, hasSubs: false }
  const sel = { lines: [{ from: 0, content: '你好' }], source: 'official', lang: 'zh' }
  const ev = buildEvidence(ctx, sel)
  assert.equal(ev.subs.source, 'official')
  assert.equal(ev.subs.lang, 'zh')
})

test('buildEvidence：无文本字幕 + 有字幕带（hasSubs）→ source=band（P 回归）', () => {
  const ctx = { danmaku: [], duration: 100, hasSubs: true, bandResult: { bandRatio: 0.05 } }
  const ev = buildEvidence(ctx, null)
  assert.equal(ev.subs.source, 'band')
  assert.equal(ev.subs.confidence, 'ok')
  assert.equal(ev.subs.bandRatio, 0.05)
})

test('buildEvidence：无文本无字幕带 → source=none', () => {
  const ctx = { danmaku: [], duration: 100, hasSubs: false }
  const ev = buildEvidence(ctx, null)
  assert.equal(ev.subs.source, 'none')
  assert.equal(ev.subs.confidence, 'none')
})

test('buildEvidence：frames 成本用 PER_IMAGE（1024）', () => {
  const ctx = { danmaku: [], duration: 100, hasSubs: false }
  const ev = buildEvidence(ctx, null)
  assert.equal(ev.frames.coarse.cost, PER_IMAGE)
  assert.equal(ev.frames.fine.cost, 1024)
})
