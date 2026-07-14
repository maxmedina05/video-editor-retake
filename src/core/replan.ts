import { buildCutList } from "./cutlist.js";
import { detectFillerCuts } from "./fillers.js";
import { modeDefaults, type Mode } from "./modes.js";
import type { CutPlan, Span, Word } from "./types.js";

/**
 * Analysis artifacts a re-plan reuses. These are the EXPENSIVE outputs (whisper
 * transcript, ffmpeg silence/freeze detection) already produced by `analyze`;
 * a re-plan reshapes the cut list from them without touching ffmpeg/whisper.
 */
export interface ReplanArtifacts {
  sourceDuration: number;
  words: Word[];
  silenceGaps: Span[];
  frozenSpans: Span[];
}

/** Plan-only knobs — everything here reshapes the plan without re-detection. */
export interface ReplanKnobs {
  mode: Mode;
  /**
   * Filter FLOOR applied to the cached silence gaps: gaps shorter than this are
   * dropped. Gaps were detected at analyze time, so raising the floor (e.g.
   * switching to a more conservative mode) is exact; lowering it below the
   * analyze-time value cannot recover gaps that were never detected — that case
   * needs a real re-analyze, which is why min-silence keeps the Re-analyze path.
   */
  minSilence?: number;
  maxPause?: number;
  maxCutPerSilence?: number;
  minKeep?: number;
  padding?: number;
  /** run heuristic filler-word removal (default: the mode's setting) */
  fillers?: boolean;
  fillerWords?: string[];
}

const EPS = 1e-6;

/**
 * Rebuild a CutPlan from ALREADY-COMPUTED analysis artifacts using plan-shaping
 * knobs only — no whisper, no ffmpeg. This is the server side of the live
 * `/api/plan` re-plan: switching mode or nudging max-pause / per-gap cap /
 * min-keep / padding / the filler list reshapes the plan instantly.
 *
 * The mode contributes its ACTIVITY policy (static/active silence handling) plus
 * the default per-gap cap and fillers-on flag; explicit knob values win. Note
 * that `smart` (Claude) cuts are intentionally NOT reproduced here — they live
 * behind the re-analyze path.
 */
export function rebuildPlan(art: ReplanArtifacts, knobs: ReplanKnobs): CutPlan {
  const md = modeDefaults(knobs.mode);
  const gaps =
    knobs.minSilence !== undefined
      ? art.silenceGaps.filter((g) => g.end - g.start >= knobs.minSilence! - EPS)
      : art.silenceGaps;
  const fillersOn = knobs.fillers ?? md.fillers;
  const fillerCuts = fillersOn
    ? detectFillerCuts(
        { words: art.words },
        knobs.fillerWords ? { fillerWords: knobs.fillerWords } : {},
      )
    : [];
  return buildCutList({
    sourceDuration: art.sourceDuration,
    words: art.words,
    silenceGaps: gaps,
    fillerCuts,
    frozenSpans: art.frozenSpans,
    activity: {
      aware: md.activity.aware,
      threshold: md.activity.threshold,
      cutActive: md.activity.cutActive,
      activeMaxPause: md.activity.activeMaxPause,
      activeMinGap: md.activity.activeMinGap,
    },
    ...(knobs.padding !== undefined ? { padding: knobs.padding } : {}),
    ...(knobs.maxPause !== undefined ? { maxPause: knobs.maxPause } : {}),
    ...(knobs.minKeep !== undefined ? { minKeep: knobs.minKeep } : {}),
    // Explicit override wins; otherwise the mode derives the cap.
    maxCutPerSilence: knobs.maxCutPerSilence ?? md.maxCutPerSilence,
  });
}
