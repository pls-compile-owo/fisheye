// tools/make-desktop-txt.mjs — 把 2.0.1 的文档/源码转成桌面纯文本版
// 用法：node tools/make-desktop-txt.mjs [输出目录]
// 产出：fisheye-README.txt / CHANGELOG.txt / CONFIG.txt / DESIGN.txt / REVIEW.txt / fisheye-源码.txt
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const outDir = process.argv[2] || path.join(process.env.USERPROFILE || '.', 'Desktop')
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
const V = `v${pkg.version} · tokencut`

const BAR = '='.repeat(60)
const LINE = '─'.repeat(60)

function writeTxt(name, content) {
  const p = path.join(outDir, name)
  fs.writeFileSync(p, content, 'utf8')
  console.log(`${name}: ${Math.round(content.length / 1024)} KB`)
}

// 1) 单文档 txt（头部 + 原文）
function docTxt(srcRel, title) {
  const md = fs.readFileSync(path.join(repo, srcRel), 'utf8')
  return `本文件由 fisheye 项目的 ${srcRel} 转换而来（纯文本格式，${V}）\n${BAR}\n\n${md}`
}
writeTxt('fisheye-README.txt', docTxt('README.md'))
writeTxt('CHANGELOG.txt', docTxt('CHANGELOG.md'))
writeTxt('CONFIG.txt', docTxt('docs/CONFIG.md'))
writeTxt('DESIGN.txt', docTxt('docs/DESIGN.md'))
writeTxt('REVIEW.txt', docTxt('docs/REVIEW.md'))

// 2) 源码合订本：扫描源/文档文件
const INCLUDE_EXT = new Set(['.mjs', '.js', '.md', '.py', '.json', '.yml', '.yaml', '.txt', '.ps1', '.svg'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'cache', 'out', '.ad-cache', '.npmrc'])
const SKIP_PATH = [
  /^test[\\/]golden[\\/]/,
  /^test[\\/]samples[\\/]/,
  /^docs[\\/]demo-.*\.gif$/,
  /^docs[\\/]2\.0[\\/]verify[\\/]0\.3-字幕摘要[\\/]/,
  /\.tgz$/,
]

const files = []
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue
    const full = path.join(dir, ent.name)
    const rel = path.relative(repo, full).split(path.sep).join('/')
    if (SKIP_PATH.some((re) => re.test(rel))) continue
    if (ent.isDirectory()) { walk(full); continue }
    const ext = path.extname(ent.name).toLowerCase()
    if (!INCLUDE_EXT.has(ext)) continue
    // 跳过超大文件（>300KB，避免 golden/大 json）
    const size = fs.statSync(full).size
    if (size > 300 * 1024) continue
    files.push(rel)
  }
}
walk(repo)
files.sort()

const chunks = []
for (const rel of files) {
  const content = fs.readFileSync(path.join(repo, rel), 'utf8')
  const lines = content.split('\n').length
  chunks.push(`${LINE}\n文件: ${rel}（${lines} 行）\n${LINE}\n\n${content}\n`)
}

const header = `fisheye 源码合订本（${V}）\n${BAR}\n共 ${files.length} 个源/文档文件（含中英双版文档）\n${BAR}\n\n`
writeTxt('fisheye-源码.txt', header + chunks.join('\n'))
console.log(`\n完成：${files.length} 个文件合订 → ${outDir}`)
