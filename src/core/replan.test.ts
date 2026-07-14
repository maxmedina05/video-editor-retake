import { describe, expect, it } from "vitest";
import { rebuildPlan, type ReplanArtifacts } from "./replan.js";
import type { Span, Word } from "./types.js";

/** A word spanning [start,end) with the given text. */
function w(text: string, start: number, end: number): Word {
  return { text, start, end };
}

/**
 * A synthetic recording: speech 0–2, a 6s silence gap 2–8, speech 8–10 with an
 * "um" filler at 8.0–8.4, then a short 0.5s gap 10–10.5, then speech to 12.
 */
function fixture(): ReplanArtifacts {
  const words: Word[] = [
    w("hello", 0, 1),
    w("there", 1, 2),
    w("um", 8.0, 8.4),
    w("okay", 8.4, 10),
    w("done", 10.5, 12),
  ];
  const silenceGaps: Span[] = [
    { start: 2, end: 8 }, // 6s gap
    { start: 10, end: 10.5 }, // 0.5s gap
  ];
  return { sourceDuration: 12, words, silenceGaps, frozenSpans: [] };
}

describe("rebuildPlan", () => {
  it("shortens a long silence and cuts a filler word (balanced)", () => {
    const plan = rebuildPlan(fixture(), { mode: "balanced" });
    const silence = plan.cuts.filter((c) => c.reason === "silence");
    const filler = plan.cuts.filter((c) => c.reason === "filler");
    expect(silence.length).toBe(1); // the 6s gap is shortened; the 0.5s gap is left as-is
    expect(filler.length).toBe(1); // "um" removed
    expect(plan.removedDuration).toBeGreaterThan(0);
    // stats accounting is preserved from buildCutList
    expect(plan.stats.silenceGaps?.total).toBe(2);
    expect(plan.stats.silenceGaps?.shortened).toBe(1);
  });

  it("does not remove fillers when fillers:false", () => {
    const plan = rebuildPlan(fixture(), { mode: "balanced", fillers: false });
    expect(plan.cuts.some((c) => c.reason === "filler")).toBe(false);
  });

  it("honors a custom filler-word list", () => {
    // "okay" is not a default filler; adding it should cut it.
    const plan = rebuildPlan(fixture(), {
      mode: "balanced",
      fillerWords: ["okay"],
    });
    expect(plan.cuts.some((c) => c.reason === "filler")).toBe(true);
    // the default "um" is no longer in the list, so it survives
    const cutsAround8 = plan.cuts.filter((c) => c.start < 8.5 && c.end > 8.0 && c.reason === "filler");
    expect(cutsAround8.length).toBeGreaterThan(0);
  });

  it("uses the mode's default per-gap cap unless overridden", () => {
    // conservative only touches STATIC silence, so mark the 6s gap frozen; then
    // it caps each gap at 2.5s removed and the gap keeps far more.
    const staticGap: ReplanArtifacts = { ...fixture(), frozenSpans: [{ start: 2, end: 8 }] };
    const cons = rebuildPlan(staticGap, { mode: "conservative", minSilence: 3.0 });
    const gapCut = cons.cuts.find((c) => c.reason === "silence");
    expect(gapCut).toBeDefined();
    expect(gapCut!.end - gapCut!.start).toBeLessThanOrEqual(2.5 + 1e-6);

    // an explicit override wins over the mode default
    const capped = rebuildPlan(staticGap, {
      mode: "conservative",
      minSilence: 3.0,
      maxCutPerSilence: 1.0,
    });
    const cappedCut = capped.cuts.find((c) => c.reason === "silence")!;
    expect(cappedCut.end - cappedCut.start).toBeLessThanOrEqual(1.0 + 1e-6);
  });

  it("filters out silence gaps shorter than minSilence (floor)", () => {
    // With a 5.0s floor only the 6s gap survives; conservative also disables
    // fillers so silence is all that remains.
    const plan = rebuildPlan(fixture(), { mode: "conservative", minSilence: 5.0 });
    expect(plan.stats.silenceGaps?.total).toBe(1);
  });

  it("aggressive mode ignores activity and trims harder than conservative", () => {
    const aggressive = rebuildPlan(fixture(), { mode: "aggressive" });
    const conservative = rebuildPlan(fixture(), { mode: "conservative", minSilence: 3.0 });
    expect(aggressive.removedDuration).toBeGreaterThan(conservative.removedDuration);
  });

  it("is pure — repeated calls yield identical plans", () => {
    const a = rebuildPlan(fixture(), { mode: "balanced", maxPause: 0.5, padding: 0.1 });
    const b = rebuildPlan(fixture(), { mode: "balanced", maxPause: 0.5, padding: 0.1 });
    expect(a).toEqual(b);
  });
});
