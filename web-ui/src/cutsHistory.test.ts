import { describe, expect, it } from "vitest";
import {
  applyTrim,
  cutsReducer,
  HISTORY_LIMIT,
  INITIAL_CUTS_STATE,
  TRIM_HEAD_ID,
  TRIM_TAIL_ID,
  type CutsState,
} from "./cutsHistory";
import type { EditorCut } from "./types";

const cut = (id: string, start: number, end: number, over: Partial<EditorCut> = {}): EditorCut => ({
  id,
  start,
  end,
  reason: "silence",
  enabled: true,
  ...over,
});

const stateWith = (cuts: EditorCut[]): CutsState => ({ past: [], present: cuts, future: [] });

describe("cutsReducer history", () => {
  it("toggle pushes history; undo reverts; redo restores", () => {
    let s = stateWith([cut("a", 1, 2)]);
    s = cutsReducer(s, { type: "toggle", id: "a" });
    expect(s.present[0]!.enabled).toBe(false);
    expect(s.past).toHaveLength(1);

    s = cutsReducer(s, { type: "undo" });
    expect(s.present[0]!.enabled).toBe(true);
    expect(s.future).toHaveLength(1);

    s = cutsReducer(s, { type: "redo" });
    expect(s.present[0]!.enabled).toBe(false);
    expect(s.future).toHaveLength(0);
  });

  it("undo/redo at the ends are no-ops", () => {
    const s = stateWith([cut("a", 1, 2)]);
    expect(cutsReducer(s, { type: "undo" })).toBe(s);
    expect(cutsReducer(s, { type: "redo" })).toBe(s);
  });

  it("a bulk setAll(false) is one undo step restoring every cut", () => {
    const cuts = Array.from({ length: 44 }, (_, i) => cut(`c${i}`, i, i + 0.5));
    let s = stateWith(cuts);
    s = cutsReducer(s, { type: "setAll", enabled: false });
    expect(s.present.every((c) => !c.enabled)).toBe(true);

    s = cutsReducer(s, { type: "undo" });
    expect(s.present.filter((c) => c.enabled)).toHaveLength(44);
  });

  it("a new edit clears the redo stack", () => {
    let s = stateWith([cut("a", 1, 2), cut("b", 3, 4)]);
    s = cutsReducer(s, { type: "toggle", id: "a" });
    s = cutsReducer(s, { type: "undo" });
    expect(s.future).toHaveLength(1);
    s = cutsReducer(s, { type: "toggle", id: "b" });
    expect(s.future).toHaveLength(0);
  });

  it("no-op edits do not pollute history", () => {
    const s = stateWith([cut("a", 1, 2, { reason: "filler" })]);
    // no cut has reason "ramble" — nothing changes
    expect(cutsReducer(s, { type: "toggleGroup", reason: "ramble", enabled: false })).toBe(s);
  });

  it("history is bounded to HISTORY_LIMIT entries", () => {
    let s = stateWith([cut("a", 1, 2)]);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      s = cutsReducer(s, { type: "toggle", id: "a" });
    }
    expect(s.past.length).toBe(HISTORY_LIMIT);
  });

  it("plan replaces auto cuts, keeps manual cuts, resets history", () => {
    let s = stateWith([cut("auto1", 1, 2), cut("m1", 5, 6, { manual: true, reason: "manual" })]);
    s = cutsReducer(s, { type: "toggle", id: "auto1" });
    expect(s.past).toHaveLength(1);

    s = cutsReducer(s, { type: "plan", cuts: [cut("auto2", 8, 9)] });
    expect(s.present.map((c) => c.id)).toEqual(["m1", "auto2"]);
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(0);
  });

  it("add appends a manual cut as an undoable step", () => {
    let s = stateWith([]);
    s = cutsReducer(s, { type: "add", cut: cut("m", 1, 2, { manual: true, reason: "manual" }) });
    expect(s.present).toHaveLength(1);
    s = cutsReducer(s, { type: "undo" });
    expect(s.present).toHaveLength(0);
  });
});

describe("trim", () => {
  it("dragging the head handle creates a snapped trim cut from 0", () => {
    const next = applyTrim([], "head", 4.234, 60);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: TRIM_HEAD_ID,
      start: 0,
      end: 4.2,
      reason: "trim",
      enabled: true,
      manual: true,
    });
  });

  it("dragging the tail handle creates a snapped trim cut to duration", () => {
    const next = applyTrim([], "tail", 55.66, 60);
    expect(next[next.length - 1]).toMatchObject({ id: TRIM_TAIL_ID, start: 55.7, end: 60 });
  });

  it("updates an existing trim cut instead of adding a second", () => {
    let cuts = applyTrim([], "head", 2, 60);
    cuts = applyTrim(cuts, "head", 5, 60);
    expect(cuts.filter((c) => c.id === TRIM_HEAD_ID)).toHaveLength(1);
    expect(cuts[0]!.end).toBe(5);
  });

  it("dragging back to the edge removes the trim cut", () => {
    let cuts = applyTrim([], "head", 5, 60);
    cuts = applyTrim(cuts, "head", 0.01, 60);
    expect(cuts).toHaveLength(0);

    let tail = applyTrim([], "tail", 50, 60);
    tail = applyTrim(tail, "tail", 59.99, 60);
    expect(tail).toHaveLength(0);
  });

  it("handles cannot cross each other", () => {
    let cuts = applyTrim([], "tail", 10, 60);
    cuts = applyTrim(cuts, "head", 30, 60); // head tries to pass the tail at 10
    const head = cuts.find((c) => c.id === TRIM_HEAD_ID)!;
    expect(head.end).toBeLessThan(10);
  });

  it("clamps to [0, duration]", () => {
    const cuts = applyTrim([], "tail", 999, 60);
    expect(cuts).toHaveLength(0); // clamped to 60 = no trim
    const head = applyTrim([], "head", -5, 60);
    expect(head).toHaveLength(0);
  });

  it("drag is transient; trimCommit makes the whole gesture one undo step", () => {
    let s = stateWith([]);
    const before = s.present;
    s = cutsReducer(s, { type: "trim", edge: "head", time: 1, duration: 60 });
    s = cutsReducer(s, { type: "trim", edge: "head", time: 2, duration: 60 });
    s = cutsReducer(s, { type: "trim", edge: "head", time: 3, duration: 60 });
    expect(s.past).toHaveLength(0); // nothing pushed during the drag

    s = cutsReducer(s, { type: "trimCommit", before });
    expect(s.past).toHaveLength(1);

    s = cutsReducer(s, { type: "undo" });
    expect(s.present).toHaveLength(0); // back to pre-drag

    s = cutsReducer(s, { type: "redo" });
    expect(s.present[0]).toMatchObject({ id: TRIM_HEAD_ID, end: 3 });
  });

  it("trimCommit with no effective change is a no-op", () => {
    const s = stateWith([cut("a", 1, 2)]);
    expect(cutsReducer(s, { type: "trimCommit", before: s.present })).toBe(s);
  });

  it("trim cuts survive a re-plan (manual flag)", () => {
    let s = stateWith([]);
    s = cutsReducer(s, { type: "trim", edge: "head", time: 4, duration: 60 });
    s = cutsReducer(s, { type: "plan", cuts: [cut("auto", 10, 11)] });
    expect(s.present.some((c) => c.id === TRIM_HEAD_ID)).toBe(true);
  });
});
