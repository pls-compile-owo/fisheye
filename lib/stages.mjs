// 五个阶段 + 本地视频：grid / subs / auto / refine / grab / local / selftest
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { spamReason, filterDanmaku } from '../danmaku-filter.mjs'
import { PKG_DIR, WS, CACHE, OUT, CFG_FILE, LOCAL_CFG, onPath, resolveTool, FFMPEG, PYTHON, PYTHON_RES, CRED } from './env.mjs'
import { fmt, fsec, jpegSize, fail, num, gridStr, parseTime, pageNum } from './util.mjs'
import { UA, cred, H, getView, MIXIN_TAB, keyOf, clean, getOfficialSubs, looksLikeMp4, ensureMp4, getDanmaku } from './bili.mjs'
import { detectScenes, subtractAds, pickTimes, snapSubsTimes, detectBand, grabFrame, runCapture } from './frame.mjs'
import { audioCaps, transcribeAudio } from './audio.mjs'
import { ocrCaps, ocrImage } from './ocr.mjs'
import { ytdlpCaps, downloadVideo } from './ytdlp.mjs'
import { parseBatchList, runBatch, formatBatchReport } from './batch.mjs'
import { loadManifestState, canResume, recordStage } from './resume.mjs'
import { AD_SEGMENT_SIGNAL, detectAdSegments, summarizeDanmaku } from './danmaku.mjs'
import { estimateTokens, tokensPerUnit, modelFactor, COST } from './budget.mjs'

export async function stageGrid(bvid, chunkSec, grid, pre = {}) {
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

export async function stageSubs(bvid, count, bandArg, pre = {}) {
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

// 单张成本不再写死：统一走 lib/budget.mjs 的 estimateTokens(kind, count)。
// 默认基准仍是 grid 1200 / subs 1000 / fine 1300（与旧版完全一致），
// 但支持 FISHEYE_TOKENS_PER_* 覆盖与 FISHEYE_TOKEN_MODEL 模型系数。
// COST 保留导出只为兼容旧的外部引用，内部不再直接乘它（它看不到环境变量）。
export { COST }

export const MAX_GRIDS = 12                                  // 拼图张数硬上限，防长视频失控

// selftest：自检
// 原则：默认不下载视频、几秒内跑完；--deep 才做抽帧和字幕带。
// 覆盖：依赖（ffmpeg/python/analyze_subs.py）→ 凭证 → API（视频/弹幕/字幕）→ 缓存 → 磁盘

export async function stageSelftest(opts = {}) {
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
    else rec('--', 'python', `无法执行（${PYTHON_RES?.from ?? '?'}，可能是 Windows 商店占位符）——字幕带功能降级`)
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
  try {
    const audio = audioCaps()
    rec(audio.available ? 'OK' : '--', '音频转写', audio.summary)
  } catch (e) { rec('!!', '音频转写', String(e.message).slice(0, 50)) }
  try {
    const ocr = ocrCaps()
    rec(ocr.available ? 'OK' : '--', 'OCR', ocr.summary)
  } catch (e) { rec('!!', 'OCR', String(e.message).slice(0, 50)) }
  try {
    const yt = ytdlpCaps()
    rec(yt.available ? 'OK' : '--', 'yt-dlp', yt.summary)
  } catch (e) { rec('!!', 'yt-dlp', String(e.message).slice(0, 50)) }
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

export async function stageAuto(bvid, budget, opts = {}) {
  // 断点：out/<BV>-manifest.json 存在且计划参数一致时可复用
  // --resume 跳过已完成的抽帧阶段；--force 强制重跑；默认只提示
  let prevManifest = null
  let resumeInfo = null
  try {
    const prev = loadManifestState(OUT, bvid)
    if (prev && !opts.force) {
      resumeInfo = canResume(prev, { plan: { budget, density: opts.density ?? null, from: opts.from ?? null, to: opts.to ?? null } })
      if (resumeInfo.resumable) {
        prevManifest = prev
        console.log('[断点] 检测到可复用产物：' + resumeInfo.reason +
          (opts.resume === true ? '（--resume：跳过抽帧）' : '（加 --resume 跳过抽帧 / --force 强制重跑）'))
      }
    }
  } catch {}
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

  // 拼图 token 按实际画面比例修正：estimateTokens('grid', 1) 以 16:9（约 1920x1080）拼图为基准，
  // 方形/竖屏视频的拼图面积大得多（1920x1920 贵 78%，竖屏贵 3 倍+），不算清楚会误导预算决策
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
          const txtFile = path.join(OUT, `${bvid}-audio-transcript.txt`)
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
  const adSegs = detectAdSegments(danmaku, fullDuration, 30, 10, official?.body ?? null)
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

  const subsCost = official ? Math.round(official.chars) : transcript ? transcript.length : hasSubs ? estimateTokens('subs', 1) : 0
  const subsRows = duration <= 180 ? 14 : duration <= 600 ? 20 : 24
  const minFine = (official || hasSubs) ? 2 : 3   // 字幕已在手，精读需求自然变少
  const fineReserve = estimateTokens('fine', minFine)
  const fixedCost = subsCost + fineReserve
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
  const estTotal = subsCost + gridCount * gridCost + fineReserve
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
    adSegments: adSegs,                            // 视频内疑似广告段（精读会避开 high 置信度的）
    useDanmakuFrames: opts.useDanmakuFrames !== false,  // 弹幕热区是否也参与铺网取帧（默认是）
  }
  let manifest
  if (opts.resume === true && prevManifest && resumeInfo?.resumable) {
    manifest = prevManifest
    console.log(`[断点] 复用已有拼图（${resumeInfo.doneGrids} 张），跳过抽帧`)
  } else {
    manifest = await stageGrid(bvid, chunk, '3x3', pre)
  }
  if (hasSubs && !transcript) await stageSubs(bvid, subsRows, 'auto', { mp4, view, bandResult, scenes, range, page: pageNo })

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
  try {
    const st = loadManifestState(OUT, bvid)
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

export const MIN_READABLE_SUBS_PX = 12 // 拼图里字幕低于这个像素高度就必然糊

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

export function geometricPick(manifest) {
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

export async function stageRefine(bvid, opts) {
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
    console.warn(`[警告] ${picks.length} 帧 ≈ ${estimateTokens('fine', picks.length)} token，建议先只留真正看不清的几帧再跑`)
  }
  console.log('')
  const grabbed = await stageGrab(bvid, picks.map((p) => p.t).join(','), { page: manifest.page ?? 1 })
  const est = estimateTokens('fine', picks.length)
  console.log(`\n精读成本 ≈ ${est} token（${picks.length} 帧 × ${tokensPerUnit('fine')}）`)
  return { picks, grabbed }
}

export async function stageGrab(bvid, timeStr, opts = {}) {
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

export async function stageTranscribe(bvid, opts = {}) {
  const pageNo = opts.page ?? 1
  const caps = audioCaps()
  if (!caps.available) {
    console.error(`[音频] 转写不可用：${caps.hint ?? caps.reason}`)
    return null
  }
  const mp4 = await ensureMp4(bvid, pageNo)
  const result = await transcribeAudio(mp4, OUT, { lang: opts.lang ?? 'zh', quiet: false })
  if (!result?.text) {
    console.error('[音频] 转写失败或结果为空')
    return null
  }
  const outFile = path.join(OUT, `${bvid}-audio-transcript.txt`)
  fs.writeFileSync(outFile, result.text, 'utf8')
  console.log(`[音频] 转写完成：${result.text.length} 字 → ${outFile}`)
  console.log(result.text.slice(0, 500))
  return result
}

export async function stageLocal(inputFile, opts = {}) {
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
