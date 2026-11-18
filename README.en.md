# fisheye · tokencut

[English](./README.en.md) | [中文](./README.md)

> Let AI agents *see* videos on a token budget — **tokencut** the token cost of video understanding, instead of grabbing one frame every 10 seconds.

A CLI that **understands a video within a token budget** — whether it's from Bilibili, a local file, or any URL.

```bash
node fisheye.mjs auto BV1xxx --budget 20000          # Bilibili
node fisheye.mjs auto video.mp4 --budget 20000       # local file
node fisheye.mjs auto https://... --budget 20000     # any URL (yt-dlp)
```

One `auto` command handles every platform: it auto-detects the input type and routes to the matching adapter.

---

![fisheye demo](docs/demo-en.gif)

## Why

The naive way to let an AI watch a video is 1 frame per second:

| Approach | 1-minute video | 40-minute video |
|---|---|---|
| 1 fps sampling | ~60 frames ≈ **15k tokens** | ~2400 frames ≈ **600k tokens** (over context) |
| fisheye | 1–2 grids (9–18 frames) ≈ **3–6k tokens** | 12 grids ≈ **30k tokens** |

The difference is not sampling less — it's sampling **the right moments**, with the cheapest source that works.

## Core idea: multiple information sources

Not everything needs to be read as images. Sources are ranked by information per token:

| Priority | Source | Cost | When |
|---|---|---|---|
| ① | **Official subtitles** (CC track) | hundreds – thousands of tokens | when the video has subtitles |
| ② | **Burnt-in subtitle band** | ~1000 tokens | no official subtitles, but text on screen |
| ③ | **Danmaku highlights** (Bilibili) | ~100 tokens | audience reaction — invisible to frames and subtitles |
| ④ | **Frame grids** (3×3) | 1200–3800 tokens/grid | fallback: when pixels actually matter |
| ⑤ | **Semantic shifts** (optional) | zero tokens | where the topic changes, feeding refine suggestions |

Then a few key moments get a **close-up** at full resolution — the only place we spend big.

## Install

> **Let your agent install it**: paste this repo link (or this README) to your AI agent and say "install fisheye, then run selftest". Setup steps, dependency probing and repair hints all live in this README and in `selftest` output, so the agent can finish the whole flow on its own; if any `[!!]` item shows up, it just installs the missing dependency and reruns.
>
> Why this works well: the core has zero npm dependencies, `selftest` diagnoses each piece with concrete repair commands, and errors carry the next executable step.

**Requires**: Node.js 18+, ffmpeg

**Optional**: Python 3.9+ with `fastembed` + `ruptures` (semantic-segmentation embedding boost; without it, a pure-JS lexical fallback is used); whisper.cpp; tesseract; yt-dlp

```bash
npm i -g @pls-compile-owo/fisheye
# or from source:
git clone https://github.com/pls-compile-owo/fisheye && cd fisheye && npm link
```

### macOS

```bash
brew install node ffmpeg python3
brew install whisper-cpp tesseract tesseract-lang   # optional
pip3 install --user yt-dlp                          # optional
pip3 install -r semantic/requirements.txt           # optional (semantic)
```

Subtitle-band detection is **pure JS** (`lib/band.mjs`) — no Python, no numpy/Pillow needed.

Semantic segmentation defaults to a pure-JS lexical fallback (`lib/semantic-core.mjs`, zero deps). For the embedding boost (bge-small-zh-v1.5, more accurate), install:

```bash
pip3 install -r semantic/requirements.txt   # fastembed + ruptures + numpy
python3 -c "import fastembed, ruptures"     # selftest verifies with the same interpreter
```

Prefer `npm i -g` over unzipping a Windows-made zip (backslash paths break on macOS).

### Bilibili credentials (only for Bilibili)

Copy `credentials.example.json` to `credentials.json` and fill in `sessdata`, `bili_jct`, `buvid3` from your browser cookies. This file is gitignored — **never commit it**. Local files and URLs need no login.

### Environment variables

| Variable | Meaning |
|---|---|
| `FISHEYE_LANG` | CLI language: `zh` (default) / `en` |
| `FISHEYE_TOKENS_PER_GRID` / `_SUBS` / `_FINE` | token estimates per grid / subtitle band / close-up (default 1200 / 1000 / 1300) |
| `FISHEYE_TOKEN_MODEL` | tokenizer correction: `gpt` 1.0 / `qwen` 1.35 / `gemini` 0.8 / number |
| `FISHEYE_WHISPER` / `FISHEYE_WHISPER_MODEL` | whisper binary / model (optional) |
| `FISHEYE_HOME` | data directory (cache/out) |
| `SEMANTIC_CLI` / `SEMANTIC_PYTHON` | external semantic CLI / interpreter (default: bundled `semantic/cli.py`) |
| `FFMPEG` / `PYTHON` / `BILI_CRED` | tool and credential path overrides |

Lookup order for tools: env var → `~/.config/fisheye/config.json` → project `bin/` / `credentials.json` → PATH.

## Quick start

```bash
node fisheye.mjs selftest                              # 1. check deps/credentials/APIs
node fisheye.mjs auto BV1ziWP6qENy --budget 20000      # 2. plan and lay out the grids
node fisheye.mjs refine BV1ziWP6qENy                   # 3. pick moments worth a close-up
node fisheye.mjs grab BV1ziWP6qENy 82.5,145.0          # 4. grab full-res frames
```

Common flags: `--budget`, `--from`/`--to`, `--density`, `--p`, `--no-audio`, `--no-danmaku-frames`.

## Output

| File | Content |
|---|---|
| `<id>-cNN_start-end_3x3.jpg` | frame grid (cells ordered by time) |
| `<id>-subs_N.jpg` | subtitle band (subtitle region only) |
| `<id>-official-subs.txt` | official subtitles with timestamps (+ `-plain.txt`) |
| `<id>-official-subs-translated.txt` | official translation track when available |
| `<id>-manifest.json` | structured index: grid ranges, per-cell timestamps, change scores, danmaku hotspots, ad segments, `semanticShifts` |

`<id>` is stable and filename-safe: BV id for Bilibili, basename for local files, normalized-URL hash for URLs.

The CLI prints a planning report explaining every decision (numbers below are from different videos, format only):

```
[ratio] 1080x1920 → grid 1920x3414, ~3793 tokens per grid
[content] 14 strong changes, rate 0.13/s
[subs] no usable official subtitles; burnt-in band detected (82%-90%, confidence 0.63) → 1 band image
[semantic] 3 topic shifts
[ad] 1 low-density segment: 04:40-06:40 (120s), 34% below average, keyword "thanks sponsor"
[danmaku] 335 comments, peaks: 01:25 (34 comments)
[density] target ≤13s/frame (derived from rate)
[grids] density needs 1, budget allows 4 → using 1
[grid 1/1] 00:00-01:49, 9 frames → BVxxx-c00_0000-0109_3x3.jpg
[refine] 2 moments (geometry 1 + danmaku 1)
```

## Commands

| Command | Purpose |
|---|---|
| `auto <BV\|file\|URL>` | recommended entry: detect platform, plan, lay out grids |
| `grid <BV>` | grids only (`--chunk`, `--grid`) |
| `subs <BV>` | subtitle band only (`--count`, `--band`) |
| `refine <BV>` | pick close-up moments and grab them (template / decisions / geometric fallback) |
| `grab <BV> <t1,t2>` | grab full-res frames at given times |
| `local <file>` | quick grid from a local file; add `--smart` for the full pipeline (equiv. `auto <file>`) |
| `transcribe <BV>` | whisper transcription |
| `ocr <image>` | tesseract OCR |
| `url <url>` | quick grid from a URL; add `--smart` for the full pipeline (equiv. `auto <url>`) |
| `batch <list\|items...>` | batch processing (`--concurrency N`) |
| `clean [--target cache\|out\|all] [--yes]` | clean cache/output (dry-run by default) |
| `selftest [--deep]` | dependency/adapter/API/optional-component checks |

## Platform adapters

The core knows no platform. Each platform is an adapter following one contract (`meta` / `media` / `subtitles` / `danmaku` / `adDetector`):

| Adapter | Input | Capabilities |
|---|---|---|
| `bilibili` | BV id | official subtitles + danmaku + download + ad detection (danmaku family + subtitle keywords) |
| `local` | file path | quick grid; `--smart` runs the full pipeline (transcription / band / ads / semantic) |
| `url` | http(s) link | yt-dlp download, then like local |

Adding a platform = copy `lib/platforms/_template/` and add one import to the registry. No core changes.

## Tuning and extension points

### Ad detection (pluggable signal sources)

Ad detection is split into pluggable **signal sources** (`lib/signals/`): five danmaku-family + two transcript-family, orchestrated in `primary` / `secondary` / `subtitle` groups. Each adapter declares which signals to enable and which keywords to use via `adDetector`.

| Signal | Group | Meaning |
|---|---|---|
| `danmaku-density` | primary | danmaku density dip (viewers skip ads) |
| `danmaku-keywords` | primary | ad keywords clustered |
| `mark` | secondary | digit marks ("1407" = ad ends at 14:07) |
| `head` | secondary | intro/spoken ad |
| `buy` | secondary | purchase-talk backtracking |
| `sub-keywords` | subtitle | purchase words in subtitles/transcript (no danmaku needed) |
| `sub-patterns` | subtitle | exact phrases in subtitles/transcript ("click the link below") |

```js
// seven built-in, six on by default (danmaku family + subtitle keywords)
adDetector: {
  keywords: DEFAULT_KEYWORDS,               // regex object { ad, strong, mark, buy, sub, pattern }
  signals: ['danmaku-density', 'danmaku-keywords', 'mark', 'head', 'buy', 'sub-keywords'],
}
```

Danmaku-less platforms (local/URL) enable the two transcript signals, fed by whisper's timestamped transcription.

Add a signal = one file under `lib/signals/` + one line in `AD_SIGNALS` + declare it in the platform's `signals` array. For fully custom detection, provide `adDetector.detect` (`({ danmaku, duration, subtitles, transcript }) => [{ from, to, confidence, ... }]`).

Tuning: label 2–3 real videos first, then adjust. Too many false positives → drop weak signals; too many misses → add platform-specific words (digit marks work best).

### Danmaku filtering

`danmaku-filter.mjs` drops ad-link spam and noise using keyword tables (`AD_PATTERNS` / `NOISE_PATTERNS`) — edit them for your platform's slang. Rules have their own test: `node test-danmaku-filter.js` (51 cases). `--no-danmaku-frames` keeps danmaku for hotspots/ads only.

### Budget model

| Constant | Default | Meaning |
|---|---|---|
| `FISHEYE_TOKENS_PER_GRID` | 1200 | one 3×3 grid |
| `FISHEYE_TOKENS_PER_SUBS` | 1000 | one subtitle band |
| `FISHEYE_TOKENS_PER_FINE` | 1300 | one close-up |
| `FISHEYE_TOKEN_MODEL` | 1.0 | model factor (`gpt` 1.0 / `qwen` 1.35 / `gemini` 0.8 / custom) |

Grid cost is corrected by frame area (portrait ≈ 3× landscape), so portrait videos hit the budget cap sooner.

### Frame density

Default: derived from content change rate (0.05–2/s → 4/6/9/13 s per frame). `--density N` forces N seconds per frame. Hard cap `MAX_GRIDS = 12`. Under budget pressure it degrades and says so in the log.

### Semantic segmentation (bring your own model)

The semantic step is an external CLI that can be replaced entirely:

```bash
SEMANTIC_CLI=/path/to/my-semantic-cli.py SEMANTIC_PYTHON=/path/to/python fisheye auto BV1xxx
```

Contract (see the header of `semantic/cli.py`):

```
input:  JSON file [{ "t": seconds, "text": "line" }, ...]
call:   python cli.py <input.json> [--n-bkps 5]
output: stdout JSON { "segments": [{ "t": s, "confidence": 0..1, "signals": [...] }],
                      "suggestions": [{ "t": s, "reason": "...", "confidence": 0..1, "source": "...", "kind": "..." }] }
```

The bundled reference implementation uses `fastembed` (bge-small-zh) + `ruptures` for embedding-based change-point detection — zero tokens, CPU-only. Enabled automatically when dependencies exist; otherwise it **falls back to pure-JS lexical segmentation** (`lib/semantic-core.mjs`, char-bigram drift) — weaker than embedding but still catches clear topic shifts.

### Close-up thresholds

- `MIN_READABLE_SUBS_PX = 12`: subtitles smaller than 12px in a grid are "unreadable" → suggest a close-up
- At most 8 close-up points, ranked by change strength / danmaku heat
- No subtitle close-up suggestions when subtitles are already covered (official track / transcript)

## Resume

```bash
node fisheye.mjs auto BV1xxx --budget 20000 --resume   # reuse completed frame extraction
node fisheye.mjs auto BV1xxx --budget 20000 --force    # rerun everything
```

Manifests carry a `version` field; older artifacts stay compatible, newer ones produce an explicit "please upgrade fisheye" instead of a silent mis-parse.

## Optional capabilities

- **Local video**: `auto <file> [--grid 3x3] [--from 30] [--to 90]` — no login required.
- **Audio transcription**: `transcribe BV1xxx --lang zh` (whisper.cpp, `FISHEYE_WHISPER_MODEL`).
- **OCR**: `ocr screenshot.png [--lang chi_sim+eng]` (tesseract).
- **Any URL**: `auto "https://..."` via yt-dlp.
- **Batch**: `batch list.txt --concurrency 2`, failures don't stop the run.
- **Clean**: `clean --target out --yes`.

## selftest

```bash
node fisheye.mjs selftest        # deps / adapters / APIs / optional components / disk
node fisheye.mjs selftest --deep # plus real samples: frames, band, OCR, silence transcription, 3-line semantic split
```

Marks: `[OK]` pass, `[--]` skipped, `[!!]` failed, with repair hints at the end.

## MCP server (optional)

`mcp-video-server.js` exposes fisheye as MCP tools for MCP-capable agents (DSH / Claude Code / Cursor):

```bash
npm i @modelcontextprotocol/sdk zod   # inside the fisheye directory
```

```json
{ "mcpServers": { "fisheye": { "command": "node", "args": ["C:/path/to/fisheye/mcp-video-server.js"] } } }
```

| Tool | Purpose |
|---|---|
| `vwatch_scan` | quick look: first segment as a 3×3 grid (returns the image) |
| `vwatch_deep` | deeper read: budgeted frames + official subtitles → independent headless session → summary only |

## DSH plugin (optional)

For DeepSeek Harness, the plugin registers fisheye as the `video_understand` agent tool:

```bash
dsh plugin --profile web add @pls-compile-owo/dsh-fisheye
```

The plugin only *reads* videos (grids, subtitles, danmaku evidence); summaries belong to the calling model or a downstream plugin — good as an upstream preprocessing module for other video plugins.

## How it works

```
① resolve input → platform adapter
② metadata (pages / duration / resolution)
③ time range (--from/--to)
④ frame aspect → per-grid token estimate (portrait is ~3× expensive)
⑤ scene detection (one ffmpeg decode at 320p) → change rate
⑥ subtitle decision: official > transcript > burnt-in band > pixels only
⑦ danmaku: hotspots + ad segments (multiple signals)
⑧ semantic shifts (optional): pure-JS lexical (char-bigram) or embedding boost
⑨ density: change rate → target interval (4/6/9/13 s)
⑩ grid count: density need vs budget cap (hard max 12)
⑪ layout: even-spaced skeleton + snap to scene changes → grids
⑫ refine suggestions: scene changes + danmaku peaks + semantic shifts, skipping ad segments
```

### Design notes

- **Even spacing + snapping**: pure spacing misses 1–2 second flashes; pure keyframes cluster in intros. The mix keeps coverage and snaps each base point to nearby scene changes.
- **Why not OCR the subtitle band?** Chinese OCR is unreliable on low-res, styled text. Slicing the band and letting a multimodal model read it is more accurate at similar cost.
- **Danmaku as a signal**: on a 40-minute video, ad segments had ~31% of average danmaku density; audience peaks were 3–5×. Density is content.
- **Ads don't occupy frames**: compressing ad segments raises content density (measured: interval 22.1s → 8.3s on one grid).
- **Semantic without an LLM**: similarity detection on subtitle/transcript text (pure-JS char-bigram by default, embedding boost with python) costs zero tokens; semantic shifts feed refine suggestions as a *structural* signal, not mixed into geometry.

## Performance benchmark

> Measured 2026-11-18: Windows 11 / Intel i5-12500H (12C/16T) / 16 GB / NVMe SSD.
> Test video: a 37-minute Bilibili video (2255s, 1080p, 281 MB), **cache hit, download excluded**.

| Stage | Time | Notes |
|---|---|---|
| **auto full pipeline** | **75–83 s** | scene detection + subtitle/danmaku APIs + semantic + 1 grid |
| ├ scene detection (bottleneck) | ~72 s | one full 320p ffmpeg decode, ~95% of the run |
| ├ subtitle / danmaku APIs | ~1–2 s | network-bound |
| ├ semantic split (pure JS) | ~0.2 s | 1026 subtitle lines, single core |
| └ 1 grid (9 frames) | ~1 s | ffmpeg frame grabs |
| grid (38 grids, incl. scene detection) | 140 s | 342 frame grabs |
| subs (subtitle band) | 5.6 s | 24-frame sampling |
| ocr (one image) | 0.5 s | tesseract |
| download 281 MB | 227 s | network, not processing |
| **peak memory** | **142 MB** (ffmpeg 85 MB) | process-tree RSS |

**Takeaway**: the cost of a 40-minute video is almost entirely scene detection (one full 320p decode). Frame grabbing, grids, semantic splitting and subtitle-band detection are all seconds.

### Measured token cost (same 40-minute video)

| Mode | Composition | Actual tokens |
|---|---|---|
| 1 fps sampling (baseline) | 2400 frames × ~250 | **≈ 600,000** |
| fisheye · full subtitles (English AI track) | subtitles 49,757 + grid 1,200 + close-up reserve 2,600 | **≈ 53,557** |
| fisheye · full subtitles (Chinese translation track) | subtitles 11,615 + grid 1,200 + close-up reserve 2,600 | **≈ 15,415** |
| fisheye · pixels only (no subtitles) | grid 1,200 + close-up reserve 2,600 | **≈ 3,800** |
| one close-up | full-resolution frame | ≈ 1,300 / point |

**Takeaways**

- vs the 1 fps baseline, fisheye saves **11× to 158×** tokens depending on mode.
- Same video: reading the English original costs 54k tokens (over a 20k budget); reading Bilibili's Chinese translation track costs **15k** — preferring the translated track is what gets a 40-minute video under a 20k budget.
- Grid cost (1,200) and close-up reserve (2,600) are fixed overhead; subtitles dominate — which is why "subtitles first, pixels only if needed" is the cheapest order.
### Other hardware (not measured — no made-up numbers)

No data outside this machine. In order of impact:

1. **CPU / decode speed** — scene detection decodes the whole file; single-core matters most, extra cores help little.
2. **Network** — downloading a 281 MB video often dominates (227 s here).
3. **Memory** — not a bottleneck (~150 MB peak); SSD only affects sequential cache reads.

Measure it yourself:

```bash
# single item: scene detection (best proxy for machine differences)
ffmpeg -hide_banner -i video.mp4 -vf "scale=320:-2,select='gt(scene,0.05)',metadata=print:file=/tmp/s.txt" -an -f null -

# full pipeline
node fisheye.mjs auto BV1xxx --budget 20000
```

Post the numbers in an issue and this table will be updated.
## Known limitations

- Capabilities vary by platform: Bilibili has subtitles + danmaku + ad detection; local/URL have no danmaku — ad detection and semantic segmentation both run on whisper's timestamped transcript.
- Bilibili subtitles/playback URLs may need cookies.
- Semantic segmentation needs dialogue (subtitles or transcript).
- Long videos cost real tokens: ~12k tokens for a 40-minute Chinese subtitle track (AI English subtitles can reach ~50k).
- Bilibili APIs change; `selftest` tells you which piece broke.

### Debug trace (`FISHEYE_TRACE=1`)

Use trace when you need to know where time went or why a signal source was skipped:

```bash
FISHEYE_TRACE=1 node fisheye.mjs auto BV1xxx --budget 20000
# → out/<id>-trace.json: per-stage timings (download / scene-detect / subtitles / transcribe /
#   subtitle-band / danmaku / ad-detection / semantic), with an error field on failures
```

Trace writes to a file and stderr only — stdout (the machine-readable result) is untouched, and it costs nothing when disabled. Combine with `FISHEYE_DEBUG=1` to print stacks on fatal errors.

### Tests

```bash
node --test --test-concurrency=1 test/          # unit + golden + integration + degradation (211 cases)
node --test test/integration.test.mjs           # real CLI end-to-end (local / --smart + trace / selftest / clean)
node --test test/degradation.test.mjs           # degradation: missing ffmpeg / broken file / bad args / bad manifest
```

Degradation cases assert a clear error, a non-zero exit code, and no uncaught stack — so missing deps or bad input never look like success.
## Development

```bash
node --test test/                       # unit tests + golden fixtures (offline)
node test-danmaku-filter.js              # danmaku filter rules (51 cases)
node fisheye.mjs selftest --deep         # end-to-end self-check
```

Currently **198 tests** (195 pass + 3 skipped) + **51 danmaku cases**; ad detection has **8 hand-labeled golden videos**.

Structure: `fisheye.mjs` (CLI), `lib/platforms/` (adapters + template + registry), `lib/collect.mjs` (signal collection), `lib/planner.mjs` / `lib/executor.mjs` (decisions), `lib/stages.mjs` (orchestration), `lib/selftest.mjs`, `dsh-plugin/`, `semantic/cli.py`, `test/`.

More docs: [`docs/DESIGN.md`](docs/DESIGN.md) (decisions and tradeoffs), [`docs/CONFIG.md`](docs/CONFIG.md) (configuration and troubleshooting), [`docs/REVIEW.md`](docs/REVIEW.md) (verification checklist).

## Compliance

For personal study and research only: follow each platform's terms, don't scrape in bulk or resell, keep cookies private, and respect video/subtitle copyright.

## Acknowledgements

The design (official subtitles first, rate-based density, refine loop) and some directory conventions were informed by **SurfCore** (QQ ↔ DeepSeek Harness bridge and Bilibili tooling, MIT, Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors). `danmaku-filter.mjs` derives from the same module in SurfCore; see the third-party notices at the end of [LICENSE](./LICENSE).

Third-party: ffmpeg, whisper.cpp, Tesseract OCR, yt-dlp, fastembed + ruptures (optional components, see the Chinese README table).

## License

MIT
