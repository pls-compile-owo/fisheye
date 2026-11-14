// 通用平台视频（可选）：yt-dlp 下载 → 本地 mp4 → 交给本地视频模式（抽帧 / 字幕带）
//
// 定位：fisheye 原来只有两路信息源——B站（官方 API）和本地文件。
// YouTube / 抖音 / Twitter 这些平台没有统一的公开 API，但 yt-dlp 一个二进制就能抓，
// 下载完的视频和用户手动放进来的本地文件没有任何区别，所以这里只负责「拿到一个视频路径」，
// 后续抽帧、字幕、预算分配全部复用现成流程。
//
// 设计约束（和 audio.mjs 一致）：
// · 零 npm 依赖，Node ≥18
// · 子进程一律 spawnSync；下载主流程 stdio:'ignore'（沙箱禁管道捕获），
//   探测类命令（where / --version）把 stdout+stderr 重定向到临时文件再读
// · 这是**可选能力**：没有 yt-dlp / URL 非法 / 网络失败 / 超时一律返回 null，绝不让整个看片流程失败
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { FFMPEG, PKG_DIR } from './env.mjs'
import { IS_WIN, EXE, stripQuotes, readText, tmpFile, capture, whereAll, spawnable, resolveFfmpeg } from './proc.mjs'


// yt-dlp 在 PATH 上的命令名；Windows 下 where 能靠 PATHEXT 命中 yt-dlp.exe
const YTDLP_NAMES = ['yt-dlp', 'yt-dlp.exe']

// 下载产物可能是这几种容器（--merge-output-format mp4 时是 mp4，降级单文件时可能是 webm/mkv）
const MEDIA_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.flv', '.ts'])

// -f 选择器：默认 best video + best audio，合不上时退回「最佳单文件」
const QUALITY = {
  best: 'bv*+ba/b',
  '2160': 'bv*[height<=2160]+ba/b[height<=2160]/b',
  '1440': 'bv*[height<=1440]+ba/b[height<=1440]/b',
  '1080': 'bv*[height<=1080]+ba/b[height<=1080]/b',
  '720': 'bv*[height<=720]+ba/b[height<=720]/b',
  '480': 'bv*[height<=480]+ba/b[height<=480]/b',
}

// --version 探测要启动一次单文件 exe（约 0.3~2s），findYtdlp / ytdlpCaps / downloadVideo 都会调，缓存一次
const versionCache = new Map()


// yt-dlp --version 输出形如 2026.10.26（nightly 多一段数字），用它确认「这个文件真的是 yt-dlp」
function looksLikeVersion(text) {
  return /^\d{4}\.\d{2}\.\d{2}/m.test(String(text ?? '').trim())
}

function versionOf(cmd) {
  const key = String(cmd).toLowerCase()
  if (versionCache.has(key)) return versionCache.get(key)
  const r = capture(cmd, ['--version'], 10000)
  const version = looksLikeVersion(r.out) ? r.out.trim().split(/\r?\n/)[0] : null
  const info = { ok: r.ok && Boolean(version), version, status: r.status, error: r.error }
  versionCache.set(key, info)
  return info
}

// 常见安装位置：用户按 README 手动放的位置优先于系统级安装
function commonYtdlpPaths(env = process.env) {
  const home = os.homedir()
  const localAppData = stripQuotes(env.LOCALAPPDATA) || path.join(home, 'AppData', 'Local')
  return [
    path.join(home, '.dsh', 'surfcore', 'yt-dlp', EXE('yt-dlp')),
    path.join(localAppData, 'Programs', 'yt-dlp', EXE('yt-dlp')),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links', EXE('yt-dlp')),
    path.join(PKG_DIR, 'bin', EXE('yt-dlp')),
  ]
}

/**
 * 探测 yt-dlp，同时把探测过程记成 notes（给 selftest / caps 用）。
 * @returns {{ ytdlp: { cmd: string, source: string, version: string|null } | null, notes: string[] }}
 */
function findYtdlpDetailed({ env = process.env } = {}) {
  const notes = []

  // 1) 环境变量显式指定（用户可以指到任意位置的单文件 exe）
  const fromEnv = stripQuotes(env.FISHEYE_YTDLP)
  if (fromEnv) {
    if (!spawnable(fromEnv)) {
      notes.push(`FISHEYE_YTDLP=${fromEnv} 不是可执行文件，已忽略`)
    } else {
      const v = versionOf(fromEnv)
      if (v.ok) return { ytdlp: { cmd: fromEnv, source: '环境变量 FISHEYE_YTDLP', version: v.version }, notes }
      notes.push(`FISHEYE_YTDLP=${fromEnv} 跑 --version 不像 yt-dlp，已忽略`)
    }
  }

  // 2) PATH
  for (const name of YTDLP_NAMES) {
    for (const cmd of whereAll(name).filter(spawnable)) {
      const v = versionOf(cmd)
      if (v.ok) return { ytdlp: { cmd, source: `PATH（${name}）`, version: v.version }, notes }
    }
  }

  // 3) 常见安装路径（用户手动解压 yt-dlp.exe 时它通常不在 PATH 里）
  for (const cmd of commonYtdlpPaths(env)) {
    if (!fs.existsSync(cmd) || !spawnable(cmd)) continue
    const v = versionOf(cmd)
    if (v.ok) return { ytdlp: { cmd, source: '常见安装路径', version: v.version }, notes }
  }

  return { ytdlp: null, notes }
}

/**
 * 探测可用的 yt-dlp。
 * 顺序：FISHEYE_YTDLP → PATH 上的 yt-dlp → 常见路径（~/.dsh/surfcore/yt-dlp、%LOCALAPPDATA%\Programs\yt-dlp、项目 bin/）。
 * @param {{ env?: NodeJS.ProcessEnv, ffmpeg?: string }} [opts]
 * @returns {{ cmd: string, ffmpeg: string|null, version: string|null, source: string } | null}
 */
export function findYtdlp({ env, ffmpeg } = {}) {
  try {
    const e = env ?? process.env
    const { ytdlp } = findYtdlpDetailed({ env: e })
    if (!ytdlp) return null
    return {
      cmd: ytdlp.cmd,
      ffmpeg: resolveFfmpeg({ env: e, explicit: ffmpeg }),
      version: ytdlp.version,
      source: ytdlp.source,
    }
  } catch {
    return null
  }
}

/**
 * 能力描述（给 CLI / selftest 打印用）。
 * available 为 true 表示「现在能把一个平台 URL 下成视频文件」。
 * 没有 ffmpeg 仍然可用，只是退化为单文件格式（不少平台没有单文件高清流，画质会低一些）。
 * @param {{ env?: NodeJS.ProcessEnv, ffmpeg?: string, ytdlp?: object }} [options]
 * @returns {{ available: boolean, reason: string, summary: string, hint: string|null,
 *             cmd: string|null, ffmpeg: string|null, version: string|null, notes: string[] }}
 */
export function ytdlpCaps(options = {}) {
  const env = options.env ?? process.env
  try {
    const detail = options.ytdlp
      ? { ytdlp: options.ytdlp, notes: [] }
      : findYtdlpDetailed({ env })
    const y = detail.ytdlp
    const ffmpeg = resolveFfmpeg({ env, explicit: options.ffmpeg })
    const caps = {
      available: false,
      reason: '',
      summary: '',
      hint: null,
      cmd: y?.cmd ?? null,
      version: y?.version ?? null,
      ffmpeg: ffmpeg ?? null,
      notes: detail.notes ?? [],
    }

    if (!y) {
      caps.reason = '未找到 yt-dlp（已试 FISHEYE_YTDLP / PATH / ~/.dsh/surfcore/yt-dlp / %LOCALAPPDATA%\\Programs\\yt-dlp / 项目 bin/）'
      caps.hint = '从 https://github.com/yt-dlp/yt-dlp/releases/latest 下载 yt-dlp.exe 放到 ~/.dsh/surfcore/yt-dlp/，'
        + '或设 FISHEYE_YTDLP=<yt-dlp 完整路径>'
    } else {
      caps.available = true
      const bits = [`yt-dlp ${y.version ?? ''}（${path.basename(y.cmd)}，${y.source}）`.replace('  ', ' ')]
      if (ffmpeg) bits.push(`ffmpeg ${path.basename(ffmpeg)}（合并音视频）`)
      else bits.push('无 ffmpeg（降级单文件格式，画质受限）')
      caps.reason = bits.join('；')
      if (!ffmpeg) caps.hint = '设 FFMPEG=<ffmpeg 完整路径> 或把 ffmpeg 装到 PATH，才能合并 1080p+ 的分离音视频流'
    }

    caps.summary = `通用平台视频（yt-dlp）：${caps.available ? '可用' : '不可用'} —— ${caps.reason}`
    return caps
  } catch (e) {
    return {
      available: false,
      reason: `能力探测异常：${String(e?.message ?? e).slice(0, 120)}`,
      summary: '通用平台视频（yt-dlp）：不可用 —— 能力探测异常',
      hint: null,
      cmd: null,
      version: null,
      ffmpeg: null,
      notes: [],
    }
  }
}

/**
 * 校验 URL：只接受 http/https，其余（file:、javascript:、ftp:、裸字符串）一律拒绝。
 * @returns {string|null} 归一化后的 URL
 */
function normalizeUrl(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.length > 8192) return null
  let u
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname) return null
  return u.toString()
}

// 目录里 sinceMs 之后生成的最新媒体文件（排除 .part / .ytdl 半成品）
function newestMedia(dir, sinceMs) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return null }
  let best = null
  for (const n of names) {
    if (n.startsWith('.')) continue
    const ext = path.extname(n).toLowerCase()
    if (!MEDIA_EXT.has(ext)) continue
    if (/\.(part|ytdl|temp)$/i.test(n)) continue
    const full = path.join(dir, n)
    try {
      const st = fs.statSync(full)
      if (!st.isFile() || st.size === 0) continue
      if (st.mtimeMs < sinceMs) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs }
    } catch { /* 跳过读不到的文件 */ }
  }
  return best?.file ?? null
}

/**
 * 用 yt-dlp 把一个平台 URL 下载成视频文件（放进 outDir）。
 *
 * @param {string} url        http(s) 视频页链接
 * @param {string} outDir     产物目录（不存在会自动创建）
 * @param {{ timeoutMs?: number, quiet?: boolean, quality?: 'best'|'2160'|'1440'|'1080'|'720'|'480',
 *           ytdlp?: object, ffmpeg?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ file: string, cmd: string } | null} 失败 / 超时 / 无 yt-dlp / URL 非法 → null（不抛）
 */
export function downloadVideo(url, outDir, options = {}) {
  const env = options.env ?? process.env
  const quiet = options.quiet === true
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 600000
  const warn = (msg) => { if (!quiet) console.warn(`[yt-dlp] ${msg}`) }

  try {
    const target = normalizeUrl(url)
    if (!target) {
      warn(`跳过下载：不是合法的 http(s) 链接（${String(url ?? '').slice(0, 120) || '(空)'}）`)
      return null
    }

    if (!outDir || typeof outDir !== 'string') {
      warn('没有指定输出目录，跳过下载')
      return null
    }

    const found = options.ytdlp ?? findYtdlp({ env, ffmpeg: options.ffmpeg })
    if (!found?.cmd) {
      warn('没有 yt-dlp，跳过下载（放一个 yt-dlp.exe 到 ~/.dsh/surfcore/yt-dlp/ 或设 FISHEYE_YTDLP）')
      return null
    }

    const dir = path.resolve(outDir)
    fs.mkdirSync(dir, { recursive: true })

    const quality = QUALITY[String(options.quality ?? 'best')] ? String(options.quality ?? 'best') : 'best'
    const started = Date.now() - 2000 // 给文件系统 mtime 精度留余量

    // --no-playlist：只下一个视频，别把整个播放列表拖下来
    const args = ['--no-playlist']
    if (found.ffmpeg) {
      args.push('-f', QUALITY[quality], '--merge-output-format', 'mp4')
      // ffmpeg 不在 PATH 时（本机就在 surfcore\bili\bin），必须显式告诉 yt-dlp 去哪找
      args.push('--ffmpeg-location', path.dirname(found.ffmpeg))
    } else {
      // 没有 ffmpeg 就无法合并分离的音视频流，退回「最佳单文件」
      args.push('-f', 'b')
    }
    args.push('-o', path.join(dir, '%(title).80s [%(id)s].%(ext)s'))
    args.push(target)

    warn(`下载中（quality=${quality}，最多等 ${Math.round(timeoutMs / 1000)}s）：${target}`)
    const r = spawnSync(found.cmd, args, {
      stdio: 'ignore',
      timeout: timeoutMs,
      windowsHide: true,
      env,
    })

    const timedOut = Boolean(r.error)
      && (r.error.code === 'ETIMEDOUT' || r.error.errno === 'ETIMEDOUT' || r.signal === 'SIGTERM')
    if (timedOut) {
      warn(`下载超时（${Math.round(timeoutMs / 1000)}s），放弃：${target}`)
      return null
    }
    if (r.error) {
      warn(`启动 yt-dlp 失败：${String(r.error.message ?? r.error).slice(0, 160)}`)
      return null
    }

    // 成功时优先取本次新生成的文件；失败时隔一段时间才出现的半成品也不认
    let file = newestMedia(dir, started)
    if (!file && r.status === 0) {
      // yt-dlp 遇到同名已存在文件会直接跳过，此时 mtime 是旧的 —— 退回目录里最新的媒体文件
      file = newestMedia(dir, 0)
      if (file) warn(`没有发现本次新生成的文件，使用 outDir 里最新的：${path.basename(file)}`)
    }
    if (!file) {
      warn(`yt-dlp 退出码 ${r.status}，outDir 里没有可用的视频文件：${dir}`)
      return null
    }

    return { file, cmd: found.cmd }
  } catch (e) {
    warn(`下载异常：${String(e?.message ?? e).slice(0, 160)}`)
    return null
  }
}
