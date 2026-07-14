import { useEffect, useState } from "react";
import { browse, type BrowseEntry } from "../api";

interface Props {
  /** called with the absolute path of a chosen video file */
  onOpen: (abs: string) => void;
  disabled?: boolean;
}

/**
 * Minimal click-through directory browser for no-dialog environments
 * (Docker with --media-root). Navigates dirs relative to the server's media
 * root and opens a video by its absolute path via the normal open flow.
 */
export default function FileBrowser({ onOpen, disabled }: Props) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    browse(dir)
      .then((r) => {
        if (cancelled) return;
        setEntries(r.entries);
        setParent(r.parent);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  return (
    <section className="file-browser" data-testid="file-browser">
      <div className="fb-head">
        <span className="fb-crumb" title={dir || "media root"}>
          /{dir}
        </span>
        {parent !== null && (
          <button
            className="btn small"
            data-testid="fb-up"
            disabled={disabled || loading}
            onClick={() => setDir(parent)}
          >
            ↑ Up
          </button>
        )}
      </div>
      {error && <div className="banner error" data-testid="fb-error">{error}</div>}
      {loading ? (
        <div className="muted small">Loading…</div>
      ) : entries.length === 0 ? (
        <p className="muted small">Empty folder.</p>
      ) : (
        <ul className="fb-list" data-testid="fb-list">
          {entries.map((e) => (
            <li key={e.rel}>
              <button
                className={`fb-entry ${e.kind}`}
                data-testid={`fb-${e.kind}`}
                disabled={disabled}
                onClick={() => (e.kind === "dir" ? setDir(e.rel) : onOpen(e.abs))}
              >
                <span className="fb-icon">{e.kind === "dir" ? "📁" : "🎬"}</span>
                <span className="fb-name">{e.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
