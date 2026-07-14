import { useRef, useState } from "react";
import { ApiError, openPath, pickFile, removeRecent, type RecentView, type SessionInfo } from "../api";
import { clock } from "../util";
import FileBrowser from "./FileBrowser";

interface Props {
  pickerAvailable: boolean;
  mediaRoot: boolean;
  recents: RecentView[];
  onRecents: (recents: RecentView[]) => void;
  onOpened: (session: SessionInfo) => void;
}

/** Home screen: title + ways to open a video (dialog / browser / path) + recents. */
export default function Home({ pickerAvailable, mediaRoot, recents, onRecents, onOpened }: Props) {
  const [pathInput, setPathInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  // Drag-and-drop (P3-3): browsers don't reveal a dropped file's absolute path,
  // and this app opens files in place (no multi-GB uploads) — so a drop shows a
  // friendly pointer to the real open methods instead.
  const [dragOver, setDragOver] = useState(false);
  const [dropHint, setDropHint] = useState("");
  const dragDepth = useRef(0);

  const open = async (path: string) => {
    setBusy(true);
    setError(null);
    setDropHint("");
    try {
      onOpened(await openPath(path));
    } catch (e) {
      if (e instanceof ApiError) setError({ message: e.message, ...(e.hint ? { hint: e.hint } : {}) });
      else setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onPick = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await pickFile();
      if (res.cancelled || !res.path) return; // closing the dialog is not an error
      await open(res.path);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onSubmitPath = (e: React.FormEvent) => {
    e.preventDefault();
    const p = pathInput.trim();
    if (p) void open(p);
  };

  const onRemove = async (path: string) => {
    try {
      onRecents(await removeRecent(path));
    } catch {
      /* ignore */
    }
  };

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    // Electron-style environments expose the real path; normal browsers don't.
    const realPath = (file as File & { path?: string }).path;
    if (realPath) {
      void open(realPath);
      return;
    }
    setDropHint(
      `Almost — the browser won't tell this app where "${file.name}" lives, and clean-video ` +
        `edits your file in place instead of uploading a copy. Open it with the button, ` +
        `paste its path below, or pick it from Recent.`,
    );
  };

  return (
    <div
      className={`home ${dragOver ? "drag-over" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="home-inner">
        <header className="home-head">
          <h1>clean-video</h1>
          <p className="muted">Denoise, cut silence &amp; fillers, auto captions — all local.</p>
        </header>

        <section className="open-panel">
          {pickerAvailable && (
            <button
              className="btn primary big"
              data-testid="open-dialog"
              disabled={busy}
              onClick={() => void onPick()}
            >
              Open video…
            </button>
          )}

          {mediaRoot && <FileBrowser onOpen={(abs) => void open(abs)} disabled={busy} />}

          <form className="path-open" onSubmit={onSubmitPath}>
            <input
              type="text"
              data-testid="path-input"
              placeholder="…or paste an absolute path (/Users/you/clip.mp4)"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              spellCheck={false}
            />
            <button className="btn" type="submit" data-testid="open-path" disabled={busy || !pathInput.trim()}>
              Open
            </button>
          </form>

          {busy && <div className="muted small">Opening…</div>}
          {dropHint && (
            <div className="banner info drop-hint" data-testid="drop-hint">
              <span>{dropHint}</span>
              <button className="icon-btn" aria-label="dismiss" onClick={() => setDropHint("")}>
                ×
              </button>
            </div>
          )}
          {error && (
            <div className="banner error" data-testid="home-error">
              <span>{error.message}</span>
              {error.hint && (
                <span className="error-hint">
                  Fix: <code>{error.hint}</code>
                </span>
              )}
            </div>
          )}
        </section>

        <section className="recents">
          <h2>Recent</h2>
          {recents.length === 0 ? (
            <div className="home-hero" data-testid="home-hero">
              <p>
                Open a screen recording and get back a tightened copy — silences shortened,
                filler words cut, captions generated. Everything runs on this machine, and
                analysis is cached so reopening a video is instant.
              </p>
              <ul className="home-hero-methods">
                {pickerAvailable && (
                  <li>
                    <strong>Open video…</strong> — pick a file with the native dialog
                  </li>
                )}
                {mediaRoot && (
                  <li>
                    <strong>Browse</strong> — pick from the media folder above
                  </li>
                )}
                <li>
                  <strong>Paste a path</strong> — any absolute path to a video file
                </li>
                <li>
                  <strong>Recent</strong> — files you've opened will be listed here
                </li>
              </ul>
            </div>
          ) : (
            <ul className="recents-list" data-testid="recents">
              {recents.map((r) => (
                <li key={r.path} className={`recent ${r.exists ? "" : "missing"}`}>
                  <button
                    className="recent-open"
                    data-testid="recent-item"
                    disabled={!r.exists || busy}
                    title={r.exists ? r.path : `missing: ${r.path}`}
                    onClick={() => r.exists && void open(r.path)}
                  >
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-meta">
                      {r.duration > 0 ? clock(r.duration) : ""}
                      {r.exists ? "" : " · missing"}
                    </span>
                    <span className="recent-path">{r.path}</span>
                  </button>
                  <button
                    className="icon-btn recent-remove"
                    aria-label="remove from recents"
                    title="Remove from recents"
                    onClick={() => void onRemove(r.path)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
