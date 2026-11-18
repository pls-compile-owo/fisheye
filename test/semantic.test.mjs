// semantic 模块单测：探测优先级 / embedding 增强 / 纯 JS 兜底 / 输入校验。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSemanticCli, semanticCaps, semanticSegment } from '../lib/semantic.mjs'
import { segmentPureJs, charBigramVector, cosine } from '../lib/semantic-core.mjs'

test('resolveSemanticCli：随包 semantic/cli.py 优先命中', () => {
  const cli = resolveSemanticCli()
  assert.ok(cli && cli.endsWith(path.join('semantic', 'cli.py')), '应命中包内 semantic/cli.py：' + cli)
})

test('resolveSemanticCli：SEMANTIC_CLI 环境变量覆盖', () => {
  const tmp = path.join(os.tmpdir(), 'semantic-cli-test-' + process.pid + '.py')
  fs.writeFileSync(tmp, 'print("{}")')
  process.env.SEMANTIC_CLI = tmp
  try {
    assert.equal(resolveSemanticCli(), tmp)
  } finally {
    delete process.env.SEMANTIC_CLI
    fs.unlinkSync(tmp)
  }
})

test('semanticCaps：纯 JS 兜底恒可用，embed 标志区分增强', () => {
  const caps = semanticCaps()
  assert.equal(caps.available, true)
  assert.equal(typeof caps.embed, 'boolean')
  assert.ok(String(caps.summary).includes('语义'))
})

test('semanticSegment：空输入返回 null', () => {
  assert.equal(semanticSegment([], {}), null)
  assert.equal(semanticSegment(null, {}), null)
})

test('semanticSegment：CLI 不可用时降级纯 JS（不返回 null、不抛错）', () => {
  process.env.SEMANTIC_CLI = path.join(os.tmpdir(), 'no-such-semantic-cli-' + Date.now() + '.py')
  try {
    const out = semanticSegment([{ t: 1, text: 'hello' }], {})
    assert.ok(out && Array.isArray(out.segments))
  } finally {
    delete process.env.SEMANTIC_CLI
  }
})

test('semanticSegment：正常输入返回结构对象（embedding 或纯 JS 均可）', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ t: i * 10, text: '第' + i + '句台词内容' }))
  let out
  assert.doesNotThrow(() => { out = semanticSegment(lines, { nBkps: 2 }) })
  assert.ok(out && Array.isArray(out.segments), 'segments 必须是数组')
  for (const s of out.segments) {
    assert.equal(typeof s.t, 'number')
    assert.ok(Array.isArray(s.signals))
  }
})

test('segmentPureJs：两个明显不同话题能切出切换点', () => {
  const lines = [
    ...Array.from({ length: 12 }, (_, i) => ({ t: i, text: '今天我们聊聊猫的品种和饲养' + i })),
    ...Array.from({ length: 12 }, (_, i) => ({ t: 12 + i, text: '量子计算机的基本原理是什么' + i })),
  ]
  const out = segmentPureJs(lines, { nBkps: 1 })
  assert.ok(Array.isArray(out.segments))
  assert.ok(out.segments.length >= 1, '两个话题之间应至少切出一个点')
  // 切换点应落在两个话题交界附近（时间在 0 之后、24 之前）
  const t = out.segments[0].t
  assert.ok(t > 0 && t < 24, '切换点时间应在台词范围内：' + t)
})

test('segmentPureJs：不足 8 行返回空结构', () => {
  const out = segmentPureJs([{ t: 0, text: '短' }, { t: 1, text: '更短' }], {})
  assert.deepEqual(out, { segments: [], suggestions: [] })
})

test('charBigramVector / cosine：语义相近余弦高、相远余弦低', () => {
  const a = charBigramVector('今天天气很好')
  const b = charBigramVector('今天天气不错')
  const c = charBigramVector('量子力学基础')
  assert.ok(cosine(a, b) > cosine(a, c))
})
