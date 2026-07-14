import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { runBinary, type Runner } from "./binaries.js";
import type { Transcript, Word } from "./types.js";

/**
 * whisper.cpp (`whisper-cli`) wrapper producing word-level timestamps.
 *
 * We run whisper with `--max-len 1 --split-on-word`, which forces one word per
 * transcription segment, and `--output-json` for machine parsing. The JSON
 * parser (`parseWhisperJson`) is pure and unit tested; the binary + audio
 * extraction are isolated in `transcribe`.
 */

interface WhisperOffsets {
  from: number; // milliseconds
  to: number; // milliseconds
}

interface WhisperToken {
  text?: string;
  p?: number;
  offsets?: WhisperOffsets;
}

interface WhisperSegment {
  text?: string;
  offsets?: WhisperOffsets;
  tokens?: WhisperToken[];
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperSegment[];
}

/** Tokens whisper emits for non-speech that we must not treat as words. */
const NON_WORD = /^\s*(\[.*\]|\(.*\)|)\s*$/;

/** Pure: parse whisper.cpp JSON (--output-json / --output-json-full) into a Transcript. */
export function parseWhisperJson(json: string): Transcript {
  const data = JSON.parse(json) as WhisperJson;
  const segments = data.transcription ?? [];
  const words: Word[] = [];

  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text || NON_WORD.test(text)) continue;
    if (!seg.offsets) continue;
    const start = seg.offsets.from / 1000;
    const end = seg.offsets.to / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;

    let probability: number | undefined;
    if (seg.tokens && seg.tokens.length > 0) {
      const ps = seg.tokens.map((t) => t.p).filter((p): p is number => typeof p === "number");
      if (ps.length > 0) probability = ps.reduce((a, b) => a + b, 0) / ps.length;
    }

    const word: Word = { text, start, end };
    if (probability !== undefined) word.probability = probability;
    words.push(word);
  }

  const transcript: Transcript = { words };
  if (data.result?.language) transcript.language = data.result.language;
  return transcript;
}

export interface TranscribeOptions {
  /** path to a whisper .bin model; if omitted we resolve `model` in modelDir */
  modelPath?: string;
  /** model name, e.g. "base.en" (default) */
  model?: string;
  /** directory holding ggml-<model>.bin files */
  modelDir?: string;
  /** language hint, e.g. "en"; omit to auto-detect */
  language?: string;
  threads?: number;
}

/**
 * Conventional location whisper.cpp models live in. Overridable via
 * `CLEAN_VIDEO_MODEL_DIR` (used by the Docker image, which mounts models at
 * /models and downloads ggml-<model>.bin there on first run).
 */
export function defaultModelDir(): string {
  return process.env.CLEAN_VIDEO_MODEL_DIR || join(homedir(), ".cache", "whisper");
}

export function resolveModelPath(opts: TranscribeOptions): string {
  if (opts.modelPath) return opts.modelPath;
  const model = opts.model ?? "base.en";
  const dir = opts.modelDir ?? defaultModelDir();
  return join(dir, `ggml-${model}.bin`);
}

export async function transcribe(
  input: string,
  opts: TranscribeOptions = {},
  runner: Runner = runBinary,
): Promise<Transcript> {
  const modelPath = resolveModelPath(opts);
  const workDir = await mkdtemp(join(tmpdir(), "clean-video-whisper-"));
  const wavPath = join(workDir, "audio.wav");
  const outBase = join(workDir, "out");

  try {
    // 1. Extract 16kHz mono PCM wav (whisper.cpp requirement).
    const ext = await runner("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      input,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);
    if (ext.exitCode !== 0) {
      throw new Error(`audio extraction failed: ${ext.stderr.trim() || "unknown error"}`);
    }

    // 2. Run whisper-cli with word-level segmentation + JSON output.
    const args = [
      "-m",
      modelPath,
      "-f",
      wavPath,
      "--output-json",
      "--max-len",
      "1",
      "--split-on-word",
      // NB: must be the short form; whisper-cli rejects `--of` as unknown —
      // and exits 0 on unknown args, so the exit-code check can't catch it.
      "-of",
      outBase,
    ];
    if (opts.language) args.push("--language", opts.language);
    if (opts.threads) args.push("--threads", String(opts.threads));

    const res = await runner("whisper-cli", args);
    if (res.exitCode !== 0) {
      const hint = res.stderr.includes("failed to load")
        ? `\nModel not found at ${modelPath}. See README for how to download it.`
        : "";
      throw new Error(`whisper-cli failed: ${res.stderr.trim() || "unknown error"}${hint}`);
    }

    let json: string;
    try {
      json = await readFile(`${outBase}.json`, "utf8");
    } catch {
      // whisper-cli exits 0 even on bad arguments, so a missing output file
      // is our only signal that the invocation itself was rejected.
      const tail = (res.stderr || res.stdout).trim().split("\n").slice(-15).join("\n");
      throw new Error(
        `whisper-cli exited 0 but wrote no JSON output.\nLast output:\n${tail}`,
      );
    }
    return parseWhisperJson(json);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
