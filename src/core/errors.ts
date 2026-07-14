import { REQUIREMENTS } from "./binaries.js";

/**
 * Map raw pipeline/tooling errors to human messages + fix hints (P3-2).
 *
 * The server applies this at the API boundary so the UI shows "ffmpeg is not
 * installed — brew install ffmpeg" instead of "spawn ffmpeg ENOENT". The rule
 * table lives here (next to REQUIREMENTS, where the install knowledge is) and
 * is exported for the table-driven unit test. Unknown errors pass through
 * verbatim — never hide information we can't improve on.
 */

export interface FriendlyError {
  /** short human explanation of what went wrong */
  message: string;
  /** how to fix it (install command, README pointer), when we know */
  hint?: string;
}

/** Platform-appropriate install hint for a REQUIREMENTS entry. */
function installHint(binary: keyof typeof REQUIREMENTS, platform: NodeJS.Platform): string {
  const req = REQUIREMENTS[binary]!;
  const cmd = platform === "darwin" ? req.install.brew : req.install.apt;
  return cmd ?? req.install.note ?? "see README → Requirements";
}

const MODEL_HINT =
  "Download it (see README → Whisper model): " +
  "curl -L -o ~/.cache/whisper/ggml-base.en.bin " +
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

export interface ErrorRule {
  /** stable id, used by tests */
  id: string;
  test: RegExp;
  message: string;
  hint?: (platform: NodeJS.Platform) => string;
}

/**
 * First match wins. ENOENT rules come first: a missing binary also matches the
 * generic "X failed" rules, and the missing-binary diagnosis is the useful one.
 */
export const ERROR_RULES: ErrorRule[] = [
  {
    id: "ffmpeg-missing",
    test: /ENOENT[^]*\bffmpeg\b|\bffmpeg\b[^]*ENOENT/i,
    message: "ffmpeg is not installed (or not on your PATH).",
    hint: (p) => installHint("ffmpeg", p),
  },
  {
    id: "ffprobe-missing",
    test: /ENOENT[^]*\bffprobe\b|\bffprobe\b[^]*ENOENT/i,
    message: "ffprobe is not installed (or not on your PATH).",
    hint: (p) => installHint("ffprobe", p),
  },
  {
    id: "whisper-missing",
    test: /ENOENT[^]*whisper-cli|whisper-cli[^]*ENOENT/i,
    message: "whisper-cli is not installed (or not on your PATH).",
    hint: (p) => installHint("whisper-cli", p),
  },
  {
    id: "model-missing",
    test: /Model not found at|failed to load model|no such file.*ggml-|failed to (open|load) '[^']*\.bin'/i,
    message: "The whisper speech model is missing, so transcription can't run.",
    hint: () => MODEL_HINT,
  },
  {
    id: "whisper-failed",
    test: /whisper-cli (failed|exited 0 but wrote no JSON)/i,
    message: "Transcription failed (whisper-cli did not produce a usable result).",
    hint: () => "Try a different model in Settings, or run the CLI for the full whisper log.",
  },
  {
    id: "probe-failed",
    test: /ffprobe failed/i,
    message: "Could not read this file — it may not be a video, or it is corrupted.",
  },
  {
    id: "audio-extract-failed",
    test: /audio extraction failed|waveform extraction failed/i,
    message: "Could not extract audio from this file — does it have an audio track?",
  },
  {
    id: "render-failed",
    test: /ffmpeg render failed/i,
    message: "The render failed inside ffmpeg.",
    hint: () => "Re-try once; if it persists, run the CLI on this file for the full ffmpeg log.",
  },
  {
    id: "silence-failed",
    test: /silencedetect failed/i,
    message: "Silence detection failed inside ffmpeg.",
  },
  {
    id: "nothing-to-render",
    test: /nothing left to render/i,
    message: "Nothing left to render — the cuts remove everything. Keep (reject) some cuts first.",
  },
];

/**
 * Map a raw error string to a friendly message + optional fix hint.
 * Unknown errors are returned as-is (message = raw, no hint).
 */
export function mapError(raw: string, platform: NodeJS.Platform = process.platform): FriendlyError {
  for (const rule of ERROR_RULES) {
    if (rule.test.test(raw)) {
      const out: FriendlyError = { message: rule.message };
      const hint = rule.hint?.(platform);
      if (hint) out.hint = hint;
      return out;
    }
  }
  return { message: raw };
}
