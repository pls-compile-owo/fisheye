// lib/platforms/url/index.mjs — yt-dlp 通用 URL 平台适配器
import path from 'node:path'
import crypto from 'node:crypto'
import { CACHE } from '../../env.mjs'
import { ytdlpCaps, downloadVideo } from '../../ytdlp.mjs'
import { probeDuration } from '../_probe.mjs'

// URL 规范化：去掉时间戳/分享类参数，保证同一视频的哈希稳定（断点续跑不失效）
function normalizeUrl(u) {
  try {
    const url = new URL(u)
    for (const k of ['t', 'ts', 'timestamp', 'start', 'time', '_t', 'spm', 'share_source', 'share_medium', 'share_plat', 'share_session_id', 'share_tag', 'unique_k', 'vd_source']) {
      url.searchParams.delete(k)
    }
    url.hash = ''
    return url.toString()
  } catch {
    return u
  }
}

export default {
  id: 'url',
  name: '通用链接',
  description: 'yt-dlp 下载任意平台视频',
  requires: { tools: ['ffmpeg', 'yt-dlp'] },

  match(input) {
    if (typeof input !== 'string' || !/^https?:\/\//i.test(input)) return null
    // id 必须是文件名安全的（规范化后 URL 哈希），去掉时间戳参数保证断点续跑稳定
    const hash = crypto.createHash('md5').update(normalizeUrl(input)).digest('hex').slice(0, 12)
    return { id: `url-${hash}`, url: input }
  },

  createSource(match) {
    const link = match.url
    let file = null
    return {
      kind: 'url',
      id: match.id,
      label: link,

      async meta() {
        const duration = file ? probeDuration(file) : null
        return {
          title: path.basename(link).slice(0, 60) || link,
          duration: duration ?? 0,
          owner: null,
          dimension: { width: null, height: null },
          pages: [{ cid: null, duration: duration ?? 0, part: '' }],
        }
      },

      async media() {
        const caps = ytdlpCaps()
        if (!caps.available) throw new Error('yt-dlp 不可用：' + (caps.hint ?? caps.reason))
        const dl = await downloadVideo(link, CACHE, { timeoutMs: 600000 })
        if (!dl?.file) throw new Error('下载失败')
        file = dl.file
        return file
      },

      async subtitles() { return null },  // yt-dlp 字幕轨暂未接，返回 null 走降级
      async danmaku() { return null },

      // 无弹幕平台：不做广告检测（设计 05 §7.5）
      adDetector: null,
    }
  },
}
