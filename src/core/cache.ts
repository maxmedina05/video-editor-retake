import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * On-disk analysis cache so reopening the same file is instant.
 *
 * The expensive analyze passes (denoise, silencedetect, freezedetect, whisper)
 * are deterministic for a given file + the settings that actually affect them.
 * We cache each pass SEPARATELY, keyed by file identity plus only the knobs it
 * depends on, so changing one knob invalidates only what it must. The cut PLAN
 * is cheap pure computation and is NEVER cached — it is always rebuilt from the
 * cached artifacts against the current knobs.
 *
 * Key/invalidation matrix (see `*Key` helpers):
 *   transcript  -> identity + whisper model (+ modelPath, language)   [the slow one]
 *   denoised wav-> identity + resolved denoise method
 *   silence     -> identity + denoise key + silence threshold + minSilence
 *   freeze      -> identity + freezedetect noise + minDuration
 *
 * silencedetect bakes BOTH `noise=<threshold>dB` and `d=<minSilence>` into the
 * ffmpeg filter, so there is no cheap "raw spans at a permissive floor" form to
 * store — the filter itself decides what is emitted. We therefore key silence
 * spans on the exact params (threshold + minSilence). It is fast anyway (an
 * audio-only decode of the already-denoised wav), so re-running on a threshold
 * change is negligible next to whisper.
 *
 * JSON artifacts are tiny and kept indefinitely; the denoised WAVs are large
 * (tens of MB) and evicted LRU under a byte cap (see {@link planEviction}).
 * Pure key derivation + eviction are unit tested; disk I/O is a thin wrapper.
 */

/** Default WAV byte cap (~2 GB); override with CLEAN_VIDEO_CACHE_MAX_BYTES. */
export const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** `${XDG_CACHE_HOME:-~/.cache}/clean-video`. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".cache");
  return join(base, "clean-video");
}

/** Resolve the WAV byte cap from env, falling back to the default. */
export function maxCacheBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLEAN_VIDEO_CACHE_MAX_BYTES;
  if (!raw) return DEFAULT_CACHE_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_MAX_BYTES;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Deterministic JSON: object keys sorted so param order never changes a key. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(",")}}`;
}

function paramHash(params: unknown): string {
  return sha256(stable(params)).slice(0, 12);
}

export interface FileIdentityInput {
  /** absolute path to the source file */
  path: string;
  /** file size in bytes */
  size: number;
  /** last-modified time in ms since epoch */
  mtimeMs: number;
}

/**
 * Identity of a source file: absolute path + size + mtime. If any of these
 * differ the file is considered changed and every artifact misses.
 */
export function fileIdentity(f: FileIdentityInput): string {
  return sha256(`${f.path}\0${f.size}\0${f.mtimeMs}`).slice(0, 16);
}

export interface TranscriptKeyParams {
  model: string;
  modelPath?: string | undefined;
  language?: string | undefined;
}

export function transcriptKey(identity: string, p: TranscriptKeyParams): string {
  return `transcript-${identity}-${paramHash({
    model: p.model,
    modelPath: p.modelPath ?? null,
    language: p.language ?? null,
  })}`;
}

export function denoiseKey(identity: string, p: { method: string }): string {
  return `denoise-${identity}-${paramHash({ method: p.method })}`;
}

export function silenceKey(
  identity: string,
  denoiseK: string,
  p: { thresholdDb: number; minSilence: number },
): string {
  return `silence-${identity}-${paramHash({
    denoise: denoiseK,
    thresholdDb: p.thresholdDb,
    minSilence: p.minSilence,
  })}`;
}

export function freezeKey(identity: string, p: { noise: number; minDuration: number }): string {
  return `freeze-${identity}-${paramHash({ noise: p.noise, minDuration: p.minDuration })}`;
}

// ---- eviction (pure) --------------------------------------------------------

export interface EvictionEntry {
  path: string;
  size: number;
  /** last-access time in ms (we touch WAVs on read so this tracks LRU) */
  atimeMs: number;
}

/**
 * Pure: pick WAV files to evict so the total stays within `maxBytes`. Evicts
 * least-recently-accessed first; `pinned` paths are never evicted (the WAV a
 * running analysis is about to use). Returns the paths to delete.
 */
export function planEviction(
  entries: EvictionEntry[],
  maxBytes: number,
  pinned: ReadonlySet<string> = new Set(),
): string[] {
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (total <= maxBytes) return [];
  const candidates = entries
    .filter((e) => !pinned.has(e.path))
    .sort((a, b) => a.atimeMs - b.atimeMs);
  const evict: string[] = [];
  let running = total;
  for (const e of candidates) {
    if (running <= maxBytes) break;
    evict.push(e.path);
    running -= e.size;
  }
  return evict;
}

// ---- disk I/O (thin wrapper) ------------------------------------------------

export type ReadResult<T> =
  | { kind: "hit"; value: T }
  | { kind: "miss" }
  | { kind: "corrupt"; error: string };

export interface Cache {
  /** Read + parse a JSON artifact. Distinguishes miss from corrupt/truncated. */
  readJson<T>(key: string): Promise<ReadResult<T>>;
  /** Atomically write a JSON artifact (tmp file + rename). */
  writeJson(key: string, value: unknown): Promise<void>;
  /** Absolute path a WAV with this key would live at. */
  wavPath(key: string): string;
  /** Whether a WAV for this key exists; touches it (LRU) when present. */
  hasWav(key: string): Promise<boolean>;
  /** Atomically copy `src` into the cache as this key's WAV; returns its path. */
  importWav(key: string, src: string): Promise<string>;
  /** Evict WAVs beyond the byte cap (LRU); pinned keys are protected. */
  evictWavs(maxBytes: number, pinnedKeys?: string[]): Promise<void>;
}

/** Create a cache rooted at `dir` (created lazily on first write). */
export function createCache(dir: string): Cache {
  const jsonPath = (key: string): string => join(dir, `${key}.json`);
  const wavPath = (key: string): string => join(dir, `${key}.wav`);

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /** Touch atime+mtime to now so LRU eviction sees recent use. */
  async function touch(path: string): Promise<void> {
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
  }

  return {
    async readJson<T>(key: string): Promise<ReadResult<T>> {
      let text: string;
      try {
        text = await readFile(jsonPath(key), "utf8");
      } catch {
        return { kind: "miss" };
      }
      try {
        return { kind: "hit", value: JSON.parse(text) as T };
      } catch (err) {
        return { kind: "corrupt", error: err instanceof Error ? err.message : String(err) };
      }
    },

    async writeJson(key: string, value: unknown): Promise<void> {
      await ensureDir();
      const final = jsonPath(key);
      const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(value), "utf8");
      await rename(tmp, final);
    },

    wavPath,

    async hasWav(key: string): Promise<boolean> {
      try {
        await stat(wavPath(key));
        await touch(wavPath(key));
        return true;
      } catch {
        return false;
      }
    },

    async importWav(key: string, src: string): Promise<string> {
      await ensureDir();
      const final = wavPath(key);
      const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
      await copyFile(src, tmp);
      await rename(tmp, final);
      return final;
    },

    async evictWavs(maxBytes: number, pinnedKeys: string[] = []): Promise<void> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return; // no cache dir yet
      }
      const entries: EvictionEntry[] = [];
      for (const name of names) {
        if (!name.endsWith(".wav")) continue;
        const full = join(dir, name);
        try {
          const st = await stat(full);
          entries.push({ path: full, size: st.size, atimeMs: st.atimeMs });
        } catch {
          // ignore files that vanished mid-scan
        }
      }
      const pinned = new Set(pinnedKeys.map(wavPath));
      const toEvict = planEviction(entries, maxBytes, pinned);
      await Promise.all(toEvict.map((p) => rm(p, { force: true }).catch(() => {})));
    },
  };
}
