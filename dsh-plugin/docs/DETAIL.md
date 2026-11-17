# fisheye video reader

给 DSH agent 增加 `video_understand` 工具：把 B 站视频 / 本地文件 / 任意链接交给 fisheye CLI 按 token 预算阅读，返回拼图、字幕与弹幕要点。

## 行为

| 输入 | 调用 |
|---|---|
| BV 号 | `fisheye auto <BV> --budget N`（官方字幕优先，否则自适应九宫格） |
| 本地文件 | `fisheye local <path>`（抽帧拼图，可选 whisper 转写） |
| URL | `fisheye url <url> --budget N`（yt-dlp） |

工具只产出证据（拼图路径、字幕文本、弹幕热区、广告段），不负责"理解"——摘要由调用方模型或下游插件完成。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `fisheyePath` | `fisheye.mjs`（也查 `FISHEYE_CLI` 环境变量与 PATH） | fisheye CLI 入口 |

## 限制

- 需要本机已安装 fisheye CLI；缺失时返回明确错误，不会中途失败。
- 长视频可能耗时数分钟；工具会报告 CLI 的 token 估算，官方字幕等必要来源可能超预算。
