# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.20] - 2026-11-18

### Docs

- **README 审计修正**（中英）：测试数 198→211（208 通过）；弹幕过滤规则名更正为实际导出 `AD_RULES`/`spamReason()`（原 `AD_PATTERNS`/`NOISE_PATTERNS` 不存在）；环境变量表补齐 `FISHEYE_MIN_SCENE`/`FISHEYE_MAX_PICKS`/`FISHEYE_TESSERACT`/`FISHEYE_YTDLP`/`FISHEYE_AUTO_AUDIO`/`FISHEYE_TRACE`/`FISHEYE_DEBUG`（英文表同步）；参数范围表补 `--concurrency`（1~8）。

## [1.0.19] - 2026-11-18

### Docs

- **多类型视频 token 实测表**（README 中英）：动画 30s（输入 3,852）、科技 130s（7,288）、定格动画 14min（12,339）、历史解说 37.6min（53,557）、科技长视频 57min（22,140）——对比 1 fps 基线省 2~39 倍；新增「同一视频英文轨 vs 中文翻译轨」对比（53,557 vs 15,415，差 3.5 倍）；并说明输出 token 归属（模型侧 300~800，不占 fisheye 预算）。

## [1.0.18] - 2026-11-18

### Docs

- 性能基准补充 **token 消耗实测**（README 中英）：同一条 40 分钟视频，1 fps 基线 `~600,000` vs fisheye 字幕全读（英文原文 `~53,557` / 中文翻译轨 `~15,415`）/ 只看画面 `~3,800`——省 11~158 倍；并点明「优先读中文翻译轨」是压进 2 万预算的关键。

## [1.0.17] - 2026-11-18

### Added

- **调试 trace（`FISHEYE_TRACE=1`）**：新增 `lib/trace.mjs`，`auto`/`local --smart` 采集阶段逐项计时（download / scene-detect / subtitles / transcribe / subtitle-band / danmaku / ad-detection / semantic），写 `out/<id>-trace.json` + stderr 一行摘要；默认零开销，不污染 stdout。
- **集成测试** `test/integration.test.mjs`（4 用例）：真实 CLI 端到端——local 抽帧、local --smart + trace 阶段齐全、selftest、clean dry-run/--yes。
- **退化场景评估** `test/degradation.test.mjs`（9 用例）：无 ffmpeg（隔离 HOME 避免 config 干扰）、文件不存在、损坏视频、空文件、非法 BV、非法参数、损坏 manifest、未知命令——断言「清晰报错 + 非零退出 + 不抛未捕获栈」。

### Tests

- 全量 211 用例（208 通过 + 3 跳过）。

## [1.0.16] - 2026-11-18

### Added

- **性能基准**（README 中英）：40 分钟视频 auto 全流程 75~83 秒（i5-12500H / 16GB / NVMe）、峰值内存 142MB；分阶段拆解显示瓶颈是场景检测（~72s，全片 320p 解码）——抽帧/字幕带/OCR/语义都是秒级。附不同硬件的自测方法。

### Fixed

- **detectScenes 在 OUT 目录不存在时静默返回空**：`lib/frame.mjs` 未先创建输出目录，ffmpeg 的 cwd 不存在导致异常被 catch 成"0 处变化"（首跑/刚清理后场景检测假失败）。已加幂等 `mkdirSync`，修复后同视频检出 673 处变化（此前 0）。

## [1.0.15] - 2026-11-18

### Docs

- README 审计修复（中英）：平台适配器表更正（bilibili 补「字幕关键词」信号、local 描述的是 `auto` 而非 `local` 命令）；语义切分流程描述更新为「纯 JS 词法或 embedding 增强」（1.0.9 起默认纯 JS）；开发命令去掉过时的 `--test-concurrency=1`（与 package.json / ci.yml 对齐）；项目结构表补全 9 个遗漏的 lib 文件（audio / batch / budget / i18n / ocr / progress / resume / retry / ytdlp）。

## [1.0.14] - 2026-11-18

### Changed

- **精读几何阈值参数化**：`executor.mjs` 里硬编码的 `scene >= 0.85`（画面变化强度门槛）和 `slice(0, 8)`（最多挑点数）提取为导出常量 `MIN_SCENE_INTENSITY` / `MAX_PICKS`；`geometricPick`/`buildSuggestions` 接受 `{ minScene, maxPicks }` 覆盖，CLI 可用环境变量 `FISHEYE_MIN_SCENE` / `FISHEYE_MAX_PICKS` 调，不必改代码。

### Tests

- 新增 minScene/maxPicks 覆盖 + 常量默认值测试。
- 全量 198 用例（195 通过 + 3 跳过）零回归。

## [1.0.13] - 2026-11-18

### Added

- **语义切分合成样本量化**：新增 `test/semantic-core.test.mjs`，用「多话题块拼接」的合成台词量化纯 JS 词法切分（char-bigram 漂移）的 recall/precision。基线：3 话题样本 recall 1.0 / precision 1.0（检出 21/41，理想 20/40）；4 话题样本 recall 0.67 / precision 1.0。并诚实标注「词汇重叠话题」的局限——不强求切准，那正是 embedding 增强（`semantic/cli.py`）的用武之地。

### Tests

- 全量 195 用例（192 通过 + 3 跳过）零回归。

## [1.0.12] - 2026-11-18

### Added

- **产物完整性摘要**：`auto`/`--smart` 跑完打印一行 `[产物] 字幕✓6 · 弹幕✓555 · 广告— · 语义— · 转写— · 字幕带—`，用 ✓（得到）/ △（质量差）/ ○（跳过）/ —（无）区分每个信号源「给没给到东西」；同时写进 manifest 的 `coverage` 字段。Agent 一眼看清这次缺了哪块，不再靠翻日志猜「静默降级」。

## [1.0.11] - 2026-11-18

### Added

- **`local`/`url` 子命令 `--smart` 标志**：默认仍是「快速均匀抽帧拼一张图」（最轻量），加 `--smart` 才走 `auto` 的完整采集管线（多路信号 + 字幕带 + 转写 + 广告识别 + 语义切分）。补齐「非 B 站视频多路信号」缺口——此前 `local`/`url` 子命令是纯抽帧器，没接统一采集。
- CLI 抽取 `runAuto()`：`auto` 与 `local`/`url --smart` 共用同一套决策参数解析，消除重复。

### Fixed

- README 命令表更正：`local`/`url` 不再标「等价 auto」（默认是快速抽图，`--smart` 才等价）。

### Tests

- 全量 192 用例（189 通过 + 3 跳过）零回归。

## [1.0.10] - 2026-11-18

### Added

- **广告信号源可插拔**：七路广告信号（弹幕密度/关键词/打点/片头/消费 + 字幕关键词/句式）从 `detectAdSegmentsCore` 拆成可注册信号源（`lib/signals/`），按 `primary`（主信号）/`secondary`（补充）/`subtitle`（台词族）分组编排；加新信号 = 注册表加一行 + 平台在 `signals` 数组声明。
- **非 B 站信号增强**：本地/URL 视频的 whisper 转写 segments 喂入台词族信号与语义切分——无弹幕平台也能做广告口播识别和话题切换（此前 `transcript` 未接入，台词族信号是摆设）。

### Changed

- `collect.mjs`：转写成功后生成带时间戳 `transcriptLines`，喂广告检测（`transcript` 参数）与语义切分（官方字幕优先、转写兜底）。
- `lib/danmaku.mjs`：广告检测入口与常量移到 `lib/signals/`，原 import 路径不变（re-export 兼容）。

### Tests

- 新增 `test/signals.test.mjs`：注册表完整性 / transcript 转写路径 / 信号可插拔组合 / 句式门槛。
- 全量 192 用例（189 通过 + 3 跳过），golden 广告真值 8 条零回归。

## [1.0.9] - 2026-11-18

### Changed

- **字幕带检测纯 JS 化（解除 python 依赖）**：删除 `analyze_subs.py`（numpy + Pillow），改为 `lib/band.mjs`——ffmpeg 输出 P5 灰度 PGM（自带宽高头），JS 读字节算行梯度 → 跨帧低分位 → 平滑找峰 → 扩展边界，输出与 python 版对齐（bandRatio/confidence 一致，top/bot 差 2px 内）。
- **语义切分纯 JS 兜底**：新增 `lib/semantic-core.mjs`（char-bigram 词法漂移 + top-k 峰值），无 python 时也能切话题切换点；embedding 增强（`semantic/cli.py` + fastembed）保留为可选，探测到 python 才启用。
- **selftest 更新**：移除 python / analyze_subs.py 检查项，字幕带实测改为纯 JS `detectBand`（跨全片 24 帧），新增「语义切分」能力检查。

### Removed

- `analyze_subs.py`（numpy + Pillow 的 python 依赖，已被 `lib/band.mjs` 取代）。

### Tests

- 语义模块单测重写：纯 JS 兜底 / embedding 增强 / 词法切分 / cosine 区分度 / 输入校验。
- 全量 186 用例（183 通过 + 3 跳过），golden 广告真值 8 条零回归。

## [1.0.8] - 2026-11-18

### Docs

- README 全量重写（中英）：修正过时路径（`src/cli.py` → `semantic/cli.py`）、移除已删的 `docs/EXPERIMENTS.md` 引用、补全测试数（176 + 51 弹幕用例）与广告真值（8 条）、token 常量（1200/1000/1300）。
- 新增「可调参数与扩展点」章：广告检测三档（keywords / signals / detect）、弹幕过滤词表、预算模型、抽帧密度、语义切分外部 CLI 契约、精读阈值。
- 输出产物表补 `-official-subs-translated.txt`；项目结构表补 `collect.mjs` / `planner.mjs` / `executor.mjs` / `selftest.mjs` / `dsh-plugin/`。

## [1.0.7] - 2026-11-18

### Fixed

- **隐私清理**：`lib/audio.mjs` 移除 `.dsh/surfcore/whisper/Release` 探测候选，`lib/ocr.mjs`/`lib/ytdlp.mjs` 注释去掉本机路径；`docs/make-demo-*.py` 默认路径改为环境变量/临时目录（不再含用户名绝对路径）。README 中的 SurfCore 署名保留（开源衍生致谢）。

## [1.0.6] - 2026-11-18

### Added

- **DSH 插件 `@pls-compile-owo/dsh-fisheye`**（本仓库 `dsh-plugin/`）：把 fisheye 注册成 agent 的 `video_understand` 工具，返回拼图/字幕/弹幕证据，供模型或下游插件消费。已发布 npm，可被 DSH 插件目录站收录。
- README 中英版新增「DSH 插件」安装节。

## [1.0.5] - 2026-11-18

### Docs

- README 标题改为 `fisheye · tokencut`（搜索关键词），README.en 同步。
- GitHub About 描述与 Topics 更新（新增 tokencut / mcp / video-summary / whisper / danmaku / deepseek）。
- npm keywords 补充 tokencut / video-summary / mcp / danmaku / deepseek，让 npm 搜索可命中。

## [1.0.4] - 2026-11-17

### Docs

- 新增演示 GIF（`docs/demo-en.gif` 英文 / `docs/demo-zh.gif` 中文），展示「输入视频 → 规划抽帧 → 3x3 拼图 → AI 摘要」全流程；README 中英版顶部引用。
- 生成脚本随包：`docs/make-demo-gif-en.py` / `docs/make-demo-gif.py`。

## [1.0.3] - 2026-11-17

### Tests

- executor 补「字幕糊」分支测试（2 用例）：拼图里字幕低于 12px 且未被字幕覆盖时建议精读；字幕已覆盖（官方文本/转写）时不建议——锁定核心价值分支，防条件写反后静默失效。
- 全量 176 用例（173 通过 + 3 跳过）。

## [1.0.2] - 2026-11-17

### Changed（编排层解耦 + 测试）

- **抽 `lib/collect.mjs`（采集层）**：stageAuto 里的下载/元信息/场景/字幕(官方/转写/字幕带)/弹幕/广告/语义采集抽成 `collectSignals(source, opts)`，返回纯数据 ctx；stageAuto 只剩「采集 → planner 决策 → stageGrid 执行 → executor 建议 → 输出」。广告分发 `detectAds` 一并移入。
- **抽 `lib/selftest.mjs`**：stageSelftest（180 行）从 stages.mjs 独立；stages.mjs 保留 re-export 兼容。
- **新增编排层测试** `test/orchestration.test.mjs`（9 用例）：mock 平台 source + 临时假视频，覆盖 collectSignals 契约、官方字幕/质量差分支、range 校验、detectAds 分发——补上编排层此前零覆盖的短板。

### Tests

- 全量 174 用例（171 通过 + 3 跳过），0 失败。

## [1.0.1] - 2026-11-17

### Fixed（macOS 安装复盘）

- **A1 音频转写坏**：`lib/audio.mjs` 缺 `spawnSync` import（解耦重构漏移），转写时报 `spawnSync is not defined`。已补，实测转写通过。
- **A5 whisper 命名**：arm64 macOS 产物 `whisper-cpp-darwin-arm64` 不被识别——自动发现加 `whisper-cpp-*` 前缀通配。
- **A6 输出目录假象**：selftest 写可写性检查前先幂等 `mkdir -p out`，"目录不存在"不再被误报为不可写。
- **A3 解释器一致性**：selftest 的 python 检查改为对**实际调用的解释器**跑 `-c "import numpy, PIL"`；缺依赖显示 `[--]` 并说明降级，而不是"python 在"就 OK。
- **字幕带实测误报**：python 依赖不可用时标记跳过而非失败。

### Added（A2/C 自检端到端）

- `selftest --deep` 新增真实调用链样例：ffmpeg testsrc 1s 解码、OCR 识别随包样图、whisper 静音 3s 转写、语义 3 行台词切分（校验输出契约）。
- README 新增「macOS 安装」节（brew 依赖、Python 解释器要求、zip 反斜杠问题与 npm/tgz 建议）；英文 README 同步。

## [1.0.0] - 2026-11-17

### Added

- **平台解耦**：核心改为平台无关，B 站/本地/URL 通过「平台适配器」接入（静态注册 + 目录约定），`auto <BV|文件|URL>` 一个命令通吃。
- **平台适配器**：bilibili / local / url 三个内置适配器 + `_template` 模板（复制即接入新平台）+ `_probe` 时长探测 + 注册表。
- **广告识别平台化**：六路信号拆成可组合多信号源 + 关键词参数化 + 台词族（无弹幕增强）+ confidence 修复（台词族命中 → high）。
- **语义识别模块**（可选能力）：embedding + 变点检测识别话题切换点，零 token 纯 CPU；`semanticShifts` 写 manifest，语义切换点喂精读建议（`source:'semantic'`）。
- **manifest 版本校验**：`version` 字段 + `loadManifestState` 校验（旧产物兼容、过新报错）。
- **`lib/proc.mjs`**：三个可选能力（audio/ocr/ytdlp）共用进程探测工具抽取。

### Changed

- **selftest**：改为遍历平台适配器自检，不再硬编码 B 站。
- **广告台词族门槛**：句式 ≥2 命中、关键词 ≥3 命中或持续 ≥30s（避免正文吐槽误报）。
- **URL 规范化哈希**：去掉时间戳/分享参数再哈希，断点续跑稳定。
- **本地/URL 平台**：无弹幕走台词族广告识别，字幕走转写/字幕带兜底。

### Fixed

- 广告 confidence 只由弹幕关键词决定的缺陷（台词族命中不参与「广告不占帧」）。
- 止损线「召回≥60% 且 误报≤2/10min」联合通过线（修复召回<60% 不触发的漏洞）。

### Tests

- 全量 148 用例（147 通过 + 1 跳过），golden 广告真值 8 条保持零回归。

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
