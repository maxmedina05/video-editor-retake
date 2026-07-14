import { describe, expect, it } from "vitest";
import {
  classifyGap,
  frozenOverlapFraction,
  parseFreezeDetect,
} from "./activity.js";

describe("parseFreezeDetect", () => {
  it("pairs freeze_start/freeze_end lines, ignoring interleaved duration/logs", () => {
    const stderr = [
      "frame=  100 fps= 30 q=-0.0 size=N/A time=00:00:03.33",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 43.423",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 56.466667",
      "frame=  200 fps= 30",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 99.889667",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 103.089667",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 20.633333",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 123.723",
    ].join("\n");
    expect(parseFreezeDetect(stderr)).toEqual([
      { start: 43.423, end: 99.889667 },
      { start: 103.089667, end: 123.723 },
    ]);
  });

  it("returns empty when there are no freezes", () => {
    const stderr = ["frame=  100 fps= 30", "frame=  200 fps= 30", "[out#0] video:0kB"].join("\n");
    expect(parseFreezeDetect(stderr)).toEqual([]);
  });

  it("closes a freeze left open at EOF at the given duration", () => {
    const stderr = [
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 300.0",
      "[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 40.0",
    ].join("\n");
    expect(parseFreezeDetect(stderr, 342.5)).toEqual([{ start: 300, end: 342.5 }]);
  });

  it("drops a trailing open freeze when no duration is provided", () => {
    const stderr = "[freezedetect] lavfi.freezedetect.freeze_start: 300.0";
    expect(parseFreezeDetect(stderr)).toEqual([]);
  });
});

describe("frozenOverlapFraction", () => {
  const frozen = [
    { start: 100, end: 200 },
    { start: 250, end: 260 },
  ];

  it("is 1 when the gap is fully inside a frozen span", () => {
    expect(frozenOverlapFraction({ start: 120, end: 180 }, frozen)).toBe(1);
  });

  it("is 0 when the gap does not touch any frozen span", () => {
    expect(frozenOverlapFraction({ start: 205, end: 245 }, frozen)).toBe(0);
  });

  it("returns the covered fraction for partial overlap", () => {
    // gap 190..210 (20s): 190..200 frozen (10s) => 0.5
    expect(frozenOverlapFraction({ start: 190, end: 210 }, frozen)).toBeCloseTo(0.5, 5);
  });

  it("sums coverage across multiple frozen spans", () => {
    // gap 150..255 (105s): 150..200 (50) + 250..255 (5) = 55 => ~0.5238
    expect(frozenOverlapFraction({ start: 150, end: 255 }, frozen)).toBeCloseTo(55 / 105, 5);
  });
});

describe("classifyGap", () => {
  const frozen = [{ start: 0, end: 100 }];

  it("labels a mostly-frozen gap static", () => {
    expect(classifyGap({ start: 10, end: 90 }, frozen)).toBe("static");
  });

  it("labels a mostly-moving gap active", () => {
    // 80..120 (40s): 80..100 frozen (20s) => 0.5 < 0.7
    expect(classifyGap({ start: 80, end: 120 }, frozen)).toBe("active");
  });

  it("respects a custom threshold", () => {
    expect(classifyGap({ start: 80, end: 120 }, frozen, 0.4)).toBe("static");
  });
});
