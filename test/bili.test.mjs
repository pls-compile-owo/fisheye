// bili 模块单测：官方字幕选轨（纯函数，不联网）
// 「外文视频只转写不翻译」的修复核心在 pickSubtitleTracks：
// 主轨保留原文，同时把中文轨（B站 l2 机器翻译）单独挑出来给 translated。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickSubtitleTracks, clean, keyOf, UA, MIXIN_TAB } from '../lib/bili.mjs'

const en = { lan: 'en-US', lan_doc: '英语', subtitle_url: '//aisubtitle.hdslb.com/en.json' }
const zh = { lan: 'zh-CN', lan_doc: '中文翻译', subtitle_url: '//aisubtitle.hdslb.com/zh.json' }

test('pickSubtitleTracks：外文主轨 + 中文翻译轨', () => {
  const t = pickSubtitleTracks([en, zh])
  assert.equal(t.main.lan, 'en-US')
  assert.equal(t.translate.lan, 'zh-CN')
})

test('pickSubtitleTracks：只有中文轨 → 主轨中文、翻译 null', () => {
  const zhOnly = { lan: 'ai-zh', lan_doc: '中文（AI）', subtitle_url: '//x/zh.json' }
  const t = pickSubtitleTracks([zhOnly])
  assert.equal(t.main.lan, 'ai-zh')
  assert.equal(t.translate, null)
})

test('pickSubtitleTracks：空数组 → null', () => {
  assert.equal(pickSubtitleTracks([]), null)
})

test('pickSubtitleTracks：外文无中文翻译 → 翻译 null', () => {
  const ja = { lan: 'ja-JP', lan_doc: '日语', subtitle_url: '//x/ja.json' }
  const t = pickSubtitleTracks([ja])
  assert.equal(t.main.lan, 'ja-JP')
  assert.equal(t.translate, null)
})

test('pickSubtitleTracks：多条中文轨仍只取一条（ai-zh 优先）', () => {
  const t = pickSubtitleTracks([en, { lan: 'zh-Hans', lan_doc: '简体中文' }, { lan: 'ai-zh', lan_doc: '中文（AI）' }])
  assert.equal(t.main.lan, 'en-US')
  assert.equal(t.translate.lan, 'ai-zh')
})

test('pickSubtitleTracks：preferZh=false 中文当主轨、不产生翻译', () => {
  const t = pickSubtitleTracks([en, zh], false)
  assert.equal(t.main.lan, 'zh-CN')
  assert.equal(t.translate, null)
})

test('pickSubtitleTracks：忽略无 lan 的脏项；全脏 → null', () => {
  const t = pickSubtitleTracks([{ subtitle_url: '//x' }, null, en, zh])
  assert.equal(t.main.lan, 'en-US')
  assert.equal(t.translate.lan, 'zh-CN')
  assert.equal(pickSubtitleTracks([{ subtitle_url: '//x' }, null]), null)
})

// —— 既有纯函数测试（0.5.0 起）——
test('clean：去除 WBI 禁止字符', () => {
  assert.equal(clean("a!b'c(d)e*f"), 'abcdef')
  assert.equal(clean('plain123'), 'plain123')
})

test('keyOf：从 URL 提取文件名（去扩展名）', () => {
  assert.equal(keyOf('https://example.com/path/file.txt'), 'file')
  assert.equal(keyOf('https://a.b/c/d/e.f.js'), 'e.f')
})

test('UA 与 MIXIN_TAB 常量存在', () => {
  assert.equal(typeof UA, 'string')
  assert.ok(UA.includes('Mozilla'))
  assert.ok(Array.isArray(MIXIN_TAB))
  assert.equal(MIXIN_TAB.length, 64)
})
