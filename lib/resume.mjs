// 断点续跑：manifest 是唯一真相源。
//
// 长视频最贵的两步是「下载」和「抽帧」，而它们都能「重来一半」：
//   · 下载：cache 里的 mp4 还在 → 跳过
//   · 抽帧：out/ 里的拼图还在 → 已抽的图不用重抽，只补缺的
//   · 精读/字幕带同理，用 stages 记录状态即可
//
// 不接 CLI、不接 auto：这里只提供纯函数 + 原子写回，由 fisheye.mjs/stages.mjs
// 在阶段边界调用。接口故意做成「state 进、state 出」，方便链式调用和单测。
//
// manifest 的拼图数组兼容两种写法（读时归一化，写回时不改字段名，不破坏旧消费方）：
//   新：state.grids  = [{ file, from, to, grid }]
//   旧：state.chunks = [{ sheet, from, to, grid }]   ← stageGrid 目前写的是这个
//   也可能叫 images / 字符串数组。
import fs from 'node:fs'
import path from 'node:path'

// 记住 state 是从哪个目录、哪个 bvid 读出来的（Symbol 键不会被 JSON.stringify 写进 manifest）。
// 这样 recordStage(state, ...) 就能自己原子写回，调用方不用到处传 outDir/bvid。
const SRC = Symbol('fisheye.manifest.source')

// 挂在 state 上的「来历」：不可枚举，deepEqual / JSON.stringify 都不会被它干扰
function setSource(state, outDir, bvid) {
  Object.defineProperty(state, SRC, { value: { outDir, bvid }, enumerable: false, writable: true, configurable: true })
}

// 阶段名 → 中文；未知阶段原样显示
const STAGE_LABEL = {
  download: '下载',
  grids: '抽帧',
  subs: '字幕带',
  refine: '精读',
  audio: '音频转写',
  danmaku: '弹幕',
  ocr: 'OCR',
}

const STATUS_LABEL = {
  done: '已完成',
  running: '进行中',
  failed: '失败',
  skipped: '已跳过',
  pending: '未开始',
}

const stageLabel = (name) => STAGE_LABEL[name] ?? name

/** `out/<bvid>-manifest.json` */
export function manifestPath(outDir, bvid) {
  return path.join(outDir, `${bvid}-manifest.json`)
}

/**
 * 读 manifest。不存在 / JSON 坏 / 不是对象 → null（坏文件不该拦住续跑流程，调用方自行决定重跑）。
 * @returns {object|null}
 */
export function loadManifestState(outDir, bvid) {
  let raw
  try { raw = fs.readFileSync(manifestPath(outDir, bvid), 'utf8') } catch { return null }
  let state
  try {
    state = JSON.parse(raw.replace(/^\uFEFF/, ''))   // 兼容 PowerShell/记事本写的 BOM
  } catch { return null }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null
  setSource(state, outDir, bvid)
  return state
}

/**
 * 原子写回：同目录临时文件 → rename。
 * Windows 上 fs.renameSync 是替换语义（MoveFileEx），目标已存在也能覆盖；
 * 写一半断电时正式文件仍是旧的完整版本，不会留下半截 JSON。
 * @returns {string} manifest 路径
 */
export function saveManifest(outDir, bvid, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('saveManifest: state 必须是对象')
  }
  if (!bvid) throw new TypeError('saveManifest: bvid 不能为空')
  fs.mkdirSync(outDir, { recursive: true })
  const file = manifestPath(outDir, bvid)
  const tmp = path.join(outDir, `.${bvid}-manifest.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
  setSource(state, outDir, bvid)
  return file
}

// ---- manifest 内部结构的归一化 ----

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** '01:05' / '1:05:30' / 65 → 秒；非法 → null（不走 util.parseTime：那条路会 process.exit） */
function parseClock(v) {
  const n = num(v)
  if (n !== null) return n
  const parts = String(v ?? '').trim().split(':').map((s) => Number(s))
  if (parts.length < 2 || parts.length > 3 || parts.some((x) => !Number.isFinite(x) || x < 0)) return null
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2]
}

/** 拼图数组：grids → images → chunks（不做拷贝，只返回引用） */
function gridsOf(state) {
  for (const key of ['grids', 'images', 'chunks']) {
    if (Array.isArray(state?.[key])) return state[key]
  }
  return []
}

/** 单张拼图的文件路径 */
function fileOf(g) {
  if (typeof g === 'string') return g
  if (!g || typeof g !== 'object') return null
  return g.file ?? g.sheet ?? g.path ?? g.image ?? g.sheetPath ?? g.sheetFile ?? null
}

/** 单张拼图的时间范围 {from,to}；无法解析 → null */
function rangeOf(g) {
  if (!g || typeof g !== 'object') return null
  const from = parseClock(g.from ?? g.start)
  const to = parseClock(g.to ?? g.end)
  if (from !== null && to !== null) return { from, to }
  if (typeof g.range === 'string') {
    // manifest 里 range 是 '00:00-05:00' 这种展示字符串
    const m = /^\s*([\d:.]+)\s*-\s*([\d:.]+)\s*$/.exec(g.range)
    if (m) {
      const a = parseClock(m[1])
      const b = parseClock(m[2])
      if (a !== null && b !== null) return { from: a, to: b }
    }
  }
  return null
}

function existsNonEmpty(file) {
  try {
    const st = fs.statSync(file)
    return st.isFile() && st.size > 0
  } catch { return false }
}

function fmtSec(sec) {
  const s = Number(sec)
  if (!Number.isFinite(s) || s < 0) return '?'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`
}

/** 区间补齐默认值：from 缺省 0，to 缺省「片尾」。dur=Infinity 表示时长未知 */
function normRange(obj, dur) {
  const fromRaw = obj?.from
  const toRaw = obj?.to
  const from = fromRaw === undefined || fromRaw === null ? 0 : num(fromRaw)
  const to = toRaw === undefined || toRaw === null ? dur : num(toRaw)
  return {
    from: from !== null ? from : 0,
    to: to !== null ? to : dur,
  }
}

function sameRange(a, b) {
  const close = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) <= 1 : x === y)
  return close(a.from, b.from) && close(a.to, b.to)
}

const rangeText = (r) => `${fmtSec(r.from)}-${Number.isFinite(r.to) ? fmtSec(r.to) : '片尾'}`

function intersects(g, r) {
  const gr = rangeOf(g)
  if (!gr) return true   // 旧数据看不出范围时不排除，宁可多算一张「可复用」
  const toA = Number.isFinite(r.to) ? r.to : Infinity
  const toB = Number.isFinite(gr.to) ? gr.to : Infinity
  return Math.max(gr.from, r.from) < Math.min(toA, toB)
}

const pick = (...vals) => {
  for (const v of vals) if (v !== undefined && v !== null) return v
  return null
}

/**
 * 判断旧 manifest 能不能复用。
 *
 * @param {object|null} state  loadManifestState 的返回值
 * @param {{plan?: {budget?:number, density?:number, from?:number, to?:number}}} opts
 * @returns {{resumable: boolean, reason: string, doneGrids: number}}
 *
 * 判定顺序（先便宜的先判）：
 *   1. manifest 存在且是对象
 *   2. 计划参数一致：只比调用方明确给出的 budget / density；
 *      manifest 没记录就判不可复用（宁可重抽，也别用不同密度的图冒充本次结果）
 *   3. 时间区间一致（容差 1s，manifest 里存的是 toFixed(1)）
 *   4. 拼图文件还在：一张都用不了 → 不可复用；部分缺失 → 可复用、只补缺的
 */
export function canResume(state, { plan } = {}) {
  const no = (reason, doneGrids = 0) => ({ resumable: false, reason, doneGrids })
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return no('没有可复用的 manifest（这个视频还没跑过）')
  }

  const given = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {}
  const rec = state.plan && typeof state.plan === 'object' && !Array.isArray(state.plan) ? state.plan : {}
  // 老 manifest 没有 plan 对象时，兼容直接写在顶层的字段
  const recorded = {
    budget: pick(rec.budget, state.budget),
    density: pick(rec.density, state.density),
    from: pick(rec.from, state.range?.from),
    to: pick(rec.to, state.range?.to),
  }

  // 1) budget / density：undefined / null 表示「调用方不关心这个维度」
  for (const key of ['budget', 'density']) {
    const want = given[key]
    if (want === undefined || want === null) continue
    const had = recorded[key]
    if (had === null) {
      return no(`manifest 里没有记录 ${key}，无法确认计划参数是否一致；要复用请重跑或手动补 plan`)
    }
    if (Number(want) !== Number(had)) {
      return no(`计划参数变了：${key} ${had} → ${want}（旧拼图的时间/密度和新计划对不上，抽帧不能跳过）`)
    }
  }

  // 2) 时间区间
  const hasPlanRange = given.from !== undefined || given.to !== undefined
  const dur = Number.isFinite(Number(state.duration)) ? Number(state.duration) : Infinity
  let wantRange = null
  if (hasPlanRange) {
    wantRange = normRange(given, dur)
    const hadRange = normRange(recorded, dur)
    if (!sameRange(wantRange, hadRange)) {
      return no(`时间区间变了：${rangeText(hadRange)} → ${rangeText(wantRange)}（时间轴不同，旧拼图拼不进这次结果）`)
    }
  }

  // 3) 拼图文件
  const all = gridsOf(state)
  if (!all.length) return no('manifest 里没有拼图记录（grids/images/chunks 为空），没有可跳过的东西')
  const scoped = wantRange ? all.filter((g) => intersects(g, wantRange)) : all
  if (!scoped.length) return no('计划区间内没有已记录的拼图')

  const paths = scoped.map(fileOf)
  const usable = paths.filter((f) => f && existsNonEmpty(f)).length
  const missing = scoped.length - usable
  if (!usable) {
    return no(`拼图文件全部缺失（0/${scoped.length}），抽帧需要从头来`, 0)
  }
  if (missing > 0) {
    return {
      resumable: true,
      reason: `可复用 ${usable}/${scoped.length} 张拼图，补抽 ${missing} 张即可`,
      doneGrids: usable,
    }
  }
  return {
    resumable: true,
    reason: `拼图齐全（${usable}/${scoped.length}），可跳过抽帧`,
    doneGrids: usable,
  }
}

function persist(state) {
  const src = state[SRC] ?? (state.outDir && state.bvid ? { outDir: state.outDir, bvid: state.bvid } : null)
  if (!src?.outDir || !src?.bvid) return false
  saveManifest(src.outDir, src.bvid, state)
  return true
}

/**
 * 记录阶段进度，并在能定位到 manifest 时原子写回。
 * @param {object} state
 * @param {string} stage   'download' | 'grids' | 'subs' | 'refine' | ...
 * @param {object|string} [info]  对象（会合并进阶段记录）或字符串状态（'done' / 'running'）
 * @returns {object} 同一个 state（方便链式调用）
 */
export function recordStage(state, stage, info = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('recordStage: state 必须是对象')
  }
  const name = String(stage ?? '').trim()
  if (!name) throw new TypeError('recordStage: stage 必须是非空字符串')

  const patch = info === null || info === undefined
    ? {}
    : typeof info === 'string'
      ? { status: info }
      : typeof info === 'object'
        ? { ...info }
        : {}

  if (!state.stages || typeof state.stages !== 'object' || Array.isArray(state.stages)) state.stages = {}
  const prev = state.stages[name] && typeof state.stages[name] === 'object' && !Array.isArray(state.stages[name])
    ? state.stages[name]
    : {}
  const status = String(patch.status ?? prev.status ?? 'running')
  const now = new Date().toISOString()
  const next = { ...prev, ...patch, status, at: now }
  if (status === 'done') next.doneAt = now
  state.stages[name] = next
  state.updatedAt = now
  persist(state)
  return state
}

/** 标记阶段完成（等价于 recordStage(state, stage, { ...info, status: 'done' })） */
export function markDone(state, stage, info = {}) {
  const extra = info && typeof info === 'object' && !Array.isArray(info) ? info : {}
  return recordStage(state, stage, { ...extra, status: 'done' })
}

/**
 * 人类可读摘要：哪些阶段到哪了、拼图还差几张、什么可以跳过。
 * @returns {string} 多行文本（没有 manifest 时返回一句说明）
 */
export function resumeSummary(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return '没有 manifest：还没有可续跑的进度'
  }
  const dur = Number.isFinite(Number(state.duration)) ? Number(state.duration) : Infinity
  const lines = []

  const head = [state.bvid ?? '未知视频']
  if (state.title) head.push(String(state.title))
  if (state.range) head.push(`区间 ${rangeText(normRange(state.range, dur))}`)
  lines.push(head.join(' · '))

  const entries = state.stages && typeof state.stages === 'object' && !Array.isArray(state.stages)
    ? Object.entries(state.stages)
    : []
  if (entries.length) {
    const parts = entries.map(([k, v]) => {
      const status = typeof v === 'string' ? v : (v?.status ?? 'unknown')
      return `${stageLabel(k)} ${STATUS_LABEL[status] ?? status}`
    })
    lines.push(`阶段：${parts.join(' · ')}`)
  }

  const grids = gridsOf(state)
  const files = grids.map(fileOf).filter(Boolean)
  let allGridsOk = false
  if (files.length) {
    const ok = files.filter(existsNonEmpty).length
    allGridsOk = ok === files.length
    lines.push(`拼图：${ok}/${files.length} 张可用${allGridsOk ? '（可跳过抽帧）' : `（缺 ${files.length - ok} 张，需补抽）`}`)
  }

  const plan = state.plan && typeof state.plan === 'object' && !Array.isArray(state.plan) ? state.plan : {}
  const bits = []
  const budget = pick(plan.budget, state.budget)
  const density = pick(plan.density, state.density)
  if (budget !== null) bits.push(`budget ${budget}`)
  if (density !== null) bits.push(`density ${density}s`)
  if (bits.length) lines.push(`计划：${bits.join(' · ')}`)

  const skippable = []
  for (const [k, v] of entries) {
    const status = typeof v === 'string' ? v : v?.status
    if (status === 'done') skippable.push(stageLabel(k))
  }
  if (allGridsOk && !skippable.includes(stageLabel('grids'))) skippable.push(stageLabel('grids'))
  lines.push(`可跳过：${skippable.length ? skippable.join('、') : '无'}`)

  const stamp = state.updatedAt ?? state.createdAt
  if (stamp) lines.push(`更新：${stamp}`)

  return lines.join('\n')
}
