// lib/platforms/_probe.mjs — 平台适配器共享工具（时长探测）
// 沙箱约束：spawnSync 不能捕获管道，ffmpeg 的 stderr 写临时文件再读。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../env.mjs'

export function probeDuration(file) {
  if (!FFMPEG) return null
  const probeTmp = path.join(os.tmpdir(), `fisheye-probe-${process.pid}-${Date.now()}.txt`)
  try {
    const fd = fs.openSync(probeTmp, 'w')
    spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', fd], timeout: 30000 })
    fs.closeSync(fd)
  } catch { /* 探测失败按 null */ }
  let text = ''
  try { text = fs.readFileSync(probeTmp, 'utf8') } catch {}
  try { fs.unlinkSync(probeTmp) } catch {}
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null
}
