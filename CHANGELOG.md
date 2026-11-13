# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范与 [语义化版本](https://semver.org/lang/zh-CN/)。

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
