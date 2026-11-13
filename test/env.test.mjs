// env 模块单测：工具探测（onPath / resolveTool）
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { onPath, resolveTool } from '../lib/env.mjs'

test('onPath：Windows 的 where 命令存在', () => {
  if (process.platform === 'win32') {
    assert.equal(onPath('where'), true)
  } else {
    assert.equal(onPath('which'), true)
  }
})

test('onPath：不存在的命令返回 false', () => {
  assert.equal(onPath('definitely-not-a-real-command-xyz-123'), false)
})

test('resolveTool：环境变量优先', () => {
  const saved = process.env.FISHEYE_TEST_TOOL
  process.env.FISHEYE_TEST_TOOL = os.tmpdir()
  try {
    const r = resolveTool('FISHEYE_TEST_TOOL', 'testTool', [], 'nonexistent-cmd-xyz')
    assert.ok(r)
    assert.equal(r.cmd, os.tmpdir())
    assert.match(r.from, /环境变量/)
  } finally {
    if (saved === undefined) delete process.env.FISHEYE_TEST_TOOL; else process.env.FISHEYE_TEST_TOOL = saved
  }
})

test('resolveTool：全部找不到返回 null', () => {
  const r = resolveTool('FISHEYE_TEST_TOOL_MISSING', 'missingTool', [os.tmpdir() + '\\no-such-exe.exe'], 'no-such-cmd-xyz-456')
  assert.equal(r, null)
})
