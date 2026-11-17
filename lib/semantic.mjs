// lib/semantic.mjs — 语义切分「能力工具」（探测 + 子进程调用）
// 语义模块是独立 Python CLI（接口：输入字幕 JSON、输出切换点 JSON），走子进程调用（同 whisper/tesseract/yt-dlp 档）。
// 沙箱约束：子进程不能捕获 stdout 管道，用「写临时文件 → 读临时文件」的方式交换数据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PYTHON } from './env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 探测语义 CLI：环境变量 SEMANTIC_CLI → 项目约定路径（bin/ 或同级目录的 semantic cli.py）
export function resolveSemanticCli() {
  if (process.env.SEMANTIC_CLI && fs.existsSync(process.env.SEMANTIC_CLI)) return process.env.SEMANTIC_CLI
  const candidates = [
    path.resolve(__dirname, '..', 'semantic', 'cli.py'),                      // 随包参考实现（推荐）
    path.resolve(os.homedir(), '.config', 'fisheye', 'semantic', 'cli.py'),  // 用户级约定位置
    path.resolve(__dirname, '..', 'bin', 'semantic', 'cli.py'),              // 项目内 bin/
    path.resolve(__dirname, '..', '..', 'semantic', 'src', 'cli.py'),        // 同级目录
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

// 探测语义模块的 python：环境变量 SEMANTIC_PYTHON → bundled Python（dsh 运行时，带 fastembed/ruptures）→ 回退 env.mjs 的 PYTHON
export function resolveSemanticPython() {
  if (process.env.SEMANTIC_PYTHON && fs.existsSync(process.env.SEMANTIC_PYTHON)) return process.env.SEMANTIC_PYTHON
  const candidates = [
    PYTHON,
    process.platform === 'win32' ? 'python.exe' : 'python3',
  ]
  for (const c of candidates) if (c && fs.existsSync(c)) return c
  return null
}

/** 能力探测：可用返回 { available, cli, summary }，不可用返回 { available:false, reason, hint } */
export function semanticCaps() {
  const cli = resolveSemanticCli()
  if (!cli) {
    return { available: false, reason: '未找到语义模块 CLI', hint: '设 SEMANTIC_CLI 环境变量指向 src/cli.py' }
  }
  const py = resolveSemanticPython()
  if (!py) {
    return { available: false, reason: '未找到 python', hint: '设 SEMANTIC_PYTHON 指向带 fastembed/ruptures 的 python' }
  }
  return { available: true, cli, summary: `语义切分：可用 —— ${cli}` }
}

/**
 * 语义切分：台词行 → { segments, suggestions }。
 * @param {Array<{t:number, text:string}>} lines 带时间戳台词行
 * @param {{nBkps?:number}} opts
 * @returns {{segments:Array, suggestions:Array}|null} 失败/不可用返回 null
 */
export function semanticSegment(lines, opts = {}) {
  const caps = semanticCaps()
  if (!caps.available) return null
  if (!Array.isArray(lines) || !lines.length) return null

  const tmpIn = path.join(os.tmpdir(), `fisheye-semantic-in-${process.pid}-${Date.now()}.json`)
  const tmpOut = path.join(os.tmpdir(), `fisheye-semantic-out-${process.pid}-${Date.now()}.json`)
  const tmpErr = path.join(os.tmpdir(), `fisheye-semantic-err-${process.pid}-${Date.now()}.log`)
  try {
    fs.writeFileSync(tmpIn, JSON.stringify(lines), 'utf8')
    const fd = fs.openSync(tmpOut, 'w')
    // stderr 必须独立：CLI 往 stderr 写日志时，和 stdout 同一个 fd 会污染 JSON 解析
    const fdErr = fs.openSync(tmpErr, 'w')
    try {
      spawnSync(resolveSemanticPython(), [caps.cli, tmpIn, '--n-bkps', String(opts.nBkps ?? 5)], {
        stdio: ['ignore', fd, fdErr],
        timeout: 300000,
      })
    } finally {
      try { fs.closeSync(fd) } catch {}
      try { fs.closeSync(fdErr) } catch {}
    }
    const raw = fs.readFileSync(tmpOut, 'utf8').trim()
    if (!raw) return null
    const result = JSON.parse(raw)
    return Array.isArray(result?.segments) ? result : { segments: result, suggestions: [] }
  } catch {
    return null
  } finally {
    try { fs.unlinkSync(tmpIn) } catch {}
    try { fs.unlinkSync(tmpOut) } catch {}
    try { fs.unlinkSync(tmpErr) } catch {}
  }
}
