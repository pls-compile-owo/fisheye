// 弹幕分析：广告段检测已拆到 lib/signals/（信号源可插拔），这里保留热区摘要 + 兼容 re-export。
// 拆出原因：七路广告信号原硬编码在本文件的 detectAdSegmentsCore 里，现在做成可注册信号源，
// 弹幕族五路在 lib/signals/danmaku.mjs，台词族两路在 lib/signals/subtitle.mjs，编排在 lib/signals/index.mjs。
import { fmt } from './util.mjs'

// 兼容 re-export：常量 + 检测入口从信号源目录转出，所有旧 import 路径不变
export {
  DEFAULT_KEYWORDS,
  AD_SEGMENT_SIGNAL,
  DEFAULT_SIGNALS,
  AD_SIGNALS,
  detectAdSegments,
  detectAdSegmentsCore,
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
