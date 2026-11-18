// lib/signals/subtitle.mjs — 台词族两路广告信号源（字幕关键词 + 字幕句式）
//
// 不依赖弹幕，是「无弹幕平台」（本地 / URL）的广告识别主力；B 站有字幕时也参与。
// 数据来自 ctx.subLines（字幕或转写台词行 [{ from, content }]）。

// 共享：把命中台词行按时间聚类成段，按 kind 区分门槛。
//   pattern（精确句式）≥2 命中即可；keyword（泛词，正文吐槽/举例易误伤）需 ≥3 命中或持续 ≥30s。
function subSpans(subLines, regex, kind, duration) {
  const minCount = kind === 'pattern' ? 2 : 3
  const minSpan = kind === 'pattern' ? 10 : 30
  const subHits = subLines.filter((l) => regex.test(l.content)).map((l) => Number(l.from) || 0)
  const spans = []
  for (const tt of subHits.sort((a, b) => a - b)) {
    const last = spans[spans.length - 1]
    if (last && tt - last.to <= 60) last.to = tt
    else spans.push({ from: tt, to: tt })
  }
  const out = []
  for (const sp of spans) {
    const count = subHits.filter((x) => x >= sp.from && x <= sp.to).length
    if (count >= minCount || sp.to - sp.from >= minSpan) {
      out.push({ from: Math.max(0, sp.from - 15), to: Math.min(duration, sp.to + 30), subAd: true, subKind: kind })
    }
  }
  return out
}

// 字幕关键词（下单/链接/优惠/购买…）
export function subKeywordSignal(ctx, kw) {
  const { subLines, duration } = ctx
  if (!subLines?.length) return []
  return subSpans(subLines, kw.sub, 'keyword', duration)
}

// 字幕句式（点击下方/领券/下单立减…）
export function subPatternSignal(ctx, kw) {
  const { subLines, duration } = ctx
  if (!subLines?.length) return []
  return subSpans(subLines, kw.pattern, 'pattern', duration)
}
