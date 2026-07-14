import { describe, expect, it } from "vitest";
import {
  absorbShortKeeps,
  buildCutList,
  keepComplement,
  mergeCuts,
  planFromCuts,
  removeCutsByIndex,
  snapToWordBoundaries,
} from "./cutlist.js";
import type { Cut, Word } from "./types.js";

const words: Word[] = [
  { text: "a", start: 0, end: 0.5 },
  { text: "b", start: 0.5, end: 1.0 },
  { text: "c", start: 1.0, end: 1.5 },
];

describe("snapToWordBoundaries", () => {
  it("expands a partial overlap to whole words", () => {
    expect(snapToWordBoundaries({ start: 0.3, end: 0.7 }, words)).toEqual({ start: 0, end: 1.0 });
  });
  it("leaves a gap between words untouched", () => {
    const only = [{ text: "x", start: 0, end: 0.5 }];
    expect(snapToWordBoundaries({ start: 1, end: 2 }, only)).toEqual({ start: 1, end: 2 });
  });
});

describe("mergeCuts", () => {
  it("merges overlapping cuts and prefers content reason over silence", () => {
    const cuts: Cut[] = [
      { start: 0, end: 2, reason: "silence" },
      { start: 1.5, end: 3, reason: "filler", snippet: "um" },
    ];
    const merged = mergeCuts(cuts, 0.05);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ start: 0, end: 3, reason: "filler" });
  });

  it("merges cuts separated by a sub-threshold gap", () => {
    const cuts: Cut[] = [
      { start: 0, end: 1, reason: "silence" },
      { start: 1.03, end: 2, reason: "silence" },
    ];
    expect(mergeCuts(cuts, 0.05)).toEqual([{ start: 0, end: 2, reason: "silence" }]);
  });

  it("keeps cuts separated by a large gap", () => {
    const cuts: Cut[] = [
      { start: 0, end: 1, reason: "silence" },
      { start: 5, end: 6, reason: "silence" },
    ];
    expect(mergeCuts(cuts, 0.05)).toHaveLength(2);
  });

  it("sorts unsorted input", () => {
    const cuts: Cut[] = [
      { start: 5, end: 6, reason: "silence" },
      { start: 0, end: 1, reason: "silence" },
    ];
    expect(mergeCuts(cuts, 0).map((c) => c.start)).toEqual([0, 5]);
  });
});

describe("keepComplement", () => {
  it("computes the complement over [0,duration]", () => {
    const cuts: Cut[] = [
      { start: 1, end: 2, reason: "silence" },
      { start: 4, end: 5, reason: "silence" },
    ];
    expect(keepComplement(cuts, 6)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 4 },
      { start: 5, end: 6 },
    ]);
  });

  it("handles a cut at the very start", () => {
    expect(keepComplement([{ start: 0, end: 2, reason: "silence" }], 5)).toEqual([
      { start: 2, end: 5 },
    ]);
  });

  it("handles a cut at the very end", () => {
    expect(keepComplement([{ start: 3, end: 5, reason: "silence" }], 5)).toEqual([
      { start: 0, end: 3 },
    ]);
  });

  it("returns empty keep when a cut covers everything", () => {
    expect(keepComplement([{ start: 0, end: 5, reason: "silence" }], 5)).toEqual([]);
  });
});

describe("absorbShortKeeps", () => {
  it("merges cuts across a keep-sliver shorter than minKeep", () => {
    const cuts: Cut[] = [
      { start: 1, end: 2, reason: "silence" },
      { start: 2.2, end: 3, reason: "filler", snippet: "um" },
    ];
    // keep between them is 0.2 < 0.4 -> absorb, prefer content reason
    expect(absorbShortKeeps(cuts, 10, 0.4)).toEqual([
      { start: 1, end: 3, reason: "filler", snippet: "um" },
    ]);
  });

  it("preserves a keep-segment at least minKeep long", () => {
    const cuts: Cut[] = [
      { start: 1, end: 2, reason: "silence" },
      { start: 2.5, end: 3, reason: "silence" },
    ];
    expect(absorbShortKeeps(cuts, 10, 0.4)).toHaveLength(2);
  });

  it("absorbs a leading sliver by extending the first cut to 0", () => {
    const cuts: Cut[] = [{ start: 0.1, end: 2, reason: "silence" }];
    expect(absorbShortKeeps(cuts, 10, 0.4)).toEqual([{ start: 0, end: 2, reason: "silence" }]);
  });

  it("absorbs a trailing sliver by extending the last cut to duration", () => {
    const cuts: Cut[] = [{ start: 2, end: 9.8, reason: "silence" }];
    expect(absorbShortKeeps(cuts, 10, 0.4)).toEqual([{ start: 2, end: 10, reason: "silence" }]);
  });

  it("is a no-op when minKeep is 0", () => {
    const cuts: Cut[] = [
      { start: 1, end: 2, reason: "silence" },
      { start: 2.1, end: 3, reason: "silence" },
    ];
    expect(absorbShortKeeps(cuts, 10, 0)).toHaveLength(2);
  });
});

describe("buildCutList — max-pause silence shortening", () => {
  it("shortens a silence to leave maxPause of pause, centred", () => {
    const plan = buildCutList({
      sourceDuration: 60,
      words: [],
      silenceGaps: [{ start: 10, end: 55 }], // 45s quiet stretch
      fillerCuts: [],
      maxPause: 0.75,
      padding: 0.15,
      minKeep: 0.4,
    });
    // keepPause = max(0.75, 0.3) = 0.75; half = 0.375 each side
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]!.start).toBeCloseTo(10.375, 5);
    expect(plan.cuts[0]!.end).toBeCloseTo(54.625, 5);
    // 45s gap - 0.75 kept = 44.25s removed (not the whole 45s)
    expect(plan.removedDuration).toBeCloseTo(44.25, 5);
  });

  it("skips a gap no longer than maxPause", () => {
    const plan = buildCutList({
      sourceDuration: 10,
      words: [],
      silenceGaps: [{ start: 2, end: 2.7 }], // 0.7s <= 0.75
      fillerCuts: [],
      maxPause: 0.75,
      minKeep: 0.4,
    });
    expect(plan.cuts).toEqual([]);
    expect(plan.keep).toEqual([{ start: 0, end: 10 }]);
  });

  it("padding acts as a per-side floor when 2*padding > maxPause", () => {
    const plan = buildCutList({
      sourceDuration: 20,
      words: [],
      silenceGaps: [{ start: 2, end: 12 }],
      fillerCuts: [],
      maxPause: 0.5,
      padding: 0.5, // 2*padding = 1.0 > 0.5 -> keepPause = 1.0
      minKeep: 0.4,
    });
    expect(plan.cuts[0]!.start).toBeCloseTo(2.5, 5);
    expect(plan.cuts[0]!.end).toBeCloseTo(11.5, 5);
  });
});

describe("buildCutList — maxCutPerSilence (per-gap removal cap)", () => {
  it("caps a long silence to lose at most the cap, centred", () => {
    const plan = buildCutList({
      sourceDuration: 60,
      words: [],
      silenceGaps: [{ start: 10, end: 55 }], // 45s gap
      fillerCuts: [],
      maxPause: 0.75,
      padding: 0.15,
      minKeep: 0.4,
      maxCutPerSilence: 2.5,
    });
    // keepPause 0.75; uncapped would remove 44.25, cap binds -> remove 2.5.
    expect(plan.cuts).toHaveLength(1);
    expect(plan.removedDuration).toBeCloseTo(2.5, 5);
    // centred: (45 - 2.5)/2 = 21.25 kept each side
    expect(plan.cuts[0]!.start).toBeCloseTo(31.25, 5);
    expect(plan.cuts[0]!.end).toBeCloseTo(33.75, 5);
  });

  it("does not bind when gap - keepPause <= cap (removes the full excess)", () => {
    const plan = buildCutList({
      sourceDuration: 60,
      words: [],
      silenceGaps: [{ start: 10, end: 13 }], // 3s gap, excess 2.25 < cap 2.5
      fillerCuts: [],
      maxPause: 0.75,
      padding: 0.15,
      minKeep: 0.4,
      maxCutPerSilence: 2.5,
    });
    // uncapped behaviour: remove 3 - 0.75 = 2.25, leaving maxPause centred
    expect(plan.removedDuration).toBeCloseTo(2.25, 5);
    expect(plan.cuts[0]!.start).toBeCloseTo(10.375, 5);
    expect(plan.cuts[0]!.end).toBeCloseTo(12.625, 5);
  });

  it("cap binds regardless of a larger max-pause (keepPause floors the pause kept)", () => {
    const plan = buildCutList({
      sourceDuration: 60,
      words: [],
      silenceGaps: [{ start: 10, end: 55 }], // 45s gap
      fillerCuts: [],
      maxPause: 1.5, // bigger pause; excess 43.5 still >> cap
      padding: 0.15,
      minKeep: 0.4,
      maxCutPerSilence: 2.5,
    });
    expect(plan.removedDuration).toBeCloseTo(2.5, 5);
    // pause kept = 45 - 2.5 = 42.5 (way above maxPause) — long static silence barely touched
    expect(plan.cuts[0]!.start).toBeCloseTo(31.25, 5);
    expect(plan.cuts[0]!.end).toBeCloseTo(33.75, 5);
  });

  it("respects the padding floor on keepPause under the cap", () => {
    const plan = buildCutList({
      sourceDuration: 20,
      words: [],
      silenceGaps: [{ start: 2, end: 12 }], // 10s gap
      fillerCuts: [],
      maxPause: 0.5,
      padding: 0.5, // 2*padding = 1.0 > maxPause -> keepPause 1.0
      minKeep: 0.4,
      maxCutPerSilence: 3,
    });
    // excess 9 > cap 3 -> remove 3, centred: (10 - 3)/2 = 3.5 kept each side
    expect(plan.removedDuration).toBeCloseTo(3, 5);
    expect(plan.cuts[0]!.start).toBeCloseTo(5.5, 5);
    expect(plan.cuts[0]!.end).toBeCloseTo(8.5, 5);
  });

  it("is uncapped when maxCutPerSilence is 0 or omitted", () => {
    const capped = buildCutList({
      sourceDuration: 60,
      words: [],
      silenceGaps: [{ start: 10, end: 55 }],
      fillerCuts: [],
      maxPause: 0.75,
      padding: 0.15,
      minKeep: 0.4,
      maxCutPerSilence: 0,
    });
    const omitted = buildCutList({
      sourceDuration: 60,
      words: [],
      silenceGaps: [{ start: 10, end: 55 }],
      fillerCuts: [],
      maxPause: 0.75,
      padding: 0.15,
      minKeep: 0.4,
    });
    expect(capped.removedDuration).toBeCloseTo(44.25, 5);
    expect(omitted.removedDuration).toBeCloseTo(44.25, 5);
  });

  it("caps an active silence too when it is shortened (balanced-style)", () => {
    const plan = buildCutList({
      sourceDuration: 300,
      words: [],
      silenceGaps: [{ start: 210, end: 260 }], // 50s active gap (not frozen)
      fillerCuts: [],
      frozenSpans: [{ start: 100, end: 200 }],
      activity: { aware: true, cutActive: true, activeMaxPause: 2.0, activeMinGap: 4.0 },
      maxPause: 0.75,
      padding: 0.15,
      minKeep: 0.4,
      maxCutPerSilence: 5,
    });
    // active keepPause 2.0; uncapped would remove 48, cap binds -> 5
    expect(plan.cuts[0]!.activity).toBe("active");
    expect(plan.removedDuration).toBeCloseTo(5, 5);
  });
});

describe("buildCutList", () => {
  it("snaps filler cuts to word boundaries and merges with silence", () => {
    const plan = buildCutList({
      sourceDuration: 3,
      words,
      silenceGaps: [],
      fillerCuts: [{ start: 0.4, end: 0.6, reason: "filler", snippet: "a b" }],
      padding: 0.15,
    });
    // filler 0.4-0.6 overlaps words a(0-0.5) and b(0.5-1) -> snaps to 0-1
    expect(plan.cuts[0]).toMatchObject({ start: 0, end: 1, reason: "filler" });
  });

  it("clamps cuts to [0,duration]", () => {
    const plan = buildCutList({
      sourceDuration: 5,
      words: [],
      silenceGaps: [{ start: -1, end: 10 }],
      fillerCuts: [],
      padding: 0,
      maxPause: 0,
    });
    expect(plan.cuts).toEqual([{ start: 0, end: 5, reason: "silence" }]);
    expect(plan.keep).toEqual([]);
  });

  it("absorbs a filler-created sliver next to a silence cut (anti-flicker)", () => {
    // silence 0-5, then a 0.1s keep, then filler word 5.1-5.4 -> sliver absorbed
    const plan = buildCutList({
      sourceDuration: 10,
      words: [{ text: "um", start: 5.1, end: 5.4 }],
      silenceGaps: [{ start: 0, end: 5 }],
      fillerCuts: [{ start: 5.1, end: 5.4, reason: "filler", snippet: "um" }],
      maxPause: 0,
      padding: 0,
      minKeep: 0.4,
    });
    // no kept segment shorter than minKeep
    for (const k of plan.keep) expect(k.end - k.start).toBeGreaterThanOrEqual(0.4);
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]).toMatchObject({ start: 0, end: 5.4 });
  });

  it("handles empty everything", () => {
    const plan = buildCutList({
      sourceDuration: 8,
      words: [],
      silenceGaps: [],
      fillerCuts: [],
    });
    expect(plan.keep).toEqual([{ start: 0, end: 8 }]);
    expect(plan.removedDuration).toBe(0);
  });
});

describe("removeCutsByIndex / planFromCuts", () => {
  it("removing a cut returns it to the kept timeline", () => {
    const cuts: Cut[] = [
      { start: 1, end: 2, reason: "silence" },
      { start: 4, end: 5, reason: "filler" },
    ];
    const plan = removeCutsByIndex(cuts, [0], 6);
    expect(plan.cuts).toEqual([{ start: 4, end: 5, reason: "filler" }]);
    expect(plan.keep).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 6 },
    ]);
  });

  it("planFromCuts merges overlaps defensively", () => {
    const cuts: Cut[] = [
      { start: 0, end: 3, reason: "silence" },
      { start: 2, end: 4, reason: "silence" },
    ];
    expect(planFromCuts(cuts, 10).cuts).toEqual([{ start: 0, end: 4, reason: "silence" }]);
  });
});

describe("buildCutList — activity-aware silence handling", () => {
  const frozenSpans = [{ start: 100, end: 200 }]; // static video 100..200

  it("exempts an active silence when cutActive is false (conservative)", () => {
    const plan = buildCutList({
      sourceDuration: 300,
      words: [],
      // gap 210..260 sits over NON-frozen video => active
      silenceGaps: [{ start: 210, end: 260 }],
      fillerCuts: [],
      frozenSpans,
      activity: { aware: true, cutActive: false, activeMaxPause: 0, activeMinGap: 0 },
      maxPause: 1.5,
      minKeep: 0.4,
    });
    expect(plan.cuts).toEqual([]);
    expect(plan.stats.silenceGaps).toMatchObject({ total: 1, shortened: 0, activeExempt: 1 });
  });

  it("still shortens a static silence in the same mode", () => {
    const plan = buildCutList({
      sourceDuration: 300,
      words: [],
      silenceGaps: [{ start: 110, end: 190 }], // inside frozen span => static
      fillerCuts: [],
      frozenSpans,
      activity: { aware: true, cutActive: false, activeMaxPause: 0, activeMinGap: 0 },
      maxPause: 1.5,
      minKeep: 0.4,
    });
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]!.reason).toBe("silence");
    expect(plan.cuts[0]!.activity).toBe("static");
  });

  it("shortens a long active silence gently (balanced: bigger pause, min gap)", () => {
    const plan = buildCutList({
      sourceDuration: 300,
      words: [],
      silenceGaps: [{ start: 210, end: 260 }], // 50s active gap
      fillerCuts: [],
      frozenSpans,
      activity: { aware: true, cutActive: true, activeMaxPause: 2.0, activeMinGap: 4.0 },
      maxPause: 0.75,
      padding: 0.15,
      minKeep: 0.4,
    });
    // active pause = max(2.0, 0.3) = 2.0 => 50 - 2 = 48 removed
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]!.activity).toBe("active");
    expect(plan.removedDuration).toBeCloseTo(48, 1);
  });

  it("leaves a short active silence alone (below activeMinGap)", () => {
    const plan = buildCutList({
      sourceDuration: 300,
      words: [],
      silenceGaps: [{ start: 210, end: 213 }], // 3s active gap < 4s
      fillerCuts: [],
      frozenSpans,
      activity: { aware: true, cutActive: true, activeMaxPause: 2.0, activeMinGap: 4.0 },
      maxPause: 0.75,
      minKeep: 0.4,
    });
    expect(plan.cuts).toEqual([]);
    expect(plan.stats.silenceGaps).toMatchObject({ activeExempt: 1 });
  });

  it("ignores activity entirely when aware is false (aggressive)", () => {
    const plan = buildCutList({
      sourceDuration: 300,
      words: [],
      silenceGaps: [{ start: 210, end: 260 }], // active video, but ignored
      fillerCuts: [],
      frozenSpans,
      activity: { aware: false, cutActive: true, activeMaxPause: 0, activeMinGap: 0 },
      maxPause: 0.5,
      minKeep: 0.4,
    });
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]!.activity).toBeUndefined();
  });
});

describe("buildCutList — honest stats", () => {
  it("splits removed seconds into deleted vs silence-shortened", () => {
    const plan = buildCutList({
      sourceDuration: 100,
      words: [],
      silenceGaps: [{ start: 10, end: 30 }], // 20s => 20 - 0.75 = 19.25 shortened
      fillerCuts: [{ start: 50, end: 52, reason: "filler" }], // 2s deleted
      maxPause: 0.75,
      padding: 0.15,
      minKeep: 0.4,
    });
    expect(plan.stats.silenceShortenedSeconds).toBeCloseTo(19.25, 2);
    expect(plan.stats.deletedSeconds).toBeCloseTo(2, 2);
  });

  it("counts detected silences as shortened vs untouched", () => {
    const plan = buildCutList({
      sourceDuration: 100,
      words: [],
      silenceGaps: [
        { start: 10, end: 30 }, // shortened
        { start: 40, end: 40.5 }, // too short => untouched
      ],
      fillerCuts: [],
      maxPause: 0.75,
      minKeep: 0.4,
    });
    expect(plan.stats.silenceGaps).toMatchObject({ total: 2, shortened: 1, untouched: 1 });
  });
});
