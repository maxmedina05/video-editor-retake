/**
 * Shared data model for the clean-video pipeline.
 *
 * All times are in seconds (floating point) on the ORIGINAL input timeline,
 * unless a field/type name explicitly says "output" (post-cut) timeline.
 */

/** A single transcribed word with timing on the original timeline. */
export interface Word {
  text: string;
  start: number;
  end: number;
  /** whisper confidence 0..1 if available */
  probability?: number;
}

export interface Transcript {
  words: Word[];
  /** language code whisper detected/was told, e.g. "en" */
  language?: string;
}

/** A contiguous span [start, end) on the original timeline. */
export interface Span {
  start: number;
  end: number;
}

export type CutReason = "silence" | "filler" | "false-start" | "ramble" | "manual" | "trim";

/** Whether a silence gap sits over frozen (static) or moving (active) video. */
export type GapActivity = "static" | "active";

/** A span to REMOVE from the video, with why and (optionally) what was said. */
export interface Cut extends Span {
  reason: CutReason;
  /** transcript snippet covered by this cut (for the approval UI) */
  snippet?: string;
  /** human note (e.g. from the smart tier) */
  note?: string;
  /** for silence cuts: whether the underlying video was static or active */
  activity?: GapActivity;
}

/** A span to KEEP in the final render. */
export type KeepSegment = Span;

/**
 * Honest split of what was removed, so the "Loom removed 21s" comparison is
 * apples-to-apples: content that was DELETED outright vs silence that was merely
 * SHORTENED, plus how many detected silences we left alone.
 */
export interface CutStats {
  /** seconds fully deleted (filler / false-start / ramble / manual cuts) */
  deletedSeconds: number;
  /** seconds removed by shortening silences */
  silenceShortenedSeconds: number;
  /** silence-gap accounting (only present when built from raw gaps) */
  silenceGaps?: {
    /** silence gaps detected */
    total: number;
    /** gaps that produced a cut */
    shortened: number;
    /** gaps left as-is (shorter than the pause we keep) */
    untouched: number;
    /** active-video gaps deliberately exempted from cutting */
    activeExempt: number;
  };
}

export interface CutPlan {
  /** total original duration in seconds */
  sourceDuration: number;
  /** ordered, non-overlapping spans to keep */
  keep: KeepSegment[];
  /** ordered, non-overlapping spans removed (with reasons) */
  cuts: Cut[];
  /** seconds removed */
  removedDuration: number;
  /** resulting duration */
  outputDuration: number;
  /** deleted-vs-shortened breakdown */
  stats: CutStats;
}

/** ffprobe-derived media info. */
export interface MediaInfo {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
}

/** A caption cue on the OUTPUT (post-cut) timeline. */
export interface Cue {
  index: number;
  /** output-timeline start in seconds */
  start: number;
  /** output-timeline end in seconds */
  end: number;
  text: string;
}
