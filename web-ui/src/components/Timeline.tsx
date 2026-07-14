import { useRef } from "react";
import type { EditorCut } from "../types";
import { REASON_COLOR, REASON_LABEL } from "../reasons";
import { clock, fmtDur } from "../util";

interface Props {
  duration: number;
  currentTime: number;
  cuts: EditorCut[];
  onSeek: (t: number) => void;
  onToggle: (id: string) => void;
}

export default function Timeline({ duration, currentTime, cuts, onSeek, onToggle }: Props) {
  const barRef = useRef<HTMLDivElement>(null);

  const timeFromEvent = (clientX: number): number => {
    const el = barRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const pct = (v: number) => `${(v / Math.max(duration, 0.001)) * 100}%`;

  return (
    <div className="timeline" data-testid="timeline">
      <div
        className="timeline-bar"
        ref={barRef}
        onClick={(e) => onSeek(timeFromEvent(e.clientX))}
      >
        {cuts.map((c) => (
          <div
            key={c.id}
            className={`region ${c.enabled ? "on" : "off"}`}
            data-testid={`region-${c.id}`}
            title={`${REASON_LABEL[c.reason]} · ${clock(c.start)}–${clock(c.end)} · ${fmtDur(
              c.end - c.start,
            )}${c.snippet ? `\n"${c.snippet}"` : ""}\n(click to ${c.enabled ? "keep" : "cut"})`}
            style={{
              left: pct(c.start),
              width: pct(c.end - c.start),
              background: REASON_COLOR[c.reason],
            }}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(c.id);
            }}
          />
        ))}
        <div className="playhead" style={{ left: pct(currentTime) }} />
      </div>
      <div className="timeline-labels">
        <span>{clock(currentTime)}</span>
        <span>{clock(duration)}</span>
      </div>
    </div>
  );
}
