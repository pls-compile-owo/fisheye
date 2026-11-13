// i18n 模块单测：语言切换与文案回退
import test from 'node:test'
import assert from 'node:assert/strict'
import { getLang, t } from '../lib/i18n.mjs'

function withLang(value, fn) {
  const saved = process.env.FISHEYE_LANG
  if (value === undefined) delete process.env.FISHEYE_LANG; else process.env.FISHEYE_LANG = value
  try { return fn() } finally {
    if (saved === undefined) delete process.env.FISHEYE_LANG; else process.env.FISHEYE_LANG = saved
  }
}

test('默认中文', () => {
  withLang(undefined, () => {
    assert.equal(getLang(), 'zh')
    assert.ok(t('usage').startsWith('用法'))
  })
})

test('FISHEYE_LANG=en 英文', () => {
  withLang('en', () => {
    assert.equal(getLang(), 'en')
    assert.ok(t('usage').startsWith('Usage'))
  })
})

test('en-US 归一化为 en', () => {
  withLang('en-US', () => assert.equal(getLang(), 'en'))
})

test('未知语言回退中文', () => {
  withLang('fr', () => assert.equal(getLang(), 'zh'))
})

test('占位符替换', () => {
  withLang(undefined, () => {
    const s = t('err.unknownStage', { stage: 'foo' })
    assert.ok(s.includes('foo'))
  })
})

test('缺失 key 原样返回（不抛错）', () => {
  assert.equal(t('no.such.key.here'), 'no.such.key.here')
})
