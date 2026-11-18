// lib/signals/partitions.mjs — 分区词库（按 B站 tid_v2 粗分区做关键词降级）
//
// 背景：B站 view API 的 tname / tname_v2 已返回空串，但 tid_v2 是稳定的新分区 id，
// 且天然是「粗分区」粒度（知识/科技/汽车/美食/生活/影视…）。
// 不同分区的观众弹幕里，同一个广告词的意义不同：
//   · 科技区：品牌名 + 「下单/赞助/商单」多是调侃/感叹（产品表现好、对官方中文的渴望），
//             真广告的弹幕回应是「感谢金主」「恭喜接广」这类。
//   · 汽车区：F1 等赛事里「赞助」是内容本身（赞助商超级 VIP 视角），不是广告口播。
// 分区覆盖 = 字段级 shallow merge：只覆盖要降级的正则字段，未覆盖字段沿用 DEFAULT_KEYWORDS，
// 未命中的 tid_v2 返回 DEFAULT_KEYWORDS（零回归）。

import { DEFAULT_KEYWORDS } from './index.mjs'

// tid_v2 → 粗分区名（数据驱动：21 条人工标注样本的实际分区分布）
export const TID_V2_PARTITION = {
  2090: '知识', 2089: '知识', 2103: '知识',   // 人文历史 / 时政资讯 / 军事
  2100: '科技', 2099: '科技', 2079: '科技',   // 数码（手机 / 电脑 / 游戏主机）
  2107: '汽车', 2108: '汽车',                 // 汽车 / 汽车·社会
  2149: '美食', 2163: '美食',                 // 美食制作 / 美食探店
  2155: '生活',                               // 日常
  2006: '影视', 2095: '影视',                 // 影视杂谈 / 电影
}

// 分区覆盖词库：只写「该分区需要降级」的字段（相对 DEFAULT_KEYWORDS 删掉某几个词）。
export const PARTITION_OVERRIDES = {
  // 科技区：去掉「商单/赞助/下单」——数码评测语境下多是调侃/感叹：
  //   「一加商单」= 产品表现突出；「PS2 我个人赞助了5台」「火星人下单」= 销量感叹；
  //   「官方中文马上下单」= 对游戏出中文的渴望。
  //   真广告靠「感谢金主/恭喜接广」命中，不受影响。
  科技: {
    ad: /金主|恰饭|硬广|软广|推广|接广|带货|优惠码/i,
  },
  // 汽车区：去掉「赞助」——F1 等赛事里赞助商是内容本身（赞助商超级 VIP 视角）。
  汽车: {
    ad: /金主|恰饭|商单|硬广|软广|推广|接广|带货|下单|优惠码/i,
  },
}

/**
 * 按 tid_v2 解析分区词库：命中分区覆盖则字段级合并，否则返回 DEFAULT_KEYWORDS。
 * @param {number|string|undefined} tidV2 B站 view 的 tid_v2 字段
 * @returns {object} 完整关键词库（ad/strong/mark/buy/sub/pattern 字段齐全）
 */
export function resolveKeywords(tidV2) {
  const p = TID_V2_PARTITION[tidV2]
  const override = p ? PARTITION_OVERRIDES[p] : null
  if (!override) return DEFAULT_KEYWORDS
  return { ...DEFAULT_KEYWORDS, ...override }
}
