import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cacheDir,
  createCache,
  denoiseKey,
  fileIdentity,
  freezeKey,
  maxCacheBytes,
  planEviction,
  silenceKey,
  transcriptKey,
  type EvictionEntry,
} from "./cache.js";

describe("cacheDir", () => {
  it("honors XDG_CACHE_HOME", () => {
    expect(cacheDir({ XDG_CACHE_HOME: "/xdg" })).toBe("/xdg/clean-video");
  });

  it("falls back to ~/.cache when XDG is empty", () => {
    expect(cacheDir({ XDG_CACHE_HOME: "  " }).endsWith("/.cache/clean-video")).toBe(true);
  });
});

describe("maxCacheBytes", () => {
  it("defaults to ~2GB", () => {
    expect(maxCacheBytes({})).toBe(2 * 1024 * 1024 * 1024);
  });
  it("reads a positive override", () => {
    expect(maxCacheBytes({ CLEAN_VIDEO_CACHE_MAX_BYTES: "1000" })).toBe(1000);
  });
  it("ignores a non-numeric or non-positive override", () => {
    expect(maxCacheBytes({ CLEAN_VIDEO_CACHE_MAX_BYTES: "nope" })).toBe(2 * 1024 * 1024 * 1024);
    expect(maxCacheBytes({ CLEAN_VIDEO_CACHE_MAX_BYTES: "-5" })).toBe(2 * 1024 * 1024 * 1024);
  });
});

describe("fileIdentity", () => {
  const base = { path: "/v/demo.mp4", size: 100, mtimeMs: 1000 };
  it("is stable for the same inputs", () => {
    expect(fileIdentity(base)).toBe(fileIdentity({ ...base }));
  });
  it("changes when size changes", () => {
    expect(fileIdentity(base)).not.toBe(fileIdentity({ ...base, size: 101 }));
  });
  it("changes when mtime changes", () => {
    expect(fileIdentity(base)).not.toBe(fileIdentity({ ...base, mtimeMs: 1001 }));
  });
  it("changes when path changes", () => {
    expect(fileIdentity(base)).not.toBe(fileIdentity({ ...base, path: "/v/other.mp4" }));
  });
});

// The invalidation matrix: each key must react to exactly the knobs it depends
// on and ignore the rest. A touched file (new identity) invalidates everything.
describe("artifact keys — invalidation matrix", () => {
  const id = fileIdentity({ path: "/v/demo.mp4", size: 100, mtimeMs: 1000 });
  const id2 = fileIdentity({ path: "/v/demo.mp4", size: 100, mtimeMs: 2000 });

  it("transcript depends on model + modelPath + language, and identity", () => {
    const k = transcriptKey(id, { model: "base.en" });
    expect(transcriptKey(id, { model: "base.en" })).toBe(k); // stable
    expect(transcriptKey(id, { model: "small.en" })).not.toBe(k); // model change
    expect(transcriptKey(id, { model: "base.en", language: "en" })).not.toBe(k); // language
    expect(transcriptKey(id, { model: "base.en", modelPath: "/m.bin" })).not.toBe(k); // modelPath
    expect(transcriptKey(id2, { model: "base.en" })).not.toBe(k); // touched file
  });

  it("denoise depends on the resolved method", () => {
    const k = denoiseKey(id, { method: "deep-filter" });
    expect(denoiseKey(id, { method: "deep-filter" })).toBe(k);
    expect(denoiseKey(id, { method: "afftdn" })).not.toBe(k);
    expect(denoiseKey(id2, { method: "deep-filter" })).not.toBe(k);
  });

  it("silence depends on denoise key + threshold + minSilence", () => {
    const d = denoiseKey(id, { method: "afftdn" });
    const k = silenceKey(id, d, { thresholdDb: -30, minSilence: 1.2 });
    expect(silenceKey(id, d, { thresholdDb: -30, minSilence: 1.2 })).toBe(k);
    expect(silenceKey(id, d, { thresholdDb: -25, minSilence: 1.2 })).not.toBe(k); // threshold
    expect(silenceKey(id, d, { thresholdDb: -30, minSilence: 0.8 })).not.toBe(k); // minSilence
    // a different denoise method feeds a different denoise key -> different silence key
    const d2 = denoiseKey(id, { method: "deep-filter" });
    expect(silenceKey(id, d2, { thresholdDb: -30, minSilence: 1.2 })).not.toBe(k);
  });

  it("freeze depends on noise + minDuration", () => {
    const k = freezeKey(id, { noise: 0.001, minDuration: 1.0 });
    expect(freezeKey(id, { noise: 0.001, minDuration: 1.0 })).toBe(k);
    expect(freezeKey(id, { noise: 0.002, minDuration: 1.0 })).not.toBe(k);
    expect(freezeKey(id, { noise: 0.001, minDuration: 2.0 })).not.toBe(k);
  });

  it("changing the whisper model does NOT change silence/freeze keys", () => {
    // The point of per-artifact keys: a model swap re-runs only the transcript.
    const d = denoiseKey(id, { method: "afftdn" });
    const s = silenceKey(id, d, { thresholdDb: -30, minSilence: 1.2 });
    const f = freezeKey(id, { noise: 0.001, minDuration: 1.0 });
    // (model isn't an input to either key, so they are unchanged by construction)
    expect(silenceKey(id, d, { thresholdDb: -30, minSilence: 1.2 })).toBe(s);
    expect(freezeKey(id, { noise: 0.001, minDuration: 1.0 })).toBe(f);
  });
});

describe("planEviction", () => {
  const e = (path: string, size: number, atimeMs: number): EvictionEntry => ({ path, size, atimeMs });

  it("evicts nothing when under the cap", () => {
    expect(planEviction([e("/a", 10, 1), e("/b", 10, 2)], 100)).toEqual([]);
  });

  it("evicts least-recently-accessed first until under the cap", () => {
    const entries = [e("/old", 40, 1), e("/mid", 40, 2), e("/new", 40, 3)];
    // total 120, cap 100 -> must drop 20+; oldest (/old) frees 40 -> under cap
    expect(planEviction(entries, 100)).toEqual(["/old"]);
  });

  it("evicts multiple when one is not enough", () => {
    const entries = [e("/old", 30, 1), e("/mid", 30, 2), e("/new", 30, 3)];
    // total 90, cap 40 -> drop /old (60), still >40 -> drop /mid (30) -> done
    expect(planEviction(entries, 40)).toEqual(["/old", "/mid"]);
  });

  it("never evicts a pinned entry, even if it is the oldest", () => {
    const entries = [e("/old", 40, 1), e("/mid", 40, 2), e("/new", 40, 3)];
    const out = planEviction(entries, 100, new Set(["/old"]));
    expect(out).toEqual(["/mid"]); // /old protected, next-oldest goes
  });
});

describe("createCache disk I/O", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cv-cache-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a JSON artifact", async () => {
    const cache = createCache(dir);
    await cache.writeJson("k", { a: 1, spans: [{ start: 0, end: 1 }] });
    const r = await cache.readJson<{ a: number }>("k");
    expect(r).toEqual({ kind: "hit", value: { a: 1, spans: [{ start: 0, end: 1 }] } });
  });

  it("reports a miss for an absent key", async () => {
    const cache = createCache(dir);
    expect(await cache.readJson("nope")).toEqual({ kind: "miss" });
  });

  it("reports corrupt (not a crash) for a truncated JSON file, and overwrite recovers", async () => {
    const cache = createCache(dir);
    // Simulate a process killed mid-write leaving half a JSON document.
    await writeFile(join(dir, "k.json"), '{"spans":[{"start":0,"en', "utf8");
    const r = await cache.readJson("k");
    expect(r.kind).toBe("corrupt");
    // Treating it as a miss, the caller recomputes and overwrites atomically.
    await cache.writeJson("k", { spans: [] });
    expect(await cache.readJson("k")).toEqual({ kind: "hit", value: { spans: [] } });
  });

  it("writes JSON atomically, leaving no .tmp files behind", async () => {
    const cache = createCache(dir);
    await cache.writeJson("k", { ok: true });
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(dir);
    expect(names).toEqual(["k.json"]);
  });

  it("imports a WAV atomically and reports its presence", async () => {
    const cache = createCache(dir);
    const src = join(tmpdir(), `cv-src-${Date.now()}.bin`);
    await writeFile(src, "RIFFfake-wav-bytes");
    expect(await cache.hasWav("d")).toBe(false);
    const dest = await cache.importWav("d", src);
    expect(dest).toBe(cache.wavPath("d"));
    expect(await cache.hasWav("d")).toBe(true);
    expect(await readFile(dest, "utf8")).toBe("RIFFfake-wav-bytes");
  });

  it("evicts WAVs over the byte cap and keeps pinned ones", async () => {
    const { utimes } = await import("node:fs/promises");
    const cache = createCache(dir);
    const src = join(tmpdir(), `cv-src-${Date.now()}.bin`);
    await writeFile(src, Buffer.alloc(100));
    await cache.importWav("a", src);
    await cache.importWav("b", src);
    await cache.importWav("c", src);
    // Pin atimes deterministically (a oldest, c newest) so LRU order is stable
    // regardless of filesystem atime granularity.
    await utimes(cache.wavPath("a"), new Date(1000), new Date(1000));
    await utimes(cache.wavPath("b"), new Date(2000), new Date(2000));
    await utimes(cache.wavPath("c"), new Date(3000), new Date(3000));
    // total 300 bytes, cap 250: dropping the oldest unpinned ("a") frees enough.
    await cache.evictWavs(250, ["c"]);
    expect(await cache.hasWav("a")).toBe(false);
    expect(await cache.hasWav("b")).toBe(true);
    expect(await cache.hasWav("c")).toBe(true);
  });
});
