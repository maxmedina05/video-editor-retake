import { useEffect, useRef } from "react";
import type { EditorCut } from "../types";
import { REASON_COLOR, REASON_LABEL } from "../reasons";
import { TRIM_HEAD_ID, TRIM_TAIL_ID } from "../cutsHistory";
import { clock, fmtDur } from "../util";

interface Props {
  duration: number;
  currentTime: number;
  cuts: EditorCut[];
  /** waveform peaks (0..1) of the source audio; null while loading/unavailable */
  peaks: number[] | null;
  onSeek: (t: number) => void;
  onToggle: (id: string) => void;
  /** trim-handle drag callbacks (undefined = handles hidden, e.g. result mode) */
  onTrimStart?: () => void;
  onTrimChange?: (edge: "head" | "tail", time: number) => void;
  onTrimEnd?: () => void;
}

/** Subtle waveform color — visible but behind the cut-region overlays. */
const WAVE_COLOR = "rgba(139, 149, 165, 0.42)";

export default function Timeline({
  duration,
  currentTime,
  cuts,
  peaks,
  onSeek,
  onToggle,
  onTrimStart,
  onTrimChange,
  onTrimEnd,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<"head" | "tail" | null>(null);

  const timeFromEvent = (clientX: number): number => {
    const el = barRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * duration;
  };

  const pct = (v: number) => `${(v / Math.max(duration, 0.001)) * 100}%`;

  // Draw the waveform behind the regions: one vertical bar per pixel, mirrored
  // around the vertical center. Redrawn on peak load and bar resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    const bar = barRef.current;
    if (!canvas || !bar) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = bar.clientWidth;
      const h = bar.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      if (!peaks || peaks.length === 0) return;
      ctx.fillStyle = WAVE_COLOR;
      const mid = h / 2;
      const maxHalf = (h / 2) * 0.88;
      for (let x = 0; x < w; x++) {
        const p = peaks[Math.floor((x * peaks.length) / w)] ?? 0;
        const half = Math.max(0.6, p * maxHalf); // hairline floor so silence reads as a line
        ctx.fillRect(x, mid - half, 1, half * 2);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [peaks]);

  // ---- trim handles ---------------------------------------------------------
  const trimHead = cuts.find((c) => c.id === TRIM_HEAD_ID);
  const trimTail = cuts.find((c) => c.id === TRIM_TAIL_ID);
  const headT = trimHead?.end ?? 0;
  const tailT = trimTail?.start ?? duration;
  const trimEnabled = Boolean(onTrimChange) && duration > 0;

  const handleDown = (edge: "head" | "tail") => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!trimEnabled) return;
    e.preventDefault();
    e.stopPropagation();
    dragging.current = edge;
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic/inactive pointer — mouse-move still reaches the handle */
    }
    onTrimStart?.();
    onTrimChange?.(edge, timeFromEvent(e.clientX));
  };
  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const edge = dragging.current;
    if (!edge) return;
    onTrimChange?.(edge, timeFromEvent(e.clientX));
  };
  const handleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* not captured — fine */
    }
    onTrimEnd?.();
  };

  return (
    <div className="timeline" data-testid="timeline">
      <div
        className="timeline-bar"
        ref={barRef}
        onClick={(e) => onSeek(timeFromEvent(e.clientX))}
      >
        <canvas ref={canvasRef} className="waveform" data-testid="waveform" />
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
        {trimEnabled && (
          <>
            <div
              className={`trim-handle head ${trimHead ? "active" : ""}`}
              data-testid="trim-handle-head"
              title={`Trim start${trimHead ? ` · ${clock(headT)}` : ""} — drag to cut the intro`}
              style={{ left: pct(headT) }}
              onPointerDown={handleDown("head")}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onClick={(e) => e.stopPropagation()}
            />
            <div
              className={`trim-handle tail ${trimTail ? "active" : ""}`}
              data-testid="trim-handle-tail"
              title={`Trim end${trimTail ? ` · ${clock(tailT)}` : ""} — drag to cut the outro`}
              style={{ left: pct(tailT) }}
              onPointerDown={handleDown("tail")}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onClick={(e) => e.stopPropagation()}
            />
          </>
        )}
      </div>
      <div className="timeline-labels">
        <span>{clock(currentTime)}</span>
        <span>{clock(duration)}</span>
      </div>
    </div>
  );
}
