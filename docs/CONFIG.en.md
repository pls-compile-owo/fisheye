# Configuration and troubleshooting

> 中文版：[CONFIG.md](./CONFIG.md)

## Dependency resolution order

fisheye hard-codes no absolute paths. ffmpeg / semantic python / credentials are resolved in this order:

```
1. environment      FFMPEG / PYTHON / BILI_CRED
2. config file      ~/.config/fisheye/config.json
3. project          <project>/bin/ffmpeg(.exe), <project>/credentials.json, <project>/.venv/
4. PATH             ffmpeg / python on the system PATH
```

When nothing is found it fails with a concrete repair command.

## Environment variables

| Variable | Purpose | Example |
|---|---|---|
| `FFMPEG` | ffmpeg executable | `C:/tools/ffmpeg/bin/ffmpeg.exe` |
| `PYTHON` | python (optional, for semantic embedding enhancement) | `C:/Python312/python.exe` |
| `BILI_CRED` | Bilibili login JSON | `D:/secrets/bili.json` |
| `FISHEYE_HOME` | data directory (where cache/out live) | `D:/video-cache` |

Temporary override:

```bash
# Windows (PowerShell)
$env:FFMPEG = "C:/tools/ffmpeg/bin/ffmpeg.exe"; node fisheye.mjs selftest

# Linux/macOS
FFMPEG=/usr/bin/ffmpeg node fisheye.mjs selftest
```

| `SEMANTIC_CLI` | semantic CLI path; default is the bundled `semantic/cli.py` |
| `SEMANTIC_PYTHON` | Python that runs the embedding enhancement (`pip install -r semantic/requirements.txt`; omit for the pure-JS lexical fallback) |

## Config file

`~/.config/fisheye/config.json` (`C:\Users\<you>\.config\fisheye\config.json` on Windows):

```json
{
  "ffmpeg": "C:/tools/ffmpeg/bin/ffmpeg.exe",
  "python": "C:/Python312/python.exe",
  "credentials": "D:/secrets/bili.json"
}
```

> ⚠️ Notepad may save a UTF-8 BOM; fisheye strips it, but VS Code or a command line is safer.

## Credentials file

```json
{
  "sessdata": "xxxxx%2C1xxxxx",
  "bili_jct": "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "buvid3": "XXXX-XXXX-XXXX-XXXX"
}
```

How to get them:

1. Log in to Bilibili in a browser
2. F12 → Application → Cookies → `https://www.bilibili.com`
3. Copy `SESSDATA` / `bili_jct` / `buvid3`

**Notes**:
- SESSDATA expires; re-copy it when it does (shows up as a failing "video API" in selftest)
- Never save it on a shared machine and never commit it to git

## Troubleshooting

### Run selftest first

```bash
node fisheye.mjs selftest --deep
```

Every item tells you what is broken.

### Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `找不到 ffmpeg` (ffmpeg not found) | not installed / not on PATH | install ffmpeg or set the `FFMPEG` variable |
| `找不到 B站登录态文件` (no credential file) | no credentials.json | create it as above |
| `视频 API 请求失败` (video API failed) | network / API change (this endpoint is public, **no cookies needed**) | check the network first, then whether the Bilibili API changed |
| `官方字幕 API` shows `[--]` | this video has no subtitle track, **or** SESSDATA expired (anonymous users cannot get AI subtitles) | cross-check with another video that has subtitles; if several fail, log in again and re-copy cookies |
| Playback URL fails / 403 | SESSDATA expired (playurl needs login) | log in again and re-copy cookies |
| `语义切分` (semantic) shows degraded | Python + fastembed not installed | `pip install -r semantic/requirements.txt`, or accept the pure-JS lexical fallback |
| Rendered grid is black | ffmpeg seek failed / unusual codec | when reporting, include the BV id and ffmpeg version |

### Performance tuning

**Video too long to run?**

```bash
# Split into ranges
node fisheye.mjs auto BV1xxx --from 0:00 --to 10:00
node fisheye.mjs auto BV1xxx --from 10:00 --to 20:00
```

**Cache too large?**

```bash
# Windows
rmdir /s /q cache
# Linux/macOS
rm -rf cache
```

`cache/` holds downloaded mp4 files; a 40-minute video is ~235 MB.

**Want more density?**

```bash
node fisheye.mjs auto BV1xxx --density 4   # force 4 s/frame
```

More density = more grids = more tokens. Portrait video is especially expensive (3793 tokens per grid).

**How to estimate the token budget?**

```
total ≈ official subtitle characters
      + grids × cost per grid
      + close-up frames × 1300
```

Cost per grid is by area: 1920×1080 = 1200 tokens; portrait 1080×1920 = 3793 tokens.

## Optional Python dependency

Subtitle-band location is pure JS now (`lib/band.mjs`) — **no Python needed**.

Only the semantic embedding enhancement needs Python:

```bash
pip install -r semantic/requirements.txt   # fastembed + ruptures + numpy
```

Without it, semantic splitting automatically falls back to the pure-JS lexical cut (`lib/semantic-core.mjs`, zero dependencies), which splits clear topic changes but separates less sharply than embeddings.
