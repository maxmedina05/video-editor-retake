import { groupCues, toVTT } from "../../src/core/captions.js";
import type { Cue, Word } from "./types";

/**
 * Client-side WebVTT builders. The heavy lifting — cue grouping (gap/duration/
 * char thresholds) and timestamp formatting — is the SAME pure code the server
 * uses to emit the .srt, imported directly from src/core/captions.ts (which is
 * unit-tested in src/core/captions.test.ts). We only add the browser glue here:
 * turning a VTT string into a Blob URL for a <track> element.
 */

/**
 * VTT for LIVE preview of the ORIGINAL video. Words are on the original
 * timeline; we group them as-is (no keep-list remap) so cue times line up with
 * the source video in both normal playback and "Play edited" mode. Returns null
 * when there is no transcript.
 */
export function editVtt(words: Word[]): string | null {
  if (!words.length) return null;
  return toVTT(groupCues(words));
}

/**
 * VTT for the RENDERED result. The cues are already on the OUTPUT timeline
 * (produced by the server's render, identical to the emitted .srt), so we just
 * format them. Returns null when there are no cues.
 */
export function resultVtt(cues: Cue[]): string | null {
  if (!cues.length) return null;
  return toVTT(cues);
}

/** Wrap a VTT string in a Blob URL suitable for a <track src>. */
export function vttBlobUrl(vtt: string): string {
  return URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
}
