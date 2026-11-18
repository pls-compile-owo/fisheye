// budget 模块单测：token 估算 / 环境变量覆盖 / 模型系数
import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, tokensPerUnit, modelFactor, COST } from '../lib/budget.mjs'

const ENV_KEYS = ['FISHEYE_TOKENS_PER_GRID', 'FISHEYE_TOKENS_PER_SUBS', 'FISHEYE_TOKENS_PER_FINE', 'FISHEYE_TOKEN_MODEL']
function withEnv(overrides, fn) {
  const saved = {}
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  Object.assign(process.env, overrides)
  try { return fn() } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
  }
}

test('默认值：grid/subs/fine = 1024（0.5 改价：Flash 每图上限 1024）', () => {
  withEnv({}, () => {
    assert.equal(estimateTokens('grid'), 1024)
    assert.equal(estimateTokens('subs'), 1024)
    assert.equal(estimateTokens('fine'), 1024)
    assert.equal(estimateTokens('fine', 3), 3072)
  })
})

test('COST 默认表与 2.0 口径一致', () => {
  assert.deepEqual({ ...COST }, { grid: 1024, subs: 1024, fine: 1024 })
})

test('环境变量覆盖单张成本', () => {
  withEnv({ FISHEYE_TOKENS_PER_GRID: '1500', FISHEYE_TOKENS_PER_SUBS: '900' }, () => {
    assert.equal(estimateTokens('grid'), 1500)
    assert.equal(estimateTokens('subs', 2), 1800)
  })
})

test('FISHEYE_TOKEN_MODEL：qwen/gemini/数字', () => {
  withEnv({ FISHEYE_TOKEN_MODEL: 'qwen' }, () => {
    assert.ok(modelFactor() > 1)
    assert.ok(estimateTokens('grid') > 1024)
  })
  withEnv({ FISHEYE_TOKEN_MODEL: 'gemini' }, () => {
    assert.ok(modelFactor() < 1)
  })
  withEnv({ FISHEYE_TOKEN_MODEL: '2' }, () => {
    assert.equal(modelFactor(), 2)
    assert.equal(estimateTokens('grid'), 2048)
  })
})

test('非法模型名回退 1.0；未知 kind 抛错', () => {
  withEnv({ FISHEYE_TOKEN_MODEL: 'nonsense-model' }, () => {
    assert.equal(modelFactor(), 1.0)
  })
  assert.throws(() => estimateTokens('unknown-kind'))
})

test('count 非正/非有限 → 0', () => {
  assert.equal(estimateTokens('grid', 0), 0)
  assert.equal(estimateTokens('grid', -5), 0)
  assert.equal(estimateTokens('grid', Number.NaN), 0)
})
