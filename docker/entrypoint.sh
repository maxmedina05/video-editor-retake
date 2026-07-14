#!/bin/sh
# Entrypoint for the clean-video Docker image.
#
# The whisper model is deliberately NOT baked into the image. On first run we
# download ggml-<model>.bin into the mounted model dir (CLEAN_VIDEO_MODEL_DIR,
# default /models) if it is not already present, then exec the server.
#
# Overridable via env:
#   WHISPER_MODEL          model name (default: base.en)
#   CLEAN_VIDEO_MODEL_DIR  where models live (default: /models)
#   WHISPER_MODEL_BASE_URL model download base URL
set -e

MODEL="${WHISPER_MODEL:-base.en}"
MODEL_DIR="${CLEAN_VIDEO_MODEL_DIR:-/models}"
BASE_URL="${WHISPER_MODEL_BASE_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main}"
MODEL_FILE="$MODEL_DIR/ggml-$MODEL.bin"

mkdir -p "$MODEL_DIR"

if [ ! -f "$MODEL_FILE" ]; then
  echo "[entrypoint] whisper model '$MODEL' not found at $MODEL_FILE"
  echo "[entrypoint] downloading (first run only): $BASE_URL/ggml-$MODEL.bin"
  curl -fL --retry 3 -o "$MODEL_FILE.partial" "$BASE_URL/ggml-$MODEL.bin"
  mv "$MODEL_FILE.partial" "$MODEL_FILE"
  echo "[entrypoint] model saved to $MODEL_FILE ($(du -h "$MODEL_FILE" | cut -f1))"
else
  echo "[entrypoint] using existing whisper model: $MODEL_FILE"
fi

exec "$@"
