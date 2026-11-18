// 把 fisheye-2.0-方案.md 转成可双击打开的 HTML（零依赖，覆盖标题/表格/代码块/列表/粗体）
import fs from 'node:fs'

const src = process.argv[2]
const dst = process.argv[3]
const md = fs.readFileSync(src, 'utf8')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

const lines = md.split('\n')
const out = []
let inCode = false
let codeBuf = []
let inTable = false
let tableRows = []
let listType = null

const flushTable = () => {
  if (!tableRows.length) return
  const head = tableRows[0]
  const body = tableRows.slice(1).filter((r) => !/^\|[\s:|-]+\|$/.test(r))
  out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>')
  for (const row of body) out.push('<tr>' + row.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>')
  out.push('</tbody></table>')
  tableRows = []
  inTable = false
}
const closeList = () => {
  if (listType) { out.push(`</${listType}>`); listType = null }
}

for (const raw of lines) {
  const line = raw
  if (line.startsWith('```')) {
    if (inCode) { out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>'); codeBuf = []; inCode = false }
    else { flushTable(); closeList(); inCode = true }
    continue
  }
  if (inCode) { codeBuf.push(line); continue }

  const t = line.trim()
  if (!t) { flushTable(); closeList(); continue }

  if (/^\|/.test(t)) {
    closeList()
    inTable = true
    tableRows.push(t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    continue
  }
  flushTable()

  const h = t.match(/^(#{1,6})\s+(.*)$/)
  if (h) { closeList(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue }

  if (/^>\s?/.test(t)) { closeList(); out.push('<blockquote>' + inline(t.replace(/^>\s?/, '')) + '</blockquote>'); continue }
  if (/^[-*]\s+/.test(t)) {
    if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul' }
    out.push('<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>')
    continue
  }
  if (/^\d+\.\s+/.test(t)) {
    if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol' }
    out.push('<li>' + inline(t.replace(/^\d+\.\s+/, '')) + '</li>')
    continue
  }
  closeList()
  out.push('<p>' + inline(t) + '</p>')
}
flushTable(); closeList()
if (inCode) out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>')

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>fisheye 2.0 方案</title>
<style>
:root{--fg:#1f2328;--bg:#fff;--muted:#656d76;--line:#d0d7de;--code:#f6f8fa;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#8b949e;--line:#30363d;--code:#161b22;--accent:#4493f8}}
*{box-sizing:border-box}
body{margin:0;padding:40px 24px;background:var(--bg);color:var(--fg);
 font:16px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:920px;margin:0 auto}
h1{font-size:30px;border-bottom:1px solid var(--line);padding-bottom:12px;margin:0 0 24px}
h2{font-size:24px;border-bottom:1px solid var(--line);padding-bottom:8px;margin:40px 0 16px}
h3{font-size:19px;margin:28px 0 12px}
h4{font-size:17px;margin:20px 0 8px}
p{margin:12px 0}
code{background:var(--code);padding:2px 6px;border-radius:4px;font-size:14px;
 font-family:ui-monospace,Consolas,monospace}
pre{background:var(--code);padding:16px;border-radius:8px;overflow:auto;border:1px solid var(--line)}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:15px;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
th{background:var(--code);font-weight:600}
blockquote{margin:12px 0;padding:8px 16px;border-left:4px solid var(--accent);color:var(--muted)}
ul,ol{padding-left:26px}
li{margin:4px 0}
strong{font-weight:600}
</style></head><body><main>
${out.join('\n')}
</main></body></html>`

fs.writeFileSync(dst, html, 'utf8')
console.log('HTML 已生成:', dst, Math.round(html.length / 1024) + ' KB')
