import type { Cue, KeepSegment, Word } from "./types.js";

/**
 * Caption generation. Words are transcribed on the ORIGINAL timeline; captions
 * must land on the OUTPUT (post-cut) timeline, so every timestamp is remapped
 * through the keep-list. All functions here are pure and unit tested.
 */

const EPS = 1e-6;

interface KeepOffset {
  start: number;
  end: number;
  /** output-timeline start of this kept segment */
  offset: number;
}

/** Precompute each kept segment's cumulative output-timeline offset. */
export function withOffsets(keep: KeepSegment[]): KeepOffset[] {
  let acc = 0;
  return keep.map((k) => {
    const seg = { start: k.start, end: k.end, offset: acc };
    acc += k.end - k.start;
    return seg;
  });
}

/**
 * Map an original-timeline time to the output timeline.
 * Returns null if the time falls inside a removed span.
 */
export function mapTime(t: number, keep: KeepOffset[]): number | null {
  for (const k of keep) {
    if (t >= k.start - EPS && t <= k.end + EPS) {
      const clamped = Math.max(k.start, Math.min(k.end, t));
      return k.offset + (clamped - k.start);
    }
  }
  return null;
}

/**
 * Remap words onto the output timeline, clipping to kept segments and dropping
 * words that fall entirely inside cuts. Returns words in output-timeline order.
 */
export function remapWords(words: Word[], keep: KeepSegment[]): Word[] {
  const ko = withOffsets(keep);
  const out: Word[] = [];
  for (const w of words) {
    const seg = ko.find((k) => w.end > k.start + EPS && w.start < k.end - EPS);
    if (!seg) continue;
    const cs = Math.max(w.start, seg.start);
    const ce = Math.min(w.end, seg.end);
    if (ce - cs <= EPS) continue;
    out.push({
      text: w.text,
      start: seg.offset + (cs - seg.start),
      end: seg.offset + (ce - seg.start),
    });
  }
  return out;
}

export interface CueOptions {
  /** max characters per caption line (default 42) */
  maxChars?: number;
  /** flush a cue when the gap to the next word exceeds this (seconds, default 0.6) */
  maxGap?: number;
  /** max cue duration in seconds (default 6) */
  maxDuration?: number;
}

/** Group output-timeline words into caption cues. */
export function groupCues(words: Word[], opts: CueOptions = {}): Cue[] {
  const maxChars = opts.maxChars ?? 42;
  const maxGap = opts.maxGap ?? 0.6;
  const maxDuration = opts.maxDuration ?? 6;

  const cues: Cue[] = [];
  let bucket: Word[] = [];

  const flush = () => {
    if (bucket.length === 0) return;
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    cues.push({
      index: cues.length + 1,
      start: first.start,
      end: last.end,
      text: bucket.map((w) => w.text.trim()).join(" ").replace(/\s+/g, " ").trim(),
    });
    bucket = [];
  };

  for (const w of words) {
    if (bucket.length === 0) {
      bucket.push(w);
      continue;
    }
    const prev = bucket[bucket.length - 1]!;
    const first = bucket[0]!;
    const candidateText = [...bucket, w].map((x) => x.text.trim()).join(" ").trim();
    const gap = w.start - prev.end;
    const dur = w.end - first.start;
    if (candidateText.length > maxChars || gap > maxGap || dur > maxDuration) {
      flush();
    }
    bucket.push(w);
  }
  flush();
  return cues;
}

/** Format seconds as HH:MM:SS<sep>mmm. */
export function formatTimestamp(seconds: number, sep: "," | "."): string {
  const clamped = Math.max(0, seconds);
  const ms = Math.round(clamped * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(millis, 3)}`;
}

export function toSRT(cues: Cue[]): string {
  return (
    cues
      .map(
        (c) =>
          `${c.index}\n${formatTimestamp(c.start, ",")} --> ${formatTimestamp(c.end, ",")}\n${c.text}`,
      )
      .join("\n\n") + (cues.length > 0 ? "\n" : "")
  );
}

export function toVTT(cues: Cue[]): string {
  const body = cues
    .map(
      (c) =>
        `${formatTimestamp(c.start, ".")} --> ${formatTimestamp(c.end, ".")}\n${c.text}`,
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}${cues.length > 0 ? "\n" : ""}`;
}

/** Convenience: original words + keep-list -> {srt, vtt, cues}. */
export function generateCaptions(
  words: Word[],
  keep: KeepSegment[],
  opts: CueOptions = {},
): { cues: Cue[]; srt: string; vtt: string } {
  const remapped = remapWords(words, keep);
  const cues = groupCues(remapped, opts);
  return { cues, srt: toSRT(cues), vtt: toVTT(cues) };
}
