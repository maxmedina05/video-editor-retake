import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasBinary } from "./binaries.js";
import {
  cacheDir,
  createCache,
  denoiseKey,
  fileIdentity,
  freezeKey,
  maxCacheBytes,
  silenceKey,
  transcriptKey,
} from "./cache.js";
import { chooseDenoiseMethod, denoise, type DenoiseMethod, type DenoiseResult } from "./denoise.js";
import { probe } from "./probe.js";
import { detectSilence } from "./silence.js";
import { detectFrozenSpans } from "./activity.js";
import type { ActivityPolicy } from "./modes.js";
import { transcribe } from "./transcribe.js";
import { detectFillerCuts, smartFillerCuts } from "./fillers.js";
import { buildCutList } from "./cutlist.js";
import { generateCaptions } from "./captions.js";
import { render } from "./render.js";
import type { Cue, CutPlan, MediaInfo, Span, Transcript } from "./types.js";

/**
 * UI-agnostic orchestration. `analyze` runs the read-only analysis and returns
 * a proposed CutPlan; a UI (CLI now, web later) presents/edits it, then calls
 * `finalize` with the approved plan.
 */

/** Coarse progress reporting so a UI can show pipeline stages. */
export type ProgressFn = (stage: string, detail?: string) => void;

export interface AnalyzeOptions {
  denoise?: DenoiseMethod;
  /** optional coarse progress callback (UI-agnostic) */
  onProgress?: ProgressFn;
  smart?: boolean;
  minSilence?: number;
  padding?: number;
  /** natural pause left in place of a silence, seconds (default 0.75) */
  maxPause?: number;
  /** absorb keep-segments shorter than this, seconds (default 0.4) */
  minKeep?: number;
  /** cap on seconds removed from a single silence gap (0/undefined = uncapped) */
  maxCutPerSilence?: number;
  thresholdDb?: number;
  model?: string;
  modelPath?: string;
  modelDir?: string;
  language?: string;
  fillerWords?: string[];
  /** run heuristic filler-word removal (default true) */
  fillers?: boolean;
  /** activity policy (static vs active silence handling). Absent = treat all static. */
  activity?: ActivityPolicy;
  /** override deep-filter detection (tests) */
  hasDeepFilter?: boolean;
  /**
   * Consult the on-disk analysis cache (default true). When false we force a
   * fresh analyze (skip cache reads) but still WRITE fresh results, so the next
   * open is warm. Set env/dir via {@link cacheDirOverride}.
   */
  cache?: boolean;
  /** override the cache directory (tests); defaults to the XDG-aware location */
  cacheDirOverride?: string;
}

/** Which analysis artifacts were served from cache on this run. */
export interface CacheProvenance {
  transcript: boolean;
  denoise: boolean;
  silence: boolean;
  freeze: boolean;
}

export interface AnalyzeResult {
  info: MediaInfo;
  transcript: Transcript;
  silenceGaps: Span[];
  /** frozen video spans detected for activity classification (empty if not run) */
  frozenSpans: Span[];
  plan: CutPlan;
  denoise: DenoiseResult;
  /** temp dir holding denoised audio; caller must call `cleanup` when done */
  workDir: string;
  warnings: string[];
  /** per-artifact cache provenance for this analyze run */
  cache: CacheProvenance;
}

export async function analyze(input: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const warnings: string[] = [];
  const progress = opts.onProgress ?? (() => {});
  progress("probe", "reading media info");
  const info = await probe(input);
  const workDir = await mkdtemp(join(tmpdir(), "clean-video-"));

  // ---- cache setup --------------------------------------------------------
  // File identity = absolute path + size + mtime. If we can't stat the file we
  // simply run without caching. `readCache` gates reads (disabled by --no-cache
  // for a forced-fresh run); we always still WRITE so the next open is warm.
  const cache = createCache(opts.cacheDirOverride ?? cacheDir());
  const readCache = opts.cache ?? true;
  let identity: string | null = null;
  try {
    const st = await stat(input);
    identity = fileIdentity({ path: resolve(input), size: st.size, mtimeMs: st.mtimeMs });
  } catch {
    identity = null;
  }
  const provenance: CacheProvenance = {
    transcript: false,
    denoise: false,
    silence: false,
    freeze: false,
  };
  /** WAV keys to protect from eviction while this run is using them. */
  const pinnedWavKeys: string[] = [];

  // ---- denoise ------------------------------------------------------------
  const hasDeepFilter = opts.hasDeepFilter ?? (await hasBinary("deep-filter"));
  // Resolve the ACTUAL method (deep-filter may fall back to afftdn) so the cache
  // key reflects what was produced, not just what was requested.
  const decision = chooseDenoiseMethod(hasDeepFilter, opts.denoise);
  const dKey = identity ? denoiseKey(identity, { method: decision.method }) : null;

  let denoiseResult: DenoiseResult;
  if (decision.method === "none") {
    denoiseResult = { path: null, method: "none", fellBack: false };
  } else if (readCache && dKey && (await cache.hasWav(dKey))) {
    progress("denoise", "cached");
    provenance.denoise = true;
    pinnedWavKeys.push(dKey);
    denoiseResult = { path: cache.wavPath(dKey), method: decision.method, fellBack: decision.fellBack };
    if (decision.fellBack) {
      warnings.push("deep-filter not found; used ffmpeg afftdn for denoise instead.");
    }
  } else {
    progress("denoise", "cleaning audio");
    const fresh = await denoise(input, { method: opts.denoise, hasDeepFilter, workDir }, undefined);
    if (fresh.fellBack) {
      warnings.push("deep-filter not found; used ffmpeg afftdn for denoise instead.");
    }
    // Persist the denoised WAV in the cache and use that copy so it survives the
    // workDir cleanup and warms the next open. Failure to import is non-fatal.
    if (dKey && fresh.path) {
      const cached = await cache.importWav(dKey, fresh.path).catch(() => null);
      denoiseResult = cached ? { ...fresh, path: cached } : fresh;
      if (cached) pinnedWavKeys.push(dKey);
    } else {
      denoiseResult = fresh;
    }
  }

  const audioSource = denoiseResult.path ?? input;

  // ---- silence ------------------------------------------------------------
  // silencedetect bakes both params into the ffmpeg filter, so we key on the
  // exact resolved values (defaults mirror silence.ts).
  const minSilence = opts.minSilence ?? 0.8;
  const thresholdDb = opts.thresholdDb ?? -30;
  const sKey =
    identity && dKey ? silenceKey(identity, dKey, { thresholdDb, minSilence }) : null;
  let silenceGaps: Span[] | null = null;
  if (readCache && sKey) {
    const r = await cache.readJson<Span[]>(sKey);
    if (r.kind === "hit") {
      silenceGaps = r.value;
      provenance.silence = true;
      progress("silence", "cached");
    } else if (r.kind === "corrupt") {
      warnings.push(`cached silence data was unreadable (${r.error}); recomputing.`);
    }
  }
  if (silenceGaps === null) {
    progress("silence", "detecting silences");
    silenceGaps = await detectSilence(audioSource, { minSilence, thresholdDb }, info.duration);
    if (sKey) await cache.writeJson(sKey, silenceGaps).catch(() => {});
  }

  // ---- activity (freezedetect) --------------------------------------------
  // Only run freezedetect when the mode is activity-aware AND there is a video
  // track. Silence detection runs on the DENOISED audio (a separate file);
  // freezedetect needs the video stream of the ORIGINAL input, so it is a
  // separate, self-contained pass (one extra video decode).
  let frozenSpans: Span[] = [];
  if (opts.activity?.aware && info.hasVideo) {
    const noise = opts.activity.noise ?? 0.001;
    const minDuration = opts.activity.minFreeze ?? 1.0;
    const fKey = identity ? freezeKey(identity, { noise, minDuration }) : null;
    let done = false;
    if (readCache && fKey) {
      const r = await cache.readJson<Span[]>(fKey);
      if (r.kind === "hit") {
        frozenSpans = r.value;
        provenance.freeze = true;
        done = true;
        progress("activity", "cached");
      } else if (r.kind === "corrupt") {
        warnings.push(`cached activity data was unreadable (${r.error}); recomputing.`);
      }
    }
    if (!done) {
      progress("activity", "detecting static/active video (freezedetect)");
      try {
        frozenSpans = await detectFrozenSpans(input, { noise, minDuration }, info.duration);
        if (fKey) await cache.writeJson(fKey, frozenSpans).catch(() => {});
      } catch (err) {
        warnings.push(
          `activity detection failed (${(err as Error).message}); treating all silences as static.`,
        );
      }
    }
  }

  // ---- transcribe (the expensive pass) ------------------------------------
  const tKey = identity
    ? transcriptKey(identity, {
        model: opts.model ?? "base.en",
        modelPath: opts.modelPath,
        language: opts.language,
      })
    : null;
  let transcript: Transcript | null = null;
  if (readCache && tKey) {
    const r = await cache.readJson<Transcript>(tKey);
    if (r.kind === "hit") {
      transcript = r.value;
      provenance.transcript = true;
      progress("transcribe", "cached");
    } else if (r.kind === "corrupt") {
      warnings.push(`cached transcript was unreadable (${r.error}); re-running whisper.`);
    }
  }
  if (transcript === null) {
    progress("transcribe", "running whisper (this is the slow part)");
    transcript = await transcribe(audioSource, {
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.modelPath !== undefined ? { modelPath: opts.modelPath } : {}),
      ...(opts.modelDir !== undefined ? { modelDir: opts.modelDir } : {}),
      ...(opts.language !== undefined ? { language: opts.language } : {}),
    });
    if (tKey) await cache.writeJson(tKey, transcript).catch(() => {});
  }

  // Keep the WAV cache within its byte cap (LRU), protecting this run's WAV.
  if (identity) await cache.evictWavs(maxCacheBytes(), pinnedWavKeys).catch(() => {});

  const fillersEnabled = opts.fillers ?? true;
  progress("fillers", fillersEnabled ? "detecting filler words" : "filler removal disabled");
  let fillerCuts = fillersEnabled
    ? detectFillerCuts(transcript, {
        ...(opts.fillerWords !== undefined ? { fillerWords: opts.fillerWords } : {}),
      })
    : [];

  if (opts.smart) {
    progress("smart", "asking Claude for smarter cuts");
    try {
      const smart = await smartFillerCuts(transcript);
      fillerCuts = [...fillerCuts, ...smart];
    } catch (err) {
      warnings.push(
        `--smart failed (${(err as Error).message}); used heuristic filler detection only.`,
      );
    }
  }

  progress("plan", "building cut plan");
  const plan = buildCutList({
    sourceDuration: info.duration,
    words: transcript.words,
    silenceGaps,
    fillerCuts,
    frozenSpans,
    ...(opts.activity
      ? {
          activity: {
            aware: opts.activity.aware,
            threshold: opts.activity.threshold,
            cutActive: opts.activity.cutActive,
            activeMaxPause: opts.activity.activeMaxPause,
            activeMinGap: opts.activity.activeMinGap,
          },
        }
      : {}),
    ...(opts.padding !== undefined ? { padding: opts.padding } : {}),
    ...(opts.maxPause !== undefined ? { maxPause: opts.maxPause } : {}),
    ...(opts.minKeep !== undefined ? { minKeep: opts.minKeep } : {}),
    ...(opts.maxCutPerSilence !== undefined ? { maxCutPerSilence: opts.maxCutPerSilence } : {}),
  });

  return {
    info,
    transcript,
    silenceGaps,
    frozenSpans,
    plan,
    denoise: denoiseResult,
    workDir,
    warnings,
    cache: provenance,
  };
}

export interface FinalizeOptions {
  input: string;
  /** approved (possibly edited) plan */
  plan: CutPlan;
  transcript: Transcript;
  info: MediaInfo;
  denoise: DenoiseResult;
  outputVideo: string;
  srtPath: string;
  vttPath: string;
  cutplanPath: string;
  burn?: boolean;
  /** mux the cut SRT as a soft, toggleable mov_text subtitle track (any ffmpeg) */
  embed?: boolean;
  crf?: number;
  preset?: string;
  onProgress?: ProgressFn;
}

/**
 * Write caption sidecars + cutplan.json and run the single-pass render.
 * Returns the OUTPUT-timeline caption cues (same ones written to the .srt),
 * so a caller can preview the rendered result with matching captions.
 */
export async function finalize(o: FinalizeOptions): Promise<{ cues: Cue[] }> {
  const progress = o.onProgress ?? (() => {});
  progress("captions", "writing SRT/VTT + cutplan");
  const { srt, vtt, cues } = generateCaptions(o.transcript.words, o.plan.keep);
  await writeFile(o.srtPath, srt, "utf8");
  await writeFile(o.vttPath, vtt, "utf8");
  await writeFile(
    o.cutplanPath,
    JSON.stringify({ ...o.plan, captionCues: cues.length }, null, 2),
    "utf8",
  );

  progress("render", "encoding video (single ffmpeg pass)");
  await render({
    input: o.input,
    output: o.outputVideo,
    keep: o.plan.keep,
    ...(o.denoise.path ? { audioInput: o.denoise.path } : {}),
    ...(o.burn ? { burnSubtitles: o.srtPath } : {}),
    ...(o.embed ? { embedCaptions: o.srtPath } : {}),
    hasVideo: o.info.hasVideo,
    hasAudio: o.info.hasAudio,
    ...(o.crf !== undefined ? { crf: o.crf } : {}),
    ...(o.preset !== undefined ? { preset: o.preset } : {}),
  });
  return { cues };
}

export async function cleanup(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
}
