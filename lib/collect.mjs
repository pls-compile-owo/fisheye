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
import { traceWrap, traceNote } from './trace.mjs'
import { audioCaps, transcribeAudio } from './audio.mjs'
import { semanticCaps, semanticSegment } from './semantic.mjs'
import {
  summarizeDanmaku,
  detectLowActivity,
  adKeywordHits,
  AD_KEYWORD,
} from './danmaku.mjs'

/**
 * 采集一条视频的全部信息源。
 * @param {object} source 平台适配器产出的 VideoSource
 * @param {object} opts { page, from, to, audio, audioLang }
 * @returns {Promise<object>} ctx —— 见下方字段
 */
export async function collectSignals(source, opts = {}) {
  const pageNo = opts.page ?? 1
  const mp4 = await traceWrap('download', () => source.media(pageNo))
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

  console.error(`\n=== 规划：${view.title}${pageCount > 1 ? ` · P${pageNo}/${pageCount}` : ''}（${fullDuration}s）===`)
  if (range) console.error(`[区间] 只处理 ${fmt(range.from)}-${fmt(range.to)}（${duration.toFixed(0)}s / 全片 ${fullDuration}s）`)
  if (pageCount > 1 && pageNo === 1) console.error(`[提示] 多P 视频，本次只处理 P1；要处理别的分P 用 --p N`)

  // 1. 内容变化率：只统计所处理区间内的显著变化（score≥0.3）
  // fast 档（2.0 默认）跳过全片场景检测（省 ~72s），changeRate=null（设计 00 §2.3）
  const fast = opts.fast === true
  const scenes = fast ? [] : await traceWrap('scene-detect', () => detectScenes(mp4))
  const rangeScenes = range ? scenes.filter((s) => s.t >= range.from && s.t <= range.to) : scenes
  const strong = rangeScenes.filter((s) => s.score >= 0.3)
  const rate = fast ? null : (duration > 0 ? strong.length / duration : 0)
  if (!fast) console.error(`[内容] 显著变化 ${strong.length} 处${range ? '（区间内）' : ''}，变化率 ${rate.toFixed(2)} 次/秒`)

  // 2. 字幕：官方字幕优先（文本几百 token，比抽字幕带图快且准）；没有才考虑烧录字幕带
  const officialRaw = await traceWrap('subtitles', () => source.subtitles(range, pageNo))
  // 质量太差的官方字幕（音乐/音效被 ASR 成 碎片）不能用，误当台词会让理解完全跑偏
  const official = officialRaw?.quality === 'ok' ? officialRaw : null
  let bandResult = null
  let hasSubs = false
  let transcript = '' // --audio 转写出的台词文本（有它就不再烧字幕带）
  let transcriptLines = null // 带时间戳台词行 [{from, content}]（喂广告检测的台词族信号 + 语义切分）
  if (official) {
    console.error(`[字幕] 官方${official.lanDoc ?? ''} ${official.lines} 行 / ${official.chars} 字 ≈ ${official.chars} token → 跳过字幕带`)
    console.error(`       文本: ${official.txt}`)
    if (official.chars > 8000) {
      console.error(`       ⚠️ 字幕较长（${official.chars} 字 ≈ ${official.chars} token），建议只读关心的时段而不是全文`)
    }
    for (const line of official.head.slice(0, 3)) console.error(`       ${line}`)
    if (official.translated) {
      console.error(`[字幕] 中文翻译 ${official.translated.lines} 行 / ${official.translated.chars} 字`)
    }
  } else {
    if (officialRaw) {
      console.error(`[字幕] 官方字幕质量差（平均有效 ${officialRaw.avgEff} 字/行、去重率 ${officialRaw.uniqueRatio}）——疑为音乐/音效噪声，不采用`)
    }
    // 默认策略：无官方字幕时尝试 whisper 转写（比抽帧省 token）；--no-audio 或 FISHEYE_AUTO_AUDIO=0 关闭
    const wantAudio = opts.audio !== false && process.env.FISHEYE_AUTO_AUDIO !== '0'
    if (wantAudio) {
      const caps = audioCaps()
      console.error(`[音频] ${caps.summary}`)
      if (!caps.available) {
        if (caps.hint) console.error(`       ${caps.hint}`)
        console.error('[音频] 不可用 → 继续原逻辑（字幕带兜底）')
      } else {
        const tr = await traceWrap('transcribe', () => transcribeAudio(mp4, OUT, { lang: opts.audioLang ?? 'zh', quiet: false }))
        const text = String(tr?.text ?? '').trim()
        if (text) {
          transcript = text
          // whisper.cpp 的 -oj 输出带时间戳 segments（start/end 秒），转成台词族信号要的 [{from, content}]
          if (Array.isArray(tr.segments) && tr.segments.length) {
            transcriptLines = tr.segments
              .filter((s) => s && String(s.text ?? '').trim())
              .map((s) => ({ from: Number(s.start) || 0, content: String(s.text) }))
          }
          const txtFile = path.join(OUT, `${source.id}-audio-transcript.txt`)
          fs.writeFileSync(txtFile, text, 'utf8')
          console.error(`[音频] 转写成功：${text.length} 字（≈ ${text.length} token）→ ${txtFile}`)
          console.error(`       文本: ${text.slice(0, 300)}`)
          hasSubs = true // 台词文本已在手，不必再烧字幕带
        } else {
          console.error('[音频] 转写失败或结果为空 → 继续原逻辑（字幕带兜底）')
        }
      }
    }
    if (!transcript) {
      // 传 fullDuration 而不是区间长度：字幕位置是视频级属性，采样必须跨全片
      bandResult = await traceWrap('subtitle-band', () => detectBand(mp4, fullDuration))
      // 置信度门槛：抖音式动态字幕（位置漂移 / 不是每帧都有）检测出来的「带」其实是画面内容，
      // 拼出来一堆非字幕行。低于 0.5 就不用字幕带，只靠画面拼图。
      const conf = bandResult?.confidence
      const confOk = conf === undefined || conf >= 0.5
      hasSubs = !!(bandResult?.ok && bandResult.bandRatio >= 0.015 && bandResult.bandRatio <= 0.35 && confOk)
      if (bandResult?.ok && !confOk) {
        console.error(`[字幕] 检出疑似字幕带（${(bandResult.topRatio * 100).toFixed(0)}%-${(bandResult.botRatio * 100).toFixed(0)}%）但置信度仅 ${Number(conf).toFixed(2)}`)
        console.error(`       —— 字幕位置漂移或不是每帧都有（抖音式动态字幕常见），跳过字幕带，只靠画面`)
      } else {
        console.error(`[字幕] ${hasSubs
          ? `无可用官方字幕，检出烧录字幕带（${(bandResult.topRatio * 100).toFixed(0)}%-${(bandResult.botRatio * 100).toFixed(0)}%，置信度 ${Number(conf).toFixed(2)}）→ 字幕带 1 张`
          : '无可用字幕 → 只靠画面'}`)
      }
    }
  }

  // 2.5 弹幕（第三个信息源：观众反应）
  // 不参与「能不能看懂」的判定，只用来找高光——观众在哪一段最激动，那里通常最值得精读
  const danmakuRaw = await traceWrap('danmaku', () => source.danmaku(range, pageNo))
  const { kept: danmaku, dropped } = filterDanmaku(danmakuRaw)
  if (danmakuRaw?.length) {
    const parts = []
    if (dropped.ad) parts.push(`${dropped.ad} 条广告引流`)
    if (dropped.noise) parts.push(`${dropped.noise} 条无意义刷屏`)
    if (parts.length) {
      console.error(`[弹幕] 原始 ${danmakuRaw.length} 条，已过滤 ${parts.join(' / ')}`)
      for (const s of dropped.samples) console.error(`       样本：${s}`)
    }
  }
  const dmHot = summarizeDanmaku(danmaku)
  // 低活跃段（密度低谷，影响取帧）+ 广告词高光（纯线索，不影响决策）——设计 05 §7.2
  const lowActivitySegs = await detectLowActivityFor(source, { danmaku, duration: fullDuration })
  // 广告词库：平台声明 adKeywords（设计 05 §7.5），否则用默认中文词库
  const adKeyword = source?.adDetector?.adKeywords ?? AD_KEYWORD
  const adHits = adKeywordHits(danmaku, adKeyword)
  if (lowActivitySegs.length) {
    console.error(`[低活跃段] 弹幕密度低谷 ${lowActivitySegs.length} 段（低互动，未必是广告）：`)
    for (const s of lowActivitySegs) {
      const sample = s.sample?.length ? `  样本「${s.sample.join('」「')}」` : ''
      console.error(`       ${s.ts}（${s.dur}s）${sample}`)
    }
  }
  if (adHits.length) {
    console.error(`[广告词] ${adHits.length} 条命中（纯线索，判断归 agent）`)
  }
  if (danmaku?.length) {
    console.error(`[弹幕] ${danmaku.length} 条${range ? '（区间内）' : ''}${dmHot?.length ? '，观众最激动的时段：' : ''}`)
    for (const h of dmHot ?? []) {
      console.error(`       ${h.ts}  ${String(h.count).padStart(3)} 条  「${h.samples.join('」「')}」`)
    }
  } else {
    console.error('[弹幕] 无（视频关弹幕 / 无人发 / 获取失败）')
  }

  // 2.6 语义切分（能力工具，可选）：官方字幕优先，其次转写台词（本地/URL 转写也可切话题）
  let semantic = null
  const semCaps = semanticCaps()
  const semSource = official?.body?.length ? official.body : transcriptLines
  if (semCaps.available && semSource?.length) {
    console.error(`[语义] ${semCaps.summary}`)
    const semLines = semSource.map((l) => ({ t: Number(l.from) || 0, text: String(l.content ?? '') }))
    semantic = await traceWrap('semantic', () => semanticSegment(semLines, { nBkps: 5 }))
    if (semantic?.segments?.length) {
      console.error(`[语义] 切出 ${semantic.segments.length} 个话题切换点`)
      for (const s of semantic.segments) console.error(`       ${fmt(s.t)}  置信度 ${s.confidence}  ${(s.signals ?? []).join('+')}`)
    }
  } else if (semCaps.available) {
    console.error('[语义] 无官方字幕，跳过（语义切分需要带时间戳台词）')
  }

  // 产物完整性：每个信号源「给没给到东西」（区分「跑过但无结果」和「跳过/不适用」），
  // 供摘要打印 + 写 manifest，让 Agent 一眼看清这次缺了哪块（对治「静默降级」）。
  const coverage = {
    subtitles: official ? { s: 'ok', n: official.lines } : (officialRaw ? { s: 'noisy' } : { s: 'none' }),
    transcript: transcript ? { s: 'ok', n: transcript.length } : { s: 'none' },
    band: bandResult?.ok ? { s: 'ok' } : { s: 'none' },
    danmaku: danmaku?.length ? { s: 'ok', n: danmaku.length } : { s: 'none' },
    lowActivity: lowActivitySegs.length ? { s: 'ok', n: lowActivitySegs.length } : (source?.adDetector ? { s: 'none' } : { s: 'skipped' }),
    semantic: semantic?.segments?.length ? { s: 'ok', n: semantic.segments.length } : { s: 'none' },
  }

  return {
    mp4, view, pageNo, pageCount, pageInfo: page,
    fullDuration, duration, range, start, end,
    scenes, rate, official, officialRaw, transcript, hasSubs, bandResult,
    danmaku, dmHot, lowActivitySegs, adHits, semantic,
    coverage,
    title: view.title,
  }
}

// 产物完整性摘要：coverage → 一行人类可读文本（✓ 得到 / △ 质量差 / ○ 跳过 / — 无）
const COVERAGE_ORDER = [
  ['subtitles', '字幕'],
  ['danmaku', '弹幕'],
  ['lowActivity', '低活跃'],
  ['semantic', '语义'],
  ['transcript', '转写'],
  ['band', '字幕带'],
]

export function coverageSummary(cov) {
  if (!cov || typeof cov !== 'object') return ''
  const parts = []
  for (const [key, label] of COVERAGE_ORDER) {
    const c = cov[key]
    let mark = '—'
    if (c?.s === 'ok') mark = c.n != null ? `✓${c.n}` : '✓'
    else if (c?.s === 'noisy') mark = '△'
    else if (c?.s === 'skipped') mark = '○'
    parts.push(`${label}${mark}`)
  }
  return `[产物] ${parts.join(' · ')}`
}

// 低活跃检测分发（2.0 第 3 批）：走适配器 adDetector（null→不判；detect 函数→自定义；否则核心密度低谷）。
export async function detectLowActivityFor(source, ctx) {
  const det = source?.adDetector
  if (!det) return []
  if (typeof det.detect === 'function') return (await det.detect(ctx)) ?? []
  return detectLowActivity(ctx.danmaku, ctx.duration)
}
