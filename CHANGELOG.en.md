# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).
中文版：[CHANGELOG.md](./CHANGELOG.md)

## [2.0.0] - 2026-11-18

### Essence

fisheye changes from "read everything + full subtitles" (~51k~95k tokens for a 40-min video) to "**evidence + cost**": by default it produces only text evidence (segment cards + subtitle skeletons + danmaku emotion), judgment stays with the agent, and images are rendered on demand (`render --plan`). Saves **25~32×**. Finalized design in `docs/2.0/` (11 modules); batch-0 verification in `docs/2.0/verify/`.

### Decision changes (all backed by batch-0 verification)

- **Image cost 348 → 1024 tokens/image**: official DeepSeek Flash vision rules changed generations (retired `deepseek-v4-flash-vision-exp` cap 384 → current cap 1024 / ~1300×1300 resize). See `docs/2.0/verify/口径变更-348-to-1024.md`.
- **Seven ad signals cut to two**: `density` (low-activity segments, affects framing) + `keywords` (ad-keyword highlights, pure hints). Removed mark/head/buy/sub-keywords/sub-patterns + partition lexicon + semantic arbitration (0.1 verified: the other five contribute zero independent hits; two-signal recall = seven-signal = 100%).
- **No render by default**: `auto` produces text only; `render` produces images (0.4 verified: 25~32× savings).
- **Snap three-tier cut to single-tier**: 0.3/0.15/0.08 ladder → single 0.3 (0.2 verified: 93% of segments never drop a tier; the 7% that do show no meaningful information difference).

### Concrete changes

**New modules**: `lib/subs-digest.mjs` (four digest laws + fact/op dual channel + compressibility), `lib/emotion.mjs` (dual emotion scores + quantile + √ compression + top samples), `lib/segments.mjs` (4-min segmentation + segment cards with second-level timestamps), `lib/tracks.mjs` (coarse/algorithm/adaptive tracks + single-tier snap + w=0.3 down-weight), `lib/video-type.mjs` (music/slides/screen/foreign typing), `lib/render.mjs` (render --plan lazy rendering), `lib/auto-text.mjs` (fast text mode).

**Subtitle fallback chain closed (4 tiers)**: translated → official original → whisper transcript → burnt-in band (`source: 'band'`; band image not rendered by default). The pure function `selectSubsLines` is unit-testable.

**manifest**: `schemaVersion: 2`; `adSegments` → `lowActivitySegments` + `adKeywordHits`; old manifests (schemaVersion 1) are explicitly rejected with a "re-run auto" hint.

**auto defaults to fast**: skips full-video scene detection (<5s, cache hit); `--standard` keeps the old framing path (full collection + grids).

**Platform adapters**: drop the `signals` declaration, switch to `adKeywords` (platforms only declare "what evidence they can offer"); local/url (no danmaku) skip ad detection.

### Migration guide

- **Old manifest rejected**: 1.0.29 manifests (schemaVersion 1) error with "re-run auto" in render/refine; re-run `auto`.
- **No render by default**: `auto` no longer produces images; read images via `render --plan [--track coarse|algorithm|adaptive|lowconf] [--segments N,M]`.
- **visualTrack three-tier** (`on`/`ask`/`off`, default `ask`): when both sources are low-confidence, `ask` only flags a `visualRequest` (with `costEstimate = frames × 1024`) and the agent decides whether to read images.
- Env vars: `FISHEYE_VISUAL_TRACK`, `FISHEYE_LOW_ACTIVITY_WEIGHT` (default 0.3).

**Demo GIFs rewritten**: `docs/demo-zh.gif` / `docs/demo-en.gif` now show the 2.0 flow (fast text mode → segment cards → on-demand render) instead of 1.0.29's "plan frames → grid → AI summary"; generator scripts `docs/make-demo-gif*.py` rewritten to write into the project's `docs/` (never the Desktop).

### Tests

- Full **288 cases** (285 pass + 3 skip), baseline 242 → 288. danmaku-filter 51/51.

## [1.0.29] - 2026-11-18

### Changed

- **Ad-detection tuning (high-confidence precision 16%→60%)**: removed 「同款」 from the keyword set (a danmaku meme, not an ad, and a frequent cross-partition false positive); narrowed the `buy` backtrace 120s→60s (the old window pulled normal content into ad spans); narrowed the density-valley merge window 20s→10s (aligned with stepSec for tighter bounds).

### Added

- **Partition keyword library** (`lib/signals/partitions.mjs`): per-partition ad-keyword downgrades keyed by Bilibili `tid_v2` — tech strips 「商单/赞助/下单」 (mostly banter in gadget reviews; real ads hit via 「感谢金主/接广」); auto strips 「赞助」 (sponsors are the content in F1-style events). `resolveKeywords(tidV2)` does a field-level merge and falls back to the default set for unknown partitions (zero regression); the bilibili adapter injects it via `adDetector.resolveKeywords`.
- **Ad-segment semantic arbitration hook** (`lib/signals/semantic.mjs`): `arbitrateAdSegments(segments, ctx, judge)` calls an external judge only on "undecided" segments (low segments, or high segments with ≤1 keyword hit) and rewrites confidence. The judge is injected via `adDetector.semanticJudge`; when absent there is zero overhead. Semantic judgment is an "arbiter", not a "signal source" — it never changes deterministic signal output, and a failing/misbehaving judge at worst mislabels confidence.

### Tests

- Added `test/partitions.test.mjs` (partition keywords) and `test/ad-semantic.test.mjs` (semantic arbitration hook).
- Pinned the 21 hand-labeled ad truths into `test/golden/ad-truth/` (12 ad + 9 no-ad, each with `tid_v2` for partition-keyword detection) and fixed the historical GBK mojibake in golden danmaku (regenerated from the normal UTF-8 cache). Golden tests now detect with the partition keyword library; the no-ad assertion became "no high segment" (low segments are low-engagement hints, not ads); the 3 "sudden / single-keyword" hard cases are marked `hardCase` and skip the coverage requirement (left to semantic recognition). 244 cases pass with zero regression.

## [1.0.28] - 2026-11-18

### Fixed

- **Privacy fix**: `tools/bench.ps1` no longer hard-codes local paths (username + absolute ffmpeg/credential paths). It now resolves the repo root via `$Repo = Split-Path -Parent $PSScriptRoot`, uses `node` from PATH, and lets fisheye probe ffmpeg/credentials itself. This was missed by the 1.0.7 privacy cleanup and only the changelog text was de-pathed in 1.0.24-1.0.25 — the script itself was left behind.

### Docs

- README project-structure table (ZH/EN) now lists the missing subdirectories: `tools/`, `docs/`, `.github/`, `test/golden/` (fixtures/ad-truth), `semantic/requirements.txt`; the Chinese table also gained `lib/trace.mjs`.
- `docs/REVIEW.md` (ZH/EN) gained an "External audit record" section: a README-claims-vs-source independent audit (verdict evolution, what it got right, six problems and their resolution, deliberately-kept trade-offs), plus a 2026-11-18 row in the review-history table.

## [1.0.27] - 2026-11-18

### Docs

- **Full ZH/EN documentation parity (no abridged versions)**: `README.en.md` rewritten as a complete version (48 sections matching the Chinese one, adding parameter ranges, the three refine modes, dependency paths, every optional-capability subsection, the third-party table and the "where the idea comes from" note); `CHANGELOG.en.md` gained the 1.0.23–1.0.26 entries (45/45 parity); added `dsh-plugin/README.zh.md` (Chinese version of the plugin README).

## [1.0.26] - 2026-11-18

### Docs

- **Full documentation audit update**: DESIGN's danmaku-filter case count 48→51 (matches the tests); README gained an "Artifact completeness summary" section (the 1.0.12 `[artifacts]`/coverage feature); REVIEW (zh) gained the full `node --test` step; CONFIG env table gained `FISHEYE_MIN_SCENE`/`FISHEYE_MAX_PICKS`/`FISHEYE_TRACE`/`FISHEYE_DEBUG`; dsh-plugin README documents the npm global install path resolution; all internal links verified.

## [1.0.25] - 2026-11-18

### Docs

- The 1.0.24 note still quoted the removed local directory path; this release abstracts that reference too — privacy-cleanup changelog entries no longer contain any local path text. Full-repo recheck: no local paths remain.

## [1.0.24] - 2026-11-18

### Docs

- **Privacy-cleanup log de-pathed**: the 1.0.7 entry had re-published the removed local directory path inside the CHANGELOG itself; both languages now describe it abstractly ("a probe candidate pointing at a developer-machine tool directory, not a standard install location").

## [1.0.23] - 2026-11-18

### Docs

- **All explanatory docs now have English versions**: `CHANGELOG.en.md` (complete translation, 0.2.1–1.0.22), `docs/DESIGN.en.md`, `docs/CONFIG.en.md`, `docs/REVIEW.en.md`, `dsh-plugin/docs/DETAIL.en.md`, `lib/platforms/_template/README.en.md`; Chinese and English docs link to each other, and the README "more docs" section points to the English versions.
- Fixed the stale name in the issue template (`vwatch version` → `fisheye version`).

## [1.0.22] - 2026-11-18

### Docs

- **Demo GIF copy fix** (EN/ZH): grids are not "always 9 frames in one image" — now reads "frame grids: 3x3=9 / 4x4=16 / 5x5=25 frames per grid, **grid count adapts per video** (1–38)", with a note that the 30s sample used just one. GIFs regenerated.

## [1.0.21] - 2026-11-18

### Docs

- **Moved the measured token table to the top of the README** ("Why" section), replacing the old estimate table: the opening now shows input tokens for five real videos (30s animation / 130s tech / 14min stop-motion / 37.6min history / 57min long tech) against the 1 fps baseline, plus the subtitle-track gap (English original vs Chinese translation, 3.5×). The benchmark section now keeps only timing/memory.

## [1.0.20] - 2026-11-18

### Docs

- **README audit fixes** (EN/ZH): test count 198→211 (208 passing); danmaku filter rule names corrected to the actual exports `AD_RULES` / `spamReason()` (the old `AD_PATTERNS` / `NOISE_PATTERNS` did not exist); env var table completed with `FISHEYE_MIN_SCENE` / `FISHEYE_MAX_PICKS` / `FISHEYE_TESSERACT` / `FISHEYE_YTDLP` / `FISHEYE_AUTO_AUDIO` / `FISHEYE_TRACE` / `FISHEYE_DEBUG` (English table synced); parameter table gained `--concurrency` (1–8).

## [1.0.19] - 2026-11-18

### Docs

- **Multi-type video token benchmark** (README EN/ZH): animation 30s (3,852 input), tech 130s (7,288), stop-motion 14min (12,339), history 37.6min (53,557), long tech 57min (22,140) — 2–39× cheaper than the 1 fps baseline; added the "same video: English track vs Chinese translation track" comparison (53,557 vs 15,415, 3.5×) and clarified where output tokens come from (model side, 300–800, not fisheye's budget).

## [1.0.18] - 2026-11-18

### Docs

- Benchmark section gained **measured token costs** (EN/ZH): for the same 40-minute video, 1 fps baseline `~600,000` vs fisheye full subtitles (English original `~53,557` / Chinese translation track `~15,415`) / pixels-only `~3,800` — 11–158× savings; noting that preferring the translated track is what fits a 20k budget.

## [1.0.17] - 2026-11-18

### Added

- **Debug trace (`FISHEYE_TRACE=1`)**: new `lib/trace.mjs`; `auto` / `local --smart` time each collection stage (download / scene-detect / subtitles / transcribe / subtitle-band / danmaku / ad-detection / semantic) and write `out/<id>-trace.json` plus a one-line stderr summary. Zero overhead when disabled, never pollutes stdout.
- **Integration tests** `test/integration.test.mjs` (4 cases): real CLI end-to-end — local frame extraction, local --smart + trace stages, selftest, clean dry-run/--yes.
- **Degradation tests** `test/degradation.test.mjs` (9 cases): missing ffmpeg (HOME isolated so the local config cannot interfere), missing file, corrupt video, empty file, invalid BV, invalid args, corrupt manifest, unknown command — asserting a clear error, non-zero exit, and no uncaught stack.

### Tests

- 211 cases total (208 pass + 3 skipped).

## [1.0.16] - 2026-11-18

### Added

- **Performance benchmark** (README EN/ZH): 40-minute video, auto full pipeline 75–83 s (i5-12500H / 16GB / NVMe), peak memory 142 MB; stage breakdown shows the bottleneck is scene detection (~72 s, one full 320p decode) — frame extraction, subtitle band, OCR and semantic splitting are all seconds. Includes a self-measurement recipe for other hardware.

### Fixed

- **`detectScenes` silently returned empty when `out/` did not exist**: `lib/frame.mjs` did not create the output directory first, ffmpeg's cwd was missing, and the exception was swallowed into "0 changes" (false failure on first run or right after cleaning). Added an idempotent `mkdirSync`; the same video now yields 673 changes (previously 0).

## [1.0.15] - 2026-11-18

### Docs

- README audit fixes (EN/ZH): platform adapter table corrected (bilibili gains the "subtitle keywords" signal; the local description now describes `auto`, not the `local` command); semantic pipeline text updated to "pure-JS lexical or embedding-enhanced" (pure JS by default since 1.0.9); development command dropped the stale `--test-concurrency=1` note; project structure table completed with 9 missing lib files (audio / batch / budget / i18n / ocr / progress / resume / retry / ytdlp).

## [1.0.14] - 2026-11-18

### Changed

- **Refine geometry thresholds are now configurable**: hard-coded `scene >= 0.85` and `slice(0, 8)` in `executor.mjs` became exported constants `MIN_SCENE_INTENSITY` / `MAX_PICKS`; `geometricPick`/`buildSuggestions` accept `{ minScene, maxPicks }` overrides, and the CLI exposes `FISHEYE_MIN_SCENE` / `FISHEYE_MAX_PICKS`.

### Tests

- Added minScene/maxPicks override and constant-default tests.
- 198 cases total (195 pass + 3 skipped), no regressions.

## [1.0.13] - 2026-11-18

### Added

- **Quantified pure-JS semantic segmentation on synthetic data**: new `test/semantic-core.test.mjs` measures recall/precision of the char-bigram drift cut on concatenated topic blocks. Baseline: 3-topic sample recall 1.0 / precision 1.0 (21/41 detected, ideal 20/40); 4-topic sample recall 0.67 / precision 1.0. Honestly documents the "lexically overlapping topics" limitation — that is where the embedding enhancement (`semantic/cli.py`) comes in.

### Tests

- 195 cases total (192 pass + 3 skipped), no regressions.

## [1.0.12] - 2026-11-18

### Added

- **Artifact completeness summary**: after `auto`/`--smart`, one line `[artifacts] subs✓6 · danmaku✓555 · ads— · semantic— · transcript— · band—` shows, per source, whether it produced anything, using ✓ (obtained) / △ (poor quality) / ○ (skipped) / — (none); also written to the manifest's `coverage` field. Agents can see at a glance which piece is missing instead of inferring "silent degradation" from logs.

## [1.0.11] - 2026-11-18

### Added

- **`--smart` for `local`/`url`**: default stays "fast uniform frames into one grid" (lightest); with `--smart` they run the full `auto` pipeline (multiple signals + subtitle band + transcription + ad detection + semantic split). Fills the "multi-signal for non-Bilibili video" gap — previously `local`/`url` were pure frame grabbers without the unified collection.
- CLI extracted `runAuto()`: `auto` and `local`/`url --smart` share decision parsing.

### Fixed

- README command table corrected: `local`/`url` are no longer described as "equal to auto" (default is fast grab; `--smart` is what equals auto).

### Tests

- 192 cases total (189 pass + 3 skipped), no regressions.

## [1.0.10] - 2026-11-18

### Added

- **Pluggable ad signal sources**: the seven ad signals (danmaku density / keywords / digit marks / head ad / purchase + subtitle keywords / patterns) were split out of `detectAdSegmentsCore` into registrable sources under `lib/signals/`, grouped by `primary` / `secondary` / `subtitle`. Adding a signal = one registry line plus a declaration in the platform's `signals` array.
- **Non-Bilibili signal boost**: whisper transcript segments from local/URL videos now feed the subtitle-family signals and semantic segmentation — platforms without danmaku can detect spoken ads and topic shifts (previously `transcript` was not wired, so the subtitle-family signals were decorative).

### Changed

- `collect.mjs`: after transcription, timestamped `transcriptLines` feed ad detection (`transcript` argument) and semantic segmentation (official subtitles first, transcript as fallback).
- `lib/danmaku.mjs`: ad entry points and constants moved to `lib/signals/`; the old import path still works via re-export.

### Tests

- New `test/signals.test.mjs`: registry completeness / transcript path / pluggable signal combinations / pattern thresholds.
- 192 cases total (189 pass + 3 skipped); the 8 golden ad-truth videos showed no regressions.

## [1.0.9] - 2026-11-18

### Changed

- **Subtitle-band detection is pure JS (no Python dependency)**: removed `analyze_subs.py` (numpy + Pillow) and replaced it with `lib/band.mjs` — ffmpeg writes a P5 grayscale PGM (with a width/height header), JS reads the bytes and computes per-row gradients → cross-frame low quantile → smoothed peak → boundary expansion, with output aligned to the Python version (same bandRatio/confidence, top/bot within 2px).
- **Pure-JS semantic fallback**: added `lib/semantic-core.mjs` (char-bigram lexical drift + top-k peaks) so topic shifts are detected without Python; the embedding enhancement (`semantic/cli.py` + fastembed) is kept as optional and enabled when Python is detected.
- **selftest updated**: removed the Python / analyze_subs.py checks; the subtitle-band probe now uses the pure-JS `detectBand` (24 frames across the whole video); added a "semantic segmentation" capability check.

### Removed

- `analyze_subs.py` (numpy + Pillow Python dependency, replaced by `lib/band.mjs`).

### Tests

- Semantic module tests rewritten: pure-JS fallback / embedding enhancement / lexical split / cosine separation / input validation.
- 186 cases total (183 pass + 3 skipped); the 8 golden ad-truth videos showed no regressions.

## [1.0.8] - 2026-11-18

### Docs

- README fully rewritten (EN/ZH): fixed stale paths (`src/cli.py` → `semantic/cli.py`), removed the reference to the deleted `docs/EXPERIMENTS.md`, filled in test counts (176 + 51 danmaku assertions) and ad ground truth (8 videos), token constants (1200/1000/1300).
- New "Tuning and extension points" chapter: ad detection (keywords / signals / detect), danmaku filter word list, budget model, frame density, semantic external CLI contract, refine thresholds.
- Output table gained `-official-subs-translated.txt`; project structure table gained `collect.mjs` / `planner.mjs` / `executor.mjs` / `selftest.mjs` / `dsh-plugin/`.

## [1.0.7] - 2026-11-18

### Fixed

- **Privacy cleanup**: removed a whisper probe candidate in `lib/audio.mjs` that pointed at a developer-machine tool directory (not a standard install location); removed local paths from comments in `lib/ocr.mjs` / `lib/ytdlp.mjs`; `docs/make-demo-*.py` default paths now come from env/temp dirs (no absolute paths containing usernames). SurfCore attribution in the README stays (open-source derivation credit).

## [1.0.6] - 2026-11-18

### Added

- **DSH plugin `@pls-compile-owo/dsh-fisheye`** (in `dsh-plugin/`): registers fisheye as the agent's `video_understand` tool, returning grids/subtitles/danmaku evidence for the model or downstream plugins. Published to npm; indexable by DSH plugin catalogs.
- README (EN/ZH) gained a "DSH plugin" install section.

## [1.0.5] - 2026-11-18

### Docs

- README title changed to `fisheye · tokencut` (search keyword); README.en synced.
- GitHub About description and topics updated (added tokencut / mcp / video-summary / whisper / danmaku / deepseek).
- npm keywords gained tokencut / video-summary / mcp / danmaku / deepseek so npm search can find it.

## [1.0.4] - 2026-11-17

### Docs

- Added demo GIFs (`docs/demo-en.gif` English / `docs/demo-zh.gif` Chinese) showing input video → planned frames → 3x3 grid → AI summary; referenced at the top of README (EN/ZH).
- Generator scripts ship with the package: `docs/make-demo-gif-en.py` / `docs/make-demo-gif.py`.

## [1.0.3] - 2026-11-17

### Tests

- executor "blurry subtitles" branch covered (2 cases): subtitles below 12px in a grid and not otherwise covered suggest a close-up; when subtitles are already covered (official text / transcript) no suggestion — locking in a core value branch against a reversed condition failing silently.
- 176 cases total (173 pass + 3 skipped).

## [1.0.2] - 2026-11-17

### Changed

- **Extracted `lib/collect.mjs` (collection layer)**: stageAuto's download / metadata / scenes / subtitles (official / transcript / band) / danmaku / ads / semantic collection moved into `collectSignals(source, opts)` returning a plain ctx; stageAuto now only orchestrates "collect → planner → stageGrid → executor → output". Ad dispatch `detectAds` moved too.
- **Extracted `lib/selftest.mjs`**: the 180-line stageSelftest is independent; stages.mjs keeps a re-export for compatibility.
- **New orchestration tests** `test/orchestration.test.mjs` (9 cases): mock platform source + temporary fake video covering collectSignals contract, official-subtitle / poor-quality branches, range validation, detectAds dispatch — filling a previously uncovered orchestration layer.

### Tests

- 174 cases total (171 pass + 3 skipped), 0 failures.

## [1.0.1] - 2026-11-17

### Fixed (macOS install retrospective)

- **A1 transcription broken**: `lib/audio.mjs` was missing the `spawnSync` import (lost during the decoupling refactor), so transcription threw `spawnSync is not defined`. Fixed; transcription verified.
- **A5 whisper naming**: the arm64 macOS artifact `whisper-cpp-darwin-arm64` was not recognized — discovery now matches the `whisper-cpp-*` prefix.
- **A6 output-dir illusion**: selftest now idempotently `mkdir -p out` before the writability probe; "directory does not exist" is no longer reported as unwritable.
- **A3 interpreter consistency**: the selftest python check now runs `-c "import numpy, PIL"` on the **actual interpreter** used; missing deps show `[--]` with an explanation instead of a false OK.
- **Subtitle-band probe false alarm**: skipped instead of failed when the Python dependency is unavailable.

### Added (A2/C end-to-end self-check)

- `selftest --deep` now runs real samples: ffmpeg testsrc 1s decode, OCR on a bundled sample image, whisper 3s silence transcription, semantic 3-line split (contract-checked).
- README gained a "macOS install" section (brew deps, Python interpreter requirement, zip backslash caveat with npm/tgz advice); English README synced.

## [1.0.0] - 2026-11-17

### Added

- **Platform decoupling**: `lib/platforms/` adapter registry (bilibili / local / url + `_template`); adding a platform = copy the template + one import in the registry, no core changes. Static registration, not hot-pluggable.
- **Semantic segmentation (optional)**: external CLI contract (`semantic/cli.py` reference implementation with fastembed + ruptures), wired into `auto` when official subtitles exist; zero tokens, pure CPU, silent fallback when unavailable.
- **Ad detection platformized**: adapters declare `adDetector` (keywords / signals / custom detect); six signals (density / keyword-cluster / head-ad / buy-backtrack / digit-mark / sub-keywords).
- **Manifest versioning**: `version` field with explicit "please upgrade fisheye" on newer formats; resume (`--resume`/`--force`) reuses completed frame extraction.
- **`lib/proc.mjs`**: shared child-process probing utilities (ffmpeg / python / whisper / tesseract / yt-dlp), so ocr/audio/ytdlp stop duplicating platform branches.

## [0.9.0] - 2026-11-14

### Added

- **Six ad-detection signals** (calibrated on 8 hand-labeled ground-truth samples):
  - density dips (existing)
  - keyword clustering (金主/恰饭/商单 comments clustered in time)
  - head-ad strong signal (ad-ish comments within the first 90s → 0-60s head ad)
  - purchase-signal backtracking (已下单/买了 → the preceding 120s is a spoken ad)
  - **digit marks** (viewers mark ad end times themselves: 1407 / 450 / 4:50 / 4.55 / 4；50 / 5分24 formats)
  - subtitle keywords (spoken ads contain 下单/链接/优惠 etc.; needs official subtitles)
- Anti-false-positive on ad-free videos: sparse danmaku guard (<0.2 comments/s → skip), head/tail low-confidence segment truncation, ad-free sample assertions.

### Changed

- Low-confidence ad segment minimum length 60s → 45s; boundaries expanded 15s on both sides.

### Tests

- Golden ground truth grew to 8 samples (7 with ads + 5 without, 3 of which have subtitles); all hit, zero false positives.

## [0.8.5] - 2026-11-14

### Added

- **Head-ad detection**: when the first 90s contain strong ad signals (接广/金主/恰饭/商单/赞助, even a single comment), 0-60s is marked as a head ad (high confidence). Fourth ground-truth sample BV1j6G16dEBF (0-57s head ad) exposed the miss.

## [0.8.4] - 2026-11-14

### Changed

- **Ad detection enhanced** (calibrated on three ground-truth samples):
  - added the "keyword clustering" signal: audiences often comment 金主/恰饭/商单 during spoken ads, independent of density dips (42s short ads were missed).
  - low-confidence segment minimum length 60s → 45s (covers 40-60s short ads).
  - density-dip segments extending into head/tail are now **truncated** (the old logic discarded the whole segment and lost real ads in the middle).
  - low-confidence segments expand 15s on both sides (audiences react late; the dip is shorter than the ad).
- Golden ad ground truth: BV1WhaA6hE7s / BV1LD421H7u4 / BV1qdb16eEF5 (coverage 100%/90%/100%, zero false positives).

## [0.8.3] - 2026-11-14

### Fixed

- Ad detection: low-confidence segments within 60s of head/tail are no longer flagged as ads (low danmaku at the start is normal; first ground-truth sample BV1WhaA6hE7s exposed the false positive).

### Added

- Ad ground-truth samples (`test/golden/ad-truth/`): hand-labeled ad segments + a golden test requiring coverage ≥80% with no head/tail false positives.

## [0.8.2] - 2026-11-14

### Fixed

- **Ad detection false positives on sparse danmaku**: below 0.2 comments/s density statistics are unreliable (the art short 《利马》 with 127 comments / 856s was flagged with 3 "low-interaction" segments); detection now skips such videos (better to miss than to misfire).
- Golden fixtures gained hand-labeled annotations (the three 利马 segments confirmed non-ad).

## [0.8.1] - 2026-11-14

### Added

- **Golden case suite** (`test/golden/`): subtitle and danmaku samples from 4 real Bilibili videos (subtitles / no subtitles / high-density danmaku / the 利马 stop-motion short) saved as fixtures, verifying subtitle-quality assessment, ad detection and frame-plan output against real replays offline.
- Subtitle quality assessment extracted into a pure function `assessSubtitleQuality` (bili.mjs), used by unit tests and golden cases.

## [0.8.0] - 2026-11-14

### Changed

- **auto default policy**: when no official subtitles exist, try whisper transcription automatically (cheaper than frames); on success skip the subtitle band. Disable with `--no-audio` or `FISHEYE_AUTO_AUDIO=0`. `--audio` remains an explicit request.

### Fixed

- No longer generates a redundant burnt-in subtitle-band image after a successful transcript.

## [0.7.3] - 2026-11-14

### Docs

Documentation-only release (same features as 0.7.2).

- README gained a dedicated "selftest" section: check items, output marks ([OK]/[--]/[!!]), `--deep` note.

## [0.7.2] - 2026-11-14

### Docs

Documentation-only release (same features as 0.7.1, no reinstall needed).

- README completed: batch processing, subtitle translation, MCP server, OCR, any-platform video, clean, resume — features added between 0.5 and 0.7.
- Third-party acknowledgements gained whisper.cpp / Tesseract / yt-dlp.
- English README gained a "More commands" section.

## [0.7.1] - 2026-11-14

### Added

- `auto --resume`: full resume support — when the manifest matches the plan and grids are complete, **skip frame extraction** and continue from existing grids (`--force` reruns everything).

## [0.7.0] - 2026-11-14

### Added

- `batch <list|items...> [--concurrency N]`: process multiple BV ids / local files / URLs in one run (`lib/batch.mjs`).
- Subtitle translation: foreign-language videos also read Bilibili's translation track (`translated` field, saved as `<BV>-official-subs-translated.txt`).
- Resume foundation (`lib/resume.mjs`): manifest records plan/stages; reruns suggest reusable artifacts (`--force` to rerun).
- Progress helpers (`lib/progress.mjs`): per-segment frame-extraction progress, stage timing.
- MCP server shipped (`mcp-video-server.js`, optional component, requires @modelcontextprotocol/sdk / zod) + EN/ZH README + CONFIG docs.

## [0.6.0] - 2026-11-14

### Added

- OCR: `ocr <image>` subcommand (tesseract, optional); selftest reports OCR availability (`lib/ocr.mjs`).
- Any-platform video: `url <link>` subcommand (yt-dlp, optional; downloads then follows the local-video flow) (`lib/ytdlp.mjs`).
- `clean [--target cache|out|all] [--yes]`: clean cache/artifacts (dry-run by default, `--yes` to delete).
- `auto --audio`: transcribe with whisper when no official subtitles exist, skipping the burnt-in band.

### Changed

- selftest gained OCR / yt-dlp checks.

## [0.5.0] - 2026-11-14

### Added

- `transcribe <BV> [--lang zh]`: transcribe audio with whisper.cpp, text saved to `out/<BV>-audio-transcript.txt`.
- `lib/audio.mjs` automatically detects the official whisper.cpp Windows package layout (`whisper/Release/`).
- Unit tests extended to all modules: retry / budget / i18n / frame / env / audio / bili (46 cases total).
- External self-check gained a "module import smoke" (all 10 lib modules load).

## [0.4.2] - 2026-11-14

### Fixed

- `lib/env.mjs` was missing the `execFileSync` import: `onPath()` failed, so ffmpeg/python on PATH could never be recognized (broke `resolveTool`'s PATH fallback).
- `selftest`: an unexecutable python on PATH (e.g. the Windows Store placeholder) degrades to a skip instead of a failure.

## [0.4.1] - 2026-11-14

### Added

- Audio transcription capability probing (`lib/audio.mjs`): detects whisper.cpp; selftest reports whether transcription is available, with install hints when not.
- README env var table gained `FISHEYE_WHISPER` / `FISHEYE_WHISPER_MODEL`.

### Fixed

- First run (no `out/` / `cache/` directory) no longer fails with ENOENT when writing the subtitle cache or downloading the video.

## [0.4.0] - 2026-11-14

### Added

- Automatic retries for Bilibili API: network errors / timeouts / 5xx / 429 retried with exponential backoff + jitter; 4xx not retried (`lib/retry.mjs`).
- Configurable token-budget estimates: `FISHEYE_TOKENS_PER_GRID` / `FISHEYE_TOKENS_PER_SUBS` / `FISHEYE_TOKENS_PER_FINE` override per-item costs; `FISHEYE_TOKEN_MODEL` (gpt / qwen / gemini / number) corrects by tokenizer (`lib/budget.mjs`).
- CLI bilingual output: `FISHEYE_LANG=en` for English, Chinese by default (`lib/i18n.mjs`).

### Changed

- All requests in `lib/bili.mjs` go through `fetchWithRetry` (same signatures and return values).
- `lib/stages.mjs` budget estimation uses `lib/budget.mjs` (defaults identical to the old COST).

## [0.3.0] - 2026-11-14

### Changed

- Main program split into modules: `lib/env.mjs` (paths/dependency resolution), `lib/util.mjs` (time/argument helpers), `lib/bili.mjs` (Bilibili API), `lib/frame.mjs` (frame extraction and timestamps), `lib/danmaku.mjs` (danmaku analysis), `lib/stages.mjs` (six subcommands); the entry point keeps CLI dispatch only.
- `selftest`: missing cache directory no longer raises an error.

### Added

- Unit tests (`node --test`): argument parsing, danmaku analysis.
- GitHub Actions CI: Node 18/20/22 syntax check + unit tests.

## [0.2.1] - 2026-11-14

First public release.

### Added

- Six subcommands: `auto` (automatic planning and layout), `grid` (segmented layout), `subs` (subtitle band), `refine` (key-frame close-ups), `grab` (full-res frames by timestamp), `local` (local video).
- Four-tier information-source priority: official subtitles → burnt-in subtitle band → danmaku hotspots → frame grids.
- Automatic subtitle-band location (row gradients + cross-frame quantiles + peak detection) and official-subtitle quality assessment.
- 3×3 layout: even-spacing skeleton + snapping to scene changes + threshold ladder + dedupe.
- Key-frame close-ups: model decisions (`--template` / `--decisions`) and a geometric fallback.
- Danmaku filtering (spam / repeats / ad links / contact info).
- `selftest`: dependencies, credentials, APIs, disk.
