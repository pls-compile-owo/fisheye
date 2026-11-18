# 平台适配器模板

English: [README.en.md](./README.en.md)

复制本目录 → 改名 → 填 `match` + `createSource` → 注册，即可接入新平台（不碰核心）。

## 三步接入

1. 复制 `_template` → 改名 `lib/platforms/<你的平台>/`
2. 改 `index.mjs` 的 `id` / `name` / `match()`（识别规则）
3. 填 `createSource()` 的 `meta/media/subtitles/danmaku/adDetector`——**拿不到就返回 `null`**（主流程自动降级）
4. 在 `lib/platforms/index.mjs` 的 `platforms` 数组加一行 `import` + 注册

## 各方法契约（拿不到就 null）

| 方法 | 返回 | 说明 |
|---|---|---|
| `meta()` | `{ title, duration, owner, dimension, pages }` | 元信息 |
| `media(pageNo=1)` | 本地 mp4 路径 | 下载/定位 |
| `subtitles(range)` | `{ body: [{from, content}], quality }` 或 `null` | 官方字幕 |
| `danmaku(range)` | `[{t, text}]` 或 `null` | 弹幕/互动 |
| `adDetector` | `{ adKeywords }` 或 `null` | 广告词证据（平台只声明"能提供什么"，用哪些信号是 fisheye 的判断） |

## 关键约定

- `match(input)` 是**纯同步快函数**，不发网络请求。
- `id` 必须是**文件名安全**的（用于 cache/out/manifest 文件名），完整路径/URL 单独存。
- 重依赖（如 embedding、torch）隔离在适配器内部，核心保持零依赖。
