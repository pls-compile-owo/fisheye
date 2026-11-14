# fisheye

[English](./README.en.md) | [中文](./README.md)

> 让 AI agent 按需看图，而不是每 10 秒抓一帧。

一个命令行工具：**在 token 预算内，尽可能看懂一条 B 站视频**。

```
node fisheye.mjs auto BV1xxx --budget 20000
```

---

## 为什么

给 AI 看视频最朴素的做法是「1 秒 1 帧」：

| 方式 | 1 分钟视频 | 40 分钟视频 |
|---|---|---|
| 1 fps 均匀采样 | ~60 帧 ≈ **1.5 万 token** | ~2400 帧 ≈ **60 万 token**（超上下文） |
| fisheye | 1~2 张拼图（9~18 帧）≈ **3~6 千 token** | 12 张拼图 ≈ **3 万 token** |

差别不在「抽得少」，而在**抽得准**——fisheye 判断哪些时间点值得看，以及**用什么方式看最省**。

## 核心思路：四路信息源 + 一个闭环

不是所有信息都要用图片读。按「单位 token 的信息量」排序，能省的先省：

| 优先级 | 信息源 | 成本 | 什么时候用 |
|---|---|---|---|
| ① | **官方字幕**（CC 字幕轨，优先 AI 中文字幕） | 几百 token | 视频有字幕时——文本比图便宜一个数量级 |
| ② | **烧录字幕带**（字幕烧进画面） | ~1000 token | 无官方字幕但画面底部有字幕 |
| ③ | **弹幕热区**（观众反应） | ~100 token | 找观众最激动的时间点，**画面和字幕都看不出这个** |
| ④ | **画面拼图**（3×3 网格） | 1200~3800 token/张 | 兜底：真正需要看画面时 |

然后对少数关键点做**精读**（原分辨率单帧），只在那里花大钱。

## 安装

**前置**：Node.js 18+、ffmpeg

**可选**：Python 3.9+（带 `numpy` 和 `Pillow`）——不装也能用，只是「烧录字幕带」功能会降级

```bash
# 方式一：npm 全局安装（推荐）
npm i -g @pls-compile-owo/fisheye

# 方式二：从源码
git clone <this-repo>
cd fisheye
npm link   # 可选：装成全局命令
```

### 配置 B 站登录态

复制 `credentials.example.json` 为 `credentials.json`，填入三个值：

```json
{
  "sessdata": "<你的 SESSDATA>",
  "bili_jct": "<你的 bili_jct>",
  "buvid3": "<你的 buvid3>"
}
```

获取：浏览器登录 B 站 → F12 → Application → Cookies → `bilibili.com`，复制这三个字段。

> ⚠️ 这个文件已被 `.gitignore` 排除，**永远不要提交**。

### 环境变量

| 变量 | 说明 |
|---|---|
| `FISHEYE_LANG` | CLI 输出语言：`zh`（默认）/ `en` |
| `FISHEYE_TOKENS_PER_GRID` / `FISHEYE_TOKENS_PER_SUBS` / `FISHEYE_TOKENS_PER_FINE` | 单张拼图 / 字幕带 / 精读帧的 token 估算覆盖（默认 1200 / 1000 / 1300） |
| `FISHEYE_TOKEN_MODEL` | 按模型 tokenizer 修正估算：`gpt`（1.0）/ `qwen`（1.35）/ `gemini`（0.8）/ 数字 |
| `FISHEYE_WHISPER` | whisper.cpp 可执行文件路径（音频转写，可选；不装则跳过） |
| `FISHEYE_WHISPER_MODEL` | whisper 模型文件（ggml-*.bin，可选） |
| `FISHEYE_HOME` | 数据目录（cache/out 位置，默认项目目录） |
| `FFMPEG` / `PYTHON` / `BILI_CRED` | 工具与登录态路径覆盖 |

### 依赖路径（一般不用管）

fisheye 按这个顺序找 ffmpeg / python / 凭证：

```
环境变量（FFMPEG / PYTHON / BILI_CRED）
  → ~/.config/fisheye/config.json
  → 项目目录下的 bin/ 和 credentials.json
  → PATH
```

都找不到时才报错，并直接给出修复命令。也可以手动写配置：

```json
// ~/.config/fisheye/config.json
{
  "ffmpeg": "C:/tools/ffmpeg/bin/ffmpeg.exe",
  "python": "C:/Python312/python.exe",
  "credentials": "D:/secrets/bili.json"
}
```

## 快速开始

```bash
# 1. 先自检（0.6 秒，确认依赖/凭证/API 都通）
node fisheye.mjs selftest

# 2. 自动规划并铺网
node fisheye.mjs auto BV1ziWP6qENy --budget 20000

# 3. 看 out/ 目录里的拼图，或读 manifest 决定要不要精读
node fisheye.mjs refine BV1ziWP6qENy

# 4. 精读：截原分辨率单帧
node fisheye.mjs grab BV1ziWP6qENy 82.5,145.0
```

### 常用参数

```bash
--budget 20000          # token 预算（决定张数上限）
--from 1:30 --to 3:00   # 只看一段
--density 6             # 强制 6 秒/帧（覆盖自动推导）
--no-danmaku-frames     # 弹幕热区不参与铺网取帧
--p 2                   # 多 P 视频的第 2 P
```

## 输出

`auto` 会在 `out/` 生成：

| 文件 | 内容 |
|---|---|
| `<BV>-cNN_起-止_3x3.jpg` | 拼图（每格一张画面，从左到右、从上到下按时间排列） |
| `<BV>-subs_N行.jpg` | 字幕带（只有字幕区，竖排 N 行） |
| `<BV>-official-subs.txt` | 官方字幕全文（带时间戳）；另有一份 `-official-subs-plain.txt` 纯文本 |
| `<BV>-manifest.json` | **结构化索引**：每张图的时间范围、每格时间戳、变化强度、弹幕热区、广告段 |

终端输出一份「规划报告」，解释每个决策。

> 下面的示例**拼自三条不同视频**（竖屏猫狗 / LOL 游戏 / 40 分钟长视频），只用来说明每一段的格式——数字之间不用互相推导。

```
[比例] 画面 1080x1920 → 拼图 1920x3414，单张约 3793 token
[内容] 显著变化 14 处，变化率 0.13 次/秒
[字幕] 无可用官方字幕，检出烧录字幕带（82%-90%，置信度 0.63）→ 字幕带 1 张
[广告段] 弹幕密度低谷 1 段：
       04:40-06:40（120s）疑似广告  密度比全片低 34%  关键词「感谢金主爸爸」
[弹幕] 335 条，观众最激动的时段：
       01:25   34 条  「打破桎梏×8」「翻山覆海×3」
[密度] 目标 ≤13s/帧（按变化率推导）
[张数] 密度需要 1 张，预算允许 4 张 → 采用 1 张
[取帧] 00:00-01:49  阈值 0.3，8/9 帧吸附
[拼图 1/1] 00:00-01:49  9 帧 → BVxxx-c00_0000-0109_3x3.jpg
[精读建议] 2 个时间点（几何 1 + 弹幕 1）：
       00:27  弹幕热区  —— 弹幕热区 19 条
```

## 断点续跑

长视频处理中断后，重新跑同样的命令会提示可复用产物：

```bash
node fisheye.mjs auto BV1xxx --budget 20000 --resume   # 跳过已抽帧阶段，复用拼图
node fisheye.mjs auto BV1xxx --budget 20000 --force    # 强制全部重跑
```

## 命令

| 命令 | 作用 |
|---|---|
| `auto <BV>` | 推荐入口：自动规划密度/张数/字幕策略，然后铺网 |
| `grid <BV>` | 只铺网（`--chunk` 秒/段、`--grid` 如 3x3） |
| `subs <BV>` | 只生成字幕带（`--count` 行数、`--band auto\|0.22`） |
| `refine <BV>` | 挑出值得精读的时间点，**并直接截好原图**（三种模式：模板 / 决策文件 / 几何兜底） |
| `grab <BV> <t1,t2>` | 按时间点截原分辨率单帧（手动指定） |
| `local <视频文件>` | 本地视频：ffmpeg 抽帧拼图（`--grid`、`--from`/`--to`） |
| `transcribe <BV>` | 音频转写（whisper.cpp，`--lang zh`） |
| `ocr <图片>` | OCR 识别图片文字（tesseract，`--lang chi_sim+eng`） |
| `url <链接>` | 任意平台视频（yt-dlp 下载后走本地流程） |
| `batch <清单文件\|条目...>` | 批量处理（`--concurrency N` 并发） |
| `clean [--target cache\|out\|all] [--yes]` | 清理缓存/产物（默认 dry-run） |
| `selftest [--deep]` | 自检：依赖 / 凭证 / API / OCR / 转写 / yt-dlp / 缓存 / 磁盘 |

> `grid` / `subs` / `refine` / `grab` 都要求 `cache/<BV>.mp4` 已存在——第一次用请先跑 `auto`（它会下载）。

### 参数范围

| 参数 | 范围 | 默认 |
|---|---|---|
| `--budget` | 2000 ~ 200000 | 20000 |
| `--density` | 0.5 ~ 60（秒/帧） | 按变化率自动 |
| `--p` | 1 ~ 200 | 1 |
| `--chunk`（grid） | 1 ~ 3600（秒） | 按张数算 |
| `--count`（subs） | 1 ~ 50（行） | 自动 |
| `--grid`（grid） | 行列各 1 ~ 9 | 3x3 |
| `--band`（subs） | 0 ~ 0.6（相对高度） | auto |

### refine 的三种挑点方式

| 方式 | 依据 | 成本 |
|---|---|---|
| `--template` | 生成模板，让模型看拼图后填「哪格看不清」 | 已付（看图时） |
| `--decisions <file>` | 按模型的结构化判断截帧 | 已付 |
| 无参数 | **几何兜底**：场景变化强度 ≥0.85 + 弹幕热区 | 每个选中点 1300 token（只截命中的点） |

> `refine` 列完点会**直接执行截帧**（没有「只列不截」的开关）。想先只看建议，用 `refine --template`——它只写模板文件，不截帧。

> 几何规则只能找「画面变化剧烈」，找不出「有文字」——后者必须真的看图。这是工具的设计边界，不是 bug。

## 本地视频

```bash
node fisheye.mjs local <视频文件> [--grid 3x3] [--from 30] [--to 90]
```

不依赖 B站 登录与字幕：ffmpeg 解析时长 → 按 grid 等间隔抽帧拼图 → 输出 `SHEET: <拼图路径>`。
把拼图路径交给模型 `read_image` 即可"看"本地视频。适合 mp4/mkv/avi/mov/webm。

## 音频转写

装了 whisper.cpp 后，可以给无字幕视频做语音转写：

```bash
node fisheye.mjs transcribe BV1xxx [--lang zh]
```

自动探测顺序：`FISHEYE_WHISPER` 环境变量 → PATH → 常见安装路径（含 `~/.dsh/surfcore/whisper/Release/`）。
模型放 `~/.dsh/surfcore/whisper/`（`ggml-*.bin`）或用 `FISHEYE_WHISPER_MODEL` 指定。
转写文本落 `out/<BV>-audio-transcript.txt`。

### 字幕翻译

外文视频（英文/日文等）的官方字幕会同时读取 B站 的**中文翻译轨**（l2 机器翻译），
转写结果旁会打印翻译行数，翻译文本落盘 `out/<BV>-official-subs-translated.txt`。
没有翻译轨的视频不会凭空翻译（不接外部翻译 API）。

## OCR（图片文字识别）

装了 tesseract 后可以识别图片/画面里的文字：

```bash
node fisheye.mjs ocr screenshot.png [--lang chi_sim+eng]
```

自动探测 `FISHEYE_TESSERACT` → PATH → 常见安装路径；语言包缺 `chi_sim` 时自动降级到 `eng`。
识别结果落 `out/<图片名>.ocr.txt`。

## 任意平台视频（yt-dlp）

装了 yt-dlp 后可以直接给任意平台（YouTube/抖音/Twitter…）的链接：

```bash
node fisheye.mjs url "https://www.youtube.com/watch?v=xxx"
```

下载（yt-dlp）→ 自动走本地视频抽帧流程。探测顺序：`FISHEYE_YTDLP` → PATH → 常见安装路径。

## 批量处理

一次处理多个视频（每行一个 BV / 本地路径 / URL，支持 `#` 注释）：

```bash
# 从清单文件
node fisheye.mjs batch list.txt --concurrency 2

# 直接传条目
node fisheye.mjs batch BV1xxx BV2xxx "C:\videos\a.mp4"

# 并发处理（默认 1 串行；失败不中断，最后汇总）
node fisheye.mjs batch list.txt --concurrency 3
```

每一项按类型自动分派：BV → auto、路径 → local、链接 → url。

## 清理

```bash
node fisheye.mjs clean                    # 预览将清理的缓存/产物（dry-run）
node fisheye.mjs clean --target out --yes # 实际删除 out/
```

## MCP server（可选）

`mcp-video-server.js` 把 fisheye 包装成 [MCP](https://modelcontextprotocol.io/)（Model Context Protocol）工具，让支持 MCP 的 agent 环境（DSH / Claude Code / Cursor 等）**不必自己拼命令行**就能看视频。

这是**可选组件**：fisheye 核心保持零依赖，不装下面两个 npm 包也能正常用 `auto` / `local` 等命令。

### 安装

```bash
# 在 fisheye 目录（含 fisheye.mjs 的那层）里执行，会生成 node_modules/
npm i @modelcontextprotocol/sdk zod
```

除此之外还需要同目录的 `fisheye.mjs` + `lib/`、ffmpeg、B站 登录态（见上文「配置 B 站登录态」）。
`vwatch_deep` 的「独立会话复述」额外需要本机安装 **DeepSeek Harness 桌面版**；没有时会自动降级，直接返回抽帧规划 + 官方字幕原文。

### 配置

把 server 注册到 MCP 客户端（Claude Code 写进项目根的 `.mcp.json`；DSH 用同样的 `mcpServers` 结构）：

```json
{
  "mcpServers": {
    "fisheye": {
      "command": "node",
      "args": ["C:/path/to/fisheye/mcp-video-server.js"]
    }
  }
}
```

Windows 路径用正斜杠或双反斜杠。若用 `FISHEYE_HOME` 挪过数据目录，在 `env` 里一并传入：

```json
{
  "mcpServers": {
    "fisheye": {
      "command": "node",
      "args": ["C:/path/to/fisheye/mcp-video-server.js"],
      "env": { "FISHEYE_HOME": "D:/video-cache" }
    }
  }
}
```

### 工具

| 工具 | 作用 | 参数 |
|---|---|---|
| `vwatch_scan` | 快速扫一眼：对开头一段抽帧拼成九宫格，**直接返回画面**（不含文字总结） | `bvid`、`grid`（`3x3` / `4x4` / `5x5`） |
| `vwatch_deep` | 深入看懂：按 token 预算抽帧 + 优先官方字幕 → 交给独立 headless 会话读完 → **只返回完整复述**（不占当前对话上下文） | `bvid`、`from`、`to`、`page`、`budget` |

> 工具名沿用旧名 `vwatch_*`，以免破坏已有的 MCP 配置。参数与 CLI 一一对应：`bvid` → BV 号，`from`/`to` → `--from`/`--to`，`page` → `--p`，`budget` → `--budget`。

## 它怎么工作

```
① 取元信息（分P / 时长 / 分辨率）
② 时间范围（--from/--to）
③ 画面比例 → 单张拼图 token 估算（竖屏是横屏的 3 倍！）
④ 场景检测（ffmpeg 一次解码，320p）→ 内容变化率
⑤ 字幕决策：官方字幕 > 烧录字幕带 > 只看画面
⑥ 弹幕：热区（观众高光）+ 广告段（密度低谷 + 关键词）
⑦ 密度决策：变化率 → 目标帧间隔（4/6/9/13 秒）
⑧ 张数决策：密度需求 vs 预算封顶（硬上限 12 张）
⑨ 铺网：分段 → 取帧（等间隔骨架 + 吸附画面变化点）→ 拼图
⑩ 精读建议：场景变化 + 弹幕热区，避开广告段
```

### 几个关键设计

**为什么取帧是「等间隔 + 吸附」而不是纯关键帧？**

- 只等间隔 → 会漏掉「只闪一两秒的关键画面」
- 只吸附关键帧 → 转场全挤在开头，中段空档
- 混合：等间隔保覆盖，每个基准点在 ±半格内吸附到画面变化点

**为什么字幕带不用 OCR？**

中文 OCR 在低分辨率、花哨排版下错误率高。把字幕带切下来交给多模态模型直接读，反而更准，成本也接近。代价是「一行字幕占一张图的宽度」，所以只切字幕区竖排。

**为什么弹幕能参与取帧？**

B 站的弹幕密度本身就是内容信号。实测一条 40 分钟视频：广告段的弹幕密度只有全片的 **31%**（观众跳过），而观众最激动的地方弹幕密度是 3~5 倍。

**为什么广告段可以不占帧？**

把广告段从时间轴上「压缩掉」，剩余有效时间重新均分——帧数不变，内容密度提升。实测某张图：跳过 118 秒广告后，平均帧间隔从 22.1 秒降到 **8.3 秒**。

## 已知限制

- **只支持 B 站**（接口依赖 BV 号 / cid / 字幕轨）
- **依赖登录态**：部分视频的字幕/播放地址需要 cookies
- **语义盲区**：场景检测只看像素变化，抓不到「同一个场景里的叙事切换」。变化率低的混剪视频可能被判「慢」，需要 `--density` 手动加密
- **广告段检测依赖弹幕**：无弹幕/关弹幕的视频检测不到；且只认「密度低谷 + 广告关键词」，观众讨论热烈的广告可能漏检
- **长视频成本高**：40 分钟视频官方字幕就要 1.2 万 token
- **B 站接口会变**：`selftest` 能帮你快速定位是哪个环节挂了

## 开发

```bash
node --test test/                # 单元测试（全部模块：46 个用例）
node test-danmaku-filter.js      # 弹幕过滤规则测试（51 条用例）
node fisheye.mjs selftest --deep # 含抽帧/字幕带实测的自检
```

项目结构：

| 文件 | 职责 |
|---|---|
| `fisheye.mjs` | CLI 入口（参数解析 / 依赖检查 / 命令分发） |
| `lib/env.mjs` | 路径与依赖解析（ffmpeg / python / 凭证 / 配置） |
| `lib/util.mjs` | 时间格式化 / 参数校验 / 文件头探测 |
| `lib/bili.mjs` | B站 API（视频信息 / WBI 签名 / 官方字幕 / 弹幕） |
| `lib/frame.mjs` | 抽帧与时间点选择（场景检测 / 字幕带定位 / 单帧截取） |
| `lib/danmaku.mjs` | 弹幕分析（广告段检测 / 热区摘要） |
| `lib/stages.mjs` | 六个子命令（auto / grid / subs / refine / grab / local） |
| `test/` | `node:test` 单元测试；CI 见 `.github/workflows/ci.yml` |

更多文档：

- [`docs/DESIGN.md`](docs/DESIGN.md) — 设计决策与取舍
- [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) — 开发日志（十轮迭代，含实测数据）
- [`docs/CONFIG.md`](docs/CONFIG.md) — 配置与故障排查
- [`docs/REVIEW.md`](docs/REVIEW.md) — 验证流程与评审清单（改完代码跑这个）

## 合规

本项目仅用于**个人学习与研究**：

- 请遵守 B 站《用户协议》，勿商用、勿批量抓取
- 登录态 cookies 属于你的账号凭据，**泄露可能导致账号风险**
- 视频与字幕版权归原作者与平台所有，工具输出仅供个人参考

## 致谢

### 灵感来源与代码来源

fisheye 最初作为一个 DSH 插件内部的视频理解命令开发，之后独立为 CLI。
设计思路（官方字幕优先、按变化率选密度、精读闭环）与部分目录约定参考了 **SurfCore**
（QQ ↔ DeepSeek Harness 桥接与 B站 工具插件，MIT License，
Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors）。

`danmaku-filter.mjs`（弹幕垃圾过滤）衍生自 SurfCore 中的同名模块，按 MIT 许可保留原版权声明，
详见 [LICENSE](./LICENSE) 末尾的第三方代码声明。

### 第三方依赖

| 依赖 | 用途 | 许可 |
|---|---|---|
| [ffmpeg](https://ffmpeg.org/) | 抽帧、拼图、字幕带切片 | LGPL/GPL |
| [numpy](https://numpy.org/) · [Pillow](https://python-pillow.org/) | 字幕带位置检测（可选） | BSD / MIT-CMU |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 音频转写（可选，`transcribe` / `--audio`） | MIT |
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) | 图片文字识别（可选，`ocr`） | Apache-2.0 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 任意平台视频下载（可选，`url`） | Unlicense |

### 思想来源

「先粗看再精读」这件事不是新想法，学术上叫 *hierarchical / agentic video understanding*。这个工具的价值不在提出新方法，而在把「token 预算」当成一等约束来工程设计——这一点在开源生态里反而少见，大多数方案默认算力免费。

## License

MIT
