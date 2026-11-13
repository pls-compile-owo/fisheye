// audio 模块单测：能力探测（不依赖本机是否装 whisper，环境无关）
import test from 'node:test'
import assert from 'node:assert/strict'
import { audioCaps, findWhisper } from '../lib/audio.mjs'

test('audioCaps：返回稳定的能力描述结构', () => {
  const caps = audioCaps()
  assert.equal(typeof caps, 'object')
  assert.equal(typeof caps.available, 'boolean')
  assert.equal(typeof caps.reason, 'string')
  assert.equal(typeof caps.summary, 'string')
  if (caps.available) {
    assert.ok(caps.whisper)
    assert.ok(caps.cmd)
  } else {
    assert.ok(caps.hint)
  }
})

test('findWhisper：无可用 whisper 时返回 null 或合法对象（不抛错）', () => {
  const r = findWhisper({ ffmpeg: null, env: {} })
  assert.ok(r === null || (r && typeof r.cmd === 'string'))
})
