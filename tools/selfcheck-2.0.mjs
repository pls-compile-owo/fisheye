// docs/2.0 全量自检：编号连续性、交叉引用、数字一致性、术语冲突、格式
import fs from 'node:fs'
import path from 'node:path'

const dir = 'C:/Users/Marsw/Documents/deepseek-harness/fisheye-publish/fisheye/docs/2.0'
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
const issues = []
const info = []

for (const f of files) {
  const p = path.join(dir, f)
  const text = fs.readFileSync(p, 'utf8')
  const lines = text.split('\n')
  const heads = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#{2,3} /.test(l))

  // 1) 代码块围栏闭合
  const fences = lines.filter((l) => l.trim().startsWith('```')).length
  if (fences % 2 !== 0) issues.push(`${f}: 代码块围栏未闭合（${fences} 个）`)

  // 2) 交叉引用
  for (const m of text.matchAll(/\]\((\.\.?\/[^)#]+)\)/g)) {
    const target = path.resolve(path.dirname(p), m[1])
    if (!fs.existsSync(target)) issues.push(`${f}: 断链 → ${m[1]}`)
  }

  // 3) 章节编号连续性（只看 ### x.y）
  const nums = heads
    .map(({ l }) => l.match(/^### (\d+)\.(\d+)/))
    .filter(Boolean)
    .map((m) => ({ major: +m[1], minor: +m[2] }))
  for (let i = 1; i < nums.length; i++) {
    const prev = nums[i - 1]
    const cur = nums[i]
    if (cur.major === prev.major && cur.minor !== prev.minor + 1) {
      issues.push(`${f}: 章节跳号 ### ${prev.major}.${prev.minor} → ### ${cur.major}.${cur.minor}`)
    }
  }

  // 4) 重复标题
  const seen = new Map()
  for (const { l } of heads) {
    const key = l.trim()
    if (seen.has(key)) issues.push(`${f}: 重复标题 "${key}"`)
    seen.set(key, true)
  }

  // 5) 表格列数一致性（同一表格内）
  let inTable = false
  let cols = 0
  for (const [i, l] of lines.entries()) {
    const t = l.trim()
    if (t.startsWith('|')) {
      const n = t.replace(/^\||\|$/g, '').split('|').length
      if (!inTable) { inTable = true; cols = n } else if (n !== cols && !/^\|[\s:|-]+\|$/.test(t)) {
        issues.push(`${f}:${i + 1}: 表格列数不一致（期望 ${cols}，实际 ${n}）`)
      }
    } else inTable = false
  }

  info.push({ f, lines: lines.length, tables: (text.match(/^\|/gm) || []).length, heads: heads.length })
}

// 6) 术语冲突
const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
const termChecks = [
  { a: 'readerModel', b: 'imageModel', label: '读图模型命名' },
  { a: '3800', b: null, label: '旧常量 3800' },
  { a: '1200', b: null, label: '旧常量 1200（应只在"已废"说明里）' },
  { a: '六路', b: null, label: '旧基线"六路"' },
  { a: '7200', b: null, label: '旧 costEstimate 7200' },
]
const termHits = {}
for (const c of termChecks) {
  const n = (all.match(new RegExp(c.a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
  termHits[c.label] = n
}

console.log('=== 文件概览 ===')
for (const i of info) console.log(`${i.f.padEnd(22)} ${String(i.lines).padStart(4)} 行  ${String(i.heads).padStart(3)} 标题`)
console.log('\n=== 术语/旧常量出现次数 ===')
for (const [k, v] of Object.entries(termHits)) console.log(`${k}: ${v}`)
console.log('\n=== 问题清单 ===')
if (issues.length) issues.forEach((x) => console.log('• ' + x))
else console.log('无问题')
