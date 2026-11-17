# fisheye

[English](./README.en.md) | [中文](./README.md)

> Let AI agents *see* videos on a token budget — instead of grabbing one frame every 10 seconds.

A CLI tool that **understands a video within a given token budget** — whether it's from Bilibili, a local file, or any URL.

```bash
node fisheye.mjs auto BV1xxx --budget 20000          # Bilibili
node fisheye.mjs auto video.mp4 --budget 20000       # local file
node fisheye.mjs auto https://... --budget 20000     # any URL (yt-dlp)
```

One `auto` command handles every platform: it auto-detects the input type and routes to the matching adapter.

## Why

Naive sampling ("1 frame per second") explodes token cost:

| Approach | 1-min video | 40-min video |
|---|---|---|
| 1 fps sampling | ~60 frames ≈ **15k tokens** | ~2400 frames ≈ **600k tokens** (over context) |
| fisheye | 1–2 grids (9–18 frames) ≈ **3–6k tokens** | 12 grids ≈ **30k tokens** |

The difference is not "sampling less" — it's **sampling the right moments and choosing the cheapest channel**.

## Design: five information channels

| Priority | Channel | Cost | When |
|---|---|---|---|
| ① | Official subtitles | a few hundred tokens | video has a CC/AI subtitle track |
| ② | Burned-in subtitle band | ~1k tokens | no subtitle track, subtitles baked into frames |
| ③ | Danmaku hotspots (Bilibili) | ~100 tokens | find where viewers reacted (invisible to pixels/subtitles) |
| ④ | Keyframe grids (3×3) | 1.2k–3.8k tokens/grid | fallback: when pixels are actually needed |
| ⑤ | Semantic shift points | zero token | detect where the video switches topic (feeds refine suggestions) |

Then refine only a few key moments at original resolution.

## Platform adapters

The core knows nothing about any specific platform. Each platform is an **adapter** implementing one contract (`meta` / `media` / `subtitles` / `danmaku` / `adDetector`):

| Adapter | Input | Capabilities |
|---|---|---|
| `bilibili` | BV id | official subs + danmaku + download + ad detection (danmaku signals) |
| `local` | file path | direct frame extraction; subs via transcription / burned-in band fallback |
| `url` | http(s) link | yt-dlp download; otherwise same as local |

Adding a platform = copy `lib/platforms/_template/` + add one import to the registry. **Static registration + directory convention** (not hot-plug): fisheye is a local CLI, platforms ship built-in.

## Install

Requirements: Node.js 18+, ffmpeg.

```bash
# Option 1: install from npm (recommended)
npm i -g @pls-compile-owo/fisheye

# Option 2: from source
git clone <repo> && cd fisheye
cp credentials.example.json credentials.json    # fill SESSDATA / bili_jct / buvid3 (Bilibili only)
node fisheye.mjs selftest --deep
```

Bilibili login is only needed for Bilibili videos (some subtitle/playback URLs require cookies). Local files and URLs need no login.

## Usage

```bash
# Any platform (auto planning + grids) — Bilibili / local file / URL
node fisheye.mjs auto BV1xxx --budget 20000 [--density 6] [--from 30] [--to 90] [--p 2]
node fisheye.mjs auto ./video.mp4 --budget 20000
node fisheye.mjs auto "https://www.youtube.com/watch?v=xxx" --budget 20000

# Manual stages (Bilibili)
node fisheye.mjs grid BV1xxx --chunk 60 --grid 3x3
node fisheye.mjs subs BV1xxx --count 14
node fisheye.mjs refine BV1xxx [--template | --decisions d.json]
node fisheye.mjs grab BV1xxx 69.6,75.3
```

The CLI prints `SHEET: <path>` — feed that image to your multimodal model via `read_image`. (Optional: wrap the CLI in an MCP server if your agent environment supports it.)

## More commands

```bash
node fisheye.mjs local ./video.mp4 [--grid 4x4]   # local video (shortcut for `auto <file>`)
node fisheye.mjs transcribe BV1xxx [--lang zh]    # audio transcription (whisper.cpp)
node fisheye.mjs ocr image.png [--lang chi_sim+eng] # OCR text (tesseract)
node fisheye.mjs url "https://..."                # any platform (shortcut for `auto <url>`)
node fisheye.mjs batch list.txt --concurrency 2   # process many videos
node fisheye.mjs clean [--target out] [--yes]     # clean artifacts
```

`auto --resume` reuses existing grids and skips frame extraction; `--force` re-runs everything.
The manifest carries a `version` field for format validation — old artifacts are auto-compatible, and a too-new format reports "please upgrade fisheye" instead of silently mis-parsing.

Optional integrations: whisper.cpp (audio), tesseract (OCR), yt-dlp (any URL), semantic segmentation (see below), and `mcp-video-server.js` (MCP tools, needs `npm i @modelcontextprotocol/sdk zod`).

## Semantic segmentation (optional)

fisheye can detect **where a video switches topic** — using subtitle text (official subs preferred) + local embeddings + change-point detection. Zero tokens, CPU-only; it adds the missing third layer beyond "visual change + danmaku change".

- Auto-enabled when official subtitles exist: `auto` extracts topic-shift points, writes them into the manifest's `semanticShifts`, and feeds them as "structural signals" into refine suggestions (`source: 'semantic'`).
- Auto-skipped when there's no timestamped dialogue (semantic segmentation needs timestamped lines).
- Implemented as a standalone Python module (`src/cli.py` + `fastembed` + `ruptures`), called via subprocess. Deployed at a conventional path (override with SEMANTIC_CLI) by default; override with `SEMANTIC_CLI`.

## Self-check

```bash
node fisheye.mjs selftest        # dependencies / platform adapters / APIs / optional tools / disk
node fisheye.mjs selftest --deep # plus frame-extraction and subtitle-band probes
```

Marks: `[OK]` pass, `[--]` skipped (optional tool missing / no data), `[!!]` failed.
Failures print fix hints at the end.

## Known limits

- **Capabilities vary by platform**: Bilibili is richest (subs + danmaku + ads); local/URL have no danmaku, ad detection relies on "transcript signals" (subtitle/transcription keywords + patterns), visual OCR signals not yet built.
- **Login required (Bilibili only)**: some subtitle/playback URLs need cookies.
- **Semantic segmentation needs dialogue**: auto-skips when there's no official subs and transcription is unavailable; low-dialogue videos (pure music / pure visuals) yield no meaningful shift points.
- **Bilibili APIs can change**: `selftest` pinpoints which step broke.

## Docs

- `docs/DESIGN.md` — design rationale
- `docs/EXPERIMENTS.md` — real experiments
- `docs/CONFIG.md` — configuration & troubleshooting
- `docs/REVIEW.md` — verification checklist

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
| [fastembed](https://github.com/qdrant/fastembed) + [ruptures](https://github.com/deepcharles/ruptures) | semantic segmentation (optional, standalone Python module) | Apache-2.0 / BSD-2 |

## License

[MIT](./LICENSE) © 2026 fisheye contributors

For personal study/research only. Video, subtitle, danmaku and comment
copyrights belong to their original authors/uploaders.
