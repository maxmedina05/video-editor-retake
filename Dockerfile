# syntax=docker/dockerfile:1
#
# clean-video — run the whole app (web editor + pipeline) with no local
# toolchain. Multi-stage:
#   deps     : prod-only node_modules
#   builder  : compile core (dist/) + web UI (web-ui/dist/) + fetch deep-filter
#   whisper  : build whisper.cpp's whisper-cli (static) via cmake
#   runtime  : slim base + ffmpeg (apt, has libass) + node + everything above
#
# The whisper model is NOT baked in — the entrypoint downloads it into the
# mounted /models volume on first run. See README "Run with Docker".

# ---- deps: production node_modules only -------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- builder: full build (core + web UI) + linux deep-filter ----------------
FROM node:20-bookworm AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web-ui/package.json web-ui/package-lock.json ./web-ui/
RUN npm --prefix web-ui ci
COPY . .
RUN npm run build \
 && npm --prefix web-ui run build \
 && npm run fetch-binaries

# ---- whisper: build whisper-cli from source (statically linked) -------------
FROM debian:bookworm-slim AS whisper
# clang, not g++: GCC 12 on aarch64 fails ggml-cpu's NEON fp16 intrinsics with
# "target specific option mismatch"; clang compiles them cleanly. libgomp for
# OpenMP (clang uses GNU's libgomp on Debian).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake clang libgomp1 make ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp
WORKDIR /opt/whisper.cpp
# BUILD_SHARED_LIBS=OFF -> whisper-cli links whisper/ggml statically, so the
# runtime image only needs the single binary (+ libgomp for OpenMP).
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
      -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
 && cmake --build build --config Release -j "$(nproc)" --target whisper-cli

# ---- runtime ----------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=deps    /app/node_modules       ./node_modules
COPY --from=builder /app/dist               ./dist
COPY --from=builder /app/web-ui/dist        ./web-ui/dist
COPY --from=builder /app/bin                ./bin
COPY --from=builder /app/package.json       ./package.json
COPY --from=whisper /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/whisper-cli \
 && mkdir -p /videos /models /config /cache

# In-container defaults: bind all interfaces (published to 127.0.0.1 on host),
# models mounted at /models, config/recents at /config (XDG-aware), and the
# analysis cache at /cache (XDG_CACHE_HOME) so reopening a file stays instant
# across container restarts.
ENV HOST=0.0.0.0 \
    PORT=5199 \
    CLEAN_VIDEO_MODEL_DIR=/models \
    WHISPER_MODEL=base.en \
    XDG_CONFIG_HOME=/config \
    XDG_CACHE_HOME=/cache

EXPOSE 5199
VOLUME ["/models", "/config", "/cache"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/cli/index.js", "ui", "--no-open", "--media-root", "/videos"]
