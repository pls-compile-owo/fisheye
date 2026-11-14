// 规划器：只做「决策」，不碰 IO / 子进程 / 网络。
// 输入视频元信息与信号（变化率/字幕/弹幕/预算），输出铺网计划（张数/分段/成本估算）。
// 这样 auto 的编排代码只负责「采集信号 → 调规划器 → 执行」，决策逻辑可独立单测。
import { estimateTokens } from './budget.mjs'

// 拼图张数硬上限，防长视频失控
export const MAX_GRIDS = 12

/**
 * 决定 auto 的铺网计划。
 * @param {object} ctx
 * @param {number} ctx.duration 处理区间时长（秒）
 * @param {number} ctx.budget token 预算
 * @param {number|null} ctx.densityOpt --density 手动指定（秒/帧），null=按变化率推导
 * @param {number} ctx.rate 内容变化率（次/秒）
 * @param {object|null} ctx.official 官方字幕（含 chars）
 * @param {string} ctx.transcript 音频转写文本（空串=无）
 * @param {boolean} ctx.hasSubs 是否有烧录字幕带
 * @param {number} ctx.gridCost 单张拼图 token
 * @returns {{
 *   maxGap:number, minGrids:number, subsCost:number, subsRows:number,
 *   fineReserve:number, gridCount:number, chunk:number, actualGap:number,
 *   estTotal:number, notes:string[], densityAuto:boolean, maxGridsByBudget:number
 * }}
 */
export function planAuto(ctx) {
  const { duration, budget, densityOpt, rate, official, transcript, hasSubs, gridCost } = ctx

  // 1. 看懂所需的最低帧间隔（--density 可强制覆盖）
  let maxGap
  if (densityOpt) maxGap = densityOpt
  else if (rate > 1.2) maxGap = 4   // 快剪 / MV / 游戏
  else if (rate > 0.5) maxGap = 6   // vlog / 教程
  else if (rate > 0.15) maxGap = 9  // 口播 / 慢节奏
  else maxGap = 13                  // 静态 / 录屏
  const densityAuto = !densityOpt

  // 2. 张数：先满足密度，再看预算
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
  const estTotal = subsCost + gridCount * gridCost + fineReserve

  return {
    maxGap, minGrids, subsCost, subsRows, fineReserve,
    gridCount, chunk, actualGap, estTotal, notes, densityAuto, maxGridsByBudget
  }
}
