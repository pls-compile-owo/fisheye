// lib/platforms/index.mjs — 平台适配器注册表 + 输入解析
// 目录约定 + 静态注册：加平台 = 加一个目录 + 在 platforms 数组加一行 import，核心逻辑零改动。
import bilibili from './bilibili/index.mjs'
import local from './local/index.mjs'
import url from './url/index.mjs'

export const platforms = [bilibili, local, url]

/**
 * 解析输入 → VideoSource 契约对象；无法识别返回 null（由调用方处理）。
 * match() 约定为纯同步快函数，不发网络请求。
 */
export function resolveSource(input, ctx = {}) {
  if (typeof input !== 'string' || !input) return null
  for (const p of platforms) {
    const m = p.match(input)
    if (m) return p.createSource(m, ctx)
  }
  return null
}
