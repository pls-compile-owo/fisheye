// lib/proc.mjs — 三个可选能力（audio/ocr/ytdlp）共用的进程探测工具
// 沙箱约束：子进程不能捕获 stdout 管道，统一用「写临时文件再读」的方式取输出（改沙箱兼容只改这里）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { FFMPEG, PKG_DIR } from './env.mjs'

export const IS_WIN = process.platform === 'win32'
export const EXE = (name) => (IS_WIN ? `${name}.exe` : name)
export const stripQuotes = (s) => String(s ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')

export function readText(file, limit = 65536) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').slice(0, limit) } catch { return '' }
}

export function tmpFile(tag) {
  return path.join(os.tmpdir(), `fisheye-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.txt`)
}

/** 跑一个短命令，把 stdout+stderr 落到临时文件（沙箱禁 pipe，只能 fd 重定向）。 */
export function capture(cmd, args, timeoutMs = 8000) {
  const file = tmpFile('cap')
  let fd = null
  try {
    fd = fs.openSync(file, 'w')
    const r = spawnSync(cmd, args, {
      stdio: ['ignore', fd, fd],
      timeout: timeoutMs,
      windowsHide: true,
    })
    return {
      ok: r.status === 0,
      status: r.status,
      error: r.error,
      out: readText(file).slice(0, 65536),
    }
  } catch (e) {
    return { ok: false, status: null, error: e, out: '' }
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(file) } catch {}
  }
}

/** 跑一个短命令，把 stdout / stderr 分别落到两个临时文件（需要分开 stdout/stderr 的场景，如 OCR）。 */
export function captureSplit(cmd, args, timeoutMs = 8000) {
  const outFile = tmpFile('out')
  const errFile = tmpFile('err')
  let fdOut = null
  let fdErr = null
  try {
    fdOut = fs.openSync(outFile, 'w')
    fdErr = fs.openSync(errFile, 'w')
    const r = spawnSync(cmd, args, {
      stdio: ['ignore', fdOut, fdErr],
      timeout: timeoutMs,
      windowsHide: true,
    })
    return {
      ok: r.status === 0,
      status: r.status,
      error: r.error,
      out: readText(outFile),
      err: readText(errFile),
    }
  } catch (e) {
    return { ok: false, status: null, error: e, out: '', err: '' }
  } finally {
    if (fdOut !== null) try { fs.closeSync(fdOut) } catch {}
    if (fdErr !== null) try { fs.closeSync(fdErr) } catch {}
    try { fs.unlinkSync(outFile) } catch {}
    try { fs.unlinkSync(errFile) } catch {}
  }
}

/** where.exe / which 的全部命中行（没有命中返回 []）。 */
export function whereAll(name, timeoutMs = 5000) {
  const r = capture(IS_WIN ? 'where.exe' : 'which', [name], timeoutMs)
  if (r.status !== 0) return []
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 判断一个 where 命中项是否值得 spawn。
 * Windows 上 where 会命中 .cpl/.dll 之类（PATHEXT），spawn 会 ENOENT；
 * .bat/.cmd 也排除：spawnSync 不带 shell 无法直接执行它们。
 */
export function spawnable(p) {
  if (!p) return false
  const ext = path.extname(p).toLowerCase()
  if (IS_WIN && ['.cpl', '.dll', '.msi', '.sys', '.scr', '.bat', '.cmd', '.ps1', '.vbs', '.js'].includes(ext)) return false
  const looksPath = p.includes('/') || p.includes('\\')
  if (looksPath && !fs.existsSync(p)) return false
  try {
    if (fs.existsSync(p)) {
      const st = fs.statSync(p)
      if (!st.isFile() || st.size === 0) return false
    }
  } catch { return false }
  return true
}

/** ffmpeg 解析：显式参数 → FFMPEG 环境变量 → env.mjs（可能为 null）→ 本机常见目录 → PATH */
export function resolveFfmpeg({ env = process.env, explicit } = {}) {
  const home = os.homedir()
  const cands = [
    explicit,
    env.FFMPEG,
    FFMPEG,
    path.join(PKG_DIR, 'bin', EXE('ffmpeg')),
  ].filter(Boolean).map(stripQuotes)

  for (const c of cands) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch { /* 下一个 */ }
  }
  return whereAll('ffmpeg').filter(spawnable)[0] ?? null
}
