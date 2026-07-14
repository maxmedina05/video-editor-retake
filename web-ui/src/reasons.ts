import type { CutReason } from "./types";

/** Reason → accent color (dark UI). */
export const REASON_COLOR: Record<CutReason, string> = {
  silence: "#5b6472",
  filler: "#e0a03a",
  "false-start": "#d9694e",
  ramble: "#9a6cd0",
  manual: "#3fa7d6",
};

export const REASON_LABEL: Record<CutReason, string> = {
  silence: "silence",
  filler: "filler",
  "false-start": "false start",
  ramble: "ramble",
  manual: "manual",
};

export const ALL_REASONS: CutReason[] = ["silence", "filler", "false-start", "ramble", "manual"];
