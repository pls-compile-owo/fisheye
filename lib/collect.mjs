// 采集层（collect.mjs）：把「下载/元信息/场景/字幕/转写/弹幕/广告/语义」这些
// 信号采集从 stageAuto 编排里抽出来，返回一个纯数据 ctx。
// 好处：编排层只剩「采集 → 决策(planner) → 执行(stageGrid) → 建议(executor)」，
// 采集可单测（用 mock source 或本地假视频）。
import fs from 'node:fs'
import path from 'node:path'
import { OUT } from './env.mjs'
import { fmt } from './util.mjs'
import { detectScenes, detectBand } from './frame.mjs'
import { filterDanmaku } from '../danmaku-filter.mjs'
import { audioCaps, transcribeAudio } from './audio.mjs'
import { semanticCaps, semanticSegment } from './semantic.mjs'
import {
  summarizeDanmaku,
  detectAdSegmentsCore,
  DEFAULT_KEYWORDS,
  DEFAULT_SIGNALS,
} from './danmaku.mjs'

/**
 * 采集一条视频的全部信息源。
 * @param {object} source 平台适配器产出的 VideoSource
 * @param {object} opts { page, from, to, audio, audioLang }
 * @returns {Promise<object>} ctx —— 见下方字段
 */
export async function collectSignals(source, opts = {}) {
  const pageNo = opts.page ?? 1
  const mp4 = await source.media(pageNo)
  const view = await source.meta()
  const pageCount = view.pages?.length ?? 1
  const page = view.pages?.[pageNo - 1]
  if (pageNo > 1 && !page) throw new Error(`没有第 ${pageNo} 个分P（这条视频共 ${pageCount} 个）`)
  const fullDuration = page?.duration ?? view.duration

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

  // 1. 内容变化率：只统计所处理区间内的显著变化（score≥0.3）
  const scenes = detectScenes(mp4)
  const rangeScenes = range ? scenes.filter((s) => s.t >= range.from && s.t <= range.to) : scenes
  const strong = rangeScenes.filter((s) => s.score >= 0.3)
  const rate = duration > 0 ? strong.length / duration : 0
  console.log(`[内容] 显著变化 ${strong.length} 处${range ? '（区间内）' : ''}，变化率 ${rate.toFixed(2)} 次/秒`)

  // 2. 字幕：官方字幕优先（文本几百 token，比抽字幕带图快且准）；没有才考虑烧录字幕带
  const officialRaw = await source.subtitles(range, pageNo)
  // 质量太差的官方字幕（音乐/音效被 ASR 成 碎片）不能用，误当台词会让理解完全跑偏
  const official = officialRaw?.quality === 'ok' ? officialRaw : null
  let bandResult = null
  let hasSubs = false
  let transcript = '' // --audio 转写出的台词文本（有它就不再烧字幕带）
  if (official) {
    console.log(`[字幕] 官方${official.lanDoc ?? ''} ${official.lines} 行 / ${official.chars} 字 ≈ ${official.chars} token → 跳过字幕带`)
    console.log(`       文本: ${official.txt}`)
    if (official.chars > 8000) {
      console.log(`       ⚠️ 字幕较长（${official.chars} 字 ≈ ${official.chars} token），建议只读关心的时段而不是全文`)
    }
    for (const line of official.head.slice(0, 3)) console.log(`       ${line}`)
    if (official.translated) {
      console.log(`[字幕] 中文翻译 ${official.translated.lines} 行 / ${official.translated.chars} 字`)
    }
  } else {
    if (officialRaw) {
      console.log(`[字幕] 官方字幕质量差（平均有效 ${officialRaw.avgEff} 字/行、去重率 ${officialRaw.uniqueRatio}）——疑为音乐/音效噪声，不采用`)
    }
    // 默认策略：无官方字幕时尝试 whisper 转写（比抽帧省 token）；--no-audio 或 FISHEYE_AUTO_AUDIO=0 关闭
    const wantAudio = opts.audio !== false && process.env.FISHEYE_AUTO_AUDIO !== '0'
    if (wantAudio) {
      const caps = audioCaps()
      console.log(`[音频] ${caps.summary}`)
      if (!caps.available) {
        if (caps.hint) console.log(`       ${caps.hint}`)
        console.log('[音频] 不可用 → 继续原逻辑（字幕带兜底）')
      } else {
        const tr = await transcribeAudio(mp4, OUT, { lang: opts.audioLang ?? 'zh', quiet: false })
        const text = String(tr?.text ?? '').trim()
        if (text) {
          transcript = text
          const txtFile = path.join(OUT, `${source.id}-audio-transcript.txt`)
          fs.writeFileSync(txtFile, text, 'utf8')
          console.log(`[音频] 转写成功：${text.length} 字（≈ ${text.length} token）→ ${txtFile}`)
          console.log(`       文本: ${text.slice(0, 300)}`)
          hasSubs = true // 台词文本已在手，不必再烧字幕带
        } else {
          console.log('[音频] 转写失败或结果为空 → 继续原逻辑（字幕带兜底）')
        }
      }
    }
    if (!transcript) {
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
  }

  // 2.5 弹幕（第三个信息源：观众反应）
  // 不参与「能不能看懂」的判定，只用来找高光——观众在哪一段最激动，那里通常最值得精读
  const danmakuRaw = await source.danmaku(range, pageNo)
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
  const adSegs = await detectAds(source, { danmaku, duration: fullDuration, subtitles: official?.body ?? null })
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

  // 2.6 语义切分（能力工具，可选）：有官方字幕时，识别话题切换点
  let semantic = null
  const semCaps = semanticCaps()
  if (semCaps.available && official?.body?.length) {
    const semLines = official.body.map((l) => ({ t: Number(l.from) || 0, text: String(l.content ?? '') }))
    semantic = semanticSegment(semLines, { nBkps: 5 })
    if (semantic?.segments?.length) {
      console.log(`[语义] 切出 ${semantic.segments.length} 个话题切换点`)
      for (const s of semantic.segments) console.log(`       ${fmt(s.t)}  置信度 ${s.confidence}  ${(s.signals ?? []).join('+')}`)
    }
  } else if (semCaps.available) {
    console.log('[语义] 无官方字幕，跳过（语义切分需要带时间戳台词）')
  }

  return {
    mp4, view, pageNo, pageCount, pageInfo: page,
    fullDuration, duration, range, start, end,
    scenes, rate, official, officialRaw, transcript, hasSubs, bandResult,
    danmaku, dmHot, adSegs, semantic,
    title: view.title,
  }
}

// 广告识别分发：走适配器 adDetector（null→不判；detect 函数→自定义；否则核心六路信号 + 平台关键词/信号）
export async function detectAds(source, ctx) {
  const det = source?.adDetector
  if (!det) return []
  if (typeof det.detect === 'function') return (await det.detect(ctx)) ?? []
  return detectAdSegmentsCore(ctx, det.keywords ?? DEFAULT_KEYWORDS, det.signals ?? DEFAULT_SIGNALS)
}
