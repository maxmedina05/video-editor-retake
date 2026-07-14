import type { CutReason } from "./types";

/**
 * Reason → accent color (dark UI). Brightened (P3-5) so chips/regions clear
 * ~3:1 contrast against the panel backgrounds (#161b22 / #1c2230); the old
 * silence grey (#5b6472) was near-invisible.
 */
export const REASON_COLOR: Record<CutReason, string> = {
  silence: "#8595ac",
  filler: "#e8ae4a",
  "false-start": "#e57f63",
  ramble: "#b08ae0",
  manual: "#54bcec",
  trim: "#46c08d",
};

export const REASON_LABEL: Record<CutReason, string> = {
  silence: "silence",
  filler: "filler",
  "false-start": "false start",
  ramble: "ramble",
  manual: "manual",
  trim: "trim",
};

export const ALL_REASONS: CutReason[] = [
  "trim",
  "silence",
  "filler",
  "false-start",
  "ramble",
  "manual",
];
