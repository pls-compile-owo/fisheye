# Platform adapter template

Copy this directory → rename → fill `match` + `createSource` → register. A new platform, without touching the core.

> 中文版：[README.md](./README.md)

## Three steps

1. Copy `_template` → rename to `lib/platforms/<your-platform>/`
2. Change `id` / `name` / `match()` (recognition rule) in `index.mjs`
3. Fill `createSource()` with `meta/media/subtitles/danmaku/adDetector` — **return `null` when unavailable** (the main flow degrades automatically)
4. Add one `import` + registration line in the `platforms` array of `lib/platforms/index.mjs`

## Method contracts (return null when unavailable)

| Method | Returns | Notes |
|---|---|---|
| `meta()` | `{ title, duration, owner, dimension, pages }` | metadata |
| `media(pageNo=1)` | local mp4 path | download / locate |
| `subtitles(range)` | `{ body: [{from, content}], quality }` or `null` | official subtitles |
| `danmaku(range)` | `[{t, text}]` or `null` | danmaku / interaction |
| `adDetector` | `{ adKeywords }` or `null` | ad-keyword evidence (platforms only declare what they can offer; which signals to use is fisheye's call) |

## Key conventions

- `match(input)` is a **pure, fast, synchronous function** — no network requests.
- `id` must be **filename-safe** (used in cache/out/manifest names); keep the full path/URL separately.
- Heavy dependencies (embedding, torch) stay inside the adapter; the core stays zero-dependency.
