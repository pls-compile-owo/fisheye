# fisheye video reader

Adds a `video_understand` tool to a DSH agent: it hands Bilibili videos / local files / any URL to the fisheye CLI, which reads them on a token budget and returns grids, subtitles and danmaku highlights.

> 中文版：[DETAIL.md](./DETAIL.md)

## Behavior

| Input | Call |
|---|---|
| BV id | `fisheye auto <BV> --budget N` (official subtitles first, otherwise adaptive grids) |
| Local file | `fisheye local <path>` (frames into grids, optional whisper transcription) |
| URL | `fisheye url <url> --budget N` (yt-dlp) |

The tool only produces evidence (grid paths, subtitle text, danmaku hotspots, ad segments). It does not "understand" the video — summaries belong to the calling model or a downstream plugin.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `fisheyePath` | `fisheye.mjs` (also checks `FISHEYE_CLI`, PATH, and the npm global install) | fisheye CLI entry point |

## Limitations

- Requires the fisheye CLI installed on the same machine; when missing it returns a clear error instead of failing mid-run.
- Long videos can take minutes; the tool reports the CLI's token estimate, and mandatory sources (official subtitles) may exceed the budget.
