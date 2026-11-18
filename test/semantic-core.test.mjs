// test/semantic-core.test.mjs — 语义切分「合成样本量化」
//
// 量化目的：给纯 JS 词法切分（char-bigram 漂移）一个可复现的客观指标，而不是只有「能跑」的冒烟测试。
// 方法：构造「多个话题块拼接」的合成台词，理想切点 = 话题边界；用 recall（真边界检出率）和
// precision（检出切点里有多少真边界）两个指标量化。合成样本可离线复现，不依赖网络/模型/真值数据集。
//
// 诚实边界：char-bigram 是词法近似，对「词汇差异明显」的话题切分有效；对「词汇重叠、语义微调」的
// 话题（如「猫的饲养」vs「猫的医疗」）区分度弱——这正是 embedding 增强存在的意义。难样本单独验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import { segmentPureJs } from '../lib/semantic-core.mjs'

// 话题块拼接成台词行（每行 t 递增）
function lines(...topics) {
  const out = []
  let t = 0
  for (const sentences of topics) {
    for (const s of sentences) out.push({ t: t++, text: s })
  }
  return out
}

// 量化：idealBoundaries = 话题边界（行索引）；检测切点落在 ±tol 行内算命中（每个检出点只匹配一个边界）
function evaluate(ls, idealBoundaries, nBkps, tol = 5) {
  const out = segmentPureJs(ls, { nBkps })
  const detected = out.segments.map((s) => s.t)
  const used = new Set()
  let matched = 0
  for (const ideal of idealBoundaries) {
    const idx = detected.findIndex((d, i) => !used.has(i) && Math.abs(d - ideal) <= tol)
    if (idx >= 0) { matched++; used.add(idx) }
  }
  return {
    recall: matched / idealBoundaries.length,
    precision: detected.length ? matched / detected.length : 0,
    detected, idealBoundaries,
  }
}

// —— 样本一：3 个词汇差异明显的话题（猫饲养 / 量子计算 / 家常菜谱），理想边界 [20, 40] ——
const CAT = ['猫咪需要定期梳理毛发', '猫粮要选择高蛋白的', '猫砂盆要每天清理', '猫咪喜欢晒太阳', '绝育对猫咪健康有益', '猫咪喝水要充足', '猫抓板必不可少', '猫咪疫苗要按时打', '猫咪体重管理很重要', '猫薄荷能让猫兴奋', '猫咪讨厌洗澡', '猫的寿命大约十五年', '猫咪会自我清洁', '猫咪夜间更活跃', '猫眼睛会反光', '猫咪喜欢钻纸箱', '猫咪会踩奶', '猫咪呼噜声表示舒服', '猫咪尾巴表达情绪', '猫咪需要定期体检']
const QUANTUM = ['量子比特可以叠加', '量子纠缠是奇妙现象', '量子门操作量子比特', '量子退相干是挑战', '量子纠错很关键', '量子算法比如肖尔算法', '量子霸权已实现', '量子计算需要低温', '量子比特容易受噪声', '量子线路图描述算法', '量子测量会坍缩', '量子隐形传态是协议', '量子密码学不可破解', '量子模拟帮助科研', '量子硬件发展迅速', '量子优势竞赛激烈', '量子纠缠分发实验', '量子中继器很关键', '量子计算前景广阔', '量子机器学习是方向']
const COOK = ['先准备新鲜食材', '热锅冷油下蒜末', '翻炒要大火快炒', '调味要适量', '盐要最后放', '勾芡让汤汁浓稠', '装盘要美观', '火候是关键', '切菜要均匀', '焯水去腥', '腌制入味', '炖汤要小火慢炖', '炒青菜别太久', '蒸鱼要水开上锅', '红烧要收汁', '凉拌要现拌现吃', '出锅前淋香油', '主食搭配米饭', '汤品要趁热喝', '剩菜要冷藏保存']

// —— 样本二：4 个话题（天气 / 编程 / 健身 / 旅行），理想边界 [15, 30, 45] ——
const WEATHER = ['今天天气晴朗', '明天会下雨', '气温明显回升', '西北风四级', '空气质量良好', '出门记得带伞', '早晚温差较大', '午后有雷阵雨', '湿度偏高', '紫外线指数强', '周末转晴', '夜间降温明显', '适合户外活动', '注意防晒', '云层逐渐增厚']
const CODING = ['变量要先声明', '函数要写清楚', '循环注意边界', '递归要设出口', '空值要判空', '异常要捕获', '命名要有语义', '注释别写废话', '测试覆盖边界', '重构小步走', '依赖越少越好', '日志要可读', '版本要语义化', '提交信息要清楚', '代码要可读']
const FITNESS = ['先热身五分钟', '深蹲注意姿势', '硬拉别弓背', '卧推要有保护', '每组间休息一分钟', '拉伸别省略', '蛋白质要补够', '睡眠是恢复关键', '循序渐进加重量', '动作要标准', '呼吸别憋气', '练完要拉伸', '强度别过度', '核心要收紧', '每周练三次']
const TRAVEL = ['订机票要提前', '酒店要看评价', '行程别排太满', '护照要检查有效期', '行李别超重', '当地交通先查好', '现金和卡都备点', '保险要买好', '时差要倒过来', '美食要尝当地', '纪念品别乱买', '手机流量要开通', '住宿位置要方便', '天气要提前看', '应急电话要存好']

test('量化：3 话题（词汇差异明显）recall 与 precision 达标', () => {
  const ls = lines(CAT, QUANTUM, COOK)
  const r = evaluate(ls, [20, 40], 3)
  assert.ok(r.recall >= 0.8, `recall=${r.recall.toFixed(2)}（检出 ${JSON.stringify(r.detected)}，理想 ${JSON.stringify(r.idealBoundaries)}）`)
  assert.ok(r.precision >= 0.5, `precision=${r.precision.toFixed(2)}（检出 ${JSON.stringify(r.detected)}）`)
})

test('量化：4 话题（词汇差异明显）recall 达标', () => {
  const ls = lines(WEATHER, CODING, FITNESS, TRAVEL)
  const r = evaluate(ls, [15, 30, 45], 4)
  assert.ok(r.recall >= 0.6, `recall=${r.recall.toFixed(2)}（检出 ${JSON.stringify(r.detected)}，理想 ${JSON.stringify(r.idealBoundaries)}）`)
})

// —— 难样本：两个「词汇重叠、语义微调」的话题（猫饲养 vs 猫医疗）——
// 诚实边界：char-bigram 对这类话题区分度弱（都含「猫/猫咪」字），这里只断言「不崩、返回合法结构」，
// 不强求切准——这正是 embedding 增强（semantic/cli.py）存在的原因。
const CAT_CARE = ['猫咪每天要吃两顿饭', '猫粮要选高蛋白', '猫砂盆要每天清理', '猫咪喜欢晒太阳', '猫抓板必不可少', '猫咪要定时喂水', '猫窝要经常晒', '猫咪需要梳毛', '猫零食别喂太多', '猫咪要控制体重', '猫玩具要多备几个', '猫咪需要陪伴']
const CAT_MEDICAL = ['猫咪要定期打疫苗', '猫生病要看兽医', '猫的驱虫很重要', '猫咪绝育要趁早', '猫的牙齿要护理', '猫咪耳螨要治疗', '猫的皮肤病常见', '猫咪要定期体检', '猫的关节炎要预防', '猫咪口腔要清洁', '猫的寄生虫要防', '猫咪术后要护理']

test('难样本：词汇重叠话题不崩，返回合法结构（不强求切准）', () => {
  const ls = lines(CAT_CARE, CAT_MEDICAL)
  const out = segmentPureJs(ls, { nBkps: 1 })
  assert.ok(Array.isArray(out.segments))
  for (const s of out.segments) {
    assert.equal(typeof s.t, 'number')
    assert.ok(Array.isArray(s.signals))
  }
})
