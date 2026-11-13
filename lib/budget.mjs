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
//   grid = 1200  FISHEYE_TOKENS_PER_GRID
//       3x3 拼图（9 格 × 640px，约 1920x1080）。stageAuto 还会按实际画面面积再修正，
//       所以这里只是 16:9 的基准值。
//   subs = 1000  FISHEYE_TOKENS_PER_SUBS
//       烧录字幕带（1xN 行，只裁画面里的字幕条，信息密度高但仍是图）。
//   fine = 1300  FISHEYE_TOKENS_PER_FINE
//       精读用单帧原图（不压成 640 格，通常比拼图里的单格更贵一点）。
//
// 模型系数（FISHEYE_TOKEN_MODEL，默认 1.0 = 基准，保持向后兼容）：
//   gpt     1.0    GPT-4o / 4.1 一类按 512px 瓦片计费的基准
//   qwen    1.35   Qwen2-VL / 2.5-VL 动态分辨率，同图 token 明显更多（保守取 1.35）
//   gemini  0.8    Gemini 单图固定档位计费，token 更少；取 0.8 作为保守下限（不按 258 的极端值算）
//   也可直接写数字（如 1.2），会被收敛到 [0.25, 4] 区间
//
// 兼容性：三个环境变量都不设、FISHEYE_TOKEN_MODEL 也不设时，
//   estimateTokens('grid'|'subs'|'fine', n) 与旧版 COST.* × n 完全一致。

// 默认单张成本（token）。导出 COST 是为了兼容旧代码里 `import { COST } from './stages.mjs'` 的用法。
const DEFAULTS = Object.freeze({ grid: 1200, subs: 1000, fine: 1300 })

export const COST = DEFAULTS

// 模型系数表：只描述「相对基准模型，同一张图的 token 大致贵/便宜多少」。
// 数值来自公开的计费规则量级（图像 500~4000 token/图），不是精确 tokenizer 复刻；
// 目的是把 20~30% 的系统性偏差收窄，而不是追求逐像素精确。
export const MODEL_FACTORS = Object.freeze({
  gpt: 1,
  qwen: 1.35,
  gemini: 0.8,
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
