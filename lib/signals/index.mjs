// lib/signals/index.mjs — 两路广告信号 + 广告词高光（2.0 第 3 批重构）
//
// 设计 05-广告识别：从「替 agent 判断」降级为「给 agent 线索」。
// 七路砍两路：density（低活跃段，影响取帧）+ keywords（广告词高光，纯线索）。
// 已删除：mark/head/buy（弹幕族边角料）、sub-keywords/sub-patterns（台词族）、
//         partitions（分区词库）、semantic（语义仲裁）——0.1 验证五路零独立命中。
import { fmt } from '../util.mjs'

// 广告词库（平台可换；B站默认中文，设计 05 §7.2/7.5）
export const AD_KEYWORD = /金主|恰饭|商单|硬广|软广|赞助|推广|接广|带货|下单|优惠码/i

// 兼容旧导出（历史 import 过渡）
export const AD_SEGMENT_SIGNAL = AD_KEYWORD

/**
 * 低活跃段（设计 05 §7.2 ①：密度低谷 = 低互动 = 低价值代理）。
 * 不是「广告段」——不知道是不是广告，只知道「观众不互动」。影响取帧（render algorithm 轨降权）。
 * @param {Array<{t:number,text:string}>} danmaku 弹幕
 * @param {number} duration 时长（秒）
 * @param {object} [opts] { bucketSec=30, stepSec=10, minDur=45, ratio=0.45 }
 * @returns {Array<{from:number,to:number,dur:number,ts:string,lowDensity:boolean,sample:string[]}>}
 */
export function detectLowActivity(danmaku, duration, opts = {}) {
  const { bucketSec = 30, stepSec = 10, minDur = 45, ratio = 0.45 } = opts
  const dm = Array.isArray(danmaku) ? danmaku : []
  if (!dm.length || duration < 120) return []
  if (dm.length / duration < 0.2) return []

  const dens = []
  for (let s = 0; s + bucketSec <= duration; s += stepSec) {
    let n = 0
    for (const d of dm) if (d.t >= s && d.t < s + bucketSec) n++
    dens.push({ s, n })
  }
  if (!dens.length) return []
  const nums = dens.map((d) => d.n).sort((a, b) => a - b)
  const median = nums[Math.floor(nums.length / 2)] || 1

  const spans = []
  for (const d of dens) {
    if (d.n >= median * ratio) continue
    const last = spans[spans.length - 1]
    if (last && d.s - last.to <= stepSec) last.to = d.s + bucketSec
    else spans.push({ from: d.s, to: d.s + bucketSec })
  }

  return spans.filter((x) => x.to - x.from >= minDur).map((x) => {
    // 复刻旧 densitySignal 的「扩展 ±15s」：短低谷段扩展后能覆盖真值广告段（避开片头 60s / 片尾 60s）
    const from = Math.max(x.from - 15, 60)
    const to = Math.min(x.to + 15, Math.max(from + 1, duration - 60))
    const segDm = dm.filter((d) => d.t >= from && d.t < to)
    return {
      from,
      to,
      dur: to - from,
      ts: `${fmt(from)}-${fmt(to)}`,
      lowDensity: true,
      sample: segDm.slice(0, 3).map((d) => d.text), // 结论配证据（设计 05 §7.2）
    }
  })
}

/**
 * 广告词高光（设计 05 §7.2 ②：纯线索，不影响决策）。
 * 匹配 AD_KEYWORD 的弹幕，去重 + 限量（最多 50 条）。
 * @param {Array<{t:number,text:string}>} danmaku
 * @param {RegExp} [adKeyword=AD_KEYWORD]
 * @param {number} [limit=50]
 * @returns {Array<{t:number,text:string}>}
 */
export function adKeywordHits(danmaku, adKeyword = AD_KEYWORD, limit = 50) {
  const seen = new Set()
  const out = []
  for (const d of (Array.isArray(danmaku) ? danmaku : [])) {
    const text = String(d?.text ?? '').trim()
    if (!text || seen.has(text)) continue
    if (adKeyword.test(text)) {
      seen.add(text)
      out.push({ t: Number(d.t) || 0, text })
      if (out.length >= limit) break
    }
  }
  return out
}
