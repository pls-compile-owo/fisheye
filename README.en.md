# fisheye

[English](./README.en.md) | [中文](./README.md)

> Let AI agents *see* videos on a token budget — instead of grabbing one frame every 10 seconds.

A CLI tool that **understands a Bilibili video within a given token budget**:

```bash
node fisheye.mjs auto BV1xxx --budget 20000
```

## Why

Naive sampling ("1 frame per second") explodes token cost:

| Approach | 1-min video | 40-min video |
|---|---|---|
| 1 fps sampling | ~60 frames ≈ **15k tokens** | ~2400 frames ≈ **600k tokens** (over context) |
| fisheye | 1–2 grids (9–18 frames) ≈ **3–6k tokens** | 12 grids ≈ **30k tokens** |

The difference is not "sampling less" — it's **sampling the right moments and choosing the cheapest channel**.

## Design: four information channels

| Priority | Channel | Cost | When |
|---|---|---|---|
| ① | Official subtitles | a few hundred tokens | video has a CC/AI subtitle track |
| ② | Burned-in subtitle band | ~1k tokens | no subtitle track, subtitles baked into frames |
| ③ | Danmaku hotspots | ~100 tokens | find where viewers reacted (invisible to pixels/subtitles) |
| ④ | Keyframe grids (3×3) | 1.2k–3.8k tokens/grid | fallback: when pixels are actually needed |

Then refine only a few key moments at original resolution.

## Install

Requirements: Node.js 18+, ffmpeg.

```bash
# Option 1: install from npm (recommended)
npm i -g @pls-compile-owo/fisheye

# Option 2: from source
git clone <repo> && cd fisheye
cp credentials.example.json credentials.json    # fill SESSDATA / bili_jct / buvid3
node fisheye.mjs selftest --deep
```

## Usage

```bash
# Bilibili video (auto planning + grids)
node fisheye.mjs auto BV1xxx --budget 20000 [--density 6] [--from 30] [--to 90] [--p 2]

# Local video file (no Bilibili login needed)
node fisheye.mjs local ./video.mp4 [--grid 3x3] [--from 30] [--to 90]

# Manual stages
node fisheye.mjs grid BV1xxx --chunk 60 --grid 3x3
node fisheye.mjs subs BV1xxx --count 14
node fisheye.mjs refine BV1xxx [--template | --decisions d.json]
node fisheye.mjs grab BV1xxx 69.6,75.3
```

The CLI prints `SHEET: <path>` — feed that image to your multimodal model via
`read_image`. (Optional: wrap the CLI in an MCP server if your agent environment supports it.)

## Ad detection

Ad segments are detected with six heuristics: danmaku density dips, keyword clustering, head-ad signals, purchase-signal backtracking, **digit marks** (viewers type the ad end time, e.g. "1407" = 14:07), and subtitle keywords. Calibrated on 8 hand-labeled videos (7 with ads all hit, 5 without ads zero false positives) — see `test/golden/ad-truth/`.

## More commands

```bash
node fisheye.mjs local ./video.mp4 [--grid 4x4]   # local video
node fisheye.mjs transcribe BV1xxx [--lang zh]    # audio transcription (whisper.cpp)
node fisheye.mjs ocr image.png [--lang chi_sim+eng] # OCR text (tesseract)
node fisheye.mjs url "https://..."                # any platform (yt-dlp)
node fisheye.mjs batch list.txt --concurrency 2   # process many videos
node fisheye.mjs clean [--target out] [--yes]     # clean artifacts
```

`auto --resume` reuses existing grids and skips frame extraction; `--force` re-runs everything.
Optional integrations: whisper.cpp (audio), tesseract (OCR), yt-dlp (any URL), and `mcp-video-server.js` (MCP tools, needs `npm i @modelcontextprotocol/sdk zod`).

## WorkBuddy (Tencent desktop agent)

WorkBuddy supports MCP — register `mcp-video-server.js` in its `mcp.json` (same `mcpServers` shape as Claude Code) after `npm i @modelcontextprotocol/sdk zod`. Tools appear as `vwatch_scan` / `vwatch_deep`. `vwatch_deep` needs the DSH desktop app for its independent-session recap; otherwise use the CLI directly: `node fisheye.mjs auto <BV>`.

## Self-check

```bash
node fisheye.mjs selftest        # dependencies / credentials / APIs / optional tools / disk
node fisheye.mjs selftest --deep # plus frame-extraction and subtitle-band probes
```

Marks: `[OK]` pass, `[--]` skipped (optional tool missing / no data), `[!!]` failed.
Failures print fix hints at the end.

## Docs

- `docs/DESIGN.md` — design rationale
- `docs/EXPERIMENTS.md` — five rounds of real experiments
- `docs/CONFIG.md` — configuration & troubleshooting

## Credits

fisheye started as a video-understanding command inside a DSH plugin and was later
split into a standalone CLI. Its design ideas (official subtitles first, density by
motion rate, refine loop) and part of the directory layout were informed by
**SurfCore** (a QQ ↔ DeepSeek Harness bridge and Bilibili tooling plugin),
MIT License, Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors.

`danmaku-filter.mjs` is derived from the same module in SurfCore and keeps the
original MIT copyright notice — see [LICENSE](./LICENSE) for the third-party code notice.

Third-party dependencies:

| Dependency | Purpose | License |
|---|---|---|
| [ffmpeg](https://ffmpeg.org/) | frame extraction, tiling, subtitle-band slicing | LGPL/GPL |
| [numpy](https://numpy.org/) · [Pillow](https://python-pillow.org/) | subtitle-band detection (optional) | BSD / MIT-CMU |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | audio transcription (optional) | MIT |
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) | OCR (optional) | Apache-2.0 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | any-platform video download (optional) | Unlicense |

## License

[MIT](./LICENSE) © 2026 fisheye contributors

For personal study/research only. Bilibili video, subtitle, danmaku and comment
copyrights belong to their original authors/uploaders.
