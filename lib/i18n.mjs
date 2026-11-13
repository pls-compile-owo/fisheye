// 国际化：CLI 文案按语言取用。语言来自环境变量 FISHEYE_LANG
// 'zh'（默认）/ 'en'；也接受 zh-CN、en-US 这类写法（取第一段）。
// 零依赖：只读 process.env，不引任何模块。

const DEFAULT_LANG = 'zh'
const SUPPORTED = new Set(['zh', 'en'])

/** 当前语言：FISHEYE_LANG 不合法或没设时回落到中文 */
export function getLang() {
  const raw = String(process.env.FISHEYE_LANG ?? '').trim().toLowerCase()
  if (!raw) return DEFAULT_LANG
  const base = raw.split(/[-_]/)[0]
  return SUPPORTED.has(base) ? base : DEFAULT_LANG
}

// 文案表。占位符写法 {name}，由 t() 的 vars 替换；
// 找不到当前语言的 key 时回落到中文，再找不到就原样返回 key（方便发现漏翻）。
const MESSAGES = {
  zh: {
    // —— 用法帮助 ——
    usage: `用法:
  node fisheye.mjs auto <BV> [--budget 20000] [--density 6]      ← 推荐：自动规划并铺网
  node fisheye.mjs refine <BV> --template                         ← 生成精读决策模板
  node fisheye.mjs refine <BV> --decisions <file.json>            ← 按模型判断精读
  node fisheye.mjs refine <BV>                                    ← 几何兜底（零 token）
  node fisheye.mjs grid <BV> [--chunk 60] [--grid 3x3]
  node fisheye.mjs subs <BV> [--count 12] [--band auto|0.22]
  node fisheye.mjs grab <BV> <t1,t2,t3>                           ← 手动指定时间点
  node fisheye.mjs local <视频文件> [--grid 3x3] [--from t] [--to t]  ← 看本地视频（mp4/mkv/...）
  node fisheye.mjs selftest [--deep]                              ← 自检（依赖/凭证/API/缓存/磁盘）`,

    // —— 依赖缺失 ——
    'err.ffmpeg.missing': `找不到 ffmpeg。

安装方式（任选其一）：
  1. 装到 PATH：https://ffmpeg.org/download.html （Windows 用 gyan.dev 的 build）
  2. 放项目里：把 ffmpeg 可执行文件放到 {binDir}/
  3. 设环境变量：FFMPEG=<ffmpeg 完整路径>
  4. 写配置：{cfgFile} 里加 {"ffmpeg": "<完整路径>"}`,

    'err.cred.missing': `找不到 B站登录态文件。

创建 {credPath}，内容：
  {
    "sessdata": "<B站 SESSDATA>",
    "bili_jct": "<bili_jct>",
    "buvid3": "<buvid3>"
  }
获取方法：浏览器登录 B站 → F12 → Application → Cookies → bilibili.com，
复制这三个值。或用环境变量 BILI_CRED=<文件路径> 指向已有文件。

（也可以只跑 selftest 先看环境是否就绪：node fisheye.mjs selftest）`,

    // —— 命令 / 参数错误 ——
    'err.unknownStage': '未知阶段: {stage}',
    'err.bvFormat': '[错误] BV 号格式不对：{raw}（应为 BV + 10 位字母数字，如 BV1ziWP6qENy）',
    'err.local.usage': '用法: node fisheye.mjs local <视频文件> [--grid 3x3] [--from t] [--to t]',
    'err.fatal': '\n错误：{message}',
    'err.local.failed': '[错误] {message}',

    // —— util 参数校验 ——
    'err.argPrefix': '参数错误：',
    'err.num.notNumber': '--{name} 需要数字，收到：{value}',
    'err.num.min': '--{name} 不能小于 {min}（收到 {n}）',
    'err.num.max': '--{name} 不能大于 {max}（收到 {n}）',
    'err.grid.format': '--grid 格式应为 NxM（如 3x3，行列 1~9），收到：{value}',
    'err.time.format': '--{name} 时间格式应为 330 / 5:30 / 1:05:30，收到：{value}',
    'err.time.invalid': '--{name} 时间格式非法：{value}',
    'err.page.range': '--p 分P序号应为 1~200 的整数，收到：{value}'
  },

  en: {
    usage: `Usage:
  node fisheye.mjs auto <BV> [--budget 20000] [--density 6]      # recommended: auto-plan and build grids
  node fisheye.mjs refine <BV> --template                         # generate a refine decision template
  node fisheye.mjs refine <BV> --decisions <file.json>            # refine using model decisions
  node fisheye.mjs refine <BV>                                    # geometric fallback (zero tokens)
  node fisheye.mjs grid <BV> [--chunk 60] [--grid 3x3]
  node fisheye.mjs subs <BV> [--count 12] [--band auto|0.22]
  node fisheye.mjs grab <BV> <t1,t2,t3>                           # pick timestamps manually
  node fisheye.mjs local <video file> [--grid 3x3] [--from t] [--to t]  # analyze a local video (mp4/mkv/...)
  node fisheye.mjs selftest [--deep]                              # self-check (deps/credentials/API/cache/disk)`,

    'err.ffmpeg.missing': `ffmpeg not found.

Install it in one of these ways:
  1. Put it on PATH: https://ffmpeg.org/download.html (on Windows use a gyan.dev build)
  2. Drop it into the project: place the ffmpeg executable in {binDir}/
  3. Set an env var: FFMPEG=<full path to ffmpeg>
  4. Use the config file: add {"ffmpeg": "<full path>"} to {cfgFile}`,

    'err.cred.missing': `Bilibili credentials not found.

Create {credPath} containing:
  {
    "sessdata": "<Bilibili SESSDATA>",
    "bili_jct": "<bili_jct>",
    "buvid3": "<buvid3>"
  }
How to get them: log in to Bilibili in your browser → F12 → Application → Cookies → bilibili.com,
then copy those three values. Or set BILI_CRED=<file path> to point at an existing file.

(You can also run selftest first to check whether the environment is ready: node fisheye.mjs selftest)`,

    'err.unknownStage': 'Unknown stage: {stage}',
    'err.bvFormat': '[error] Invalid BV id: {raw} (expected BV + 10 alphanumeric chars, e.g. BV1ziWP6qENy)',
    'err.local.usage': 'Usage: node fisheye.mjs local <video file> [--grid 3x3] [--from t] [--to t]',
    'err.fatal': '\nError: {message}',
    'err.local.failed': '[error] {message}',

    'err.argPrefix': 'Argument error: ',
    'err.num.notNumber': '--{name} must be a number, got: {value}',
    'err.num.min': '--{name} must be >= {min} (got {n})',
    'err.num.max': '--{name} must be <= {max} (got {n})',
    'err.grid.format': '--grid must be NxM (e.g. 3x3, rows/cols 1-9), got: {value}',
    'err.time.format': '--{name} must be a time like 330 / 5:30 / 1:05:30, got: {value}',
    'err.time.invalid': '--{name} invalid time: {value}',
    'err.page.range': '--p (page number) must be an integer from 1 to 200, got: {value}'
  }
}

/**
 * 取当前语言的一条文案，替换 {name} 占位符。
 * 未提供的占位符保持原样，未知 key 返回 key 本身。
 */
export function t(key, vars = {}) {
  const entry = MESSAGES[getLang()]?.[key] ?? MESSAGES[DEFAULT_LANG][key]
  if (entry === undefined) return key
  return entry.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match)
}
