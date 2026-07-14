import type { EditorCut, Range } from "./types";

/** mm:ss.d */
export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${rest}`;
}

export function fmtDur(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

/** Merge enabled cuts into sorted, non-overlapping ranges for preview skipping. */
export function mergedEnabledRanges(cuts: EditorCut[], mergeGap = 0.02): Range[] {
  const enabled = cuts
    .filter((c) => c.enabled && c.end > c.start)
    .map((c) => ({ start: c.start, end: c.end }))
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of enabled) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= mergeGap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** The enabled cut covering time t (or word overlapping), if any. */
export function enabledCutAt(cuts: EditorCut[], t: number): EditorCut | undefined {
  return cuts.find((c) => c.enabled && t >= c.start && t < c.end);
}

/** The enabled cut overlapping [start,end), if any. */
export function enabledCutOverlapping(
  cuts: EditorCut[],
  start: number,
  end: number,
): EditorCut | undefined {
  return cuts.find((c) => c.enabled && c.end > start && c.start < end);
}
