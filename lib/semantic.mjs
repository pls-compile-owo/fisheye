// lib/semantic.mjs — 语义切分「能力工具」（embedding 增强 + 纯 JS 兜底）
//
// 两条路径：
//   1. embedding 增强（可选）：探测到 python + fastembed + semantic/cli.py 时，走子进程调真 embedding
//      （bge-small-zh-v1.5），质量和 1.0.8 一致。
//   2. 纯 JS 兜底（默认可用）：无 python 时用 char-bigram 词法漂移（lib/semantic-core.mjs），
//      零 python / 零 npm，能跑但语义区分度弱于 embedding。
//
// 沙箱约束：子进程不能捕获 stdout 管道，用「写临时文件 → 读临时文件」的方式交换数据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PYTHON } from './env.mjs'
import { segmentPureJs } from './semantic-core.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 探测语义 CLI：环境变量 SEMANTIC_CLI → 项目约定路径（随包 semantic/cli.py 优先）
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

/**
 * 能力探测：语义切分「恒可用」（纯 JS 兜底）；embed 标志区分是否走 embedding 增强。
 * @returns {{available:boolean, embed:boolean, cli:string|null, summary:string}}
 */
export function semanticCaps() {
  const cli = resolveSemanticCli()
  const py = cli ? resolveSemanticPython() : null
  if (cli && py) {
    return { available: true, embed: true, cli, summary: `语义切分：embedding 增强可用 —— ${cli}` }
  }
  return { available: true, embed: false, cli: null, summary: '语义切分：纯 JS 词法降级（装 python + fastembed 可提升质量）' }
}

// 子进程跑 embedding 版 CLI；失败/超时/解析失败返回 null（由调用方降级纯 JS）
function runPythonSegment(lines, opts) {
  const caps = semanticCaps()
  if (!caps.embed) return null
  const tmpIn = path.join(os.tmpdir(), `fisheye-semantic-in-${process.pid}-${Date.now()}.json`)
  const tmpOut = path.join(os.tmpdir(), `fisheye-semantic-out-${process.pid}-${Date.now()}.json`)
  const tmpErr = path.join(os.tmpdir(), `fisheye-semantic-err-${process.pid}-${Date.now()}.log`)
  try {
    fs.writeFileSync(tmpIn, JSON.stringify(lines), 'utf8')
    const fd = fs.openSync(tmpOut, 'w')
    const fdErr = fs.openSync(tmpErr, 'w') // stderr 独立：避免污染 stdout JSON
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
    if (result?.error) return null // CLI 侧依赖缺失 / 失败 → 降级纯 JS
    return Array.isArray(result?.segments) ? result : { segments: result, suggestions: [] }
  } catch {
    return null
  } finally {
    try { fs.unlinkSync(tmpIn) } catch {}
    try { fs.unlinkSync(tmpOut) } catch {}
    try { fs.unlinkSync(tmpErr) } catch {}
  }
}

/**
 * 语义切分：台词行 → { segments, suggestions }。
 * embedding 增强可用时优先走 python；否则（或 python 失败时）纯 JS 词法兜底。
 * @param {Array<{t:number, text:string}>} lines 带时间戳台词行
 * @param {{nBkps?:number}} opts
 * @returns {{segments:Array, suggestions:Array}|null} 空输入返回 null
 */
export function semanticSegment(lines, opts = {}) {
  if (!Array.isArray(lines) || !lines.length) return null
  const clean = lines.filter((l) => l && String(l.text ?? '').trim())
  if (!clean.length) return null

  const python = runPythonSegment(clean, opts)
  if (python) return python
  return segmentPureJs(clean, opts)
}
