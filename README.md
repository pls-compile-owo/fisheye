# fisheye

[English](./README.en.md) | [中文](./README.md)

> 让 AI agent 按需看图，而不是每 10 秒抓一帧。

一个命令行工具：**在 token 预算内，尽可能看懂一条视频**——不管它来自 B 站、本地文件，还是任意 URL。

```
node fisheye.mjs auto BV1xxx --budget 20000          # B 站
node fisheye.mjs auto video.mp4 --budget 20000       # 本地文件
node fisheye.mjs auto https://... --budget 20000     # 任意 URL（yt-dlp）
```

一个 `auto` 命令通吃多平台，自动识别输入类型，走对应的平台适配器。

---

## 为什么

给 AI 看视频最朴素的做法是「1 秒 1 帧」：

| 方式 | 1 分钟视频 | 40 分钟视频 |
|---|---|---|
| 1 fps 均匀采样 | ~60 帧 ≈ **1.5 万 token** | ~2400 帧 ≈ **60 万 token**（超上下文） |
| fisheye | 1~2 张拼图（9~18 帧）≈ **3~6 千 token** | 12 张拼图 ≈ **3 万 token** |

差别不在「抽得少」，而在**抽得准**——fisheye 判断哪些时间点值得看，以及**用什么方式看最省**。

## 核心思路：多路信息源 + 一个闭环

不是所有信息都要用图片读。按「单位 token 的信息量」排序，能省的先省：

| 优先级 | 信息源 | 成本 | 什么时候用 |
|---|---|---|---|
| ① | **官方字幕**（CC 字幕轨，优先 AI 中文字幕） | 几百 token | 视频有字幕时——文本比图便宜一个数量级 |
| ② | **烧录字幕带**（字幕烧进画面） | ~1000 token | 无官方字幕但画面底部有字幕 |
| ③ | **弹幕热区**（观众反应，B 站） | ~100 token | 找观众最激动的时间点，**画面和字幕都看不出这个** |
| ④ | **画面拼图**（3×3 网格） | 1200~3800 token/张 | 兜底：真正需要看画面时 |
| ⑤ | **语义切分**（话题切换点，可选） | 零 token | 识别视频在哪个时间点换了话题/段落，喂精读建议 |

然后对少数关键点做**精读**（原分辨率单帧），只在那里花大钱。

## 平台适配器

fisheye 核心不认识任何具体平台。每个平台是一个「适配器」，遵循统一契约（`meta` / `media` / `subtitles` / `danmaku` / `adDetector`）：

| 适配器 | 输入 | 能力 |
|---|---|---|
| `bilibili` | BV 号 | 官方字幕 + 弹幕 + 下载 + 广告识别（弹幕族） |
| `local` | 本地文件路径 | 直接抽帧，字幕走转写/字幕带兜底 |
| `url` | http(s) 链接 | yt-dlp 下载，其余同本地 |

加平台 = 照 `lib/platforms/_template/` 抄一个目录 + 注册表加一行 import，不碰核心。**静态注册 + 目录约定**（不是热插拔）：fisheye 是本地 CLI，平台内置随包发布。

### 语义切分（可选）

**随包附带参考实现** `semantic/cli.py`（fastembed embedding + ruptures 变点检测，零 token、纯 CPU）：

```bash
pip install -r semantic/requirements.txt   # fastembed + ruptures + numpy
# 首次运行会自动下载中文 embedding 模型（BAAI/bge-small-zh-v1.5，约 100MB）
```

装好依赖后 `auto` 会自动启用（有官方字幕时）：识别话题切换点写进 manifest 的 `semanticShifts`，并在精读建议里以 `semantic` 来源列出。没有依赖/没装模型时会静默降级，不影响主流程。

想换模型或接自己的 CLI：设 `SEMANTIC_CLI` / `SEMANTIC_PYTHON` 环境变量。自定义 CLI 契约见 `semantic/cli.py` 头部注释（输入 `[{t,text}]`，stdout 输出 `{segments,suggestions}`）。

## macOS 安装（Apple Silicon / Intel）

```bash
# 基础
brew install node ffmpeg python3

# 可选能力
brew install whisper-cpp                 # 音频转写（arm64 产物可能叫 whisper-cpp-darwin-arm64，fisheye 已按前缀自动发现）
brew install tesseract tesseract-lang    # OCR
pip3 install --user yt-dlp               # 任意平台视频

# 语义切分（可选）
pip3 install -r semantic/requirements.txt
```

**Python 依赖**：字幕带检测需要 `numpy` + `Pillow`，必须装在 **fisheye 实际调用的那个 python3** 上：

```bash
python3 -c "import numpy, PIL"   # 自检会用同一解释器验证，缺依赖会显示 [--]
```

**解压**：Windows 打的 zip 在 macOS 上可能解出反斜杠命名的坏文件。推荐直接 `npm i -g @pls-compile-owo/fisheye`，或下载 `npm pack` 生成的 `.tgz`（POSIX 路径安全）。

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

### 配置 B 站登录态（只用 B 站时需要）

复制 `credentials.example.json` 为 `credentials.json`，填入三个值：

```json
{
  "sessdata": "<你的 SESSDATA>",
  "bili_jct": "<你的 bili_jct>",
  "buvid3": "<你的 buvid3>"
}
```

获取：浏览器登录 B 站 → F12 → Application → Cookies → `bilibili.com`，复制这三个字段。

> ⚠️ 这个文件已被 `.gitignore` 排除，**永远不要提交**。本地文件 / URL 平台不需要登录态。

### 环境变量

| 变量 | 说明 |
|---|---|
| `FISHEYE_LANG` | CLI 输出语言：`zh`（默认）/ `en` |
| `FISHEYE_TOKENS_PER_GRID` / `FISHEYE_TOKENS_PER_SUBS` / `FISHEYE_TOKENS_PER_FINE` | 单张拼图 / 字幕带 / 精读帧的 token 估算覆盖（默认 1200 / 1000 / 1300） |
| `FISHEYE_TOKEN_MODEL` | 按模型 tokenizer 修正估算：`gpt`（1.0）/ `qwen`（1.35）/ `gemini`（0.8）/ 数字 |
| `FISHEYE_WHISPER` | whisper.cpp 可执行文件路径（音频转写，可选；不装则跳过） |
| `FISHEYE_WHISPER_MODEL` | whisper 模型文件（ggml-*.bin，可选） |
| `FISHEYE_HOME` | 数据目录（cache/out 位置，默认项目目录） |
| `SEMANTIC_CLI` | 语义切分 CLI 路径（可选；**默认使用随包的 `semantic/cli.py`**） |
| `SEMANTIC_PYTHON` | 跑语义模块的 Python（需带 fastembed + ruptures；不设则用系统 python） |
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

# 2. 自动规划并铺网（B 站 / 本地 / URL 都行）
node fisheye.mjs auto BV1ziWP6qENy --budget 20000
node fisheye.mjs auto video.mp4 --budget 20000
node fisheye.mjs auto "https://www.bilibili.com/video/BV1ziWP6qENy" --budget 20000

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
| `<id>-cNN_起-止_3x3.jpg` | 拼图（每格一张画面，从左到右、从上到下按时间排列） |
| `<id>-subs_N行.jpg` | 字幕带（只有字幕区，竖排 N 行） |
| `<id>-official-subs.txt` | 官方字幕全文（带时间戳）；另有一份 `-official-subs-plain.txt` 纯文本 |
| `<id>-manifest.json` | **结构化索引**：每张图的时间范围、每格时间戳、变化强度、弹幕热区、广告段、`semanticShifts`（语义切换点） |

`<id>` 是「文件名安全」的稳定标识：B 站 = BV 号，本地 = 文件 basename，URL = 规范化后的哈希。终端输出一份「规划报告」，解释每个决策。

> 下面的示例**拼自三条不同视频**（竖屏猫狗 / LOL 游戏 / 40 分钟长视频），只用来说明每一段的格式——数字之间不用互相推导。

```
[比例] 画面 1080x1920 → 拼图 1920x3414，单张约 3793 token
[内容] 显著变化 14 处，变化率 0.13 次/秒
[字幕] 无可用官方字幕，检出烧录字幕带（82%-90%，置信度 0.63）→ 字幕带 1 张
[语义] 切出 3 个话题切换点
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

manifest 带 `version` 字段做格式校验，旧产物自动兼容；格式过新的 manifest 会明确报「请升级 fisheye」而不是静默解析错。

## 命令

| 命令 | 作用 |
|---|---|
| `auto <BV\|文件\|URL>` | 推荐入口：自动识别平台 → 规划密度/张数/字幕策略 → 铺网 |
| `grid <BV>` | 只铺网（`--chunk` 秒/段、`--grid` 如 3x3） |
| `subs <BV>` | 只生成字幕带（`--count` 行数、`--band auto\|0.22`） |
| `refine <BV>` | 挑出值得精读的时间点，**并直接截好原图**（三种模式：模板 / 决策文件 / 几何兜底） |
| `grab <BV> <t1,t2>` | 按时间点截原分辨率单帧（手动指定） |
| `local <视频文件>` | 本地视频快捷方式（等价于 `auto <文件>`） |
| `transcribe <BV>` | 音频转写（whisper.cpp，`--lang zh`） |
| `ocr <图片>` | OCR 识别图片文字（tesseract，`--lang chi_sim+eng`） |
| `url <链接>` | URL 快捷方式（等价于 `auto <链接>`） |
| `batch <清单文件\|条目...>` | 批量处理（`--concurrency N` 并发） |
| `clean [--target cache\|out\|all] [--yes]` | 清理缓存/产物（默认 dry-run） |
| `selftest [--deep]` | 自检：依赖 / 平台适配器 / API / OCR / 转写 / yt-dlp / 语义 / 缓存 / 磁盘 |

> `grid` / `subs` / `refine` / `grab` 都要求 `cache/<id>.mp4` 已存在——第一次用请先跑 `auto`（它会下载）。

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
node fisheye.mjs auto <视频文件> [--grid 3x3] [--from 30] [--to 90]
```

不依赖 B站 登录与字幕：ffmpeg 解析时长 → 按 grid 等间隔抽帧拼图 → 输出 `SHEET: <拼图路径>`。
没有官方字幕时自动尝试 whisper 转写（口播/播客类）；转写不可用则检测烧录字幕带。适合 mp4/mkv/avi/mov/webm。

## 语义识别（可选能力）

fisheye 能识别视频「在哪个时间点换了话题/段落」——用字幕文本（官方字幕优先）+ 本地 embedding + 变点检测，**零 token、纯 CPU**，补上「画面变化 + 弹幕变化」之外的第三层「语义变化」。

- 有官方字幕时自动启用：`auto` 会切出话题切换点，写进 manifest 的 `semanticShifts`，并作为「结构信号」喂给精读建议（`source: 'semantic'`）。
- 无官方字幕时自动跳过（语义切分需要带时间戳的台词）。
- 实现是独立 Python 模块（`src/cli.py` + `fastembed` + `ruptures`，独立 Python 模块））。
模型放到项目 bin/ 或任意目录，用 `FISHEYE_WHISPER_MODEL` 指定。
转写文本落 `out/<id>-audio-transcript.txt`。

> **默认策略**：`auto` 发现视频没有官方字幕时，会自动尝试 whisper 转写；转写文本作为台词源，跳过烧录字幕带。不想用加 `--no-audio` 或设 `FISHEYE_AUTO_AUDIO=0`。

### 字幕翻译

外文视频（英文/日文等）的官方字幕会同时读取 B站 的**中文翻译轨**（l2 机器翻译），
转写结果旁会打印翻译行数，翻译文本落盘 `out/<id>-official-subs-translated.txt`。
没有翻译轨的视频不会凭空翻译（不接外部翻译 API）。

## OCR（图片文字识别）

装了 tesseract 后可以识别图片/画面里的文字：

```bash
node fisheye.mjs ocr screenshot.png [--lang chi_sim+eng]
```

自动探测 `FISHEYE_TESSERACT` → PATH → 常见安装路径；语言包缺 `chi_sim` 时自动降级到 `eng`。
识别结果落 `out/<图片名>.ocr.txt`。

## 任意平台视频（URL）

装了 yt-dlp 后可以直接给任意平台（YouTube/抖音/Twitter…）的链接：

```bash
node fisheye.mjs auto "https://www.youtube.com/watch?v=xxx"
```

下载（yt-dlp）→ 自动走本地视频流程。URL 会先「规范化」（去掉时间戳/分享参数）再哈希做 id，保证断点续跑稳定。

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

每一项按类型自动分派：BV → bilibili、路径 → local、链接 → url。

## 清理

```bash
node fisheye.mjs clean                    # 预览将清理的缓存/产物（dry-run）
node fisheye.mjs clean --target out --yes # 实际删除 out/
```

## 自检

```bash
node fisheye.mjs selftest        # 快速检查依赖 / 平台适配器 / API / 可选组件 / 磁盘
node fisheye.mjs selftest --deep # 额外做抽帧 + 字幕带实测（需缓存视频）
```

检查项：

| 类别 | 检查内容 |
|---|---|
| 基础 | Node 版本、ffmpeg、python（可选）、analyze_subs.py |
| 环境 | 输出目录可写、缓存目录、磁盘剩余 |
| 平台适配器 | 遍历注册表：B 站凭证 / 视频 API / 弹幕 API / 官方字幕 API（含翻译轨） |
| 可选组件 | 音频转写（whisper）、OCR（tesseract）、yt-dlp、语义切分 |

输出标记：`[OK]` 通过、`[--]` 跳过（可选依赖未装/无数据）、`[!!]` 失败。
失败时末尾会打印修复提示；`--deep` 会额外实测抽帧与字幕带检测。

## MCP server（可选）

`mcp-video-server.js` 把 fisheye 包装成 [MCP](https://modelcontextprotocol.io/)（Model Context Protocol）工具，让支持 MCP 的 agent 环境（DSH / Claude Code / Cursor 等）**不必自己拼命令行**就能看视频。

这是**可选组件**：fisheye 核心保持零依赖，不装下面两个 npm 包也能正常用 `auto` 等命令。

### 安装

```bash
# 在 fisheye 目录（含 fisheye.mjs 的那层）里执行，会生成 node_modules/
npm i @modelcontextprotocol/sdk zod
```

除此之外还需要同目录的 `fisheye.mjs` + `lib/`、ffmpeg、B站 登录态（只用 B 站时）。
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
① 解析输入 → 平台适配器（BV / 本地文件 / URL）
② 取元信息（分P / 时长 / 分辨率）
③ 时间范围（--from/--to）
④ 画面比例 → 单张拼图 token 估算（竖屏是横屏的 3 倍！）
⑤ 场景检测（ffmpeg 一次解码，320p）→ 内容变化率
⑥ 字幕决策：官方字幕 > 转写 > 烧录字幕带 > 只看画面
⑦ 弹幕（B 站）：热区（观众高光）+ 广告段（多信号源）
⑧ 语义切分（可选）：embedding + 变点检测 → 话题切换点
⑨ 密度决策：变化率 → 目标帧间隔（4/6/9/13 秒）
⑩ 张数决策：密度需求 vs 预算封顶（硬上限 12 张）
⑪ 铺网：分段 → 取帧（等间隔骨架 + 吸附画面变化点）→ 拼图
⑫ 精读建议：场景变化 + 弹幕热区 + 语义切换点，避开广告段
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

**为什么语义切分不靠大模型？**

把字幕/转写文本做 embedding 相似度 + 变点检测，识别「话题切换点」，零 token、纯 CPU。语义切换点作为「结构信号」喂精读建议，不融合进几何（几何是「内容信号」，语义是「结构信号」，性质不同）。

## 已知限制

- **能力随平台变化**：B 站最全（字幕+弹幕+广告）；本地/URL 无弹幕，广告识别靠「台词族」（字幕/转写关键词+句式），画面 OCR 视觉族未做
- **依赖登录态（仅 B 站）**：部分视频的字幕/播放地址需要 cookies
- **语义切分只对有字幕/对白的视频有效**：无官方字幕且转写不可用时自动跳过；对白少的视频（纯音乐/纯画面）切不出有意义的切换点
- **广告段检测对 B 站（弹幕）最强**：无弹幕平台的台词族是补强，效果弱于弹幕族
- **长视频成本高**：40 分钟视频官方字幕就要 1.2 万 token
- **B 站接口会变**：`selftest` 能帮你快速定位是哪个环节挂了

## 开发

```bash
node --test test/                # 单元测试 + golden 验收集（真实视频样本，离线可跑）
node test-danmaku-filter.js      # 弹幕过滤规则测试（51 条用例）
node fisheye.mjs selftest --deep # 含抽帧/字幕带实测的自检
```

项目结构：

| 文件 | 职责 |
|---|---|
| `fisheye.mjs` | CLI 入口（参数解析 / 输入解析 / 命令分发） |
| `lib/platforms/` | 平台适配器（`bilibili` / `local` / `url` + `_template` 模板 + `_probe` 时长探测 + `index.mjs` 注册表） |
| `lib/env.mjs` | 路径与依赖解析（ffmpeg / python / 凭证 / 配置） |
| `lib/util.mjs` | 时间格式化 / 参数校验 / 文件头探测 |
| `lib/proc.mjs` | 进程探测共用工具（三个可选能力 audio/ocr/ytdlp 共用） |
| `lib/bili.mjs` | B站纯函数 + API（视频信息 / WBI 签名 / 官方字幕 / 弹幕，被 bilibili 适配器调用） |
| `lib/frame.mjs` | 抽帧与时间点选择（场景检测 / 字幕带定位 / 单帧截取） |
| `lib/danmaku.mjs` | 弹幕分析 + 广告段检测（多信号源，关键词参数化） |
| `lib/semantic.mjs` | 语义切分能力探测 + 子进程调用（独立 Python 模块） |
| `lib/executor.mjs` | 精读建议（几何挑点 + 弹幕热区 + 语义切换点合并） |
| `lib/stages.mjs` | 子命令编排（auto / grid / subs / refine / grab / local / ...） |
| `test/` | `node:test` 单元测试；CI 见 `.github/workflows/ci.yml` |

更多文档：

- [`docs/DESIGN.md`](docs/DESIGN.md) — 设计决策与取舍
- [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) — 开发日志（十轮迭代，含实测数据）
- [`docs/CONFIG.md`](docs/CONFIG.md) — 配置与故障排查
- [`docs/REVIEW.md`](docs/REVIEW.md) — 验证流程与评审清单（改完代码跑这个）

## 合规

本项目仅用于**个人学习与研究**：

- 请遵守各平台《用户协议》，勿商用、勿批量抓取
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
| [fastembed](https://github.com/qdrant/fastembed) + [ruptures](https://github.com/deepcharles/ruptures) | 语义切分（可选，独立 Python 模块） | Apache-2.0 / BSD-2 |

### 思想来源

「先粗看再精读」这件事不是新想法，学术上叫 *hierarchical / agentic video understanding*。这个工具的价值不在提出新方法，而在把「token 预算」当成一等约束来工程设计——这一点在开源生态里反而少见，大多数方案默认算力免费。

## License

MIT
