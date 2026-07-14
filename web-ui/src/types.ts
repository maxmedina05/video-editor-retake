export type CutReason = "silence" | "filler" | "false-start" | "ramble" | "manual" | "trim";

export type GapActivity = "static" | "active";

export type Mode = "conservative" | "balanced" | "aggressive";

export interface Word {
  text: string;
  start: number;
  end: number;
  probability?: number;
}

export interface Cut {
  start: number;
  end: number;
  reason: CutReason;
  snippet?: string;
  note?: string;
  activity?: GapActivity;
}

export interface MediaInfo {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
}

export interface KeepSegment {
  start: number;
  end: number;
}

export interface CutStats {
  deletedSeconds: number;
  silenceShortenedSeconds: number;
  silenceGaps?: {
    total: number;
    shortened: number;
    untouched: number;
    activeExempt: number;
  };
}

export interface CutPlan {
  sourceDuration: number;
  keep: KeepSegment[];
  cuts: Cut[];
  removedDuration: number;
  outputDuration: number;
  stats: CutStats;
}

/** A cut in the editor: proposed or manual, toggleable. */
export interface EditorCut extends Cut {
  id: string;
  enabled: boolean;
  manual?: boolean;
}

export interface Settings {
  mode: Mode;
  minSilence: number;
  maxPause: number;
  /** cap on seconds removed from a single silence gap (0 = uncapped) */
  maxCutPerSilence: number;
  minKeep: number;
  padding: number;
  threshold: number;
  model: string;
  smart: boolean;
  fillers: boolean;
  fillerWords: string;
}

/** Fields whose defaults come from the mode (mirrored from src/core/modes.ts). */
export type ModePresetKey = "minSilence" | "maxPause" | "maxCutPerSilence" | "smart" | "fillers";

export const MODE_PRESET_KEYS: ModePresetKey[] = [
  "minSilence",
  "maxPause",
  "maxCutPerSilence",
  "smart",
  "fillers",
];

/** Mode presets mirrored from src/core/modes.ts (numeric knobs + fillers/smart). */
export const MODE_PRESETS: Record<Mode, Pick<Settings, ModePresetKey>> = {
  conservative: { minSilence: 3.0, maxPause: 1.5, maxCutPerSilence: 2.5, smart: false, fillers: false },
  balanced: { minSilence: 1.2, maxPause: 0.75, maxCutPerSilence: 0, smart: false, fillers: true },
  aggressive: { minSilence: 0.8, maxPause: 0.5, maxCutPerSilence: 0, smart: false, fillers: true },
};

/** One-line description shown under the mode dropdown. */
export const MODE_BLURB: Record<Mode, string> = {
  conservative: "Loom-like: light touch, silence only",
  balanced: "Recommended: shorten silences, cut fillers",
  aggressive: "Tightest cut: everything",
};

export interface Range {
  start: number;
  end: number;
}

/** Which analysis artifacts came from the on-disk cache. */
export interface CacheProvenance {
  transcript: boolean;
  denoise: boolean;
  silence: boolean;
  freeze: boolean;
}

export interface AnalyzeResult {
  info: MediaInfo;
  transcript: { words: Word[]; language?: string };
  plan: CutPlan;
  warnings: string[];
  denoiseMethod: string;
  hasSubtitlesFilter: boolean;
  cache?: CacheProvenance;
}

/** A caption cue on the OUTPUT (post-cut) timeline. Mirrors src/core/types.ts. */
export interface Cue {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface RenderResult {
  video: string;
  srt: string;
  vtt: string;
  cutplan: string;
  sourceDuration: number;
  outputDuration: number;
  removedDuration: number;
  /** output-timeline caption cues matching the emitted .srt */
  cues: Cue[];
}
