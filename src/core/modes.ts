/**
 * Aggressiveness presets. A mode only sets DEFAULTS; any explicitly-passed flag
 * (CLI) or user-touched knob (web) still wins — the UI layers are responsible
 * for that merge (see cli/index.ts and web/server.ts).
 *
 * Motivation: on a 7:44 screen-demo, Loom removed ~21s of silence and 0 fillers,
 * while our old defaults removed ~2:20. The difference is philosophy, not a bug:
 * Loom is very conservative and leaves long quiet stretches alone. Modes expose
 * that spectrum, and `conservative` additionally refuses to touch silences where
 * the screen is visually ACTIVE (see activity.ts).
 */

export type Mode = "conservative" | "balanced" | "aggressive";

export const MODES_LIST: Mode[] = ["conservative", "balanced", "aggressive"];

/** How silences are treated relative to on-screen motion. */
export interface ActivityPolicy {
  /** classify each gap static/active via freezedetect (false = ignore activity) */
  aware: boolean;
  /** frozen-overlap fraction at/above which a gap counts as static */
  threshold: number;
  /** freezedetect noise tolerance (n) */
  noise: number;
  /** freezedetect min freeze duration (d), seconds */
  minFreeze: number;
  /** whether ACTIVE (non-frozen) silences may be shortened at all */
  cutActive: boolean;
  /** pause left in place when shortening an active silence, seconds */
  activeMaxPause: number;
  /** only shorten active silences longer than this, seconds */
  activeMinGap: number;
}

export interface ModeDefaults {
  minSilence: number;
  /** max pause left in place for STATIC silences, seconds */
  maxPause: number;
  /**
   * cap on how many seconds a SINGLE silence gap may lose, seconds (0 = uncapped).
   * Binds when `gap - maxPause > maxCutPerSilence`: a long static silence is only
   * trimmed by this much rather than collapsed to `maxPause`, so long quiet
   * stretches are barely touched (Loom-like). Removed from the middle as usual.
   */
  maxCutPerSilence: number;
  /** run heuristic filler-word removal */
  fillers: boolean;
  /** run the --smart (Claude) tier */
  smart: boolean;
  activity: ActivityPolicy;
}

// Freeze detection is tuned against real screen-recording footage: at n=0.001
// (ffmpeg's strictest default) genuinely static stretches read as ~100% frozen
// while sections with mouse/scroll motion drop below 0.6, so a 0.7 threshold
// separates them cleanly. See TODO.md for the measured numbers.
const AWARE: Omit<ActivityPolicy, "cutActive" | "activeMaxPause" | "activeMinGap"> = {
  aware: true,
  threshold: 0.7,
  noise: 0.001,
  minFreeze: 1.0,
};

export const MODES: Record<Mode, ModeDefaults> = {
  // Loom-like: only shorten silences over static video, keep a generous pause,
  // never touch active silences, no filler/smart edits.
  conservative: {
    minSilence: 3.0,
    maxPause: 1.5,
    // Cap each static silence at 2.5s removed: on demo.mp4 this lands ~20.7s total
    // (vs 80.9s uncapped), matching Loom's ~21s hands-off treatment of long
    // static silence. See TODO.md for the measured cap sweep.
    maxCutPerSilence: 2.5,
    fillers: false,
    smart: false,
    activity: { ...AWARE, cutActive: false, activeMaxPause: 0, activeMinGap: 0 },
  },
  // New default: previous behaviour for static silences; active silences are
  // shortened only when long (>4s) and left a bigger 2s pause.
  balanced: {
    minSilence: 1.2,
    maxPause: 0.75,
    maxCutPerSilence: 0, // uncapped
    fillers: true,
    smart: false,
    activity: { ...AWARE, cutActive: true, activeMaxPause: 2.0, activeMinGap: 4.0 },
  },
  // Old aggressive behaviour: ignore activity entirely, trim hard.
  aggressive: {
    minSilence: 0.8,
    maxPause: 0.5,
    maxCutPerSilence: 0, // uncapped
    fillers: true,
    smart: false,
    activity: { aware: false, threshold: 0.7, noise: 0.001, minFreeze: 1.0, cutActive: true, activeMaxPause: 0, activeMinGap: 0 },
  },
};

export function modeDefaults(mode: Mode): ModeDefaults {
  return MODES[mode] ?? MODES.balanced;
}
