// lib/danmaku.mjs — 弹幕分析：低活跃检测 + 广告词高光（已拆到 signals/）+ 热区摘要
// 2.0 第 3 批：七路砍两路，这里只保留「低活跃 + 广告词高光」re-export + 热区摘要。
import { fmt } from './util.mjs'

// 兼容 re-export：低活跃检测 + 广告词高光从 signals/ 转出，旧 import 路径不变
export {
  AD_KEYWORD,
  AD_SEGMENT_SIGNAL,
  detectLowActivity,
  adKeywordHits,
} from './signals/index.mjs'

// 按时间桶聚合，找「观众最激动」的时段。
// 高频重复的弹幕最能代表那里在刷什么（梗 / 共鸣），所以每个热区取前 3 条并标出现次数。

export function summarizeDanmaku(list, bucketSec = 5, topN = 6) {
  if (!list?.length) return null
  const buckets = new Map()
  for (const d of list) {
    const k = Math.floor(d.t / bucketSec) * bucketSec
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(d.text)
  }
  return [...buckets.entries()]
    .map(([start, texts]) => ({ start, texts }))
    .sort((a, b) => b.texts.length - a.texts.length)   // 先按密度挑出最热的 N 个桶
    .slice(0, topN)
    .sort((a, b) => a.start - b.start)                  // 再按时间顺序展示
    .map(({ start, texts }) => {
      const freq = new Map()
      for (const t of texts) freq.set(t, (freq.get(t) ?? 0) + 1)
      const samples = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, n]) => (n > 1 ? `${t}×${n}` : t))
      return { start, end: start + bucketSec, ts: fmt(start), count: texts.length, samples }
    })
}
