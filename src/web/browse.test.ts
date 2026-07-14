import { describe, expect, it } from "vitest";
import { sep } from "node:path";
import {
  browse,
  BrowseError,
  isWithinRoot,
  resolveUnderRoot,
  type BrowseDeps,
} from "./browse.js";

const ROOT = `${sep}media`;

describe("isWithinRoot", () => {
  it("accepts the root itself and descendants", () => {
    expect(isWithinRoot(ROOT, ROOT)).toBe(true);
    expect(isWithinRoot(ROOT, `${ROOT}${sep}a`)).toBe(true);
    expect(isWithinRoot(ROOT, `${ROOT}${sep}a${sep}b`)).toBe(true);
  });
  it("rejects siblings and prefix look-alikes", () => {
    expect(isWithinRoot(ROOT, `${sep}mediaother`)).toBe(false);
    expect(isWithinRoot(ROOT, `${sep}etc`)).toBe(false);
    expect(isWithinRoot(ROOT, `${sep}`)).toBe(false);
  });
});

describe("resolveUnderRoot", () => {
  it("resolves nested relative dirs", () => {
    expect(resolveUnderRoot(ROOT, "")).toBe(ROOT);
    expect(resolveUnderRoot(ROOT, "sub")).toBe(`${ROOT}${sep}sub`);
    expect(resolveUnderRoot(ROOT, `sub${sep}deep`)).toBe(`${ROOT}${sep}sub${sep}deep`);
  });
  it("rejects parent traversal", () => {
    expect(resolveUnderRoot(ROOT, "..")).toBeNull();
    expect(resolveUnderRoot(ROOT, `..${sep}..${sep}etc`)).toBeNull();
    expect(resolveUnderRoot(ROOT, `sub${sep}..${sep}..${sep}etc`)).toBeNull();
  });
  it("rejects absolute paths", () => {
    expect(resolveUnderRoot(ROOT, `${sep}etc${sep}passwd`)).toBeNull();
  });
});

/** Build injectable deps from a virtual tree. `links` maps abs path -> real target. */
function fakeDeps(
  tree: Record<string, { kind: "dir" | "file"; children?: string[] }>,
  links: Record<string, string> = {},
): BrowseDeps {
  const realOf = (p: string): string => links[p] ?? p;
  return {
    realpath: async (p) => {
      const real = realOf(p);
      if (!(real in tree)) throw new Error(`ENOENT: ${p}`);
      return real;
    },
    readdir: async (p) => tree[realOf(p)]?.children ?? [],
    stat: async (p) => {
      const node = tree[realOf(p)];
      if (!node) throw new Error(`ENOENT: ${p}`);
      return { isDirectory: () => node.kind === "dir", isFile: () => node.kind === "file" };
    },
  };
}

describe("browse", () => {
  const tree = {
    [ROOT]: { kind: "dir" as const, children: ["a.mp4", "notes.txt", "sub", ".hidden"] },
    [`${ROOT}${sep}a.mp4`]: { kind: "file" as const },
    [`${ROOT}${sep}notes.txt`]: { kind: "file" as const },
    [`${ROOT}${sep}sub`]: { kind: "dir" as const, children: ["b.mkv"] },
    [`${ROOT}${sep}sub${sep}b.mkv`]: { kind: "file" as const },
    [`${ROOT}${sep}.hidden`]: { kind: "file" as const },
  };

  it("lists dirs first then videos, skipping non-video files and dotfiles", async () => {
    const res = await browse(ROOT, "", fakeDeps(tree));
    expect(res.dir).toBe("");
    expect(res.parent).toBeNull();
    expect(res.entries.map((e) => `${e.kind}:${e.name}`)).toEqual(["dir:sub", "video:a.mp4"]);
  });

  it("navigates into a subdir and reports its parent", async () => {
    const res = await browse(ROOT, "sub", fakeDeps(tree));
    expect(res.dir).toBe("sub");
    expect(res.parent).toBe("");
    expect(res.entries.map((e) => e.name)).toEqual(["b.mkv"]);
  });

  it("rejects traversal and absolute paths", async () => {
    await expect(browse(ROOT, "..", fakeDeps(tree))).rejects.toBeInstanceOf(BrowseError);
    await expect(browse(ROOT, `${sep}etc`, fakeDeps(tree))).rejects.toBeInstanceOf(BrowseError);
  });

  it("skips entries whose symlink target escapes the root", async () => {
    const withLink = {
      ...tree,
      [ROOT]: { kind: "dir" as const, children: ["a.mp4", "escape"] },
      [`${sep}outside`]: { kind: "dir" as const, children: [] },
    };
    // `escape` is a symlink resolving outside the root.
    const deps = fakeDeps(withLink, { [`${ROOT}${sep}escape`]: `${sep}outside` });
    const res = await browse(ROOT, "", deps);
    expect(res.entries.map((e) => e.name)).toEqual(["a.mp4"]);
  });

  it("rejects a requested dir that is a symlink escaping the root", async () => {
    const withLink = {
      [ROOT]: { kind: "dir" as const, children: ["link"] },
      [`${sep}outside`]: { kind: "dir" as const, children: [] },
    };
    const deps = fakeDeps(withLink, { [`${ROOT}${sep}link`]: `${sep}outside` });
    await expect(browse(ROOT, "link", deps)).rejects.toBeInstanceOf(BrowseError);
  });
});
