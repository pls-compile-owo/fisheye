// batch 模块单测：批量清单解析 / 串行与并发执行 / 汇总报告
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBatchList, runBatch, formatBatchReport } from '../lib/batch.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('parseBatchList：混合清单分类（BV / 文件 / URL / 空行 / 注释 / 非法行）', () => {
  const input = String.raw`
# 今晚要跑的一批
BV1ziWP6qENy

C:\videos\a.mp4
./clips/b.mkv
https://www.bilibili.com/video/BV1xx411c7mD
video.webm
D:/movies/c.mov
这不是视频
`
  const { items, errors } = parseBatchList(input)
  assert.deepEqual(items, [
    { kind: 'bv', value: 'BV1ziWP6qENy' },
    { kind: 'file', value: String.raw`C:\videos\a.mp4` },
    { kind: 'file', value: './clips/b.mkv' },
    { kind: 'url', value: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    { kind: 'file', value: 'video.webm' },
    { kind: 'file', value: 'D:/movies/c.mov' }
  ])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].raw, '这不是视频')
  // 行号按物理行算（1-based），空行 / 注释行也占行号
  const expectedLine = input.split(/\r?\n/).findIndex((line) => line.trim() === '这不是视频') + 1
  assert.equal(errors[0].line, expectedLine)
  assert.match(errors[0].reason, /无法识别/)
})

test('parseBatchList：数组输入、trim 与 # 注释行', () => {
  const { items, errors } = parseBatchList([
    '  BV1ziWP6qENy  ',
    '# 注释',
    '',
    '   ',
    '../up/c.mkv'
  ])
  assert.deepEqual(items, [
    { kind: 'bv', value: 'BV1ziWP6qENy' },
    { kind: 'file', value: '../up/c.mkv' }
  ])
  assert.deepEqual(errors, [])
})

test('parseBatchList：空输入 / 纯注释返回空清单', () => {
  assert.deepEqual(parseBatchList(''), { items: [], errors: [] })
  assert.deepEqual(parseBatchList([]), { items: [], errors: [] })
  assert.deepEqual(parseBatchList('# only\n\n  # comments'), { items: [], errors: [] })
})

test('parseBatchList：非视频扩展名的路径算 file，纯文本词进 errors', () => {
  const { items, errors } = parseBatchList(['notes.txt', String.raw`C:\docs\readme.txt`, 'BV1ziWP6qENy-x'])
  assert.deepEqual(items, [{ kind: 'file', value: String.raw`C:\docs\readme.txt` }])
  assert.equal(errors.length, 2)
  assert.deepEqual(errors.map((e) => e.raw), ['notes.txt', 'BV1ziWP6qENy-x'])
})

test('parseBatchList：非法 input 类型不抛错，进 errors', () => {
  const { items, errors } = parseBatchList(42)
  assert.deepEqual(items, [])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 0)
})

test('runBatch：concurrency=1 串行执行，结果按输入顺序', async () => {
  const order = []
  let active = 0
  let peak = 0
  const summary = await runBatch([1, 2, 3], async (n) => {
    active++
    peak = Math.max(peak, active)
    order.push(n)
    await sleep(5)
    active--
    return n * 10
  })
  assert.deepEqual(order, [1, 2, 3])
  assert.equal(peak, 1) // 串行：任意时刻只有一个在跑
  assert.equal(summary.total, 3)
  assert.equal(summary.ok, 3)
  assert.equal(summary.failed, 0)
  assert.deepEqual(summary.results.map((r) => r.item), [1, 2, 3])
  assert.deepEqual(summary.results.map((r) => r.result), [10, 20, 30])
  for (const row of summary.results) {
    assert.equal(row.ok, true)
    assert.equal(typeof row.ms, 'number')
    assert.ok(row.ms >= 0)
  }
})

test('runBatch：单个失败不中断整体，失败项带 error', async () => {
  const summary = await runBatch(['a', 'b', 'c'], async (item) => {
    if (item === 'b') throw new Error('炸了')
    return item.toUpperCase()
  })
  assert.equal(summary.total, 3)
  assert.equal(summary.ok, 2)
  assert.equal(summary.failed, 1)
  assert.deepEqual(summary.results.map((r) => r.ok), [true, false, true])
  assert.equal(summary.results[1].item, 'b')
  assert.match(summary.results[1].error, /炸了/)
  assert.equal(summary.results[2].result, 'C') // 失败之后仍继续执行
})

test('runBatch：concurrency=2 时并发度不超过 2，结果顺序不变', async () => {
  const items = [1, 2, 3, 4, 5]
  let active = 0
  let peak = 0
  const summary = await runBatch(items, async (n) => {
    active++
    peak = Math.max(peak, active)
    await sleep(20)
    active--
    return n
  }, { concurrency: 2 })
  assert.equal(peak, 2) // 两个 worker 各自跑，不会超过上限
  assert.equal(summary.ok, 5)
  assert.equal(summary.failed, 0)
  // 后完成的项不会把结果顺序打乱
  assert.deepEqual(summary.results.map((r) => r.item), items)
  assert.deepEqual(summary.results.map((r) => r.result), items)
})

test('runBatch：onItem 在每项开始前回调（进度用）', async () => {
  const events = []
  const summary = await runBatch(['a', 'b'], async (item) => {
    events.push(`run:${item}`)
    return item
  }, {
    concurrency: 1,
    onItem: (item, index) => { events.push(`item:${index}:${item}`) }
  })
  assert.deepEqual(events, ['item:0:a', 'run:a', 'item:1:b', 'run:b'])
  assert.equal(summary.ok, 2)
})

test('runBatch：空列表直接返回零统计，不调用 runner', async () => {
  let called = 0
  const summary = await runBatch([], async () => { called++ })
  assert.deepEqual(summary, { results: [], total: 0, ok: 0, failed: 0 })
  assert.equal(called, 0)
})

test('runBatch：非法 concurrency 回落为串行，参数类型错误抛 TypeError', async () => {
  const summary = await runBatch([1, 2], async (n) => n, { concurrency: 0 })
  assert.equal(summary.ok, 2)
  await assert.rejects(() => runBatch([], 'not a function'), TypeError)
  await assert.rejects(() => runBatch('not an array', async () => {}), TypeError)
})

test('formatBatchReport：含总数 / 成功 / 失败 / 耗时 / 失败明细', () => {
  const summary = {
    total: 3,
    ok: 2,
    failed: 1,
    results: [
      { item: { kind: 'bv', value: 'BV1ziWP6qENy' }, ok: true, result: {}, ms: 1000 },
      { item: { kind: 'file', value: String.raw`C:\videos\a.mp4` }, ok: false, error: '找不到文件', ms: 20 },
      { item: { kind: 'url', value: 'https://example.com/v.mp4' }, ok: true, result: {}, ms: 800 }
    ]
  }
  const report = formatBatchReport(summary)
  assert.match(report, /共 3 条/)
  assert.match(report, /成功 2 条/)
  assert.match(report, /失败 1 条/)
  assert.match(report, /1\.8s/) // 1000 + 20 + 800 ms
  assert.match(report, /失败明细/)
  assert.match(report, /\[file\] C:\\videos\\a\.mp4/)
  assert.match(report, /找不到文件/)
  // 失败明细只列失败项：成功的 BV 不出现在报告里
  assert.ok(!report.includes('[bv] BV1ziWP6qENy'))
})

test('formatBatchReport：全部成功时不打印失败明细', () => {
  const report = formatBatchReport({
    total: 2,
    ok: 2,
    failed: 0,
    results: [
      { item: { kind: 'bv', value: 'BV1ziWP6qENy' }, ok: true, ms: 300 },
      { item: { kind: 'bv', value: 'BV1xx411c7mD' }, ok: true, ms: 200 }
    ]
  })
  assert.match(report, /失败 0 条/)
  assert.ok(!report.includes('失败明细'))
  assert.match(report, /500ms/)
})

test('parseBatchList + runBatch + formatBatchReport：全流程', async () => {
  const { items, errors } = parseBatchList(String.raw`BV1ziWP6qENy
坏行
C:\v.mp4`)
  assert.equal(items.length, 2)
  assert.equal(errors.length, 1)
  const summary = await runBatch(items, async (item) => {
    if (item.kind === 'file') throw new Error('文件不存在')
    return item.value
  })
  assert.equal(summary.total, 2)
  assert.equal(summary.ok, 1)
  assert.equal(summary.failed, 1)
  const report = formatBatchReport(summary)
  assert.match(report, /共 2 条/)
  assert.match(report, /文件不存在/)
})
