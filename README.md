# clean-video

Local, open-source video cleanup for Loom-style screen + cam recordings.
It denoises audio, cuts silences, removes filler words, and generates captions —
then renders a tightened `.mp4` in a single ffmpeg pass. **Everything runs
locally.** Nothing is uploaded.

Phase 1 (this repo) is a core library + interactive CLI. A web UI wraps the same
core in phase 2 (see [Architecture](#architecture)).

## What it does

```
input.mp4
  ├─ denoise        deep-filter (preferred) or ffmpeg afftdn fallback
  ├─ silence        ffmpeg silencedetect → gap list
  ├─ transcribe     whisper.cpp → word-level timestamps
  ├─ fillers        heuristic ("um", "uh", stutters) + optional Claude tier
  ├─ cut plan       merge silence + fillers → keep-list (snapped to words)
  ├─ approve        interactive y / n / edit in the terminal (or the web UI)
  └─ render         one-pass ffmpeg trim/atrim + concat (frame-accurate)
        → input.cleaned.mp4  +  .srt  +  .vtt  +  cutplan.json
```

There's also a **web editor** (`clean-video ui <video>`) — a Loom/Descript-style
single page with a video player, clickable transcript, timeline, and an instant
"play edited" preview. See [Web editor](#web-editor).

## Prerequisites

You need external binaries on your `PATH`. clean-video detects them at startup
and prints install instructions if any required one is missing.

| Tool          | Required | macOS                     | Linux                                   |
| ------------- | -------- | ------------------------- | --------------------------------------- |
| ffmpeg/ffprobe| yes      | `brew install ffmpeg`     | `sudo apt install ffmpeg`               |
| whisper-cli   | yes      | `brew install whisper-cpp`| build [whisper.cpp](https://github.com/ggerganov/whisper.cpp) from source |
| deep-filter   | no       | `npm run fetch-binaries` (or [DeepFilterNet releases](https://github.com/Rikorose/DeepFilterNet)) | same |
| claude        | no       | Claude Code CLI (only for `--smart`) | same |

`ffmpeg`/`ffprobe`/`whisper-cli` must be on your `PATH`. `deep-filter` is
vendored per-platform under `bin/` (see [deep-filter](#deep-filter-denoiser-optional)),
so it does **not** need to be on `PATH`.

For a full Ubuntu setup (apt + node 20 + whisper.cpp from source), see
[docs/ubuntu.md](docs/ubuntu.md).

### deep-filter denoiser (optional)

The DeepFilterNet `deep-filter` binary is platform-specific. clean-video looks
for a vendored build at `bin/deep-filter-<platform>-<arch>` (e.g.
`bin/deep-filter-linux-x64`), then a legacy `bin/deep-filter`, then `deep-filter`
on `PATH`. Download the one matching your machine:

```bash
npm run fetch-binaries
```

This detects your platform/arch, downloads the matching DeepFilterNet v0.5.6
release asset into `bin/`, `chmod +x`es it, and verifies `--version`. It is
idempotent (skips when the binary is already present and working) and prints a
clear error on an unsupported platform/arch. Supported: `darwin-arm64`,
`darwin-x64`, `linux-x64`, `linux-arm64`.

If **deep-filter** isn't available, denoising automatically falls back to
ffmpeg's `afftdn` and says so in the output (`denoise: afftdn`).

### Captions: sidecar vs embed vs burn-in

clean-video always writes sidecar `.srt`/`.vtt`. Two flags add captions to the
`.mp4` itself:

| Mode        | Flag      | ffmpeg needs | Result |
| ----------- | --------- | ------------ | ------ |
| Sidecar     | (default) | any          | `.srt` + `.vtt` files next to the video; load them in a player manually. |
| **Embed**   | `--embed` | any          | A soft **`mov_text`** subtitle track muxed into the mp4 — toggleable in QuickTime/VLC/most players. Muxed in the single render pass (no extra encode). |
| **Burn-in** | `--burn`  | **libass** (`subtitles` filter) | Hard-baked pixels — always visible, can't be turned off. Fails fast with a clear message if this ffmpeg lacks libass. |

`--embed` works with **any** ffmpeg build (including Homebrew's default, which
often lacks libass), so it's the portable way to ship a mp4 with toggleable
captions. You can combine `--embed` and `--burn`.

### Whisper model

whisper.cpp needs a model file. The default is `base.en`. Models are **not**
auto-downloaded. Fetch one into `~/.cache/whisper/`:

```bash
mkdir -p ~/.cache/whisper
curl -L -o ~/.cache/whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Other models (`tiny.en`, `small.en`, `medium.en`, `large-v3`, …) work the same
way — download `ggml-<name>.bin` and pass `--model <name>`. Or point at any file
with `--model-path /path/to/model.bin`.

`base.en` is a good speed/accuracy default for English screen recordings.

## Install & build

```bash
npm install
npm run fetch-binaries   # optional: download the deep-filter denoiser for your platform
npm run build            # compiles to dist/
npm test                 # unit tests (vitest)
```

## Usage

```bash
# simplest: analyze, approve interactively, render alongside the input
node dist/cli/index.js recording.mp4

# during development you can skip the build step:
npm run dev -- recording.mp4
```

Common flags:

```bash
# smarter filler / false-start / ramble detection via Claude (optional)
node dist/cli/index.js recording.mp4 --smart

# tune silence detection, write outputs to a folder, non-interactive
node dist/cli/index.js recording.mp4 \
  --min-silence 1.2 --max-pause 0.75 --min-keep 0.4 --threshold -35 \
  --out ./cleaned --yes

# embed captions as a soft, toggleable subtitle track (works with any ffmpeg)
node dist/cli/index.js recording.mp4 --embed

# burn captions into the video (hard subs; needs libass ffmpeg)
node dist/cli/index.js recording.mp4 --burn

# pick a different whisper model
node dist/cli/index.js recording.mp4 --model small.en
```

Full flag list: `node dist/cli/index.js --help`.

### Interactive approval

After analysis, clean-video prints a numbered cut plan (timestamp range,
seconds saved, reason, and the transcript snippet) and asks:

```
Render with these cuts? [y]es / [n]o / [e]dit:
```

- `y` — render.
- `n` — abort, write nothing.
- `e` — type the numbers of cuts you want to **keep in the video** (exclude from
  cutting); the plan is recomputed and shown again.

### Outputs

Written next to the input (or into `--out <dir>`):

- `<name>.cleaned.mp4` — the tightened video
- `<name>.cleaned.srt` / `<name>.cleaned.vtt` — captions, timestamps remapped to
  the post-cut timeline
- `<name>.cutplan.json` — the full keep-list + cuts with reasons

### Cut-quality knobs

- **`--min-silence` (default 1.2s)** — a quiet stretch shorter than this is never
  cut.
- **`--max-pause` (default 0.75s)** — a detected silence is _shortened_, not
  deleted: it keeps `max-pause` seconds of natural pause and removes the rest
  from the **middle**, leaving `max-pause / 2` of silence next to the speech on
  each side (so pauses don't turn into hard jump cuts, and a long quiet stretch
  of a screen demo isn't removed wholesale). Cut length = gap − pause-kept, and
  a gap no longer than the pause-kept is left untouched.
- **`--padding` (default 0.15s)** — a per-side floor on that breathing room:
  the pause kept per silence is `max(max-pause, 2 × padding)`, so `max-pause` is
  the primary control and `padding` only matters if you set it high enough to
  exceed it.
- **`--min-keep` (default 0.4s)** — anti-flicker: after cuts are merged, any
  kept sliver shorter than this (they show up as a 1–2 frame flash between
  adjacent cuts) is absorbed by merging the neighbouring cuts across it. Applies
  to leading/trailing slivers too.
- **`--max-cut-per-silence` (default 0 = uncapped)** — a per-gap ceiling: a
  single silence may lose **at most** this many seconds (still removed from the
  middle, still respecting `max-pause`). The cap binds only when
  `gap − pause-kept > cap`, so short gaps are unaffected while a long static
  silence is *barely trimmed* rather than collapsed to `max-pause`. This is the
  knob that makes `conservative` sit near Loom (see Modes below).

Cuts longer than 10s are flagged with a leading `⚠` in the plan so you eyeball
them before approving.

### Modes (`--mode`)

A `--mode` sets **defaults** for the knobs above (plus the activity policy); any
explicitly-passed flag still wins. Measured on `sample-videos/demo.mp4`
(7:43.7 / 463.7s); Loom's "Edit and enhance" removed ~21s on the same footage.

| Mode | min-silence | max-pause | max-cut-per-silence | fillers | activity policy | demo.mp4 removed |
| ---- | ----------- | --------- | ------------------- | ------- | --------------- | ---------------- |
| `conservative` | 3.0s | 1.5s | **2.5s (capped)** | off | static-only; active silences exempt | **~20.7s** (≈ Loom's 21s) |
| `balanced` *(default)* | 1.2s | 0.75s | uncapped | on | shorten static; ease off active (2s pause, >4s only) | ~127.1s |
| `aggressive` | 0.8s | 0.5s | uncapped | on | ignores on-screen activity | ~175.4s |

The `conservative` cap of 2.5s is what pulls it from 80.9s (uncapped) down to
~20.7s: each of demo.mp4's 9 static silences now loses at most 2.5s instead of
collapsing a 40s gap to a 1.5s pause. That is the Loom philosophy — long quiet
stretches are left almost intact.

## Web editor

```bash
node dist/cli/index.js ui                    # persistent app: open videos from the browser
node dist/cli/index.js ui recording.mp4      # optional: jump straight into a file
# or: npm run ui           /  npm run ui -- recording.mp4
```

Starts a localhost-only server (bound to `127.0.0.1`) and opens your browser
(`--no-open` to skip, `--port <n>` to pin the port). Leave it running — it is a
persistent personal app, not tied to one file. The core pipeline is reused
verbatim — the server just wraps `analyze()` / `finalize()`.

Build the UI once with `npm run build:ui` (or `npm run build:all` for core + UI).

### Home screen

With no file argument the browser opens a **home screen** with three ways to
open any video, no restart required:

- **"Open video…"** — a native OS file dialog spawned by the server (which runs
  on your own machine): `choose file` on macOS, `zenity`/`kdialog` on Linux. The
  button is hidden if no dialog tool is available.
- **Path input** — paste an absolute path; the server validates it (exists, is a
  regular file, ffprobe can read it) before opening.
- **Recent** — the last ~15 videos you opened, most recent first, persisted at
  `${XDG_CONFIG_HOME:-~/.config}/clean-video/recents.json`. Entries whose file
  has since moved are greyed out with a remove (`×`) button.

Opening a video (by any method) creates a server-side **session** and drops you
into the editor. The header **"← Videos"** button returns home so you can open
another; switching video discards the previous editor's cut state (the source
file and its outputs are untouched).

### Editor

- **Video player + "Play edited"** — toggle it on and the player skips cut ranges
  client-side (no rendering): an instant preview of the final result.
- **Transcript** — words are clickable; cut words are struck through and
  reason-coloured. Click a struck word to keep it (toggles that cut off); select
  a word range and hit **Cut selection** for a manual cut.
- **Timeline** — cut regions coloured by reason, playhead, click to seek or
  toggle a region.
- **Settings drawer** — one **Mode** dropdown (Conservative / Balanced /
  Aggressive, each with a one-line description) is the primary control; switching
  mode updates the advanced values shown. Everything else (min-silence,
  max-pause, per-gap cap, min-keep, padding, threshold, whisper model, filler
  list, smart/filler toggles) lives in a collapsed **Advanced** section. Editing
  an advanced field marks it as an override that survives mode switches and
  re-analysis; **Reset to mode defaults** clears overrides. Then **Re-analyze**
  (keeps your manual cuts and replaces the auto proposal).
- **Render** — writes the same `.mp4` + `.srt`/`.vtt`/`cutplan.json` next to the
  input. Two caption checkboxes: **"Embed captions (soft, toggleable)"** (always
  available) and **"Burn-in captions (hard)"** (offered only when this ffmpeg has
  the `subtitles` filter). See [Captions](#captions-sidecar-vs-embed-vs-burn-in).

### Analysis cache

Analyze is slow (denoise + silencedetect + freezedetect + whisper — tens of
seconds). The result is deterministic for a given file and the settings that
affect it, so it is cached on disk under
`${XDG_CACHE_HOME:-~/.cache}/clean-video` and reopening the same file is
near-instant.

Each pass is cached **separately**, keyed by file identity (absolute path +
size + mtime) plus only the knobs it depends on, so a knob change invalidates
only what it must:

| Artifact | Invalidated by |
| --- | --- |
| transcript (`whisper`) | file identity + whisper model / language |
| denoised audio (WAV) | file identity + denoise method |
| silence spans | file identity + denoise method + threshold + min-silence |
| activity (freeze) spans | file identity + freeze noise + min-duration |

So changing the whisper model re-runs only the transcript; silence/activity are
reused. Editing the source file (any size/mtime change) invalidates everything.
The **cut plan is never cached** — it is always rebuilt from the cached
artifacts against your current knobs, so cut-shaping is instant either way.

- The editor shows a badge when an analysis came fully or partly from cache; the
  progress lines say `cached` for reused passes.
- **Fresh analysis** — the CLI `--no-cache` flag and the Settings ▸ Advanced ▸
  "Fresh analysis (ignore cache)" checkbox force a full re-run (cache reads are
  skipped; fresh results are still written so the next open is warm).
- Denoised WAVs are large; they are evicted LRU under a byte cap (~2GB, override
  with `CLEAN_VIDEO_CACHE_MAX_BYTES`). The small JSON artifacts are kept. A
  corrupt/half-written cache entry is treated as a miss and overwritten.

### Security model

The server is localhost-only and treats the browser as untrusted so a malicious
web page can't use it to read arbitrary files:

- Bound to `127.0.0.1`; any request carrying a non-localhost `Origin` header is
  rejected (`403`).
- Only `/api/open` (and the native `/api/pick`) accept a filesystem path, and
  only after validation. Every other endpoint (`/api/media`, `/api/analyze`,
  `/api/render`) takes a **session id**, never a raw path — unknown/forged ids
  get `404`.

The bind address is configurable (`--host` / `HOST`, default `127.0.0.1`). The
Docker image binds `0.0.0.0` **inside the container** so the published port is
reachable from the host — but you publish it to `127.0.0.1` only (see below), so
it is still loopback-only from the outside, and the `Origin` check still applies.
There is no authentication: do not expose the port to a untrusted network.

## Run with Docker

Run the whole app — pipeline, whisper, ffmpeg, web editor — with no local
toolchain. The image bundles `ffmpeg` (with libass), a statically built
`whisper-cli`, and the linux `deep-filter` denoiser.

```bash
# build
docker build -t clean-video:latest .

# run: your videos at /videos, model + config on named volumes,
# port published to loopback only
docker run --rm \
  -p 127.0.0.1:5199:5199 \
  -v "$PWD/sample-videos":/videos \
  -v clean-video-models:/models \
  -v clean-video-config:/config \
  -v clean-video-cache:/cache \
  clean-video:latest
```

Then open <http://127.0.0.1:5199>.

Or with compose (`docker compose up --build`) — see `docker-compose.yml`.

**What's mounted where**

| Mount | Purpose |
| --- | --- |
| `/videos` | Your videos. Browsed via the in-app file browser; rendered `*.cleaned.mp4` / `.srt` / `.vtt` land here too, so mount it **read-write** (add `:ro` only if you just want to analyze, not render). |
| `/models` | Whisper models. Persist this so the first-run download happens once. |
| `/config` | Recents / preferences (`XDG_CONFIG_HOME`). |
| `/cache` | Analysis cache (`XDG_CACHE_HOME`). Persist this so reopening a file skips the slow re-analyze. WAVs are LRU-capped (~2GB, `CLEAN_VIDEO_CACHE_MAX_BYTES`). |

**Model download on first start.** The whisper model is *not* baked into the
image. On first run the entrypoint downloads `ggml-base.en.bin` into `/models`
and logs a line; subsequent runs reuse it. Override with `-e WHISPER_MODEL=small.en`.

**Two tradeoffs vs. a native install**

- *No native file dialog in a container.* Instead the image sets
  `--media-root /videos` and the home screen shows a click-through **file
  browser** scoped to that directory. Mount your videos there. (The pasted-path
  input still works too.)
- *CPU-only whisper.* Transcription runs on the CPU inside the container, so it
  is slower than a native Metal/CUDA build. Pick a smaller model
  (`-e WHISPER_MODEL=tiny.en` / `base.en`) if it drags.

## Run it as a background service

Because `clean-video ui` is persistent, you can run it as a login service on a
pinned port and just open `http://127.0.0.1:5199` whenever you need it. Use
`--no-open` so it doesn't pop a browser at login. Adjust the two absolute paths
(`node` and the repo) to your machine — `which node` and `pwd` in the repo.

### macOS (launchd)

Save as `~/Library/LaunchAgents/io.cobalt.clean-video.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.cobalt.clean-video</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/video-editor/dist/cli/index.js</string>
    <string>ui</string>
    <string>--no-open</string>
    <string>--port</string>
    <string>5199</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/video-editor</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/clean-video.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/clean-video.err</string>
</dict>
</plist>
```

Install / enable / stop:

```bash
launchctl load -w ~/Library/LaunchAgents/io.cobalt.clean-video.plist   # start now + at login
launchctl unload -w ~/Library/LaunchAgents/io.cobalt.clean-video.plist # stop + disable
```

`launchd` uses a minimal `PATH`, so ffmpeg/whisper-cli may not be found. If so,
add an `EnvironmentVariables` dict with a `PATH` that includes their directory
(e.g. `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`).

### Linux (systemd user unit)

Save as `~/.config/systemd/user/clean-video.service`:

```ini
[Unit]
Description=clean-video web editor
After=network.target

[Service]
ExecStart=/usr/bin/node /home/you/video-editor/dist/cli/index.js ui --no-open --port 5199
WorkingDirectory=/home/you/video-editor
Restart=on-failure
# If ffmpeg/whisper-cli aren't on the default PATH, extend it:
# Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Install / enable / status:

```bash
systemctl --user daemon-reload
systemctl --user enable --now clean-video     # start now + at login
systemctl --user status clean-video
loginctl enable-linger "$USER"                 # keep running when logged out (optional)
```

## Architecture

The core (`src/core/`) is pure TypeScript with **no CLI/UI dependencies** — every
external binary sits behind a thin, injectable adapter (`binaries.ts`), so the
bug-prone logic (silencedetect parsing, cut merging, timestamp remapping, SRT
generation) is unit-tested without touching ffmpeg or whisper.

```
src/
  core/
    types.ts        shared data model (Word, Cut, KeepSegment, CutPlan, …)
    binaries.ts     binary detection + injectable runner adapter
    probe.ts        ffprobe wrapper (duration, streams, resolution)
    denoise.ts      deep-filter / afftdn
    silence.ts      silencedetect → gap list
    transcribe.ts   whisper.cpp → word-level timestamps
    fillers.ts      heuristic + Claude filler/false-start detection
    cutlist.ts      merge silence + fillers → keep-list
    captions.ts     SRT + VTT with post-cut timestamp remapping
    render.ts       one-pass ffmpeg render (trim/atrim + concat), optional burn-in + soft-embed captions
    pipeline.ts     UI-agnostic orchestration: analyze() + finalize()
    openfile.ts     path-open validation (injectable stat/probe, unit-tested)
    sessions.ts     in-memory open-file session registry
    recents.ts      persisted "recently opened" list (pure ops + disk I/O)
  cli/
    index.ts        thin CLI: flags, preflight, interactive approval, `ui` command
  web/
    server.ts       localhost HTTP API wrapping the pipeline (SSE progress)
    pick.ts         native OS file-dialog detection + spawn
web-ui/             Vite + React + TS front end (builds to web-ui/dist)
  src/components/   Home (open/recents) + Editor (player/timeline/transcript)
```

**Phase 2 (web UI)** imports `analyze()` / `finalize()` from `core/pipeline.ts`
and reuses the same pure logic — the CLI and the web server are just two front
ends over the same core.

## Design notes / limitations

- **One render pass.** Cuts use a per-segment `trim`/`atrim` + `concat`
  filtergraph (passed via `-filter_complex_script`), so the video is re-encoded
  exactly once (no chained re-encodes). Cuts snap to whole-word boundaries from
  whisper — never mid-word.
- **Denoise runs before analysis**, so silence/transcription see the cleaned
  audio and the same track is muxed into the final render.
- The `--smart` tier shells out to `claude -p` for a JSON cut plan and degrades
  gracefully to heuristics on any parse/exec error.
- Output duration can differ from the sum of kept spans by a few frames because
  of audio-frame/keyframe rounding in the container — expected and harmless.
```
