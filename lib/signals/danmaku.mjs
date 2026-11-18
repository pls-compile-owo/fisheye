// lib/signals/danmaku.mjs — 弹幕族五路广告信号源（密度 / 关键词 / 打点 / 片头 / 消费回溯）
//
// 每个信号源导出一个 detect(ctx, keywords) 纯函数，输入共享工作上下文 + 关键词库，
// 输出标准化候选段 [{ from, to, subAd?, subKind? }]。编排与合并投票在 lib/signals/index.mjs。
//
// 契约：ctx = { danmaku, duration, bucketSec, stepSec, hits, dens, median, subLines }
//   hits    —— 命中广告关键词的弹幕（关键词信号 + 最终置信度共用）
//   dens    —— 密度桶 [{ s, n }]（密度信号 + 最终低密度比共用）
//   median  —— 密度中位数
// 抽取原因：这五路原来硬编码在 danmaku.mjs 的 detectAdSegmentsCore 里，拆成独立信号源后
// 可单独替换（如把密度低谷换成分类模型），也可被「无弹幕平台」选择性地排除。

// 密度低谷（主信号）：低于 median*0.45 的连续低谷，≥45s 才算
export function densitySignal(ctx) {
  const { dens, median, stepSec, bucketSec } = ctx
  if (!dens?.length) return []
  const spans = []
  for (const d of dens) {
    if (d.n >= median * 0.45) continue
    const last = spans[spans.length - 1]
    if (last && d.s - last.to <= stepSec) last.to = d.s + bucketSec
    else spans.push({ from: d.s, to: d.s + bucketSec })
  }
  return spans.filter((x) => x.to - x.from >= 45)
}

// 关键词聚类（主信号）：广告关键词命中时间聚类，≥10s 且 ≥2 条
export function keywordSignal(ctx) {
  const { hits } = ctx
  if (!hits?.length) return []
  const hitTimes = hits.map((h) => h.t).sort((a, b) => a - b)
  const spans = []
  for (const tt of hitTimes) {
    const last = spans[spans.length - 1]
    if (last && tt - last.to <= 60) last.to = tt
    else spans.push({ from: tt, to: tt })
  }
  return spans.filter(
    (s) => s.to - s.from >= 10 && hitTimes.filter((x) => x >= s.from && x <= s.to).length >= 2)
}

// 数字打点：观众自发标记广告结束时间（4:50 / 1407 / 4分50）
export function markSignal(ctx, kw) {
  const { danmaku, duration } = ctx
  const out = []
  for (const d of danmaku) {
    if (!kw.mark.test(d.text)) continue
    const m = d.text.match(/(\d{1,2})[.．:：；;](\d{2})|(\d{3,4})|(\d{1,2})分(\d{2})/)
    if (!m) continue
    let T = null
    if (m[1] !== undefined) T = Number(m[1]) * 60 + Number(m[2])
    else if (m[4] !== undefined) T = Number(m[4]) * 60 + Number(m[5])
    else {
      const v = Number(m[3])
      const mm = Math.floor(v / 100)
      const ss = v % 100
      if (mm <= 59 && ss <= 59) T = mm * 60 + ss
    }
    if (T === null || T > duration) continue
    const dist = Math.abs(T - d.t)
    if (dist < 30 || dist > 600) continue
    out.push({ from: Math.max(0, Math.min(d.t, T) - 15), to: Math.min(duration, Math.max(d.t, T) + 15) })
  }
  return out
}

// 片头强信号：开头 90s 内接广类弹幕 → 0-60s 片头广告
export function headSignal(ctx, kw) {
  const { danmaku } = ctx
  const headStrong = danmaku.filter((d) => d.t < 90 && kw.strong.test(d.text))
  return headStrong.length ? [{ from: 0, to: 60 }] : []
}

// 消费回溯：已下单/买了 → 之前 60s 为广告口播（原 120s 太激进，把正常内容也回溯进广告段）
export function buySignal(ctx, kw) {
  const { danmaku, duration } = ctx
  return danmaku
    .filter((d) => kw.buy.test(d.text))
    .map((h) => ({ from: Math.max(0, h.t - 60), to: Math.min(duration, h.t + 20) }))
}
