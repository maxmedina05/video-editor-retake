import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import VideoPlayer from "./VideoPlayer";
import Timeline from "./Timeline";
import Transcript from "./Transcript";
import SettingsDrawer from "./SettingsDrawer";
import { mediaUrl, streamSSE, type SessionInfo } from "../api";
import { ALL_REASONS, REASON_COLOR, REASON_LABEL } from "../reasons";
import { clock, mergedEnabledRanges } from "../util";
import { editVtt, resultVtt } from "../captions";
import {
  MODE_PRESETS,
  MODE_PRESET_KEYS,
  type AnalyzeResult,
  type CacheProvenance,
  type Cut,
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
  const [stage, setStage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  // Force-fresh toggle (Settings > Advanced) and the cache provenance of the
  // last analyze, for the "loaded from cache" badge.
  const [fresh, setFresh] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<CacheProvenance | null>(null);

  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const [cuts, setCuts] = useState<EditorCut[]>([]);
  const [planStats, setPlanStats] = useState<CutStats | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playEdited, setPlayEdited] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null);
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

  const runAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setError("");
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
            setCuts((prev) => [...prev.filter((c) => c.manual), ...toEditorCuts(r.plan.cuts)]);
            setSelection(null);
          },
          onError: (m) => setError(m),
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
  }, []);

  const toggleCut = useCallback((id: string) => {
    setCuts((cs) => cs.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)));
  }, []);

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
    setCuts((cs) => [
      ...cs,
      { id: uid(), start: first.start, end: last.end, reason: "manual", enabled: true, manual: true, snippet },
    ]);
    setSelection(null);
  }, [selection, words]);

  const runRender = useCallback(async () => {
    setRendering(true);
    setRenderStage("starting");
    setError("");
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
          onError: (m) => setError(m),
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRendering(false);
      setRenderStage("");
    }
  }, [cuts, burn, embed, hasSubtitlesFilter, session.id]);

  const enabledCount = cuts.filter((c) => c.enabled).length;

  // Cache provenance summary for the badge: none / partial / full.
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
    // "full" when the expensive transcript + silences both came from cache.
    const full = cacheInfo.transcript && cacheInfo.silence;
    return {
      full,
      text: full
        ? "Loaded from cache — instant reopen"
        : `Partly cached: reused ${hit.map((k) => labels[k]).join(", ")}`,
    };
  }, [cacheInfo]);

  // In result mode we play the rendered file with its own (output-timeline)
  // captions and no cut-skipping; editing controls are suppressed.
  const playerSrc = watchingResult ? mediaUrl(session.id, "rendered") : mediaUrl(session.id);
  const playerVtt = watchingResult ? resultVttText : editVttText;

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
        <div className="stats">
          {info && (
            <>
              <span>src {clock(info.duration)}</span>
              <span className="arrow">→</span>
              <span className="hi">edited {clock(Math.max(0, info.duration - removedEstimate))}</span>
              <span className="muted">
                ({enabledCount} cuts · −{removedEstimate.toFixed(1)}s)
              </span>
            </>
          )}
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
              <label className="toggle">
                <input
                  type="checkbox"
                  data-testid="play-edited"
                  checked={playEdited}
                  onChange={(e) => setPlayEdited(e.target.checked)}
                />
                <span>Play edited</span>
              </label>
              <button className="btn" onClick={() => setDrawerOpen((o) => !o)}>
                Settings
              </button>
              <button
                className="btn primary"
                data-testid="render-btn"
                disabled={rendering || analyzing || enabledCount === 0}
                onClick={runRender}
              >
                {rendering ? "Rendering…" : "Render"}
              </button>
            </>
          )}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {warnings.map((w, i) => (
        <div className="banner warn" key={i}>
          {w}
        </div>
      ))}

      {cacheBadge && !analyzing && (
        <div
          className={`banner ${cacheBadge.full ? "ok" : "info"}`}
          data-testid="cache-badge"
        >
          {cacheBadge.text}
        </div>
      )}

      {planStats && !analyzing && (
        <div className="banner info" data-testid="plan-stats">
          Removed <strong>{planStats.silenceShortenedSeconds.toFixed(1)}s</strong> by shortening
          silence and <strong>{planStats.deletedSeconds.toFixed(1)}s</strong> by deleting content
          (fillers / false-starts / rambles / manual).
          {planStats.silenceGaps && (
            <>
              {" "}
              Silences: {planStats.silenceGaps.total} detected —{" "}
              {planStats.silenceGaps.shortened} shortened, {planStats.silenceGaps.untouched} left
              as-is
              {planStats.silenceGaps.activeExempt > 0
                ? `, ${planStats.silenceGaps.activeExempt} exempt (active video)`
                : ""}
              .
            </>
          )}
        </div>
      )}

      {(analyzing || rendering) && (
        <div className="progress" data-testid="progress">
          <div className="bar indeterminate" />
          <span className="progress-label">
            {rendering ? `Rendering — ${renderStage}` : `Analyzing — ${stage}`}
          </span>
        </div>
      )}

      {renderResult && (
        <div className="banner ok" data-testid="render-result">
          <div className="render-done-row">
            <span>
              Rendered {clock(renderResult.outputDuration)} (saved{" "}
              {renderResult.removedDuration.toFixed(1)}s).
            </span>
            {watchingResult ? (
              <button
                className="btn"
                data-testid="back-to-edit-banner"
                onClick={() => setWatchingResult(false)}
              >
                ← Back to editing
              </button>
            ) : (
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
          <div className="render-files">
            <code>{renderResult.video}</code>
            <code>{renderResult.srt}</code>
            <code>{renderResult.vtt}</code>
          </div>
        </div>
      )}

      <main className="main">
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
          playEdited={watchingResult ? false : playEdited}
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
          onSeek={seekTo}
          onToggle={toggleCut}
        />

        <div className="legend">
          {ALL_REASONS.map((r) => (
            <span className="legend-item" key={r}>
              <i style={{ background: REASON_COLOR[r] }} />
              {REASON_LABEL[r]}
            </span>
          ))}
        </div>

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
          <label className="toggle small">
            <input
              type="checkbox"
              data-testid="embed"
              checked={embed}
              disabled={watchingResult}
              onChange={(e) => setEmbed(e.target.checked)}
            />
            <span>Embed captions (soft, toggleable)</span>
          </label>
          <label className="toggle small">
            <input
              type="checkbox"
              data-testid="burn"
              checked={burn}
              disabled={watchingResult || !hasSubtitlesFilter}
              onChange={(e) => setBurn(e.target.checked)}
            />
            <span>Burn-in captions (hard){hasSubtitlesFilter ? "" : " (unavailable)"}</span>
          </label>
        </div>

        <Transcript
          words={words}
          cuts={watchingResult ? [] : cuts}
          selection={watchingResult ? null : selection}
          onWordClick={onWordClick}
          readOnly={watchingResult}
        />
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
