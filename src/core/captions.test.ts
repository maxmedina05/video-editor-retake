import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  generateCaptions,
  groupCues,
  mapTime,
  remapWords,
  toSRT,
  toVTT,
  withOffsets,
} from "./captions.js";
import type { KeepSegment, Word } from "./types.js";

const keep: KeepSegment[] = [
  { start: 0, end: 2 },
  { start: 5, end: 8 },
];

describe("mapTime", () => {
  const ko = withOffsets(keep);
  it("maps times inside the first kept segment unchanged", () => {
    expect(mapTime(1, ko)).toBeCloseTo(1, 5);
  });
  it("shifts times in the second segment by removed time", () => {
    // segment 2 starts at output offset 2 (length of first keep); t=6 -> 2 + (6-5) = 3
    expect(mapTime(6, ko)).toBeCloseTo(3, 5);
  });
  it("returns null inside a cut", () => {
    expect(mapTime(3.5, ko)).toBeNull();
  });
});

describe("remapWords", () => {
  it("drops words inside cuts and shifts kept words", () => {
    const words: Word[] = [
      { text: "keep1", start: 0.5, end: 1 },
      { text: "cut", start: 3, end: 4 }, // inside the removed 2-5 span
      { text: "keep2", start: 6, end: 6.5 },
    ];
    const out = remapWords(words, keep);
    expect(out.map((w) => w.text)).toEqual(["keep1", "keep2"]);
    expect(out[1]!.start).toBeCloseTo(3, 5); // 2 + (6-5)
    expect(out[1]!.end).toBeCloseTo(3.5, 5);
  });

  it("clips a word straddling a cut boundary", () => {
    const words: Word[] = [{ text: "straddle", start: 1.5, end: 3 }];
    const out = remapWords(words, keep);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBeCloseTo(1.5, 5);
    expect(out[0]!.end).toBeCloseTo(2, 5); // clipped to end of first keep
  });
});

describe("groupCues", () => {
  it("splits on large gaps", () => {
    const words: Word[] = [
      { text: "hello", start: 0, end: 0.4 },
      { text: "there", start: 0.5, end: 0.9 },
      { text: "again", start: 5, end: 5.4 },
    ];
    const cues = groupCues(words, { maxGap: 0.6 });
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe("hello there");
    expect(cues[1]!.text).toBe("again");
  });

  it("splits when exceeding maxChars", () => {
    const words: Word[] = Array.from({ length: 10 }, (_, i) => ({
      text: "word",
      start: i * 0.3,
      end: i * 0.3 + 0.2,
    }));
    const cues = groupCues(words, { maxChars: 14, maxGap: 5 });
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(14);
  });

  it("returns nothing for empty input", () => {
    expect(groupCues([])).toEqual([]);
  });
});

describe("formatTimestamp", () => {
  it("formats SRT (comma) and VTT (dot)", () => {
    expect(formatTimestamp(3661.5, ",")).toBe("01:01:01,500");
    expect(formatTimestamp(3661.5, ".")).toBe("01:01:01.500");
  });
  it("clamps negatives to zero", () => {
    expect(formatTimestamp(-1, ",")).toBe("00:00:00,000");
  });
});

describe("toSRT / toVTT", () => {
  const cues = [
    { index: 1, start: 0, end: 1.5, text: "hello" },
    { index: 2, start: 1.5, end: 3, text: "world" },
  ];
  it("renders SRT blocks", () => {
    expect(toSRT(cues)).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nhello\n\n2\n00:00:01,500 --> 00:00:03,000\nworld\n",
    );
  });
  it("renders a VTT header and cues", () => {
    const vtt = toVTT(cues);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.500\nhello");
  });
  it("empty cues -> just the WEBVTT header", () => {
    expect(toVTT([])).toBe("WEBVTT\n\n");
    expect(toSRT([])).toBe("");
  });
});

describe("generateCaptions (integration of remap + group + format)", () => {
  it("produces captions on the output timeline", () => {
    const words: Word[] = [
      { text: "before", start: 1, end: 1.5 },
      { text: "cut", start: 3, end: 4 },
      { text: "after", start: 6, end: 6.5 },
    ];
    const { cues, srt } = generateCaptions(words, keep, { maxGap: 5, maxChars: 100 });
    expect(cues).toHaveLength(1);
    // "before" at 1-1.5 and "after" remapped to 3-3.5 -> one cue 1..3.5
    expect(cues[0]!.text).toBe("before after");
    expect(srt).toContain("00:00:01,000 --> 00:00:03,500");
  });
});
