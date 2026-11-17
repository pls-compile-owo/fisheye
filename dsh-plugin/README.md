# fisheye video reader

Registers a `video_understand` tool that reads a video through the [fisheye](https://github.com/pls-compile-owo/fisheye) CLI and returns the artifacts a vision model needs — grid images, subtitle/transcript notes and the run manifest.

## What it does

| Source | How it is read |
|---|---|
| Bilibili BV id | `fisheye auto <BV> --budget N` — official subtitles when available, otherwise adaptive keyframe grids |
| Local video file | `fisheye local <path>` — grid from the file, optional whisper transcription |
| Any http(s) URL | `fisheye url <url> --budget N` — yt-dlp |

The tool never decides what the video *means*; it only produces evidence (grid paths, subtitle text, danmaku highlights, ad segments) on a token budget. Summaries belong to the calling model or a downstream plugin.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `fisheyePath` | `fisheye.mjs` (plus `FISHEYE_CLI` env, PATH) | Entry point of the fisheye CLI |

## Tool parameters

- `input` (required): BV id, absolute local path, or URL.
- `budget`: token budget, default 20000.
- `grid`: `3x3` / `4x4` / `5x5`.
- `range`: optional `from-to` segment (`1:30-5:00`).

## Limitations

- Requires the fisheye CLI installed on the same machine; without it the tool returns a clear error instead of failing mid-run.
- Reading a long video can take minutes; the tool reports the CLI's own token estimate and may exceed the budget for mandatory sources (official subtitles).
