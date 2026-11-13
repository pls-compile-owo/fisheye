#!/usr/bin/env node
// fisheye.mjs — 从 B 站视频里「按需看图」：多张拼图铺网 + 关键帧精读
// 五个阶段（通常只用 auto 和 refine）
// auto 自动规划：按 token 预算和内容变化率决定采样密度、张数、要不要字幕带
// grid 铺网：下载一次 mp4 → 按 chunk 切段 → 每段抽 N 帧拼成一张图
// subs 字幕带：剪掉画面只留底部字幕，竖排 N 行（自动定位字幕位置）
// refine 精读选择：按模板/决策文件/几何规则挑出要看原分辨率的时间点
// grab 精读执行：按时间点截原分辨率单帧
// 产物
// out/<BV>-manifest.json 每张图的时间范围 + 每格时间戳、变化强度、吸附偏移
// out/<BV>-*.jpg 拼图 / 字幕带 / 精读帧
// cache/<BV>.mp4 原始视频（下载一次复用）
// 设计要点
// · 段内取帧 = 等间隔骨架（保覆盖）+ 吸附画面变化点（不漏关键帧）
// · 拼图每格顺序固定，manifest 按「从左到右、从上到下」记录时间，供 agent 对照
// · 拼图与精读用同一种 seek，保证同一时间戳取到同一帧
// · 所有子进程用 stdio:'ignore'（沙箱禁管道捕获），数据走临时文件
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { spamReason, filterDanmaku } from './danmaku-filter.mjs'

// 路径与依赖解析
// 这个脚本要能在「别人的机器」上跑，所以不写死任何绝对路径。
// 解析顺序：环境变量 → ~/.config/fisheye/config.json → 项目内 bin/ → PATH
// FFMPEG=... ffmpeg 可执行文件
// PYTHON=... python 可执行文件（字幕带检测用，可选）
// BILI_CRED=... B站登录态 JSON
// FISHEYE_HOME=... 数据目录（cache/out 放哪，默认脚本所在目录）
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))
const WS = process.env.FISHEYE_HOME || PKG_DIR
const CACHE = path.join(WS, 'cache')
const OUT = path.join(WS, 'out')
fs.mkdirSync(CACHE, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })

const CFG_FILE = path.join(os.homedir(), '.config', 'fisheye', 'config.json')
let LOCAL_CFG = {}
try {
  // 去掉 BOM —— Windows 记事本 / PowerShell 写的 UTF-8 常带 BOM，直接 JSON.parse 会炸
  // （开发时配置文件明明存在却解析成 {}，查了半天是 BOM）
  LOCAL_CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}
} catch {}

/** 命令能不能直接从 PATH 调起来（不捕获输出，沙箱禁管道） */
function onPath(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch { return false }
}

/** 按 环境变量 → 配置文件 → 项目内 bin → PATH 的顺序找工具；找不到返回 null */
function resolveTool(envVar, cfgKey, localCandidates, cmdName) {
  if (process.env[envVar]) return { cmd: process.env[envVar], from: `环境变量 ${envVar}` }
  if (LOCAL_CFG[cfgKey] && fs.existsSync(LOCAL_CFG[cfgKey])) return { cmd: LOCAL_CFG[cfgKey], from: CFG_FILE }
  for (const c of localCandidates) if (fs.existsSync(c)) return { cmd: c, from: '项目内 bin/' }
  if (onPath(cmdName)) return { cmd: cmdName, from: 'PATH' }
  return null
}

const FFMPEG_RES = resolveTool('FFMPEG', 'ffmpeg', [
  path.join(PKG_DIR, 'bin', 'ffmpeg.exe'), path.join(PKG_DIR, 'bin', 'ffmpeg'),
], 'ffmpeg')
const PYTHON_RES = resolveTool('PYTHON', 'python', [
  path.join(PKG_DIR, '.venv', 'Scripts', 'python.exe'), path.join(PKG_DIR, '.venv', 'bin', 'python'),
], process.platform === 'win32' ? 'python' : 'python3')

const FFMPEG = FFMPEG_RES?.cmd ?? null
const PYTHON = PYTHON_RES?.cmd ?? null

/** B站登录态：环境变量 → config.json → 数据目录 → ~/.config/fisheye/ */
function resolveCred() {
  if (process.env.BILI_CRED) return process.env.BILI_CRED
  if (LOCAL_CFG.credentials && fs.existsSync(LOCAL_CFG.credentials)) return LOCAL_CFG.credentials
  for (const c of [
    path.join(WS, 'credentials.json'),
    path.join(os.homedir(), '.config', 'fisheye', 'credentials.json'),
  ]) if (fs.existsSync(c)) return c
  return null
}
const CRED = resolveCred()

// 自检要能诊断「依赖缺失」本身，所以 selftest 时不在下面硬退出
const IS_SELFTEST = process.argv[2] === 'selftest'
// local 处理本地文件，不需要 B站 登录态（但仍然需要 ffmpeg）
const IS_LOCAL = process.argv[2] === 'local'
if (!IS_SELFTEST) {
  if (!FFMPEG) {
    console.error(`找不到 ffmpeg。

安装方式（任选其一）：
  1. 装到 PATH：https://ffmpeg.org/download.html （Windows 用 gyan.dev 的 build）
  2. 放项目里：把 ffmpeg 可执行文件放到 ${path.join(PKG_DIR, 'bin')}/
  3. 设环境变量：FFMPEG=<ffmpeg 完整路径>
  4. 写配置：${CFG_FILE} 里加 {"ffmpeg": "<完整路径>"}`)
    process.exit(2)
  }
  if (!IS_LOCAL && !CRED) {
    console.error(`找不到 B站登录态文件。

创建 ${path.join(WS, 'credentials.json')}，内容：
  {
    "sessdata": "<B站 SESSDATA>",
    "bili_jct": "<bili_jct>",
    "buvid3": "<buvid3>"
  }
获取方法：浏览器登录 B站 → F12 → Application → Cookies → bilibili.com，
复制这三个值。或用环境变量 BILI_CRED=<文件路径> 指向已有文件。

（也可以只跑 selftest 先看环境是否就绪：node fisheye.mjs selftest）`)
    process.exit(2)
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
let cred = {}
try {
  // 去 BOM：README 让用户「复制模板为 credentials.json」，而模板/记事本/PowerShell 写的
  // UTF-8 常带 BOM。不剥的话 JSON.parse 抛错 → cred 为空 → 匿名拿不到 AI 字幕、
  // 部分播放地址 403，但正式运行不报错，只有 selftest 报「缺字段」。
  cred = JSON.parse(fs.readFileSync(CRED, 'utf8').replace(/^\uFEFF/, '')) || {}
} catch { /* 自检会报 */ }
const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${cred.sessdata ?? ''}; bili_jct=${cred.bili_jct ?? ''}; buvid3=${cred.buvid3 ?? ''}`,
}

// 时长格式化：超过 1 小时显示 01:05:30，否则 MM:SS
const fmt = (s) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
// Windows 文件名不能带冒号，落盘用秒数
const fsec = (s) => String(Math.round(s)).padStart(4, '0')

// 从 JPEG 头读尺寸（沙箱禁管道，不能用 ffprobe 捕获输出）
function jpegSize(file) {
  try {
    const b = fs.readFileSync(file)
    let i = 2
    while (i < b.length - 8) {
      if (b[i] !== 0xFF) { i++; continue }
      const marker = b[i + 1]
      const len = (b[i + 2] << 8) | b[i + 3]
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] }
      }
      i += 2 + len
    }
  } catch {}
  return null
}

// 参数校验（在 CLI 分发处用；Number('')===0、Infinity、NaN 都要挡掉）
const fail = (msg) => {
  console.error(`参数错误：${msg}`)
  process.exit(2)
}
const num = (v, name, { min, max } = {}) => {
  const n = Number(v)
  if (v === '' || !Number.isFinite(n)) fail(`--${name} 需要数字，收到：${JSON.stringify(v)}`)
  if (min !== undefined && n < min) fail(`--${name} 不能小于 ${min}（收到 ${n}）`)
  if (max !== undefined && n > max) fail(`--${name} 不能大于 ${max}（收到 ${n}）`)
  return n
}
const gridStr = (v) => {
  const s = String(v ?? '3x3').toLowerCase()
  if (!/^[1-9]x[1-9]$/.test(s)) fail(`--grid 格式应为 NxM（如 3x3，行列 1~9），收到：${JSON.stringify(v)}`)
  return s
}
// 时间参数：支持 330（秒）/ 5:30 / 1:05:30
const parseTime = (v, name) => {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) fail(`--${name} 时间格式应为 330 / 5:30 / 1:05:30，收到：${JSON.stringify(v)}`)
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) fail(`--${name} 时间格式非法：${JSON.stringify(v)}`)
  return parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2]
}
const pageNum = (v) => {
  if (v === null || v === undefined || v === '') return 1
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 200) fail(`--p 分P序号应为 1~200 的整数，收到：${JSON.stringify(v)}`)
  return n
}

// 统一取视频元信息（带超时 + code 校验；之前三处各自 fetch，有的没查 code）
async function getView(bvid) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { headers: H, signal: AbortSignal.timeout(15000) })
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
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const clean = (v) => String(v).replace(/[!'()*]/g, '')

async function getOfficialSubs(bvid, cid, range = null) {
  try {
    const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav',
      { headers: H, signal: AbortSignal.timeout(15000) })).json()
    const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '')
    if (raw.length < 64) return null
    const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
    const wbi = (params) => {
      const wts = Math.round(Date.now() / 1000)
      const q = Object.keys({ ...params, wts }).sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
      return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
    }
    const p = await (await fetch(`https://api.bilibili.com/x/player/wbi/v2?${wbi({ bvid, cid })}`,
      { headers: H, signal: AbortSignal.timeout(15000) })).json()
    const subs = p?.data?.subtitle?.subtitles ?? []
    if (!subs.length) return null
    const pick = subs.find((s) => s.lan === 'ai-zh') ?? subs.find((s) => s.lan === 'zh-CN')
      ?? subs.find((s) => String(s.lan).startsWith('zh')) ?? subs[0]
    if (!pick?.subtitle_url) return null

    const url = String(pick.subtitle_url).startsWith('http') ? pick.subtitle_url : 'https:' + pick.subtitle_url
    const r = await fetch(url, {
      headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/` },
      signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) return null
    let body = (JSON.parse(await r.text()).body ?? [])
    if (!body.length) return null
    // 只保留所处理区间内的字幕行（--from/--to）
    if (range) body = body.filter((l) => Number(l.from) >= range.from && Number(l.from) <= range.to)
    if (!body.length) return null

    const txt = path.join(OUT, `${bvid}-official-subs.txt`)
    const plain = path.join(OUT, `${bvid}-official-subs-plain.txt`)
    fs.writeFileSync(txt, body.map((l) => `[${fmt(l.from)}] ${l.content}`).join('\n'), 'utf8')
    fs.writeFileSync(plain, body.map((l) => l.content).join('\n'), 'utf8')

    // 质量判断：B 站 AI 字幕在纯音乐/音效为主的视频里会输出大量「 歌词」噪声或无意义碎片，
    // 这种字幕不能用（拿它当台词理解视频会全错），应该降级为看图
    const effChars = body.map((l) => String(l.content ?? '').replace(/[♪\s]/g, '').length)
    const avgEff = effChars.reduce((a, b) => a + b, 0) / body.length
    const uniqueRatio = new Set(body.map((l) => String(l.content ?? '').replace(/[♪\s]/g, ''))).size / body.length
    const chars = effChars.reduce((a, b) => a + b, 0)
    const quality = avgEff < 2 || uniqueRatio < 0.4 ? 'noisy' : 'ok'

    return {
      lan: pick.lan, lanDoc: pick.lan_doc, lines: body.length, txt, plain,
      chars, quality, avgEff: Number(avgEff.toFixed(1)), uniqueRatio: Number(uniqueRatio.toFixed(2)),
      head: body.slice(0, 5).map((l) => `[${fmt(l.from)}] ${l.content}`),
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
function looksLikeMp4(p) {
  try {
    if (!fs.existsSync(p) || fs.statSync(p).size <= 1024) return false
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(12)
    fs.readSync(fd, buf, 0, 12, 0)
    fs.closeSync(fd)
    return buf.includes(Buffer.from('ftyp'))
  } catch { return false }
}

async function ensureMp4(bvid, pageNo = 1) {
  const p = path.join(CACHE, pageNo > 1 ? `${bvid}-p${pageNo}.mp4` : `${bvid}.mp4`)
  if (looksLikeMp4(p)) return p

  const data = await getView(bvid)
  const page = data.pages?.[pageNo - 1]
  if (!page) throw new Error(`没有第 ${pageNo} 个分P（这条视频共 ${data.pages?.length ?? 1} 个）`)
  const { cid } = page
  const duration = page.duration ?? data.duration
  const title = page.part && data.pages.length > 1 ? `${data.title} · P${pageNo} ${page.part}` : data.title

  const pu = await (await fetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`,
    { headers: H, signal: AbortSignal.timeout(15000) })).json()
  const url = pu.data?.durl?.[0]?.url
  if (!url) throw new Error(`没拿到直链 code=${pu.code}`)

  // 下载到 .part 再 rename：网络中断时只会留下 .part，不会把半个 mp4 伪装成缓存
  // （旧实现直接写最终路径，中断后下次运行会拿着残缺文件当缓存用）
  const r = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' },
    signal: AbortSignal.timeout(300000),
  })
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
function detectScenes(file) {
  // 文件名带 pid + 时间戳：两个视频并发跑时不会互相覆盖
  const name = `.scenes-${process.pid}-${Date.now()}.txt`
  const abs = path.join(OUT, name)
  try {
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true })
    execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-vf',
      `scale=320:-2,select='gt(scene,0.05)',metadata=print:file=${name}`, '-an', '-f', 'null', '-'],
      { stdio: 'ignore', cwd: OUT })
    if (!fs.existsSync(abs)) return []
    const out = fs.readFileSync(abs, 'utf8')
    fs.rmSync(abs, { force: true })
    // 输出是两行一组： "…pts_time:4.1" 紧跟 "lavfi.scene_score=0.42"
    const ents = []
    let cur = null
    for (const line of out.split('\n')) {
      const t = line.match(/pts_time:\s*([0-9.]+)/)
      if (t) { cur = { t: Number(t[1]), score: 0 }; continue }
      const s = line.match(/scene_score=([0-9.]+)/)
      if (s && cur) { cur.score = Number(s[1]); ents.push(cur); cur = null }
    }
    return ents.filter((e) => e.t > 0.2)
  } catch { return [] }
}

// 段内取帧：等间隔骨架 + 吸附变化点（阈值阶梯 + 去重）
// 基准点 ((i+0.5)*dur/n) 让每格的吸附窗口 [base±dur/2n] 恰好铺满整段、且不越界。
// 从 [from,to] 里减掉广告段，返回剩余连续区间（用于「广告不占帧」）
function subtractAds(from, to, adSegs) {
  let segs = [{ a: from, b: to }]
  for (const ad of adSegs) {
    const next = []
    for (const s of segs) {
      if (ad.to <= s.a || ad.from >= s.b) { next.push(s); continue }
      if (ad.from > s.a) next.push({ a: s.a, b: ad.from })
      if (ad.to < s.b) next.push({ a: ad.to, b: s.b })
    }
    segs = next
  }
  return segs.filter((s) => s.b - s.a > 0.5)
}

function pickTimes(from, to, n, scenes, adSegs = []) {
  const dur = to - from
  const inAd = (t) => adSegs.some((ad) => t >= ad.from && t <= ad.to)

  // 广告段时间从时间轴上「压缩掉」：在剩余有效时间里等间隔取基准点。
  // 效果 = 帧数不变、广告不占帧、多出来的时长自动分给内容（密度提升）。
  const segs = adSegs.length ? subtractAds(from, to, adSegs) : [{ a: from, b: to }]
  if (!segs.length) return null                      // 整段都是广告 → 调用方跳过这张图
  const totalEff = segs.reduce((s, x) => s + (x.b - x.a), 0)
  const base = []
  for (let i = 0; i < n; i++) {
    let rem = ((i + 0.5) / n) * totalEff
    let t = segs[segs.length - 1].b
    for (const s of segs) {
      const d = s.b - s.a
      if (rem <= d) { t = s.a + rem; break }
      rem -= d
    }
    base.push(t)
  }

  // 吸附窗口/去重下限按「有效时长」算，而不是原始段长。
  // 段里有广告时，内容被压缩得更密，用原始 dur 会让窗口过大 → 多帧吸到同一点后被去重退回
  // （40 分钟视频图2：跳过 118s 广告后 9 帧里有 5 帧被退回）
  const timingBase = totalEff > 0 ? totalEff : dur
  const half = timingBase / n / 2
  const minGap = (timingBase / n) * 0.4 // 去重下限：相邻两帧至少隔这么多

  const tryThreshold = (th) => {
    // 吸附候选也排除广告段：不然帧会被吸到广告里的高变化点（片头/转场）
    const cands = scenes.filter((s) => s.score >= th && !inAd(s.t))
    const raw = base.map((b) => {
      const near = cands.filter((s) => Math.abs(s.t - b) <= half)
      if (!near.length) return b
      // 窗口内可能挤着多个变化点：取「最剧烈」的而不是「最近」的——
      // 时间代表性靠窗口保证（都在 ±half 内），视觉显著性决定落在哪一刻
      return near.reduce((x, s) => (s.score > x.score ? s : x)).t
    })
    // snapped 统计的是「吸附能力」，必须在去重前算 —— 否则被去重退回的帧会被误记成「没吸到」
    const snapped = raw.filter((t, i) => Math.abs(t - base[i]) > 1e-6).length

    // 去重：吸附后若相邻两帧挤得比 minGap 还近，把后一个退回它自己的等间隔基准点
    // （基准点之间间距 = dur/n，永远不会违反 minGap，所以退回一定安全）
    const times = raw.slice()
    for (let i = 1; i < times.length; i++) {
      if (Math.abs(times[i] - times[i - 1]) < minGap) times[i] = base[i]
    }
    let dedup = 0
    for (let i = 1; i < times.length; i++) {
      if (Math.abs(raw[i] - times[i]) > 1e-6) dedup++
    }
    return { times, th, snapped, dedup, base }
  }

  // 阈值阶梯：从严格到宽松，取第一个「≥75% 帧都吸附成功」的档位
  // （段变短后吸附窗口 half 会变小，过半门槛太松，容易留下大量没吸到的帧）
  let fallback = null
  for (const th of [0.3, 0.15, 0.08]) {
    const r = tryThreshold(th)
    if (!fallback) fallback = r
    if (r.snapped >= Math.ceil(n * 0.75)) return r
  }
  return fallback
}

// 字幕行取帧：等间隔骨架 + 吸附变化点（字幕通常在镜头切换时更新，纯等间隔会取到
// 「还没出字幕」的过渡帧——第一条字幕带的行 1 经常是空的）
function snapSubsTimes(span, count, scenes, start = 0) {
  const base = Array.from({ length: count }, (_, i) => start + ((i + 0.5) * span) / count)
  const cands = scenes.filter((s) => s.score >= 0.15 && s.t >= start && s.t <= start + span)
  if (!cands.length) return base
  const half = span / count / 2
  const minGap = (span / count) * 0.4
  const times = base.map((b) => {
    const near = cands.filter((s) => Math.abs(s.t - b) <= half)
    if (!near.length) return b
    return near.reduce((x, s) => (s.score > x.score ? s : x)).t
  })
  for (let i = 1; i < times.length; i++) {
    if (Math.abs(times[i] - times[i - 1]) < minGap) times[i] = base[i]
  }
  return times
}

// 弹幕：独立于画面和字幕的第三个信息源
// 为什么值得拉：弹幕密集的时段 = 观众真正觉得精彩的地方，可以直接指导精读选点；
// 而且它能看到画面和字幕里都没有的东西——大家在哪一秒笑、在刷什么梗。
// 数据源：https://comment.bilibili.com/<cid>.xml
// 每条 <d p="相对秒,模式,字号,颜色,...,>内容</d>，只取第一段（相对时间）和文本
async function getDanmaku(cid, range = null) {
  try {
    const r = await fetch(`https://comment.bilibili.com/${cid}.xml`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(20000),
    })
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
const AD_SEGMENT_SIGNAL = /金主|恰饭|商单|硬广|软广|赞助|推广|接广|带货|下单|同款|优惠码/i;

function detectAdSegments(danmaku, duration, bucketSec = 30, stepSec = 10) {
  if (!danmaku?.length || duration < 120) return []
  const dens = []
  for (let s = 0; s + bucketSec <= duration; s += stepSec) {
    let n = 0
    for (const d of danmaku) if (d.t >= s && d.t < s + bucketSec) n++
    dens.push({ s, n })
  }
  if (!dens.length) return []
  const nums = dens.map((d) => d.n).sort((a, b) => a - b)
  const median = nums[Math.floor(nums.length / 2)] || 1
  // 低密度：低于中位数的 45%
  const spans = []
  for (const d of dens) {
    if (d.n >= median * 0.45) continue
    const last = spans[spans.length - 1]
    if (last && d.s - last.to <= stepSec * 2) last.to = d.s + bucketSec
    else spans.push({ from: d.s, to: d.s + bucketSec, count: 0 })
  }
  const long = spans.filter((x) => x.to - x.from >= 60)
  if (!long.length) return []

  const hits = danmaku.filter((d) => AD_SEGMENT_SIGNAL.test(d.text))
  return long.map((sp) => {
    const near = hits.filter((h) => h.t >= sp.from - 20 && h.t <= sp.to + 20)
    // dens 是「30s 窗、10s 步长」的滑窗，同一条弹幕会被相邻 3 个桶各计一次。
    // 分母必须用「实际桶数」而不是 (时长/bucketSec)，否则 ratio 虚高约 3 倍
    // （出现 lowDensity = -25% 的负值，因为 ratio > 1）
    const segBuckets = dens.filter((d) => d.s >= sp.from && d.s < sp.to)
    const total = segBuckets.reduce((s, d) => s + d.n, 0)
    const ratio = total / Math.max(1, segBuckets.length) / median
    return {
      from: sp.from,
      to: sp.to,
      dur: sp.to - sp.from,
      ts: `${fmt(sp.from)}-${fmt(sp.to)}`,
      lowDensity: Number((1 - ratio).toFixed(2)),
      confidence: near.length ? 'high' : 'low',
      keywords: near.slice(0, 3).map((h) => h.text),
    }
  })
}

// 按时间桶聚合，找「观众最激动」的时段。
// 高频重复的弹幕最能代表那里在刷什么（梗 / 共鸣），所以每个热区取前 3 条并标出现次数。
function summarizeDanmaku(list, bucketSec = 5, topN = 6) {
  if (!list?.length) return null
  const buckets = new Map()
  for (const d of list) {
    const k = Math.floor(d.t / bucketSec) * bucketSec
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(d.text)
  }
  return [...buckets.entries()]
    .map(([start, texts]) => ({ start, texts }))
    .sort((a, b) => b.texts.length - a.texts.length)   // 先按密度挑出最热的 N 个桶
    .slice(0, topN)
    .sort((a, b) => a.start - b.start)                  // 再按时间顺序展示
    .map(({ start, texts }) => {
      const freq = new Map()
      for (const t of texts) freq.set(t, (freq.get(t) ?? 0) + 1)
      const samples = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, n]) => (n > 1 ? `${t}×${n}` : t))
      return { start, end: start + bucketSec, ts: fmt(start), count: texts.length, samples }
    })
}

async function stageGrid(bvid, chunkSec, grid, pre = {}) {
  const pageNo = pre.page ?? 1
  const mp4 = pre.mp4 ?? await ensureMp4(bvid, pageNo)
  const viewData = pre.view ?? await getView(bvid)
  // 时长要用「所处理分P」的时长（多P 视频的 view.duration 是全部分P 总和）
  const pageInfo = viewData.pages?.[pageNo - 1]
  const title = pageInfo?.part && (viewData.pages?.length ?? 1) > 1
    ? `${viewData.title} · P${pageNo} ${pageInfo.part}` : viewData.title
  const fullDuration = pageInfo?.duration ?? viewData.duration
  const owner = viewData.owner?.name
  const [cols, rows] = grid.split('x').map(Number)
  const N = cols * rows
  // 时间区间：只铺 [start, end]
  const range = pre.range ?? null
  const start = range?.from ?? 0
  const end = Math.min(range?.to ?? fullDuration, fullDuration)
  const span = Math.max(0.1, end - start)
  if (range) console.log(`[区间] 铺网范围 ${fmt(start)}-${fmt(end)}`)

  // 画面变化点（visualScenes）与「参与吸附的候选」（sceneCands）要分开
  // 弹幕热区要参与吸附，但不能污染 manifest 里每格的 scene 分数（那是纯画面的指标）。
  const visualScenes = pre.scenes ?? detectScenes(mp4)
  const strong = visualScenes.filter((s) => s.score >= 0.15).length
  console.log(`[场景] 候选 ${visualScenes.length} 处画面变化（score≥0.15 的 ${strong} 处）`)

  // 弹幕热区也当作「重要时刻」参与吸附：B 站弹幕密度本身就是内容信号，
  // 那些「画面没怎么变、但观众集体激动」的时刻，纯视觉检测抓不到。
  // score 给 0.9 而不是 1.0 —— 同一窗口里真实画面变化优先，
  // 避免一个热区把整段的帧全吸过去（那会破坏均匀覆盖）。
  let sceneCands = visualScenes
  const dmFrameCands = pre.useDanmakuFrames === false ? [] : (pre.danmakuHot ?? [])
  if (dmFrameCands.length) {
    sceneCands = [
      ...visualScenes,
      ...dmFrameCands.map((h) => ({ t: h.start + 2.5, score: 0.9, kind: 'danmaku' })),
    ]
    console.log(`[取帧] 弹幕热区 ${dmFrameCands.length} 处参与吸附（score 0.9，低于真实画面变化）`)
  }
  // 字幕信息：pre 里显式传了（哪怕是 null=检测失败）就复用，不要再检测第二遍
  let bandResult = pre.bandResult !== undefined ? pre.bandResult : null
  if (pre.bandResult === undefined) {
    try { bandResult = detectBand(mp4, fullDuration) } catch { /* 分析失败就当没有字幕 */ }
  }
  let videoSize = null

  const chunks = []
  // 分段边界：先在区间内均分，再把过短的尾段并进前一段
  const bounds = []
  for (let c = 0; c < Math.max(1, Math.ceil(span / chunkSec)); c++) {
    bounds.push({ from: start + c * chunkSec, to: Math.min(end, start + (c + 1) * chunkSec) })
  }
  const tailMin = Math.min(20, chunkSec * 0.25)
  if (bounds.length > 1 && bounds.at(-1).to - bounds.at(-1).from < tailMin) {
    const tail = bounds.pop()
    bounds.at(-1).to = tail.to
    console.log(`[分段] 尾段只有 ${(tail.to - tail.from).toFixed(1)}s，已并入上一段`)
  }

  // 高置信度广告段：这些时间不占帧（get 交给内容），铺网时压缩掉
  const adHigh = (pre.adSegments ?? []).filter((s) => s.confidence === 'high')

  for (let c = 0; c < bounds.length; c++) {
    const { from, to } = bounds[c]
    const picked = pickTimes(from, to, N, sceneCands, adHigh)
    if (!picked) {
      // 整段都被高置信度广告占满（极罕见）——跳过这张图，不让它浪费预算
      console.log(`[取帧] ${fmt(from)}-${fmt(to)}  整段都是疑似广告，跳过这张拼图`)
      continue
    }
    const times = picked.times
    const thText = picked.th === null ? '无变化点' : `阈值 ${picked.th}`
    const dedupText = picked.dedup ? `，去重退回 ${picked.dedup} 帧` : ''
    const adText = adHigh.length
      ? `（已跳过广告 ${Math.round(adHigh.filter((a) => a.to > from && a.from < to).reduce((s, a) => s + Math.min(a.to, to) - Math.max(a.from, from), 0))}s）`
      : ''
    console.log(`[取帧] ${fmt(from)}-${fmt(to)}  ${thText}，${picked.snapped}/${N} 帧吸附${dedupText}${adText}`)
    // 变化点稀疏/聚集（如冲浪视频：大部分平静、巨浪集中在几秒）时吸附率会很低——
    // 这是正常现象，等间隔骨架保覆盖，但要提醒：关键时刻可能被少量帧覆盖，看精读建议
    if (picked.snapped < N * 0.5) {
      console.log(`  ↳ 变化点稀疏或高度聚集（${visualScenes.length} 处全片变化点），等间隔骨架兜底；关键瞬间见精读建议`)
    }

    const tmp = path.join(OUT, `.f-${bvid}-${c}`)
    fs.mkdirSync(tmp, { recursive: true })
    const files = []
    times.forEach((t, i) => {
      const f = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)
      // -ss 放在 -i 前面 = 快速 seek（跳到最近关键帧），比精确 seek 快一个数量级。
      // 拼图和精读用同一种 seek，保证「同一时间戳」两边取到的是同一帧。
      if (!grabFrame(mp4, t, f)) {
        // 抽帧失败（t 越界 / 解码出错）：复制上一帧补齐，避免 tile 因缺帧直接报错
        if (files.length) fs.copyFileSync(files[files.length - 1], f)
        else return // 第一帧就失败 → 这一帧留空，下面按数量不足处理
      }
      files.push(f)
    })
    if (files.length < N) {
      console.warn(`[警告] 本段只抽到 ${files.length}/${N} 帧，跳过该段（其余段不受影响）`)
      fs.rmSync(tmp, { recursive: true, force: true })
      continue
    }
    if (!videoSize) videoSize = jpegSize(files[0])   // 原片分辨率（供几何可读性计算）

    const sheet = path.join(OUT, `${bvid}-c${String(c).padStart(2, '0')}_${fsec(from)}-${fsec(to)}_${cols}x${rows}.jpg`)
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, `f%02d.jpg`), '-vf',
      `scale=640:-1,tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '3', sheet], { stdio: 'ignore' })
    fs.rmSync(tmp, { recursive: true, force: true })

    // 这一格落在多强的画面变化上（供「哪些格值得精读」的判断参考：变化越强，通常信息越密）
    const scoreAt = (t) => {
      const c = visualScenes.filter((s) => Math.abs(s.t - t) < 0.06)
      return c.length ? Number(Math.max(...c.map((s) => s.score)).toFixed(3)) : 0
    }
    // 有广告被跳过时，range 标注成「原始区间 + 实际内容范围」，否则会让人误以为覆盖到段尾
    const adSkipped = Math.round(adHigh
      .filter((a) => a.to > from && a.from < to)
      .reduce((s, a) => s + Math.min(a.to, to) - Math.max(a.from, from), 0))
    const effRange = adSkipped > 0 && times.length
      ? `${fmt(times[0])}-${fmt(times[times.length - 1])}`
      : null
    chunks.push({
      chunk: c + 1,
      from: Number(from.toFixed(1)),
      to: Number(to.toFixed(1)),
      range: `${fmt(from)}-${fmt(to)}`,
      adSkipped,                                    // 本段被跳过的疑似广告秒数
      effectiveRange: effRange,                     // 实际内容覆盖范围（跳过广告后）
      sheet,
      grid: `${cols}x${rows}`,
      threshold: picked.th,
      snapped: picked.snapped,
      cells: times.map((t, i) => ({
        cell: i + 1,
        row: Math.floor(i / cols) + 1,
        col: (i % cols) + 1,
        t: Number(t.toFixed(2)),
        ts: fmt(t),
        scene: scoreAt(t),
        shift: Number((t - picked.base[i]).toFixed(1)), // 相对等间隔基准挪了多少秒
      })),
    })
    const adNote = adSkipped > 0 ? `（跳过广告 ${adSkipped}s，内容实际 ${effRange}）` : ''
    console.log(`[拼图 ${c + 1}/${bounds.length}] ${fmt(from)}-${fmt(to)}  ${N} 帧${adNote} → ${path.basename(sheet)}`)
  }

  const sheetSize = chunks.length ? jpegSize(chunks[0].sheet) : null
  const manifest = {
    bvid, title, up: owner, duration: fullDuration, chunkSec,
    page: pre.page ?? 1,   // 分P 序号（grab/refine 靠它找对缓存文件）
    range: range ? { from: Number(start.toFixed(1)), to: Number(end.toFixed(1)) } : null,
    grid: `${cols}x${rows}`,
    // 几何信息：refine --auto 用它算「拼图里字幕还剩几个像素」
    sheetWidth: sheetSize?.w ?? null,
    sheetHeight: sheetSize?.h ?? null,
    videoWidth: videoSize?.w ?? null,
    videoHeight: videoSize?.h ?? null,
    subs: bandResult?.ok ? { top: bandResult.topRatio, bottom: bandResult.botRatio } : null,
    subsSheet: pre.subsSheet ?? false,   // 是否另外生成了字幕带
    subsCovered: pre.subsCovered ?? pre.subsSheet ?? false, // 字幕信息是否已覆盖（official 或 burned-in）
    subsSource: pre.subsSource ?? null,  // 'official' | 'burned-in' | null
    danmaku: pre.danmakuHot?.length
      ? { total: pre.danmakuTotal ?? null, hot: pre.danmakuHot }
      : null,                            // 弹幕热区（refine 的几何兜底会合并进来）
    adSegments: pre.adSegments ?? null,  // 视频内疑似广告段（refine 会避开 high 置信度区间）
    chunks,
    createdAt: new Date().toISOString(),
  }
  const mf = path.join(OUT, `${bvid}-manifest.json`)
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`\nMANIFEST: ${mf}`)
  console.log(`共 ${chunks.length} 张拼图 / ${chunks.reduce((a, c) => a + c.cells.length, 0)} 帧`)
  console.log(`\n看图顺序（每张图从左到右、从上到下对应下列时间；括号里是该格的画面变化强度）：`)
  for (const c of chunks) {
    console.log(`  图${c.chunk} [${c.range}]  ${c.sheet}`)
    console.log(`      ${c.cells.map((x) => `#${x.cell}=${x.ts}${x.scene ? `(${x.scene})` : ''}`).join('  ')}`)
  }
  return manifest
}

// 字幕带竖排：剪掉画面、只留底部字幕，竖着拼 N 条
// band 可以是比例（0.22）或 'auto'（先跑 analyze_subs.py 自动定位字幕带）
// 依据：讲解/翻唱类视频，字幕就是全部信息量；同样 token 预算下，字幕带比全画幅拼图清楚得多

function detectBand(mp4, duration) {
  const probe = path.join(OUT, `.probe-${Date.now()}`)
  try {
    fs.mkdirSync(probe, { recursive: true })
    // 逐帧快速 seek 抽 24 帧：fps 滤镜虽然只输出 24 帧，但必须全片解码，长视频下慢一个数量级
    // 注意：这里**必须跨全片采样**，不能只看 --from/--to 区间 —— 字幕位置是视频级属性，
    // 只在区间内采样时，区间里若恰好多帧无字幕，峰值会被画面边缘抢走（82%-90% 跑偏成 55%-83%）
    for (let i = 0; i < 24; i++) {
      const t = ((i + 0.5) * Math.max(duration, 1)) / 24
      grabFrame(mp4, t, path.join(probe, `f${String(i).padStart(2, '0')}.jpg`))
    }
    const jsonPath = path.join(probe, 'subs.json')
    execFileSync(PYTHON, [path.join(PKG_DIR, 'analyze_subs.py'), probe, jsonPath], { stdio: 'ignore' })
    const r = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    return r.ok ? r : null
  } catch (e) {
    // Python 缺失、分析脚本报错、抽帧失败 —— 一律降级为「没有字幕」，不能让整个流程崩掉
    console.warn(`[字幕] 检测失败（将按无字幕处理）：${String(e.message).split('\n')[0].slice(0, 80)}`)
    return null
  } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }) } catch {}
  }
}

// 抽一帧；失败返回 false 而不是抛异常（t 越界、解码失败都可能发生）
function grabFrame(mp4, t, outFile, quality = 3) {
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', mp4,
      '-an', '-frames:v', '1', '-q:v', String(quality), outFile], { stdio: 'ignore' })
    return fs.existsSync(outFile)
  } catch {
    return false
  }
}

async function stageSubs(bvid, count, bandArg, pre = {}) {
  const pageNo = pre.page ?? 1
  const mp4 = pre.mp4 ?? path.join(CACHE, pageNo > 1 ? `${bvid}-p${pageNo}.mp4` : `${bvid}.mp4`)
  if (!fs.existsSync(mp4)) throw new Error(`没有缓存 mp4，先跑 auto 或 grid：${mp4}`)
  const viewData = pre.view ?? await getView(bvid)
  const page = viewData.pages?.[pageNo - 1]
  const fullDuration = page?.duration ?? viewData.duration
  // 时间区间：字幕行只取 [start, end] 内
  const range = pre.range ?? null
  const start = range?.from ?? 0
  const span = Math.max(0.1, Math.min(range?.to ?? fullDuration, fullDuration) - start)
  // 有场景数据就吸附变化点，没有就纯等间隔（单独跑 subs 时不额外做全片检测）
  const scenes = pre.scenes ?? null
  const times = scenes?.length
    ? snapSubsTimes(span, count, scenes, start)
    : Array.from({ length: count }, (_, i) => start + ((i + 0.5) * span) / count)
  if (range) console.log(`[区间] 字幕带范围 ${fmt(start)}-${fmt(start + span)}`)

  // 决定裁剪范围：[top, bottom] 比例
  let top, bottom, how
  if (bandArg === 'auto') {
    // 显式传了 null（=检测失败）就复用，别为它再检测第二遍
    const r = pre.bandResult !== undefined ? pre.bandResult : detectBand(mp4, fullDuration)
    if (r) {
      top = r.topRatio
      bottom = r.botRatio
      how = `自动检测（${r.frames} 帧，像素 ${r.region.top}-${r.region.bottom}/${r.videoH}）`
    } else {
      top = 0.78
      bottom = 1.0
      how = '自动检测失败，退回 0.78-1.0'
    }
  } else {
    // band 必须是 0~0.6 的比例：NaN / 负数 / 超范围都会让 crop 表达式出错
    const band = Number(bandArg)
    if (!Number.isFinite(band) || band <= 0 || band >= 0.6) {
      throw new Error(`--band 需是 0~0.6 的比例（如 0.22 = 底部 22%），收到：${JSON.stringify(bandArg)}`)
    }
    top = 1 - band
    bottom = 1
    how = `固定比例 ${band}`
  }
  console.log(`[字幕带] ${how}  → 裁剪 ${(top * 100).toFixed(0)}%-${(bottom * 100).toFixed(0)}%`)

  const tmp = path.join(OUT, `.s-${bvid}`)
  fs.mkdirSync(tmp, { recursive: true })
  let ok = 0
  times.forEach((t, i) => {
    const f = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)
    if (!grabFrame(mp4, t, f)) {
      if (ok > 0) fs.copyFileSync(path.join(tmp, `f${String(i - 1).padStart(2, '0')}.jpg`), f)
      else return
    }
    ok++
  })
  if (ok < count) {
    console.warn(`[警告] 只抽到 ${ok}/${count} 帧，字幕带按实际帧数拼接`)
    if (ok === 0) {
      fs.rmSync(tmp, { recursive: true, force: true })
      return { sheet: null, times: [], band: { top, bottom } }
    }
  }
  const out = path.join(OUT, `${bvid}-subs_${count}行.jpg`)
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
      `crop=iw:ih*${(bottom - top).toFixed(4)}:0:ih*${top.toFixed(4)},tile=1x${ok}`,
      '-frames:v', '1', '-q:v', '3', out], { stdio: 'ignore' })
  } catch {
    console.warn('[字幕带] 拼接失败（已跳过，不影响拼图）')
    fs.rmSync(tmp, { recursive: true, force: true })
    return { sheet: null, times: [], band: { top, bottom } }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`SUBS: ${out}`)
  console.log(`  每行对应时间: ${times.map((t, i) => `${i + 1}=${fmt(t)}`).join('  ')}`)
  return { sheet: out, times: times.map((t) => Number(t.toFixed(1))), band: { top, bottom } }
}

// auto：按 token 预算 + 内容变化率，自动决定采样密度、张数和路径
// 平衡原则：先保「看懂所需的最低帧密度」，再在剩余预算里加张数；
// 预算不够时诚实降级并报告，而不是悄悄变稀。
const COST = { grid: 1200, subs: 1000, fine: 1300 } // 单张成本估算（token）
const MAX_GRIDS = 12                                  // 拼图张数硬上限，防长视频失控

// selftest：自检
// 原则：默认不下载视频、几秒内跑完；--deep 才做抽帧和字幕带。
// 覆盖：依赖（ffmpeg/python/analyze_subs.py）→ 凭证 → API（视频/弹幕/字幕）→ 缓存 → 磁盘
function runCapture(cmd, args, timeoutMs = 15000) {
  const tmp = path.join(WS, `.selftest-${process.pid}-${crypto.randomUUID().slice(0, 8)}.txt`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    // 沙箱禁管道捕获 stdout，所以写到文件再读（和 detectScenes 同样的做法）
    execFileSync(cmd, args, { stdio: ['ignore', fd, 'ignore'], timeout: timeoutMs })
    return { ok: true, out: fs.readFileSync(tmp, 'utf8') }
  } catch (e) {
    return { ok: false, out: '', err: String(e?.message ?? e).split('\n')[0] }
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(tmp) } catch {}
  }
}

async function stageSelftest(opts = {}) {
  const rows = []
  const rec = (mark, label, detail = '') => {
    rows.push({ mark, label, detail })
    console.log(`  [${mark}] ${label.padEnd(18)} ${detail}`)
  }
  const t0 = Date.now()
  const deep = opts.deep === true
  console.log('\n== fisheye 自检 ==\n')

  // 1) Node
  const nv = process.versions.node
  rec(Number(nv.split('.')[0]) >= 18 ? 'OK' : '!!', 'Node', `v${nv}${Number(nv.split('.')[0]) >= 18 ? '' : '（需要 ≥18）'}`)

  // 2) ffmpeg：直接试着执行（PATH 命中时 FFMPEG 是命令名而不是路径，
  // 用 existsSync 判断会误报「配置的路径不存在」——这是最常见的安装方式，必须走 runCapture）
  if (!FFMPEG) rec('!!', 'ffmpeg', '未找到（装到 PATH，或设 FFMPEG 环境变量 / 写 ~/.config/fisheye/config.json）')
  else {
    const r = runCapture(FFMPEG, ['-version'], 10000)
    if (r.ok) rec('OK', 'ffmpeg', r.out.split('\n')[0].slice(0, 58))
    else rec('!!', 'ffmpeg', `无法执行（来源 ${FFMPEG_RES?.from ?? '?'}）：${r.err.slice(0, 50)}`)
  }

  // 3) python（字幕带检测用，可选）
  if (!PYTHON) rec('--', 'python', '未找到（字幕带功能会降级，其余不受影响）')
  else {
    const r = runCapture(PYTHON, ['--version'], 10000)
    if (r.ok) rec('OK', 'python', r.out.trim())
    else rec('!!', 'python', `无法执行（来源 ${PYTHON_RES?.from ?? '?'}）：${r.err.slice(0, 50)}`)
  }

  // 4) analyze_subs.py
  const aspy = path.join(PKG_DIR, 'analyze_subs.py')
  rec(fs.existsSync(aspy) ? 'OK' : '!!', 'analyze_subs.py', fs.existsSync(aspy) ? '存在' : '不存在（烧录字幕带检测会失败）')

  // 5) 输出/缓存目录可写
  try {
    const t = path.join(OUT, `.selftest-${process.pid}.tmp`)
    fs.writeFileSync(t, 'ok')
    fs.unlinkSync(t)
    rec('OK', '输出目录', '可写')
  } catch (e) { rec('!!', '输出目录', `不可写：${String(e.message).slice(0, 50)}`) }

  // 6) 凭证
  if (!CRED) rec('!!', 'B站凭证', `未找到（创建 ${path.join(WS, 'credentials.json')}，或设 BILI_CRED 环境变量）`)
  else if (!fs.existsSync(CRED)) rec('!!', 'B站凭证', `配置的路径不存在：${CRED}`)
  else {
    const miss = ['sessdata', 'bili_jct'].filter((k) => !cred[k])
    rec(miss.length ? '!!' : 'OK', 'B站凭证', miss.length ? `缺字段：${miss.join('/')}` : 'SESSDATA + bili_jct 已配置')
  }

  // 7) 视频/弹幕/字幕 API —— 用缓存里的 BV，没有就用默认测试片
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

  // 8) 缓存
  const cacheMb = cached.reduce((s, f) => s + fs.statSync(path.join(CACHE, f)).size, 0) / 1024 / 1024
  rec(cached.length ? 'OK' : '--', '缓存', cached.length ? `${cached.length} 个视频 / ${cacheMb.toFixed(1)} MB` : '空（首次跑会下载）')

  // 9) 磁盘空间
  try {
    const st = fs.statfsSync(WS)
    const freeGb = (st.bsize * st.bavail) / 1024 / 1024 / 1024
    rec(freeGb > 1 ? 'OK' : '!!', '磁盘剩余', `${freeGb.toFixed(1)} GB${freeGb > 1 ? '' : '（长视频缓存可能不够）'}`)
  } catch { rec('--', '磁盘剩余', 'statfs 不可用') }

  // 10) --deep：抽帧 + 字幕带定位
  if (deep) {
    const mp4 = cached.length ? path.join(CACHE, cached[0]) : null
    if (!mp4) {
      rec('--', '抽帧实测', '没有缓存视频可测（先跑一次 auto）')
    } else {
      const tmp = path.join(OUT, `.selftest-frame-${process.pid}.jpg`)
      const okFrame = grabFrame(mp4, 1.0, tmp) && fs.existsSync(tmp) && fs.statSync(tmp).size > 1024
      const size = okFrame ? jpegSize(tmp) : null
      rec(okFrame ? 'OK' : '!!', '抽帧实测', okFrame ? `${cached[0]} → ${size ? `${size.w}x${size.h}` : 'ok'}` : '抽帧失败')
      try { fs.unlinkSync(tmp) } catch {}
      if (okFrame && fs.existsSync(aspy) && PYTHON) {
        // 采样 3 帧喂给字幕带检测脚本
        const dir = path.join(OUT, `.selftest-subs-${process.pid}`)
        fs.mkdirSync(dir, { recursive: true })
        let n = 0
        for (const t of [1, 3, 5]) {
          const f = path.join(dir, `f${n}.jpg`)
          if (grabFrame(mp4, t, f)) n++
        }
        const outJson = path.join(dir, 'r.json')
        const r = runCapture(PYTHON, [aspy, dir, outJson], 30000)
        let band = null
        try { band = JSON.parse(fs.readFileSync(outJson, 'utf8')) } catch {}
        rec(r.ok && band?.ok ? 'OK' : '!!', '字幕带实测', band?.ok
          ? `${(band.topRatio * 100).toFixed(0)}%-${(band.botRatio * 100).toFixed(0)}% 置信度 ${band.confidence}（仅 3 帧采样，数值仅供参考，只验证链路通）`
          : `失败：${(r.err || '无 JSON 输出').slice(0, 50)}`)
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
      } else {
        rec('--', '字幕带实测', '缺少 python 或 analyze_subs.py')
      }
    }
  }

  // 汇总
  const okN = rows.filter((r) => r.mark === 'OK').length
  const badN = rows.filter((r) => r.mark === '!!').length
  const skipN = rows.filter((r) => r.mark === '--').length
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n结果：${okN} 项通过${badN ? ` / ${badN} 项失败` : ''}${skipN ? ` / ${skipN} 项跳过` : ''}（${secs}s）`)
  if (badN) {
    console.log('\n怎么修：')
    console.log('  · ffmpeg/python 缺失 → 用环境变量指定路径：FFMPEG=/path/to/ffmpeg.exe  PYTHON=...')
    console.log('  · 凭证缺失         → 在 B 站登录态文件里补 sessdata / bili_jct')
    console.log('  · API 失败         → 检查网络；bilibili 接口可能改了，需要更新代码')
    console.log('  · 字幕带失败       → 确认 python 有 numpy + Pillow')
  } else {
    console.log('✅ 全部通过')
  }
  if (!deep) console.log('\n（想看抽帧/字幕带实测，加 --deep）')
  return { ok: badN === 0, rows }
}

async function stageAuto(bvid, budget, opts = {}) {
  const pageNo = opts.page ?? 1
  const mp4 = await ensureMp4(bvid, pageNo)
  const view = await getView(bvid)
  const pageCount = view.pages?.length ?? 1
  const page = view.pages?.[pageNo - 1]
  if (pageNo > 1 && !page) throw new Error(`没有第 ${pageNo} 个分P（这条视频共 ${pageCount} 个）`)
  const fullDuration = page?.duration ?? view.duration
  const cid = page?.cid ?? view.cid

  // 时间范围：所有内部计算用「区间长度」，但对外（manifest/日志/精读）都用全局秒数
  const start = Math.max(0, Number(opts.from ?? 0))
  const end = (opts.to !== null && opts.to !== undefined) ? Number(opts.to) : fullDuration
  // 上界校验：--from 超出视频时长时，后面的 duration 会算出负数，
  // 再往下 chunk 变负 → pickTimes 返回 null → 打印「整段都是疑似广告」，是误导性日志
  if (!Number.isFinite(start) || start >= fullDuration) {
    throw new Error(`--from(${Number.isFinite(start) ? start : opts.from}s) 超出视频时长（${fullDuration}s）`)
  }
  if (!Number.isFinite(end) || end <= start) {
    throw new Error(`--to(${opts.to ?? fullDuration}s) 必须大于 --from(${start}s)，视频时长 ${fullDuration}s`)
  }
  const duration = Math.min(end, fullDuration) - start
  const range = start > 0 || end < fullDuration ? { from: start, to: Math.min(end, fullDuration) } : null

  console.log(`\n=== 规划：${view.title}${pageCount > 1 ? ` · P${pageNo}/${pageCount}` : ''}（${fullDuration}s）===`)
  if (range) console.log(`[区间] 只处理 ${fmt(range.from)}-${fmt(range.to)}（${duration.toFixed(0)}s / 全片 ${fullDuration}s）`)
  if (pageCount > 1 && pageNo === 1) console.log(`[提示] 多P 视频，本次只处理 P1；要处理别的分P 用 --p N`)

  // 拼图 token 按实际画面比例修正：COST.grid 以 1920x1080 拼图为基准，
  // 方形/竖屏视频的拼图面积大得多（1920x1920 贵 78%，竖屏贵 3 倍+），不算清楚会误导预算决策
  const dim = view.dimension ?? {}
  const vw = Number(dim.width) || 1280
  const vh = Number(dim.height) || 720
  const cellH = Math.round((640 * vh) / Math.max(vw, 1))
  const sheetPx = 640 * 3 * (cellH * 3)
  const gridCost = Math.max(300, Math.round((COST.grid * sheetPx) / (1920 * 1080)))
  if (Math.abs(sheetPx / (1920 * 1080) - 1) > 0.25) {
    console.log(`[比例] 画面 ${vw}x${vh} → 拼图 ${640 * 3}x${cellH * 3}，单张约 ${gridCost} token（基准 1200 已按面积修正）`)
  }

  // 1. 内容变化率：只统计所处理区间内的显著变化（score≥0.3）
  const scenes = detectScenes(mp4)
  const rangeScenes = range ? scenes.filter((s) => s.t >= range.from && s.t <= range.to) : scenes
  const strong = rangeScenes.filter((s) => s.score >= 0.3)
  const rate = duration > 0 ? strong.length / duration : 0
  console.log(`[内容] 显著变化 ${strong.length} 处${range ? '（区间内）' : ''}，变化率 ${rate.toFixed(2)} 次/秒`)

  // 2. 字幕：官方字幕优先（文本几百 token，比抽字幕带图快且准）；没有才考虑烧录字幕带
  const officialRaw = await getOfficialSubs(bvid, cid, range)
  // 质量太差的官方字幕（音乐/音效被 ASR 成 碎片）不能用，误当台词会让理解完全跑偏
  const official = officialRaw?.quality === 'ok' ? officialRaw : null
  let bandResult = null
  let hasSubs = false
  if (official) {
    console.log(`[字幕] 官方${official.lanDoc ?? ''} ${official.lines} 行 / ${official.chars} 字 ≈ ${official.chars} token → 跳过字幕带`)
    console.log(`       文本: ${official.txt}`)
    if (official.chars > 8000) {
      console.log(`       ⚠️ 字幕较长（${official.chars} 字 ≈ ${official.chars} token），建议只读关心的时段而不是全文`)
    }
    for (const line of official.head.slice(0, 3)) console.log(`       ${line}`)
  } else {
    if (officialRaw) {
      console.log(`[字幕] 官方字幕质量差（平均有效 ${officialRaw.avgEff} 字/行、去重率 ${officialRaw.uniqueRatio}）——疑为音乐/音效噪声，不采用`)
    }
    // 传 fullDuration 而不是区间长度：字幕位置是视频级属性，采样必须跨全片
    bandResult = detectBand(mp4, fullDuration)
    // 置信度门槛：抖音式动态字幕（位置漂移 / 不是每帧都有）检测出来的「带」其实是画面内容，
    // 拼出来一堆非字幕行。低于 0.5 就不用字幕带，只靠画面拼图。
    const conf = bandResult?.confidence
    const confOk = conf === undefined || conf >= 0.5
    hasSubs = !!(bandResult?.ok && bandResult.bandRatio >= 0.015 && bandResult.bandRatio <= 0.35 && confOk)
    if (bandResult?.ok && !confOk) {
      console.log(`[字幕] 检出疑似字幕带（${(bandResult.topRatio * 100).toFixed(0)}%-${(bandResult.botRatio * 100).toFixed(0)}%）但置信度仅 ${Number(conf).toFixed(2)}`)
      console.log(`       —— 字幕位置漂移或不是每帧都有（抖音式动态字幕常见），跳过字幕带，只靠画面`)
    } else {
      console.log(`[字幕] ${hasSubs
        ? `无可用官方字幕，检出烧录字幕带（${(bandResult.topRatio * 100).toFixed(0)}%-${(bandResult.botRatio * 100).toFixed(0)}%，置信度 ${Number(conf).toFixed(2)}）→ 字幕带 1 张`
        : '无可用字幕 → 只靠画面'}`)
    }
  }

  // 2.5 弹幕（第三个信息源：观众反应）
  // 不参与「能不能看懂」的判定，只用来找高光——观众在哪一段最激动，那里通常最值得精读
  const danmakuRaw = await getDanmaku(cid, range)
  const { kept: danmaku, dropped } = filterDanmaku(danmakuRaw)
  if (danmakuRaw?.length) {
    const parts = []
    if (dropped.ad) parts.push(`${dropped.ad} 条广告引流`)
    if (dropped.noise) parts.push(`${dropped.noise} 条无意义刷屏`)
    if (parts.length) {
      console.log(`[弹幕] 原始 ${danmakuRaw.length} 条，已过滤 ${parts.join(' / ')}`)
      for (const s of dropped.samples) console.log(`       样本：${s}`)
    }
  }
  const dmHot = summarizeDanmaku(danmaku)
  // 视频内广告段（靠弹幕密度低谷 + 关键词；见 detectAdSegments 注释）
  const adSegs = detectAdSegments(danmaku, fullDuration)
  if (adSegs.length) {
    console.log(`[广告段] 弹幕密度低谷 ${adSegs.length} 段：`)
    for (const s of adSegs) {
      const tag = s.confidence === 'high' ? '疑似广告' : '低互动段（未必是广告）'
      const kw = s.keywords.length ? `  关键词「${s.keywords.join('」「')}」` : ''
      console.log(`       ${s.ts}（${s.dur}s）${tag}  密度比全片低 ${(s.lowDensity * 100).toFixed(0)}%${kw}`)
    }
  }
  if (danmaku?.length) {
    console.log(`[弹幕] ${danmaku.length} 条${range ? '（区间内）' : ''}${dmHot?.length ? '，观众最激动的时段：' : ''}`)
    for (const h of dmHot ?? []) {
      console.log(`       ${h.ts}  ${String(h.count).padStart(3)} 条  「${h.samples.join('」「')}」`)
    }
  } else {
    console.log('[弹幕] 无（视频关弹幕 / 无人发 / 获取失败）')
  }

  // 3. 看懂所需的最低帧间隔（可由 --density 强制覆盖）
  let maxGap
  if (opts.density) maxGap = opts.density
  else if (rate > 1.2) maxGap = 4   // 快剪 / MV / 游戏
  else if (rate > 0.5) maxGap = 6   // vlog / 教程
  else if (rate > 0.15) maxGap = 9  // 口播 / 慢节奏
  else maxGap = 13                  // 静态 / 录屏
  console.log(`[密度] 目标 ≤${maxGap}s/帧（${opts.density ? '手动指定' : '按变化率推导'}）`)

  // 4. 张数：先满足密度，再看预算
  const framesNeeded = Math.ceil(duration / maxGap)
  const minGrids = Math.max(1, Math.ceil(framesNeeded / 9))

  const subsCost = official ? Math.round(official.chars) : hasSubs ? COST.subs : 0
  const subsRows = duration <= 180 ? 14 : duration <= 600 ? 20 : 24
  const minFine = (official || hasSubs) ? 2 : 3   // 字幕已在手，精读需求自然变少
  const fixedCost = subsCost + minFine * COST.fine
  const maxGridsByBudget = Math.max(1, Math.floor((budget - fixedCost) / gridCost))

  let gridCount = minGrids
  const notes = []
  if (gridCount > maxGridsByBudget) {
    notes.push(`预算只够 ${maxGridsByBudget} 张（密度会变稀）`)
    gridCount = maxGridsByBudget
  }
  if (gridCount > MAX_GRIDS) {
    notes.push(`触及张数上限 ${MAX_GRIDS}`)
    gridCount = MAX_GRIDS
  }
  gridCount = Math.max(1, gridCount)

  const chunk = duration / gridCount
  const actualGap = duration / (gridCount * 9)

  // 5. 报告
  const estTotal = subsCost + gridCount * gridCost + minFine * COST.fine
  console.log(`[张数] 密度需要 ${minGrids} 张，预算允许 ${maxGridsByBudget} 张 → 采用 ${gridCount} 张`)
  console.log(`[参数] chunk=${chunk.toFixed(1)}s（每张覆盖），实际平均 ${actualGap.toFixed(1)}s/帧`)
  console.log(`[预算] ${budget} token ≈ 字幕带 ${subsCost} + 拼图 ${gridCount * gridCost} + 精读预留 ${minFine * COST.fine} = ${estTotal}`)
  if (estTotal > budget) {
    console.log(`[警告] 最低配置已要 ${estTotal} token，超出预算 ${budget}（字幕带和精读预留不可再砍），将超支运行`)
  }
  if (actualGap > maxGap + 0.5) console.log(`[降级] 实际 ${actualGap.toFixed(1)}s/帧 稀于目标 ${maxGap}s/帧：${notes.join('；')}`)
  if (notes.length) console.log(`[备注] ${notes.join('；')}`)

  // 6. 执行铺网
  console.log(`\n--- 生成 ---`)
  const pre = {
    mp4, view, scenes, bandResult, subsSheet: hasSubs, range, page: pageNo,
    subsCovered: !!(official || hasSubs),          // 字幕信息是否已被覆盖（官方文本或烧录字幕带）
    subsSource: official ? 'official' : hasSubs ? 'burned-in' : null,
    danmakuHot: dmHot,                             // 写进 manifest，让 refine 也能用弹幕热区挑点
    danmakuTotal: danmaku?.length ?? 0,
    adSegments: adSegs,                            // 视频内疑似广告段（精读会避开 high 置信度的）
    useDanmakuFrames: opts.useDanmakuFrames !== false,  // 弹幕热区是否也参与铺网取帧（默认是）
  }
  const manifest = await stageGrid(bvid, chunk, '3x3', pre)
  if (hasSubs) await stageSubs(bvid, subsRows, 'auto', { mp4, view, bandResult, scenes, range, page: pageNo })

  // 7. 精读建议 = 几何规则（画面变化剧烈）+ 弹幕热区（观众反应最激烈）
  // 两个信号互补：几何只看像素，弹幕看人的反应；合并后按时间排序、同一时刻只留一个
  const geo = geometricPick(manifest)
  const dmPicks = (dmHot ?? []).map((h) => {
    const mid = h.start + 2.5
    return {
      t: mid,
      ts: fmt(mid),   // 和 t 保持一致（桶中点），否则排序后显示会错乱
      reason: `弹幕热区 ${h.count} 条：「${h.samples.join('」「')}」`,
      source: '弹幕热区',
    }
  })
  const seen = new Set()
  const suggestions = []
  for (const p of [...dmPicks, ...geo]) {
    const key = Math.round(p.t)
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push(p)
  }
  suggestions.sort((a, b) => a.t - b.t)

  console.log(`\n=== 完成 ===`)
  console.log(`预计 token ≈ ${estTotal}（若铺网信息已自足、跳过精读，实际会更低）`)
  if (official) {
    console.log(`\n[字幕] 台词已存成文本，直接读（别为字幕抽帧）：`)
    console.log(`       ${official.txt}`)
  }
  if (suggestions.length) {
    console.log(`\n[精读建议] ${suggestions.length} 个时间点（几何 ${geo.length} + 弹幕 ${dmPicks.length}）：`)
    for (const p of suggestions) console.log(`  ${p.ts}  ${p.source}  —— ${p.reason}`)
    console.log(`  需要时: node fisheye.mjs refine ${bvid}`)
    console.log(`  （几何只能找「变化剧烈」、弹幕只能找「观众反应」；读图发现其他格看不清时，走 refine --template/--decisions）`)
  } else {
    console.log(`\n[精读建议] 两个信号都没命中；读图后如需精读：node fisheye.mjs refine ${bvid} --template`)
  }
  return { gridCount, chunk, actualGap, maxGap, hasSubs, estTotal, notes, danmaku: danmaku?.length ?? 0, top: suggestions }
}

// refine：决定哪些格需要精读，然后自动截原分辨率单帧
// 两种模式
// --template 生成决策模板（每格一行，agent 读完拼图后填 needDetail）
// --decisions <file.json> 按 agent 的结构化判断执行
// 都不传 几何兜底：只凭像素算，零 token（不读图）
// 分工原则：语义判断（"这格重要吗"）只有读图能做；几何判断（"这格的字一定糊"）可以纯计算。
const MIN_READABLE_SUBS_PX = 12 // 拼图里字幕低于这个像素高度就必然糊

function buildDecisionTemplate(manifest) {
  const cells = []
  for (const c of manifest.chunks) {
    for (const cell of c.cells) {
      cells.push({
        chunk: c.chunk, cell: cell.cell, t: cell.t, ts: cell.ts, scene: cell.scene,
        desc: '',          // 填：这一格你看到了什么
        needDetail: false, // 填：是否要看原分辨率
        reason: '',        // 填：为什么要看（字幕糊 / 特写 / 看不清某物）
      })
    }
  }
  return {
    bvid: manifest.bvid,
    title: manifest.title,
    note: '逐格填 desc 和 needDetail；reason 写理由。needDetail=true 的会被自动截原图。',
    cells,
  }
}

function geometricPick(manifest) {
  const { subs, videoWidth, videoHeight, sheetWidth } = manifest
  // 字幕是否已被覆盖（官方文本 / 烧录字幕带）；旧 manifest 只有 subsSheet
  const subsCovered = manifest.subsCovered ?? manifest.subsSheet ?? false
  const picks = []
  // 弹幕热区也参与挑点：观众在哪一段最激动，那里通常最值得单独看原图
  for (const h of manifest.danmaku?.hot ?? []) {
    // t 取桶中点（不是桶起点），ts 也用中点 —— 两者必须一致，否则按 t 排序时显示会错乱
    const mid = Number(h.start) + 2.5
    picks.push({
      t: mid,
      ts: fmt(mid),
      scene: 1,
      chunk: 0,
      cell: 0,
      reasons: [`弹幕热区 ${h.count} 条：「${(h.samples ?? []).join('」「')}」`],
    })
  }
  for (const c of manifest.chunks) {
    const [cols] = c.grid.split('x').map(Number)
    const cellW = sheetWidth && cols ? sheetWidth / cols : null
    const scale = cellW && videoWidth ? cellW / videoWidth : null
    // 字幕在拼图里还剩多少像素
    const subsPx = subs && scale && videoHeight
      ? (subs.bottom - subs.top) * videoHeight * scale
      : null
    for (const cell of c.cells) {
      const reasons = []
      // 字幕糊：只在「字幕信息还没被覆盖」时才值得逐帧精读
      if (subsPx !== null && subsPx < MIN_READABLE_SUBS_PX && !subsCovered) {
        reasons.push(`字幕在拼图里只剩 ${subsPx.toFixed(1)}px（低于 ${MIN_READABLE_SUBS_PX}px，必然糊）`)
      }
      if (cell.scene >= 0.85) reasons.push(`画面变化强度 ${cell.scene}，信息密度高`)
      if (reasons.length) {
        picks.push({ t: cell.t, ts: cell.ts, chunk: c.chunk, cell: cell.cell, scene: cell.scene, reasons })
      }
    }
  }
  // 精读避开高置信度广告段：那里不值得花 token 看原图（标注给 agent 知道即可）
  const adHigh = (manifest.adSegments ?? []).filter((s) => s.confidence === 'high')
  const inAd = (t) => adHigh.some((s) => t >= s.from - 5 && t <= s.to + 5)

  // 按信号强度排序，最多取 8 个（几何规则 + 弹幕热区合并后），避免把整片都标成必读
  // 去重按「秒」：不同信号可能指向同一时刻（82.18 和 82.5 显示都是 01:22），保留更靠前的
  // （scene 排序已把弹幕热区放前面，因为它的理由更具体：观众反应）
  const seenSec = new Set()
  const deduped = []
  for (const p of picks.sort((a, b) => b.scene - a.scene)) {
    if (inAd(p.t)) continue                              // 广告段不出现在精读建议里
    const sec = Math.floor(p.t)
    if (seenSec.has(sec)) continue
    seenSec.add(sec)
    deduped.push(p)
  }
  return deduped
    .slice(0, 8)
    .sort((a, b) => a.t - b.t)   // 按时间顺序展示
    .map((p) => ({
      t: p.t,
      ts: p.ts,
      reason: p.reasons.join('；'),
      source: p.chunk ? `图${p.chunk} #${p.cell} 几何规则` : '弹幕热区',
    }))
}

async function stageRefine(bvid, opts) {
  const mfPath = path.join(OUT, `${bvid}-manifest.json`)
  if (!fs.existsSync(mfPath)) throw new Error(`没有 manifest，先跑 auto 或 grid：${mfPath}`)
  const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'))

  if (opts.template) {
    const tpl = buildDecisionTemplate(manifest)
    const p = path.join(OUT, `${bvid}-decisions.template.json`)
    fs.writeFileSync(p, JSON.stringify(tpl, null, 2), 'utf8')
    console.log(`决策模板: ${p}`)
    console.log(`共 ${tpl.cells.length} 格。读完拼图后填 needDetail=true，再执行：`)
    console.log(`  node fisheye.mjs refine ${bvid} --decisions "${p}"`)
    return { template: p, cells: tpl.cells.length }
  }

  let picks
  if (opts.decisions) {
    // 去掉 BOM —— PowerShell 的 Set-Content -Encoding UTF8 和记事本都会加，JSON.parse 会炸
    const txt = fs.readFileSync(opts.decisions, 'utf8').replace(/^\uFEFF/, '')
    const d = JSON.parse(txt)
    const all = (d.cells ?? []).filter((x) => x.needDetail)
    // 校验时间范围：越界的时间点截不出帧，提前报出来而不是静默失败
    const dur = manifest.duration ?? Infinity
    const bad = all.filter((x) => typeof x.t !== 'number' || x.t < 0 || x.t > dur)
    if (bad.length) {
      console.warn(`[警告] ${bad.length} 个时间点越界或格式错误，已忽略：${bad.map((x) => x.t).join(', ')}`)
    }
    picks = all.filter((x) => typeof x.t === 'number' && x.t >= 0 && x.t <= dur).map((x) => ({
      t: x.t,
      ts: x.ts ?? fmt(x.t),
      reason: x.reason || x.desc || '模型判断需要细看',
      source: `图${x.chunk} #${x.cell}`,
    }))
  } else {
    picks = geometricPick(manifest)
  }

  if (!picks.length) {
    console.log('没有需要精读的点（几何规则未命中，也没给 decisions）')
    return { picks: [] }
  }

  console.log(`\n[精读] 选中 ${picks.length} 个时间点：`)
  for (const p of picks) console.log(`  ${p.ts}  ${p.source}  —— ${p.reason}`)
  if (picks.length > 8) {
    console.warn(`[警告] ${picks.length} 帧 ≈ ${picks.length * COST.fine} token，建议先只留真正看不清的几帧再跑`)
  }
  console.log('')
  const grabbed = await stageGrab(bvid, picks.map((p) => p.t).join(','), { page: manifest.page ?? 1 })
  const est = picks.length * COST.fine
  console.log(`\n精读成本 ≈ ${est} token（${picks.length} 帧 × ${COST.fine}）`)
  return { picks, grabbed }
}

async function stageGrab(bvid, timeStr, opts = {}) {
  const pageNo = opts.page ?? 1
  const mp4 = path.join(CACHE, pageNo > 1 ? `${bvid}-p${pageNo}.mp4` : `${bvid}.mp4`)
  if (!fs.existsSync(mp4)) throw new Error(`没有缓存 mp4，先跑 auto 或 grid：${mp4}`)
  // 注意 Number('') === 0：必须先滤掉空串，否则空输入会变成「0 秒」
  const times = timeStr
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n))
  if (!times.length) {
    console.error('没有有效时间点（格式：44,59.5,79.9）')
    return []
  }
  const out = []
  for (const t of times) {
    // 2 位小数：1.73 和 1.74 若只留 1 位都会变成 1_7s，后一个会覆盖前一个
    const f = path.join(OUT, `${bvid}-grab-${t.toFixed(2).replace('.', '_')}s.jpg`)
    // 和拼图用同一种 seek（-ss 前置），保证「拼图上第 N 格」和「精读的同一时间点」是同一帧。
    if (!grabFrame(mp4, t, f, 2)) {
      console.warn(`[精读帧] ${fmt(t)} 抽取失败（时间越界或解码出错），跳过`)
      continue
    }
    out.push({ t, ts: fmt(t), file: f })
    console.log(`[精读帧] ${fmt(t)} → ${f}`)
  }
  console.log(JSON.stringify(out, null, 2))
  return out
}


// 本地视频：不依赖 B站，直接用 ffmpeg 抽帧拼图（fisheye local <文件>）
async function stageLocal(inputFile, opts = {}) {
  const file = path.resolve(inputFile)
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`)
  if (!FFMPEG) throw new Error('找不到 ffmpeg（设置 FFMPEG 环境变量，或放到 ~/.dsh/surfcore/bili/bin/ffmpeg.exe）')
  const grid = String(opts.grid || '3x3').toLowerCase()
  const [cols, rows] = grid.split('x').map(Number)
  if (!cols || !rows || cols < 1 || rows < 1 || cols > 9 || rows > 9) throw new Error('grid 格式应为 3x3 / 4x4 / 5x5')
  const n = cols * rows
  // 用 ffmpeg 解析时长：stderr 写临时文件，避免依赖管道捕获
  const probeTmp = path.join(os.tmpdir(), `fisheye-local-probe-${process.pid}-${Date.now()}.txt`)
  try {
    const fd = fs.openSync(probeTmp, 'w')
    spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', fd], timeout: 30000 })
    fs.closeSync(fd)
  } catch {}
  let text = ''
  try { text = fs.readFileSync(probeTmp, 'utf8') } catch {}
  try { fs.unlinkSync(probeTmp) } catch {}
  const durm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  if (!durm) throw new Error('读不出视频时长（ffmpeg 无法解析该文件？）')
  const duration = (+durm[1]) * 3600 + (+durm[2]) * 60 + (+durm[3])
  const from = Math.max(0, Number(opts.from) || 0)
  const to = Number.isFinite(opts.to) && opts.to > from ? Math.min(opts.to, duration) : duration
  const segDur = Math.max(0.5, to - from)
  const interval = Math.max(0.1, segDur / n)
  const base = path.basename(file, path.extname(file)).replace(/[^\w.-]+/g, '_').slice(0, 40)
  fs.mkdirSync(OUT, { recursive: true })
  const outPath = path.join(OUT, `local-${base}-${grid}-${Date.now()}.jpg`)
  const vf = `fps=1/${interval.toFixed(4)},scale=480:-2,tile=${cols}x${rows}`
  const r = spawnSync(FFMPEG, ['-y', '-ss', String(from.toFixed(3)), '-t', String(segDur.toFixed(3)), '-i', file, '-vf', vf, '-frames:v', '1', '-q:v', '3', outPath], { stdio: 'ignore', timeout: 600000 })
  if (r.status !== 0 || !fs.existsSync(outPath)) throw new Error('抽帧拼图失败（ffmpeg 返回非 0 或没有输出图）')
  console.log(`时长: ${duration.toFixed(1)}s | 区间: ${from.toFixed(1)}-${to.toFixed(1)}s | 抽帧: ${n} 张 (${grid}) | 间隔 ${interval.toFixed(1)}s`)
  console.log(`SHEET: ${outPath}`)
  return { sheet: outPath, duration, from, to, grid }
}

// CLI
const argv = process.argv.slice(2)
const stage = argv[0]
// BV 号固定是 BV + 10 位字母数字。入口就校验，不接受任意字符串
// 它会被拼进文件名（out/cache）和 API URL —— 放过 "../" 就是路径穿越，放过 "&?#" 会污染 query。
// 这个工具要给 AI agent 用，传入的 BV 号未必可信。
const rawBvid = argv[1]
const bvid = rawBvid && /^BV[0-9A-Za-z]{10}$/.test(rawBvid) ? rawBvid : ''
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
if (stage === 'local') {
  const fileArg = argv[1]
  if (!fileArg || fileArg.startsWith('--')) {
    console.error('用法: node fisheye.mjs local <视频文件> [--grid 3x3] [--from t] [--to t]')
    process.exit(2)
  }
  try {
    await stageLocal(fileArg, {
      grid: opt('grid', '3x3'),
      from: parseTime(opt('from', null), 'from'),
      to: parseTime(opt('to', null), 'to')
    })
  } catch (error) {
    console.error(`[错误] ${error?.message ?? error}`)
    process.exit(1)
  }
  process.exit(0)
}
if (!stage || (stage !== 'selftest' && !bvid)) {
  if (rawBvid && stage !== 'selftest') {
    console.error(`[错误] BV 号格式不对：${rawBvid}（应为 BV + 10 位字母数字，如 BV1ziWP6qENy）\n`)
  }
  console.log('用法:')
  console.log('  node fisheye.mjs auto <BV> [--budget 20000] [--density 6]      ← 推荐：自动规划并铺网')
  console.log('  node fisheye.mjs refine <BV> --template                         ← 生成精读决策模板')
  console.log('  node fisheye.mjs refine <BV> --decisions <file.json>            ← 按模型判断精读')
  console.log('  node fisheye.mjs refine <BV>                                    ← 几何兜底（零 token）')
  console.log('  node fisheye.mjs grid <BV> [--chunk 60] [--grid 3x3]')
  console.log('  node fisheye.mjs subs <BV> [--count 12] [--band auto|0.22]')
  console.log('  node fisheye.mjs grab <BV> <t1,t2,t3>                           ← 手动指定时间点')
  console.log('  node fisheye.mjs local <视频文件> [--grid 3x3] [--from t] [--to t]  ← 看本地视频（mp4/mkv/...）')
  console.log('  node fisheye.mjs selftest [--deep]                              ← 自检（依赖/凭证/API/缓存/磁盘）')
  process.exit(2)
}
// 顶层错误兜底：不要把堆栈直接甩给用户
try {
  const page = pageNum(opt('p', null))
  const from = parseTime(opt('from', null), 'from')
  const to = parseTime(opt('to', null), 'to')
  // 只给了一端时，另一端交给各 stage 用视频实际时长补齐
  const range = (from !== null || to !== null)
    ? { from: from ?? 0, to: to ?? Number.POSITIVE_INFINITY }
    : null

  if (stage === 'selftest') {
    await stageSelftest({ deep: argv.includes('--deep') })
  } else if (stage === 'auto') {
    const d = opt('density', null)
    await stageAuto(bvid,
      num(opt('budget', 20000), 'budget', { min: 2000, max: 200000 }),
      { density: d === null ? null : num(d, 'density', { min: 0.5, max: 60 }), page, from, to,
        useDanmakuFrames: !argv.includes('--no-danmaku-frames') })
  } else if (stage === 'refine') {
    await stageRefine(bvid, { template: argv.includes('--template'), decisions: opt('decisions', null) })
  } else if (stage === 'grid') {
    await stageGrid(bvid,
      num(opt('chunk', 60), 'chunk', { min: 1, max: 3600 }),
      gridStr(opt('grid', '3x3')),
      { page, range })
  } else if (stage === 'subs') {
    await stageSubs(bvid,
      num(opt('count', 12), 'count', { min: 1, max: 50 }),
      opt('band', 'auto'),
      { page, range })
  } else if (stage === 'grab') await stageGrab(bvid, argv[2] ?? '', { page })
  else { console.error('未知阶段: ' + stage); process.exit(2) }
} catch (e) {
  console.error(`\n错误：${e.message}`)
  if (process.env.FISHEYE_DEBUG) console.error(e.stack)
  process.exit(1)
}


