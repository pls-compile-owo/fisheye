// 带「重试 + 指数退避」的 fetch 封装（零依赖，只用 Node >= 18 内置能力）
//
// 背景：lib/bili.mjs 里的 B站请求都是幂等 GET，但原来是裸 fetch——网络抖动 / 429 限流 /
// 网关 5xx 一次失败就让整条命令直接挂掉（getView 抛错、ensureMp4 失败、字幕静默降级）。
// 这里统一加一层重试，调用点只把 fetch 换成 fetchWithRetry，不改各函数的签名和返回值。
//
// 策略：
// · 只重试可安全重复的失败：网络错误 / 超时 / HTTP 5xx / 429。
// · 其余 4xx（鉴权失效、参数错、资源不存在）是确定性失败，重试没有意义，直接把 Response 交给调用方。
// · 退避 delay = baseDelayMs * 2^attempt + 随机 jitter；429/503 若带 Retry-After 头则优先听它的
//   （仍受 MAX_BACKOFF_MS 上限约束，避免被服务端要求等几小时）。
// · 每次尝试都新建独立的超时 signal：AbortSignal.timeout() 触发后不可复用，跨 attempt 复用会让
//   第二次重试瞬间失败。外部 AbortController 的 signal 则跨 attempt 保持生效（用于用户主动取消）。
// · 返回原生 Response，调用方照常 .json() / .text() / .arrayBuffer() 消费。

const DEFAULT_RETRIES = 2
const DEFAULT_BASE_DELAY_MS = 500
const MAX_BACKOFF_MS = 30_000

// undici 的网络错误会包一层 TypeError('fetch failed')，真正的 code 在 err.cause 里
const NETWORK_ERROR_RE = /fetch failed|network error|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR|socket hang up|terminated|other side closed|connection (?:reset|closed|refused)|getaddrinfo/i

/** 5xx 和 429 可以重试；其余状态码（含 3xx/4xx）不重试 */
export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

/** 判断 signal 是否因「超时」而 abort（AbortSignal.timeout 的 reason 是 TimeoutError） */
function isTimeoutAbort(signal) {
  const reason = signal?.reason
  if (!reason) return false
  return reason.name === 'TimeoutError' || reason.code === 23 || /timeout/i.test(String(reason.message ?? ''))
}

/** 判断错误是否为可重试的瞬时网络错误（超时单独由 signal 判定，这里也兼容直接抛出的 TimeoutError） */
export function isTransientNetworkError(err) {
  if (!err) return false
  const name = String(err.name ?? '')
  if (name === 'TimeoutError') return true
  if (name === 'AbortError') return false // 外部取消由调用方判定，这里不盲目重试
  const msg = [
    err.message,
    err.cause?.message,
    err.cause?.code,
    err.code,
  ].filter(Boolean).join(' ')
  return NETWORK_ERROR_RE.test(msg)
}

/** 组合外部取消信号与本次尝试的超时信号（Node 18.17+ 用 AbortSignal.any，更早版本手动转发） */
function combineSignals(external, timeoutSignal) {
  if (!external) return timeoutSignal
  if (!timeoutSignal) return external
  if (typeof AbortSignal.any === 'function') {
    try { return AbortSignal.any([external, timeoutSignal]) } catch { /* 参数异常时走下面的回退 */ }
  }
  const ctrl = new AbortController()
  const forward = (src) => () => {
    cleanup()
    ctrl.abort(src.reason ?? new DOMException('This operation was aborted', 'AbortError'))
  }
  const onExternal = forward(external)
  const onTimeout = forward(timeoutSignal)
  function cleanup() {
    external.removeEventListener('abort', onExternal)
    timeoutSignal.removeEventListener('abort', onTimeout)
  }
  if (external.aborted) { onExternal(); return ctrl.signal }
  if (timeoutSignal.aborted) { onTimeout(); return ctrl.signal }
  external.addEventListener('abort', onExternal, { once: true })
  timeoutSignal.addEventListener('abort', onTimeout, { once: true })
  return ctrl.signal
}

/** 可被外部 signal 打断的 sleep（重试等待期间用户取消要立刻退出） */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abortReason = () => signal?.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    if (signal?.aborted) { reject(abortReason()); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortReason())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 解析 Retry-After（秒数或 HTTP 日期），拿不到返回 null */
function retryAfterMs(res) {
  try {
    const raw = res?.headers?.get?.('retry-after')
    if (!raw) return null
    const secs = Number(raw)
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
    const at = Date.parse(raw)
    if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  } catch { /* 头不可读就当没有 */ }
  return null
}

/** 指数退避：base * 2^attempt + 随机 jitter；有 Retry-After 时取更大值但封顶 MAX_BACKOFF_MS */
function backoffDelay(attempt, baseDelayMs, hintMs) {
  const exp = baseDelayMs * 2 ** attempt
  const jitter = Math.random() * baseDelayMs
  let delay = Math.round(exp + jitter)
  if (hintMs != null) delay = Math.max(delay, Math.round(hintMs))
  return Math.min(delay, MAX_BACKOFF_MS)
}

function shortUrl(url) {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`.slice(0, 72)
  } catch {
    return String(url).slice(0, 72)
  }
}

function defaultOnRetry(info) {
  console.warn(`[重试] ${info.label} ${info.reason}，${info.delay}ms 后重试（${info.attempt + 1}/${info.maxRetries}）`)
}

/**
 * 带重试与指数退避的 fetch。
 *
 * @param {string | URL} url 请求地址
 * @param {RequestInit} [options] 原生 fetch 选项；options.signal 会被视为「外部取消信号」（跨重试复用）
 * @param {object} [retryOptions]
 * @param {number} [retryOptions.retries=2] 额外重试次数（总尝试 = retries + 1）
 * @param {number} [retryOptions.baseDelayMs=500] 指数退避基数（第 n 次重试等待 base*2^n + jitter）
 * @param {number} [retryOptions.timeoutMs=0] 单次尝试超时（毫秒）；>0 时每次尝试新建 AbortSignal.timeout
 * @param {boolean} [retryOptions.quiet=false] 为 true 时不打印重试日志
 * @param {Function | null} [retryOptions.onRetry] 自定义重试回调（传 null 关闭日志）
 * @returns {Promise<Response>} 原生 Response；最后一次尝试即使是 5xx/429 也原样返回，交给调用方处理
 */
export async function fetchWithRetry(url, options = {}, {
  retries = DEFAULT_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  timeoutMs = 0,
  quiet = false,
  onRetry,
} = {}) {
  const maxRetries = Math.max(0, Math.floor(Number(retries) || 0))
  const base = Math.max(0, Number(baseDelayMs) || 0)
  const notify = onRetry !== undefined ? onRetry : (quiet ? null : defaultOnRetry)
  const label = shortUrl(url)

  // 调用方可能传 AbortSignal.timeout()（一次性）或 AbortController.signal（可持续取消）
  let externalSignal = options.signal ?? null
  let attemptTimeoutMs = Math.max(0, Number(timeoutMs) || 0)

  if (externalSignal?.aborted) {
    // 已经取消的请求没必要再发；若它同时是超时信号，也不该浪费一次尝试
    throw externalSignal.reason instanceof Error
      ? externalSignal.reason
      : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now()
    const timeoutSignal = attemptTimeoutMs > 0 ? AbortSignal.timeout(attemptTimeoutMs) : null
    const signal = combineSignals(externalSignal, timeoutSignal)

    try {
      const res = await fetch(url, signal ? { ...options, signal } : options)

      if (!isRetryableStatus(res.status) || attempt >= maxRetries) return res

      // 丢弃 5xx/429 的响应体，避免连接/流泄漏后再发下一次
      try { await res.body?.cancel?.() } catch { /* 忽略 */ }
      const hint = res.status === 429 || res.status === 503 ? retryAfterMs(res) : null
      const delay = backoffDelay(attempt, base, hint)
      notify?.({ url, label, attempt, maxRetries, status: res.status, reason: `HTTP ${res.status}`, delay })
      await sleep(delay, externalSignal)
      continue
    } catch (err) {
      const cancelledExternally = externalSignal?.aborted === true
      const timedOutByCaller = cancelledExternally && isTimeoutAbort(externalSignal)

      // 用户/上层主动取消：立即结束，不重试
      if (cancelledExternally && !timedOutByCaller) throw err

      // 调用方传的是 AbortSignal.timeout()：它已经触发且不可复用，记录实际耗时作为后续尝试的超时
      if (timedOutByCaller) {
        if (!attemptTimeoutMs) attemptTimeoutMs = Math.max(1, Date.now() - startedAt)
        externalSignal = null
      }

      const timedOut = timedOutByCaller || timeoutSignal?.aborted === true
      const transient = timedOut || isTransientNetworkError(err)
      if (attempt >= maxRetries || !transient) throw err

      const delay = backoffDelay(attempt, base)
      notify?.({ url, label, attempt, maxRetries, status: null, reason: timedOut ? '请求超时' : `网络错误：${String(err.message).slice(0, 60)}`, delay })
      await sleep(delay, externalSignal)
    }
  }

  // 逻辑上不可达（循环内要么 return 要么 throw）
  throw new Error(`fetchWithRetry: ${label} 重试耗尽`)
}

export { DEFAULT_RETRIES, DEFAULT_BASE_DELAY_MS, MAX_BACKOFF_MS }
