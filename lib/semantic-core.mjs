// lib/semantic-core.mjs — 语义切分核心（纯 JS，零 python / 零 npm）
//
// 这是语义模块的「无 python 降级路径」：当探测不到 python + fastembed 时，
// 用字符 bigram 词频向量做语义漂移检测，切出话题切换点。
//
// 质量定位（诚实说明）：char-bigram 是词法近似，语义区分度弱于 bge-small-zh embedding；
// 它是「能跑」的兜底，不是「和 embedding 一样准」的替代。想要高质量语义切分，
// 仍然建议装 python（fastembed）或用 onnxruntime-node（方案 B）。
//
// 输出契约与 semantic/cli.py 一致：{ segments: [{t, confidence, signals}], suggestions: [...] }
// 供 lib/semantic.mjs 的 semanticSegment 兜底调用。

// 字符 bigram 词频向量（过滤空白，按 Unicode 码点切字）
export function charBigramVector(text) {
  const m = new Map()
  const chars = Array.from(String(text ?? '')).filter((c) => c.trim() !== '')
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i] + chars[i + 1]
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}

// 稀疏向量余弦相似度（a、b 都是 Map<bigram, count>）
export function cosine(a, b) {
  let dot = 0
  let na = 0
  for (const [k, v] of a) {
    dot += v * (b.get(k) || 0)
    na += v * v
  }
  let nb = 0
  for (const v of b.values()) nb += v * v
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}

// 把台词行按累计字符数分块（短行合并、长行自成块），减少逐行 bigram 的稀疏噪声
export function chunkLines(lines, charTarget = 80) {
  const chunks = []
  let buf = []
  let t = 0
  let len = 0
  for (const l of lines) {
    const text = String(l?.text ?? '')
    if (!buf.length) t = Number(l?.t) || 0
    buf.push(text)
    len += text.length
    if (len >= charTarget) {
      chunks.push({ t, text: buf.join('') })
      buf = []
      len = 0
    }
  }
  if (buf.length) chunks.push({ t, text: buf.join('') })
  return chunks
}

// drift 序列上取 top-k 峰值，且任意两个切点间隔 ≥ minGap 个块
export function topKPeaks(drift, k, minGap = 2) {
  const cands = drift
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d - a.d)
  const picked = []
  for (const { i } of cands) {
    if (picked.every((p) => Math.abs(p - i) >= minGap)) {
      picked.push(i)
      if (picked.length >= k) break
    }
  }
  return picked.sort((a, b) => a - b)
}

const pyRound = (x, d) => Math.round(x * 10 ** d) / 10 ** d

/**
 * 纯 JS 语义切分：台词 → 话题切换点。
 * @param {Array<{t:number, text:string}>} lines 带时间戳台词行
 * @param {{nBkps?:number, charTarget?:number}} opts
 * @returns {{segments:Array, suggestions:Array}}
 */
export function segmentPureJs(lines, opts = {}) {
  const clean = (Array.isArray(lines) ? lines : [])
    .filter((l) => l && String(l.text ?? '').trim())
  if (clean.length < 8) return { segments: [], suggestions: [] }

  const chunks = chunkLines(clean, opts.charTarget ?? 80)
  if (chunks.length < 3) return { segments: [], suggestions: [] }

  const vecs = chunks.map((c) => charBigramVector(c.text))
  const drift = []
  for (let i = 0; i < vecs.length - 1; i++) {
    drift.push(1 - cosine(vecs[i], vecs[i + 1]))
  }

  const nBkps = Math.max(1, Math.min(opts.nBkps ?? 5, chunks.length - 1))
  const idxs = topKPeaks(drift, nBkps, 2)

  const segments = idxs.map((i) => {
    // 切点在块 i 与 i+1 之间，时间取块 i+1 的第一行时间
    const t = chunks[i + 1].t
    const conf = pyRound(Math.max(0, Math.min(1, drift[i])), 3)
    return { t, confidence: conf, signals: ['lexical', 'change'] }
  })

  const suggestions = segments.map((s) => ({
    t: s.t,
    reason: `话题切换（词法漂移，置信度 ${s.confidence}）`,
    confidence: s.confidence,
    source: 'semantic',
    kind: 'structural',
  }))

  return { segments, suggestions }
}
