// planner 单测：决策逻辑与 IO 解耦后可直接验证（密度阶梯 / 张数 / 预算钳制 / 成本估算）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { planAuto, MAX_GRIDS } from '../lib/planner.mjs'

const base = {
  duration: 600,
  budget: 20000,
  densityOpt: null,
  rate: 0.1,
  official: null,
  transcript: '',
  hasSubs: false,
  gridCost: 1200,
}

test('planAuto：密度阶梯按变化率推导', () => {
  assert.equal(planAuto({ ...base, rate: 2 }).maxGap, 4)   // 快剪
  assert.equal(planAuto({ ...base, rate: 0.8 }).maxGap, 6)  // vlog
  assert.equal(planAuto({ ...base, rate: 0.3 }).maxGap, 9)  // 口播
  assert.equal(planAuto({ ...base, rate: 0.05 }).maxGap, 13) // 静态
})

test('planAuto：--density 手动指定覆盖推导', () => {
  const p = planAuto({ ...base, densityOpt: 3 })
  assert.equal(p.maxGap, 3)
  assert.equal(p.densityAuto, false)
})

test('planAuto：张数满足密度需求', () => {
  // 600s / 13s ≈ 47 帧 → ceil(47/9) = 6 张
  const p = planAuto({ ...base, rate: 0.05 })
  assert.equal(p.minGrids, 6)
  assert.equal(p.gridCount, 6)
  assert.equal(p.actualGap, 600 / (6 * 9))
})

test('planAuto：预算不足时钳制张数并备注', () => {
  // 预算 3000，固定成本（无字幕：精读 3 × 1300 = 3900）已超 → maxGridsByBudget=1
  const p = planAuto({ ...base, budget: 3000, rate: 0.05 })
  assert.equal(p.gridCount, 1)
  assert.ok(p.notes.length > 0, '应有预算备注')
})

test('planAuto：MAX_GRIDS 上限生效', () => {
  const p = planAuto({ ...base, duration: 7200, budget: 200000, rate: 0.05 })
  assert.ok(p.gridCount <= MAX_GRIDS)
})

test('planAuto：subsCost 优先官方字幕/转写，其次字幕带', () => {
  const official = { chars: 500 }
  assert.equal(planAuto({ ...base, official }).subsCost, 500)
  assert.equal(planAuto({ ...base, transcript: 'a'.repeat(300) }).subsCost, 300)
  assert.ok(planAuto({ ...base, hasSubs: true }).subsCost > 0)
  assert.equal(planAuto(base).subsCost, 0)
})

test('planAuto：estTotal = 字幕 + 拼图 + 精读预留', () => {
  const p = planAuto({ ...base, official: { chars: 500 } })
  assert.equal(p.estTotal, p.subsCost + p.gridCount * base.gridCost + p.fineReserve)
  assert.ok(p.fineReserve > 0)
})

test('planAuto：空/边界输入不崩', () => {
  const p = planAuto({ duration: 1, budget: 2000, densityOpt: null, rate: 0, official: null, transcript: '', hasSubs: false, gridCost: 1200 })
  assert.equal(p.gridCount, 1)
  assert.ok(p.chunk > 0)
})
