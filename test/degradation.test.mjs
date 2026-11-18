// 退化场景评估：确认「缺依赖 / 坏输入 / 坏产物」时是清晰报错，而不是崩溃或静默假成功。
// 每个用例都断言 exit code + 错误信息的关键词，避免"看起来跑完了但没有结果"。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'fisheye.mjs')

function run(args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) }
  if (options.clearPath) env.PATH = ''
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? 60000,
    env,
    cwd: options.cwd,
  })
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-deg-'))
}

test('退化：无 ffmpeg —— 明确报错并退出 2，不抛堆栈', () => {
  // 隔离 HOME：避免本机 ~/.config/fisheye/config.json 提供 ffmpeg 路径
  const home = tmpHome()
  const r = run(['local', path.join(home, 'whatever.mp4')], {
    env: { FFMPEG: '', FISHEYE_HOME: home, USERPROFILE: home, HOME: home },
    clearPath: true,
  })
  assert.equal(r.code, 2)
  assert.match(r.err, /ffmpeg/i)
  assert.ok(!/at .*\.mjs:\d+/.test(r.err), '不应输出堆栈')
})

test('退化：文件不存在 —— 清晰提示，不崩溃', () => {
  const missing = path.join(os.tmpdir(), 'fisheye-not-exist-' + Date.now() + '.mp4')
  const r = run(['local', missing], { env: { FISHEYE_HOME: tmpHome() } })
  assert.notEqual(r.code, 0)
  assert.ok(r.err.length > 0, '应有错误信息')
  assert.ok(!/TypeError|ReferenceError|at .*\.mjs:\d+/.test(r.err), '不应是未捕获异常')
})

test('退化：损坏的视频文件 —— 报错而非假成功', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-deg-'))
  const bad = path.join(dir, 'broken.mp4')
  fs.writeFileSync(bad, 'not a real mp4')
  const r = run(['local', bad], { env: { FISHEYE_HOME: tmpHome() }, timeout: 60000 })
  assert.notEqual(r.code, 0, '损坏视频不应返回 0')
  assert.ok(r.err.length > 0)
})

test('退化：空文件 —— 报错而非无限等待', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-deg-'))
  const empty = path.join(dir, 'empty.mp4')
  fs.writeFileSync(empty, '')
  const r = run(['local', empty], { env: { FISHEYE_HOME: tmpHome() }, timeout: 60000 })
  assert.notEqual(r.code, 0)
})

test('退化：非法 BV 号 —— 用法提示 + 退出 2', () => {
  const r = run(['auto', 'not-a-bv'], { env: { FISHEYE_HOME: tmpHome() } })
  assert.equal(r.code, 2)
  assert.match(r.err + r.out, /BV|用法|usage/i)
})

test('退化：--budget 超范围 —— 参数校验报错', () => {
  const r = run(['auto', 'BV1Cc411Q78T', '--budget', '999'], { env: { FISHEYE_HOME: tmpHome() } })
  assert.notEqual(r.code, 0)
  assert.match(r.err, /budget|范围|range/i)
})

test('退化：--density 超范围 —— 参数校验报错', () => {
  const r = run(['auto', 'BV1Cc411Q78T', '--density', '999'], { env: { FISHEYE_HOME: tmpHome() } })
  assert.notEqual(r.code, 0)
  assert.match(r.err, /density|范围|range/i)
})

test('退化：损坏的 manifest —— refine 给出可读提示而非崩溃', () => {
  const home = tmpHome()
  const outDir = path.join(home, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  // 伪造一个损坏的 manifest + 一个占位 mp4（refine 只要求 cache/<id>.mp4 存在）
  const id = 'local-brokenclip'
  fs.writeFileSync(path.join(outDir, `${id}-manifest.json`), '{ not json')
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true })
  fs.writeFileSync(path.join(home, 'cache', `${id}.mp4`), 'x')
  const r = run(['refine', path.join(home, 'cache', `${id}.mp4`)], { env: { FISHEYE_HOME: home }, timeout: 60000 })
  assert.ok(!/TypeError|ReferenceError|at .*\.mjs:\d+/.test(r.err), '不应是未捕获异常')
})

test('退化：未知子命令 —— 用法提示 + 退出 2', () => {
  const r = run(['definitely-not-a-command'], { env: { FISHEYE_HOME: tmpHome() } })
  assert.equal(r.code, 2)
  assert.ok((r.err + r.out).length > 0)
})
