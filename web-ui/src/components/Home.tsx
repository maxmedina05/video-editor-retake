import { useState } from "react";
import { openPath, pickFile, removeRecent, type RecentView, type SessionInfo } from "../api";
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
  const [error, setError] = useState("");

  const open = async (path: string) => {
    setBusy(true);
    setError("");
    try {
      onOpened(await openPath(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPick = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await pickFile();
      if (res.cancelled || !res.path) return; // closing the dialog is not an error
      await open(res.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  return (
    <div className="home">
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
          {error && <div className="banner error" data-testid="home-error">{error}</div>}
        </section>

        <section className="recents">
          <h2>Recent</h2>
          {recents.length === 0 ? (
            <p className="muted small">Nothing opened yet.</p>
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
