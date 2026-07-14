# Running clean-video on Ubuntu

clean-video is cross-platform. This is the exact setup for a fresh Ubuntu
machine (tested target: Ubuntu 24.04 LTS). Everything runs locally.

## 1. System packages (apt)

```bash
sudo apt update
sudo apt install -y ffmpeg build-essential git cmake
```

- `ffmpeg` on Ubuntu is built **with libass**, so the `subtitles` filter (used by
  `--burn`) is available out of the box — unlike Homebrew's default macOS build.
- `--embed` (soft `mov_text` captions) works regardless.

## 2. Node.js 20+

clean-video needs Node >= 20. Ubuntu's apt Node may be older, so use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should print v20.x or newer
```

(Or use `nvm`: `nvm install 20 && nvm use 20`.)

## 3. whisper.cpp (provides `whisper-cli`)

There is no apt package; build it from source and put `whisper-cli` on your PATH:

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build --config Release -j
# the binary lands at build/bin/whisper-cli
sudo install build/bin/whisper-cli /usr/local/bin/whisper-cli
whisper-cli --help
```

Then download a model (not auto-fetched):

```bash
mkdir -p ~/.cache/whisper
curl -L -o ~/.cache/whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

## 4. clean-video itself

```bash
git clone <this repo>
cd video-editor
npm ci                 # or: npm install
npm run fetch-binaries # downloads the linux deep-filter binary into bin/ (optional)
npm run build          # compiles to dist/
npm run build:ui       # builds the web UI (optional, for the `ui` command)
npm test               # unit tests
```

`npm run fetch-binaries` detects `linux-x64` / `linux-arm64` and downloads the
matching DeepFilterNet v0.5.6 asset into `bin/deep-filter-linux-<arch>`. If you
skip it, denoising falls back to ffmpeg's `afftdn` automatically.

## 5. Run

```bash
# CLI
node dist/cli/index.js recording.mp4 --yes --embed

# web editor (persistent, localhost only)
node dist/cli/index.js ui
```

For the native "Open video…" dialog in the web UI, install `zenity` (GNOME) or
`kdialog` (KDE):

```bash
sudo apt install -y zenity   # or: kdialog
```

Without either, use the path input / recents in the home screen instead.

## Running as a service

See the "Linux (systemd user unit)" section in the main
[README](../README.md#run-it-as-a-background-service).

---

## Verification status (be honest)

The macOS build of this checkout is fully verified (build, unit tests, and an
end-to-end CLI render with `--embed` producing a `mov_text` subtitle stream).

**The Linux path is now verified in a container** (`node:20-bookworm`,
`linux/arm64`, apt `ffmpeg` 5.1.9). The following all passed against the built
`dist/`:

- `apt install ffmpeg` → `npm ci` → `npm run build` → `npm test`
  (**116 unit tests pass** on Linux).
- `npm run fetch-binaries` downloaded the `aarch64-unknown-linux-gnu`
  deep-filter binary into `bin/deep-filter-linux-arm64` and its `--version`
  check passed (`deep_filter 0.5.6`).
- `resolveBinary` picked `bin/deep-filter-linux-arm64` at runtime, and the
  **deep-filter denoise leg** ran successfully against it (no fallback).
- `hasFfmpegFilter('subtitles')` is **true** on apt ffmpeg (libass present), and
  a single-pass render with **both `embedCaptions` and `burnSubtitles`**
  produced an output whose streams ffprobe reports as `video:h264`,
  `audio:aac`, `subtitle:mov_text`.
- Silence detection and cut-list building ran end to end on the sample video.

whisper.cpp `whisper-cli` is verified via the **Docker image** (see the main
README "Run with Docker"): it is built from source with CMake + clang
(`-DBUILD_SHARED_LIBS=OFF`, statically linked) and runs a real CPU transcription
of the sample video in-container. Note: on `aarch64` with GCC 12, ggml-cpu's
NEON fp16 intrinsics fail to compile ("target specific option mismatch"); the
image builds with **clang** to avoid this. If you build whisper.cpp yourself on
an ARM Ubuntu host with the apt default `g++`, use clang instead
(`cmake -B build -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++`).

The `linux-x64` (`x86_64-unknown-linux-musl`) deep-filter asset is downloaded by
the same code path but was exercised on arm64 here; x64 differs only in the
release asset name.
