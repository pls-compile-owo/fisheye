// resume 模块单测：manifest 读写 / 可复用判定 / 阶段记录 / 人类可读摘要
// 数据全在 os.tmpdir() 的临时目录里造，跑完清理，不碰项目自己的 out/。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadManifestState,
  saveManifest,
  manifestPath,
  canResume,
  recordStage,
  markDone,
  resumeSummary,
} from '../lib/resume.mjs'

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fisheye-resume-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 造一张「存在且非空」的拼图文件（内容无所谓，续跑只看文件在不在） */
function writeSheet(dir, name) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, 'fake-jpeg')
  return file
}

const PLAN = { budget: 20000, density: 6, from: 0, to: 600 }

/** 一份完整的 manifest：下载已 done，两张拼图，计划参数固定 */
function makeState(t, { bvid = 'BV1resume001' } = {}) {
  const dir = tmpDir(t)
  const a = writeSheet(dir, 'c00_0000-0300_3x3.jpg')
  const b = writeSheet(dir, 'c01_0300-0600_3x3.jpg')
  const state = {
    bvid,
    title: '断点续跑测试片',
    duration: 600,
    grid: '3x3',
    plan: { ...PLAN },
    range: { from: 0, to: 600 },
    // 第一条用 sheet（stageGrid 现在的写法），第二条用 file（新写法）——两种都要认
    chunks: [
      { chunk: 1, from: 0, to: 300, range: '00:00-05:00', grid: '3x3', sheet: a },
      { chunk: 2, from: 300, to: 600, range: '05:00-10:00', grid: '3x3', file: b },
    ],
    stages: { download: { status: 'done' } },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  saveManifest(dir, bvid, state)
  return { dir, bvid, state, sheets: [a, b] }
}

test('loadManifestState：读回 manifest；不存在 / 坏 JSON → null；BOM 能读', (t) => {
  const { dir, bvid, state } = makeState(t)
  const got = loadManifestState(dir, bvid)
  assert.equal(got.bvid, bvid)
  assert.equal(got.title, state.title)
  assert.deepEqual(got.chunks, state.chunks)
  assert.equal(manifestPath(dir, bvid), path.join(dir, `${bvid}-manifest.json`))

  assert.equal(loadManifestState(dir, 'BVnothere'), null)

  fs.writeFileSync(manifestPath(dir, bvid), '{ 这不是 json', 'utf8')
  assert.equal(loadManifestState(dir, bvid), null)

  // PowerShell / 记事本会加 BOM
  fs.writeFileSync(manifestPath(dir, bvid), '\uFEFF{"bvid":"x"}', 'utf8')
  assert.equal(loadManifestState(dir, bvid).bvid, 'x')
})

test('saveManifest：校验参数，写出的内容能原样读回，且不留临时文件', (t) => {
  const dir = tmpDir(t)
  assert.throws(() => saveManifest(dir, '', {}), TypeError)
  assert.throws(() => saveManifest(dir, 'BVx', null), TypeError)

  const file = saveManifest(dir, 'BVx', { bvid: 'BVx', chunks: [] })
  assert.equal(file, manifestPath(dir, 'BVx'))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { bvid: 'BVx', chunks: [] })
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [])
})

test('canResume：文件都在、计划参数没变 → 可复用并给出张数', (t) => {
  const { dir, bvid } = makeState(t)
  const r = canResume(loadManifestState(dir, bvid), { plan: { ...PLAN } })
  assert.equal(r.resumable, true)
  assert.equal(r.doneGrids, 2)
  assert.match(r.reason, /2\/2/)
  assert.match(r.reason, /跳过抽帧/)
})

test('canResume：缺一张 / 空文件 → 仍可复用，只补缺的', (t) => {
  const { dir, bvid, sheets } = makeState(t)
  fs.unlinkSync(sheets[1])
  let r = canResume(loadManifestState(dir, bvid), { plan: { ...PLAN } })
  assert.equal(r.resumable, true)
  assert.equal(r.doneGrids, 1)
  assert.match(r.reason, /1\/2/)
  assert.match(r.reason, /补抽 1 张/)

  // 0 字节的图不能算「已抽好」
  fs.writeFileSync(sheets[0], '')
  r = canResume(loadManifestState(dir, bvid), { plan: { ...PLAN } })
  assert.equal(r.resumable, false)
  assert.equal(r.doneGrids, 0)
})

test('canResume：拼图全没了 → 抽帧要重来（不可复用）', (t) => {
  const { dir, bvid, sheets } = makeState(t)
  for (const f of sheets) fs.unlinkSync(f)
  const r = canResume(loadManifestState(dir, bvid), { plan: { ...PLAN } })
  assert.equal(r.resumable, false)
  assert.equal(r.doneGrids, 0)
  assert.match(r.reason, /全部缺失/)
})

test('canResume：budget / density 变了 → 抽帧不能跳过', (t) => {
  const { dir, bvid } = makeState(t)
  const byBudget = canResume(loadManifestState(dir, bvid), { plan: { ...PLAN, budget: 50000 } })
  assert.equal(byBudget.resumable, false)
  assert.match(byBudget.reason, /budget/)
  assert.match(byBudget.reason, /20000/)

  const byDensity = canResume(loadManifestState(dir, bvid), { plan: { ...PLAN, density: 3 } })
  assert.equal(byDensity.resumable, false)
  assert.match(byDensity.reason, /density/)
})

test('canResume：时间区间变了 → 时间轴对不上，不能复用', (t) => {
  const { dir, bvid } = makeState(t)
  const r = canResume(loadManifestState(dir, bvid), { plan: { ...PLAN, from: 60 } })
  assert.equal(r.resumable, false)
  assert.match(r.reason, /区间/)
  assert.match(r.reason, /00:00-10:00/)
})

test('canResume：老 manifest 没记录 plan → 不敢按参数复用；只比区间时可以', (t) => {
  const { dir, bvid } = makeState(t)
  const st = loadManifestState(dir, bvid)
  delete st.plan
  saveManifest(dir, bvid, st)

  const strict = canResume(loadManifestState(dir, bvid), { plan: { budget: PLAN.budget } })
  assert.equal(strict.resumable, false)
  assert.match(strict.reason, /没有记录 budget/)

  // 老 state 没有 plan，但 range 还在：只给区间且与 range 一致 → 可以续
  const loose = canResume(loadManifestState(dir, bvid), { plan: { from: 0, to: 600 } })
  assert.equal(loose.resumable, true)
  assert.equal(loose.doneGrids, 2)
})

test('canResume：没有 manifest / 没有拼图记录 → 不可复用', () => {
  const missing = canResume(null)
  assert.deepEqual(missing, { resumable: false, reason: '没有可复用的 manifest（这个视频还没跑过）', doneGrids: 0 })

  const empty = canResume({ bvid: 'BVx', chunks: [] }, { plan: {} })
  assert.equal(empty.resumable, false)
  assert.match(empty.reason, /没有拼图记录/)
})

test('canResume：只给了 range 展示字符串的旧记录也能判断（按 duration 补齐区间）', (t) => {
  const dir = tmpDir(t)
  const sheet = writeSheet(dir, 'only.jpg')
  const state = {
    bvid: 'BVrange',
    duration: 600,
    plan: { budget: 1000 },
    chunks: [{ chunk: 1, sheet, range: '00:00-10:00' }],
  }
  const r = canResume(state, { plan: { budget: 1000, from: 0, to: 600 } })
  assert.equal(r.resumable, true)
  assert.equal(r.doneGrids, 1)
})

test('recordStage / markDone：自动原子写回，重新 load 保持一致', (t) => {
  const { dir, bvid } = makeState(t)
  const st = loadManifestState(dir, bvid)

  recordStage(st, 'grids', { done: 1, total: 2 })
  assert.equal(loadManifestState(dir, bvid).stages.grids.status, 'running')

  markDone(st, 'grids', { done: 2, total: 2 })
  const again = loadManifestState(dir, bvid)
  assert.equal(again.stages.download.status, 'done')   // 老记录不能丢
  assert.equal(again.stages.grids.status, 'done')
  assert.equal(again.stages.grids.done, 2)
  assert.ok(again.stages.grids.doneAt)
  assert.ok(again.updatedAt)

  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [])
})

test('recordStage：没有来源信息时只改内存、不写盘；非法参数抛 TypeError', () => {
  const st = { bvid: 'BVx', stages: { download: 'done' } }
  const out = recordStage(st, 'download', 'done')
  assert.equal(out, st)
  assert.equal(st.stages.download.status, 'done')
  assert.match(st.stages.download.at, /^\d{4}-\d{2}-\d{2}T/)

  assert.throws(() => recordStage(null, 'grids'), TypeError)
  assert.throws(() => recordStage(st, ''), TypeError)
})

test('resumeSummary：列出阶段、拼图缺口、计划参数与可跳过项', (t) => {
  const { dir, bvid, sheets } = makeState(t)
  const st = loadManifestState(dir, bvid)
  recordStage(st, 'grids', { done: 1, total: 2 })
  fs.unlinkSync(sheets[1])

  const s = resumeSummary(loadManifestState(dir, bvid))
  assert.match(s, /BV1resume001/)
  assert.match(s, /断点续跑测试片/)
  assert.match(s, /阶段：下载 已完成 · 抽帧 进行中/)
  assert.match(s, /拼图：1\/2 张可用/)
  assert.match(s, /缺 1 张/)
  assert.match(s, /计划：budget 20000 · density 6s/)
  assert.match(s, /可跳过：下载/)
  assert.match(resumeSummary(null), /没有 manifest/)
})

test('resumeSummary：拼图齐全时说明可跳过抽帧', (t) => {
  const { dir, bvid } = makeState(t)
  const st = loadManifestState(dir, bvid)
  markDone(st, 'grids')
  const s = resumeSummary(loadManifestState(dir, bvid))
  assert.match(s, /拼图：2\/2 张可用（可跳过抽帧）/)
  assert.match(s, /可跳过：下载、抽帧/)
})
