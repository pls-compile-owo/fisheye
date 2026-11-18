// lib/auto-text.mjs — fast 文本模式（2.0 默认：只产文本证据，不渲染）
//
// 设计 00 §2.3/2.4：auto 默认只产「段卡片 + 字幕骨架 + 弹幕高光 + manifest + report.html」，
// 跳过全片场景检测（changeRate=null），不生成任何 jpg。画面只在第 2 批 render --plan 时按需渲染。
//
// 产出：
//   out/<id>-manifest.json  agent 看（schemaVersion 2，含 segments + evidence + quote）
//   out/<id>-plan.json      每段计划（段卡片 + 帧成本，供第 2 批 render --plan 用）
//   out/<id>-report.html    人类自检（设计 08 §11.2）
import fs from 'node:fs'
import path from 'node:path'
import { OUT } from './env.mjs'
import { fmt } from './util.mjs'
import { collectSignals } from './collect.mjs'
import { makeSegments } from './segments.mjs'
import { AD_KEYWORD, adKeywordHits } from './signals/index.mjs'

// 0.5 重定后的报价（官方 Flash 上限；text 锚点不变）
export const PER_IMAGE = 1024
export const TEXT_ANCHOR = 2000

// 证据可用性（设计 01 §3.2：null ≠ 0，缺失给 confidence）
function buildEvidence(ctx, subsLines) {
  const danmaku = ctx.danmaku ?? []
  const danmakuConf = danmaku.length < 20 ? 'low' : (danmaku.length / Math.max(1, ctx.duration)) < 0.05 ? 'low' : 'ok'
  return {
    subs: subsLines?.length ? {
      source: ctx.official ? (ctx.official.translated ? 'official-translated' : 'official') : (ctx.transcript ? 'transcript' : 'band'),
      lang: subsLines === ctx.official?.translated?.body ? 'zh'
        : (ctx.official ? (ctx.official.lan ?? 'unknown') : (ctx.transcript ? 'zh' : 'unknown')),
      chars: subsLines.reduce((a, l) => a + String(l?.content ?? '').length, 0),
      confidence: 'ok',
    } : { source: 'none', confidence: 'none' },
    danmaku: danmaku.length ? {
      available: true, count: danmaku.length,
      perMin: Number((danmaku.length / Math.max(1, ctx.duration) * 60).toFixed(1)),
      confidence: danmakuConf,
    } : { available: false, confidence: 'none' },
    frames: {
      coarse: { cost: PER_IMAGE },
      adaptive: { cost: PER_IMAGE, enabled: false },
      fine: { cost: PER_IMAGE },
    },
  }
}

// 文本 manifest（schemaVersion 2）
export function buildTextManifest(sourceId, ctx, segments, evidence, textTokens, visualRequest = null) {
  return {
    schemaVersion: 2,
    bvid: sourceId,
    title: ctx.title,
    duration: Math.round(ctx.duration),
    mode: 'fast',
    changeRate: null, // fast 档：类型判定/低置信帧不可用（设计 00 §2.3）
    evidence,
    segments,
    visualRequest, // 两源低置信时标记（非阻塞，设计 01 §3.6）
    textTokens,
    quote: {
      imageModel: 'flash',
      confidence: 'high',
      text: TEXT_ANCHOR,
      perImage: PER_IMAGE,
      coarse: { rel: Number((PER_IMAGE / TEXT_ANCHOR).toFixed(2)) },
      fine: { rel: Number((PER_IMAGE / TEXT_ANCHOR).toFixed(2)), per: '段' },
      adaptive: { rel: Number((PER_IMAGE / TEXT_ANCHOR).toFixed(2)), per: '张' },
      lowconf: { rel: Number((PER_IMAGE / TEXT_ANCHOR).toFixed(2)), per: '张' },
      segmentCount: segments.length,
      allIn: TEXT_ANCHOR + PER_IMAGE + PER_IMAGE * segments.length,
      cached: false,
    },
  }
}

// plan.json：每段计划（第 2 批 render --plan 消费）
export function buildPlan(segments) {
  return segments.map((s) => ({
    i: s.i, from: s.from, to: s.to, dur: s.dur,
    subs: s.subs ? { lang: s.subs.lang, chars: s.subs.chars, confidence: s.subs.confidence } : null,
    danmaku: s.danmaku?.emotion ? { value: s.danmaku.emotion.value, level: s.danmaku.emotion.level } : null,
    lowActivity: s.lowActivity,
    needsFrames: s.needsFrames,
    frames: s.frames,
  }))
}

// visualTrack 三档配置（设计 01 §3.6：on / ask / off，默认 ask）
export function visualTrackConfig() {
  const v = process.env.FISHEYE_VISUAL_TRACK
  return ['on', 'ask', 'off'].includes(v) ? v : 'ask'
}

// visualRequest（非阻塞，设计 01 §3.6：两源低置信时标记，不渲染，等 agent 决定）
// fast 档 changeRate=null → type 无法判定，建议 coarse 兜底；有 typeInfo 且 confidence≥0.7 才建议 adaptive。
export function buildVisualRequest(segments, typeInfo = null, visualTrack = 'ask', perImage = PER_IMAGE) {
  const needs = (Array.isArray(segments) ? segments : []).filter((s) => s.needsFrames)
  if (!needs.length) return null
  if (visualTrack === 'off') return null

  const hasType = typeInfo?.type && typeInfo.confidence >= 0.7
  const frames = hasType ? suggestedFramesFor(typeInfo.type, needs.length) : needs.length
  return {
    reason: 'no-subs-no-danmaku',
    type: hasType ? typeInfo.type : null,
    confidence: hasType ? typeInfo.confidence : 0,
    suggestedTrack: hasType ? 'adaptive' : 'coarse',
    suggestedFrames: frames,
    costEstimate: frames * perImage,
    segments: needs.map((s) => s.i),
  }
}

function suggestedFramesFor(type, segCount) {
  // 按类型密度粗估（PPT 每页 / MV 密抽 / 录屏稀疏）
  const per = type === 'music' ? 6 : type === 'slides' ? 4 : type === 'screen' ? 2 : 2
  return Math.max(1, per * segCount)
}

// report.html（设计 08 §11.2：人类唯一入口）
export function buildReport(ctx, evidence, segments, median, textTokens) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const rows = segments.map((s) => {
    const head = s.subs?.head?.text ?? ''
    const dm = s.danmaku?.emotion ? `${s.danmaku.emotion.value}(${s.danmaku.emotion.level})` : '—'
    const subEmo = s.subsEmotion ? `${s.subsEmotion.value}(${s.subsEmotion.level})` : '—'
    return `<tr><td>${s.i + 1}</td><td>${fmt(s.from)}-${fmt(s.to)}</td><td>${esc(head)}</td><td>${esc(s.subs?.keywords?.join('、') ?? '')}</td><td>${subEmo}</td><td>${dm}</td><td>${s.lowActivity ? '低活跃' : ''}${s.needsFrames ? ' 需读图' : ''}</td></tr>`
  }).join('\n')
  const subsE = evidence.subs
  const dmE = evidence.danmaku
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${esc(ctx.title)} · fisheye 2.0</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:1000px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;font-size:14px;text-align:left}th{background:#f5f5f5}</style></head><body>
<h2>${esc(ctx.title)}</h2>
<p>时长 <b>${fmt(ctx.duration)}</b> · 模式 <b>fast</b> · 只读文本 ≈ <b>${textTokens}</b> token（图片按需，未渲染）</p>
<h3>证据可用性</h3>
<ul>
<li>字幕：${subsE.source === 'none' ? '无' : `${subsE.source}（${subsE.chars} 字，${subsE.lang}）`}，置信度 ${subsE.confidence}</li>
<li>弹幕：${dmE.available ? `${dmE.count} 条（${dmE.perMin}/分钟）` : '无'}，置信度 ${dmE.confidence}</li>
<li>画面：未渲染（auto 默认不生成图，render --plan 才出图）</li>
</ul>
<h3>段列表（${segments.length} 段）</h3>
<table><tr><th>#</th><th>时间</th><th>字幕骨架 head</th><th>关键词</th><th>字幕情绪</th><th>弹幕情绪</th><th>标记</th></tr>
${rows}
</table>
<p>全片情绪中位数：字幕 ${median.subs} / 弹幕 ${median.danmaku}。详情见 manifest.json / plan.json。</p>
</body></html>`
}

/**
 * fast 文本模式主入口。默认只产文本，不抽帧、不生成 jpg。
 */
export async function stageAutoText(source, opts = {}) {
  const ctx = await collectSignals(source, { ...opts, fast: true })
  const { fullDuration, duration, official, transcriptLines, danmaku, lowActivitySegs, adHits: ctxAdHits, semantic } = ctx

  // 字幕降级链：中文翻译轨 → 官方原文轨 → whisper 转写台词（无官方字幕时兜底，设计 02 §3.1）
  const subsLines = (official?.translated?.body?.length ? official.translated.body : official?.body)
    ?? (transcriptLines?.length ? transcriptLines : null)

  // 低活跃段 + 广告词命中（collectSignals 已产出，用平台的 adKeywords 词库）
  const lowSegs = lowActivitySegs ?? []
  const adHits = ctxAdHits ?? []
  const adKeyword = source?.adDetector?.adKeywords ?? AD_KEYWORD

  const { segments, median, textTokens } = makeSegments({
    duration, subsLines, danmaku, adKeywordHits: adHits,
    semanticShifts: semantic?.segments ?? null,
    lowActivitySegs: lowSegs,
    adKeyword,
  })

  const evidence = buildEvidence(ctx, subsLines)
  // fast 档 changeRate=null → typeInfo 传 null（类型判定留给 standard/render 阶段）
  const visualRequest = buildVisualRequest(segments, null, visualTrackConfig(), PER_IMAGE)
  const manifest = buildTextManifest(source.id, ctx, segments, evidence, textTokens, visualRequest)
  const plan = buildPlan(segments)
  const report = buildReport(ctx, evidence, segments, median, textTokens)

  const base = path.join(OUT, `${source.id}`)
  fs.writeFileSync(`${base}-manifest.json`, JSON.stringify(manifest, null, 2), 'utf8')
  fs.writeFileSync(`${base}-plan.json`, JSON.stringify(plan, null, 2), 'utf8')
  fs.writeFileSync(`${base}-report.html`, report, 'utf8')

  // 设计 08 §11.7：stdout 给 agent（重定向时只拿路径），人类提示走 stderr
  console.error(`\n=== 完成（fast 文本模式，未渲染任何画面）===`)
  console.error(`只读文本 ≈ ${textTokens} token（${segments.length} 段骨架）`)
  for (const s of segments.slice(0, 3)) {
    console.error(`  段 ${s.i + 1} ${fmt(s.from)}-${fmt(s.to)}  ${s.subs?.head?.text ?? '(无字幕)'}`)
  }
  if (segments.length > 3) console.error(`  … 共 ${segments.length} 段`)
  console.log(`MANIFEST: ${base}-manifest.json`)
  console.log(`PLAN: ${base}-plan.json`)
  console.log(`REPORT: ${base}-report.html`)

  return { segments, textTokens, manifest, plan, report, duration }
}
