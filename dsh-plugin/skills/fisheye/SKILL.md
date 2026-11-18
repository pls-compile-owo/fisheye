---
name: fisheye
description: 用 fisheye 最省 token 地看视频。需要理解 B站/本地文件/URL 视频，或用户要求总结视频时使用。先读段卡片，按需购买图片证据。
---

# fisheye：最省 token 地看视频

fisheye 把视频压缩为「证据 + 成本」。只购买回答问题所需的证据。

## 0. 调用

1. 调用 `video_understand`（插件工具）或 CLI `fisheye auto <输入>`
2. 获取：manifest 路径、段卡片、报价单、guidance

## 1. 成本优先

按以下顺序购买证据，前一步能回答即停止：

1. **text**（约 2k token）：全片摘要，回答"这视频讲什么"
2. **coarse**（约 348 token）：全片 1 张图，回答"画面大概有什么"
3. **fine**（约 348 token/段）：单段高密度图，回答"某段细节是什么"

## 2. fine 准入门槛

三条同时满足才购买：

1. 问题需要画面细节（文字、数字、图表、动作），text 与 coarse 无法回答
2. 目标为 1~2 段，不是全片
3. 能明确指出"要看哪一段的什么"

fine 提高分辨率，不改变语义理解。需要覆盖时购买 coarse，不需要精确时购买 fine。

## 3. 置信度与样本

出现以下信号时，读取 `top` 字段的 3 条样本原文，不依赖统计数字：

| 信号 | 含义 |
|---|---|
| `confidence: 'low'` | 样本量不足（弹幕少于 20 条） |
| `suspect: 'spam-heavy'` | 重复度过高 |
| `dupRatio > 0.4` | 同上 |

禁止读取原始弹幕列表。3 条样本足以判断。

## 4. visualRequest 处理

依据 `visualTrack` 配置：

| 配置 | 行为 |
|---|---|
| `on` | adaptive 图已自动生成，无需操作 |
| `ask`（默认） | 由你决定：需要则调用 `render --track adaptive`，否则忽略 |
| `off` | 无 adaptive 可用，仅 coarse/fine |

`visualRequest` 表示"文本证据不足，是否读图由你决定"，不表示必须响应。

## 5. 子会话

需要阅读的证据量超过 3k token 时，派子会话执行，加载 `fisheye-reader` 技能。

派单需包含：manifest 路径、选中的段、允许的轨道、预算。

## 6. 常见错误

- 回答"这视频讲什么"时购买 fine
- 不确定时购买全部证据
- 把 fine 当作更准确的选项
- 为覆盖全片而购买 fine
- 无明确目标时购买 fine
- 把 `allIn` 当作必须用完的预算
- 数字可疑时读取原始弹幕

## 7. 证据与结论

fisheye 提供证据与量级，不提供结论。类型判定、情绪分数、可压缩性判定均可能出错，需使用对应证据字段验证。
