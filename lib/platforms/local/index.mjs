// lib/platforms/local/index.mjs — 本地文件平台适配器
import fs from 'node:fs'
import path from 'node:path'
import { probeDuration } from '../_probe.mjs'
import { DEFAULT_KEYWORDS } from '../../danmaku.mjs'

export default {
  id: 'local',
  name: '本地文件',
  description: '本地视频文件',
  requires: { tools: ['ffmpeg'] },

  match(input) {
    if (typeof input !== 'string' || !input || input.startsWith('--') || /^https?:\/\//i.test(input)) return null
    const p = path.resolve(input)
    if (!fs.existsSync(p)) return null
    // id 必须是文件名安全的（用于 cache/out/manifest 文件名），完整路径单独存 file
    const base = path.basename(p, path.extname(p)).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'video'
    return { id: `local-${base}`, file: p }
  },

  createSource(match) {
    const file = match.file
    return {
      kind: 'local',
      id: match.id,
      label: path.basename(file),

      async meta() {
        const duration = probeDuration(file)
        return {
          title: path.basename(file),
          duration: duration ?? 0,
          owner: null,
          dimension: { width: null, height: null },
          pages: [{ cid: null, duration: duration ?? 0, part: '' }],
        }
      },

      async media() { return file },      // 直接用文件，无需下载

      async subtitles() { return null },  // 无官方字幕 → 主流程走转写 / 字幕带兜底
      async danmaku() { return null },    // 无弹幕

      adDetector: {
        // 无弹幕：台词族（字幕/转写关键词 + 句式）。生效依赖「转写 segments 喂入」，见 stages.detectAds
        keywords: DEFAULT_KEYWORDS,
        signals: ['sub-keywords', 'sub-patterns'],
      },
    }
  },
}
