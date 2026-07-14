import { readdir as fsReaddir, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

/**
 * Server-side directory browser for the `--media-root` mode (used when the
 * native file dialog is unavailable — notably inside Docker). It lists
 * directories and video files STRICTLY under a configured root.
 *
 * Traversal guard, in two layers:
 *   1. Lexical: resolve the client-supplied relative path against the root and
 *      require the result to stay within the root (rejects `../` and absolute
 *      paths). Pure — see {@link isWithinRoot} / {@link resolveUnderRoot}.
 *   2. Symlink: `realpath` the resolved target (and every listed entry) and
 *      re-check containment, so a symlink pointing outside the root is rejected
 *      / skipped rather than followed.
 *
 * The pure guard and the fs-touching browse are separated so the guard is
 * unit-tested directly and `browse` is tested with injected fs deps.
 */

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

export class BrowseError extends Error {}

export interface BrowseEntry {
  name: string;
  kind: "dir" | "video";
  /** path relative to the media root (used to navigate deeper) */
  rel: string;
  /** absolute path (used to open the file into a session) */
  abs: string;
}

export interface BrowseResult {
  /** requested dir, relative to root ("" = root itself) */
  dir: string;
  /** parent dir relative to root, or null when already at the root */
  parent: string | null;
  entries: BrowseEntry[];
}

/**
 * Lexical containment check. Both args must be absolute + resolved. Pure.
 * `target` is contained if it equals the root or sits beneath it.
 */
export function isWithinRoot(root: string, target: string): boolean {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  return target === r || target.startsWith(r + sep);
}

/**
 * Resolve a client-supplied relative dir under `root`, lexically. Returns the
 * absolute path if it stays within the root, or null if it escapes (via `../`
 * or by being an absolute path). Pure.
 */
export function resolveUnderRoot(root: string, rel: string): string | null {
  const target = resolve(root, rel && rel.length > 0 ? rel : ".");
  return isWithinRoot(root, target) ? target : null;
}

export interface BrowseDeps {
  realpath: (p: string) => Promise<string>;
  /** directory entry names (no filtering) */
  readdir: (p: string) => Promise<string[]>;
  stat: (p: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>;
}

export const defaultBrowseDeps: BrowseDeps = {
  realpath: (p) => fsRealpath(p),
  readdir: (p) => fsReaddir(p),
  stat: (p) => fsStat(p),
};

/** Compute the parent (relative to root) of a relative dir, or null at root. */
function parentOf(relDir: string): string | null {
  if (relDir === "" || relDir === ".") return null;
  const parent = dirname(relDir);
  return parent === "." ? "" : parent;
}

/**
 * List directories + video files directly under `<root>/<relDir>`, rejecting
 * any path (requested or symlinked) that escapes the root.
 */
export async function browse(
  rootRaw: string,
  relDir: string,
  deps: BrowseDeps = defaultBrowseDeps,
): Promise<BrowseResult> {
  const root = await deps.realpath(resolve(rootRaw));

  const lexical = resolveUnderRoot(root, relDir);
  if (lexical === null) throw new BrowseError("path escapes media root");

  // Resolve symlinks on the requested dir itself and re-check containment.
  let real: string;
  try {
    real = await deps.realpath(lexical);
  } catch {
    throw new BrowseError("directory not found");
  }
  if (!isWithinRoot(root, real)) throw new BrowseError("path escapes media root");

  const dirStat = await deps.stat(real).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) throw new BrowseError("not a directory");

  const names = await deps.readdir(real);
  const entries: BrowseEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // hide dotfiles
    const abs = join(real, name);
    // Skip anything that resolves outside the root (symlink escape) or can't be stat'd.
    let realEntry: string;
    try {
      realEntry = await deps.realpath(abs);
    } catch {
      continue;
    }
    if (!isWithinRoot(root, realEntry)) continue;
    let st: { isDirectory: () => boolean; isFile: () => boolean };
    try {
      st = await deps.stat(realEntry);
    } catch {
      continue;
    }
    const rel = relative(root, abs);
    if (st.isDirectory()) {
      entries.push({ name, kind: "dir", rel, abs });
    } else if (st.isFile() && VIDEO_EXTS.has(extname(name).toLowerCase())) {
      entries.push({ name, kind: "video", rel, abs });
    }
  }

  // Directories first, then videos; alpha within each group.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const dir = relative(root, real);
  return { dir, parent: parentOf(dir), entries };
}
