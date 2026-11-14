// 执行器：把「规划结果」与「信号数据」落成具体建议/决策模板，只依赖纯数据（无 IO）。
// 几何挑点（画面变化激烈 / 字幕糊）+ 弹幕热区合并——executor 不负责真正抽帧（那在 stages.stageGrid）。
import { fmt } from './util.mjs'

// 拼图里字幕低于这个像素高度就必然糊
export const MIN_READABLE_SUBS_PX = 12

/**
 * 几何挑点：从 manifest 里找值得精读的时间点（画面变化强度高 / 字幕糊），
 * 合并弹幕热区，去掉高置信度广告段，按时间排序。
 * @param {object} manifest stageGrid 生成的 manifest
 * @returns {Array<{t:number, ts:string, reason:string, source:string}>}
 */
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

/**
 * 精读建议：几何挑点（manifest）+ 弹幕热区（独立信号），合并后去重排序。
 * 两个信号互补：几何只看像素，弹幕看人的反应。
 * @param {object} manifest stageGrid 生成的 manifest
 * @param {Array|null} dmHot summarizeDanmaku 的热区
 * @returns {{geo:Array, dmPicks:Array, suggestions:Array}}
 */
export function buildSuggestions(manifest, dmHot) {
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
  return { geo, dmPicks, suggestions }
}
