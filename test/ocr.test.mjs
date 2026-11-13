// ocr 模块单测：能力探测结构（环境无关）+ 有 tesseract 时实测一张自带文字的小图
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findTesseract, ocrCaps, ocrImage } from '../lib/ocr.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = path.join(HERE, 'ocr-sample.png')

test('ocrCaps：结构完整、字段类型正确', () => {
  const caps = ocrCaps()
  assert.equal(typeof caps.available, 'boolean')
  assert.equal(typeof caps.reason, 'string')
  assert.equal(typeof caps.summary, 'string')
  assert.ok(caps.summary.includes('OCR：'))
  assert.ok(caps.summary.includes(caps.available ? '可用' : '不可用'))
  assert.ok(caps.hint === null || typeof caps.hint === 'string')
  assert.ok(caps.cmd === null || typeof caps.cmd === 'string')
  assert.ok(caps.binDir === null || typeof caps.binDir === 'string')
  assert.ok(caps.tessdata === null || typeof caps.tessdata === 'string')
  assert.ok(caps.version === null || typeof caps.version === 'string')
  assert.ok(Array.isArray(caps.langs))
  for (const l of caps.langs) assert.equal(typeof l, 'string')
  // 可用时必须能指到真实 cmd，且语言包列表非空
  if (caps.available) {
    assert.ok(caps.cmd && fs.existsSync(caps.cmd))
    assert.ok(caps.langs.length > 0)
  }
})

test('ocrCaps：探测异常也不抛（env 为怪值）', () => {
  const caps = ocrCaps({ env: { FISHEYE_TESSERACT: 123 } })
  assert.equal(typeof caps.available, 'boolean')
  assert.equal(typeof caps.summary, 'string')
})

test('findTesseract：返回 null 或合法对象（环境无关）', () => {
  const t = findTesseract()
  if (t === null) return // 没装 tesseract 的机器上这是合法结果
  assert.equal(typeof t.cmd, 'string')
  assert.ok(fs.existsSync(t.cmd), `cmd 应该存在：${t.cmd}`)
  assert.equal(
    path.basename(t.cmd).toLowerCase(),
    process.platform === 'win32' ? 'tesseract.exe' : 'tesseract',
  )
  assert.equal(typeof t.binDir, 'string')
  assert.ok(fs.existsSync(t.binDir))
  assert.ok(t.tessdata === null || typeof t.tessdata === 'string')
  if (t.tessdata) assert.ok(fs.existsSync(t.tessdata))
})

test('findTesseract：FISHEYE_TESSERACT 指向不存在的文件时优雅回退', () => {
  const t = findTesseract({ env: { ...process.env, FISHEYE_TESSERACT: path.join(HERE, 'no-such-dir', 'tesseract.exe') } })
  assert.ok(t === null || (typeof t.cmd === 'string' && fs.existsSync(t.cmd)))
})

test('findTesseract：FISHEYE_TESSERACT 可指向安装目录', () => {
  const real = findTesseract()
  if (!real) return // 环境无关：没装就跳过
  const t = findTesseract({ env: { ...process.env, FISHEYE_TESSERACT: real.binDir } })
  assert.ok(t)
  assert.equal(t.cmd.toLowerCase(), real.cmd.toLowerCase())
})

test('ocrImage：图片不存在时返回 null', () => {
  const r = ocrImage(path.join(HERE, 'no-such-image.png'), { quiet: true })
  assert.equal(r, null)
})

test('ocrImage：实测识别 test/ocr-sample.png 里的 HELLO 123', (t) => {
  const caps = ocrCaps()
  if (!caps.available) {
    t.skip('本机没有可用的 tesseract')
    return
  }
  if (!fs.existsSync(SAMPLE)) {
    t.skip('缺少 test/ocr-sample.png')
    return
  }
  const r = ocrImage(SAMPLE, { lang: 'eng', quiet: true })
  assert.ok(r, 'tesseract 可用时应该识别出文本')
  assert.equal(typeof r.text, 'string')
  assert.match(r.text, /HELLO/i)
  assert.match(r.text, /123/)
  assert.equal(typeof r.cmd, 'string')
  assert.equal(r.lang, 'eng')
})
