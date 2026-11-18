# fisheye 2.0 进度与上下文恢复锚点

> 本文是会话上下文浓缩版：接续工作时先读这里，再按需读对应模块文档。
> 设计文档唯一真相在 [`docs/2.0/`](./)（11 模块）；本文只做进度与决策索引。

## 一、这是什么

fisheye 2.0 = 把 B站/本地/URL 视频压成「**证据 + 成本**」，判断归 agent，成本优先。

- **1.0.29 的问题**：全量读图 + 字幕全文，40 分钟视频 ~51k~95k token；广告七路判断层过重。
- **2.0 的改法**：默认只产文本（段卡片 + 字幕骨架 + 弹幕情绪），省 **25~32 倍**；图按需渲染（`render --plan`）。

## 二、核心设计（11 模块，见 docs/2.0/）

| # | 模块 | 一句话 |
|---|---|---|
| 00 | 总纲 | 定位、成本链路、铁律、执行计划、验收 |
| 01 | 证据体系 | 三源 × 可用性 × 三轨；null ≠ 0；视觉授权三档 |
| 02 | 字幕链路 | 摘要四铁律 + fact/op 双通道 + 可压缩性 |
| 03 | 弹幕链路 | 情绪双分数 + 分位数 + √压缩 + top 样本 |
| 04 | 语义切分 | 默认纯 JS，外挂 `SEMANTIC_CLI` |
| 05 | 广告识别 | 七路砍两路 + adKeywordHits 纯线索 |
| 06 | 工作流 | 主 agent / 子会话 / fisheye 三方 |
| 07 | 性能优化 | 共享解码、批量抽帧、两段式下载、API 缓存 |
| 08 | 人类自检 | report.html 唯一入口 + stdout/stderr 分离 |
| 09 | 成本报价 | 1024/图、text 2000、rel 0.51、imageModel |
| 10 | agent 指南 | skill 形态、fine 门槛、visualRequest |

## 三、铁律（违反即返工，详见 HANDOFF §2）

1. **图片单价 1024 token/张**（官方 Flash 上限；精确约 945~968）。旧常量 1200/3800 禁止。
2. **text 锚点 2000**（段卡片 800 + 骨架 1200）。
3. **默认不渲染**：`auto` 不生成 jpg，`render` 才生成。
4. **判断归 agent**：类型/情绪/广告都只给"线索/量级/建议"。
5. **null ≠ 0**：缺失给 `null` + `confidence`。
6. **w=0.3 只在 render 的 algorithm 轨**；纯文本只标布尔 lowActivity。
7. **fast 档 changeRate=null**：类型判定输出 `{type:null, confidence:0, reason:'changeRate unavailable (fast mode)'}`，不是 `unknown`。

## 四、关键决策记录（都已验证）

| 决策 | 依据 |
|---|---|
| **图片 348 → 1024** | 0.5 验证：官方 vision 规则换代（旧 vision-exp 384 上限 → 现 1024 上限/1300×1300 缩放）。见 `verify/口径变更-348-to-1024.md` |
| **七路砍两路** | 0.1 验证：两路召回 = 七路 = 100%（27 真值），五路零独立命中 |
| **吸附单档 0.3** | 0.2 验证：93% 段三档不降档，7% 降档信息量差异不明显 |
| **摘要四铁律** | 0.3 验证：逐条有反例坐实；发现英文停用词/截断、AD 词表(鱼油)缺口 |
| **省 25~32 倍（非 47）** | 0.4 验证：auto 默认 51k~64k vs 2k；47 是最贵对照(grid 38 张) |

## 五、当前进度

| 阶段 | 状态 |
|---|---|
| 文档定稿（11 模块 + HANDOFF） | ✅ |
| skill（fisheye + fisheye-reader） | ✅ |
| **第 0 批验证**（5 项） | ✅ 全部通过 |
| **第 1 批实现**（字幕+弹幕+切段，纯文本） | ✅ 完成，审查通过 |
| **第 2 批实现**（画面三轨 + 类型判定 + 按需渲染） | ✅ 完成，审查通过（P1 已修） |
| **第 3 批实现**（广告重构） | ✅ 完成，审查通过（P1 已修） |
| **第 4 批**（文档 + 发布） | ✅ 完成（CHANGELOG/README/DESIGN/REVIEW + 2.0.0） |

## 六、批次审查结论

### 第 1 批（已通过，代码已修复）

**验收全达标**：fast 1.15s / 只读文本 1298 token（估算）/ 0 jpg / 测试 **269**（266+3 skip，基线 242 +27）+ danmaku-filter 51/51。

**P0 ✅ 已修**：`summarizeSegment` 的 head/info 改为 `nonAd` 过滤（`ranked.filter(s => !isAd(s.text))`），并加回归测试「广告句带数字+关键词仍不进 head」。

**P1 ✅ 已全修**：
1. stdout/stderr 分离：`collect.mjs` 30 处 `console.log`→`console.error` + `auto-text.mjs` 人类提示走 stderr；stdout 只剩 `MANIFEST:/PLAN:/REPORT:` 三行。
2. 「蚌埠住了」从 `OP_RE` 删（保留在 `EMOTION_RE`）。
3. `subsEmotion` 补 `confidence`（<20 句 → low）。

**P2 ✅ 已删 ⑥，④⑤⑦ 留第 2 批**：
- ⑥ 死代码（`{charBigramVector:null, cosine:null}`）已删。
- ④ 中文 tokenize 删英文/数字（`subs-digest.mjs`）——专名 `CPU/iPhone` 被删，需在「数字与专名」通道补大写缩写抽取。
- ⑤ text token 估算中文 `/1.5` 低估（应 `/1.0~1.2`）。
- ⑦ **段级未计算 compressible**：`segments.mjs` 的 `ds.compressible` 引用的是段对象上**不存在的字段**（`compressible` 只在 `digestSubs` 顶层返回），故 `ds.compressible === false` 恒为 false → `subs.confidence` 恒 `'ok'`、`needsFrames` 字幕侧判定失效。修法：**把可压缩性下沉到段级**（对每段 subsLines 单独跑 `assessCompressibility`）。

**遗留（第 2 批处理）**：全文切片 `seg-NN-subs.txt`；段卡片「~80/段」精简版（`plan.json` 补，否则「骨架即段卡片」让 text 口径虚高）；report.html 的 `inspect.jpg` 区块；P2 ④⑤⑦。

### 第 2 批（已通过，P1 已修）

**验收全达标**：auto 不生成图 / render 出图（coarse 全片 + algorithm 按段 + adaptive 按类型 + lowconf）/ `costEstimate = 帧数 × 1024` 一致 / 测试 **291**（288+3 skip，第 2 批 +22）。

**P1 ✅ 已修**：
1. 类型判定 meta 真实接入：`render.mjs` 从 manifest.json 读真实 `subsLang/subsChars/danmakuCount/hasTranslated`；`hasAudio/avgVolume/subsMusicRatio` 未实现探测 → 传 null，`video-type.mjs` 判据改为「缺失不触发」（不再硬编码 0/true 让假判据恒命中）。
2. foreign 判据改 AND：`subsLang 非中文 && !hasTranslated` 复合判据（`total.foreign` 2→1），中文+无翻译不再误报。

**P2 挂账（随第 3/4 批）**：
1. coarse 40 分钟 = 10 帧 → 9+1 两张，第 2 张 8 空格（`tracks.mjs`/`render.mjs`）。
2. `renderTrack` 第一帧 grabFrame 失败 `continue` 留序号空洞（`tracks.mjs` L138-142）。
3. fast 档 `on` 与 `ask` 等价（都只标记不渲染，符合铁律 3），建议注释写明「on 在 fast 档不自动渲染」。

**遗留（跨批）**：第 1 批 P2 ④⑤⑦（tokenize 专名 / token 估算 / needsFrames 段级 compressible）；全文切片；段卡片精简版；report inspect。

## 七、审查流程（每批都这样）

执行者按 `HANDOFF.md` §5 交付格式汇报：改动文件 / 测试 / 自检(`tools/selfcheck-2.0.mjs`) / 数字核对(1024/2000/旧常量0) / 验收对照 / 遗留。

审查要点：① 数字口径（348→1024 后的新值）② null≠0 ③ 判断归 agent ④ fast 档 changeRate=null ⑤ w=0.3 落点 ⑥ 平台不声明 signals ⑦ head/info 排除广告句（0.3 教训）。

## 八、关键文件位置

| 文件 | 用途 |
|---|---|
| `docs/2.0/HANDOFF.md` | 交接文档（任务分解 + 铁律 + 交付格式） |
| `docs/2.0/verify/` | 第 0 批 5 份验证结论 + 口径变更记录 |
| `tools/selfcheck-2.0.mjs` | 模块自检（数字/链接/JSON/结构） |
| `tools/md2html.mjs` | 文档转 HTML（生成桌面合集） |
| `dsh-plugin/skills/fisheye/SKILL.md` | 主 agent 决策 skill |
| `dsh-plugin/skills/fisheye-reader/SKILL.md` | 子会话执行 skill |
| 桌面 `fisheye-2.0-方案合集.html` | 全模块合并视图（对照用） |

## 九、git 状态（本地未推送）

累计提交（`git log`，HEAD 在最新）：
- `723ec01` docs(release): 2.0.0 changelog + docs sync + reprice 1024 + bump
- `1eb4512` feat: 2.0 core + ad refactor（第 1~3 批代码）
- `d6eedee` fix(skill): prices 348→1024
- `000b293` docs: reprice 348→1024 + 变更记录
- `40b13cc` docs: batch-0 验证结论 + handoff
- `5454b86` tools: md2html + selfcheck
- `8db5729` feat(skills): fisheye + fisheye-reader
- `fd5a4fb` docs: 拆分 11 模块
- 更早 5 个（docs/工具/bili fix/1.0.29）

**全部批次已提交，工作区干净**（HEAD `723ec01`，版本 2.0.0）。npm 发布 / 桌面合集更新 / dsh-plugin 发布未执行（需用户授权，见第 4 批验收）。
