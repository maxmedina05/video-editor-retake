import { basename, join } from "node:path";
import { runBinary, type Runner } from "./binaries.js";

/**
 * Noise removal. Prefers the DeepFilterNet `deep-filter` binary when present,
 * otherwise falls back to ffmpeg's `afftdn` filter. Produces a full-length
 * denoised WAV on the ORIGINAL timeline (same duration as input), which the
 * render step can map as the audio source.
 */

export type DenoiseMethod = "deep-filter" | "afftdn" | "none";

export interface DenoiseDecision {
  method: DenoiseMethod;
  /** true when the caller asked for deep-filter but it wasn't available */
  fellBack: boolean;
}

/**
 * Pure: pick the denoise method.
 * - requested "none"       -> none
 * - requested "afftdn"     -> afftdn
 * - requested "deep-filter"-> deep-filter if available, else afftdn (fellBack)
 * - requested undefined    -> deep-filter if available, else afftdn
 */
export function chooseDenoiseMethod(
  hasDeepFilter: boolean,
  requested?: DenoiseMethod,
): DenoiseDecision {
  if (requested === "none") return { method: "none", fellBack: false };
  if (requested === "afftdn") return { method: "afftdn", fellBack: false };
  if (hasDeepFilter) return { method: "deep-filter", fellBack: false };
  return { method: "afftdn", fellBack: requested === "deep-filter" };
}

export interface DenoiseResult {
  /** path to denoised wav, or null when method is "none" */
  path: string | null;
  method: DenoiseMethod;
  fellBack: boolean;
}

export interface DenoiseOptions {
  method?: DenoiseMethod;
  hasDeepFilter?: boolean;
  /** working directory for intermediate files (caller-managed temp dir) */
  workDir: string;
}

export async function denoise(
  input: string,
  opts: DenoiseOptions,
  runner: Runner = runBinary,
): Promise<DenoiseResult> {
  const decision = chooseDenoiseMethod(opts.hasDeepFilter ?? false, opts.method);
  if (decision.method === "none") {
    return { path: null, method: "none", fellBack: false };
  }

  if (decision.method === "deep-filter") {
    // DeepFilterNet works on 48kHz mono/stereo wav; extract then process.
    const rawWav = join(opts.workDir, "raw48.wav");
    const ext = await runner("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      input,
      "-ar",
      "48000",
      "-c:a",
      "pcm_s16le",
      rawWav,
    ]);
    if (ext.exitCode !== 0) {
      throw new Error(`audio extraction failed: ${ext.stderr.trim() || "unknown"}`);
    }
    const df = await runner("deep-filter", [rawWav, "-o", opts.workDir]);
    if (df.exitCode !== 0) {
      throw new Error(`deep-filter failed: ${df.stderr.trim() || "unknown"}`);
    }
    // deep-filter writes <outdir>/<basename>.
    return {
      path: join(opts.workDir, basename(rawWav)),
      method: "deep-filter",
      fellBack: decision.fellBack,
    };
  }

  // afftdn fallback
  const outWav = join(opts.workDir, "denoised.wav");
  const res = await runner("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-y",
    "-i",
    input,
    "-af",
    "afftdn=nf=-25",
    "-c:a",
    "pcm_s16le",
    outWav,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(`ffmpeg afftdn failed: ${res.stderr.trim() || "unknown"}`);
  }
  return { path: outWav, method: "afftdn", fellBack: decision.fellBack };
}
