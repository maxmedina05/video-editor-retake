import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveBinary, type ResolveBinaryDeps } from "./binaries.js";

/** Build deps whose `isExecutable` returns true only for the listed absolute paths. */
function depsWithExisting(existing: string[], platform: NodeJS.Platform, arch: string): ResolveBinaryDeps {
  const set = new Set(existing);
  return {
    isExecutable: (p) => set.has(p),
    platform,
    arch,
    pkgRoot: "/pkg",
  };
}

describe("resolveBinary", () => {
  it("prefers the platform/arch-suffixed vendored binary", () => {
    const suffixed = join("/pkg", "bin", "deep-filter-linux-x64");
    const deps = depsWithExisting([suffixed, join("/pkg", "bin", "deep-filter")], "linux", "x64");
    expect(resolveBinary("deep-filter", deps)).toBe(suffixed);
  });

  it("falls back to the legacy unsuffixed vendored binary", () => {
    const legacy = join("/pkg", "bin", "deep-filter");
    const deps = depsWithExisting([legacy], "darwin", "arm64");
    expect(resolveBinary("deep-filter", deps)).toBe(legacy);
  });

  it("falls back to the bare name (PATH) when nothing is vendored", () => {
    const deps = depsWithExisting([], "linux", "arm64");
    expect(resolveBinary("ffmpeg", deps)).toBe("ffmpeg");
  });

  it("does not use a suffixed binary built for a different platform/arch", () => {
    // A darwin-arm64 file present, but we're resolving on linux-x64.
    const wrong = join("/pkg", "bin", "deep-filter-darwin-arm64");
    const deps = depsWithExisting([wrong], "linux", "x64");
    expect(resolveBinary("deep-filter", deps)).toBe("deep-filter");
  });

  it("checks suffixed before legacy (order matters)", () => {
    const suffixed = join("/pkg", "bin", "deep-filter-darwin-arm64");
    const legacy = join("/pkg", "bin", "deep-filter");
    const deps = depsWithExisting([suffixed, legacy], "darwin", "arm64");
    // both exist -> suffixed wins
    expect(resolveBinary("deep-filter", deps)).toBe(suffixed);
  });
});
