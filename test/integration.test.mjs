// 集成测试：真实 CLI 端到端（spawn 子进程，不 mock 内部函数）
// 覆盖：本地视频抽帧、--smart 全管线、trace 输出、selftest、clean。
// 需要 ffmpeg；没有则整体 skip（CI 的 ubuntu 有 ffmpeg，Windows 开发机按需）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../lib/env.mjs'

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'fisheye.mjs')

function makeVideo(seconds = 3) {
  if (!FFMPEG) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-int-'))
  const file = path.join(dir, `clip-${seconds}s.mp4`)
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=128x72:rate=10`, '-pix_fmt', 'yuv420p', '-y', file], { stdio: 'ignore', timeout: 30000 })
  return r.status === 0 && fs.existsSync(file) ? file : null
}

function run(args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) }
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    env,
    cwd: options.cwd,
  })
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}

const video = makeVideo(3)
const skip = video ? false : '本地没有 ffmpeg，跳过集成测试'

test('local：抽帧拼图端到端', { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-home-'))
  const r = run(['local', video, '--grid', '3x3'], { env: { FISHEYE_HOME: home } })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /SHEET:\s+.+\.jpg/)
  const sheets = fs.readdirSync(path.join(home, 'out')).filter((f) => f.endsWith('.jpg'))
  assert.ok(sheets.length >= 1, '应至少生成一张拼图')
})

test('local --smart：全管线 + trace 阶段齐全', { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-home-'))
  const r = run(['local', video, '--smart'], { env: { FISHEYE_HOME: home, FISHEYE_TRACE: '1' } })
  assert.equal(r.code, 0, r.err)
  const traceFile = fs.readdirSync(path.join(home, 'out')).find((f) => f.endsWith('-trace.json'))
  assert.ok(traceFile, 'FISHEYE_TRACE=1 应生成 trace.json')
  const trace = JSON.parse(fs.readFileSync(path.join(home, 'out', traceFile), 'utf8'))
  assert.equal(trace.ok, true)
  const phases = trace.phases.map((p) => p.phase)
  assert.ok(phases.includes('scene-detect'), 'trace 应含 scene-detect 阶段')
  assert.ok(phases.some((p) => ['download', 'subtitles'].includes(p)), 'trace 应含采集阶段')
})

test('selftest：不需要网络也能跑完（exit 0）', () => {
  const r = run(['selftest'], { timeout: 60000 })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /结果：/)
})

test('selftest：ffmpeg 指向坏路径 → 报「无法执行」而不是崩溃', () => {
  // 回归：ffmpeg 执行失败分支曾引用未 import 的 FFMPEG_RES，一执行就 ReferenceError。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-home-'))
  const r = run(['selftest'], {
    env: {
      FISHEYE_HOME: home,
      FFMPEG: path.join(os.tmpdir(), 'fisheye-not-a-real-ffmpeg.exe'),
    },
    timeout: 60000,
  })
  assert.equal(r.code, 0, `selftest 不应因依赖缺失崩溃：${r.err}`)
  assert.match(r.out, /ffmpeg/)
  assert.match(r.out, /无法执行/, '应报告「无法执行」而不是抛异常')
  assert.ok(!/ReferenceError/.test(r.err), '不应出现 ReferenceError（FFMPEG_RES 未 import 的回归）')
})

test('clean：dry-run 不删、--yes 才删', { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-home-'))
  const outDir = path.join(home, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'x.jpg'), 'x')
  const dry = run(['clean', '--target', 'out'], { env: { FISHEYE_HOME: home } })
  assert.equal(dry.code, 0, dry.err)
  assert.ok(fs.existsSync(path.join(outDir, 'x.jpg')), 'dry-run 不应删除')
  const real = run(['clean', '--target', 'out', '--yes'], { env: { FISHEYE_HOME: home } })
  assert.equal(real.code, 0, real.err)
  assert.ok(!fs.existsSync(path.join(outDir, 'x.jpg')), '--yes 应删除产物')
})
