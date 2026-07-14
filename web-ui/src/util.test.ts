import { describe, expect, it } from "vitest";
import { toEditedTime } from "./util";
import type { Range } from "./types";

const ranges: Range[] = [
  { start: 10, end: 15 },
  { start: 20, end: 30 },
];

describe("toEditedTime", () => {
  it("passes through before any cut", () => {
    expect(toEditedTime(5, ranges)).toBe(5);
  });
  it("clamps inside a cut to the cut's start on the edited timeline", () => {
    expect(toEditedTime(12, ranges)).toBe(10);
  });
  it("subtracts full earlier cuts", () => {
    expect(toEditedTime(18, ranges)).toBe(13);
    expect(toEditedTime(40, ranges)).toBe(25);
  });
  it("maps the original duration to the edited duration", () => {
    expect(toEditedTime(60, ranges)).toBe(45);
  });
  it("handles no cuts and t=0", () => {
    expect(toEditedTime(7, [])).toBe(7);
    expect(toEditedTime(0, ranges)).toBe(0);
  });
});
