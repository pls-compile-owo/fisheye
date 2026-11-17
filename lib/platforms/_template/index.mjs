// lib/platforms/_template/index.mjs — 平台适配器模板（复制改名即可接入新平台）
// 三步接入：
//   1. 复制本目录 → 改名 lib/platforms/<你的平台>/
//   2. 改下面的 id / name / match() 识别规则
//   3. 填 createSource() 的 meta/media/subtitles/danmaku/adDetector（拿不到就返回 null，主流程自动降级）
//   4. 在 lib/platforms/index.mjs 的 platforms 数组加一行 import + 注册
export default {
  id: 'your-platform',               // 注册表唯一 key
  name: '你的平台名',
  description: '一句话描述',
  requires: { tools: ['ffmpeg'] },   // 依赖声明（selftest 用；可加 credentials）

  // 纯同步快函数，不发网络请求；不是我的输入返回 null
  match(input) {
    // TODO: 改成识别规则，命中返回 { id: '文件名安全的稳定标识' }
    // 例：return /^XX\d+$/.test(input) ? { id: input } : null
    return null
  },

  createSource(match) {
    const id = match.id
    return {
      kind: 'your-platform',
      id,                              // 文件名安全 key（用于 cache/out/manifest）
      label: id,

      // meta()：元信息（title/duration/pages 供主流程用）
      async meta() {
        return {
          title: id,
          duration: 0,
          owner: null,
          dimension: { width: null, height: null },
          pages: [{ cid: null, duration: 0, part: '' }],
        }
      },

      // media(pageNo=1)：返回本地 mp4 路径（下载/定位）
      async media() { throw new Error('TODO: 实现 media()') },

      // subtitles(range)：官方字幕 { body: [{from, content}], quality } | null
      async subtitles() { return null },

      // danmaku(range)：弹幕 [{t, text}] | null
      async danmaku() { return null },

      // adDetector：广告识别（可选；null = 该平台不做广告识别）
      // 形态：{ keywords: DEFAULT_KEYWORDS, signals: ['sub-keywords','sub-patterns'] }
      adDetector: null,
    }
  },

  // 可选：平台专属自检（stageSelftest 遍历调用）
  // async selftest(ctx) {
  //   const { rec } = ctx
  //   rec('OK', '平台自检', '说明')
  // }
}
