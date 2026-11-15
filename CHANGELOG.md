# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.9.3] - 2026-11-15

### Fixed

- **`grid` 命令在发布包中不可用**：`fisheye.mjs` 的 util 导入漏了 `gridStr`，发布版运行 `grid` 报 `gridStr is not defined`。0.5.0 起发布版一直存在此问题（本地开发版已手动补过但发布物缺），本次修复。感谢用户反馈。

## [0.9.2] - 2026-11-14

### Fixed（外部评审问题修复）

- **广告检测 confidence 与六路信号一致**：字幕关键词 / 数字打点 / 消费回溯 / 片头强信号命中直接判 high（此前只有弹幕关键词才算 high，这些信号不参与「广告不占帧/精读避开」）。
- 消费回溯（buy）要求附近 ≥2 条购买信号，避免观众正常讨论「买了」误报。
- **ensureMp4 流式下载**：不再全量读进内存；超时语义改为「连续 60s 无新数据才中止」，大文件不再被 5 分钟总超时误杀。
- **cleanupVideoSessions** 只清理 mtime 超过 2 小时的僵尸会话，不再误删并发进程正在用的会话。
- **stageLocal 时长探测加 -t 0**：只读 header 立即退出（实测 30s→0.4s），不再解码全片。
- `detectScenes` 开头补 mkdirSync(OUT)（单独跑 grid 时场景检测不再静默失效）。
- 清理未使用导入；frame.mjs 移除未用的 os/spawnSync。
- stageGrab 过滤负数时间点；stageSubs 文件名用实际行数；lowDensity 钳制为 ≥0。
- getOfficialSubs 质量判定统一走 assessSubtitleQuality（消除两处可能不同步的内联实现）。
- stageRefine 的 decisions 越界校验改用 manifest.range（区间外点不再被放过）。
- 精读日志说明 geo 已含弹幕热区。

### Changed

- **抽 `lib/proc.mjs`**：audio / ocr / ytdlp 三个可选模块的进程探测公共代码（capture/whereAll/spawnable/readText/tmpFile/stripQuotes/resolveFfmpeg）收敛为一份实现（评审指出的最大可维护性问题）。

## [0.9.1] - 2026-11-14

### Changed

- **planner / executor 拆分**（重构，行为不变）：
  - `lib/planner.mjs`：纯函数规划器（密度阶梯 / 张数 / 预算钳制 / 成本估算），不碰 IO。
  - `lib/executor.mjs`：几何挑点 + 精读建议（纯数据），`MIN_READABLE_SUBS_PX` 一并移入。
  - `stageAuto` 只做编排：采集信号 → planAuto 决策 → stageGrid/stageSubs 执行。
  - 新增 14 个单测（planner 8 + executor 6），行为与重构前逐行一致（真实 auto 输出对比仅路径差异）。

## [0.9.0] - 2026-11-14

### Added

- **广告段检测六路信号**（基于 8 条人工真值样本校准）：
  - 密度低谷（原有）
  - 关键词聚类（金主/恰饭/商单等弹幕按时间聚类）
  - 片头强信号（开头 90s 内接广类弹幕 → 0-60s 片头广告）
  - 消费信号回溯（已下单/买了 → 之前 120s 为广告口播）
  - **数字打点**（观众自发标记广告结束时间：1407 / 450 / 4:50 / 4.55 / 4；50 / 5分24 等格式）
  - 字幕关键词（口播广告字幕必含下单/链接/优惠等词，需官方字幕）
- 无广告视频防误报：稀疏弹幕守卫（<0.2 条/s 跳过）、片头片尾低置信度段截断、无广告样本断言。

### Changed

- 低置信度广告段最小长度 60s → 45s；边界向两侧扩 15s。

### Tests

- golden 真值样本扩充到 8 条（7 条有广告 + 5 条无广告，其中 3 条同时含字幕），全部命中/零误报。

## [0.8.5] - 2026-11-14

### Added

- **片头广告识别**：视频开头 90s 内出现「接广/金主/恰饭/商单/赞助」等强信号弹幕（哪怕 1 条）时，判定 0-60s 为片头广告段（high）。第四个人工真值样本 BV1j6G16dEBF（0-57s 片头广告）暴露的漏报。

## [0.8.4] - 2026-11-14

### Changed

- **广告段检测增强**（三条人工真值样本校准）：
  - 新增「关键词聚类」信号：广告口播段观众常刷「金主/恰饭/商单」，不依赖密度低谷（42s 短广告常被漏）。
  - 低置信度段最小长度 60s → 45s（覆盖 40-60s 短广告）。
  - 密度低谷段延伸进片头/片尾时改为**截断**（原逻辑整段丢弃会连带丢掉中间真实广告）。
  - 低置信度段向两侧各扩 15s（广告开始前观众还没反应，低密度段偏短）。
- golden 广告真值样本：BV1WhaA6hE7s / BV1LD421H7u4 / BV1qdb16eEF5（覆盖率分别 100%/90%/100%，0 误报）。

## [0.8.3] - 2026-11-14

### Fixed

- 广告段检测：片头/片尾 60s 内的低置信度段不再判为广告（片头低弹幕是正常现象，首次人工真值样本 BV1WhaA6hE7s 暴露的误报）。

### Added

- 广告段真值样本（`test/golden/ad-truth/`）：人工标注广告段 + golden 测试验证覆盖率 ≥80% 且无片头片尾误报。

## [0.8.2] - 2026-11-14

### Fixed

- **广告段检测在稀疏弹幕视频上误报**：弹幕密度低于 0.2 条/秒时密度统计不可靠（艺术短片《利马》127 条/856s 被误标 3 段「低互动段」），改为直接跳过检测（宁漏勿错）。
- golden fixture 补充人工真值标注（利马三段确认非广告）。

## [0.8.1] - 2026-11-14

### Added

- **golden case 验收集**（`test/golden/`）：4 条真实 B站 视频（含字幕/无字幕/高密度弹幕/利马定格片）的字幕与弹幕样本落盘为 fixture，离线验证字幕质量判定、广告段检测、取帧计划的输出与真实回放一致。
- 字幕质量判定提取为纯函数 `assessSubtitleQuality`（bili.mjs），供单测与 golden 用。

## [0.8.0] - 2026-11-14

### Changed

- **auto 默认策略**：无官方字幕时自动尝试 whisper 转写（比抽帧省 token），转写成功则跳过字幕带；用 `--no-audio` 或环境变量 `FISHEYE_AUTO_AUDIO=0` 关闭。`--audio` 保留为显式请求。

### Fixed

- 转写成功后不再多余生成烧录字幕带图。

## [0.7.3] - 2026-11-14

### Docs

纯文档同步版本（功能与 0.7.2 一致）。

- README 新增「自检」专节：selftest 检查项、输出标记（[OK]/[--]/[!!]）、--deep 说明。

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
