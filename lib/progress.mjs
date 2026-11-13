// 进度反馈：长视频抽帧/下载动辄几分钟，不给进度就像卡死。
//
// 设计约束：
// · 默认写 stderr —— stdout 留给机器可读结果（MANIFEST/SHEET/JSON），别混在一起
// · TTY 单行覆盖（\r），非 TTY（重定向到文件/管道）每次换行，否则日志会变成一坨
// · --quiet 用 enabled:false 整体静默，但 elapsed() 仍然准确（耗时统计不受影响）
// · stream 可注入：测试用假 stream 收集输出，不用去 patch process.stderr

export const isTTYStream = (stream) => Boolean(stream && stream.isTTY)

/** 毫秒 → 人类可读时长：300ms / 1.5s / 2m3s / 1h2m3s */
export function humanDuration(ms) {
  let n = Number(ms)
  if (!Number.isFinite(n) || n < 0) n = 0
  if (n < 1000) return `${Math.round(n)}ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`
  const totalSec = Math.round(n / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h ? `${h}h${m}m${s}s` : `${m}m${s}s`
}

/** 安全写入：终端已关闭（EPIPE）不该炸掉整个抽帧流程 */
function safeWrite(stream, text) {
  if (typeof stream?.write !== 'function') return
  try { stream.write(text) } catch { /* 忽略写失败 */ }
}

/**
 * 进度条。返回 { tick(n=1), set(done), done(), fail(msg), elapsed() }
 *
 * @param {string} label  前缀，如 '抽帧'
 * @param {number} total  总数；<=0 / 非数字表示「总数未知」，只显示已计数
 * @param {{stream?: {write: Function, isTTY?: boolean}, enabled?: boolean}} opts
 */
export function createProgress(label, total, { stream = process.stderr, enabled = true } = {}) {
  const t0 = Date.now()
  const rawTotal = Number(total)
  const totalN = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 0
  const tty = isTTYStream(stream)
  let done = 0
  let dirty = false   // TTY 下屏幕上是否已有一行「没换行」的进度
  let ended = false

  const clamp = (n) => {
    const v = Number(n)
    if (!Number.isFinite(v) || v < 0) return 0
    return totalN ? Math.min(v, totalN) : v
  }
  const text = () => {
    const base = `[${label}] `
    if (!totalN) return `${base}${done}`
    const pct = Math.min(100, Math.floor((done / totalN) * 100))
    return `${base}${done}/${totalN} (${pct}%)`
  }
  const render = () => {
    if (!enabled) return
    if (tty) {
      safeWrite(stream, `\r${text()}`)
      dirty = true
    } else {
      safeWrite(stream, `${text()}\n`)
      dirty = false
    }
  }
  const closeLine = () => {
    if (dirty) {
      safeWrite(stream, '\n')
      dirty = false
    }
  }

  const api = {
    tick(n = 1) {
      if (ended) return api
      const step = Number(n)
      done = clamp(done + (Number.isFinite(step) ? step : 1))
      render()
      return api
    },
    set(n) {
      if (ended) return api
      done = clamp(n)
      render()
      return api
    },
    done() {
      if (!ended) {
        done = totalN || done
        if (enabled) {
          render()
          closeLine()
        }
        ended = true
      }
      return api.elapsed()
    },
    fail(msg) {
      if (!ended) {
        if (enabled) {
          if (tty && dirty) {
            // 覆盖当前行，失败原因和停在哪一帧一起显示，方便直接定位
            safeWrite(stream, `\r${text()} 失败：${msg}\n`)
            dirty = false
          } else {
            closeLine()
            safeWrite(stream, `[${label}] 失败：${msg}\n`)
          }
        }
        ended = true
      }
      return api.elapsed()
    },
    elapsed() {
      return Number(((Date.now() - t0) / 1000).toFixed(1))
    },
  }
  return api
}

/**
 * 阶段计时器。stop() 输出 `[label] 用时 3.2s`，返回秒数（重复 stop 只输出一次）。
 * @param {string} label
 * @param {{stream?: {write: Function, isTTY?: boolean}, enabled?: boolean}} opts
 */
export function stageTimer(label, { stream = process.stderr, enabled = true } = {}) {
  const t0 = Date.now()
  let stopped = false
  return {
    stop() {
      const ms = Date.now() - t0
      if (!stopped) {
        stopped = true
        if (enabled) safeWrite(stream, `[${label}] 用时 ${humanDuration(ms)}\n`)
      }
      return Number((ms / 1000).toFixed(1))
    },
  }
}
