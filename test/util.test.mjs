// util 模块单测：时间格式化 / 参数解析（非法输入走 fail() 会 exit，用子进程断言退出码）
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { fmt, fsec, parseTime, num, gridStr, pageNum } from '../lib/util.mjs'

const utilPath = fileURLToPath(new URL('../lib/util.mjs', import.meta.url))

// 在子进程里执行一段 import util 的表达式，返回退出码（fail() 会 exit(2)）
function runInChild(fn, argExpr) {
  const code = `import(${JSON.stringify(pathToFileURL(utilPath).href)}).then(({ ${fn} }) => { ${fn}(${argExpr}) })`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  return r.status
}

test('fmt：超过 1 小时显示 H:MM:SS，否则 MM:SS', () => {
  assert.equal(fmt(0), '00:00')
  assert.equal(fmt(65), '01:05')
  assert.equal(fmt(600), '10:00')
  assert.equal(fmt(3930), '1:05:30')
})

test('fsec：落盘文件名用 4 位秒数', () => {
  assert.equal(fsec(0), '0000')
  assert.equal(fsec(59.6), '0060')
  assert.equal(fsec(3600), '3600')
})

test('parseTime：数字 / M:SS / H:MM:SS', () => {
  assert.equal(parseTime(90, 't'), 90)
  assert.equal(parseTime('90', 't'), 90)
  assert.equal(parseTime('1:30', 't'), 90)
  assert.equal(parseTime('1:05:30', 't'), 3930)
  assert.equal(parseTime(null, 't'), null)
  assert.equal(parseTime('', 't'), null)
})

test('parseTime：非法格式退出码为 2', () => {
  assert.equal(runInChild('parseTime', "'abc', 't'"), 2)
  assert.equal(runInChild('parseTime', "'1:2:3:4', 't'"), 2)
})

test('num：数字与边界', () => {
  assert.equal(num('5', 'x'), 5)
  assert.equal(num(5, 'x'), 5)
  assert.equal(num(0, 'x'), 0)
})

test('num：非法 / 越界退出码为 2', () => {
  assert.equal(runInChild('num', "'abc', 'x'"), 2)
  assert.equal(runInChild('num', "'', 'x'"), 2)
  assert.equal(runInChild('num', "999, 'x', { min: 0, max: 10 }"), 2)
})

test('gridStr：归一化与校验', () => {
  assert.equal(gridStr('3x3'), '3x3')
  assert.equal(gridStr('4X4'), '4x4')
  assert.equal(gridStr(undefined), '3x3')
  assert.equal(runInChild('gridStr', "'10x10'"), 2)
  assert.equal(runInChild('gridStr', "'abc'"), 2)
})

test('pageNum：分P序号', () => {
  assert.equal(pageNum(null), 1)
  assert.equal(pageNum('2'), 2)
  assert.equal(runInChild('pageNum', '0'), 2)
  assert.equal(runInChild('pageNum', '201'), 2)
  assert.equal(runInChild('pageNum', "'x'"), 2)
})
