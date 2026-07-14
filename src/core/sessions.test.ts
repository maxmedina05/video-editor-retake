import { describe, expect, it } from "vitest";
import { createSessionRegistry } from "./sessions.js";
import type { MediaInfo } from "./types.js";

const info: MediaInfo = { duration: 12, hasVideo: true, hasAudio: true };

describe("createSessionRegistry", () => {
  it("creates sessions with unique ids and stores path + mediaInfo", () => {
    let n = 0;
    const reg = createSessionRegistry(() => `id-${++n}`);
    const a = reg.create("/a.mp4", info);
    const b = reg.create("/b.mp4", info);
    expect(a).toEqual({ id: "id-1", path: "/a.mp4", mediaInfo: info });
    expect(b.id).toBe("id-2");
    expect(reg.list()).toHaveLength(2);
  });

  it("looks up by id and reports membership", () => {
    const reg = createSessionRegistry(() => "fixed");
    const s = reg.create("/a.mp4", info);
    expect(reg.get("fixed")).toBe(s);
    expect(reg.has("fixed")).toBe(true);
  });

  it("returns undefined and false for unknown/forged ids", () => {
    const reg = createSessionRegistry();
    expect(reg.get("nope")).toBeUndefined();
    expect(reg.has("nope")).toBe(false);
  });

  it("removes sessions", () => {
    const reg = createSessionRegistry(() => "x");
    reg.create("/a.mp4", info);
    expect(reg.remove("x")).toBe(true);
    expect(reg.has("x")).toBe(false);
    expect(reg.remove("x")).toBe(false);
  });
});
