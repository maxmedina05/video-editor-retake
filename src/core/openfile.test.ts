import { describe, expect, it } from "vitest";
import { validateVideoPath, type ValidateDeps } from "./openfile.js";
import type { MediaInfo } from "./types.js";

const okInfo: MediaInfo = { duration: 10, hasVideo: true, hasAudio: true };

const deps = (over: Partial<ValidateDeps> = {}): ValidateDeps => ({
  stat: async () => ({ isFile: () => true }),
  probe: async () => okInfo,
  ...over,
});

describe("validateVideoPath", () => {
  it("rejects a relative path without touching fs/ffprobe", async () => {
    let touched = false;
    const res = await validateVideoPath(
      "relative/path.mp4",
      deps({
        stat: async () => {
          touched = true;
          return { isFile: () => true };
        },
      }),
    );
    expect(res).toEqual({ ok: false, error: expect.stringContaining("absolute") });
    expect(touched).toBe(false);
  });

  it("rejects a missing file (stat throws)", async () => {
    const res = await validateVideoPath(
      "/missing.mp4",
      deps({
        stat: async () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(res).toEqual({ ok: false, error: expect.stringContaining("file not found") });
  });

  it("rejects a directory / non-regular file", async () => {
    const res = await validateVideoPath("/somedir", deps({ stat: async () => ({ isFile: () => false }) }));
    expect(res).toEqual({ ok: false, error: expect.stringContaining("not a regular file") });
  });

  it("rejects when ffprobe fails", async () => {
    const res = await validateVideoPath(
      "/notvideo.txt",
      deps({
        probe: async () => {
          throw new Error("Invalid data found");
        },
      }),
    );
    expect(res).toEqual({ ok: false, error: expect.stringContaining("ffprobe failed") });
  });

  it("rejects a file with neither audio nor video", async () => {
    const res = await validateVideoPath(
      "/empty.bin",
      deps({ probe: async () => ({ duration: 0, hasVideo: false, hasAudio: false }) }),
    );
    expect(res).toEqual({ ok: false, error: expect.stringContaining("no audio or video") });
  });

  it("accepts a valid video and returns its MediaInfo", async () => {
    const res = await validateVideoPath("/good.mp4", deps());
    expect(res).toEqual({ ok: true, info: okInfo });
  });
});
