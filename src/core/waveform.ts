import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBinary, type Runner } from "./binaries.js";

/**
 * Audio waveform peaks for the timeline (P2-4).
 *
 * `computePeaks` is pure and unit tested; `extractWaveformPeaks` isolates the
 * ffmpeg call: decode to mono 16-bit PCM at a low sample rate, then downsample
 * to ~1-2k max-amplitude buckets. The result is a tiny JSON artifact cached
 * per file identity (see cache.waveformKey), like the other analysis passes.
 */

/** Peak buckets per file — enough for a per-pixel bar on any sane timeline width. */
export const WAVEFORM_BUCKETS = 1500;

/** Decode sample rate. Peaks only need envelope resolution, not fidelity. */
export const WAVEFORM_SAMPLE_RATE = 8000;

/**
 * Pure: downsample PCM samples into `buckets` max-|amplitude| values in 0..1.
 *
 * Each bucket covers an equal slice of the input; its value is the maximum
 * absolute sample in that slice, scaled to 0..1. When `normalize` (default) and
 * the loudest bucket is > 0, everything is rescaled so that bucket is 1 — this
 * keeps quiet recordings visually readable, which is the whole point of the
 * waveform (silences must look flat next to speech).
 */
export function computePeaks(
  samples: ArrayLike<number>,
  buckets: number,
  opts: { normalize?: boolean } = {},
): number[] {
  const n = samples.length;
  const count = Math.max(1, Math.floor(buckets));
  const peaks = new Array<number>(count).fill(0);
  if (n === 0) return peaks;

  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * n) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / count));
    let max = 0;
    for (let i = from; i < to && i < n; i++) {
      const v = Math.abs(samples[i]!);
      if (v > max) max = v;
    }
    peaks[b] = max / 32768;
  }

  if (opts.normalize ?? true) {
    const top = Math.max(...peaks);
    if (top > 0) {
      for (let b = 0; b < count; b++) peaks[b] = peaks[b]! / top;
    }
  }
  // Round to 3 decimals so the cached JSON stays small (~10 KB).
  for (let b = 0; b < count; b++) peaks[b] = Math.round(peaks[b]! * 1000) / 1000;
  return peaks;
}

/**
 * Extract waveform peaks from a media file: one ffmpeg pass to raw mono PCM in
 * a temp file, then pure downsampling. Throws on ffmpeg failure (e.g. the file
 * has no audio track).
 */
export async function extractWaveformPeaks(
  input: string,
  opts: { buckets?: number } = {},
  runner: Runner = runBinary,
): Promise<number[]> {
  const buckets = opts.buckets ?? WAVEFORM_BUCKETS;
  const workDir = await mkdtemp(join(tmpdir(), "clean-video-wave-"));
  const pcmPath = join(workDir, "audio.pcm");
  try {
    const res = await runner("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      input,
      "-ac",
      "1",
      "-ar",
      String(WAVEFORM_SAMPLE_RATE),
      "-f",
      "s16le",
      "-c:a",
      "pcm_s16le",
      pcmPath,
    ]);
    if (res.exitCode !== 0) {
      throw new Error(`ffmpeg waveform extraction failed: ${res.stderr.trim() || "unknown error"}`);
    }
    const buf = await readFile(pcmPath);
    const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    return computePeaks(samples, buckets);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
