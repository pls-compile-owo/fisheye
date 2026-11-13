// 通用工具：时间格式化、参数解析、文件头探测
import fs from 'node:fs'

// 时长格式化：超过 1 小时显示 01:05:30，否则 MM:SS

export const fmt = (s) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
// Windows 文件名不能带冒号，落盘用秒数

export const fsec = (s) => String(Math.round(s)).padStart(4, '0')

// 从 JPEG 头读尺寸（沙箱禁管道，不能用 ffprobe 捕获输出）

export function jpegSize(file) {
  try {
    const b = fs.readFileSync(file)
    let i = 2
    while (i < b.length - 8) {
      if (b[i] !== 0xFF) { i++; continue }
      const marker = b[i + 1]
      const len = (b[i + 2] << 8) | b[i + 3]
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] }
      }
      i += 2 + len
    }
  } catch {}
  return null
}

// 参数校验（在 CLI 分发处用；Number('')===0、Infinity、NaN 都要挡掉）

export const fail = (msg) => {
  console.error(`参数错误：${msg}`)
  process.exit(2)
}

export const num = (v, name, { min, max } = {}) => {
  const n = Number(v)
  if (v === '' || !Number.isFinite(n)) fail(`--${name} 需要数字，收到：${JSON.stringify(v)}`)
  if (min !== undefined && n < min) fail(`--${name} 不能小于 ${min}（收到 ${n}）`)
  if (max !== undefined && n > max) fail(`--${name} 不能大于 ${max}（收到 ${n}）`)
  return n
}

export const gridStr = (v) => {
  const s = String(v ?? '3x3').toLowerCase()
  if (!/^[1-9]x[1-9]$/.test(s)) fail(`--grid 格式应为 NxM（如 3x3，行列 1~9），收到：${JSON.stringify(v)}`)
  return s
}
// 时间参数：支持 330（秒）/ 5:30 / 1:05:30

export const parseTime = (v, name) => {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) fail(`--${name} 时间格式应为 330 / 5:30 / 1:05:30，收到：${JSON.stringify(v)}`)
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) fail(`--${name} 时间格式非法：${JSON.stringify(v)}`)
  return parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2]
}

export const pageNum = (v) => {
  if (v === null || v === undefined || v === '') return 1
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 200) fail(`--p 分P序号应为 1~200 的整数，收到：${JSON.stringify(v)}`)
  return n
}

// 统一取视频元信息（带超时 + code 校验；之前三处各自 fetch，有的没查 code）
