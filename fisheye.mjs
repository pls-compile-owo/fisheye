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
import path from 'node:path'
import { PKG_DIR, WS, CFG_FILE, FFMPEG, CRED } from './lib/env.mjs'
import { parseTime, num, pageNum } from './lib/util.mjs'
import { stageAuto, stageGrid, stageSubs, stageSelftest, stageRefine, stageGrab, stageLocal } from './lib/stages.mjs'

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
