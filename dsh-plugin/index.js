/**
 * dsh-fisheye — 给 DSH agent 的 video_understand 工具。
 *
 * 把 B 站 BV 号 / 本地视频 / 任意视频链接交给 fisheye CLI 处理，
 * 返回拼图路径、字幕/转写要点与 manifest 摘要（token 预算感知）。
 * 上游职责：只负责"看视频"，摘要与下游消费交给其他插件/模型。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-fisheye'
export const inject = ['tools']

const DEFAULT_FISHEYE = 'fisheye.mjs'

/** 找 fisheye 入口：显式配置 > 环境变量 > PATH 上的 fisheye > 常见位置。 */
function resolveFisheye(config) {
  const candidates = []
  if (config.fisheyePath) candidates.push(config.fisheyePath)
  if (process.env.FISHEYE_CLI) candidates.push(process.env.FISHEYE_CLI)
  // npm 全局安装位置（npm i -g @pls-compile-owo/fisheye）
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@pls-compile-owo', 'fisheye', 'fisheye.mjs'))
  }
  candidates.push('/usr/local/lib/node_modules/@pls-compile-owo/fisheye/fisheye.mjs')
  candidates.push('/usr/lib/node_modules/@pls-compile-owo/fisheye/fisheye.mjs')
  candidates.push(DEFAULT_FISHEYE)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return path.resolve(c)
    } catch {}
  }
  return null
}

/** 跑 fisheye，返回 stdout（结果以 STD 前缀行标注，见 fisheye 输出约定）。 */
function runFisheye(cliPath, args, cwd) {
  const workDir = cwd ?? path.join(os.tmpdir(), 'dsh-fisheye-run')
  try { fs.mkdirSync(workDir, { recursive: true }) } catch {}
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workDir,
    timeout: 30 * 60 * 1000,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return {
    ok: r.status === 0,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    status: r.status,
    workDir,
  }
}

/** 从 fisheye stdout 提取产物（SHEET: / MANIFEST: / 摘要行）。 */
function parseArtifacts(stdout) {
  const sheet = []
  const manifest = []
  const notes = []
  for (const line of stdout.split('\n')) {
    const s = line.match(/^SHEET:\s*(.+)$/)
    if (s) { sheet.push(s[1].trim()); continue }
    const g = line.match(/→\s*(\S+\.(?:jpg|png|jpeg))\s*$/)
    if (g) { sheet.push(g[1].trim()); continue }
    const m = line.match(/^MANIFEST:\s*(.+)$/)
    if (m) { manifest.push(m[1].trim()); continue }
    if (/^\[(字幕|弹幕|音频|广告段|张数|预算|拼图|取帧)\]/.test(line.trim())) notes.push(line.trim())
    if (/^(时长|区间|抽帧):/.test(line.trim())) notes.push(line.trim())
  }
  return { sheet, manifest, notes }
}

export async function apply(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'video_understand',
    description:
      'Understand a video through the fisheye CLI on a token budget: prefer official subtitles, otherwise build adaptive keyframe grids, and refine close-ups only where needed. '
      + 'Returns the grid image path(s), subtitle/transcript notes and the manifest, ready for a vision model or a downstream plugin to consume. '
      + 'Supports Bilibili BV ids, local video files and any URL (yt-dlp).',
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Video to read: a Bilibili BV id (e.g. BV1WhaA6hE7s), an absolute local file path, or an http(s) URL.',
      },
      budget: {
        type: 'number',
        description: 'Token budget for this read. Defaults to 20000. The CLI may exceed it for mandatory sources and reports the estimate.',
      },
      grid: {
        type: 'string',
        enum: ['3x3', '4x4', '5x5'],
        description: 'Grid density: 3x3 for short/simple videos, 4x4 or 5x5 for long or fast-cut videos.',
      },
      range: {
        type: 'string',
        description: 'Optional time range as "from-to" in seconds or m:ss, e.g. "1:30-5:00". Reads only that segment.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sheets: { type: 'array', required: true, items: { type: 'string' } },
          manifests: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `fisheye read ok: ${value.sheets.length} grid(s), ${value.notes.length} note line(s).`
          : `fisheye failed: ${value.error ?? 'unknown error'}`,
      }],
    },
    execute(args) {
      const cli = resolveFisheye(config)
      if (!cli) {
        return Promise.resolve({
          ok: false,
          sheets: [],
          manifests: [],
          notes: [],
          error: 'fisheye CLI not found. Install it (npm i -g @pls-compile-owo/fisheye) or set config.fisheyePath to fisheye.mjs.',
        })
      }
      const modal = String(args.input ?? '').trim()
      if (!modal) {
        return Promise.resolve({ ok: false, sheets: [], manifests: [], notes: [], error: 'empty input' })
      }
      const isLocal = fs.existsSync(modal)
      const cliArgs = []
      if (isLocal) {
        cliArgs.push('local', modal)
        if (args.grid) cliArgs.push('--grid', args.grid)
      } else if (/^BV[0-9A-Za-z]{10}$/.test(modal)) {
        cliArgs.push('auto', modal, '--budget', String(args.budget ?? 20000))
      } else {
        cliArgs.push('url', modal, '--budget', String(args.budget ?? 20000))
      }
      if (args.grid && !isLocal) cliArgs.push('--grid', args.grid)
      if (args.range) {
        const [from, to] = String(args.range).split(/[-~]/).map((s) => s.trim())
        if (from) cliArgs.push('--from', from)
        if (to) cliArgs.push('--to', to)
      }
      const res = runFisheye(cli, cliArgs)
      const parsed = parseArtifacts(res.stdout)
      const outDir = path.join(res.workDir, 'out')
      parsed.sheet = parsed.sheet.map((p) => (path.isAbsolute(p) ? p : path.join(outDir, p)))
      if (!res.ok && parsed.sheet.length === 0) {
        return Promise.resolve({
          ok: false,
          sheets: [],
          manifests: [],
          notes: parsed.notes,
          error: (res.stderr || res.stdout || 'fisheye exited non-zero').slice(0, 400),
        })
      }
      return Promise.resolve({
        ok: true,
        sheets: parsed.sheet,
        manifests: parsed.manifest,
        notes: parsed.notes,
      })
    },
    presentCall: (args) => ({ card: 'generic', title: 'Read video', kind: 'other', rawInput: args.input }),
  }))
}
