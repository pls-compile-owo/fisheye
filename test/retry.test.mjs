// retry 模块单测：可重试判定 + fetchWithRetry 行为（本地 mock server）
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fetchWithRetry, isRetryableStatus, isTransientNetworkError } from '../lib/retry.mjs'

test('isRetryableStatus：只重试 5xx / 429', () => {
  assert.equal(isRetryableStatus(200), false)
  assert.equal(isRetryableStatus(301), false)
  assert.equal(isRetryableStatus(400), false)
  assert.equal(isRetryableStatus(404), false)
  assert.equal(isRetryableStatus(429), true)
  assert.equal(isRetryableStatus(500), true)
  assert.equal(isRetryableStatus(502), true)
  assert.equal(isRetryableStatus(503), true)
})

test('isTransientNetworkError：网络错误可重试，其他不重试', () => {
  assert.equal(isTransientNetworkError(new Error('fetch failed: ECONNRESET')), true)
  assert.equal(isTransientNetworkError(new Error('socket hang up')), true)
  assert.equal(isTransientNetworkError(new Error('ETIMEDOUT')), true)
  assert.equal(isTransientNetworkError(new Error('something else')), false)
  assert.equal(isTransientNetworkError(null), false)
})

test('fetchWithRetry：成功后直接返回（不发冗余请求）', async () => {
  let hits = 0
  const server = http.createServer((req, res) => { hits++; res.writeHead(200); res.end('ok') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const res = await fetchWithRetry(`http://127.0.0.1:${port}/`, {}, { retries: 2, baseDelayMs: 10, quiet: true })
    assert.equal(res.status, 200)
    assert.equal(hits, 1)
  } finally {
    server.close()
  }
})

test('fetchWithRetry：503 重试后成功', async () => {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    if (hits < 3) { res.writeHead(503); res.end('busy') } else { res.writeHead(200); res.end('ok') }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const res = await fetchWithRetry(`http://127.0.0.1:${port}/`, {}, { retries: 3, baseDelayMs: 10, quiet: true })
    assert.equal(res.status, 200)
    assert.equal(hits, 3)
  } finally {
    server.close()
  }
})

test('fetchWithRetry：404 不重试', async () => {
  let hits = 0
  const server = http.createServer((req, res) => { hits++; res.writeHead(404); res.end('nope') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const res = await fetchWithRetry(`http://127.0.0.1:${port}/`, {}, { retries: 3, baseDelayMs: 10, quiet: true })
    assert.equal(res.status, 404)
    assert.equal(hits, 1)
  } finally {
    server.close()
  }
})
