// B站 API：视频信息 / WBI 签名 / 官方字幕 / 播放地址 / 弹幕
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { FFMPEG, CACHE, WS, CRED, OUT } from './env.mjs'
import { fmt } from './util.mjs'
// 所有 B站请求都走 fetchWithRetry：网络抖动 / 429 / 5xx 时自动重试（指数退避），幂等 GET 才重试
import { fetchWithRetry } from './retry.mjs'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export let cred = {}
try {
  // 去 BOM：README 让用户「复制模板为 credentials.json」，而模板/记事本/PowerShell 写的
  // UTF-8 常带 BOM。不剥的话 JSON.parse 抛错 → cred 为空 → 匿名拿不到 AI 字幕、
  // 部分播放地址 403，但正式运行不报错，只有 selftest 报「缺字段」。
  cred = JSON.parse(fs.readFileSync(CRED, 'utf8').replace(/^\uFEFF/, '')) || {}
} catch { /* 自检会报 */ }

export const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${cred.sessdata ?? ''}; bili_jct=${cred.bili_jct ?? ''}; buvid3=${cred.buvid3 ?? ''}`,
}

// 时长格式化：超过 1 小时显示 01:05:30，否则 MM:SS

export async function getView(bvid) {
  const r = await fetchWithRetry(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { headers: H }, { timeoutMs: 15000 })
  const v = await r.json()
  if (v.code !== 0) throw new Error(`view code=${v.code} ${v.message}`)
  return v.data
}

// 官方字幕（看视频最省的一条腿）
// 有官方/AI 字幕时，台词信息用文本拿（几百 token），比抽字幕带图（1000 token + OCR 误差）又快又准。
// 关键（踩过的坑，见 subtitles.mjs）
// ① 必须走 WBI 签名的 /x/player/wbi/v2，旧端点拿到的 subtitle_url 缺 auth_key → CDN 403
// ② auth_key 分钟级过期，拿到就得马上下载
// ③ 匿名拿不到 AI 字幕，必须带登录 cookie

export const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]

export const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))

export const clean = (v) => String(v).replace(/[!'()*]/g, '')

/**
 * 从 B站 subtitle.subtitles 列表里挑「主轨（原文）」和「翻译轨（中文）」。
 * 外文视频（英文/日文…）的 AI 字幕除了原文轨还会带一条中文机器翻译轨（l2，lan 含 zh），
 * 只取原文就成了「只转写不翻译」——所以这里把两条轨分开，交给 getOfficialSubs 分别下载。
 *
 * 语义：
 * · 有外文轨 + 中文轨：main = 第一条外文轨（保留原话），translate = 中文轨
 * · 只有中文轨：main = 中文轨，translate = null（原有行为，不产生「中文翻译中文」）
 * · 只有外文轨：main = 外文轨，translate = null
 * · 空 / 无有效 lan：null
 * · preferZh=false：不做翻译，中文轨直接当主轨（只要中文文本的调用方）
 * 中文轨优先级沿用旧逻辑：ai-zh → zh-CN → 其它 zh*（B站 AI 中文覆盖最全）。
 * 纯函数，不发请求，便于单测。
 */
export function pickSubtitleTracks(subs, preferZh = true) {
  const list = (Array.isArray(subs) ? subs : []).filter((s) => s && typeof s.lan === 'string' && s.lan)
  if (!list.length) return null
  const isZh = (s) => /zh/i.test(s.lan)
  const zh = list.find((s) => s.lan === 'ai-zh') ?? list.find((s) => s.lan === 'zh-CN')
    ?? list.find(isZh) ?? null
  const foreign = list.find((s) => !isZh(s)) ?? null
  // 只要中文：中文轨当主轨，不再单列翻译
  if (!preferZh) return { main: zh ?? foreign, translate: null }
  // 没有外文轨（中文原声视频 / 只有单条中文字幕）：保持旧行为
  if (!foreign) return { main: zh, translate: null }
  return { main: foreign, translate: zh }
}

export async function getOfficialSubs(bvid, cid, range = null) {
  try {
    const nav = await (await fetchWithRetry('https://api.bilibili.com/x/web-interface/nav',
      { headers: H }, { timeoutMs: 15000 })).json()
    const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '')
    if (raw.length < 64) return null
    const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
    const wbi = (params) => {
      const wts = Math.round(Date.now() / 1000)
      const q = Object.keys({ ...params, wts }).sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
      return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
    }
    const p = await (await fetchWithRetry(`https://api.bilibili.com/x/player/wbi/v2?${wbi({ bvid, cid })}`,
      { headers: H }, { timeoutMs: 15000 })).json()
    const subs = p?.data?.subtitle?.subtitles ?? []
    if (!subs.length) return null
    const tracks = pickSubtitleTracks(subs)
    if (!tracks?.main?.subtitle_url) return null

    const subHeaders = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/` }
    const subUrl = (u) => (String(u).startsWith('http') ? String(u) : 'https:' + String(u))
    // 下载一条字幕轨并按 --from/--to 过滤。翻译轨失败只丢翻译，不能让整条字幕失败。
    const fetchBody = async (u) => {
      const r = await fetchWithRetry(subUrl(u), { headers: subHeaders }, { timeoutMs: 20000 })
      if (!r.ok) return []
      const raw = JSON.parse(await r.text()).body ?? []
      if (!range) return raw
      return raw.filter((l) => Number(l.from) >= range.from && Number(l.from) <= range.to)
    }
    // 主轨 + 翻译轨并行下载：auth_key 分钟级过期，串行两次请求更容易踩到期
    const translateTrack = tracks.translate?.subtitle_url ? tracks.translate : null
    const [body, transBody] = await Promise.all([
      fetchBody(tracks.main.subtitle_url),
      translateTrack ? fetchBody(translateTrack.subtitle_url).catch(() => []) : Promise.resolve([]),
    ])
    if (!body.length) return null

    fs.mkdirSync(OUT, { recursive: true })
  const txt = path.join(OUT, `${bvid}-official-subs.txt`)
    const plain = path.join(OUT, `${bvid}-official-subs-plain.txt`)
    fs.writeFileSync(txt, body.map((l) => `[${fmt(l.from)}] ${l.content}`).join('\n'), 'utf8')
    fs.writeFileSync(plain, body.map((l) => l.content).join('\n'), 'utf8')

    // 翻译轨：中文机器翻译（外文视频才有）。chars 用与原文相同的「去 ♪/空白」算法，
    // 避免译文里的空格让字数虚高；全空的翻译轨按「没有翻译」处理。
    let translated = null
    if (transBody?.length) {
      const tChars = transBody.reduce(
        (a, l) => a + String(l.content ?? '').replace(/[♪\s]/g, '').length, 0)
      if (tChars > 0) {
        const file = path.join(OUT, `${bvid}-official-subs-translated.txt`)
        fs.writeFileSync(file, transBody.map((l) => `[${fmt(l.from)}] ${l.content}`).join('\n'), 'utf8')
        translated = {
          lan: translateTrack.lan,
          lines: transBody.length,
          chars: tChars,
          txt: transBody.map((l) => String(l.content ?? '')).join('\n'),
          file,
        }
      }
    }

    // 质量判断：B 站 AI 字幕在纯音乐/音效为主的视频里会输出大量「 歌词」噪声或无意义碎片，
    // 这种字幕不能用（拿它当台词理解视频会全错），应该降级为看图
    const effChars = body.map((l) => String(l.content ?? '').replace(/[♪\s]/g, '').length)
    const avgEff = effChars.reduce((a, b) => a + b, 0) / body.length
    const uniqueRatio = new Set(body.map((l) => String(l.content ?? '').replace(/[♪\s]/g, ''))).size / body.length
    const chars = effChars.reduce((a, b) => a + b, 0)
    const quality = avgEff < 2 || uniqueRatio < 0.4 ? 'noisy' : 'ok'

    return {
      lan: tracks.main.lan, lanDoc: tracks.main.lan_doc, lines: body.length, txt, plain,
      chars, quality, avgEff: Number(avgEff.toFixed(1)), uniqueRatio: Number(uniqueRatio.toFixed(2)),
      head: body.slice(0, 5).map((l) => `[${fmt(l.from)}] ${l.content}`),
      // 中文翻译轨（没有时为 null）：原文 lines/txt 不变，翻译单独给，调用方自己决定怎么用
      translated,
    }
  } catch (e) {
    console.warn(`[官方字幕] 获取失败（按无官方字幕处理）：${String(e.message).split('\n')[0].slice(0, 60)}`)
    return null
  }
}

// 下载（一次，复用；分P 分开缓存）
/**
 * 缓存视频是否有效。
 * 只校验文件大小会把「下载中断的残缺文件 / 拷坏的 mp4」当有效缓存复用，
 * 之后抽帧静默失败，极难排查。mp4 头 12 字节里一定有 ftyp box。
 */

export function looksLikeMp4(p) {
  try {
    if (!fs.existsSync(p) || fs.statSync(p).size <= 1024) return false
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(12)
    fs.readSync(fd, buf, 0, 12, 0)
    fs.closeSync(fd)
    return buf.includes(Buffer.from('ftyp'))
  } catch { return false }
}

export async function ensureMp4(bvid, pageNo = 1) {
  fs.mkdirSync(CACHE, { recursive: true })
  const p = path.join(CACHE, pageNo > 1 ? `${bvid}-p${pageNo}.mp4` : `${bvid}.mp4`)
  if (looksLikeMp4(p)) return p

  const data = await getView(bvid)
  const page = data.pages?.[pageNo - 1]
  if (!page) throw new Error(`没有第 ${pageNo} 个分P（这条视频共 ${data.pages?.length ?? 1} 个）`)
  const { cid } = page
  const duration = page.duration ?? data.duration
  const title = page.part && data.pages.length > 1 ? `${data.title} · P${pageNo} ${page.part}` : data.title

  const pu = await (await fetchWithRetry(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`,
    { headers: H }, { timeoutMs: 15000 })).json()
  const url = pu.data?.durl?.[0]?.url
  if (!url) throw new Error(`没拿到直链 code=${pu.code}`)

  // 下载到 .part 再 rename：网络中断时只会留下 .part，不会把半个 mp4 伪装成缓存
  // （旧实现直接写最终路径，中断后下次运行会拿着残缺文件当缓存用）
  const r = await fetchWithRetry(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' },
  }, { timeoutMs: 300000 })
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 1024) throw new Error('下载内容过短，可能被中断（.part 已丢弃）')
  const part = p + '.part'
  fs.writeFileSync(part, buf)
  fs.renameSync(part, p)
  console.log(`[下载] ${title}  ${duration}s  →  ${(fs.statSync(p).size / 1048576).toFixed(2)} MB`)
  return p
}

// 画面变化点：一次解码，把带分数的候选全部拿出来
// 旧做法是每个阈值各跑一遍 ffmpeg（0.3 / 0.15 / 0.08 三遍全片解码），慢且浪费。
// 现在只解码一遍（阈值放最低 0.05），把每处的 scene_score 一起记下，阈值阶梯在内存里做，零重复成本。
// 注意：沙箱下 child_process 的 stdout 管道被禁（EPERM），只能用「ffmpeg 写临时文件」的方式取输出。

export async function getDanmaku(cid, range = null) {
  try {
    const r = await fetchWithRetry(`https://comment.bilibili.com/${cid}.xml`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    }, { timeoutMs: 20000 })
    if (!r.ok) return null
    const xml = await r.text()
    const list = []
    for (const m of xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) {
      const t = Number(String(m[1]).split(',')[0])
      const text = String(m[2] ?? '').trim()
      if (!Number.isFinite(t) || !text) continue
      if (range && (t < range.from || t > range.to)) continue
      list.push({ t, text })
    }
    return list
  } catch (e) {
    console.warn(`[弹幕] 获取失败（忽略，不影响其余流程）：${String(e.message).split('\n')[0].slice(0, 60)}`)
    return null
  }
}

// 弹幕过滤逻辑在 danmaku-filter.mjs（与测试共用同一份实现，避免测试测副本）

// 广告段检测（视频内广告，不是弹幕文本广告）
// 判断依据来自案例 BV1i4W86zEUS（小约翰可汗 40 分钟视频，
// 用户指认 04:35-06:49 是鱼油广告）
// · 广告段弹幕密度只有全片的 31%（观众跳过 / 不互动）
// · 「感谢金主爸爸」这类关键词会在广告段附近出现
// 只用密度会误报（纯画面段、BGM 段也是低谷），所以分两级
// high = 密度低谷 且 附近有关键词命中（可直接标注为广告）
// low = 只有密度低谷（标成「低互动段」，不当广告）
