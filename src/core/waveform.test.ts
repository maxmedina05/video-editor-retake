import { describe, expect, it } from "vitest";
import { computePeaks } from "./waveform.js";

describe("computePeaks", () => {
  it("returns all zeros for empty input", () => {
    expect(computePeaks([], 4)).toEqual([0, 0, 0, 0]);
  });

  it("returns the requested number of buckets", () => {
    const samples = new Array(1000).fill(100);
    expect(computePeaks(samples, 7)).toHaveLength(7);
    expect(computePeaks(samples, 1)).toHaveLength(1);
  });

  it("takes the max |amplitude| per bucket and normalizes the loudest to 1", () => {
    // 4 buckets of 2 samples; bucket peaks (pre-scale): 200, 400, 100, 800.
    const samples = [200, -100, 400, 0, -100, 50, 800, -800];
    const peaks = computePeaks(samples, 4);
    expect(peaks).toEqual([0.25, 0.5, 0.125, 1]);
  });

  it("without normalization scales against full 16-bit range", () => {
    const samples = [16384, -16384]; // half amplitude
    const peaks = computePeaks(samples, 1, { normalize: false });
    expect(peaks).toEqual([0.5]);
  });

  it("silence stays flat (zero) even when normalizing", () => {
    // Loud speech in the first half, dead silence in the second.
    const samples = [...new Array<number>(100).fill(30000), ...new Array<number>(100).fill(0)];
    const peaks = computePeaks(samples, 4);
    expect(peaks[0]).toBe(1);
    expect(peaks[1]).toBe(1);
    expect(peaks[2]).toBe(0);
    expect(peaks[3]).toBe(0);
  });

  it("handles fewer samples than buckets (repeats/zero-fills sensibly)", () => {
    const peaks = computePeaks([32768], 4);
    // one sample, spread across buckets by index math; every bucket sees it or 0
    expect(peaks).toHaveLength(4);
    expect(Math.max(...peaks)).toBe(1);
    for (const p of peaks) expect(p === 0 || p === 1).toBe(true);
  });

  it("an all-zero signal does not divide by zero", () => {
    expect(computePeaks(new Array(100).fill(0), 5)).toEqual([0, 0, 0, 0, 0]);
  });
});
