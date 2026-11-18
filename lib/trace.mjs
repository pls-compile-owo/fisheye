// 调试 trace：FISHEYE_TRACE=1 时记录各阶段耗时与决策点，写入 out/<id>-trace.json
// 设计约束：
// · 默认关闭、零开销（未开启时所有函数近乎 no-op）
// · 只写 stderr 与文件，绝不污染 stdout（stdout 是给 agent 读的结果）
// · 阶段名稳定（集成测试会断言这些阶段出现）
import fs from 'node:fs'
import path from 'node:path'
import { OUT } from './env.mjs'

const ENABLED = process.env.FISHEYE_TRACE === '1' || process.env.FISHEYE_TRACE === 'true'

/** 当前 trace 是否开启。 */
export function traceEnabled() {
  return ENABLED
}

let sink = null // 收集的阶段记录
let currentId = 'run'

/** 开始一次 trace（每个命令调用一次）。 */
export function traceStart(id) {
  currentId = String(id || 'run').replace(/[^\w.-]/g, '_')
  sink = ENABLED ? [] : null
}

/** 记录一个已完成的阶段（耗时来自 performance.now）。 */
export function tracePhase(name, ms, extra) {
  if (!sink) return
  sink.push({ phase: name, ms: Math.round(ms * 10) / 10, ...(extra ?? {}) })
}

/** 记录一个决策点（无耗时，只有原因/数值）。 */
export function traceNote(name, detail) {
  if (!sink) return
  sink.push({ note: name, detail })
}

/** 包住一个 async/sync 函数并记录耗时；返回值透传。 */
export async function traceWrap(name, fn, extra) {
  if (!ENABLED) return fn()
  const t0 = performance.now()
  try {
    const v = await fn()
    tracePhase(name, performance.now() - t0, extra)
    return v
  } catch (e) {
    tracePhase(`${name}.error`, performance.now() - t0, { ...(extra ?? {}), error: String(e?.message ?? e).slice(0, 200) })
    throw e
  }
}

/** 把收集到的阶段写成 out/<id>-trace.json 并打印一行摘要。 */
export function traceFinish(ok = true) {
  if (!sink) return null
  const total = sink.reduce((a, s) => a + (s.ms ?? 0), 0)
  const file = path.join(OUT, `${currentId}-trace.json`)
  try {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ id: currentId, ok, totalMs: Math.round(total), phases: sink }, null, 2), 'utf8')
    console.error(`[trace] ${Math.round(total)}ms 共 ${sink.length} 项 → ${file}`)
    return file
  } catch (e) {
    console.error(`[trace] 写入失败：${String(e?.message ?? e).slice(0, 120)}`)
    return null
  }
}
