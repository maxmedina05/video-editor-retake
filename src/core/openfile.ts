import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { probe } from "./probe.js";
import type { MediaInfo } from "./types.js";

/**
 * Validation gate for opening a video by path. The decision logic is pure
 * given injectable `stat`/`probe` adapters, so it is unit-tested without
 * touching the filesystem or ffprobe.
 *
 * A path is only openable if it is absolute, a regular existing file, and
 * ffprobe can read at least one audio or video stream from it.
 */

export interface StatLike {
  isFile(): boolean;
}

export interface ValidateDeps {
  stat: (path: string) => Promise<StatLike>;
  probe: (path: string) => Promise<MediaInfo>;
}

export type ValidateResult =
  | { ok: true; info: MediaInfo }
  | { ok: false; error: string };

export const defaultValidateDeps: ValidateDeps = {
  stat: (p) => stat(p),
  probe: (p) => probe(p),
};

export async function validateVideoPath(
  path: string,
  deps: ValidateDeps = defaultValidateDeps,
): Promise<ValidateResult> {
  if (!path || !isAbsolute(path)) {
    return { ok: false, error: "path must be an absolute path" };
  }

  let st: StatLike;
  try {
    st = await deps.stat(path);
  } catch {
    return { ok: false, error: `file not found: ${path}` };
  }
  if (!st.isFile()) {
    return { ok: false, error: `not a regular file: ${path}` };
  }

  let info: MediaInfo;
  try {
    info = await deps.probe(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `not a readable video (ffprobe failed): ${msg}` };
  }
  if (!info.hasVideo && !info.hasAudio) {
    return { ok: false, error: `no audio or video streams found in ${path}` };
  }
  return { ok: true, info };
}
