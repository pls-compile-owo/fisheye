// 弹幕垃圾过滤（被 fisheye.mjs 和 test-danmaku-filter.js 共用）
// 为什么单独一个模块：测试必须测「真实实现」而不是复制一份规则。
// 之前测试文件里复制了一套 AD_RULES，改 fisheye.mjs 的规则时测试不会报警——回归防护是假的。

// 原则：只掐「明确的广告引流」和「纯无意义刷屏」，**绝不碰梗**。
// 「前面的」「666」「awsl」「哈哈哈哈」「打破桎梏×8」都是观众共鸣信号，
// 过滤掉等于把热区判断的依据砍了。
// 踩过的坑（2026-11-11）：第一版规则太宽，把正常情绪弹幕
// 「没事，这次我不怕了，我再也不怕看这个场面了」当成「主页引流」过滤了——
// 因为 `看` + `这` 命中了 (关注|点|看|进)+(我|这|主页|简介)。
// 教训：单字动词（看/点/戳/滴滴）在中文里太常见，绝不能用；只认「完整短语」。
export const AD_RULES = [
  { re: /(?:加|➕|＋)\s*(?:我|微信|威信|薇信|企鹅|群|q群|Q群|vx|VX|V|v)/, why: '引流' },
  { re: /(?:vx|VX|v信|V信|威信|薇信|weixin|wechat)\s*[:：=]\s*\S/i, why: '微信引流' },
  { re: /(?:私信|私我|私聊)\s*我/, why: '私信引流' },
  { re: /(?:关注我|我(?:的)?主页|我(?:的)?头像|简介(?:里)?有)/, why: '主页引流' },
  { re: /(?:免费|白嫖)\s*(?:送|领|拿)/, why: '诈骗话术' },
  { re: /https?:\/\/|www\./i, why: '链接' },
  { re: /[¥$]\s*\d+|\d+\s*元\s*(?:起|包邮|优惠)/, why: '标价' },
  { re: /(?:^|[^\d])\d{7,11}(?:[^\d]|$)/, why: '疑似联系方式' },   // 7~11 位（6 位可能是正常数字）
]

/** 这条弹幕该不该被过滤？返回原因（空串 = 保留） */
export function spamReason(text) {
  const t = String(text ?? '').trim()
  if (!t) return '空'
  for (const r of AD_RULES) {
    if (r.re.test(t)) return r.why
  }
  // 纯情绪标点是正常弹幕：「？？？」「！！！」「……」「¿」都是 B 站最常见的反应
  // （测试用例里「？？？」第一版就被误杀了，后来「¿」又误杀一次）
  if (/^[？?！!。.、,，~～…·¿¡\s]+$/.test(t)) return ''
  // 纯无意义刷屏（不是梗，是噪声）
  // 表情符号也是正常弹幕（😂😂😂 被判「纯符号」就违背了「绝不碰梗」的原则）
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(t)) return '纯符号'
  // 单字符重复 4 次以上，且是**字母**才过滤。
  // 数字重复不是垃圾——「666」「66666」「1111」在 B 站是梗文化（实测把 66666 误杀过）
  if (/^(.)\1{3,}$/.test(t) && /^[a-zA-Z]$/.test(t[0])) return '重复刷屏'
  return ''
}

/** 批量过滤：返回 { kept, dropped }，dropped 里记账 + 留样本方便核对有没有误伤 */
export function filterDanmaku(list) {
  const kept = []
  const dropped = { ad: 0, noise: 0, samples: [] }
  for (const d of list ?? []) {
    const why = spamReason(d.text)
    if (!why) { kept.push(d); continue }
    if (['引流', '微信引流', '微信/QQ 号', '私信引流', '主页引流', '诈骗话术', '链接', '标价', '疑似联系方式'].includes(why)) dropped.ad += 1
    else dropped.noise += 1
    if (dropped.samples.length < 4) dropped.samples.push(`「${d.text}」→ ${why}`)
  }
  return { kept, dropped }
}
