# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.7.2] - 2026-11-14

### Docs

纯文档同步版本（功能与 0.7.1 完全一致，无需重新安装）。

- README 补全：批量处理、字幕翻译、MCP server、OCR、任意平台视频、清理、断点续跑等 0.5～0.7 新增功能的文档。
- 第三方依赖致谢补充 whisper.cpp / Tesseract / yt-dlp。
- 英文 README 补充 More commands 段。

## [0.7.1] - 2026-11-14

### Added

- `auto --resume`：断点续跑完整版——manifest 与计划一致且拼图齐全时**跳过抽帧**，直接复用已有拼图继续后续阶段（`--force` 强制重跑）。

## [0.7.0] - 2026-11-14

### Added

- `batch <清单文件|条目...> [--concurrency N]` 子命令：一次处理多个 BV/本地文件/URL（`lib/batch.mjs`）。
- 字幕翻译：外文视频的官方字幕会同时读取 B站 翻译轨（`translated` 字段，落盘 `<BV>-official-subs-translated.txt`）。
- 断点续跑基础（`lib/resume.mjs`）：manifest 记录计划/阶段，重跑时提示可复用产物（`--force` 强重跑）。
- 进度辅助（`lib/progress.mjs`）：分段抽帧进度、阶段计时。
- MCP server 入包（`mcp-video-server.js`，可选组件，需自装 @modelcontextprotocol/sdk / zod）+ 中英 README + CONFIG 文档。

## [0.6.0] - 2026-11-14

### Added

- OCR 画面文字识别：`ocr <图片路径>` 子命令（tesseract，可选）；selftest 显示 OCR 可用性（`lib/ocr.mjs`）。
- 任意平台视频：`url <视频链接>` 子命令（yt-dlp，可选，下载后走本地视频流程）（`lib/ytdlp.mjs`）。
- `clean [--target cache|out|all] [--yes]` 子命令：清理缓存/产物（dry-run 默认，--yes 才删）。
- `auto --audio`：无官方字幕时自动用 whisper 转写台词，跳过烧录字幕带。

### Changed

- selftest 增加 OCR / yt-dlp 检查项。

## [0.5.0] - 2026-11-14

### Added

- `transcribe <BV> [--lang zh]` 子命令：用 whisper.cpp 转写音频，文本落 `out/<BV>-audio-transcript.txt`。
- `lib/audio.mjs` 自动探测 whisper.cpp 官方 Windows 包解压结构（`whisper/Release/`）。
- 单元测试覆盖扩展到全部模块：retry / budget / i18n / frame / env / audio / bili（共 46 个用例）。
- 外部自检脚本增加「模块导入冒烟」（10 个 lib 模块全部可加载）。

## [0.4.2] - 2026-11-14

### Fixed

- `lib/env.mjs` 缺少 `execFileSync` 导入：`onPath()` 失败导致 PATH 上的 ffmpeg/python 永远无法被识别（影响 `resolveTool` 的 PATH 兜底）。
- `selftest`：PATH 上的 python 无法执行（如 Windows 商店占位符）时降级为跳过而不是失败。

## [0.4.1] - 2026-11-14

### Added

- 音频转写能力探测（`lib/audio.mjs`）：检测 whisper.cpp，`selftest` 显示音频转写是否可用；不可用时优雅提示安装方式。
- README 环境变量表补充 `FISHEYE_WHISPER` / `FISHEYE_WHISPER_MODEL`。

### Fixed

- 首次运行（`out/`、`cache/` 目录不存在）时字幕缓存写入与视频下载不再报 ENOENT。

## [0.4.0] - 2026-11-14

### Added

- B站 API 请求自动重试：网络错误 / 超时 / 5xx / 429 自动重试，指数退避 + 抖动；4xx 不重试（`lib/retry.mjs`）。
- token 预算估算可配置：`FISHEYE_TOKENS_PER_GRID` / `FISHEYE_TOKENS_PER_SUBS` / `FISHEYE_TOKENS_PER_FINE` 覆盖单张成本，`FISHEYE_TOKEN_MODEL`（gpt / qwen / gemini / 数字）按模型 tokenizer 修正（`lib/budget.mjs`）。
- CLI 中英双语：`FISHEYE_LANG=en` 输出英文，默认中文（`lib/i18n.mjs`）。

### Changed

- `lib/bili.mjs` 的请求统一走 `fetchWithRetry`（函数签名与返回值不变）。
- `lib/stages.mjs` 的预算估算改用 `lib/budget.mjs`（默认值与旧 COST 一致）。

## [0.3.0] - 2026-11-14

### Changed

- 主程序拆分为模块：`lib/env.mjs`（路径/依赖解析）、`lib/util.mjs`（时间/参数工具）、`lib/bili.mjs`（B站 API）、`lib/frame.mjs`（抽帧与时间点）、`lib/danmaku.mjs`（弹幕分析）、`lib/stages.mjs`（六个子命令）；入口只保留 CLI 分发。
- `selftest`：缓存目录缺失时不再报错。

### Added

- 单元测试（`node --test`）：参数解析、弹幕分析。
- GitHub Actions CI：Node 18/20/22 语法检查 + 单元测试。

## [0.2.1] - 2026-11-14

首个公开发布版本。

### Added

- 六个子命令：`auto`（自动规划铺网）、`grid`（分段铺网）、`subs`（字幕带）、`refine`（关键帧精读）、`grab`（按时间点截帧）、`local`（本地视频）。
- 四层信息源优先级：官方字幕 → 烧录字幕带 → 弹幕热区 → 画面拼图。
- 字幕带自动定位（行梯度 + 跨帧分位 + 峰值检测）与官方字幕质量判断。
- 九宫格铺网：等间隔骨架 + 吸附画面变化点 + 阈值阶梯 + 去重。
- 关键帧精读：模型决策（--template / --decisions）与几何兜底两种模式。
- 弹幕过滤（刷屏 / 重复 / 引流 / 联系方式）。
- `selftest` 自检：依赖、凭证、API、磁盘。
