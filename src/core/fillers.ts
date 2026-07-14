import { runBinary, type Runner } from "./binaries.js";
import type { Cut, CutReason, Transcript, Word } from "./types.js";

/**
 * Two-tier filler / false-start detection.
 *
 * Tier 1 (`detectFillerCuts`): always on. Pure heuristic over transcript words
 * — filler word list + repeated-word stutters.
 *
 * Tier 2 (`smartFillerCuts`): optional (`--smart`). Shells out to `claude -p`
 * with the numbered transcript and asks for JSON cut suggestions. Parsing
 * (`parseSmartResponse`) is pure; on ANY error the caller degrades to tier 1.
 */

export const DEFAULT_FILLER_WORDS = [
  "um",
  "umm",
  "uh",
  "uhh",
  "uhm",
  "erm",
  "er",
  "hmm",
  "mm",
  "ah",
];

export interface FillerOptions {
  fillerWords?: string[];
  /** detect consecutive repeated words ("the the") (default true) */
  detectStutters?: boolean;
}

/** Lowercase and strip surrounding punctuation/whitespace. */
export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function wordSnippet(words: Word[], i: number): string {
  return words[i]?.text.trim() ?? "";
}

/** Pure tier-1 heuristic detection. Returns cuts sorted by start time. */
export function detectFillerCuts(transcript: Transcript, opts: FillerOptions = {}): Cut[] {
  const fillerSet = new Set((opts.fillerWords ?? DEFAULT_FILLER_WORDS).map((w) => w.toLowerCase()));
  const detectStutters = opts.detectStutters ?? true;
  const words = transcript.words;
  const cutIndices = new Map<number, Cut>();

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    const norm = normalizeWord(w.text);
    if (norm && fillerSet.has(norm)) {
      cutIndices.set(i, {
        start: w.start,
        end: w.end,
        reason: "filler",
        snippet: wordSnippet(words, i),
      });
    }
  }

  if (detectStutters) {
    for (let i = 1; i < words.length; i++) {
      const prev = words[i - 1];
      const cur = words[i];
      if (!prev || !cur) continue;
      const a = normalizeWord(prev.text);
      const b = normalizeWord(cur.text);
      // repeated real word: cut the EARLIER occurrence, keep the later one.
      if (a && a === b && !fillerSet.has(a)) {
        if (!cutIndices.has(i - 1)) {
          cutIndices.set(i - 1, {
            start: prev.start,
            end: prev.end,
            reason: "false-start",
            snippet: `${wordSnippet(words, i - 1)} ${wordSnippet(words, i)}`.trim(),
            note: "repeated word",
          });
        }
      }
    }
  }

  return [...cutIndices.values()].sort((x, y) => x.start - y.start);
}

// ---------------------------------------------------------------------------
// Tier 2: Claude smart detection
// ---------------------------------------------------------------------------

export function buildSmartPrompt(transcript: Transcript): string {
  const numbered = transcript.words
    .map((w, i) => `${i}: ${w.text.trim()}`)
    .join("\n");
  return [
    "You are cleaning up a screen-recording transcript. Below is the transcript,",
    "one word per line, prefixed by its index.",
    "",
    "Identify spans that should be CUT to tighten the recording:",
    '- filler words ("um", "uh", "you know", "like" used as filler)',
    "- false starts and self-corrections (speaker restarts a sentence)",
    "- rambling / repeated content that adds no information",
    "",
    "Do NOT cut meaningful content. Prefer conservative, tight spans.",
    "",
    "Respond with ONLY a JSON array (no prose, no code fences) of objects:",
    '[{"startWord": <int>, "endWord": <int>, "reason": "filler"|"false-start"|"ramble", "note": "<short reason>"}]',
    "startWord/endWord are inclusive word indices from the list below.",
    "If nothing should be cut, respond with [].",
    "",
    "TRANSCRIPT:",
    numbered,
  ].join("\n");
}

interface SmartItem {
  startWord: number;
  endWord: number;
  reason?: string;
  note?: string;
}

function normalizeReason(raw: string | undefined): CutReason {
  switch (raw) {
    case "false-start":
      return "false-start";
    case "ramble":
      return "ramble";
    default:
      return "filler";
  }
}

/**
 * Pure: extract the JSON array from Claude's response and map word-index ranges
 * to cuts on the original timeline. Throws on malformed input so the caller can
 * fall back to the heuristic tier.
 */
export function parseSmartResponse(text: string, transcript: Transcript): Cut[] {
  // Tolerate code fences / surrounding prose: grab the outermost [...] block.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON array found in smart response");
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("smart response is not an array");

  const words = transcript.words;
  const cuts: Cut[] = [];
  for (const raw of parsed as SmartItem[]) {
    const s = Number(raw?.startWord);
    const e = Number(raw?.endWord);
    if (!Number.isInteger(s) || !Number.isInteger(e)) continue;
    if (s < 0 || e >= words.length || e < s) continue;
    const first = words[s];
    const last = words[e];
    if (!first || !last) continue;
    const snippet = words
      .slice(s, e + 1)
      .map((w) => w.text.trim())
      .join(" ")
      .trim();
    const cut: Cut = {
      start: first.start,
      end: last.end,
      reason: normalizeReason(raw.reason),
      snippet,
    };
    if (raw.note) cut.note = String(raw.note);
    cuts.push(cut);
  }
  return cuts.sort((a, b) => a.start - b.start);
}

export async function smartFillerCuts(
  transcript: Transcript,
  runner: Runner = runBinary,
): Promise<Cut[]> {
  if (transcript.words.length === 0) return [];
  const prompt = buildSmartPrompt(transcript);
  const res = await runner("claude", ["-p", prompt]);
  if (res.exitCode !== 0) {
    throw new Error(`claude failed: ${res.stderr.trim() || "unknown"}`);
  }
  return parseSmartResponse(res.stdout, transcript);
}
