import { runBinary, type Runner } from "./binaries.js";
import type { Span } from "./types.js";

/**
 * Silence detection via ffmpeg's `silencedetect` filter.
 * Parsing (`parseSilenceDetect`) is pure and unit tested; the binary call is
 * isolated in `detectSilence`.
 */

export interface SilenceOptions {
  /** minimum silence duration to treat as a gap, seconds (default 0.8) */
  minSilence?: number;
  /** silence threshold in dB (default -30) */
  thresholdDb?: number;
}

/**
 * Pure: parse ffmpeg stderr from the silencedetect filter into silence spans.
 *
 * ffmpeg emits lines like:
 *   [silencedetect @ 0x..] silence_start: 12.345
 *   [silencedetect @ 0x..] silence_end: 15.678 | silence_duration: 3.333
 *
 * A trailing silence_start with no matching silence_end (silence running to
 * EOF) is closed at `duration` if provided.
 */
export function parseSilenceDetect(stderr: string, duration?: number): Span[] {
  const spans: Span[] = [];
  let openStart: number | null = null;

  const startRe = /silence_start:\s*(-?[\d.]+)/;
  const endRe = /silence_end:\s*(-?[\d.]+)/;

  for (const line of stderr.split("\n")) {
    const startMatch = line.match(startRe);
    if (startMatch) {
      openStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(endRe);
    if (endMatch && openStart !== null) {
      const end = Number(endMatch[1]);
      if (Number.isFinite(openStart) && Number.isFinite(end) && end > openStart) {
        spans.push({ start: Math.max(0, openStart), end });
      }
      openStart = null;
    }
  }

  if (openStart !== null && duration !== undefined && duration > openStart) {
    spans.push({ start: Math.max(0, openStart), end: duration });
  }

  return spans;
}

export async function detectSilence(
  input: string,
  opts: SilenceOptions = {},
  duration?: number,
  runner: Runner = runBinary,
): Promise<Span[]> {
  const minSilence = opts.minSilence ?? 0.8;
  const thresholdDb = opts.thresholdDb ?? -30;
  const { stderr, exitCode } = await runner("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    input,
    "-af",
    `silencedetect=noise=${thresholdDb}dB:d=${minSilence}`,
    "-f",
    "null",
    "-",
  ]);
  // ffmpeg writes the filter output to stderr and exits 0 on success.
  if (exitCode !== 0) {
    throw new Error(`ffmpeg silencedetect failed: ${stderr.trim() || "unknown error"}`);
  }
  return parseSilenceDetect(stderr, duration);
}
