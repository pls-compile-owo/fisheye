// 音频转写（可选）：ffmpeg 抽 16kHz 单声道 wav → whisper.cpp / whisper-cli / openai-whisper → txt
//
// 定位：fisheye 的信息源顺序是「官方字幕 → 画面/字幕带 → 弹幕」，音频转写是第四路补强：
// 没有官方字幕、字幕又烧在画面里看不清时，听一遍比只看图准。
// 它是**可选能力**：找不到 whisper / 模型 / ffmpeg 一律返回 null，绝不让整个看片流程失败。
//
// 设计约束（和项目其他模块一致）：
// · 零 npm 依赖，Node ≥18
// · 所有子进程用 spawnSync；ffmpeg / whisper 主流程 stdio:'ignore'（沙箱禁管道捕获），
//   需要读输出的探测（where / --help）把 stdout+stderr 重定向到临时文件再读
// · Windows 路径全部 path.join，可执行文件补 .exe
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { FFMPEG, PKG_DIR } from './env.mjs'
import { IS_WIN, EXE, stripQuotes, readText, tmpFile, capture, whereAll, spawnable, resolveFfmpeg } from './proc.mjs'

// 探测顺序按需求固定：FISHEYE_WHISPER → whisper-cli → whisper → main → 常见安装路径
const WHISPER_NAMES = ['whisper-cli', 'whisper', 'main']
// arm64 macOS 官方产物命名是 whisper-cpp-darwin-arm64 之类：按前缀通配
const WHISPER_PREFIX = 'whisper-cpp-'

// 自动发现模型时的偏好：CPU 上 base/small 就够字幕场景，大的留给用户显式指定
const MODEL_PRIORITY = ['base', 'small', 'medium', 'large-v3', 'large', 'tiny']

// --help 探测很便宜但会被 findWhisper / audioCaps / transcribeAudio 反复调用，缓存一次
const helpCache = new Map()

// where / which / spawn 探测已抽到 lib/proc.mjs（三个可选能力共用）



// whisper.cpp（含旧版 main）和 openai-whisper 的帮助里一定带这些参数之一
function looksLikeWhisper(text) {
  const t = String(text ?? '')
  if (!t) return false
  if (/--output[_-](?:txt|json|srt|vtt)|--output[_-]format|--output[_-]dir|--word[_-]timestamps/i.test(t)) return true
  if (/(?:^|[\s,])-o(?:txt|json|srt|vtt)(?:[\s,]|$)/m.test(t)) return true
  // whisper.cpp 的 -m/--model 与 -f/--file 组合；openai-whisper 没有 -f
  if (/(?:-m|--model)\s+\S+/i.test(t) && /(?:-f|--file)\s+\S+/i.test(t)) return true
  return false
}

// 两套参数体系：whisper.cpp 一套，openai-whisper（pip 装的 whisper 命令）一套
function detectKind(text, cmd) {
  const t = String(text ?? '')
  if (/--output[_-]dir|--output[_-]format|--word[_-]timestamps/i.test(t)) return 'openai'
  if (/--output-txt|--output-json|--output-srt|--print-progress|--no-prints|whisper\.cpp/i.test(t)) return 'cpp'
  const base = path.basename(String(cmd ?? '')).toLowerCase().replace(/\.exe$/, '')
  if (base === 'main' || base.startsWith('whisper-cli')) return 'cpp'
  return 'auto'
}

function inspect(cmd) {
  const key = String(cmd).toLowerCase()
  if (helpCache.has(key)) return helpCache.get(key)
  let r = capture(cmd, ['--help'], 8000)
  // 少数构建只认 -h，或 --help 什么都不打
  if (!r.out.trim()) r = capture(cmd, ['-h'], 8000)
  const info = {
    ok: r.ok,
    status: r.status,
    error: r.error,
    text: r.out,
    whisper: looksLikeWhisper(r.out),
    kind: detectKind(r.out, cmd),
    supportsJson: /--output-json|(?:^|[\s,])-oj(?:[\s,]|$)/m.test(r.out),
  }
  helpCache.set(key, info)
  return info
}

/** 常见安装路径：先看已知目录，再让 where 兜底 */
function commonWhisperPaths(env = process.env) {
  const home = os.homedir()
  const localApp = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const names = WHISPER_NAMES.map(EXE)
  const dirs = [
    path.join(home, 'whisper.cpp'),
    path.join(home, 'whisper.cpp', 'build', 'bin'),
    path.join(home, 'whisper.cpp', 'build', 'bin', 'Release'),
    path.join(home, 'Documents', 'whisper.cpp', 'build', 'bin', 'Release'),
    path.join(localApp, 'whisper'),
    path.join(localApp, 'Programs', 'whisper'),
    path.join(PKG_DIR, 'bin'),
    path.join(PKG_DIR, '..', 'whisper'),
    'C:\\whisper.cpp',
    'C:\\whisper.cpp\\build\\bin\\Release',
    'C:\\Tools\\whisper',
  ]
  const out = []
  const seen = new Set()
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n)
      const key = p.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(p)
    }
  }
  return out
}

// 环境变量给的可能是完整路径、带引号的路径，或 PATH 上的命令名
function resolveEnvCommand(raw, notes) {
  const v = stripQuotes(raw)
  if (!v) return null
  if (fs.existsSync(v)) return v
  if (path.isAbsolute(v) || v.includes('/') || v.includes('\\')) {
    notes.push(`FISHEYE_WHISPER 指向的文件不存在：${v}`)
    return null
  }
  const hits = whereAll(v).filter(spawnable)
  if (hits.length) return hits[0]
  notes.push(`FISHEYE_WHISPER=${v} 在 PATH 上找不到`)
  return null
}

function modelDirs(cmd, env = process.env) {
  const home = os.homedir()
  const localApp = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const dirs = []
  // whisper 可执行文件旁边 / build/bin 往上一层的 models/
  if (cmd && (cmd.includes('/') || cmd.includes('\\'))) {
    const d = path.dirname(cmd)
    dirs.push(d, path.join(d, 'models'), path.join(d, '..', 'models'), path.join(d, '..', '..', 'models'))
  }
  const explicitDir = stripQuotes(env.FISHEYE_WHISPER_MODEL_DIR)
  if (explicitDir) dirs.unshift(explicitDir)
  dirs.push(
    path.join(home, '.cache', 'whisper'),
    path.join(home, 'whisper.cpp', 'models'),
    path.join(home, 'Documents', 'whisper.cpp', 'models'),
    path.join(localApp, 'whisper', 'models'),
    path.join(PKG_DIR, 'models'),
    path.join(PKG_DIR, '..', 'models'),
    'C:\\whisper.cpp\\models',
    'C:\\Tools\\whisper\\models',
  )
  const out = []
  const seen = new Set()
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue
      const key = d.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(d)
    } catch { /* 目录读不了就跳过 */ }
  }
  return out
}

function isModelFile(name, kind) {
  const n = String(name).toLowerCase()
  if (kind === 'openai') return n.endsWith('.pt')
  return /^ggml[-_].+\.(bin|ggml)$/.test(n) || /(whisper|model).*\.bin$/.test(n) || n.endsWith('.ggml')
}

// 同名档位里优先多语种：.en 模型会把中文语音转成英文
function rankModel(file) {
  const n = path.basename(file).toLowerCase()
  const i = MODEL_PRIORITY.findIndex((k) => n.includes(k))
  let rank = i < 0 ? MODEL_PRIORITY.length : i
  if (/(^|[-_.])en([-_.]|$)/.test(n)) rank += 0.5
  return rank
}

function listModels(dirs, kind) {
  const files = []
  for (const d of dirs) {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (!e.isFile() || !isModelFile(e.name, kind)) continue
      files.push(path.join(d, e.name))
    }
  }
  return files
}

function scanModels(dirs, kind) {
  const files = listModels(dirs, kind)
  if (!files.length) return null
  files.sort((a, b) => rankModel(a) - rankModel(b) || a.localeCompare(b))
  return files[0]
}

function findNamedModel(dirs, name, kind) {
  const want = String(name).toLowerCase()
  const hits = listModels(dirs, kind).filter((f) => path.basename(f).toLowerCase().includes(want))
  if (!hits.length) return null
  hits.sort((a, b) => rankModel(a) - rankModel(b) || a.localeCompare(b))
  return hits[0]
}

/**
 * 找模型：
 * · FISHEYE_WHISPER_MODEL 是文件 → 直接用（用户显式指定就尊重）
 * · 是目录 → 在目录里扫
 * · 是裸名字（base/small）→ 先在本机同名文件里匹配；openai-whisper 允许直接传名字
 * · 没设 → 在常见目录里自动发现 ggml-*.bin（cpp）或 *.pt（openai）
 */
function findModel({ cmd, kind, env = process.env }) {
  const dirs = modelDirs(cmd, env)
  const wanted = stripQuotes(env.FISHEYE_WHISPER_MODEL)

  if (wanted) {
    if (fs.existsSync(wanted)) {
      try {
        if (fs.statSync(wanted).isDirectory()) {
          const m = scanModels([wanted, ...dirs], kind)
          if (m) return { model: m, from: `${wanted}（目录）` }
          return { model: null, error: `FISHEYE_WHISPER_MODEL 目录里没有可用模型：${wanted}` }
        }
      } catch { /* 落回按文件处理 */ }
      return { model: wanted, from: 'FISHEYE_WHISPER_MODEL' }
    }
    if (!wanted.includes('/') && !wanted.includes('\\')) {
      const named = findNamedModel(dirs, wanted, kind)
      if (named) return { model: named, from: `FISHEYE_WHISPER_MODEL=${wanted}（本地匹配）` }
      if (kind === 'openai') return { model: wanted, from: `FISHEYE_WHISPER_MODEL=${wanted}（模型名）` }
      return { model: null, error: `FISHEYE_WHISPER_MODEL=${wanted} 在本机找不到对应模型（需要 ggml-*.bin 的完整路径）` }
    }
    return { model: null, error: `FISHEYE_WHISPER_MODEL 指向的文件不存在：${wanted}` }
  }

  const found = scanModels(dirs, kind)
  if (found) return { model: found, from: path.dirname(found) }
  // openai-whisper 可以把模型名交给命令自己下载；whisper.cpp 必须有本地 ggml 文件
  if (kind === 'openai') return { model: 'base', from: '默认 base（首次运行会下载）' }
  return { model: null, error: '没找到 ggml-*.bin 模型（放到 项目 bin/ 或 PATH/，或用 FISHEYE_WHISPER_MODEL 指定）' }
}

function buildWhisper(cmd, info, source, env) {
  const m = findModel({ cmd, kind: info.kind, env })
  return {
    cmd,
    model: m.model,
    modelFrom: m.from ?? null,
    modelError: m.error ?? null,
    kind: info.kind,
    source,
    supportsJson: info.supportsJson === true,
  }
}

function findWhisperDetailed({ env = process.env } = {}) {
  const notes = []

  // 1) 环境变量：显式指定优先级最高
  if (env.FISHEYE_WHISPER) {
    const cmd = resolveEnvCommand(env.FISHEYE_WHISPER, notes)
    if (cmd) {
      const info = inspect(cmd)
      if (info.whisper) {
        return { whisper: buildWhisper(cmd, info, '环境变量 FISHEYE_WHISPER', env), notes }
      }
      const why = info.error?.code
        ? `无法执行：${info.error.code}`
        : (info.text.trim() ? '帮助输出不匹配' : '没有帮助输出')
      notes.push(`FISHEYE_WHISPER=${stripQuotes(env.FISHEYE_WHISPER)} 不像 whisper（${why}）`)
    }
  }

  // 2) PATH：严格按 whisper-cli → whisper → main 的顺序
  // PATH 上以 whisper-cpp- 开头的产物（如 whisper-cpp-darwin-arm64）也算候选
  for (const hit of whereAll(WHISPER_PREFIX).filter(spawnable)) {
    const info = inspect(hit)
    if (info) return buildWhisper(hit, info, 'PATH（whisper-cpp 产物）', env)
  }
  for (const name of WHISPER_NAMES) {
    const all = whereAll(name)
    const hits = all.filter(spawnable)
    if (all.length && !hits.length) {
      notes.push(`PATH 上的 ${name} 只命中了 ${path.basename(all[0]).toLowerCase()}（不是 whisper，已忽略）`)
    }
    for (const cmd of hits) {
      const info = inspect(cmd)
      if (info.whisper) {
        return { whisper: buildWhisper(cmd, info, `PATH（${name}）`, env), notes }
      }
    }
  }

  // 3) 常见安装路径（用户手动解压 whisper.cpp 时它通常不在 PATH 里）
  for (const cmd of commonWhisperPaths(env)) {
    if (!fs.existsSync(cmd) || !spawnable(cmd)) continue
    const info = inspect(cmd)
    if (info.whisper) {
      return { whisper: buildWhisper(cmd, info, '常见安装路径', env), notes }
    }
  }

  return { whisper: null, notes }
}

/**
 * 探测可用的 whisper。
 * @param {{ ffmpeg?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ cmd: string, model: string|null, kind: 'cpp'|'openai'|'auto', source: string,
 *             supportsJson: boolean, modelFrom: string|null, modelError: string|null } | null}
 */
export function findWhisper({ ffmpeg, env } = {}) {
  void ffmpeg // 抽音频时才用；保留参数是为了和 audioCaps/transcribeAudio 的调用签名一致
  const r = findWhisperDetailed({ env: env ?? process.env })
  if (!r.whisper) return null
  const w = r.whisper
  return {
    cmd: w.cmd,
    model: w.model,
    kind: w.kind,
    source: w.source,
    supportsJson: w.supportsJson,
    modelFrom: w.modelFrom,
    modelError: w.modelError,
  }
}

// ffmpeg 解析已抽到 lib/proc.mjs



/**
 * 能力描述（给 CLI / selftest 打印用）。
 * available 为 true 才表示「现在真的能转写」：whisper + 模型 + ffmpeg 三者齐了。
 * @param {{ ffmpeg?: string, env?: NodeJS.ProcessEnv, whisper?: object }} [options]
 * @returns {{ available: boolean, reason: string, summary: string, hint: string|null,
 *             whisper: boolean, ffmpeg: string|null, cmd: string|null, model: string|null,
 *             kind: string|null, notes: string[] }}
 */
export function audioCaps(options = {}) {
  const env = options.env ?? process.env
  try {
    const ffmpeg = resolveFfmpeg({ env, explicit: options.ffmpeg })
    const detail = options.whisper
      ? { whisper: options.whisper, notes: [] }
      : findWhisperDetailed({ env })
    const w = detail.whisper
    const caps = {
      available: false,
      reason: '',
      summary: '',
      hint: null,
      whisper: Boolean(w),
      ffmpeg: ffmpeg ?? null,
      cmd: w?.cmd ?? null,
      model: w?.model ?? null,
      kind: w?.kind ?? null,
      notes: detail.notes ?? [],
    }

    if (!w) {
      caps.reason = '未找到 whisper 可执行文件（已试 FISHEYE_WHISPER / whisper-cli / whisper / main / 常见安装路径）'
      caps.hint = '装 whisper.cpp 后设 FISHEYE_WHISPER=<whisper-cli 或 main 的完整路径>；'
        + '模型放 项目 bin/ 或 PATH/，或用 FISHEYE_WHISPER_MODEL 指定 ggml-*.bin'
    } else if (!w.model) {
      caps.reason = w.modelError || '找到 whisper，但找不到可用的模型'
      caps.hint = '把 ggml-*.bin 放到 项目 bin/ 或 PATH/，或设 FISHEYE_WHISPER_MODEL=<模型完整路径>'
    } else if (!ffmpeg) {
      caps.reason = '找到 whisper，但缺少 ffmpeg（抽 16kHz wav 必需）'
      caps.hint = '设 FFMPEG=<ffmpeg 完整路径>，或把 ffmpeg 装到 PATH'
    } else {
      caps.available = true
      const bits = [`whisper ${path.basename(w.cmd)}（${w.source}）`, `模型 ${path.basename(w.model)}`]
      if (w.modelFrom && w.modelFrom !== path.dirname(w.model)) bits.push(w.modelFrom)
      bits.push(`ffmpeg ${path.basename(ffmpeg)}`)
      caps.reason = bits.join('，')
    }

    caps.summary = `音频转写：${caps.available ? '可用' : '不可用'} —— ${caps.reason}`
    return caps
  } catch (e) {
    return {
      available: false,
      reason: `能力探测异常：${String(e?.message ?? e).slice(0, 120)}`,
      summary: `音频转写：不可用 —— 能力探测异常`,
      hint: null,
      whisper: false,
      ffmpeg: null,
      cmd: null,
      model: null,
      kind: null,
      notes: [],
    }
  }
}

function buildWhisperArgs(kind, { model, wav, outDir, prefix, lang, supportsJson }) {
  if (kind === 'cpp') {
    // whisper.cpp / whisper-cli：-otxt 落 txt；-oj 只有新版支持（help 里探测过才加）
    const args = ['-m', model, '-f', wav, '-otxt', '-of', prefix]
    if (lang && lang !== 'auto') args.push('-l', String(lang))
    if (supportsJson) args.push('-oj')
    return args
  }
  // openai-whisper：输入文件在前，模型可以是名字（base/small）或 .pt 路径
  const args = [wav, '--model', model, '--output_dir', outDir, '--output_format', 'txt']
  if (lang && lang !== 'auto') args.push('--language', String(lang))
  return args
}

function findTranscript(kind, { prefix, wav, outDir }) {
  const cands = kind === 'cpp'
    ? [`${prefix}.txt`]
    : [path.join(outDir, `${path.basename(wav, path.extname(wav))}.txt`), `${prefix}.txt`]
  for (const f of cands) {
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > 0) return f
    } catch { /* 下一个 */ }
  }
  return null
}

// whisper.cpp 的 -oj 输出 { transcription: [{ offsets: {from,to}, text }] }，offset 是毫秒
function readSegments(jsonFile) {
  try {
    const j = JSON.parse(readText(jsonFile))
    const arr = Array.isArray(j)
      ? j
      : (Array.isArray(j?.transcription) ? j.transcription : (Array.isArray(j?.segments) ? j.segments : []))
    const segs = []
    for (const s of arr) {
      const text = String(s?.text ?? '').trim()
      if (!text) continue
      const start = typeof s?.start === 'number' ? s.start
        : (typeof s?.offsets?.from === 'number' ? s.offsets.from / 1000 : undefined)
      const end = typeof s?.end === 'number' ? s.end
        : (typeof s?.offsets?.to === 'number' ? s.offsets.to / 1000 : undefined)
      const seg = { text }
      if (Number.isFinite(start)) seg.start = Number(start.toFixed(3))
      if (Number.isFinite(end)) seg.end = Number(end.toFixed(3))
      segs.push(seg)
    }
    return segs.length ? segs : null
  } catch { return null }
}

function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 转写一个视频里的音频（可选能力，失败不抛异常）。
 *
 * @param {string} mp4Path 视频文件（mp4/mkv/... 只要有音轨）
 * @param {string} outDir  产物目录：txt 留在这里，wav 默认用完删除
 * @param {{
 *   ffmpeg?: string, whisper?: object, model?: string, env?: NodeJS.ProcessEnv,
 *   lang?: string, ffmpegTimeoutMs?: number, timeoutMs?: number,
 *   keepWav?: boolean, quiet?: boolean
 * }} [options]
 * @returns {{ text: string, segments?: { start?: number, end?: number, text: string }[],
 *             cmd: string, model: string, kind: string, file: string } | null}
 */
export function transcribeAudio(mp4Path, outDir, options = {}) {
  const env = options.env ?? process.env
  const quiet = options.quiet === true
  const warn = (msg) => { if (!quiet) console.warn(`[音频] ${msg}`) }
  let wav = null

  try {
    const file = mp4Path ? path.resolve(String(mp4Path)) : ''
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      warn(`找不到视频文件：${mp4Path ?? '(空)'}`)
      return null
    }

    const ffmpeg = resolveFfmpeg({ env, explicit: options.ffmpeg })
    if (!ffmpeg) {
      warn('没有 ffmpeg，跳过音频转写（设 FFMPEG 环境变量或把 ffmpeg 装到 PATH）')
      return null
    }

    let w = options.whisper ?? findWhisper({ ffmpeg, env })
    if (!w) {
      warn('没有可用的 whisper，跳过音频转写（装 whisper.cpp 或设 FISHEYE_WHISPER）')
      return null
    }
    if (options.model) w = { ...w, model: options.model, modelFrom: 'options.model', modelError: null }
    if (!w.model) {
      warn(`找到 ${path.basename(w.cmd)}，但没有模型：${w.modelError ?? '未知原因'}（用 FISHEYE_WHISPER_MODEL 指定）`)
      return null
    }

    const dir = path.resolve(outDir || path.join(os.tmpdir(), 'fisheye-audio'))
    fs.mkdirSync(dir, { recursive: true })
    const id = `${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`
    wav = path.join(dir, `audio-${id}.wav`)
    const prefix = path.join(dir, `audio-${id}`)

    // 1) 抽音频：16kHz 单声道 wav（whisper 全家都吃这个格式）
    const ff = spawnSync(ffmpeg, [
      '-y', '-loglevel', 'error', '-i', file,
      '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav,
    ], { stdio: 'ignore', timeout: options.ffmpegTimeoutMs ?? 900000, windowsHide: true })

    if (ff.status !== 0 || !fs.existsSync(wav)) {
      warn('抽取音频失败（视频可能没有音轨，或 ffmpeg 解码出错）')
      return null
    }
    if (fs.statSync(wav).size <= 1024) {
      warn('抽出来的音频几乎为空（视频可能没有音轨）')
      return null
    }

    // 2) 跑 whisper。kind 未知（auto）时两套参数都试一遍，反正失败得很快
    const order = w.kind === 'cpp' ? ['cpp'] : w.kind === 'openai' ? ['openai'] : ['cpp', 'openai']
    const failures = []
    for (const kind of order) {
      const args = buildWhisperArgs(kind, {
        model: w.model,
        wav,
        outDir: dir,
        prefix,
        lang: options.lang,
        supportsJson: w.supportsJson,
      })
      const run = spawnSync(w.cmd, args, {
        stdio: 'ignore',
        timeout: options.timeoutMs ?? 1800000,
        windowsHide: true,
      })
      const txt = findTranscript(kind, { prefix, wav, outDir: dir })
      if (txt) {
        const text = normalizeText(readText(txt))
        const segments = kind === 'cpp' ? readSegments(`${prefix}.json`) : null
        if (!text) warn('转写结果为空（视频里可能没有可识别的人声）')
        const out = { text, cmd: w.cmd, model: w.model, kind, file: txt }
        if (segments) out.segments = segments
        return out
      }
      const why = run.error?.code === 'ETIMEDOUT'
        ? '超时'
        : (run.error?.code ?? `退出码 ${run.status}`)
      failures.push(`${kind} 参数失败（${why}）`)
    }

    warn(`whisper 没有产出文本：${failures.join('；')}（可先用 --help 看这版参数）`)
    return null
  } catch (e) {
    warn(`转写异常：${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`)
    return null
  } finally {
    // wav 是纯中间产物，默认清掉；调试时传 keepWav:true 留证据
    if (wav && options.keepWav !== true) {
      try { fs.unlinkSync(wav) } catch {}
    }
  }
}
