import type { CutReason, EditorCut } from "./types";

/**
 * Pure reducer for the editor's cut list with bounded undo/redo (P3-4) and the
 * head/tail trim cuts (P2-6). Every user edit (toggle, bulk action, manual cut,
 * trim drag) flows through here so it can be undone with Cmd/Ctrl+Z.
 *
 * History model: past / present / future snapshots of the whole cut list
 * (they're small — tens of items). "plan" (a fresh analyze/re-plan result)
 * resets history: old snapshots reference cut ids that no longer exist.
 *
 * Trim drags are TRANSIENT — pointer-moves update `present` without pushing
 * history — and the gesture is committed once on pointer-up via "trimCommit",
 * so one drag is one undo step.
 */

export const HISTORY_LIMIT = 100;

/** Fixed ids so the trim cuts can be found/updated during a drag. */
export const TRIM_HEAD_ID = "trim-head";
export const TRIM_TAIL_ID = "trim-tail";

/** Trim handles snap to tenths of a second. */
export const TRIM_SNAP = 0.1;

export interface CutsState {
  past: EditorCut[][];
  present: EditorCut[];
  future: EditorCut[][];
}

export const INITIAL_CUTS_STATE: CutsState = { past: [], present: [], future: [] };

export type CutsAction =
  /** fresh analyze/re-plan: replace auto cuts, keep manual ones, reset history */
  | { type: "plan"; cuts: EditorCut[] }
  | { type: "toggle"; id: string }
  | { type: "toggleGroup"; reason: CutReason; enabled: boolean }
  | { type: "setAll"; enabled: boolean }
  /** add a manual cut (e.g. transcript "Cut selection") */
  | { type: "add"; cut: EditorCut }
  /** transient trim-handle drag; snaps to TRIM_SNAP, no history push */
  | { type: "trim"; edge: "head" | "tail"; time: number; duration: number }
  /** end of a trim drag: push the pre-drag snapshot as one undo step */
  | { type: "trimCommit"; before: EditorCut[] }
  | { type: "undo" }
  | { type: "redo" };

function samePresent(a: EditorCut[], b: EditorCut[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.enabled !== y.enabled || x.start !== y.start || x.end !== y.end) {
      return false;
    }
  }
  return true;
}

/** Push `state.present` into the past and move to `next` (no-op if unchanged). */
function commit(state: CutsState, next: EditorCut[]): CutsState {
  if (samePresent(state.present, next)) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
  };
}

/** Snap to tenths. `round(t*10)/10` (not `round(t/0.1)*0.1`) stays float-exact. */
const snap = (t: number): number => Math.round(t * 10) / 10;

/**
 * Compute the cut list after moving a trim handle. Dragging a handle back to
 * its own edge (start of video / end of video) removes the trim cut. Handles
 * cannot cross each other (a TRIM_SNAP gap is enforced).
 */
export function applyTrim(
  cuts: EditorCut[],
  edge: "head" | "tail",
  time: number,
  duration: number,
): EditorCut[] {
  const other = cuts.find((c) => c.id === (edge === "head" ? TRIM_TAIL_ID : TRIM_HEAD_ID));
  let t = snap(Math.min(Math.max(time, 0), duration));
  if (edge === "head" && other) t = Math.min(t, other.start - TRIM_SNAP);
  if (edge === "tail" && other) t = Math.max(t, other.end + TRIM_SNAP);

  const id = edge === "head" ? TRIM_HEAD_ID : TRIM_TAIL_ID;
  const rest = cuts.filter((c) => c.id !== id);
  const gone = edge === "head" ? t < TRIM_SNAP / 2 : t > duration - TRIM_SNAP / 2;
  if (gone) return rest.length === cuts.length ? cuts : rest;

  const cut: EditorCut = {
    id,
    start: edge === "head" ? 0 : t,
    end: edge === "head" ? t : duration,
    reason: "trim",
    enabled: true,
    manual: true, // survives re-plan like other manual cuts
    note: edge === "head" ? "Trim start" : "Trim end",
  };
  // Keep trim cuts first so the panel shows them at the top of their group.
  return edge === "head" ? [cut, ...rest] : [...rest.filter((c) => c.id !== id), cut];
}

export function cutsReducer(state: CutsState, action: CutsAction): CutsState {
  switch (action.type) {
    case "plan": {
      // Preserve manual cuts (incl. trims) across a re-plan; replace auto cuts.
      const manual = state.present.filter((c) => c.manual);
      return { past: [], present: [...manual, ...action.cuts], future: [] };
    }
    case "toggle":
      return commit(
        state,
        state.present.map((c) => (c.id === action.id ? { ...c, enabled: !c.enabled } : c)),
      );
    case "toggleGroup":
      return commit(
        state,
        state.present.map((c) =>
          c.reason === action.reason ? { ...c, enabled: action.enabled } : c,
        ),
      );
    case "setAll":
      return commit(
        state,
        state.present.map((c) => ({ ...c, enabled: action.enabled })),
      );
    case "add":
      return commit(state, [...state.present, action.cut]);
    case "trim": {
      const next = applyTrim(state.present, action.edge, action.time, action.duration);
      // transient: replace present in place, leave past/future untouched
      return next === state.present ? state : { ...state, present: next };
    }
    case "trimCommit": {
      if (samePresent(action.before, state.present)) return state;
      return {
        past: [...state.past, action.before].slice(-HISTORY_LIMIT),
        present: state.present,
        future: [],
      };
    }
    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return {
        past: state.past.slice(0, -1),
        present: prev,
        future: [state.present, ...state.future],
      };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: state.future.slice(1),
      };
    }
  }
}
