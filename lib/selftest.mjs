// 自检（stageSelftest）：依赖 / 凭证 / API / 可选能力 / 缓存 / 磁盘。
// 从 stages.mjs 拆出（编排与自检职责分离；自检是独立可维护的 180 行逻辑）。
import fs from 'node:fs'
import path from 'node:path'
import { PKG_DIR, WS, CACHE, OUT, CFG_FILE, FFMPEG, PYTHON, PYTHON_RES, CRED } from './env.mjs'
import { fmt, jpegSize } from './util.mjs'
import { getView, cred, looksLikeMp4 } from './bili.mjs'
import { grabFrame, runCapture } from './frame.mjs'
import { platforms } from './platforms/index.mjs'
import { audioCaps, transcribeAudio } from './audio.mjs'
import { ocrCaps, ocrImage } from './ocr.mjs'
import { ytdlpCaps } from './ytdlp.mjs'
import { semanticCaps, semanticSegment } from './semantic.mjs'

export async function stageSelftest(opts = {}) {
  const rows = []
  const rec = (mark, label, detail = '') => {
    rows.push({ mark, label, detail })
    console.log(`  [${mark}] ${label.padEnd(18)} ${detail}`)
  }
  const t0 = Date.now()
  const deep = opts.deep === true
  let pythonDepsOk = false
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
    if (r.ok) {
      // 用「实际会调用的这个解释器」验证依赖，而不是只看某个环境里有没有
      const dep = runCapture(PYTHON, ['-c', 'import numpy, PIL'], 15000)
      pythonDepsOk = dep.ok
      rec(dep.ok ? 'OK' : '--', 'python', dep.ok ? r.out.trim() + '（numpy + Pillow 可用）' : r.out.trim() + '（缺 numpy/Pillow——字幕带功能降级）')
    } else rec('--', 'python', `无法执行（${PYTHON_RES?.from ?? '?'}，可能是 Windows 商店占位符）——字幕带功能降级`)
  }

  // 4) analyze_subs.py
  const aspy = path.join(PKG_DIR, 'analyze_subs.py')
  rec(fs.existsSync(aspy) ? 'OK' : '!!', 'analyze_subs.py', fs.existsSync(aspy) ? '存在' : '不存在（烧录字幕带检测会失败）')

  // 5) 输出/缓存目录可写（首次运行时目录可能还不存在：先幂等创建，不算失败）
  try {
    fs.mkdirSync(OUT, { recursive: true })
    const t = path.join(OUT, `.selftest-${process.pid}.tmp`)
    fs.writeFileSync(t, 'ok')
    fs.unlinkSync(t)
    rec('OK', '输出目录', '可写')
  } catch (e) { rec('!!', '输出目录', `不可写：${String(e.message).slice(0, 50)}`) }

  // 6) 平台适配器自检（遍历注册表：凭证 + 平台专属 API，由各适配器 selftest 钩子实现）
  for (const p of platforms) {
    if (typeof p.selftest === 'function') {
      await p.selftest({ rec, CACHE })
    }
  }

  // 7) 能力工具（平台无关）+ 缓存统计
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })
  const cached = fs.readdirSync(CACHE).filter((f) => /^BV[\w]+(-p\d+)?\.mp4$/.test(f) && fs.statSync(path.join(CACHE, f)).size > 1024)
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
      if (okFrame && fs.existsSync(aspy) && pythonDepsOk) {
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

    // A2: 真实调用链实测（不满足于「二进制在不在」，真跑最小样例）
    // 1) ffmpeg 真解码一次（testsrc 1 秒）
    if (FFMPEG) {
      const r = runCapture(FFMPEG, ['-hide_banner', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=5', '-f', 'null', '-'], 15000)
      rec(r.ok ? 'OK' : '!!', 'ffmpeg 实测', r.ok ? 'testsrc 1s 解码通过' : String(r.err || '失败').slice(0, 50))
    }
    // 2) OCR 实测：识别随包样图，验证「真能出字」
    try {
      const ocrNow = ocrCaps()
      const sample = path.join(PKG_DIR, 'test', 'ocr-sample.png')
      if (ocrNow.available && fs.existsSync(sample)) {
        const r = ocrImage(sample, { lang: 'eng', timeoutMs: 30000 })
        const text = String(r?.text ?? '')
        rec(r && /HELLO|123/.test(text) ? 'OK' : '!!', 'OCR 实测', r ? `识别「${text.slice(0, 30)}」` : '识别失败')
      } else rec('--', 'OCR 实测', 'OCR 不可用或缺样图')
    } catch (e) { rec('!!', 'OCR 实测', String(e.message).slice(0, 50)) }
    // 3) whisper 实测：3 秒静音 → 转写（验证子进程链路，不要求内容）
    try {
      const audioNow = audioCaps()
      if (audioNow.available && FFMPEG) {
        const wav = path.join(OUT, `.selftest-silence-${process.pid}.wav`)
        const gen = runCapture(FFMPEG, ['-hide_banner', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-acodec', 'pcm_s16le', '-y', wav], 20000)
        if (gen.ok && fs.existsSync(wav)) {
          const tr = await transcribeAudio(wav, OUT, { lang: 'zh', quiet: true })
          rec(tr ? 'OK' : '!!', '转写实测', tr ? `静音 3s → ${String(tr.text ?? '').length} 字输出` : '转写失败（子进程链路问题）')
          try { fs.unlinkSync(wav) } catch {}
        } else rec('--', '转写实测', '生成静音样例失败')
      } else rec('--', '转写实测', 'whisper 不可用')
    } catch (e) { rec('!!', '转写实测', String(e.message).slice(0, 50)) }
    // 4) 语义实测（C）：3 行台词切分，校验输出符合契约
    try {
      const semNow = semanticCaps()
      if (semNow.available) {
        const sample = [
          { t: 0, text: '今天我们来聊聊视频理解。' },
          { t: 5, text: '首先看官方字幕怎么读。' },
          { t: 10, text: '接下来我们换个话题，讲弹幕。' },
        ]
        const out = semanticSegment(sample, { nBkps: 1 })
        const shapeOk = out && Array.isArray(out.segments) && out.segments.every((s) => typeof s.t === 'number' && Array.isArray(s.signals))
        rec(shapeOk ? 'OK' : '!!', '语义实测', shapeOk ? `切分输出合法（${out.segments.length} 个切换点）` : '语义 CLI 输出不符合契约')
      } else rec('--', '语义实测', '语义模块不可用（未装 python 依赖）')
    } catch (e) { rec('!!', '语义实测', String(e.message).slice(0, 50)) }
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
