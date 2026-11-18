// lib/render.mjs — render --plan（2.0 设计 01 §3.6/3.7：按 plan.json 惰性渲染）
//
// auto（fast）只产文本 + visualRequest 标记；agent 决定读图时调 render --plan，
// 选轨（coarse/algorithm/adaptive/lowconf）+ 选段，惰性出图。类型判定在这里做
// （需要 changeRate → 补跑一次场景检测）。
import fs from 'node:fs'
import path from 'node:path'
import { OUT } from './env.mjs'
import { detectScenes } from './frame.mjs'
import { trackFrameTimes, renderTrack, pickTimesSingle } from './tracks.mjs'
import { detectVideoType } from './video-type.mjs'
import { fmt } from './util.mjs'

function parseSegments(raw) {
  if (!raw) return null // null = 全片
  const out = new Set()
  for (const p of String(raw).split(',')) {
    const n = Number(p.trim())
    if (Number.isInteger(n) && n >= 0) out.add(n)
  }
  return out.size ? out : null
}

/**
 * 按 plan.json 渲染指定轨/段。
 * @param {object} source 平台适配器 VideoSource
 * @param {object} opts { plan?, track='coarse', segments?, page=1 }
 * @returns {Promise<string[]>} 生成的拼图路径
 */
export async function stageRender(source, opts = {}) {
  const planPath = opts.plan ?? path.join(OUT, `${source.id}-plan.json`)
  if (!fs.existsSync(planPath)) throw new Error(`没有 plan.json，先跑 auto：${planPath}`)

  // 旧 manifest 拒绝（设计 05 §7.6 / 第 3 批验收）：schemaVersion 1（1.0.29 产物）字段已改名，明确提示重跑
  const mfPath = path.join(OUT, `${source.id}-manifest.json`)
  if (fs.existsSync(mfPath)) {
    try {
      const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'))
      if (mf.schemaVersion !== 2) {
        throw new Error(`旧 manifest（schemaVersion ${mf.schemaVersion ?? (mf.version ?? 'unknown')}，1.0.29 产物）字段已改名（adSegments→lowActivitySegments），请重跑 auto 生成 2.0 产物`)
      }
    } catch (e) {
      if (/旧 manifest/.test(e.message)) throw e
      // manifest 损坏按「不存在」处理，后续读 evidence 时降级为 null
    }
  }

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  const track = opts.track ?? 'coarse'
  const segIdx = parseSegments(opts.segments)

  const mp4 = await source.media(opts.page ?? 1)

  // algorithm/adaptive/lowconf 需要场景检测；coarse 不需要
  const scenes = track === 'coarse' ? [] : detectScenes(mp4)

  // 时长：从 plan.json 尾段（coarse 也要用它算全片 4 分钟/帧）
  let duration = plan.length ? plan[plan.length - 1].to : 0

  // adaptive/lowconf 需要类型判定（changeRate = 显著变化次数 / 时长）
  let typeInfo = null
  if (track === 'adaptive' || track === 'lowconf') {
    const meta = await source.meta()
    duration = meta.duration ?? duration
    const strong = scenes.filter((s) => s.score >= 0.3)
    const changeRate = duration > 0 ? strong.length / duration : 0

    // P1-①：从 manifest.json 读真实证据，缺失传 null（不硬编码 0/true 让假判据恒命中）
    const mfPath = path.join(OUT, `${source.id}-manifest.json`)
    let manifest = null
    try { manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8')) } catch { /* manifest 缺失时元数据全 null */ }
    const ev = manifest?.evidence ?? {}
    typeInfo = detectVideoType({
      changeRate,
      subsLang: ev.subs?.lang ?? null,
      subsChars: ev.subs?.chars ?? null,
      danmakuCount: ev.danmaku?.count ?? null,
      hasTranslated: ev.subs?.source === 'official-translated',
      hasAudio: null,        // 音频流探测未实现 → null（缺失不触发 screen）
      avgVolume: null,       // 音量探测未实现 → null
      subsMusicRatio: null,  // 歌词占比未实现 → null
    })
    console.error(`[类型] ${typeInfo.type ?? 'null'}（confidence ${typeInfo.confidence}；音频/音量/歌词占比未采，判据部分缺失）`)
  }

  // 低活跃段（plan.json 里 lowActivity=true 的段）
  const lowSegs = plan.filter((s) => s.lowActivity).map((s) => ({ from: s.from, to: s.to }))

  const sheets = []
  const selected = plan.filter((s) => (segIdx ? segIdx.has(s.i) : true))

  if (track === 'coarse') {
    // 全片 4 分钟/帧（设计 01 §3.4：1~2 张/40 分钟），分 9 帧/张
    const allTimes = trackFrameTimes('coarse', { from: 0, to: duration })
    for (let i = 0; i < allTimes.length; i += 9) {
      const batch = allTimes.slice(i, i + 9)
      const sheet = renderTrack(mp4, batch, { outName: `${source.id}-coarse-${Math.floor(i / 9)}`, grid: '3x3' })
      if (sheet) sheets.push({ track: 'coarse', sheet, times: batch })
    }
    console.error(`[coarse] 全片 ${allTimes.length} 帧 → ${sheets.length} 张`)
  } else if (track === 'lowconf') {
    // 低置信拼图（设计 01 §3.7）：低活跃段帧 + 骨架未吸附帧打包，时间戳标在 manifest 而非图上
    const lowTimes = []
    for (const seg of selected) {
      if (!seg.lowActivity && !seg.needsFrames) continue
      lowTimes.push((seg.from + seg.to) / 2)
    }
    if (lowTimes.length) {
      const sheet = renderTrack(mp4, lowTimes, { outName: `${source.id}-lowconf`, grid: '3x3' })
      if (sheet) sheets.push({ track: 'lowconf', sheet, times: lowTimes })
    }
    console.error(`[低置信拼图] ${lowTimes.length} 帧（时间戳见 manifest）`)
  } else {
    // algorithm/adaptive：按段渲染（每段 9 帧拼 1 张）
    for (const seg of selected) {
      const times = trackFrameTimes(track, {
        from: seg.from, to: seg.to, n: 9, scenes, lowSegs, type: typeInfo?.type ?? 'unknown',
      })
      if (!times.length) continue
      const sheet = renderTrack(mp4, times, { outName: `${source.id}-${track}-s${seg.i}`, grid: '3x3' })
      if (sheet) sheets.push({ track, seg: seg.i, sheet, times })
      console.error(`[渲染] 段 ${seg.i + 1} ${fmt(seg.from)}-${fmt(seg.to)} ${track} ${times.length} 帧 → ${path.basename(sheet)}`)
    }
  }

  // stdout 只给路径（设计 08 §11.7）
  for (const s of sheets) console.log(`SHEET: ${s.sheet}`)
  return sheets
}
