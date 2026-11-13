// 批量处理核心：把多条 BV / 本地文件 / URL 交给同一个 runner 跑。
// 纯逻辑：不读文件系统、不起子进程、不碰网络、零第三方依赖。
// 文件是否存在、视频能不能解析，统一交给调用方传入的 runner 判断——
// 这样 parseBatchList 是可测的纯函数，批量流程也能在单测里跑完。
//
// 典型接法（后续 batch 子命令）：
//   const { items, errors } = parseBatchList(text)
//   // errors 先报给用户，items 再进 runBatch
//   const summary = await runBatch(items, (item) => runOne(item, opts), {
//     concurrency: 2,
//     onItem: (item, i) => console.log(`[${i + 1}/${items.length}] ${item.value}`)
//   })
//   console.log(formatBatchReport(summary))

// BV 号：BV + 10 位字母数字（与 fisheye.mjs 入口校验保持一致）
const BV_RE = /^BV[0-9A-Za-z]{10}$/
const URL_RE = /^https?:\/\//i
// Windows 盘符：C:\ / C:/ / 裸 C:
const DRIVE_RE = /^[A-Za-z]:(?:[\\/]|$)/
// 常见视频扩展名（URL 已在前面单独判定，这里只看裸文件名）
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|webm)$/i

// 路径形态判断（纯字符串，不看磁盘）
function looksLikeFile(s) {
  if (DRIVE_RE.test(s)) return true
  if (s.startsWith('\\\\') || s.startsWith('//')) return true // UNC \\server\share
  if (s.startsWith('./') || s.startsWith('.\\') || s.startsWith('../') || s.startsWith('..\\')) return true
  if (s.startsWith('/')) return true
  if (VIDEO_EXT_RE.test(s)) return true // 裸文件名：video.mp4
  if (/[\\/]/.test(s)) return true // 含路径分隔符
  return false
}

function classify(value) {
  if (BV_RE.test(value)) return 'bv'
  if (URL_RE.test(value)) return 'url'
  if (looksLikeFile(value)) return 'file'
  return null
}

// 统一成「物理行」数组：字符串直接按行拆；数组每项再按行拆（一项多行也认）
function toLines(input) {
  if (typeof input === 'string') return input.split(/\r?\n/)
  if (!Array.isArray(input)) return null
  const out = []
  for (const entry of input) {
    if (entry === null || entry === undefined) continue
    out.push(...String(entry).split(/\r?\n/))
  }
  return out
}

/**
 * 解析批量输入。
 * 每行 trim 后：空行 / `#` 开头的注释行跳过；BV 号 → bv；http(s):// → url；
 * 像文件路径（盘符/UNC/相对路径/含分隔符/视频扩展名）→ file；其余进 errors。
 * @param {string|string[]} input 多行文本，或每项一行的数组
 * @returns {{ items: Array<{kind:'bv'|'file'|'url', value:string}>,
 *             errors: Array<{line:number, raw:string, reason:string}> }}
 */
export function parseBatchList(input) {
  const lines = toLines(input)
  // 类型不对时也走 errors，不要抛异常——CLI 层还要把错误列给用户看
  if (lines === null) {
    return {
      items: [],
      errors: [{ line: 0, raw: String(input ?? ''), reason: '批量清单必须是字符串或数组' }]
    }
  }
  const items = []
  const errors = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const value = raw.trim()
    if (value === '' || value.startsWith('#')) continue
    const kind = classify(value)
    if (kind) items.push({ kind, value })
    else errors.push({ line: i + 1, raw: value, reason: '无法识别：既不是 BV 号、URL，也不是视频文件路径' })
  }
  return { items, errors }
}

const nowMs = () => performance.now()

function errorText(error) {
  if (error instanceof Error) return error.message || error.name || '未知错误'
  if (typeof error === 'string') return error
  if (error === null || error === undefined) return '未知错误'
  try {
    const s = JSON.stringify(error)
    return s === undefined ? String(error) : s
  } catch {
    return String(error) // 循环引用、BigInt 之类
  }
}

async function runOne(item, runner) {
  const started = nowMs()
  try {
    const result = await runner(item)
    return { item, ok: true, result, ms: Math.round(nowMs() - started) }
  } catch (error) {
    return { item, ok: false, error: errorText(error), ms: Math.round(nowMs() - started) }
  }
}

function normalizeConcurrency(value, total) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, total)
}

/**
 * 批量执行：串行或简单并发池；单项失败只记录，不中断整体。
 * 结果顺序始终与 items 一致（并发完成顺序不回写结果顺序）。
 * onItem 在每项 runner 之前调用，抛错会中断整批（进度回调不该抛错）。
 * @param {Array} items parseBatchList().items 或任意可迭代项
 * @param {(item:any, index:number)=>Promise<any>} runner 单条处理逻辑
 * @param {{concurrency?:number, onItem?:null|((item:any, index:number)=>any)}} [options]
 * @returns {Promise<{results: Array<{item:any, ok:boolean, result?:any, error?:string, ms:number}>,
 *                    total:number, ok:number, failed:number}>}
 */
export async function runBatch(items, runner, { concurrency = 1, onItem = null } = {}) {
  if (!Array.isArray(items)) throw new TypeError('runBatch: items 必须是数组')
  if (typeof runner !== 'function') throw new TypeError('runBatch: runner 必须是函数')
  if (onItem !== null && typeof onItem !== 'function') throw new TypeError('runBatch: onItem 必须是函数或 null')

  const total = items.length
  if (total === 0) return { results: [], total: 0, ok: 0, failed: 0 }

  const limit = normalizeConcurrency(concurrency, total)
  const results = new Array(total)
  let next = 0

  // 简单并发池：limit 个 worker 抢同一个游标，谁空谁取下一个
  async function worker() {
    for (;;) {
      const index = next++
      if (index >= total) return
      const item = items[index]
      if (onItem) await onItem(item, index)
      results[index] = await runOne(item, runner)
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()))

  const ok = results.reduce((n, r) => n + (r.ok ? 1 : 0), 0)
  return { results, total, ok, failed: total - ok }
}

// 报告里的耗时：按 ms 展示，超过 1 秒给一位小数，超过 1 分钟给 XmYs
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) {
    const s = Math.round(ms / 100) / 10
    return s >= 60 ? '1m0s' : `${s.toFixed(1)}s`
  }
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return s === 60 ? `${m + 1}m0s` : `${m}m${s}s`
}

function describeItem(item) {
  if (!item || typeof item !== 'object') return String(item)
  const value = item.value ?? ''
  return item.kind ? `[${item.kind}] ${value}` : String(value)
}

/**
 * 生成人类可读的汇总文本（不含尾随换行，方便 console.log 直接用）。
 * 耗时取 results 里各条 ms 之和（并发时是累计值，不是墙钟时间）。
 * @param {object} summary runBatch() 的返回值
 * @returns {string}
 */
export function formatBatchReport(summary) {
  const results = Array.isArray(summary?.results) ? summary.results : []
  const total = Number.isFinite(summary?.total) ? summary.total : results.length
  const ok = Number.isFinite(summary?.ok) ? summary.ok : results.filter((r) => r?.ok).length
  const failed = Number.isFinite(summary?.failed) ? summary.failed : Math.max(0, total - ok)
  const spent = results.reduce((sum, r) => sum + (Number.isFinite(r?.ms) ? r.ms : 0), 0)

  const lines = [`批量处理：共 ${total} 条，成功 ${ok} 条，失败 ${failed} 条，耗时合计 ${formatDuration(spent)}`]
  if (failed > 0) {
    lines.push('失败明细：')
    const failures = results.filter((r) => r && !r.ok)
    if (failures.length === 0) lines.push('  （没有明细）')
    else failures.forEach((r, i) => lines.push(`  ${i + 1}. ${describeItem(r.item)} —— ${r.error ?? '未知错误'}`))
  }
  return lines.join('\n')
}
