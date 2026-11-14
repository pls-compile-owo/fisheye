// OCR（可选）：tesseract 命令行识别画面里的文字（截图标题、PPT、烧进画面的字幕条）
//
// 定位：fisheye 的信息源是「官方字幕 → 画面/字幕带 → 弹幕 → 音频」。画面里的文字
// （弹幕截图、PPT、标题条、烧进画面的字幕）模型只能"看图猜"，OCR 能直接给出原文，
// 让模型对照文本而不是辨认像素。
// 它是**可选能力**：找不到 tesseract / 语言包一律返回 null，绝不让整个看片流程失败。
//
// 设计约束（和项目其他模块一致）：
// · 零 npm 依赖，Node ≥18
// · 所有子进程用 spawnSync；stdout / stderr 分别重定向到临时文件（沙箱禁管道捕获），
//   分开落盘是为了不让 stderr 的 "Estimating resolution as ..." 混进正文
// · Windows 路径全部 path.join，可执行文件补 .exe
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { PKG_DIR } from './env.mjs'
import { IS_WIN, EXE, stripQuotes, readText, tmpFile, capture, whereAll, spawnable } from './proc.mjs'


// tesseract --version 每次探测都跑一遍太浪费，按 cmd 缓存
const versionCache = new Map()


function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

/** tessdata 目录：TESSDATA_PREFIX → exe 同级 tessdata → 标准 share 布局 */
function tessdataDir(cmd, env = process.env) {
  const cands = []
  const explicit = stripQuotes(env.TESSDATA_PREFIX)
  if (explicit) {
    if (isDir(explicit)) cands.push(explicit)
    // 少数分发把 TESSDATA_PREFIX 指到 "tessdata 的父目录"
    if (isDir(path.join(explicit, 'tessdata'))) cands.push(path.join(explicit, 'tessdata'))
  }
  if (cmd && (cmd.includes('/') || cmd.includes('\\'))) {
    const binDir = path.dirname(cmd)
    cands.push(
      path.join(binDir, 'tessdata'),
      path.join(binDir, '..', 'share', 'tesseract-ocr', 'tessdata'),
      path.join(binDir, '..', 'share', 'tessdata'),
      path.join(binDir, '..', 'tessdata'),
    )
  }
  for (const d of cands) if (isDir(d)) return path.resolve(d)
  return null
}

/** tessdata 里的语言包（* .traineddata 的文件名，去掉扩展名） */
function listLangs(dir) {
  if (!dir) return []
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.traineddata'))
      .map((e) => e.name.slice(0, -'.traineddata'.length))
      .sort((a, b) => a.localeCompare(b))
  } catch { return [] }
}

/** 常见安装路径（不含 PATH）；顺序按需求固定：surfcore → LOCALAPPDATA → Program Files → 项目 bin */
function commonTesseractPaths(env = process.env) {
  const home = os.homedir()
  const localApp = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  return [
    path.join(home, '.dsh', 'surfcore', 'tesseract', EXE('tesseract')),
    path.join(home, '.dsh', 'surfcore', 'tesseract', 'bin', EXE('tesseract')),
    path.join(localApp, 'Programs', 'Tesseract-OCR', EXE('tesseract')),
    path.join(localApp, 'Tesseract-OCR', EXE('tesseract')),
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
    path.join(PKG_DIR, 'bin', EXE('tesseract')),
  ]
}

// FISHEYE_TESSERACT 可能是 exe 路径 / 安装目录 / PATH 上的命令名
function resolveEnvCommand(raw, env, notes) {
  const v = stripQuotes(raw)
  if (!v) return null
  if (isDir(v)) {
    const p = path.join(v, EXE('tesseract'))
    if (fs.existsSync(p) && spawnable(p)) return path.resolve(p)
    notes.push(`FISHEYE_TESSERACT=${v} 是目录，但里面没有 ${EXE('tesseract')}`)
    return null
  }
  if (fs.existsSync(v)) {
    if (!spawnable(v)) { notes.push(`FISHEYE_TESSERACT=${v} 不是可执行文件`); return null }
    return path.resolve(v)
  }
  if (path.isAbsolute(v) || v.includes('/') || v.includes('\\')) {
    notes.push(`FISHEYE_TESSERACT 指向的文件不存在：${v}`)
    return null
  }
  const hits = whereAll(v).filter(spawnable)
  if (hits.length) return hits[0]
  notes.push(`FISHEYE_TESSERACT=${v} 在 PATH 上找不到`)
  return null
}

function describe(cmd, source, env) {
  const abs = path.resolve(cmd)
  return {
    cmd: fs.existsSync(abs) ? abs : cmd,
    binDir: path.dirname(fs.existsSync(abs) ? abs : cmd),
    tessdata: tessdataDir(abs, env),
    source,
  }
}

function findTesseractDetailed({ env = process.env } = {}) {
  const e = env ?? {}
  const notes = []

  // 1) 环境变量：显式指定优先级最高
  if (e.FISHEYE_TESSERACT) {
    const cmd = resolveEnvCommand(e.FISHEYE_TESSERACT, e, notes)
    if (cmd) return { tesseract: describe(cmd, '环境变量 FISHEYE_TESSERACT', e), notes }
  }

  // 2) PATH 上所有 tesseract 命中项
  for (const cmd of whereAll('tesseract').filter(spawnable)) {
    return { tesseract: describe(cmd, 'PATH', e), notes }
  }

  // 3) 常见安装路径（用户手动解压时它通常不在 PATH 里）
  for (const cmd of commonTesseractPaths(e)) {
    if (!fs.existsSync(cmd) || !spawnable(cmd)) continue
    return { tesseract: describe(cmd, '常见安装路径', e), notes }
  }

  return { tesseract: null, notes }
}

/**
 * 探测可用的 tesseract。
 * 探测顺序：FISHEYE_TESSERACT → PATH 上 tesseract → 常见安装路径（~/.dsh/surfcore/tesseract、
 * %LOCALAPPDATA%\Programs\Tesseract-OCR、C:\Program Files\Tesseract-OCR、项目 bin/）。
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ cmd: string, binDir: string, tessdata: string|null } | null}
 */
export function findTesseract({ env } = {}) {
  const r = findTesseractDetailed({ env: env ?? process.env })
  if (!r.tesseract) return null
  const { cmd, binDir, tessdata } = r.tesseract
  return { cmd, binDir, tessdata }
}

// --version 输出形如 "tesseract v5.4.0.20240606" / "tesseract 4.1.1"
function tesseractVersion(cmd) {
  const key = String(cmd).toLowerCase()
  if (versionCache.has(key)) return versionCache.get(key)
  const r = capture(cmd, ['--version'], 8000)
  const m = `${r.out}\n${r.err}`.match(/tesseract\s+v?([0-9][\w.-]*)/i)
  const v = m ? m[1] : null
  versionCache.set(key, v)
  return v
}

// 请求的语言里有的语言包没有时降级到交集；一个都没有返回 null
function resolveLang(requested, langs) {
  // osd 只做方向检测，不是识别语言，混进 -l 会让 tesseract 输出空页
  const want = String(requested ?? '').split('+').map((s) => s.trim()).filter(Boolean)
    .filter((l) => l.toLowerCase() !== 'osd')
  if (!want.length) return null
  if (!langs.length) return want.join('+') // 语言包目录没探到，交给 tesseract 自己找
  const have = new Set(langs.map((l) => l.toLowerCase()))
  const kept = want.filter((l) => have.has(l.toLowerCase()))
  return kept.length ? kept.join('+') : null
}

// chi_sim 会在每个汉字之间插一个空格（"你 好 世 界"），合并回"你好世界"；
// 只处理「汉字 + 空格 + 汉字」这一种相邻关系，不会动英文单词之间和中文与数字之间的空格
const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3005-\\u303f\\uff00-\\uffef'
const CJK_GAP = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g')

function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/\u000c/g, '\n') // tesseract 每页结尾的 form feed
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join('\n')
    .replace(CJK_GAP, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 能力描述（给 CLI / selftest 打印用）。
 * available 为 true 才表示「现在真的能做 OCR」：tesseract + 至少一个语言包。
 * @param {{ env?: NodeJS.ProcessEnv, tesseract?: object }} [options]
 * @returns {{ available: boolean, reason: string, summary: string, hint: string|null,
 *             cmd: string|null, binDir: string|null, langs: string[],
 *             tessdata: string|null, version: string|null, notes: string[] }}
 */
export function ocrCaps(options = {}) {
  const env = options.env ?? process.env
  try {
    const detail = options.tesseract
      ? { tesseract: { ...options.tesseract, source: 'opts.tesseract' }, notes: [] }
      : findTesseractDetailed({ env })
    const t = detail.tesseract
    const langs = t ? listLangs(t.tessdata) : []
    const hasLang = langs.some((l) => l.toLowerCase() !== 'osd')
    const version = t ? tesseractVersion(t.cmd) : null
    const caps = {
      available: false,
      reason: '',
      summary: '',
      hint: null,
      cmd: t?.cmd ?? null,
      binDir: t?.binDir ?? null,
      langs,
      tessdata: t?.tessdata ?? null,
      version,
      notes: detail.notes ?? [],
    }

    if (!t) {
      caps.reason = '未找到 tesseract 可执行文件（已试 FISHEYE_TESSERACT / PATH / 常见安装路径）'
      caps.hint = '装 tesseract 到 ~/.dsh/surfcore/tesseract，或把 tesseract.exe 放进 PATH；'
        + '中文识别还需要 tessdata/chi_sim.traineddata'
    } else if (!hasLang) {
      caps.reason = `找到 ${path.basename(t.cmd)}，但 tessdata 里没有可用的语言包（只有 osd 不算）`
      caps.hint = '把 eng.traineddata / chi_sim.traineddata 放进 tessdata 目录（或用 TESSDATA_PREFIX 指定）'
    } else {
      caps.available = true
      const bits = [
        `tesseract ${version ? `v${version}` : path.basename(t.cmd)}`,
        `语言包 ${langs.join('/')}`,
      ]
      if (t.source) bits.push(t.source)
      caps.reason = bits.join('，')
      if (!langs.some((l) => l.toLowerCase() === 'chi_sim')) {
        caps.hint = '没有 chi_sim 语言包，中文画面只能识别英文/数字；把 chi_sim.traineddata 放进 tessdata'
      }
    }

    caps.summary = `OCR：${caps.available ? '可用' : '不可用'} —— ${caps.reason}`
    return caps
  } catch (e) {
    return {
      available: false,
      reason: `能力探测异常：${String(e?.message ?? e).slice(0, 120)}`,
      summary: 'OCR：不可用 —— 能力探测异常',
      hint: null,
      cmd: null,
      binDir: null,
      langs: [],
      tessdata: null,
      version: null,
      notes: [],
    }
  }
}

/**
 * 识别一张图片里的文字（可选能力，失败不抛异常）。
 *
 * @param {string} imagePath 图片路径（png/jpg/bmp/tiff/webp 等，tesseract 支持的格式）
 * @param {{ lang?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv,
 *           tesseract?: object, quiet?: boolean }} [options]
 * @returns {{ text: string, cmd: string, lang: string } | null}
 */
export function ocrImage(imagePath, { lang = 'chi_sim+eng', timeoutMs = 30000, env = process.env, tesseract, quiet = false } = {}) {
  const warn = (msg) => { if (!quiet) console.warn(`[OCR] ${msg}`) }

  try {
    const file = imagePath ? path.resolve(String(imagePath)) : ''
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      warn(`找不到图片：${imagePath ?? '(空)'}`)
      return null
    }

    const t = tesseract ?? findTesseract({ env })
    if (!t) {
      warn('没有可用的 tesseract，跳过 OCR（装 tesseract 或设 FISHEYE_TESSERACT）')
      return null
    }

    const langs = listLangs(t.tessdata)
    const useLang = resolveLang(lang, langs)
    if (!useLang) {
      warn(`tessdata 里没有 ${lang} 对应的语言包（现有：${langs.join('/') || '无'}）`)
      return null
    }
    if (useLang !== lang) warn(`语言包不全：${lang} → 改用 ${useLang}`)

    // tesseract <img> stdout [--tessdata-dir <dir>] -l <lang>
    const args = [file, 'stdout']
    const tessdata = t.tessdata ? path.resolve(t.tessdata) : null
    if (tessdata) args.push('--tessdata-dir', tessdata)
    args.push('-l', useLang)

    const r = capture(t.cmd, args, timeoutMs)
    if (!r.ok) {
      const why = r.error?.code === 'ETIMEDOUT' ? '超时' : (r.error?.code ?? `退出码 ${r.status}`)
      const detail = (r.err || r.out).trim().split(/\r?\n/)[0]?.slice(0, 160) ?? ''
      warn(`tesseract 执行失败（${why}）${detail ? `：${detail}` : ''}`)
      return null
    }

    const text = normalizeText(r.out)
    if (!text) {
      warn('识别结果为空（画面里可能没有可读文字）')
      return null
    }
    return { text, cmd: t.cmd, lang: useLang }
  } catch (e) {
    warn(`OCR 异常：${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`)
    return null
  }
}
