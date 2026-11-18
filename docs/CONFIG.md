# 配置与故障排查

English: [CONFIG.en.md](./CONFIG.en.md)

## 依赖解析顺序

fisheye 不写死任何绝对路径。ffmpeg / 语义 python / 凭证按这个顺序找：

```
1. 环境变量        FFMPEG / PYTHON / BILI_CRED
2. 配置文件        ~/.config/fisheye/config.json
3. 项目内          <项目>/bin/ffmpeg(.exe)、<项目>/credentials.json、<项目>/.venv/
4. PATH            系统 PATH 里的 ffmpeg / python
```

全找不到时直接报错，并给出具体修复命令。

## 环境变量

| 变量 | 作用 | 示例 |
|---|---|---|
| `FFMPEG` | ffmpeg 可执行文件 | `C:/tools/ffmpeg/bin/ffmpeg.exe` |
| `PYTHON` | python（语义切分 embedding 增强用，可选） | `C:/Python312/python.exe` |
| `BILI_CRED` | B站登录态 JSON | `D:/secrets/bili.json` |
| `FISHEYE_HOME` | 数据目录（cache/out 放哪） | `D:/video-cache` |

临时覆盖：

```bash
# Windows (PowerShell)
$env:FFMPEG = "C:/tools/ffmpeg/bin/ffmpeg.exe"; node fisheye.mjs selftest

# Linux/macOS
FFMPEG=/usr/bin/ffmpeg node fisheye.mjs selftest
```

| `FISHEYE_MIN_SCENE` / `FISHEYE_MAX_PICKS` | 精读几何阈值：画面变化门槛（默认 0.85）/ 最多挑几点（默认 8） |
| `FISHEYE_TRACE` / `FISHEYE_DEBUG` | `1` 时生成 `out/<id>-trace.json` 分阶段耗时 / 打印错误堆栈 |
| `SEMANTIC_CLI` | 语义切分 CLI 路径；默认用随包 `semantic/cli.py` |
| `SEMANTIC_PYTHON` | 跑语义模块 embedding 增强的 Python（需 `pip install -r semantic/requirements.txt`；不设则纯 JS 词法兜底） |

## 配置文件

`~/.config/fisheye/config.json`（Windows 上是 `C:\Users\<你>\.config\fisheye\config.json`）：

```json
{
  "ffmpeg": "C:/tools/ffmpeg/bin/ffmpeg.exe",
  "python": "C:/Python312/python.exe",
  "credentials": "D:/secrets/bili.json"
}
```

> ⚠️ 用记事本保存可能带 UTF-8 BOM，fisheye 会自己剥掉，但更推荐用 VS Code / 命令行写。

## 凭证文件

```json
{
  "sessdata": "xxxxx%2C1xxxxx",
  "bili_jct": "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "buvid3": "XXXX-XXXX-XXXX-XXXX"
}
```

获取步骤：

1. 浏览器登录 B 站
2. F12 → Application（应用）→ Cookies → `https://www.bilibili.com`
3. 复制 `SESSDATA` / `bili_jct` / `buvid3` 三个值

**注意**：
- SESSDATA 有时效，过期后需要重新复制（表现为 selftest 的「视频 API」失败）
- 不要在公共电脑保存，不要提交到 git

## 故障排查

### 先跑自检

```bash
node fisheye.mjs selftest --deep
```

每一项都会告诉你哪里坏了。

### 常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `找不到 ffmpeg` | 没装 / 不在 PATH | 装 ffmpeg，或设 `FFMPEG` 环境变量 |
| `找不到 B站登录态文件` | 没有 credentials.json | 按上面步骤创建 |
| `视频 API 请求失败` | 网络 / 接口变更（这个接口是公开的，**不吃 cookie**） | 先查网络；再确认 bilibili 接口是否改了 |
| `官方字幕 API` 显示 `[--]` | 这条视频没字幕轨，**或** SESSDATA 过期（匿名拿不到 AI 字幕） | 换一条有字幕的视频交叉验证；若多条都拿不到，重新登录复制 cookies |
| 播放直链拿不到 / 403 | SESSDATA 过期（playurl 接口要登录态） | 重新登录复制 cookies |
| `语义切分` 显示降级 | 没装 python + fastembed | 装 `pip install -r semantic/requirements.txt`，或接受纯 JS 词法兜底 |
| 渲染出的拼图是黑图 | ffmpeg seek 失败 / 视频编码特殊 | 反馈时附上视频 BV 号和 ffmpeg 版本 |

### 性能调优

**视频太长跑不动？**

```bash
# 分段看
node fisheye.mjs auto BV1xxx --from 0:00 --to 10:00
node fisheye.mjs auto BV1xxx --from 10:00 --to 20:00
```

**缓存太大？**

```bash
# Windows
rmdir /s /q cache
# Linux/macOS
rm -rf cache
```

`cache/` 存的是下载的原始 mp4，40 分钟视频约 235 MB。

**想提高密度？**

```bash
node fisheye.mjs auto BV1xxx --density 4   # 强制 4 秒/帧
```

注意：密度提高 = 张数增加 = token 成本增加。竖屏视频尤其贵（单张 3793 token）。

**token 预算怎么估？**

```
总成本 ≈ 官方字幕字数
       + 拼图张数 × 单张成本
       + 精读帧数 × 1300
```

单张拼图成本按面积算：1920×1080 = 1200 token；竖屏 1080×1920 = 3793 token。

## Python 可选依赖

字幕带定位已纯 JS 化（`lib/band.mjs`），**不需要 python**。

语义切分的 embedding 增强才需要 python：

```bash
pip install -r semantic/requirements.txt   # fastembed + ruptures + numpy
```

不装的话：语义切分自动降级为纯 JS 词法切分（`lib/semantic-core.mjs`，零依赖），能切明显话题切换但语义区分度弱于 embedding。
