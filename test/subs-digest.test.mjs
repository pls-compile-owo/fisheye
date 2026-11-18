// test/subs-digest.test.mjs — 字幕摘要（四铁律 + fact/op 双通道 + 可压缩性）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectLang, mergeSentences, tokenize, tfidfKeywords, summarizeSegment,
  assessCompressibility, digestSubs, clip, DEFAULT_AD_KEYWORD,
} from '../lib/subs-digest.mjs'

test('detectLang：中文字幕判 zh，英文判 en', () => {
  assert.equal(detectLang([{ content: '大家好今天讲苏联' }]), 'zh')
  assert.equal(detectLang([{ content: 'Welcome to the Soviet Union story' }]), 'en')
})

test('mergeSentences：中文相邻短句合并（≤40 字，前句不以句号结尾），时间戳取前句起点', () => {
  const merged = mergeSentences([
    { from: 0, content: '中国以明显低于市场水平的价格' },
    { from: 3, content: '创纪录地购买了大量的美国玉米' },
  ], 'zh')
  assert.equal(merged.length, 1)
  assert.equal(merged[0].text, '中国以明显低于市场水平的价格 创纪录地购买了大量的美国玉米')
  assert.equal(merged[0].from, 0)
})

test('mergeSentences：句末标点阻断合并', () => {
  const merged = mergeSentences([
    { from: 0, content: '第一句。' },
    { from: 3, content: '第二句。' },
  ], 'zh')
  assert.equal(merged.length, 2, '句号结尾应阻断合并')
})

test('mergeSentences：英文相邻短句合并（≤30 词）', () => {
  const lines = [
    { from: 0, content: 'In the past year' },
    { from: 2, content: 'China bought a lot of grain' },
  ]
  const merged = mergeSentences(lines, 'en')
  assert.equal(merged.length, 1)
})

test('tfidfKeywords：排除全片高频泛词，抽段内特有词', () => {
  // grain 出现在 9/11 句（全片高频泛词），Lysenko 只在 2 句（段内特有）
  const sentences = []
  for (let i = 0; i < 9; i++) sentences.push({ from: i, text: 'grain production in the Soviet Union' })
  sentences.push({ from: 9, text: 'Lysenko denied the existence of genes' })
  sentences.push({ from: 10, text: 'Lysenko theory of inheritance' })
  const kws = tfidfKeywords(sentences, 'en', 3)
  assert.ok(kws.includes('lysenko'), `应含 lysenko，实际 ${kws}`)
  assert.ok(!kws.includes('grain'), 'grain 是全片高频泛词，应被排除')
})

test('summarizeSegment：广告句踢出摘要（铁律 3）', () => {
  const sents = [
    { from: 0, text: '这一期由海力生赞助播出' },
    { from: 1, text: '贝内特发现画不见了' },
    { from: 2, text: '他赶紧去询问保安' },
  ]
  const sum = summarizeSegment(sents, 'zh', { kws: ['贝内特', '不见了'] })
  assert.ok(!String(sum.head.text).includes('赞助'), 'head 不应抽到广告句')
})

test('summarizeSegment：广告句带数字+关键词仍不进 head（P0 回归）', () => {
  // 广告句带数字(90%)+关键词(欧米伽)，过去 ad 扣 5 分仍可能排 head 第一
  const sents = [
    { from: 0, text: '海力生欧米伽三检测纯度90%赞助播出下单立减' },
    { from: 1, text: '贝内特发现画不见了' },
    { from: 2, text: '他赶紧去询问保安' },
  ]
  const sum = summarizeSegment(sents, 'zh', { kws: ['贝内特'] })
  assert.ok(!String(sum.head.text).includes('海力生'), 'head 不应抽到广告口播句')
})

test('summarizeSegment：平台专属广告词（如鱼油）经 adKeyword 参数踢出', () => {
  // 0.3 实测：鱼油/欧米伽/海力生类 UP 主口播词不在通用词表，需平台 adKeyword 扩展
  const adKeyword = /(金主|赞助|鱼油|欧米伽|海力生)/i
  const sents = [
    { from: 0, text: '海力生冻三天三夜欧米伽三检测纯度90%' },
    { from: 1, text: '贝内特发现画不见了' },
  ]
  const sum = summarizeSegment(sents, 'zh', { kws: ['贝内特'], adKeyword })
  assert.ok(!String(sum.head.text).includes('海力生'), '自定义 adKeyword 应踢出广告句')
})

test('summarizeSegment：head/info 截断 60 字（铁律 4）', () => {
  const sents = [{ from: 0, text: '这是一段超过六十个字的很长很长的句子用来测试截断逻辑是否生效到底有没有把六十字以后的字符都切掉呢我们看看结果怎么样' }]
  const sum = summarizeSegment(sents, 'zh', { kws: [] })
  assert.ok(sum.head.text.length <= 61, `head 应 ≤61（含省略号），实际 ${sum.head.text.length}`)
})

test('summarizeSegment：op 双通道（观点句命中）', () => {
  const sents = [
    { from: 0, text: '我请问这合理吗' },
    { from: 1, text: '贝内特说画不见了' },
  ]
  const sum = summarizeSegment(sents, 'zh', { kws: ['贝内特'] })
  assert.ok(sum.op.length >= 1, '观点句应进 op 通道')
  assert.match(sum.op[0].text, /我请问/)
})

test('assessCompressibility：梗句/拟声样本判 false（字全对但摘不出信息）', () => {
  const sents = [
    { from: 0, text: '你喵难道没有教你' },
    { from: 1, text: '不要随便对人哈气' },
    { from: 2, text: '叮咚 叮叮咚' },
    { from: 3, text: '大狗大狗叫' },
  ]
  const r = assessCompressibility(sents, 'zh')
  assert.equal(r.compressible, false)
  assert.ok(r.reasons.length >= 3)
})

test('digestSubs：整条字幕 → 每 4 分钟段摘要', () => {
  const lines = []
  for (let i = 0; i < 10; i++) {
    lines.push({ from: i * 60, content: `第${i}分钟的内容是关于苏联农业的事情` })
  }
  const d = digestSubs(lines, { lang: 'zh', segSec: 240, duration: 600 })
  assert.equal(d.lang, 'zh')
  assert.ok(d.segments.length >= 1)
  assert.ok(d.segments[0].head, '应有 head')
})
