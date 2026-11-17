// semantic 模块单测：探测优先级 / 降级路径 / 输入校验（不依赖真实 Python）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSemanticCli, semanticCaps, semanticSegment } from '../lib/semantic.mjs'

const origEnv = { ...process.env }

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

test('semanticCaps：结构与一致性（不假设本机有 python）', () => {
  const caps = semanticCaps()
  assert.equal(typeof caps.available, 'boolean')
  if (caps.available) {
    assert.ok(caps.cli)
    assert.ok(String(caps.summary).includes('语义'))
  } else {
    // 找不到 python 时应给出可操作的 hint
    assert.ok(String(caps.reason ?? '').length > 0)
    assert.ok(String(caps.hint ?? '').includes('SEMANTIC_PYTHON'))
  }
})

test('semanticSegment：空输入返回 null', () => {
  assert.equal(semanticSegment([], {}), null)
  assert.equal(semanticSegment(null, {}), null)
})

test('semanticSegment：CLI 不可用返回 null（不抛错）', () => {
  process.env.SEMANTIC_CLI = path.join(os.tmpdir(), 'no-such-semantic-cli-' + Date.now() + '.py')
  try {
    assert.equal(semanticSegment([{ t: 1, text: 'hello' }], {}), null)
  } finally {
    delete process.env.SEMANTIC_CLI
  }
})

test('semanticSegment：正常输入不抛错（无 Python 时返回 null 或结构对象）', () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ t: i * 10, text: '第' + i + '句台词内容' }))
  let out
  assert.doesNotThrow(() => { out = semanticSegment(lines, { nBkps: 2 }) })
  if (out !== null) {
    assert.ok(Array.isArray(out.segments), 'segments 必须是数组')
    for (const s of out.segments) {
      assert.equal(typeof s.t, 'number')
      assert.ok(Array.isArray(s.signals))
    }
  }
})
