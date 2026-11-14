// 进程/依赖探测的公共工具：audio / ocr / ytdlp 三个可选模块共用一份实现。
// 之前三个模块各自复制了 capture / whereAll / spawnable / readText / tmpFile / stripQuotes /
// resolveFfmpeg 约 300 行（评审 P2 指出的最大可维护性问题）——沙箱兼容改动只需改这里一处。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from './env.mjs'

export const IS_WIN = process.platform === 'win32'

export const EXE = (name) => (IS_WIN ? `${name}.exe` : name)

export const stripQuotes = (s) => String(s ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')

/**
 * 读文本文件（去 BOM），失败返回空串。
 * @param {string} file
 * @param {number} limit 最多读多少字符
 */
export function readText(file, limit = 65536) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').slice(0, limit) } catch { return '' }
}

/** 临时文件路径（调用方负责删除）。 */
export function tmpFile(tag) {
  return path.join(os.tmpdir(), `fisheye-${tag}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.txt`)
}

/**
 * 跑一个短命令并把 stdout+stderr 落到临时文件。
 * 沙箱里不能捕获管道，所以不能用 spawnSync 的 'pipe' —— 只能 fd 重定向。
 */
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
      out: readText(file),
    }
  } catch (e) {
    return { ok: false, status: null, error: e, out: '' }
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* ignore */ }
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
}

// where.exe / which 的全部命中行（没有命中返回 []）
export function whereAll(name) {
  const r = capture(IS_WIN ? 'where.exe' : 'which', [name], 5000)
  if (r.status !== 0) return []
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 判断一个 where 命中项是否值得 spawn。
 * Windows 上 `where main` 会命中 C:\Windows\System32\main.cpl —— PATHEXT 里有 .CPL，
 * 但它是控制面板程序，直接 spawn 会 ENOENT。所以先按扩展名筛掉，
 * 再用 --help 输出确认是不是真的目标程序。
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

/**
 * 解析 ffmpeg 路径：显式参数 > 环境变量 > lib/env.mjs 解析结果。
 * audio / ytdlp 共用。
 */
export function resolveFfmpeg({ env = process.env, explicit } = {}) {
  const raw = explicit ?? env.FISHEYE_FFMPEG ?? env.FFMPEG ?? FFMPEG
  if (!raw) return null
  const s = stripQuotes(raw)
  if (!s) return null
  return s
}
