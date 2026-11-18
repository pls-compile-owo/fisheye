# Design decisions

> This document explains *why* fisheye works this way. For *how to use it*, see [`../README.md`](../README.en.md).
> 中文版：[DESIGN.md](./DESIGN.md)

---

## 1. Why rank information sources instead of uniform frame sampling

The core observation: **the same information costs an order of magnitude more when read as pixels than as text.**

| Information | As text | As image |
|---|---|---|
| One subtitle line | ~10 tokens | one band image ~1000 tokens |
| One key frame | cannot express | ~300 tokens (one grid cell) |

So the order is: **read text when text exists; when pixels are unavoidable, read many frames in one image.**

This is not a trick — it follows from the cost structure: 12,410 characters of official subtitles ≈ 12,410 tokens, while 1 fps sampling of a 40-minute video is 600k tokens.

## 2. Frame picking: even-spacing skeleton + snapping to scene changes

**Pure even spacing**: a key moment may last only 1–2 seconds and would be missed.

**Pure keyframes**: transitions cluster in the intro/peak, leaving big gaps mid-video.

**The mix**:

```
base[i] = segment start + (i+0.5) × segment length / n    ← skeleton, guarantees coverage
each base snaps to the strongest scene change within ±half a cell
threshold ladder 0.3 → 0.15 → 0.08, stop when ≥75% of frames snap
dedupe: if two snapped frames are closer than 0.4 × frame interval, fall back to the skeleton
```

**Two guarantees**: coverage from the skeleton, key moments from snapping.

### Lessons learned

- **Threshold too high**: with the 0.3 ladder the snap rate was low and it looked like "scene detection was broken" — those videos (surfing, slow cuts) simply had few changes.
- **No dedupe floor**: initially several frames landed in the same second.
- **Three frames snapping to one change point**: snapping takes the strongest change in the window, so several base points can point at the same one — `minGap` in `pickTimes` sends the later ones back to the skeleton.

## 3. Subtitle band: why not OCR

**Why not OCR**:
- Chinese OCR has a high error rate on low resolution, strokes and fancy layouts
- it needs heavy dependencies (PaddleOCR / RapidOCR are hundreds of MB)
- a multimodal model reads the band almost for free (the text is already in the image — no second recognition step)

**Why band instead of the whole frame**:
- subtitles occupy the bottom ~10% of the frame; reading the whole frame wastes 90% of the tokens
- N stacked lines → N subtitle lines in one image

**Locating the band without OCR**:

```
sample 24 frames → per-row gradient per frame (subtitle edges produce high frequency)
→ 30th percentile across frames (subtitles are present in every frame → even the low quantile is high; picture content does not stay on fixed rows)
→ find the peak → expand until below threshold
→ height cap (≤ 1/4 of the search area) + confidence (band strength vs the frame itself)
```

### Lessons learned

- **TikTok-style dynamic subtitles**: position drifts and it is not every frame → the "band" found is really picture content. Added a confidence floor (<0.5 → skip).
- **Portrait high resolution**: expansion merged into a 531px block for a ~60px band → added a height cap.
- **Range mode**: with `--from/--to` only the range was sampled and the band was stolen by frame edges → **always sample the whole video** (band position is a video-level property).

## 4. Danmaku: why it works as a signal

**Bilibili danmaku density is a content signal**, and it shows things neither frames nor subtitles show:

- **Hotspots = audience highlights**: a LoL video at 01:20-01:30 has 3–5× average density, and the content is a team-fight peak
- **Density valleys = ads / boring parts**: the ad segment of a 40-minute video had only 31% of average density (viewers skip)

### Why filter ad-like danmaku

Danmaku mixes in "add WeChat" / "DM me" spam. But **the filtering principle is prefer misses over false positives** — three misfires taught this:

- "再也不怕**看这**个场面了" → matched the "看+这" ad rule
- "**666**" → killed by the "meaningless symbols" rule
- "**？？？**" → killed by the "pure punctuation" rule

The final rules only match **complete phrases** (加微信, 私信我, 关注我主页…), and:
- numeric repeats (6666/1111) stay — they are memes
- Chinese repeats (哈哈哈哈) stay — they are emotion
- pure emotional punctuation (？？？/！！！) stays

51 test assertions pin these boundaries.

## 5. Density and grid-count decisions

```
change rate = significant changes / second
rate > 1.2  → 4 s/frame (fast cuts / MV / gaming)
rate > 0.5  → 6 s/frame (vlog / tutorial)
rate > 0.15 → 9 s/frame (talking head / slow pacing)
else        → 13 s/frame (static / screen recording)

grids = ceil(duration / frame interval / 9), capped by budget, hard maximum 12
```

**Why 4–13 seconds**: empirical. Humans merge continuous motion within one scene but must split on scene changes. 4 s/frame is enough for high-dynamic video; 13 s/frame does not waste static content.

**Why a hard cap of 12 grids**: 108 frames is already the limit for a 40-minute video (22 s/frame). Beyond that it is better to use `--from/--to` on segments.

### Lessons learned

- Multi-page videos used `view.duration` (sum of all pages) for density → should be `pages[p-1].duration`
- Portrait token underestimation: a 1920×1920 grid costs 2133 tokens, not 1200

## 6. Ad segments: grade them, never guess

```
30s sliding window over danmaku density
→ continuous windows below 45% of the median (≥60s) → candidates
→ ad keywords (金主/恰饭/赞助…) within ±20s → confidence='high'
→ no keywords → confidence='low' (a low-interaction segment, not necessarily an ad)
```

**Why grading**: a pure density valley can also be a "pictures-only segment", a "BGM segment" or slow motion — skipping it would lose content. Only "valley **and** ad keywords" is safe to drop.

**What happens to high-confidence ads**: they are compressed out of the timeline and the remaining time is redistributed. The grid count stays the same, so content density rises.

**Only `confidence='high'` segments are compressed** — `low` (valley only, no keywords) still occupies frames, because a pure valley may be pictures or slow motion.

## 7. What was deliberately not built (and why)

| Not built | Why |
|---|---|
| Multimodal video models (Video-LLaVA etc.) | need local GPU / lots of VRAM; cloud APIs are pricier and less controllable |
| Unsupervised keyframe clustering | scene detection is enough; clustering adds complexity with little gain |
| Automatic summaries | that is the agent's job — the tool supplies material; summary quality belongs to the model and should not be hard-coded here |
| OCR for on-screen text | band + multimodal reading covers it; OCR adds a heavy dependency |
| YouTube support | different API layer (subtitle formats, no danmaku), but the core logic is reusable — PRs welcome |

## 8. One lesson

**The most valuable part of this tool is not the code, it is the pitfalls.**

Every "just add a parameter" feature (danmaku filtering, band detection) was really a negotiation with a concrete Chinese video ecosystem: dynamic subtitles, spam culture, ad language, Bilibili API signatures.

The "why" in this document was written by stepping on concrete cases.

## 9. Platform adapters (1.0.0)

The core does not know Bilibili: all inputs are parsed by adapters under `lib/platforms/` into one contract (duration / subtitles / danmaku / media); `auto` only sees the capabilities the adapter declares. Adding a platform = copy `lib/platforms/_template/` + one registry line, no core changes.

## 10. Semantic shifts (optional, 1.0.0)

Embeddings + change-point detection find "topic shift" moments with zero tokens and pure CPU; results go to the manifest's `semanticShifts` and feed refine suggestions as an extra signal (`source: 'semantic'`). Prefer the external Python CLI (`SEMANTIC_CLI`) for embedding enhancement; when Python is missing it degrades to pure-JS lexical splitting (`lib/semantic-core.mjs`, char-bigram drift, since 1.0.9). Without official subtitles, transcript lines (`transcriptLines`, since 1.0.10) provide a fallback so local/URL videos can also split topics.

## 11. Pluggable ad signals (1.0.10)

Ad detection went from "one function with seven hard-coded signals" to "a signal-source registry + an orchestrator":

- Seven sources: five danmaku-family (density / keywords / digit marks / head ad / purchase) + two subtitle-family (subtitle keywords / patterns), each a pure function `detect(ctx, keywords) -> [{ from, to, subAd? }]` under `lib/signals/`.
- The orchestrator `lib/signals/index.mjs` runs groups: `primary` (main) / `secondary` (booster) / `subtitle`; if the primary signal fires but yields nothing, it early-exits; secondary signals only join after the primary produced something; subtitle-family results are appended separately and do not participate in danmaku-family overlap merging.
- Platforms declare which signals to enable via `adDetector.signals` and swap the word list via `adDetector.keywords` (regex objects).
- Platforms without danmaku (local/URL) enable the two subtitle-family signals, fed by whisper transcript lines (`transcript` argument).

Adding a signal = one file under `lib/signals/` + one line in `AD_SIGNALS` + a declaration in the platform's `signals` array. This is also the reserved hook for swapping in a lightweight classifier: model and keyword signal sources share the same `detect` contract.

> **2.0 note**: the "seven pluggable signals" described in this chapter (11) are cut to two (`density` + `keywords`) in 2.0 — see chapter 13.

## 12. Agent involvement boundary (2.0)

The 2.0 positioning ([`docs/2.0/00-总纲.md`](./2.0/00-总纲.md)): **fisheye compresses a video into "evidence + cost", and does not judge for the agent.**

Three corollaries:

1. **The user is an agent, not a human**: agents read text cheaply and images expensively — fisheye turns the agent's cost structure into an engineering decision.
2. **Judgment stays with the agent**: deciding "which span is an ad / which span matters / where topic boundaries lie" is the agent's job — it is more accurate than rules, and it was going to read anyway.
3. **The sensing layer stays mechanical**: frame extraction, grids, subtitle slicing have no judgment space and don't need the agent.

Concrete outcomes:

- Type detection gives only a "suggestion" + `evidence` (criterion hits), which the agent can override (design 01 §3.5).
- Emotion gives only a "magnitude" + `top` samples, never an "excited/flat" verdict (design 03 §5.1).
- Ads give only "low-activity segments (density valleys)" + "ad-keyword highlights (pure hints)", never an "is it an ad" verdict (design 05 §7.2).
- `visualRequest` is non-blocking: fisheye only reports "insufficient text evidence + suggested track + cost"; the agent decides whether to read images (design 01 §3.6).

## 13. Structural constraints on ad detection (2.0)

2.0 downgrades ad detection from "judge for the agent" to "give the agent hints" ([`docs/2.0/05-广告识别.md`](./2.0/05-广告识别.md)), with structural constraints:

- **Seven signals cut to two**: keep only `density` (low-activity segments, affects framing) + `keywords` (ad-keyword highlights, pure hints). Remove mark/head/buy/sub-keywords/sub-patterns + partition lexicon + semantic arbitration — 0.1 verified: the other five contribute zero independent hits; two-signal recall = seven-signal = 100%.
- **Down-weight, never skip**: low-activity segments get `w=0.3` (only in render's algorithm track), not "skip entirely" — a false positive only down-weights (recoverable), while skipping deletes a whole span (catastrophic).
- **Conclusions carry evidence**: low-activity segments carry `sample` (2~3 original danmaku lines), ad-keyword highlights carry the `text` — so the agent can verify at a glance instead of taking it on faith.
- **Platforms don't declare signals**: platforms only declare "what ad-keyword evidence they can offer" (`adKeywords`); which signals to use is fisheye's call (design 05 §7.5).
- **manifest schemaVersion 2**: `adSegments` → `lowActivitySegments`; old manifests are explicitly rejected.
