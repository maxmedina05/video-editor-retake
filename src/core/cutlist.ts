import { classifyGap, type GapActivity } from "./activity.js";
import type { Cut, CutPlan, CutReason, CutStats, KeepSegment, Span, Word } from "./types.js";

/**
 * Merge silence gaps + filler cuts into a final keep-list.
 *
 * All functions here are pure and heavily unit tested — this and captions.ts
 * are the parts where off-by-a-frame bugs hide.
 */

const CLAMP_EPS = 0.01;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Expand a span outward to the boundaries of any word it partially overlaps,
 * so we never cut mid-word (we cut the whole word or none of it).
 */
export function snapToWordBoundaries(span: Span, words: Word[]): Span {
  let { start, end } = span;
  for (const w of words) {
    // overlap test (strict, ignore touching edges)
    if (w.end > start && w.start < end) {
      if (w.start < start) start = w.start;
      if (w.end > end) end = w.end;
    }
  }
  return { start, end };
}

/** Pick a display reason when several cuts merge: prefer content over silence. */
function combineReason(reasons: CutReason[]): CutReason {
  const nonSilence = reasons.find((r) => r !== "silence");
  return nonSilence ?? reasons[0] ?? "silence";
}

/** Fold `cut` into `last` in place, combining reason/snippet/note. */
function absorbInto(last: Cut, cut: Cut): void {
  last.end = Math.max(last.end, cut.end);
  last.reason = combineReason([last.reason, cut.reason]);
  // If either merged gap was over active video, keep the conservative label.
  if (last.activity === "active" || cut.activity === "active") last.activity = "active";
  else if (cut.activity && !last.activity) last.activity = cut.activity;
  const snippets = [last.snippet, cut.snippet].filter((s): s is string => Boolean(s));
  if (snippets.length > 0) last.snippet = snippets.join(" … ");
  const notes = [last.note, cut.note].filter((s): s is string => Boolean(s));
  if (notes.length > 0) last.note = [...new Set(notes)].join("; ");
}

/**
 * Sort + merge cuts that overlap or are separated by a small gap.
 * With `strict=false` the threshold is inclusive (gap <= mergeGap merges);
 * with `strict=true` it is exclusive (gap < mergeGap merges) — used by
 * `absorbShortKeeps`, where a keep-segment *exactly* minKeep long is preserved.
 */
export function mergeCuts(cuts: Cut[], mergeGap = 0.05, strict = false): Cut[] {
  if (cuts.length === 0) return [];
  const sorted = [...cuts].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Cut[] = [];

  for (const cut of sorted) {
    if (cut.end - cut.start <= 0) continue;
    const last = out[out.length - 1];
    const gap = last ? cut.start - last.end : Infinity;
    const close = strict ? gap < mergeGap : gap <= mergeGap;
    if (last && close) {
      absorbInto(last, cut);
    } else {
      out.push({ ...cut });
    }
  }
  return out;
}

/**
 * Absorb keep-segments shorter than `minKeep` (the flicker fix): a 2-frame
 * sliver of kept video between two adjacent cuts flashes on screen, so we
 * merge the neighbouring cuts across it. Leading/trailing slivers (a tiny keep
 * before the first cut or after the last) are absorbed by extending the edge
 * cut to the timeline boundary.
 */
export function absorbShortKeeps(cuts: Cut[], duration: number, minKeep: number): Cut[] {
  if (minKeep <= 0) return cuts.map((c) => ({ ...c }));
  const merged = mergeCuts(cuts, minKeep, true);
  if (merged.length === 0) return merged;
  const first = merged[0]!;
  if (first.start > 0 && first.start < minKeep) first.start = 0;
  const last = merged[merged.length - 1]!;
  if (duration - last.end > 0 && duration - last.end < minKeep) last.end = duration;
  return merged;
}

/** Complement of the given (merged, sorted) cuts over [0, duration]. */
export function keepComplement(
  cuts: Cut[],
  duration: number,
  minKeep = CLAMP_EPS,
): KeepSegment[] {
  const keep: KeepSegment[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    const s = clamp(cut.start, 0, duration);
    const e = clamp(cut.end, 0, duration);
    if (s - cursor > minKeep) keep.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (duration - cursor > minKeep) keep.push({ start: cursor, end: duration });
  return keep;
}

function sumSpans(spans: Span[]): number {
  return spans.reduce((acc, s) => acc + (s.end - s.start), 0);
}

export interface FinalizeOpts {
  /** absorb keep-segments shorter than this, seconds (0 = disabled) */
  minKeep?: number;
  /** merge cuts separated by <= this gap, seconds (default 0.05) */
  mergeGap?: number;
}

/**
 * Split removed seconds by reason. A merged cut that combines silence with any
 * content (filler/false-start/ramble/manual) is attributed to DELETED, matching
 * `combineReason` (content wins) — a cut that removed words is a content cut.
 */
function splitBySeconds(cuts: Cut[]): { deletedSeconds: number; silenceShortenedSeconds: number } {
  let deletedSeconds = 0;
  let silenceShortenedSeconds = 0;
  for (const c of cuts) {
    const len = Math.max(0, c.end - c.start);
    if (c.reason === "silence") silenceShortenedSeconds += len;
    else deletedSeconds += len;
  }
  return { deletedSeconds, silenceShortenedSeconds };
}

/** Merge + absorb slivers + complement → CutPlan. Shared by all entry points. */
function finalizePlan(
  cuts: Cut[],
  duration: number,
  opts: FinalizeOpts = {},
  gapStats?: CutStats["silenceGaps"],
): CutPlan {
  const mergeGap = opts.mergeGap ?? 0.05;
  const minKeep = opts.minKeep ?? 0;
  const merged = mergeCuts(cuts, mergeGap);
  const absorbed = absorbShortKeeps(merged, duration, minKeep);
  const keep = keepComplement(absorbed, duration);
  const outputDuration = sumSpans(keep);
  const stats: CutStats = {
    ...splitBySeconds(absorbed),
    ...(gapStats ? { silenceGaps: gapStats } : {}),
  };
  return {
    sourceDuration: duration,
    keep,
    cuts: absorbed,
    removedDuration: Math.max(0, duration - outputDuration),
    outputDuration,
    stats,
  };
}

/** Build a CutPlan from a final cut list (e.g. after interactive edits). */
export function planFromCuts(cuts: Cut[], duration: number, opts: FinalizeOpts = {}): CutPlan {
  return finalizePlan(cuts, duration, opts);
}

/**
 * Activity policy for silence handling. When `aware`, each gap is classified
 * static/active against `frozenSpans`; active gaps are either exempted
 * (`cutActive:false`) or shortened gently (their own `activeMaxPause`, and only
 * when longer than `activeMinGap`). When absent, every gap is treated as static
 * (the historical behaviour), keeping existing callers/tests unchanged.
 */
export interface ActivityParams {
  aware: boolean;
  /** frozen-overlap fraction at/above which a gap is static (default 0.7) */
  threshold?: number;
  /** whether active silences may be shortened at all */
  cutActive: boolean;
  /** pause left when shortening an active silence, seconds */
  activeMaxPause: number;
  /** only shorten active silences longer than this, seconds */
  activeMinGap: number;
}

export interface BuildCutListParams {
  sourceDuration: number;
  words: Word[];
  silenceGaps: Span[];
  fillerCuts: Cut[];
  /** frozen video spans (from activity.detectFrozenSpans) for classification */
  frozenSpans?: Span[];
  /** how to treat silences relative to on-screen motion */
  activity?: ActivityParams;
  /** minimum breathing room kept next to speech on each side of a cut (default 0.15) */
  padding?: number;
  /**
   * natural pause left in place of a detected silence, seconds (default 0.75).
   * A silence is SHORTENED to leave this much pause rather than deleted, so a
   * long quiet stretch of a screen demo isn't removed wholesale and every pause
   * doesn't become a hard jump cut.
   */
  maxPause?: number;
  /** absorb keep-segments shorter than this, seconds (default 0.4) */
  minKeep?: number;
  /** merge cuts separated by <= this gap, seconds (default 0.05) */
  mergeGap?: number;
  /**
   * cap on seconds removed from a SINGLE silence gap (0/undefined = uncapped).
   * Applied after `keepPause` is chosen: the removed amount is
   * `min(gapLen - keepPause, maxCutPerSilence)`, still removed from the middle,
   * so a long static silence keeps far more than `maxPause` and is barely
   * touched. Binds only when `gapLen - keepPause > maxCutPerSilence`.
   */
  maxCutPerSilence?: number;
}

/**
 * Combine silence gaps and filler cuts into a final CutPlan.
 *
 * Silence handling (max-pause): each detected gap keeps `keepPause` seconds of
 * natural pause, removed from the MIDDLE so `keepPause/2` of silence remains
 * adjacent to the speech on each side (this is what stops pauses turning into
 * hard jump cuts). `keepPause = max(maxPause, 2*padding)`: `maxPause` is the
 * primary control; `padding` acts as a per-side floor on breathing room. A gap
 * no longer than `keepPause` is left untouched. Cut duration = gap - keepPause.
 *
 * Filler cuts are snapped to whole-word boundaries. Everything is merged,
 * clamped to [0, duration], and slivers shorter than `minKeep` are absorbed.
 */
export function buildCutList(params: BuildCutListParams): CutPlan {
  const padding = params.padding ?? 0.15;
  const maxPause = params.maxPause ?? 0.75;
  const minKeep = params.minKeep ?? 0.4;
  const mergeGap = params.mergeGap ?? 0.05;
  const maxCutPerSilence = params.maxCutPerSilence ?? 0;
  const duration = params.sourceDuration;
  const staticPause = Math.max(maxPause, 2 * padding);
  const activity = params.activity;
  const frozen = params.frozenSpans ?? [];
  const raw: Cut[] = [];

  let gapsShortened = 0;
  let gapsUntouched = 0;
  let gapsActiveExempt = 0;

  for (const gap of params.silenceGaps) {
    const gapLen = gap.end - gap.start;

    // Classify (only when activity-aware); the activity label is attached to the
    // cut only when classification actually ran.
    let kind: GapActivity | undefined;
    let keepPause = staticPause;
    if (activity?.aware) {
      kind = classifyGap(gap, frozen, activity.threshold ?? 0.7);
      if (kind === "active") {
        if (!activity.cutActive || gapLen <= activity.activeMinGap) {
          gapsActiveExempt++;
          continue; // leave active silences alone
        }
        keepPause = Math.max(activity.activeMaxPause, 2 * padding);
      }
    }

    if (gapLen <= keepPause + CLAMP_EPS) {
      gapsUntouched++;
      continue; // short enough to leave as-is
    }
    // Remove `removed` seconds from the MIDDLE, keeping the rest split evenly on
    // each side. Without a cap this is `gapLen - keepPause` (leaving keepPause).
    // The per-gap cap only reduces `removed`, so more pause is kept.
    let removed = gapLen - keepPause;
    if (maxCutPerSilence > 0 && removed > maxCutPerSilence) removed = maxCutPerSilence;
    const half = (gapLen - removed) / 2;
    const start = clamp(gap.start + half, 0, duration);
    const end = clamp(gap.end - half, 0, duration);
    if (end - start > CLAMP_EPS) {
      gapsShortened++;
      raw.push({ start, end, reason: "silence", ...(kind ? { activity: kind } : {}) });
    } else {
      gapsUntouched++;
    }
  }

  for (const cut of params.fillerCuts) {
    const snapped = snapToWordBoundaries(cut, params.words);
    const start = clamp(snapped.start, 0, duration);
    const end = clamp(snapped.end, 0, duration);
    if (end - start > CLAMP_EPS) {
      raw.push({ ...cut, start, end });
    }
  }

  return finalizePlan(
    raw,
    duration,
    { minKeep, mergeGap },
    {
      total: params.silenceGaps.length,
      shortened: gapsShortened,
      untouched: gapsUntouched,
      activeExempt: gapsActiveExempt,
    },
  );
}

/** For interactive edit: drop cuts by index and rebuild the plan. */
export function removeCutsByIndex(
  cuts: Cut[],
  excludeIndices: number[],
  duration: number,
  opts: FinalizeOpts = {},
): CutPlan {
  const exclude = new Set(excludeIndices);
  const kept = cuts.filter((_, i) => !exclude.has(i));
  return finalizePlan(kept, duration, opts);
}
