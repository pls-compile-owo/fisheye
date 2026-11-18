# fisheye 2.0 实现交接（HANDOFF）

> 给执行者的交接文档。**先读这份，再读 [00-总纲](./00-总纲.md)**。
> 设计文档已定稿并经三轮审查；你的任务是按它实现，不要重新设计。

## 0. 你要做什么

把 fisheye 从 1.0.29 升级到 2.0.0，按下面 5 批执行。每批做完停下来汇报，等审查通过再继续。

## 1. 当前状态（基线）

| 项 | 值 |
|---|---|
| 代码版本 | 1.0.29（commit `dd4c065`） |
| 测试 | 242 用例（239 通过 + 3 跳过） |
| 文档 | `docs/2.0/` 11 个模块（**唯一真相**） |
| 设计状态 | 定稿，未执行 |
| 桌面 | `fisheye-2.0-方案合集.html`（可对照） |

## 2. 铁律（违反即返工）

1. **数字口径固定**
   - 图片单价：**1024 token/张**（官方上限；精确约 945~968，与尺寸无关；5x5 也是一张图）
   - text 锚点：**2,000**（段卡片 800 + 骨架 1,200）
   - 旧常量 `1200` / `3800` **禁止使用**（只在"已废"说明里出现）
   - 对比基线：auto 默认 51k~64k，省 **25~32 倍**（不是 47 倍）

2. **默认不渲染**：`auto` 不生成任何 jpg；`render` 才生成。

3. **判断归 agent**：类型判定给"建议"、情绪给"量级"、广告给"线索"，都不做最终判断。

4. **null ≠ 0**：缺失给 `null` + `confidence`，不给 `0`。

5. **w=0.3 只在 render 的 algorithm 轨生效**；纯文本链路只标布尔 `lowActivity`。

6. **平台适配器不声明 `signals`**（只声明"能提供什么证据"）。

7. **fast 档**：`changeRate = null`，类型判定输出 `{ type: null, confidence: 0, reason: 'changeRate unavailable (fast mode)' }`，不是 `unknown`。

## 3. 任务分解

### 第 0 批：验证（先做，不改代码）

| # | 任务 | 产出 | 验收 |
|---|---|---|---|
| 0.1 | 两路 vs 七路广告召回（27 条真值，按弹幕密度/有无字幕/广告位置分组） | 分组召回表 | 两路 ≥ 七路 80% |
| 0.2 | 吸附单档 vs 三档（8 条 golden 视频对比拼图覆盖） | 对比表 | 信息量差不明显 |
| 0.3 | 字幕摘要质量（中英各 3 条，人工抽检 head/op/kw） | 抽检记录 | 5 条能独立说明段落 |
| 0.4 | 成本优先实测（40 分钟「只读文本」vs「auto 默认」） | 实测数据 | 25~32 倍 |
| 0.5 | 计费基准核对（Flash 1024/图，用官方 Image Token Calculator） | 核对记录 | 1024 ±8% |

> 第 0 批的结论决定第 1/3 批的参数（低活跃阈值、是否退回"两路+advice"折中）。**不要跳过。**

### 第 1 批：字幕 + 弹幕（纯文本，无渲染）

| # | 文件 | 内容 |
|---|---|---|
| 1.1 | `lib/subs-digest.mjs`（新） | 分句合并、TF-IDF 关键词、停用词表、结构抽取（结论/转折/数字/专名）、fact/op 双通道、可压缩性判定、截断 60 字 |
| 1.2 | `lib/emotion.mjs`（新） | 双分数、分位数 + 绝对下限（floor 0.08/0.02）、√压缩、`top` 3 条样本、`suspect` 标记 |
| 1.3 | `lib/segments.mjs`（新） | 4 分钟切段（语义切点吸附）、段卡片（含秒级时间戳） |
| 1.4 | `plan.json` + `auto` | 默认只产文本（段卡片/骨架/弹幕 + manifest + report.html）；跳过全片场景检测（fast 档） |
| 1.5 | 测试 | subs-digest / emotion / segments 各 5~8 用例 |

**验收**：40 分钟视频 fast 档 <5s；text ≤3k token；无任何 jpg 生成。

### 第 2 批：画面三轨 + 类型判定 + 按需渲染

| # | 文件 | 内容 |
|---|---|---|
| 2.1 | `lib/tracks.mjs`（新） | coarse（4 分钟/帧，不吸附不降权）/ algorithm（等间隔+单档吸附+w=0.3）/ adaptive（按类型）；`renderTrack()` |
| 2.2 | `lib/video-type.mjs`（新） | 四类判定（music/slides/screen/foreign）+ `evidence` + fast 档 null 语义 |
| 2.3 | `visualTrack` 三档 | `on`/`off`/`ask`（默认 ask）；非阻塞 `visualRequest`（含 `costEstimate = 帧数 × 1024`） |
| 2.4 | `render --plan` | 按 plan.json 渲染；惰性 |
| 2.5 | 低置信拼图 | 打包 + 时间戳标注；**归属 visualRequest，不是默认产出** |
| 2.6 | 测试 | tracks / video-type / render / 低置信图 |

**验收**：`auto` 仍不生成图；`render` 出图；visualRequest 的 costEstimate 与报价单一致。

### 第 3 批：广告重构

| # | 文件 | 内容 |
|---|---|---|
| 3.1 | `lib/signals/` | 砍到两路（density/keywords）+ `AD_KEYWORD`；删 partitions/subtitle/semantic 仲裁 |
| 3.2 | 低活跃段 | `detectLowActivity()` + `weightSegments(w=0.3)`（只影响 render 的 algorithm 轨） |
| 3.3 | manifest | `adSegments` → `lowActivitySegments`；加 `adKeywordHits`；`schemaVersion: 2` |
| 3.4 | 平台适配器 | 去掉 `signals` 声明，改 `adKeywords` |
| 3.5 | 真值 | `test/golden/ad-truth/` → `low-activity/`（27 条保留） |
| 3.6 | 测试 | signals / danmaku / golden / orchestration / platforms / executor 随改名调整 |

**验收**：旧 manifest（schemaVersion 1）被明确拒绝并提示重跑；广告召回不劣于第 0 批结论。

### 第 4 批：文档 + 发布

| # | 任务 |
|---|---|
| 4.1 | README（中英）同步：默认不渲染、三轨、报价、report.html |
| 4.2 | DESIGN 两章：「agent 参与边界」「广告检测的结构性约束」 |
| 4.3 | CHANGELOG（中英，四段：本质/决策变更/具体变更/迁移指南） |
| 4.4 | REVIEW 评审历史填真实记录 |
| 4.5 | 版本 2.0.0；npm 发布 + 桌面更新 + dsh-plugin 同步（manifest 字段改了） |

**验收**：`tools/selfcheck-2.0.mjs` 通过；README 与代码字段一致；测试 242 → ~290。

## 4. 不要做的事

- 不要重新设计（文档已定稿；有异议先提，不要直接改）
- 不要引入 `1200`/`3800` 旧常量
- 不要给平台适配器加 `signals`
- 不要在 `auto` 里自动渲染
- 不要把 `visualRequest` 做成阻塞式询问
- 不要给 fine 加"更准"的语义（它是"更细"）
- 不要删 `test/golden/ad-truth/` 的 27 条真值（改名为 low-activity 继续用）

## 5. 每批交付格式

```
批次：第 N 批
改动文件：<列表>
测试：<通过数/总数>
自检：tools/selfcheck-2.0.mjs <通过/失败>
数字核对：图片单价 1024 ✓ / text 2000 ✓ / 旧常量 0 处 ✓
验收项：<逐条对照>
遗留：<未完成项>
```

## 6. 关键参考

| 文档 | 用途 |
|---|---|
| [00-总纲](./00-总纲.md) | 定位、成本链路、执行计划、验收 |
| [01-证据体系](./01-证据体系.md) | 三源 × 三轨 × 授权（第 2 批核心） |
| [02-字幕链路](./02-字幕链路.md) | 摘要四铁律（第 1 批核心） |
| [03-弹幕链路](./03-弹幕链路.md) | 情绪双分数（第 1 批核心） |
| [04-语义切分](./04-语义切分.md) | 默认纯 JS + 外挂 |
| [05-广告识别](./05-广告识别.md) | 两路 + 高光（第 3 批核心） |
| [06-工作流](./06-工作流.md) | 主 agent / 子会话分工 |
| [07-性能优化](./07-性能优化.md) | 五条优化（可选，非阻塞） |
| [08-人类自检](./08-人类自检.md) | report.html（第 1 批产出） |
| [09-成本报价](./09-成本报价.md) | 报价单（第 1 批产出） |
| [10-agent指南](./10-agent指南.md) | skill 形态（已实现，见 dsh-plugin/skills/） |

## 7. 交接备注

- `docs/2.0/` 是唯一真相；`docs/fisheye-2.0-方案.md` 是历史版本（已标"不再更新"）
- 字幕专题在 `docs/字幕链路-设计.md`（含实测数据与算法细节）
- 广告复盘在 `docs/广告识别复盘.md`（含原始决策记录）
- 桌面 `fisheye-2.0-方案合集.html` 是全部模块的合并视图（可对照）
