// 五个阶段 + 本地视频：grid / subs / auto / refine / grab / local / selftest
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { spamReason, filterDanmaku } from '../danmaku-filter.mjs'
import { WS, CACHE, OUT, CFG_FILE, LOCAL_CFG, onPath, resolveTool, FFMPEG, CRED } from './env.mjs'
import { fmt, fsec, jpegSize, fail, num, gridStr, parseTime, pageNum } from './util.mjs'
import { platforms } from './platforms/index.mjs'
import { semanticCaps, semanticSegment } from './semantic.mjs'
import { detectScenes, subtractAds, pickTimes, snapSubsTimes, detectBand, grabFrame, runCapture } from './frame.mjs'
import { audioCaps, transcribeAudio } from './audio.mjs'
import { ocrCaps, ocrImage } from './ocr.mjs'
import { ytdlpCaps, downloadVideo } from './ytdlp.mjs'
import { parseBatchList, runBatch, formatBatchReport } from './batch.mjs'
import { loadManifestState, canResume, recordStage } from './resume.mjs'
import { estimateTokens, tokensPerUnit, modelFactor, COST } from './budget.mjs'
import { planAuto, MAX_GRIDS } from './planner.mjs'
import { collectSignals, coverageSummary } from './collect.mjs'
import { stageSelftest } from './selftest.mjs'
import { traceWrap, traceNote } from './trace.mjs'
import { geometricPick, buildSuggestions, MIN_READABLE_SUBS_PX } from './executor.mjs'

export async function stageGrid(source, chunkSec, grid, pre = {}) {
  const pageNo = pre.page ?? 1
  const mp4 = pre.mp4 ?? await source.media(pageNo)
  const viewData = pre.view ?? await source.meta()
  // 时长要用「所处理分P」的时长（多P 视频的 view.duration 是全部分P 总和）
  const pageInfo = viewData.pages?.[pageNo - 1]
  const title = pageInfo?.part && (viewData.pages?.length ?? 1) > 1
    ? `${viewData.title} · P${pageNo} ${pageInfo.part}` : viewData.title
  const fullDuration = pageInfo?.duration ?? viewData.duration
  const owner = viewData.owner
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

  // 低活跃段（密度低谷）：这些时间不占帧，铺网时压缩掉（standard 路径；render algorithm 轨用降权 w=0.3）
  const lowActivity = (pre.lowActivitySegments ?? [])

  for (let c = 0; c < bounds.length; c++) {
    const { from, to } = bounds[c]
    const picked = pickTimes(from, to, N, sceneCands, lowActivity)
    if (!picked) {
      // 整段都被低活跃段占满（极罕见）——跳过这张图，不让它浪费预算
      console.log(`[取帧] ${fmt(from)}-${fmt(to)}  整段都是低活跃，跳过这张拼图`)
      continue
    }
    const times = picked.times
    const thText = picked.th === null ? '无变化点' : `阈值 ${picked.th}`
    const dedupText = picked.dedup ? `，去重退回 ${picked.dedup} 帧` : ''
    const adText = lowActivity.length
      ? `（已跳过低活跃 ${Math.round(lowActivity.filter((a) => a.to > from && a.from < to).reduce((s, a) => s + Math.min(a.to, to) - Math.max(a.from, from), 0))}s）`
      : ''
    console.log(`[取帧] ${fmt(from)}-${fmt(to)}  ${thText}，${picked.snapped}/${N} 帧吸附${dedupText}${adText}`)
    // 变化点稀疏/聚集（如冲浪视频：大部分平静、巨浪集中在几秒）时吸附率会很低——
    // 这是正常现象，等间隔骨架保覆盖，但要提醒：关键时刻可能被少量帧覆盖，看精读建议
    if (picked.snapped < N * 0.5) {
      console.log(`  ↳ 变化点稀疏或高度聚集（${visualScenes.length} 处全片变化点），等间隔骨架兜底；关键瞬间见精读建议`)
    }

    const tmp = path.join(OUT, `.f-${source.id}-${c}`)
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

    const sheet = path.join(OUT, `${source.id}-c${String(c).padStart(2, '0')}_${fsec(from)}-${fsec(to)}_${cols}x${rows}.jpg`)
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, `f%02d.jpg`), '-vf',
      `scale=640:-1,tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '3', sheet], { stdio: 'ignore' })
    fs.rmSync(tmp, { recursive: true, force: true })

    // 这一格落在多强的画面变化上（供「哪些格值得精读」的判断参考：变化越强，通常信息越密）
    const scoreAt = (t) => {
      const c = visualScenes.filter((s) => Math.abs(s.t - t) < 0.06)
      return c.length ? Number(Math.max(...c.map((s) => s.score)).toFixed(3)) : 0
    }
    // 有低活跃段被跳过时，range 标注成「原始区间 + 实际内容范围」，否则会让人误以为覆盖到段尾
    const adSkipped = Math.round(lowActivity
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
      adSkipped,                                    // 本段被跳过的低活跃秒数
      effectiveRange: effRange,                     // 实际内容覆盖范围（跳过低活跃后）
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
    const adNote = adSkipped > 0 ? `（跳过低活跃 ${adSkipped}s，内容实际 ${effRange}）` : ''
    console.log(`[拼图 ${c + 1}/${bounds.length}] ${fmt(from)}-${fmt(to)}  ${N} 帧${adNote} → ${path.basename(sheet)}`)
  }

  const sheetSize = chunks.length ? jpegSize(chunks[0].sheet) : null
  const manifest = {
    version: 1, bvid: source.id, sourceId: source.id, sourceKind: source.kind, title, up: owner, duration: fullDuration, chunkSec,
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
    lowActivitySegments: pre.lowActivitySegments ?? null,  // 低活跃段（密度低谷，refine 避开）
    semanticShifts: pre.semanticShifts ?? null,  // 语义切换点（原始信号层，语义模块产出）
    coverage: pre.coverage ?? null,      // 产物完整性（各信号源状态，Agent 判断缺了哪块）
    chunks,
    createdAt: new Date().toISOString(),
  }
  const mf = path.join(OUT, `${source.id}-manifest.json`)
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
// band 可以是比例（0.22）或 'auto'（先跑纯 JS detectBand 自动定位字幕带）
// 依据：讲解/翻唱类视频，字幕就是全部信息量；同样 token 预算下，字幕带比全画幅拼图清楚得多

export async function stageSubs(source, count, bandArg, pre = {}) {
  const pageNo = pre.page ?? 1
  const mp4 = pre.mp4 ?? path.join(CACHE, pageNo > 1 ? `${source.id}-p${pageNo}.mp4` : `${source.id}.mp4`)
  if (!fs.existsSync(mp4)) throw new Error(`没有缓存 mp4，先跑 auto 或 grid：${mp4}`)
  const viewData = pre.view ?? await source.meta()
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

  const tmp = path.join(OUT, `.s-${source.id}`)
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
  const out = path.join(OUT, `${source.id}-subs_${count}行.jpg`)
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

// 单张成本不再写死：统一走 lib/budget.mjs 的 estimateTokens(kind, count)。
// 默认基准 grid 1024 / subs 1024 / fine 1024（2.0 改价：官方 Flash 每图上限 1024），
// 但支持 FISHEYE_TOKENS_PER_* 覆盖与 FISHEYE_TOKEN_MODEL 模型系数。
// COST 保留导出只为兼容旧的外部引用，内部不再直接乘它（它看不到环境变量）。
export { COST }


// selftest：自检
// 原则：默认不下载视频、几秒内跑完；--deep 才做抽帧和字幕带。
// 覆盖：依赖（ffmpeg）→ 凭证 → API（视频/弹幕/字幕）→ 缓存 → 磁盘

export { stageSelftest }

export async function stageAuto(source, budget, opts = {}) {
  // 断点：out/<BV>-manifest.json 存在且计划参数一致时可复用
  // --resume 跳过已完成的抽帧阶段；--force 强制重跑；默认只提示
  let prevManifest = null
  let resumeInfo = null
  try {
    const prev = loadManifestState(OUT, source.id)
    if (prev && !opts.force) {
      resumeInfo = canResume(prev, { plan: { budget, density: opts.density ?? null, from: opts.from ?? null, to: opts.to ?? null } })
      if (resumeInfo.resumable) {
        prevManifest = prev
        console.log('[断点] 检测到可复用产物：' + resumeInfo.reason +
          (opts.resume === true ? '（--resume：跳过抽帧）' : '（加 --resume 跳过抽帧 / --force 强制重跑）'))
      }
    }
  } catch {}
  // 1-2.6 采集层（collect.mjs）：下载 / 元信息 / 场景 / 字幕(官方/转写/字幕带) / 弹幕 / 广告 / 语义
  const ctx = await collectSignals(source, {
    page: opts.page ?? 1, from: opts.from ?? null, to: opts.to ?? null,
    audio: opts.audio, audioLang: opts.audioLang,
  })
  const {
    mp4, view, pageNo, pageCount, fullDuration, duration, range,
    scenes, rate, official, transcript, hasSubs, bandResult,
    danmaku, dmHot, lowActivitySegs, semantic, coverage,
  } = ctx

  // 拼图 token 按实际画面比例修正（预算决策准备）
  const dim = view.dimension ?? {}
  const vw = Number(dim.width) || 1280
  const vh = Number(dim.height) || 720
  const cellH = Math.round((640 * vh) / Math.max(vw, 1))
  const sheetPx = 640 * 3 * (cellH * 3)
  const gridBase = estimateTokens('grid', 1)
  const gridCost = Math.max(300, Math.round((gridBase * sheetPx) / (1920 * 1080)))
  const factor = modelFactor()
  if (factor !== 1) {
    console.log(`[预算] 模型系数 ×${factor}（FISHEYE_TOKEN_MODEL，按该 tokenizer 的图像成本修正）`)
  }
  if (Math.abs(sheetPx / (1920 * 1080) - 1) > 0.25) {
    console.log(`[比例] 画面 ${vw}x${vh} → 拼图 ${640 * 3}x${cellH * 3}，单张约 ${gridCost} token（基准 ${gridBase} 已按面积修正）`)
  }

  // 3-5. 规划器决策（planner.mjs 纯函数：密度→张数→预算钳制→成本估算）
  const plan = planAuto({
    duration, budget, densityOpt: opts.density ?? null, rate,
    official, transcript, hasSubs, gridCost,
  })
  const { maxGap, minGrids, subsCost, subsRows, fineReserve, gridCount, chunk, actualGap, estTotal, notes, densityAuto, maxGridsByBudget } = plan
  console.log(`[密度] 目标 ≤${maxGap}s/帧（${densityAuto ? '按变化率推导' : '手动指定'}）`)
  console.log(`[张数] 密度需要 ${minGrids} 张，预算允许 ${maxGridsByBudget} 张 → 采用 ${gridCount} 张`)
  console.log(`[参数] chunk=${chunk.toFixed(1)}s（每张覆盖），实际平均 ${actualGap.toFixed(1)}s/帧`)
  console.log(`[预算] ${budget} token ≈ 字幕带 ${subsCost} + 拼图 ${gridCount * gridCost} + 精读预留 ${fineReserve} = ${estTotal}`)
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
    subsSource: official ? 'official' : transcript ? 'audio' : hasSubs ? 'burned-in' : null,
    danmakuHot: dmHot,                             // 写进 manifest，让 refine 也能用弹幕热区挑点
    danmakuTotal: danmaku?.length ?? 0,
    lowActivitySegments: lowActivitySegs,              // 低活跃段（密度低谷，铺网降权）
    useDanmakuFrames: opts.useDanmakuFrames !== false,  // 弹幕热区是否也参与铺网取帧（默认是）
    semanticShifts: semantic?.segments ?? null,         // 语义切换点（原始信号层，写 manifest）
    coverage,                                       // 产物完整性（各信号源给没给到东西，写 manifest）
  }
  let manifest
  if (opts.resume === true && prevManifest && resumeInfo?.resumable) {
    manifest = prevManifest
    console.log(`[断点] 复用已有拼图（${resumeInfo.doneGrids} 张），跳过抽帧`)
  } else {
    manifest = await stageGrid(source, chunk, '3x3', pre)
  }
  if (hasSubs && !transcript) await stageSubs(source, subsRows, 'auto', { mp4, view, bandResult, scenes, range, page: pageNo })

  // 7. 精读建议 = 几何规则（画面变化剧烈）+ 弹幕热区（观众反应最激烈）
  // 执行器统一合并：几何（manifest）+ 弹幕热区，去重排序（executor.mjs）
  // 阈值可覆盖：FISHEYE_MIN_SCENE（画面变化强度门槛）/ FISHEYE_MAX_PICKS（最多挑几个点）
  const { geo, dmPicks, suggestions } = buildSuggestions(manifest, dmHot, semantic?.suggestions ?? null, {
    minScene: process.env.FISHEYE_MIN_SCENE ? Number(process.env.FISHEYE_MIN_SCENE) : undefined,
    maxPicks: process.env.FISHEYE_MAX_PICKS ? Number(process.env.FISHEYE_MAX_PICKS) : undefined,
  })
  console.log(`\n=== 完成 ===`)
  console.log(`预计 token ≈ ${estTotal}（若铺网信息已自足、跳过精读，实际会更低）`)
  console.log(coverageSummary(coverage))
  if (official) {
    console.log(`\n[字幕] 台词已存成文本，直接读（别为字幕抽帧）：`)
    console.log(`       ${official.txt}`)
  }
  if (suggestions.length) {
    console.log(`\n[精读建议] ${suggestions.length} 个时间点（几何 ${geo.length} + 弹幕 ${dmPicks.length}）：`)
    for (const p of suggestions) console.log(`  ${p.ts}  ${p.source}  —— ${p.reason}`)
    console.log(`  需要时: node fisheye.mjs refine ${source.id}`)
    console.log(`  （几何只能找「变化剧烈」、弹幕只能找「观众反应」；读图发现其他格看不清时，走 refine --template/--decisions）`)
  } else {
    console.log(`\n[精读建议] 两个信号都没命中；读图后如需精读：node fisheye.mjs refine ${source.id} --template`)
  }
  try {
    const st = loadManifestState(OUT, source.id)
    if (st) {
      st.plan = { budget, density: opts.density ?? null, from: opts.from ?? null, to: opts.to ?? null }
      recordStage(st, 'auto', { status: 'done', gridCount, hasSubs, audio: Boolean(transcript) })
    }
  } catch {}
  return { gridCount, chunk, actualGap, maxGap, hasSubs, audio: Boolean(transcript), estTotal, notes, danmaku: danmaku?.length ?? 0, top: suggestions }
}

// refine：决定哪些格需要精读，然后自动截原分辨率单帧
// 两种模式
// --template 生成决策模板（每格一行，agent 读完拼图后填 needDetail）
// --decisions <file.json> 按 agent 的结构化判断执行
// 都不传 几何兜底：只凭像素算，零 token（不读图）
// 分工原则：语义判断（"这格重要吗"）只有读图能做；几何判断（"这格的字一定糊"）可以纯计算。


export function buildDecisionTemplate(manifest) {
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

export async function stageRefine(source, opts) {
  const mfPath = path.join(OUT, `${source.id}-manifest.json`)
  if (!fs.existsSync(mfPath)) throw new Error(`没有 manifest，先跑 auto 或 grid：${mfPath}`)
  const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'))

  if (opts.template) {
    const tpl = buildDecisionTemplate(manifest)
    const p = path.join(OUT, `${source.id}-decisions.template.json`)
    fs.writeFileSync(p, JSON.stringify(tpl, null, 2), 'utf8')
    console.log(`决策模板: ${p}`)
    console.log(`共 ${tpl.cells.length} 格。读完拼图后填 needDetail=true，再执行：`)
    console.log(`  node fisheye.mjs refine ${source.id} --decisions "${p}"`)
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
    console.warn(`[警告] ${picks.length} 帧 ≈ ${estimateTokens('fine', picks.length)} token，建议先只留真正看不清的几帧再跑`)
  }
  console.log('')
  const grabbed = await stageGrab(source, picks.map((p) => p.t).join(','), { page: manifest.page ?? 1 })
  const est = estimateTokens('fine', picks.length)
  console.log(`\n精读成本 ≈ ${est} token（${picks.length} 帧 × ${tokensPerUnit('fine')}）`)
  return { picks, grabbed }
}

export async function stageGrab(source, timeStr, opts = {}) {
  const pageNo = opts.page ?? 1
  const mp4 = path.join(CACHE, pageNo > 1 ? `${source.id}-p${pageNo}.mp4` : `${source.id}.mp4`)
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
    const f = path.join(OUT, `${source.id}-grab-${t.toFixed(2).replace('.', '_')}s.jpg`)
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

export function cleanTargets(target = 'all') {
  const want = String(target ?? 'all').trim().toLowerCase()
  if (!['cache', 'out', 'all'].includes(want)) {
    throw new Error(`--target 只能是 cache / out / all，收到：${JSON.stringify(target)}`)
  }
  const dirs = []
  if (want === 'cache' || want === 'all') dirs.push({ name: 'cache', dir: CACHE })
  if (want === 'out' || want === 'all') dirs.push({ name: 'out', dir: OUT })
  return dirs
}

// 递归统计文件数与总大小（不跟符号链接：链接按 0 字节计，避免统计到外部大文件）
function dirStat(root) {
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        files++
        try { bytes += fs.statSync(p).size } catch { /* 读不到就按 0 计 */ }
      }
    }
  }
  walk(root)
  return { files, bytes }
}

function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

// dry-run 时列出实际会被删掉的文件（最多 20 个/目录，避免长视频跑完刷屏几千行）
function listEntries(root, max = 20) {
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= max) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of ents) {
      if (out.length >= max) return
      const p = path.join(dir, e.name)
      const rel = path.relative(root, p)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile()) {
        let size = 0
        try { size = fs.statSync(p).size } catch {}
        out.push({ rel, size })
      }
    }
  }
  walk(root, 0)
  return out
}


export async function stageClean(opts = {}) {
  const target = String(opts.target ?? 'all').trim().toLowerCase()
  const yes = opts.yes === true
  const dirs = cleanTargets(target)          // 先校验，非法 target 直接抛错
  console.log(`\n=== 清理（target=${target}${yes ? '，--yes 实际删除' : '，dry-run'}）===`)

  const plans = []
  for (const d of dirs) {
    const exists = fs.existsSync(d.dir)
    if (!exists) {
      console.log(`[${d.name}] 目录不存在，跳过：${d.dir}`)
      continue
    }
    const st = dirStat(d.dir)
    plans.push({ ...d, ...st })
    if (!st.files) {
      console.log(`[${d.name}] 空目录：${d.dir}`)
      continue
    }
    console.log(`[${d.name}] ${st.files} 个文件 / ${humanSize(st.bytes)}  → ${d.dir}`)
    for (const e of listEntries(d.dir)) {
      console.log(`    ${e.rel}  ${humanSize(e.size)}`)
    }
    if (st.files > 20) console.log(`    …还有 ${st.files - 20} 个文件未列出`)
  }

  const totalFiles = plans.reduce((s, p) => s + p.files, 0)
  const totalBytes = plans.reduce((s, p) => s + p.bytes, 0)
  if (!plans.length) {
    console.log('\n没有可清理的内容。')
    return { target, deleted: false, files: 0, bytes: 0 }
  }
  if (!totalFiles) {
    console.log('\n目录都是空的，没有可清理的内容。')
    return { target, deleted: false, files: 0, bytes: 0 }
  }

  if (!yes) {
    console.log(`\n将删除 ${totalFiles} 个文件 / ${humanSize(totalBytes)}（dry-run，什么都没删）`)
    console.log('加 --yes 才会真正删除')
    return { target, deleted: false, dryRun: true, files: totalFiles, bytes: totalBytes }
  }

  // 只删每个目录的内容，目录本身保留
  let removedFiles = 0
  let failed = 0
  let freed = 0
  for (const p of plans) {
    let ents = []
    try { ents = fs.readdirSync(p.dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const abs = path.join(p.dir, e.name)
      const st = e.isDirectory() ? dirStat(abs) : { files: 1, bytes: (() => { try { return fs.statSync(abs).size } catch { return 0 } })() }
      try {
        fs.rmSync(abs, { recursive: true, force: true })
        removedFiles += st.files
        freed += st.bytes
      } catch (err) {
        failed++
        console.warn(`[${p.name}] 删除失败：${abs}（${err?.message ?? err}）`)
      }
    }
  }
  console.log(`\n已删除 ${removedFiles} 个文件 / 释放 ${humanSize(freed)}${failed ? `（${failed} 项删除失败）` : ''}`)
  return { target, deleted: true, files: removedFiles, bytes: freed, failed }
}

// CLI

export async function stageTranscribe(source, opts = {}) {
  const pageNo = opts.page ?? 1
  const caps = audioCaps()
  if (!caps.available) {
    console.error(`[音频] 转写不可用：${caps.hint ?? caps.reason}`)
    return null
  }
  const mp4 = await source.media(pageNo)
  const result = await transcribeAudio(mp4, OUT, { lang: opts.lang ?? 'zh', quiet: false })
  if (!result?.text) {
    console.error('[音频] 转写失败或结果为空')
    return null
  }
  const outFile = path.join(OUT, `${source.id}-audio-transcript.txt`)
  fs.writeFileSync(outFile, result.text, 'utf8')
  console.log(`[音频] 转写完成：${result.text.length} 字 → ${outFile}`)
  console.log(result.text.slice(0, 500))
  return result
}

export async function stageLocal(inputFile, opts = {}) {
  const file = path.resolve(inputFile)
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`)
  if (!FFMPEG) throw new Error('找不到 ffmpeg（设置 FFMPEG 环境变量，或放进 PATH）')
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

// OCR：识别一张图片里的文字（截图/画面帧/字幕带）
export async function stageOcr(imagePath, opts = {}) {
  const input = String(imagePath ?? '')
  if (!input) { console.error('[OCR] 需要图片路径'); return null }
  if (!fs.existsSync(input)) { console.error('[OCR] 文件不存在: ' + input); return null }
  const caps = ocrCaps()
  if (!caps.available) { console.error('[OCR] 不可用：' + (caps.hint ?? caps.reason)); return null }
  const r = await ocrImage(input, { lang: opts.lang ?? 'chi_sim+eng', timeoutMs: 60000 })
  if (!r?.text) { console.error('[OCR] 未识别到文字（或识别失败）'); return null }
  fs.mkdirSync(OUT, { recursive: true })
  const outFile = path.join(OUT, path.basename(input, path.extname(input)) + '.ocr.txt')
  fs.writeFileSync(outFile, r.text, 'utf8')
  console.log('[OCR] ' + r.text.length + ' 字 → ' + outFile)
  console.log(r.text.slice(0, 1000))
  return r
}

// URL：用 yt-dlp 下载任意平台视频，再走本地视频流程
export async function stageUrl(url, opts = {}) {
  const link = String(url ?? '').trim()
  if (!/^https?:\/\//i.test(link)) { console.error('[URL] 只支持 http(s) 链接'); return null }
  const caps = ytdlpCaps()
  if (!caps.available) { console.error('[URL] yt-dlp 不可用：' + (caps.hint ?? caps.reason)); return null }
  fs.mkdirSync(CACHE, { recursive: true })
  console.log('[URL] 下载中（可能需要几分钟）：' + link)
  const dl = await downloadVideo(link, CACHE, { timeoutMs: 600000 })
  if (!dl?.file) { console.error('[URL] 下载失败'); return null }
  console.log('[URL] 已下载 → ' + dl.file)
  return stageLocal(dl.file, opts)
}

// 批量：从清单（文件或参数列表）逐条处理
export async function stageBatch(input, opts = {}) {
  const { items, errors } = parseBatchList(input)
  for (const e of errors) console.error(`[批量] 第 ${e.line} 行无法识别：${String(e.raw).slice(0, 60)}`)
  if (!items.length) { console.error('[批量] 没有可处理的条目'); return null }
  console.log(`[批量] 共 ${items.length} 条（并发 ${opts.concurrency ?? 1}）`)
  let idx = 0
  const summary = await runBatch(items, async (item) => {
    idx++
    console.log(`\n[批量 ${idx}/${items.length}] ${item.kind}: ${String(item.value).slice(0, 80)}`)
    if (item.kind === 'bv') return stageAuto(item.value, opts.budget ?? 20000, { page: opts.page ?? 1, audio: opts.audio === true, audioLang: opts.lang ?? null })
    if (item.kind === 'file') return stageLocal(item.value, { grid: opts.grid ?? '3x3', from: opts.from ?? null, to: opts.to ?? null })
    if (item.kind === 'url') return stageUrl(item.value, { grid: opts.grid ?? '3x3', from: opts.from ?? null, to: opts.to ?? null })
    return null
  }, { concurrency: opts.concurrency ?? 1 })
  console.log('\n' + formatBatchReport(summary))
  return summary
}
