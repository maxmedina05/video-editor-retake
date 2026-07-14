import { useMemo } from "react";
import type { EditorCut, Word } from "../types";
import { REASON_COLOR } from "../reasons";

interface Props {
  words: Word[];
  cuts: EditorCut[];
  selection: { anchor: number; focus: number } | null;
  onWordClick: (index: number, shift: boolean) => void;
  /** result-preview mode: de-emphasize + ignore clicks (editing doesn't apply) */
  readOnly?: boolean;
}

export default function Transcript({ words, cuts, selection, onWordClick, readOnly = false }: Props) {
  // For each word, the enabled cut covering it (strikethrough + reason color).
  const wordCut = useMemo(() => {
    const enabled = cuts.filter((c) => c.enabled);
    return words.map((w) => enabled.find((c) => c.end > w.start && c.start < w.end));
  }, [words, cuts]);

  const selRange = selection
    ? { lo: Math.min(selection.anchor, selection.focus), hi: Math.max(selection.anchor, selection.focus) }
    : null;

  if (words.length === 0) {
    return <div className="transcript empty">No transcript yet — run analysis.</div>;
  }

  return (
    <div className={`transcript${readOnly ? " readonly" : ""}`} data-testid="transcript">
      {words.map((w, i) => {
        const cut = wordCut[i];
        const selected = selRange ? i >= selRange.lo && i <= selRange.hi : false;
        const cls = ["word"];
        if (cut) cls.push("cut");
        if (selected) cls.push("selected");
        return (
          <span
            key={i}
            className={cls.join(" ")}
            data-testid={`word-${i}`}
            style={cut ? { textDecorationColor: REASON_COLOR[cut.reason], background: `${REASON_COLOR[cut.reason]}33` } : undefined}
            title={cut ? `cut: ${cut.reason} (click to keep)` : "click to select · shift-click to extend"}
            onClick={readOnly ? undefined : (e) => onWordClick(i, e.shiftKey)}
          >
            {w.text}{" "}
          </span>
        );
      })}
    </div>
  );
}
