import { describe, expect, it } from "vitest";
import { parseSilenceDetect } from "./silence.js";

describe("parseSilenceDetect", () => {
  it("pairs silence_start/silence_end lines", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 1.5",
      "[silencedetect @ 0x1] silence_end: 3.2 | silence_duration: 1.7",
      "[silencedetect @ 0x1] silence_start: 10.0",
      "[silencedetect @ 0x1] silence_end: 12.0 | silence_duration: 2.0",
    ].join("\n");
    expect(parseSilenceDetect(stderr)).toEqual([
      { start: 1.5, end: 3.2 },
      { start: 10, end: 12 },
    ]);
  });

  it("closes a trailing open silence at duration", () => {
    const stderr = "[silencedetect] silence_start: 55.0";
    expect(parseSilenceDetect(stderr, 60)).toEqual([{ start: 55, end: 60 }]);
  });

  it("ignores a trailing open silence with no duration", () => {
    const stderr = "[silencedetect] silence_start: 55.0";
    expect(parseSilenceDetect(stderr)).toEqual([]);
  });

  it("drops zero/negative spans", () => {
    const stderr = ["silence_start: 5.0", "silence_end: 5.0"].join("\n");
    expect(parseSilenceDetect(stderr)).toEqual([]);
  });

  it("returns empty for no matches", () => {
    expect(parseSilenceDetect("frame= 100 fps=25")).toEqual([]);
  });
});
