// lib/budget.mjs —— token 预算估算（零依赖，Node ≥18）
//
// 为什么单独拆一个模块：
//   fisheye 的整个「抽多少帧 / 拼几张图」决策都建立在「一张图 ≈ 多少 token」上。
//   旧版把这个值写死在 stages.mjs（COST = { grid: 1200, subs: 1000, fine: 1300 }），
//   但不同模型的图像 tokenizer 差异很大——同一张 1920x1080 拼图，
//   Gemini 对单图按固定档位计（约 258 token 起），GPT-4o high detail 按 512px 瓦片计（约 1.1k~2.1k），
//   Qwen-VL 系列走动态分辨率（28px patch，token 更多）。固定系数会系统性高估或低估 20~30%，
//   直接让「预算只够几张」算错，最后要么超支、要么白白变稀。
//
// 估算公式：
//   estimateTokens(kind, count) = round(tokensPerUnit(kind) * count)
//   tokensPerUnit(kind)         = round(基准(kind) * 模型系数)      // 单张/单帧成本
//
// 基准值（环境变量可覆盖，单位 token；覆盖值须为正数，非法值忽略并告警一次）：
//   grid = 1024  FISHEYE_TOKENS_PER_GRID
//       3x3 拼图（9 格 × 640px，约 1920x1080）。官方 Flash 每图上限 1024（缩放 1300×1300，与尺寸无关）。
//   subs = 1024  FISHEYE_TOKENS_PER_SUBS
//       烧录字幕带（1xN 行，仍是「一张图」）。
//   fine = 1024  FISHEYE_TOKENS_PER_FINE
//       精读单帧原图（5x5 也是一张图，与 coarse 同价）。
//
// 模型系数（FISHEYE_TOKEN_MODEL，默认 1.0 = Flash 基准）：
//   gpt     1.08   GPT-4o 一类按 512px 瓦片计费（1105/1024）
//   qwen    1.27   Qwen-VL 动态分辨率（1300/1024）
//   gemini  0.25   Gemini 单图固定档位（258/1024）
//   claude  1.56   Claude（1600/1024）
//   也可直接写数字（如 1.2），会被收敛到 [0.25, 4] 区间
//
// 兼容性：三个环境变量都不设、FISHEYE_TOKEN_MODEL 也不设时，
//   estimateTokens('grid'|'subs'|'fine', n) 与 COST.* × n 一致。

// 默认单张成本（token）。导出 COST 是为了兼容旧代码里 `import { COST } from './stages.mjs'` 的用法。
// 2.0 第 4 批：图片单价统一 1024（0.5 计费核对：官方 Flash vision 每图上限 1024，拼图/字幕带/精读帧都是「一张图」）。
const DEFAULTS = Object.freeze({ grid: 1024, subs: 1024, fine: 1024 })

export const COST = DEFAULTS

// 模型系数表：只描述「相对基准模型（Flash），同一张图的 token 大致贵/便宜多少」。
// 数值来自 0.5 计费核对（官方文档倍率，vs Flash 1024）：
//   gemini 0.25 / gpt 1.08 / claude 1.56 / qwen 1.27
export const MODEL_FACTORS = Object.freeze({
  gpt: 1.08,
  qwen: 1.27,
  gemini: 0.25,
  claude: 1.56,
})

const ENV_PER_UNIT = Object.freeze({
  grid: 'FISHEYE_TOKENS_PER_GRID',
  subs: 'FISHEYE_TOKENS_PER_SUBS',
  fine: 'FISHEYE_TOKENS_PER_FINE',
})

const FACTOR_MIN = 0.25
const FACTOR_MAX = 4

// 同一个错误只提示一次，避免在每个拼图的日志里刷屏
const warned = new Set()
function warnOnce(key, message) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[预算] ${message}`)
}

function toPositiveNumber(raw) {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 解析模型系数；无法识别/非法时回退 1.0（并告警一次），保证环境变量写错不会瘫痪 CLI */
export function modelFactor(raw = process.env.FISHEYE_TOKEN_MODEL) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 1
  const key = String(raw).trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(MODEL_FACTORS, key)) return MODEL_FACTORS[key]
  const n = toPositiveNumber(key)
  if (n !== null) {
    const clamped = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, n))
    if (clamped !== n) warnOnce(`factor:${n}`, `FISHEYE_TOKEN_MODEL=${raw} 超出合理范围，已收敛为 ×${clamped}`)
    return clamped
  }
  warnOnce(`model:${key}`, `FISHEYE_TOKEN_MODEL=${raw} 不认识（可用 gpt / qwen / gemini，或 0.5~2 的数字），按 ×1 估算`)
  return 1
}

/** 单张（单帧）成本：基准 × 模型系数，四舍五入到整数 token */
export function tokensPerUnit(kind) {
  const base = DEFAULTS[kind]
  if (base === undefined) {
    throw new Error(`tokensPerUnit：未知 kind「${kind}」（支持 ${Object.keys(DEFAULTS).join(' / ')}）`)
  }
  const envVar = ENV_PER_UNIT[kind]
  const raw = process.env[envVar]
  let unit = base
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = toPositiveNumber(raw)
    if (n === null) warnOnce(`env:${envVar}`, `${envVar}=${raw} 不是正数，忽略，仍用默认 ${base}`)
    else unit = n
  }
  return Math.round(unit * modelFactor())
}

/**
 * 估算 count 个单位的 token 消耗。
 * @param {'grid'|'subs'|'fine'} kind 单位类型：拼图 / 烧录字幕带 / 精读单帧
 * @param {number} [count=1] 数量；非有限数或 ≤0 视为 0（空列表不花钱）
 * @returns {number} 整数 token
 */
export function estimateTokens(kind, count = 1) {
  if (DEFAULTS[kind] === undefined) {
    throw new Error(`estimateTokens：未知 kind「${kind}」（支持 ${Object.keys(DEFAULTS).join(' / ')}）`)
  }
  const n = count === undefined || count === null ? 1 : Number(count)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(tokensPerUnit(kind) * n)
}
