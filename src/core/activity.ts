import { runBinary, type Runner } from "./binaries.js";
import type { Span } from "./types.js";

/**
 * Activity (motion) detection via ffmpeg's `freezedetect` filter.
 *
 * A screen recording is nearly static by nature, so "the user stopped talking"
 * does not mean "nothing is happening on screen": they may be scrolling, moving
 * the mouse or typing. `freezedetect` reports spans where consecutive frames are
 * (near-)identical, i.e. the video is truly FROZEN. We use those frozen spans to
 * classify a silence gap as `static` (safe to shorten) vs `active` (leave alone
 * or shorten gently), so we don't jump-cut a section where the screen is busy.
 *
 * Parsing (`parseFreezeDetect`) is pure and unit tested; the binary call is
 * isolated in `detectFrozenSpans`, matching the silence.ts adapter style.
 */

export interface FreezeOptions {
  /**
   * Noise tolerance as a difference ratio between 0 and 1 (freezedetect `n`).
   * ffmpeg's default is 0.001 (-60dB): frames must be near-identical to count as
   * frozen, so real mouse/scroll/typing motion reliably breaks a freeze. Tuned
   * against real screen-recording footage — see activity.test.ts / the TODO.
   */
  noise?: number;
  /** minimum freeze duration to report, seconds (freezedetect `d`, default 1.0) */
  minDuration?: number;
}

/**
 * Pure: parse ffmpeg stderr from the freezedetect filter into frozen spans.
 *
 * ffmpeg emits metadata lines like:
 *   [freezedetect @ 0x..] lavfi.freezedetect.freeze_start: 43.423
 *   [freezedetect @ 0x..] lavfi.freezedetect.freeze_duration: 56.466667
 *   [freezedetect @ 0x..] lavfi.freezedetect.freeze_end: 99.889667
 *
 * A trailing freeze_start with no matching freeze_end (freeze running to EOF) is
 * closed at `duration` if provided.
 */
export function parseFreezeDetect(stderr: string, duration?: number): Span[] {
  const spans: Span[] = [];
  let openStart: number | null = null;

  const startRe = /freeze_start:\s*(-?[\d.]+)/;
  const endRe = /freeze_end:\s*(-?[\d.]+)/;

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

export async function detectFrozenSpans(
  input: string,
  opts: FreezeOptions = {},
  duration?: number,
  runner: Runner = runBinary,
): Promise<Span[]> {
  const noise = opts.noise ?? 0.001;
  const minDuration = opts.minDuration ?? 1.0;
  const { stderr, exitCode } = await runner("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-vf",
    `freezedetect=n=${noise}:d=${minDuration}`,
    "-f",
    "null",
    "-",
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg freezedetect failed: ${stderr.trim() || "unknown error"}`);
  }
  return parseFreezeDetect(stderr, duration);
}

/** Seconds of `gap` covered by any frozen span, as a fraction of the gap length. */
export function frozenOverlapFraction(gap: Span, frozen: Span[]): number {
  const len = gap.end - gap.start;
  if (len <= 0) return 0;
  let covered = 0;
  for (const f of frozen) {
    const lo = Math.max(gap.start, f.start);
    const hi = Math.min(gap.end, f.end);
    if (hi > lo) covered += hi - lo;
  }
  return Math.min(1, covered / len);
}

export type GapActivity = "static" | "active";

/**
 * Classify a silence gap: `static` if its overlap with frozen video spans is at
 * least `threshold` (default 0.7), else `active`.
 */
export function classifyGap(gap: Span, frozen: Span[], threshold = 0.7): GapActivity {
  return frozenOverlapFraction(gap, frozen) >= threshold ? "static" : "active";
}
