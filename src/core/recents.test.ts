import { describe, expect, it } from "vitest";
import {
  parseRecents,
  recentsDir,
  removeRecentByPath,
  upsertRecent,
  type RecentEntry,
} from "./recents.js";

const entry = (path: string, lastOpened = 0): RecentEntry => ({
  path,
  name: path.split("/").pop()!,
  duration: 10,
  lastOpened,
});

describe("upsertRecent", () => {
  it("prepends a new entry", () => {
    const list = [entry("/a.mp4")];
    const out = upsertRecent(list, entry("/b.mp4"));
    expect(out.map((e) => e.path)).toEqual(["/b.mp4", "/a.mp4"]);
  });

  it("de-duplicates by path and moves the entry to the front", () => {
    const list = [entry("/a.mp4"), entry("/b.mp4"), entry("/c.mp4")];
    const out = upsertRecent(list, entry("/b.mp4", 99));
    expect(out.map((e) => e.path)).toEqual(["/b.mp4", "/a.mp4", "/c.mp4"]);
    expect(out[0]!.lastOpened).toBe(99); // updated metadata wins
  });

  it("caps the list length, dropping the oldest", () => {
    const list = Array.from({ length: 15 }, (_, i) => entry(`/f${i}.mp4`));
    const out = upsertRecent(list, entry("/new.mp4"), 15);
    expect(out).toHaveLength(15);
    expect(out[0]!.path).toBe("/new.mp4");
    expect(out.some((e) => e.path === "/f14.mp4")).toBe(false); // oldest dropped
  });

  it("does not mutate the input list", () => {
    const list = [entry("/a.mp4")];
    upsertRecent(list, entry("/b.mp4"));
    expect(list.map((e) => e.path)).toEqual(["/a.mp4"]);
  });
});

describe("removeRecentByPath", () => {
  it("removes a matching entry", () => {
    const list = [entry("/a.mp4"), entry("/b.mp4")];
    expect(removeRecentByPath(list, "/a.mp4").map((e) => e.path)).toEqual(["/b.mp4"]);
  });

  it("is a no-op when the path is absent", () => {
    const list = [entry("/a.mp4")];
    expect(removeRecentByPath(list, "/missing.mp4")).toHaveLength(1);
  });
});

describe("parseRecents", () => {
  it("returns [] for invalid JSON or non-arrays", () => {
    expect(parseRecents("not json")).toEqual([]);
    expect(parseRecents('{"a":1}')).toEqual([]);
  });

  it("drops malformed entries and fills defaults", () => {
    const text = JSON.stringify([
      { path: "/good.mp4", name: "good.mp4", duration: 5, lastOpened: 123 },
      { name: "no-path.mp4" },
      { path: "/bare.mp4" },
      42,
    ]);
    const out = parseRecents(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ path: "/good.mp4", name: "good.mp4", duration: 5, lastOpened: 123 });
    expect(out[1]).toEqual({ path: "/bare.mp4", name: "bare.mp4", duration: 0, lastOpened: 0 });
  });
});

describe("recentsDir", () => {
  it("honors XDG_CONFIG_HOME", () => {
    expect(recentsDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/clean-video");
  });

  it("falls back to ~/.config when XDG is empty", () => {
    const dir = recentsDir({ XDG_CONFIG_HOME: "  " });
    expect(dir.endsWith("/.config/clean-video")).toBe(true);
  });
});
