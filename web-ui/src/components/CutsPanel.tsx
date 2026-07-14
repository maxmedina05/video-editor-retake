import { useEffect, useMemo, useRef } from "react";
import type { CutReason, EditorCut } from "../types";
import { ALL_REASONS, REASON_COLOR, REASON_LABEL } from "../reasons";
import { clock, fmtDur } from "../util";

interface Props {
  cuts: EditorCut[];
  /** narrow-screen drawer open state (ignored when the panel is docked wide) */
  open: boolean;
  /** close the narrow-screen drawer */
  onClose: () => void;
  /** id of the cut currently highlighted by keyboard/row selection, if any */
  selectedId: string | null;
  /** click a row: seek the player + select it */
  onSeekSelect: (cut: EditorCut) => void;
  /** flip one cut's keep/cut state */
  onToggle: (id: string) => void;
  /** set every cut in a reason group to enabled/disabled */
  onToggleGroup: (reason: CutReason, enabled: boolean) => void;
  /** ▶ audition this cut (plays around it with the cut skipped if enabled) */
  onPreview: (cut: EditorCut) => void;
  /** enable / disable every cut */
  onAcceptAll: () => void;
  onRejectAll: () => void;
}

/** Master checkbox that renders the indeterminate (partial) state. */
function TriStateCheckbox({
  checked,
  indeterminate,
  onChange,
  testid,
  title,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  testid?: string;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      data-testid={testid}
      title={title}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export default function CutsPanel({
  cuts,
  open,
  onClose,
  selectedId,
  onSeekSelect,
  onToggle,
  onToggleGroup,
  onPreview,
  onAcceptAll,
  onRejectAll,
}: Props) {
  // Group cuts by reason (stable ALL_REASONS order), each group sorted by start.
  const groups = useMemo(() => {
    return ALL_REASONS.map((reason) => {
      const rows = cuts
        .filter((c) => c.reason === reason)
        .sort((a, b) => a.start - b.start);
      const enabled = rows.filter((c) => c.enabled);
      const seconds = enabled.reduce((a, c) => a + (c.end - c.start), 0);
      return { reason, rows, enabledCount: enabled.length, seconds };
    }).filter((g) => g.rows.length > 0);
  }, [cuts]);

  const total = cuts.length;
  const enabledTotal = cuts.filter((c) => c.enabled).length;

  const cls = `cuts-panel ${open ? "open" : ""}`;

  if (total === 0) {
    return (
      <aside className={cls} data-testid="cuts-panel">
        <div className="cuts-head">
          <h2>Cuts</h2>
          <button className="icon-btn cuts-close" onClick={onClose} aria-label="close cuts panel">
            ×
          </button>
        </div>
        <p className="cuts-empty">No cuts proposed. Adjust the mode or knobs in Settings.</p>
      </aside>
    );
  }

  return (
    <aside className={cls} data-testid="cuts-panel">
      <div className="cuts-head">
        <h2>
          Cuts <span className="cuts-count">{enabledTotal}/{total}</span>
        </h2>
        <div className="cuts-bulk">
          <button className="icon-btn cuts-close" onClick={onClose} aria-label="close cuts panel">
            ×
          </button>
          <button
            className="btn small"
            data-testid="accept-all"
            title="Cut every proposed section"
            onClick={onAcceptAll}
          >
            Accept all
          </button>
          <button
            className="btn small"
            data-testid="reject-all"
            title="Keep everything (cut nothing)"
            onClick={onRejectAll}
          >
            Reject all
          </button>
        </div>
      </div>

      <div className="cuts-scroll">
        {groups.map((g) => {
          const allOn = g.enabledCount === g.rows.length;
          const someOn = g.enabledCount > 0 && !allOn;
          return (
            <div className="cut-group" key={g.reason} data-testid={`cut-group-${g.reason}`}>
              <div className="cut-group-head">
                <TriStateCheckbox
                  checked={allOn}
                  indeterminate={someOn}
                  onChange={() => onToggleGroup(g.reason, !allOn)}
                  testid={`group-toggle-${g.reason}`}
                  title={`${allOn ? "Keep" : "Cut"} all ${REASON_LABEL[g.reason]}`}
                />
                <span className="reason-chip" style={{ background: REASON_COLOR[g.reason] }} />
                <span className="cut-group-label">{REASON_LABEL[g.reason]}</span>
                <span className="cut-group-meta">
                  {g.enabledCount}/{g.rows.length} · {fmtDur(g.seconds)}
                </span>
              </div>

              {g.rows.map((c) => (
                <div
                  key={c.id}
                  className={`cut-row ${c.enabled ? "" : "kept"} ${
                    c.id === selectedId ? "selected" : ""
                  }`}
                  data-testid={`cut-row-${c.id}`}
                  onClick={() => onSeekSelect(c)}
                >
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    data-testid={`cut-toggle-${c.id}`}
                    title={c.enabled ? "Uncheck to keep this section" : "Check to cut this section"}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onToggle(c.id)}
                  />
                  <span className="cut-time">{clock(c.start)}</span>
                  <span className="cut-dur">{fmtDur(c.end - c.start)}</span>
                  <span className="cut-snippet" title={c.snippet ?? c.note ?? ""}>
                    {c.snippet ?? c.note ?? "—"}
                  </span>
                  <button
                    type="button"
                    className="cut-play"
                    data-testid={`cut-preview-${c.id}`}
                    title="Preview this cut (plays around it)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreview(c);
                    }}
                  >
                    ▶
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
