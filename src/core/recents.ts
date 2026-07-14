import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persisted "recently opened videos" list.
 *
 * The list transforms (upsert / remove / cap) are pure and unit-tested; disk
 * I/O is a thin wrapper on top. Stored at
 * `${XDG_CONFIG_HOME:-~/.config}/clean-video/recents.json`.
 */

export interface RecentEntry {
  /** absolute path to the source video */
  path: string;
  /** display name (basename) */
  name: string;
  /** duration in seconds (0 if unknown) */
  duration: number;
  /** epoch ms of the last time this file was opened */
  lastOpened: number;
}

/** Keep at most this many recents. */
export const RECENTS_CAP = 15;

/**
 * Pure: put `entry` at the front, de-duplicating by path (case-sensitive,
 * already-resolved absolute paths), and cap the list length. Most-recent-first.
 */
export function upsertRecent(
  list: readonly RecentEntry[],
  entry: RecentEntry,
  cap: number = RECENTS_CAP,
): RecentEntry[] {
  const rest = list.filter((e) => e.path !== entry.path);
  return [entry, ...rest].slice(0, Math.max(0, cap));
}

/** Pure: drop the entry with this path (no-op if absent). */
export function removeRecentByPath(
  list: readonly RecentEntry[],
  path: string,
): RecentEntry[] {
  return list.filter((e) => e.path !== path);
}

/** Pure: tolerant parse of recents.json contents into a clean, typed list. */
export function parseRecents(text: string): RecentEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentEntry[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.path !== "string" || r.path.length === 0) continue;
    out.push({
      path: r.path,
      name: typeof r.name === "string" ? r.name : r.path.split("/").pop() ?? r.path,
      duration: typeof r.duration === "number" && Number.isFinite(r.duration) ? r.duration : 0,
      lastOpened:
        typeof r.lastOpened === "number" && Number.isFinite(r.lastOpened) ? r.lastOpened : 0,
    });
  }
  return out;
}

/** `${XDG_CONFIG_HOME:-~/.config}/clean-video`. */
export function recentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config");
  return join(base, "clean-video");
}

export function recentsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(recentsDir(env), "recents.json");
}

/** Load recents from disk; returns [] when the file is missing or corrupt. */
export async function loadRecents(env: NodeJS.ProcessEnv = process.env): Promise<RecentEntry[]> {
  try {
    const text = await readFile(recentsPath(env), "utf8");
    return parseRecents(text);
  } catch {
    return [];
  }
}

/** Persist recents to disk, creating the config dir on demand. */
export async function saveRecents(
  list: readonly RecentEntry[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = recentsPath(env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(list, null, 2), "utf8");
}
