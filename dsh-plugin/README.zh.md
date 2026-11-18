# fisheye 视频阅读器

注册一个 `video_understand` 工具：通过 [fisheye](https://github.com/pls-compile-owo/fisheye) CLI 读视频，返回视觉模型需要的产物——拼图、字幕/转写笔记和运行 manifest。

> English: [README.md](./README.md)

## 它做什么

| 输入源 | 读取方式 |
|---|---|
| B站 BV 号 | `fisheye auto <BV> --budget N`——有官方字幕优先，否则自适应关键帧拼图 |
| 本地视频文件 | `fisheye local <路径>`——从文件出拼图，可选 whisper 转写 |
| 任意 http(s) 链接 | `fisheye url <url> --budget N`——yt-dlp |

工具**从不判断视频"讲什么"**，只在 token 预算内产出证据（拼图路径、字幕文本、弹幕高光、低活跃段）。摘要交给调用方模型或下游插件。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `fisheyePath` | `fisheye.mjs`（也查 `FISHEYE_CLI` 环境变量、PATH 和 npm 全局安装） | fisheye CLI 入口 |

## 工具参数

- `input`（必填）：BV 号、本地绝对路径或 URL。
- `budget`：token 预算，默认 20000。
- `grid`：`3x3` / `4x4` / `5x5`。
- `range`：可选的 `from-to` 片段（`1:30-5:00`）。

## 限制

- 需要本机装好 fisheye CLI；没装时工具直接返回清晰错误，而不是跑到一半失败。
- 读长视频可能要几分钟；工具会报告 CLI 自己的 token 估算，强制信号源（官方字幕）可能超预算。
