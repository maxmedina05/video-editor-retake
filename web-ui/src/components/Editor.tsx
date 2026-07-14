import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import VideoPlayer from "./VideoPlayer";
import Timeline from "./Timeline";
import Transcript from "./Transcript";
import CutsPanel from "./CutsPanel";
import SettingsDrawer from "./SettingsDrawer";
import { getWaveform, mediaUrl, postPlan, streamSSE, type SessionInfo } from "../api";
import { ALL_REASONS, REASON_COLOR, REASON_LABEL } from "../reasons";
import { clock, mergedEnabledRanges } from "../util";
import { editVtt, resultVtt } from "../captions";
import { cutsReducer, INITIAL_CUTS_STATE } from "../cutsHistory";
import {
  MODE_PRESETS,
  MODE_PRESET_KEYS,
  type AnalyzeResult,
  type CacheProvenance,
  type Cut,
  type CutReason,
  type CutStats,
  type EditorCut,
  type MediaInfo,
  type Mode,
  type RenderResult,
  type Settings,
  type Word,
} from "../types";

/** Advanced fields that are NOT mode-derived; reset restores these baselines. */
const BASE_SETTINGS: Pick<Settings, "minKeep" | "padding" | "threshold" | "model" | "fillerWords"> = {
  minKeep: 0.4,
  padding: 0.15,
  threshold: -30,
  model: "base.en",
  fillerWords: "",
};

const DEFAULT_SETTINGS: Settings = {
  mode: "balanced",
  ...MODE_PRESETS.balanced,
  ...BASE_SETTINGS,
};

const MODE_LABEL: Record<Mode, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

const uid = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

function toEditorCuts(cuts: Cut[]): EditorCut[] {
  return cuts.map((c) => ({ ...c, id: uid(), enabled: true }));
}

interface Props {
  session: SessionInfo;
  /** ffmpeg has the libass `subtitles` filter (from /api/config) */
  initialHasSubtitlesFilter: boolean;
  /** go back to the home screen / switch video */
  onHome: () => void;
}

/**
 * The editor for a single open session. It is mounted with `key={session.id}`
 * by the parent, so switching videos remounts it fresh — the previous video's
 * edit state (cuts, transcript, render result) is intentionally discarded.
 */
export default function Editor({ session, initialHasSubtitlesFilter, onHome }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const [hasSubtitlesFilter, setHasSubtitlesFilter] = useState(initialHasSubtitlesFilter);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // Advanced fields the user explicitly edited. These survive a mode switch and
  // a re-analyze; "Reset to mode defaults" clears them.
  const [overrides, setOverrides] = useState<Set<keyof Settings>>(() => new Set());

  // Switching mode updates every non-overridden mode-derived field to the new
  // mode's default, leaving user overrides in place.
  const changeMode = useCallback(
    (mode: Mode) => {
      setSettings((s) => {
        const next: Settings = { ...s, mode };
        for (const k of MODE_PRESET_KEYS) {
          if (!overrides.has(k)) (next[k] as Settings[typeof k]) = MODE_PRESETS[mode][k];
        }
        return next;
      });
    },
    [overrides],
  );

  // Editing any advanced field marks it as an explicit override.
  const changeField = useCallback((patch: Partial<Settings>) => {
    const keys = Object.keys(patch) as (keyof Settings)[];
    setOverrides((prev) => {
      const nextO = new Set(prev);
      for (const k of keys) nextO.add(k);
      return nextO;
    });
    setSettings((s) => ({ ...s, ...patch }));
  }, []);

  // Clear all overrides: mode-derived fields revert to the current mode's
  // defaults, the rest to their baselines.
  const resetOverrides = useCallback(() => {
    setOverrides(new Set());
    setSettings((s) => ({ ...s, ...BASE_SETTINGS, ...MODE_PRESETS[s.mode] }));
  }, []);

  const [analyzing, setAnalyzing] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [stage, setStage] = useState<string>("");
  // Server errors arrive pre-mapped to a human message + optional fix hint.
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // Force-fresh toggle (Settings > Advanced) and the cache provenance of the
  // last analyze, for the "loaded from cache" badge.
  const [fresh, setFresh] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<CacheProvenance | null>(null);

  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  // Cut list with bounded undo/redo (P3-4); every edit goes through the reducer.
  const [cutsState, dispatchCuts] = useReducer(cutsReducer, INITIAL_CUTS_STATE);
  const cuts = cutsState.present;
  const canUndo = cutsState.past.length > 0;
  const canRedo = cutsState.future.length > 0;
  const [planStats, setPlanStats] = useState<CutStats | null>(null);
  // Waveform peaks for the timeline (P2-4); fetched once per session, cached
  // server-side per file identity. Null = still loading or unavailable.
  const [peaks, setPeaks] = useState<number[] | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playEdited, setPlayEdited] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cutsOpen, setCutsOpen] = useState(false); // narrow-screen cuts drawer
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null);
  // Cut currently highlighted by the row/keyboard walk-through.
  const [selectedCutId, setSelectedCutId] = useState<string | null>(null);
  // Per-cut preview: play until this time then pause (null = not previewing).
  const [previewStopAt, setPreviewStopAt] = useState<number | null>(null);
  // Captions default on once a transcript exists; the CC button toggles them.
  const [captionsOn, setCaptionsOn] = useState(true);
  // "Watch result" preview mode: play the rendered file with output-timeline
  // captions, with editing controls suppressed (they don't apply to it).
  const [watchingResult, setWatchingResult] = useState(false);

  const [burn, setBurn] = useState(false);
  const [embed, setEmbed] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderStage, setRenderStage] = useState("");
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);

  // True once the first analyze has produced artifacts server-side; gates the
  // live re-plan so it never fires before there is anything to re-plan.
  const analyzedRef = useRef(false);

  const ranges = useMemo(() => mergedEnabledRanges(cuts), [cuts]);
  const removedEstimate = useMemo(
    () => ranges.reduce((a, r) => a + (r.end - r.start), 0),
    [ranges],
  );
  const dur = duration || info?.duration || 0;

  // Live captions for the ORIGINAL video (words on the original timeline).
  const editVttText = useMemo(() => editVtt(words), [words]);
  // Captions for the RENDERED result (cues already on the output timeline).
  const resultVttText = useMemo(
    () => (renderResult ? resultVtt(renderResult.cues) : null),
    [renderResult],
  );

  // Fetch waveform peaks once per session (server caches per file identity).
  // Silent failure — the waveform is a progressive enhancement.
  useEffect(() => {
    let cancelled = false;
    getWaveform(session.id)
      .then((w) => {
        if (!cancelled) setPeaks(w.peaks);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const runAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setError(null);
    setRenderResult(null);
    setWatchingResult(false);
    setStage("starting");
    const fillerWords = settings.fillerWords
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await streamSSE(
        "/api/analyze",
        {
          sessionId: session.id,
          mode: settings.mode,
          minSilence: settings.minSilence,
          maxPause: settings.maxPause,
          maxCutPerSilence: settings.maxCutPerSilence,
          minKeep: settings.minKeep,
          padding: settings.padding,
          threshold: settings.threshold,
          model: settings.model,
          smart: settings.smart,
          fillers: settings.fillers,
          ...(fresh ? { noCache: true } : {}),
          ...(fillerWords.length ? { fillerWords } : {}),
        },
        {
          onProgress: (s, detail) => setStage(detail ? `${s}: ${detail}` : s),
          onResult: (data) => {
            const r = data as unknown as AnalyzeResult;
            setInfo(r.info);
            setWords(r.transcript.words);
            setWarnings(r.warnings ?? []);
            setHasSubtitlesFilter(r.hasSubtitlesFilter);
            setCacheInfo(r.cache ?? null);
            setPlanStats(r.plan.stats ?? null);
            // Preserve manual cuts across re-analysis; replace auto cuts.
            dispatchCuts({ type: "plan", cuts: toEditorCuts(r.plan.cuts) });
            setSelection(null);
            setSelectedCutId(null);
            analyzedRef.current = true;
          },
          onError: (m, hint) => setError({ message: m, ...(hint ? { hint } : {}) }),
        },
      );
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setAnalyzing(false);
      setStage("");
    }
  }, [settings, session.id, fresh]);

  // Run the first analysis automatically when this session mounts.
  useEffect(() => {
    void runAnalyze();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cheap live re-plan: reshape the cut list from cached artifacts (no whisper,
  // no progress modal). Preserves manual cuts, same as analyze.
  const runPlan = useCallback(async () => {
    if (!analyzedRef.current) return;
    setReplanning(true);
    setError(null);
    const fillerWords = settings.fillerWords
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const { plan } = await postPlan({
        sessionId: session.id,
        mode: settings.mode,
        minSilence: settings.minSilence,
        maxPause: settings.maxPause,
        maxCutPerSilence: settings.maxCutPerSilence,
        minKeep: settings.minKeep,
        padding: settings.padding,
        fillers: settings.fillers,
        ...(fillerWords.length ? { fillerWords } : {}),
      });
      setPlanStats(plan.stats ?? null);
      dispatchCuts({ type: "plan", cuts: toEditorCuts(plan.cuts) });
      setSelectedCutId(null);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setReplanning(false);
    }
  }, [settings, session.id]);

  const runPlanRef = useRef(runPlan);
  runPlanRef.current = runPlan;

  // Auto re-plan (debounced) whenever a PLAN-ONLY knob changes. Detection knobs
  // (minSilence field, threshold, model, smart, fresh) are deliberately NOT in
  // this dep list — they keep the explicit Re-analyze path.
  useEffect(() => {
    if (!analyzedRef.current) return;
    const id = window.setTimeout(() => void runPlanRef.current(), 180);
    return () => window.clearTimeout(id);
  }, [
    settings.mode,
    settings.maxPause,
    settings.maxCutPerSilence,
    settings.minKeep,
    settings.padding,
    settings.fillers,
    settings.fillerWords,
  ]);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
  }, []);

  const toggleCut = useCallback((id: string) => {
    dispatchCuts({ type: "toggle", id });
  }, []);

  const toggleGroup = useCallback((reason: CutReason, enabled: boolean) => {
    dispatchCuts({ type: "toggleGroup", reason, enabled });
  }, []);

  const setAll = useCallback((enabled: boolean) => {
    dispatchCuts({ type: "setAll", enabled });
  }, []);

  // ---- head/tail trim handles (P2-6) ---------------------------------------
  // Drags are transient in the reducer; the whole gesture commits as ONE undo
  // step on pointer-up, against the snapshot taken when the drag started.
  const trimSnapshot = useRef<EditorCut[]>([]);
  const cutsRef = useRef(cuts);
  cutsRef.current = cuts;
  const durRef = useRef(0);
  durRef.current = dur;

  const onTrimStart = useCallback(() => {
    trimSnapshot.current = cutsRef.current;
  }, []);
  const onTrimChange = useCallback((edge: "head" | "tail", time: number) => {
    dispatchCuts({ type: "trim", edge, time, duration: durRef.current });
  }, []);
  const onTrimEnd = useCallback(() => {
    dispatchCuts({ type: "trimCommit", before: trimSnapshot.current });
  }, []);

  // Audition a single cut: play from 2s before to 2s after, skipping the cut
  // itself when it is enabled (so you hear the edited result, not the raw gap).
  const previewCut = useCallback(
    (cut: EditorCut) => {
      const v = videoRef.current;
      if (!v) return;
      setSelectedCutId(cut.id);
      setPreviewStopAt(cut.end + 2);
      v.currentTime = Math.max(0, cut.start - 2);
      void v.play();
    },
    [],
  );

  // Stop the per-cut preview once playback passes its end+2s window.
  useEffect(() => {
    if (previewStopAt === null) return;
    if (currentTime >= previewStopAt) {
      videoRef.current?.pause();
      setPreviewStopAt(null);
    }
  }, [currentTime, previewStopAt]);

  const onSeekSelect = useCallback(
    (cut: EditorCut) => {
      setSelectedCutId(cut.id);
      seekTo(cut.start);
    },
    [seekTo],
  );

  // ---- keyboard walk-through ------------------------------------------------
  const sortedCuts = useMemo(() => [...cuts].sort((a, b) => a.start - b.start), [cuts]);
  const sortedRef = useRef(sortedCuts);
  sortedRef.current = sortedCuts;
  const selectedRef = useRef(selectedCutId);
  selectedRef.current = selectedCutId;

  const stepCut = useCallback(
    (delta: 1 | -1) => {
      const list = sortedRef.current;
      if (list.length === 0) return;
      const cur = selectedRef.current;
      let idx = cur ? list.findIndex((c) => c.id === cur) : -1;
      if (idx === -1) idx = delta > 0 ? 0 : list.length - 1;
      else idx = Math.min(list.length - 1, Math.max(0, idx + delta));
      const c = list[idx];
      if (c) {
        setSelectedCutId(c.id);
        seekTo(c.start);
      }
    },
    [seekTo],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (watchingResult) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      // Don't fight native focus: let inputs/selects/buttons keep normal keys.
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || t?.isContentEditable) {
        return;
      }
      // Cmd/Ctrl+Z undo · Shift+Cmd/Ctrl+Z redo (P3-4)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatchCuts({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave other shortcuts alone
      switch (e.key) {
        case "j":
          e.preventDefault();
          stepCut(1);
          break;
        case "k":
          e.preventDefault();
          stepCut(-1);
          break;
        case "x": {
          const id = selectedRef.current;
          if (id) {
            e.preventDefault();
            toggleCut(id);
          }
          break;
        }
        case " ": {
          e.preventDefault();
          const v = videoRef.current;
          if (v) {
            if (v.paused) void v.play();
            else v.pause();
          }
          break;
        }
        case "ArrowLeft":
          e.preventDefault();
          seekTo(Math.max(0, (videoRef.current?.currentTime ?? 0) - 5));
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo((videoRef.current?.currentTime ?? 0) + 5);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [watchingResult, stepCut, toggleCut, seekTo]);

  const onWordClick = useCallback(
    (i: number, shift: boolean) => {
      const w = words[i];
      if (!w) return;
      const cut = cuts.find((c) => c.enabled && c.end > w.start && c.start < w.end);
      if (cut) {
        toggleCut(cut.id); // keep this word: disable the covering cut
        return;
      }
      if (shift && selection) setSelection({ anchor: selection.anchor, focus: i });
      else {
        setSelection({ anchor: i, focus: i });
        seekTo(w.start);
      }
    },
    [words, cuts, selection, toggleCut, seekTo],
  );

  const cutSelection = useCallback(() => {
    if (!selection) return;
    const lo = Math.min(selection.anchor, selection.focus);
    const hi = Math.max(selection.anchor, selection.focus);
    const first = words[lo];
    const last = words[hi];
    if (!first || !last) return;
    const snippet = words
      .slice(lo, hi + 1)
      .map((w) => w.text.trim())
      .join(" ");
    dispatchCuts({
      type: "add",
      cut: { id: uid(), start: first.start, end: last.end, reason: "manual", enabled: true, manual: true, snippet },
    });
    setSelection(null);
  }, [selection, words]);

  const runRender = useCallback(async () => {
    setRendering(true);
    setRenderStage("starting");
    setError(null);
    setRenderResult(null);
    setWatchingResult(false);
    const enabled: Cut[] = cuts
      .filter((c) => c.enabled)
      .map((c) => ({ start: c.start, end: c.end, reason: c.reason, ...(c.snippet ? { snippet: c.snippet } : {}), ...(c.note ? { note: c.note } : {}) }));
    try {
      await streamSSE(
        "/api/render",
        { sessionId: session.id, cuts: enabled, burn: burn && hasSubtitlesFilter, embed },
        {
          onProgress: (s, detail) => setRenderStage(detail ? `${s}: ${detail}` : s),
          onResult: (data) => setRenderResult(data as unknown as RenderResult),
          onError: (m, hint) => setError({ message: m, ...(hint ? { hint } : {}) }),
        },
      );
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRendering(false);
      setRenderStage("");
    }
  }, [cuts, burn, embed, hasSubtitlesFilter, session.id]);

  const enabledCount = cuts.filter((c) => c.enabled).length;

  // Cache provenance summary for the compact status strip.
  const cacheBadge = useMemo(() => {
    if (!cacheInfo) return null;
    const labels: Record<keyof CacheProvenance, string> = {
      transcript: "transcript",
      denoise: "denoised audio",
      silence: "silences",
      freeze: "activity",
    };
    const hit = (Object.keys(labels) as (keyof CacheProvenance)[]).filter((k) => cacheInfo[k]);
    if (hit.length === 0) return null;
    const full = cacheInfo.transcript && cacheInfo.silence;
    return {
      full,
      text: full ? "cached ✓" : "partial cache",
      title: full
        ? "Loaded from cache — instant reopen"
        : `Partly cached: reused ${hit.map((k) => labels[k]).join(", ")}`,
    };
  }, [cacheInfo]);

  // Fuller stats sentence, surfaced as the status-strip tooltip.
  const statsTitle = useMemo(() => {
    if (!planStats) return "";
    let s = `Shortened ${planStats.silenceShortenedSeconds.toFixed(1)}s of silence; deleted ${planStats.deletedSeconds.toFixed(1)}s of content (fillers / false-starts / rambles / manual).`;
    if (planStats.silenceGaps) {
      s += ` Silences: ${planStats.silenceGaps.total} detected — ${planStats.silenceGaps.shortened} shortened, ${planStats.silenceGaps.untouched} left as-is`;
      if (planStats.silenceGaps.activeExempt > 0) {
        s += `, ${planStats.silenceGaps.activeExempt} exempt (active video)`;
      }
      s += ".";
    }
    return s;
  }, [planStats]);

  // In result mode we play the rendered file with its own (output-timeline)
  // captions and no cut-skipping; editing controls are suppressed.
  const playerSrc = watchingResult ? mediaUrl(session.id, "rendered") : mediaUrl(session.id);
  const playerVtt = watchingResult ? resultVttText : editVttText;
  // Skip cuts during a per-cut preview even if the global "Preview edit" is off.
  const skipCuts = watchingResult ? false : playEdited || previewStopAt !== null;

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn" data-testid="home-btn" onClick={onHome} title="Back to videos">
          ← Videos
        </button>
        <div className="brand">
          <strong>clean-video</strong>
          <span className="muted">{session.name}</span>
        </div>
        <div className="actions">
          {watchingResult ? (
            <button
              className="btn"
              data-testid="back-to-edit"
              onClick={() => setWatchingResult(false)}
              title="Return to the editing view"
            >
              ← Back to editing
            </button>
          ) : (
            <>
              <button
                className="btn cuts-toggle"
                data-testid="cuts-toggle"
                onClick={() => setCutsOpen((o) => !o)}
                title="Show the cut list"
              >
                Cuts ({enabledCount})
              </button>
              <label
                className="toggle"
                title="Play the video as it will render — cut sections are skipped live"
              >
                <input
                  type="checkbox"
                  data-testid="play-edited"
                  checked={playEdited}
                  onChange={(e) => setPlayEdited(e.target.checked)}
                />
                <span>Preview edit</span>
              </label>
              <div className="render-opts" title="Caption options for the render">
                <label className="toggle small">
                  <input
                    type="checkbox"
                    data-testid="embed"
                    checked={embed}
                    onChange={(e) => setEmbed(e.target.checked)}
                  />
                  <span>Embed CC</span>
                </label>
                <label className="toggle small">
                  <input
                    type="checkbox"
                    data-testid="burn"
                    checked={burn}
                    disabled={!hasSubtitlesFilter}
                    onChange={(e) => setBurn(e.target.checked)}
                  />
                  <span>Burn CC{hasSubtitlesFilter ? "" : " (n/a)"}</span>
                </label>
              </div>
              <button className="btn" onClick={() => setDrawerOpen((o) => !o)}>
                Settings
              </button>
              <button
                className="btn primary"
                data-testid="render-btn"
                disabled={rendering || analyzing || replanning || enabledCount === 0}
                onClick={runRender}
              >
                {rendering ? "Rendering…" : "Render"}
              </button>
            </>
          )}
        </div>
      </header>

      {!watchingResult && (
        <div className="statusbar" data-testid="status-strip" title={statsTitle}>
          <span className="pill">{MODE_LABEL[settings.mode]}</span>
          <span>
            <strong>{enabledCount}</strong> cuts
          </span>
          <span className="hi">−{removedEstimate.toFixed(1)}s</span>
          {info && (
            <span className="muted">
              {clock(info.duration)} → {clock(Math.max(0, info.duration - removedEstimate))}
            </span>
          )}
          {cacheBadge && (
            <span className={`chip ${cacheBadge.full ? "ok" : ""}`} title={cacheBadge.title}>
              {cacheBadge.text}
            </span>
          )}
          {replanning && (
            <span className="chip busy" data-testid="replanning">
              re-planning…
            </span>
          )}
          <span className="undo-group">
            <button
              className="btn small"
              data-testid="undo-btn"
              disabled={!canUndo}
              title="Undo (⌘Z / Ctrl+Z)"
              onClick={() => dispatchCuts({ type: "undo" })}
            >
              ↶ Undo
            </button>
            <button
              className="btn small"
              data-testid="redo-btn"
              disabled={!canRedo}
              title="Redo (⇧⌘Z / Ctrl+Shift+Z)"
              onClick={() => dispatchCuts({ type: "redo" })}
            >
              ↷ Redo
            </button>
          </span>
        </div>
      )}

      {error && (
        <div className="banner error" data-testid="error-banner">
          <span>{error.message}</span>
          {error.hint && (
            <span className="error-hint" data-testid="error-hint">
              Fix: <code>{error.hint}</code>
            </span>
          )}
        </div>
      )}
      {warnings.map((w, i) => (
        <div className="banner warn" key={i}>
          {w}
        </div>
      ))}

      {(analyzing || rendering) && (
        <div className="progress" data-testid="progress">
          <div className="bar indeterminate" />
          <span className="progress-label">
            {rendering ? `Rendering — ${renderStage}` : `Analyzing — ${stage}`}
          </span>
        </div>
      )}

      {renderResult && (
        <div className="banner ok slim" data-testid="render-result">
          <div className="render-done-row">
            <span>
              Rendered {clock(renderResult.outputDuration)} (saved{" "}
              {renderResult.removedDuration.toFixed(1)}s).
            </span>
            {/* while watching, the top bar already has "Back to editing" (P3-1: no duplicate) */}
            {!watchingResult && (
              <button
                className="btn primary"
                data-testid="watch-result"
                onClick={() => {
                  setCaptionsOn(true);
                  setWatchingResult(true);
                }}
              >
                ▶ Watch result
              </button>
            )}
          </div>
          <details className="render-files-details">
            <summary>Output files</summary>
            <div className="render-files">
              <code>{renderResult.video}</code>
              <code>{renderResult.srt}</code>
              <code>{renderResult.vtt}</code>
            </div>
          </details>
        </div>
      )}

      <main className="main">
        <div className="editor-body">
          <div className="stage">
            {watchingResult && (
              <div className="result-badge" data-testid="result-badge">
                Playing rendered result — captions on the final timeline. Editing is
                paused; go back to keep tweaking.
              </div>
            )}
            <VideoPlayer
              key={watchingResult ? "rendered" : "source"}
              videoRef={videoRef}
              src={playerSrc}
              playEdited={skipCuts}
              ranges={watchingResult ? [] : ranges}
              vtt={playerVtt}
              captionsOn={captionsOn}
              onToggleCaptions={() => setCaptionsOn((v) => !v)}
              onTime={setCurrentTime}
              onDuration={setDuration}
            />

            <Timeline
              duration={dur}
              currentTime={currentTime}
              cuts={watchingResult ? [] : cuts}
              peaks={peaks}
              onSeek={seekTo}
              onToggle={toggleCut}
              {...(watchingResult ? {} : { onTrimStart, onTrimChange, onTrimEnd })}
            />

            {/* P3-1: no legend in result mode — the result timeline has no regions */}
            {!watchingResult && (
              <div className="legend-row">
                <div className="legend">
                  {ALL_REASONS.map((r) => (
                    <span className="legend-item" key={r}>
                      <i style={{ background: REASON_COLOR[r] }} />
                      {REASON_LABEL[r]}
                    </span>
                  ))}
                </div>
                <span className="kbd-hint" data-testid="kbd-hint">
                  <kbd>j</kbd>/<kbd>k</kbd> prev/next · <kbd>x</kbd> cut · <kbd>space</kbd> play ·{" "}
                  <kbd>←</kbd>/<kbd>→</kbd> ±5s · <kbd>⌘Z</kbd> undo
                </span>
              </div>
            )}

            <div className="transcript-head">
              <h2>Transcript</h2>
              <button
                className="btn"
                data-testid="cut-selection"
                disabled={watchingResult || !selection}
                onClick={cutSelection}
              >
                Cut selection
              </button>
            </div>

            <Transcript
              words={words}
              cuts={watchingResult ? [] : cuts}
              selection={watchingResult ? null : selection}
              onWordClick={onWordClick}
              readOnly={watchingResult}
            />
          </div>

          {!watchingResult && (
            <CutsPanel
              cuts={cuts}
              open={cutsOpen}
              onClose={() => setCutsOpen(false)}
              selectedId={selectedCutId}
              onSeekSelect={onSeekSelect}
              onToggle={toggleCut}
              onToggleGroup={toggleGroup}
              onPreview={previewCut}
              onAcceptAll={() => setAll(true)}
              onRejectAll={() => setAll(false)}
            />
          )}
        </div>
      </main>

      <SettingsDrawer
        open={drawerOpen}
        settings={settings}
        analyzing={analyzing}
        overrides={overrides}
        fresh={fresh}
        onModeChange={changeMode}
        onChange={changeField}
        onFreshChange={setFresh}
        onReset={resetOverrides}
        onClose={() => setDrawerOpen(false)}
        onReanalyze={() => {
          setDrawerOpen(false);
          void runAnalyze();
        }}
      />
    </div>
  );
}
