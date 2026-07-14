import { describe, expect, it } from "vitest";
import { chooseDenoiseMethod } from "./denoise.js";

describe("chooseDenoiseMethod", () => {
  it("none stays none", () => {
    expect(chooseDenoiseMethod(true, "none")).toEqual({ method: "none", fellBack: false });
  });
  it("explicit afftdn stays afftdn", () => {
    expect(chooseDenoiseMethod(true, "afftdn")).toEqual({ method: "afftdn", fellBack: false });
  });
  it("uses deep-filter when available", () => {
    expect(chooseDenoiseMethod(true, "deep-filter")).toEqual({
      method: "deep-filter",
      fellBack: false,
    });
  });
  it("falls back to afftdn and flags it when deep-filter requested but absent", () => {
    expect(chooseDenoiseMethod(false, "deep-filter")).toEqual({
      method: "afftdn",
      fellBack: true,
    });
  });
  it("default (undefined) prefers deep-filter when present, silently afftdn otherwise", () => {
    expect(chooseDenoiseMethod(true)).toEqual({ method: "deep-filter", fellBack: false });
    expect(chooseDenoiseMethod(false)).toEqual({ method: "afftdn", fellBack: false });
  });
});
