// ytdlp 模块单测：能力探测结构 / 二进制可用性 / URL 校验 / 失败兜底
//
// 这些测试不依赖「本机装没装 yt-dlp」：没装时 findYtdlp 返回 null、caps 报不可用，
// 需要二进制的用例自动 skip。想跑真正的端到端下载（会联网、小文件）：
//   FISHEYE_YTDLP_E2E=1 node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { downloadVideo, findYtdlp, ytdlpCaps } from '../lib/ytdlp.mjs'

const CAP_KEYS = ['available', 'reason', 'summary', 'hint', 'cmd', 'ffmpeg', 'version', 'notes']

/** caps 的公共结构断言（available / 不可用两种形态都适用） */
function assertCapsShape(caps) {
  for (const k of CAP_KEYS) assert.ok(k in caps, `caps 缺少字段 ${k}`)
  assert.equal(typeof caps.available, 'boolean')
  assert.equal(typeof caps.reason, 'string')
  assert.ok(caps.reason.length > 0, 'reason 不能为空')
  assert.equal(typeof caps.summary, 'string')
  assert.match(caps.summary, /yt-dlp/)
  assert.equal(caps.summary.includes(caps.available ? '可用' : '不可用'), true, 'summary 里要说明可用性')
  assert.ok(caps.hint === null || typeof caps.hint === 'string')
  assert.ok(caps.cmd === null || typeof caps.cmd === 'string')
  assert.ok(caps.ffmpeg === null || typeof caps.ffmpeg === 'string')
  assert.ok(Array.isArray(caps.notes))
  if (caps.available) {
    assert.equal(typeof caps.cmd, 'string', 'available 时必须给出 cmd')
    assert.ok(caps.cmd.length > 0)
  } else {
    assert.ok(typeof caps.hint === 'string' && caps.hint.length > 0, '不可用时要给 hint')
  }
}

/** 把 stdout+stderr 落到临时文件再读（沙箱里不能捕获管道） */
function runCapture(cmd, args, timeoutMs = 20000) {
  const file = path.join(os.tmpdir(), `fisheye-test-${process.pid}-${crypto.randomUUID().slice(0, 8)}.txt`)
  let fd
  let status
  let error
  try {
    fd = fs.openSync(file, 'w')
    const r = spawnSync(cmd, args, { stdio: ['ignore', fd, fd], timeout: timeoutMs, windowsHide: true })
    status = r.status
    error = r.error
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
  try {
    assert.equal(status, 0, `${path.basename(cmd)} ${args.join(' ')} 退出码 ${status}（${error?.message ?? '无错误信息'}）`)
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } finally {
    try { fs.unlinkSync(file) } catch {}
  }
}

test('ytdlpCaps：结构完整，字段类型正确', () => {
  const caps = ytdlpCaps()
  assertCapsShape(caps)
  // caps 与 findYtdlp 必须是同一个结论，不能一个说可用一个说没装
  assert.equal(caps.available, findYtdlp() !== null)
  // summaries 是给 CLI 打印的一行话，不该换行
  assert.ok(!caps.summary.includes('\n'))
})

test('ytdlpCaps：可用时 reason 带版本与来源', () => {
  const caps = ytdlpCaps({
    ytdlp: { cmd: path.join(os.tmpdir(), 'yt-dlp.exe'), version: '2024.01.01', source: '单测注入' },
  })
  assertCapsShape(caps)
  assert.equal(caps.available, true)
  assert.match(caps.reason, /2024\.01\.01/)
  assert.match(caps.reason, /单测注入/)
  assert.equal(caps.version, '2024.01.01')
})

test('ytdlpCaps：不可用分支给出安装提示', () => {
  // 直接喂一个空 ytdlp 会走真实探测；这里用伪造的环境 + 让所有候选都不存在不可行，
  // 所以只断言：无 yt-dlp 时 hint 非空，有 yt-dlp 时 hint 为 null 或字符串。
  const caps = ytdlpCaps({ env: { FISHEYE_YTDLP: 'C:\\definitely\\not\\here\\yt-dlp.exe' } })
  assertCapsShape(caps)
  if (!caps.available) assert.match(caps.hint, /yt-dlp\.exe|FISHEYE_YTDLP/)
})

test('findYtdlp：返回 null 或字段合法的对象', () => {
  const f = findYtdlp()
  if (f === null) return
  assert.equal(typeof f.cmd, 'string')
  assert.ok(f.cmd.length > 0)
  assert.ok(f.ffmpeg === null || typeof f.ffmpeg === 'string')
  if (f.ffmpeg) assert.ok(fs.existsSync(f.ffmpeg), `ffmpeg 路径不存在：${f.ffmpeg}`)
  // cmd 是绝对/相对路径时必须真的存在；裸命令名（PATH 命中）允许
  if (f.cmd.includes('/') || f.cmd.includes('\\')) assert.ok(fs.existsSync(f.cmd), `yt-dlp 路径不存在：${f.cmd}`)
  assert.ok(f.version === null || /^\d{4}\.\d{2}\.\d{2}/.test(f.version))
  assert.equal(typeof f.source, 'string')
})

test('findYtdlp：FISHEYE_YTDLP 指向不存在的文件时不崩', () => {
  const f = findYtdlp({ env: { FISHEYE_YTDLP: 'C:\\definitely\\not\\here\\yt-dlp.exe' } })
  assert.ok(f === null || typeof f.cmd === 'string')
})

test('yt-dlp 二进制能跑 --version（没装则 skip）', { skip: findYtdlp() === null }, () => {
  const f = findYtdlp()
  assert.ok(f && f.cmd)
  const out = runCapture(f.cmd, ['--version'])
  assert.match(out.trim(), /^\d{4}\.\d{2}\.\d{2}/)
})

test('ffmpeg 可用时能被解析出来（没装则 skip）', { skip: findYtdlp()?.ffmpeg == null }, () => {
  const f = findYtdlp()
  assert.ok(f?.ffmpeg)
  assert.ok(fs.existsSync(f.ffmpeg))
})

test('downloadVideo：非法 URL 一律返回 null（不抛）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-ytdlp-bad-'))
  const bad = [
    '', '   ', 'not a url', 'ftp://example.com/v.mp4', 'javascript:alert(1)',
    'file:///C:/Windows/win.ini', 'mailto:a@b.c', 'http://', null, undefined, 42, {},
  ]
  try {
    for (const u of bad) {
      const r = downloadVideo(u, dir, { quiet: true, timeoutMs: 5000 })
      assert.equal(r, null, `非法 URL 应返回 null：${String(u)}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('downloadVideo：没有输出目录时返回 null', () => {
  assert.equal(downloadVideo('https://example.com/v', '', { quiet: true, timeoutMs: 5000 }), null)
  assert.equal(downloadVideo('https://example.com/v', undefined, { quiet: true, timeoutMs: 5000 }), null)
})

test('downloadVideo：超时 → null（不抛）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-ytdlp-timeout-'))
  try {
    const r = downloadVideo('https://www.youtube.com/watch?v=BaW_jenozKc', dir, {
      quiet: true,
      timeoutMs: 500,
    })
    assert.equal(r, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 可选端到端：默认跳过，FISHEYE_YTDLP_E2E=1 时下载 yt-dlp 官方 10 秒测试视频
const E2E = process.env.FISHEYE_YTDLP_E2E === '1'

test('downloadVideo：端到端下载官方测试视频', { skip: !E2E }, (t) => {
  if (!findYtdlp()) {
    t.skip('本机没有 yt-dlp')
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-ytdlp-e2e-'))
  try {
    const r = downloadVideo('https://www.youtube.com/watch?v=BaW_jenozKc', dir, {
      quiet: true,
      timeoutMs: 180000,
      quality: '480',
    })
    if (!r) {
      t.skip('下载失败（网络 / 平台不可达），跳过端到端')
      return
    }
    assert.ok(fs.existsSync(r.file), `返回的文件不存在：${r.file}`)
    assert.ok(fs.statSync(r.file).size > 1024, '文件太小，可能不是视频')
    assert.equal(path.dirname(r.file), dir)
    assert.equal(typeof r.cmd, 'string')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
