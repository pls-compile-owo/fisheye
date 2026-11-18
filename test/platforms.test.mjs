// platforms 适配器契约测试：注册表 / 输入识别 / source 接口 / URL 归一化稳定性。
// 纯逻辑，不真下载、不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { platforms, resolveSource } from '../lib/platforms/index.mjs'
import { probeDuration } from '../lib/platforms/_probe.mjs'

test('注册表：包含 bilibili / local / url 三个内置适配器', () => {
  const ids = platforms.map((p) => p.id)
  assert.deepEqual(ids.sort(), ['bilibili', 'local', 'url'])
})

test('每个适配器都满足契约（id/name/match/createSource/requires）', () => {
  for (const p of platforms) {
    assert.equal(typeof p.id, 'string')
    assert.equal(typeof p.name, 'string')
    assert.equal(typeof p.match, 'function')
    assert.equal(typeof p.createSource, 'function')
    assert.equal(typeof p.requires, 'object')
  }
})

test('resolveSource：BV 号 → bilibili 适配器', () => {
  const src = resolveSource('BV1Cc411Q78T')
  assert.ok(src)
  assert.equal(src.kind, 'bilibili')
  assert.equal(src.id, 'BV1Cc411Q78T')
})

test('resolveSource：BV 格式边界（长度/非法字符）不匹配 bilibili', () => {
  for (const bad of ['BV123', 'BV1Cc411Q78', 'BV1Cc411Q78T!', 'bv1Cc411Q78T']) {
    const src = resolveSource(bad)
    // 非法 BV 不应落到 bilibili 适配器（可能为 null 或被 local 拒绝）
    assert.ok(!src || src.kind !== 'bilibili', bad + ' 不应匹配 bilibili')
  }
})

test('resolveSource：存在的本地文件 → local 适配器（id 文件名安全）', () => {
  const tmp = path.join(os.tmpdir(), `fisheye-platform-test-${process.pid}.mp4`)
  fs.writeFileSync(tmp, 'fake')
  try {
    const src = resolveSource(tmp)
    assert.ok(src)
    assert.equal(src.kind, 'local')
    assert.match(src.id, /^local-[A-Za-z0-9_.-]+$/)
    assert.ok(src.id.length <= 48)
  } finally {
    fs.unlinkSync(tmp)
  }
})

test('resolveSource：http(s) 链接 → url 适配器（id 为短哈希）', () => {
  const src = resolveSource('https://www.youtube.com/watch?v=abc123')
  assert.ok(src)
  assert.equal(src.kind, 'url')
  assert.match(src.id, /^url-[a-f0-9]{12}$/)
})

test('resolveSource：未知输入返回 null', () => {
  assert.equal(resolveSource(''), null)
  assert.equal(resolveSource(null), null)
  assert.equal(resolveSource(123), null)
  assert.equal(resolveSource('--grid'), null)
  assert.equal(resolveSource('不存在的路径/xx.mp4'), null)
})

test('url 适配器：时间戳/分享参数归一化后 id 稳定', () => {
  const a = resolveSource('https://example.com/v?id=1&t=120')
  const b = resolveSource('https://example.com/v?id=1&share_source=qq')
  const c = resolveSource('https://example.com/v?id=1')
  assert.ok(a && b && c)
  assert.equal(a.id, c.id, '时间戳参数不应影响 id')
  assert.equal(b.id, c.id, '分享参数不应影响 id')
})

test('source 契约：meta/media/subtitles/danmaku 都是函数；local/url 无弹幕不做广告检测', () => {
  const tmp = path.join(os.tmpdir(), `fisheye-platform-test2-${process.pid}.mp4`)
  fs.writeFileSync(tmp, 'fake')
  try {
    const localSrc = resolveSource(tmp)
    for (const k of ['kind', 'id', 'label']) assert.ok(localSrc[k] !== undefined)
    for (const fn of ['meta', 'media', 'subtitles', 'danmaku']) assert.equal(typeof localSrc[fn], 'function')
    assert.equal(localSrc.adDetector, null, 'local 无弹幕 → 不做广告检测（设计 05 §7.5）')

    const urlSrc = resolveSource('https://example.com/v?id=9')
    for (const fn of ['meta', 'media', 'subtitles', 'danmaku']) assert.equal(typeof urlSrc[fn], 'function')
    assert.equal(urlSrc.adDetector, null, 'url 无弹幕 → 不做广告检测（设计 05 §7.5）')
  } finally {
    fs.unlinkSync(tmp)
  }
})

test('bilibili source：meta/media/subtitles/danmaku 都是函数', () => {
  const src = resolveSource('BV1Cc411Q78T')
  for (const fn of ['meta', 'media', 'subtitles', 'danmaku']) assert.equal(typeof src[fn], 'function')
})

test('probeDuration：不存在的文件返回 null（不抛错）', () => {
  let out
  assert.doesNotThrow(() => { out = probeDuration(path.join(os.tmpdir(), 'no-such-file-' + Date.now() + '.mp4')) })
  assert.equal(out, null)
})
