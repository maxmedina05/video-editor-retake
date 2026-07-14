import { describe, expect, it } from "vitest";
import { MODES, MODES_LIST, modeDefaults } from "./modes.js";

describe("mode defaults", () => {
  it("lists the three modes", () => {
    expect(MODES_LIST).toEqual(["conservative", "balanced", "aggressive"]);
  });

  it("conservative is Loom-like: long silences, static-only, capped, no fillers/smart", () => {
    const m = MODES.conservative;
    expect(m.minSilence).toBe(3.0);
    expect(m.maxPause).toBe(1.5);
    expect(m.maxCutPerSilence).toBe(2.5); // per-gap cap ~ Loom's hands-off long silence
    expect(m.fillers).toBe(false);
    expect(m.smart).toBe(false);
    expect(m.activity.aware).toBe(true);
    expect(m.activity.cutActive).toBe(false); // never cut active silences
  });

  it("balanced keeps the historical numeric defaults, uncapped, gentle active handling", () => {
    const m = MODES.balanced;
    expect(m.minSilence).toBe(1.2);
    expect(m.maxPause).toBe(0.75);
    expect(m.maxCutPerSilence).toBe(0); // uncapped
    expect(m.fillers).toBe(true);
    expect(m.activity.aware).toBe(true);
    expect(m.activity.cutActive).toBe(true);
    expect(m.activity.activeMaxPause).toBe(2.0);
    expect(m.activity.activeMinGap).toBe(4.0);
  });

  it("aggressive trims hard, uncapped, ignores activity", () => {
    const m = MODES.aggressive;
    expect(m.minSilence).toBe(0.8);
    expect(m.maxPause).toBe(0.5);
    expect(m.maxCutPerSilence).toBe(0); // uncapped
    expect(m.fillers).toBe(true);
    expect(m.activity.aware).toBe(false);
  });

  it("falls back to balanced for an unknown mode", () => {
    // @ts-expect-error exercising the runtime guard
    expect(modeDefaults("nonsense")).toBe(MODES.balanced);
  });
});
