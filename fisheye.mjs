#!/usr/bin/env node
// fisheye.mjs — 从视频「按需看图」：多张拼图铺网 + 关键帧精读
// 平台无关：B站（BV 号）/ 本地文件 / 任意 URL 通过平台适配器（lib/platforms）接入。
// 五个阶段（通常只用 auto 和 refine）
// auto 自动规划：按 token 预算和内容变化率决定采样密度、张数、要不要字幕带
// grid 铺网：下载一次 mp4 → 按 chunk 切段 → 每段抽 N 帧拼成一张图
// subs 字幕带：剪掉画面只留底部字幕，竖排 N 行（自动定位字幕位置）
// refine 精读选择：按模板/决策文件/几何规则挑出要看原分辨率的时间点
// grab 精读执行：按时间点截原分辨率单帧
// 产物
// out/<id>-manifest.json 每张图的时间范围 + 每格时间戳、变化强度、吸附偏移
// out/<id>-*.jpg 拼图 / 字幕带 / 精读帧
// cache/<id>.mp4 原始视频（下载一次复用）
// 设计要点
// · 段内取帧 = 等间隔骨架（保覆盖）+ 吸附画面变化点（不漏关键帧）
// · 拼图每格顺序固定，manifest 按「从左到右、从上到下」记录时间，供 agent 对照
// · 拼图与精读用同一种 seek，保证同一时间戳取到同一帧
// · 所有子进程用 stdio:'ignore'（沙箱禁管道捕获），数据走临时文件
import fs from 'node:fs'
import path from 'node:path'
import { PKG_DIR, WS, CFG_FILE, FFMPEG, CRED } from './lib/env.mjs'
import { parseTime, num, pageNum, gridStr } from './lib/util.mjs'
import { t } from './lib/i18n.mjs'
import { stageAuto, stageGrid, stageSubs, stageSelftest, stageRefine, stageGrab, stageLocal, stageTranscribe, stageClean, stageOcr, stageUrl, stageBatch } from './lib/stages.mjs'
import { stageAutoText } from './lib/auto-text.mjs'
import { stageRender } from './lib/render.mjs'
import { resolveSource } from './lib/platforms/index.mjs'
import { traceStart, traceFinish } from './lib/trace.mjs'

const argv = process.argv.slice(2)
const stage = argv[0]
const input = argv[1]

const IS_SELFTEST = stage === 'selftest'
const IS_CLEAN = stage === 'clean'
const IS_OCR = stage === 'ocr'

// ffmpeg：除 selftest / clean / ocr 外都需要
if (!IS_SELFTEST && !IS_CLEAN && !IS_OCR) {
  if (!FFMPEG) {
    console.error(t('err.ffmpeg.missing', { binDir: path.join(PKG_DIR, 'bin'), cfgFile: CFG_FILE }))
    process.exit(2)
  }
}

const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

// auto 决策管线（完整采集：多路信号 + 字幕带 + 广告 + 语义）。local/url 的 --smart 与 auto 共用。
async function runAuto(source, forceStandard = false) {
  traceStart(source.id)
  let ok = false
  try {
  // 参数校验统一前置：无论 fast/standard 都要校验（非法值报错，不因模式而吞掉）
  const d = opt('density', null)
  const budget = num(opt('budget', 20000), 'budget', { min: 2000, max: 200000 })
  const density = d === null ? null : num(d, 'density', { min: 0.5, max: 60 })
  const standard = forceStandard || argv.includes('--standard') || argv.includes('--render')
  if (standard) {
    // 标准模式（1.0.29 抽帧路径）：完整采集 + 场景检测 + 拼图
    await stageAuto(source, budget, {
      density,
      page: pageNum(opt('p', null)),
      from: parseTime(opt('from', null), 'from'),
      to: parseTime(opt('to', null), 'to'),
      useDanmakuFrames: !argv.includes('--no-danmaku-frames'),
      audio: argv.includes('--audio') ? true : (argv.includes('--no-audio') ? false : undefined),
      audioLang: opt('lang', null),
      resume: argv.includes('--resume'),
      force: argv.includes('--force'),
    })
  } else {
    // fast 文本模式（2.0 默认）：跳过场景检测，只产文本证据，不渲染
    await stageAutoText(source, {
      page: pageNum(opt('p', null)),
      from: parseTime(opt('from', null), 'from'),
      to: parseTime(opt('to', null), 'to'),
      audio: argv.includes('--audio') ? true : (argv.includes('--no-audio') ? false : undefined),
      audioLang: opt('lang', null),
    })
  }
    ok = true
  } finally {
    traceFinish(ok)
  }
}

// 需要「平台源」的命令：解析输入（BV / 文件 / URL）→ VideoSource 契约对象
const SOURCE_STAGES = new Set(['auto', 'grid', 'subs', 'refine', 'grab', 'transcribe', 'render'])
let source = null
if (SOURCE_STAGES.has(stage) && input && !input.startsWith('--')) {
  source = resolveSource(input)
  if (!source) {
    console.error(`${t('err.bvFormat', { raw: input })}\n`)
    console.log(t('usage'))
    process.exit(2)
  }
  // B 站凭证：仅 bilibili 平台需要（保持零回归：无凭证报错，其余平台不受影响）
  if (source.kind === 'bilibili' && !CRED) {
    console.error(t('err.cred.missing', { credPath: path.join(WS, 'credentials.json') }))
    process.exit(2)
  }
}

if (stage === 'local') {
  const fileArg = argv[1]
  if (!fileArg || fileArg.startsWith('--')) {
    console.error(t('err.local.usage'))
    process.exit(2)
  }
  try {
    if (argv.includes('--smart')) {
      // --smart：走 auto 完整采集管线（多路信号 + 场景检测 + 字幕带 + 广告 + 语义），而非纯均匀抽帧
      const smartSource = resolveSource(fileArg)
      if (!smartSource) { console.error(t('err.local.usage')); process.exit(2) }
      await runAuto(smartSource, true)
    } else {
      await stageLocal(fileArg, {
        grid: opt('grid', '3x3'),
        from: parseTime(opt('from', null), 'from'),
        to: parseTime(opt('to', null), 'to')
      })
    }
  } catch (error) {
    console.error(t('err.local.failed', { message: error?.message ?? error }))
    process.exit(1)
  }
  process.exit(0)
}

if (stage === 'ocr') {
  const img = argv[1]
  if (!img || img.startsWith('--')) {
    console.error(t('err.ocr.usage'))
    process.exit(2)
  }
  try {
    await stageOcr(img, { lang: opt('lang', null) })
  } catch (error) {
    console.error(t('err.local.failed', { message: error?.message ?? error }))
    process.exit(1)
  }
  process.exit(0)
}
if (stage === 'url') {
  const link = argv[1]
  if (!link || link.startsWith('--')) {
    console.error(t('err.url.usage'))
    process.exit(2)
  }
  try {
    if (argv.includes('--smart')) {
      // --smart：走 auto 完整采集管线（多路信号 + 字幕带 + 广告 + 语义）
      const smartSource = resolveSource(link)
      if (!smartSource) { console.error(t('err.url.usage')); process.exit(2) }
      await runAuto(smartSource)
    } else {
      await stageUrl(link, {
        grid: opt('grid', '3x3'),
        from: parseTime(opt('from', null), 'from'),
        to: parseTime(opt('to', null), 'to')
      })
    }
  } catch (error) {
    console.error(t('err.local.failed', { message: error?.message ?? error }))
    process.exit(1)
  }
  process.exit(0)
}


if (stage === 'batch') {
  const arg = argv[1]
  const listText = (arg && !arg.startsWith('--') && fs.existsSync(arg))
    ? fs.readFileSync(arg, 'utf8')
    : argv.slice(1).filter((a) => !a.startsWith('--')).join('\n')
  if (!listText.trim()) {
    console.error(t('err.batch.usage'))
    process.exit(2)
  }
  try {
    await stageBatch(listText, {
      concurrency: num(opt('concurrency', 1), 'concurrency', { min: 1, max: 8 }),
      budget: opt('budget', null) ? num(opt('budget'), 'budget', { min: 2000, max: 200000 }) : 20000,
      grid: opt('grid', '3x3'),
      audio: argv.includes('--audio'),
      lang: opt('lang', null),
      from: parseTime(opt('from', null), 'from'),
      to: parseTime(opt('to', null), 'to')
    })
  } catch (error) {
    console.error(t('err.local.failed', { message: error?.message ?? error }))
    process.exit(1)
  }
  process.exit(0)
}

if (!stage || (stage !== 'selftest' && stage !== 'clean' && stage !== 'ocr' && stage !== 'url' && stage !== 'batch' && !source)) {
  if (input && stage !== 'selftest') {
    console.error(`${t('err.bvFormat', { raw: input })}\n`)
  }
  console.log(t('usage'))
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
    await runAuto(source)
  } else if (stage === 'render') {
    await stageRender(source, {
      track: opt('track', 'coarse'),
      segments: opt('segments', null),
      page: pageNum(opt('p', null)),
    })
  } else if (stage === 'refine') {
    await stageRefine(source, { template: argv.includes('--template'), decisions: opt('decisions', null) })
  } else if (stage === 'grid') {
    await stageGrid(source,
      num(opt('chunk', 60), 'chunk', { min: 1, max: 3600 }),
      gridStr(opt('grid', '3x3')),
      { page, range })
  } else if (stage === 'subs') {
    await stageSubs(source,
      num(opt('count', 12), 'count', { min: 1, max: 50 }),
      opt('band', 'auto'),
      { page, range })
  } else if (stage === 'grab') await stageGrab(source, argv[2] ?? '', { page })
  else if (stage === 'clean') {
    // 清理缓存/产物：本地操作，不需要输入源
    await stageClean({ target: opt('target', 'all'), yes: argv.includes('--yes') })
  }
  else if (stage === 'transcribe') await stageTranscribe(source, { page, lang: opt('lang', null) })
  else { console.error(t('err.unknownStage', { stage })); process.exit(2) }
} catch (e) {
  console.error(t('err.fatal', { message: e.message }))
  if (process.env.FISHEYE_DEBUG) console.error(e.stack)
  process.exit(1)
}
