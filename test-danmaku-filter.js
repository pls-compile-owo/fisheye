// 弹幕过滤规则测试
// 关键：这里 import 的是 fisheye.mjs 实际使用的**同一份实现**（danmaku-filter.mjs），
// 而不是复制一套规则。之前复制版的后果是——改 fisheye.mjs 的规则时测试不会报警，
// 「48 用例」的回归防护是名义上的。
import { spamReason } from './danmaku-filter.mjs';

// 必须保留的（误伤即失败）
const KEEP = [
  // 数字梗
  '666', '66666', '666666', '111', '1111', '233', '888',
  // 网络流行语 / 情绪
  'awsl', '哈哈哈哈', '笑死我了', '好家伙', '前方高能',
  // 纯情绪标点
  '？？？', '？？？？', '！！！', '!!!', '。。。', '……', '啊？', '¿',
  // 表情符号（Extended_Pictographic）
  '😂', '😂😂😂', '🤣🤣',
  // 正常叙述（含敏感单字，之前踩过误伤）
  '前面的说得对', '看这个场面我也哭了', '找我妈呢', '点赞了', '加了个群好吵',
  '打破桎梏', '这一段配上音乐真是压抑到极致后的爆发啊', '妈妈问我为什么跪着看视频',
  '没事，这次我不怕了，我再也不怕看这个场面了',
];

// 必须过滤的
const DROP = [
  // 广告引流
  '加我vx abc123', '加微信领取', '私信我', '私信我领取福利', '关注我主页',
  '我的主页有资源', '免费送皮肤', 'https://x.com', 'www.abc.com', '¥99',
  '123456789', '欢迎加群交流', '加我领取资料', '简介有福利',
  // 噪声
  'aaaa', 'zzzz', '@@@@', '※§¤', '',
];

let pass = 0;
const fails = [];

for (const t of KEEP) {
  const r = spamReason(t);
  if (r === '') pass++;
  else fails.push(`[应保留] 「${t}」→ 被判 ${r}`);
}
for (const t of DROP) {
  const r = spamReason(t);
  if (r !== '') pass++;
  else fails.push(`[应过滤] 「${t}」→ 保留了`);
}

const total = KEEP.length + DROP.length;
console.log(`通过 ${pass}/${total}`);
if (fails.length) {
  console.log('\n失败：');
  fails.forEach((f) => console.log('  ' + f));
} else {
  console.log('✅ 全部通过');
}
// 失败必须返回非零，否则 npm test / CI 永远是绿的，回归防护形同虚设
process.exit(fails.length ? 1 : 0);
