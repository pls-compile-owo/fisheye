# Verification and review process

> This document defines "how to confirm fisheye is not broken" and "how to let an independent perspective find problems".
> Run it every time you change code.
> 中文版：[REVIEW.md](./REVIEW.md)

---

## 1. Quick verification (mandatory after code changes, ~10 s)

```bash
cd fisheye

# 1. syntax
node --check fisheye.mjs
node --check lib/band.mjs
node --check lib/semantic-core.mjs

# 2. unit tests
node test-danmaku-filter.js          # 51 assertions
node --test --test-concurrency=1 test/   # unit + golden + integration + degradation

# 3. self-check (dependencies / credentials / APIs / cache / disk)
node fisheye.mjs selftest

# 4. deep self-check (+ real frame extraction, subtitle-band location)
node fisheye.mjs selftest --deep
```

**Expected**: everything passes, `selftest` has no `[!!]`.

> Note: `[--]` means "skipped", not failed (e.g. a video without a subtitle track, an empty cache) — that is normal.

---

## 2. Functional regression (when changing frame picking / subtitles / danmaku)

Use fixed test videos and compare output before and after:

| Purpose | BV | Traits | Look at |
|---|---|---|---|
| Short + no subtitles | `BV12F411E7Zi` | 109s, portrait 1080×1920, dynamic subtitles | portrait token correction, band confidence rejection |
| Short + official subtitles | `BV1ziWP6qENy` | 114s, square, CC subtitles | official-subtitle priority, danmaku hotspots |
| Medium + fixed subtitles | `BV1h3W76wE6A` | 82s, landscape, burnt-in subtitles | band location, rate-based density |
| Long + ad segment | `BV1i4W86zEUS` | 2385s, 40 min, fish-oil ad at 4:35-6:49 | 12-grid cap degradation, ad detection, ads not occupying frames |

```bash
node fisheye.mjs auto BV1i4W86zEUS --budget 30000   # full long-video flow
```

**Watch these outputs**:

- `[ratio]` — does per-grid token cost track resolution?
- `[density]` — does the target interval track the change rate?
- `[grids]` — does it trigger "budget only allows N grids" degradation?
- `[subs]` — official / burnt-in band / none: is the right path taken?
- `[ads]` — does the 40-minute video detect 04:40-06:40?
- `[grab]` — with ads skipped, is the `content actual` range reasonable?

---

## 3. Review checklist (six dimensions)

After changing important logic, self-check against this list:

### 1. Correctness
- [ ] boundary cases: `--from` > `--to`? `--budget 0`? a 0-second video?
- [ ] empty data: no danmaku / no subtitles / no scene changes — does it still work?
- [ ] can NaN / Infinity enter computations (argument validation, division)?
- [ ] timestamp precision: manifest stores 2 decimals (1 would cross shots)

### 2. Portability
- [ ] no hard-coded absolute paths
- [ ] platform assumptions: path separators (`path.join`), commands (`where`/`which`), encoding
- [ ] clear errors when external dependencies cannot be resolved

### 3. Resource management
- [ ] temp files cleaned on all paths (including exceptions)
- [ ] child processes have timeouts
- [ ] large files (234 MB mp4) streamed rather than fully read
- [ ] `cache/` has a cleanup mechanism

### 4. Error handling
- [ ] failures give "actionable hints" rather than stacks
- [ ] no `catch {}` silently swallowing critical errors
- [ ] degraded paths tell the user explicitly (instead of quietly getting worse)

### 5. Consistency
- [ ] features promised in README exist in code
- [ ] README parameter names match what the CLI parses
- [ ] output examples match the real output format
- [ ] descriptions in `docs/` are in sync with code (change code → change docs)

### 6. Security
- [ ] external input (BV id, time parameters) never concatenated into a shell command (only `execFile` arrays)
- [ ] file paths never built directly from external input (path traversal)
- [ ] credentials (SESSDATA) never appear in logs, errors, or `out/` artifacts

---

## 4. Independent review (subagent)

Reviewing your own work has blind spots. Send this to an agent with an **independent context**:

```
You are an independent code reviewer. Project: <project path>

Step 1 (must actually run):
  node fisheye.mjs selftest
  node test-danmaku-filter.js
  node --check fisheye.mjs

Step 2: review across six dimensions
  1. Correctness (boundaries, empty data, NaN)
  2. Portability (hard-coded paths, platform assumptions)
  3. Resource management (temp files, child processes, large files)
  4. Error handling (failure hints, swallowed errors, degradation notices)
  5. Consistency (README promises vs actual code)
  6. Security (command injection, path traversal, credential leaks)

Output: grouped by 🔴 critical / 🟠 medium / 🟡 minor; each item with `file:line` + problem + reproduction + suggestion.
End with an X/10 rating.

Hard requirements:
- only report issues supported by code evidence (give line numbers)
- avoid generic "add more tests" unless you can name the untested function and its risk
- mark items already declared in README "Known limitations" as "(declared)"
- state "not verified" for anything you did not verify
- do not modify files
```

**Why independent review**: earlier reviews of this project found three real issues — "zero unit tests", "hard-coded paths", "concurrent cleanup deleting wrong files" — all blind spots of the author.

---

## 5. Review history

| Date | Scope | Found | Resolution |
|---|---|---|---|
| 2026-11-11 | first release review | zero unit tests, hard-coded paths, concurrent cleanup deleting wrong files | fixed (tests from 0.3.0, de-pathed in 1.0.7) |
| 2026-11-18 | README claims vs source + full CHANGELOG audit | see "External audit record" below | all four debts closed (1.0.10–1.0.14) |

> Update this table after each review: what was found, what was changed, what was left.

---

## 6. External audit record (2026-11-18)

> An independent "README claims vs source" audit. The audit landed on 1.0.8; status below is updated through the current version.

### How the verdict evolved

- **First verdict**: a Bilibili-specialized generic framework — the adapter contract is right, but ~80% of the intelligence is bound to Bilibili: `lib/bili.mjs` is the heaviest module, four ad signals depend on danmaku, local/URL degrade to a "fancy frame sampler".
- **Updated verdict**: a Bilibili-first, architecturally generalizable token-budget video-understanding engine — the adapter contract + signal registry + independent collection layer are already generalization-ready; functionally Bilibili is still the only "full-feature" platform. That's a "perfect one platform first, then generalize" priority choice, not a defect.

### What it got right

- **Token budget through the whole pipeline**: `planAuto` splits the budget into subtitles/transcript + grids + refine reserve; per-grid cost is area-corrected (not a hard-coded 1200); `estimateTokens` goes through `budget.mjs` with `FISHEYE_TOKEN_MODEL`.
- **Even skeleton + snap to change points**: bases spread over effective duration, snap window `half`, dedup floor `0.4×half`, threshold ladder `[0.3, 0.15, 0.08]` picking the first ≥75% snap tier, ad segments compressed before re-spreading.
- **Subtitle-band detection really dropped Python**: `lib/band.mjs` uses ffmpeg P5 grayscale PGM + pure-JS gradient/percentile/peak, numpy/Pillow semantics aligned, plus a vertical-video over-height fallback.
- **Honest multi-source layering**: official subtitles (WBI-signed, `assessSubtitleQuality` noise rejection) → whisper transcription → burnt-in band → frames, the priority is realized in code.
- **Danmaku as a third signal**: `summarizeDanmaku` buckets by 5s, hotspots join frame snapping (score 0.9, below real scene changes).

### Problems found and their resolution

| Problem | Resolution | Version |
|---|---|---|
| Ad detection is heuristic voting, signals hard-coded in `detectAdSegmentsCore` | pluggable signal sources (`lib/signals/` registry, seven signals split into primary/secondary/subtitle) | 1.0.10 |
| Non-Bilibili videos degrade to a frame sampler; `local`/`url` don't use the unified collection | `local`/`url --smart` runs the full pipeline | 1.0.11 |
| Silent errors: try/catch swallows failures, output quietly missing pieces | coverage summary + manifest `coverage` field | 1.0.12 |
| Semantic segmentation had no quantitative metric ("acknowledged but unfixed") | synthetic-sample recall/precision baseline (`test/semantic-core.test.mjs`) | 1.0.13 |
| Refine geometric thresholds hard-coded (`scene >= 0.85`, `slice(0,8)`) | `MIN_SCENE_INTENSITY`/`MAX_PICKS` parametrized + env vars | 1.0.14 |
| README claims mismatch code (platform capability table, semantic description, dev command, structure table missing subdirs, `bench.ps1` hard-coded paths) | README audit fixes + privacy fix | 1.0.15 / 1.0.26 / 1.0.28 |

### Deliberately kept trade-offs

- **Swapping ad detection for a lightweight classifier**: needs a model runtime, breaks zero-npm-dependency; the signal registry already leaves the slot.
- **Defaulting semantic segmentation to embedding**: conflicts with "dropping Python"; currently "pure-JS fallback + optional embedding boost".
- **Temp-file storm from sandbox constraints**: subprocesses can't capture pipes, data flows through temp files — the DSH-sandbox-prescribed solution; correct, but a rough IO pattern.
