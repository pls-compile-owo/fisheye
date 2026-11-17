// lib/platforms/bilibili/index.mjs — B站平台适配器
// 把 lib/bili.mjs 的 API 调用包装成 VideoSource 契约对象。
// 纯函数（pickSubtitleTracks / assessSubtitleQuality / looksLikeMp4 / keyOf / clean）仍留在 bili.mjs。
import fs from 'node:fs'
import path from 'node:path'
import { cred, getView, getOfficialSubs, getDanmaku, ensureMp4 } from '../../bili.mjs'
import { AD_SEGMENT_SIGNAL, DEFAULT_KEYWORDS } from '../../danmaku.mjs'

export default {
  id: 'bilibili',
  name: '哔哩哔哩',
  description: 'B站视频/字幕/弹幕适配',
  requires: {
    credentials: { kind: 'bilibili', fields: ['sessdata', 'bili_jct'] },
    tools: ['ffmpeg'],
  },

  match(input) {
    return typeof input === 'string' && /^BV[0-9A-Za-z]{10}$/.test(input) ? { id: input } : null
  },

  createSource(match) {
    const bvid = match.id
    let pageNo = 1
    let viewCache = null
    const view = async () => (viewCache ??= await getView(bvid))
    const cidOf = async (pn = pageNo) => {
      const v = await view()
      return v.pages?.[pn - 1]?.cid ?? v.cid
    }

    return {
      kind: 'bilibili',
      id: bvid,
      label: bvid,

      async meta() {
        const v = await view()
        return {
          title: v.title,
          duration: v.duration,
          owner: v.owner?.name,
          dimension: { width: v.dimension?.width, height: v.dimension?.height },
          pages: (v.pages ?? []).map((p) => ({ cid: p.cid, duration: p.duration, part: p.part })),
        }
      },

      async media(pn = 1) {
        pageNo = pn
        return ensureMp4(bvid, pn)
      },

      async subtitles(range = null, pn = pageNo) {
        const cid = await cidOf(pn)
        if (!cid) return null
        return getOfficialSubs(bvid, cid, range)
      },

      async danmaku(range = null, pn = pageNo) {
        const cid = await cidOf(pn)
        if (!cid) return null
        return getDanmaku(cid, range)
      },

      // 广告识别：弹幕族 + 字幕关键词（6 路，与旧 detectAdSegments 默认一致，零回归）
      adDetector: {
        keywords: DEFAULT_KEYWORDS,
        signals: ['danmaku-density', 'danmaku-keywords', 'mark', 'head', 'buy', 'sub-keywords'],
      },
    }
  },

  // 平台专属自检：凭证 + 视频/弹幕/字幕 API（由 stageSelftest 遍历调用）
  async selftest(ctx) {
    const { rec, CACHE } = ctx
    const miss = ['sessdata', 'bili_jct'].filter((k) => !cred[k])
    rec(miss.length ? '!!' : 'OK', 'B站凭证', miss.length ? `缺字段：${miss.join('/')}` : 'SESSDATA + bili_jct 已配置')
    if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })
    const cached = fs.readdirSync(CACHE).filter((f) => /^BV[\w]+(-p\d+)?\.mp4$/.test(f) && fs.statSync(path.join(CACHE, f)).size > 1024)
    const testBv = cached.length ? cached[0].replace(/(-p\d+)?\.mp4$/, '') : 'BV1ziWP6qENy'
    let view = null
    try {
      view = await getView(testBv)
      rec('OK', '视频 API', `${testBv} ${view.duration}s「${String(view.title ?? '').slice(0, 16)}」`)
    } catch (e) {
      rec('!!', '视频 API', `请求失败：${String(e.message).split('\n')[0].slice(0, 50)}`)
    }
    const cid = view?.pages?.[0]?.cid
    if (cid) {
      try {
        const dm = await getDanmaku(cid)
        rec(dm?.length ? 'OK' : '--', '弹幕 API', dm?.length ? `${dm.length} 条（含广告过滤前）` : '无数据（视频可能关弹幕）')
      } catch (e) { rec('!!', '弹幕 API', String(e.message).slice(0, 50)) }
      try {
        const subs = await getOfficialSubs(testBv, cid, null)
        rec(subs ? 'OK' : '--', '官方字幕 API', subs ? `${subs.quality} / ${subs.lines} 行 / ${subs.chars} 字` : '这条视频无字幕轨（不影响，会用字幕带或画面）')
      } catch (e) { rec('!!', '官方字幕 API', String(e.message).slice(0, 50)) }
    } else {
      rec('--', '弹幕/字幕 API', '视频 API 不可用，跳过')
    }
  },
}
