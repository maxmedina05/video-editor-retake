import { describe, expect, it } from "vitest";
import {
  buildSmartPrompt,
  detectFillerCuts,
  normalizeWord,
  parseSmartResponse,
} from "./fillers.js";
import type { Transcript } from "./types.js";

function tx(words: [string, number, number][]): Transcript {
  return { words: words.map(([text, start, end]) => ({ text, start, end })) };
}

describe("normalizeWord", () => {
  it("lowercases and strips surrounding punctuation", () => {
    expect(normalizeWord("Um,")).toBe("um");
    expect(normalizeWord("...Uh?")).toBe("uh");
    expect(normalizeWord("don't")).toBe("don't");
  });
});

describe("detectFillerCuts", () => {
  it("detects filler words with punctuation", () => {
    const t = tx([
      ["So", 0, 0.3],
      ["um,", 0.3, 0.6],
      ["yeah", 0.6, 1],
    ]);
    const cuts = detectFillerCuts(t);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ start: 0.3, end: 0.6, reason: "filler" });
  });

  it("cuts the earlier of a repeated word, keeps the last", () => {
    const t = tx([
      ["the", 0, 0.2],
      ["the", 0.2, 0.4],
      ["cat", 0.4, 0.7],
    ]);
    const cuts = detectFillerCuts(t);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ start: 0, end: 0.2, reason: "false-start" });
  });

  it("cuts first two of a triple stutter", () => {
    const t = tx([
      ["so", 0, 0.2],
      ["so", 0.2, 0.4],
      ["so", 0.4, 0.6],
      ["then", 0.6, 0.9],
    ]);
    const cuts = detectFillerCuts(t);
    expect(cuts.map((c) => c.start)).toEqual([0, 0.2]);
  });

  it("respects a custom filler list", () => {
    const t = tx([["like", 0, 0.3]]);
    expect(detectFillerCuts(t)).toHaveLength(0);
    expect(detectFillerCuts(t, { fillerWords: ["like"] })).toHaveLength(1);
  });

  it("returns nothing for an empty transcript", () => {
    expect(detectFillerCuts(tx([]))).toEqual([]);
  });
});

describe("parseSmartResponse", () => {
  const t = tx([
    ["I", 0, 0.2],
    ["think", 0.2, 0.5],
    ["um", 0.5, 0.7],
    ["maybe", 0.7, 1],
  ]);

  it("maps word-index ranges to spans", () => {
    const cuts = parseSmartResponse('[{"startWord":2,"endWord":2,"reason":"filler"}]', t);
    expect(cuts).toEqual([{ start: 0.5, end: 0.7, reason: "filler", snippet: "um" }]);
  });

  it("tolerates surrounding prose/code fences", () => {
    const resp = "Sure!\n```json\n[{\"startWord\":0,\"endWord\":1,\"reason\":\"ramble\"}]\n```";
    const cuts = parseSmartResponse(resp, t);
    expect(cuts[0]).toMatchObject({ start: 0, end: 0.5, reason: "ramble", snippet: "I think" });
  });

  it("drops out-of-range or reversed ranges", () => {
    const cuts = parseSmartResponse('[{"startWord":3,"endWord":99},{"startWord":2,"endWord":1}]', t);
    expect(cuts).toEqual([]);
  });

  it("throws when no array present (caller falls back)", () => {
    expect(() => parseSmartResponse("nope", t)).toThrow();
  });
});

describe("buildSmartPrompt", () => {
  it("numbers words and asks for JSON only", () => {
    const p = buildSmartPrompt(tx([["hi", 0, 1]]));
    expect(p).toContain("0: hi");
    expect(p).toContain("JSON array");
  });
});
