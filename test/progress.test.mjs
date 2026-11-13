// progress 模块单测：进度计数 / 单行覆盖 / 静默 / 时长格式化 / 阶段计时
// 用注入的假 stream 收集输出，不碰真实 stderr。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProgress, stageTimer, humanDuration } from '../lib/progress.mjs'

function fakeStream({ isTTY = false } = {}) {
  return {
    isTTY,
    chunks: [],
    write(s) { this.chunks.push(s) },
  }
}

const text = (out) => out.chunks.join('')

test('createProgress：tick 累计、set 跳转、done 收尾（非 TTY 每行换行）', () => {
  const out = fakeStream()
  const p = createProgress('抽帧', 12, { stream: out })
  p.tick()
  p.tick()
  p.tick()
  p.set(9)
  p.tick(2)
  const sec = p.done()

  assert.equal(typeof sec, 'number')
  assert.deepEqual(out.chunks, [
    '[抽帧] 1/12 (8%)\n',
    '[抽帧] 2/12 (16%)\n',
    '[抽帧] 3/12 (25%)\n',
    '[抽帧] 9/12 (75%)\n',
    '[抽帧] 11/12 (91%)\n',
    '[抽帧] 12/12 (100%)\n',
  ])
  assert.ok(!text(out).includes('\r'), '非 TTY 不该用 \\r 覆盖')
})

test('createProgress：TTY 用 \\r 单行覆盖，done 时补换行', () => {
  const out = fakeStream({ isTTY: true })
  const p = createProgress('下载', 4, { stream: out })
  p.tick()
  p.tick(2)
  assert.ok(out.chunks.every((c) => c.startsWith('\r')))
  assert.ok(!text(out).includes('\n'), 'done 之前不能换行')

  p.done()
  assert.equal(text(out), '\r[下载] 1/4 (25%)\r[下载] 3/4 (75%)\r[下载] 4/4 (100%)\n')
})

test('createProgress：tick 超过总数时停在 100%', () => {
  const out = fakeStream()
  const p = createProgress('x', 3, { stream: out })
  p.tick(10)
  assert.equal(out.chunks.at(-1), '[x] 3/3 (100%)\n')
})

test('createProgress：total 未知（0）时只显示计数', () => {
  const out = fakeStream()
  const p = createProgress('帧', 0, { stream: out })
  p.tick()
  p.tick(2)
  assert.deepEqual(out.chunks, ['[帧] 1\n', '[帧] 3\n'])
})

test('createProgress：enabled:false 时完全静默，elapsed 仍可用', () => {
  const out = fakeStream()
  const p = createProgress('x', 5, { stream: out, enabled: false })
  p.tick()
  p.set(3)
  p.done()
  p.fail('boom')
  assert.equal(text(out), '')
  assert.equal(typeof p.elapsed(), 'number')
  assert.ok(p.elapsed() >= 0)
})

test('createProgress：fail 输出原因，之后不再输出', () => {
  const out = fakeStream()
  const p = createProgress('下载', 4, { stream: out })
  p.tick()
  p.fail('网络断了')
  p.tick()
  p.done()
  assert.equal(out.chunks.length, 2)
  assert.equal(out.chunks[0], '[下载] 1/4 (25%)\n')
  assert.match(out.chunks[1], /^\[下载\] 失败：网络断了\n$/)
})

test('createProgress：elapsed 返回非负秒数', () => {
  const p = createProgress('x', 1, { stream: fakeStream() })
  const sec = p.elapsed()
  assert.equal(typeof sec, 'number')
  assert.ok(sec >= 0 && sec < 5)
})

test('createProgress / stageTimer：stream 不能写时不抛', () => {
  const p = createProgress('x', 1, { stream: {} })
  p.tick()
  p.done()
  p.fail('no-write')
  const timer = stageTimer('y', { stream: {} })
  timer.stop()
})

test('humanDuration：ms / s / m / h 格式化', () => {
  assert.equal(humanDuration(0), '0ms')
  assert.equal(humanDuration(300), '300ms')
  assert.equal(humanDuration(1500), '1.5s')
  assert.equal(humanDuration(59000), '59.0s')
  assert.equal(humanDuration(60000), '1m0s')
  assert.equal(humanDuration(123000), '2m3s')
  assert.equal(humanDuration(3723000), '1h2m3s')
  // 异常输入不该产出 NaN
  assert.equal(humanDuration(-5), '0ms')
  assert.equal(humanDuration(NaN), '0ms')
  assert.equal(humanDuration(undefined), '0ms')
})

test('stageTimer：stop 输出用时、返回秒数、重复 stop 只输出一次', () => {
  const out = fakeStream()
  const timer = stageTimer('下载', { stream: out })
  const sec = timer.stop()
  assert.equal(typeof sec, 'number')
  assert.ok(sec >= 0)
  assert.equal(out.chunks.length, 1)
  assert.match(out.chunks[0], /^\[下载\] 用时 (\d+ms|\d+\.\d+s|\d+m\d+s|\d+h\d+m\d+s)\n$/)

  timer.stop()
  assert.equal(out.chunks.length, 1, '重复 stop 不应重复输出')
})

test('stageTimer：enabled:false 时静默', () => {
  const out = fakeStream()
  const timer = stageTimer('精读', { stream: out, enabled: false })
  const sec = timer.stop()
  assert.equal(text(out), '')
  assert.equal(typeof sec, 'number')
})
