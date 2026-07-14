# TODO

## Cut aggressiveness vs Loom — investigated + shipped (2026-07-14)

Same source video (sample-videos/demo.mp4, 7:44):

- **Loom "Edit and enhance"**: removed **21s** of silence, found **0 filler words**.
- **clean-video (old default)**: removed **~2:20** (min-silence 1.2 / max-pause
  0.75 + heuristic fillers + optional `--smart`).

### What we built

1. **Activity-aware silence classification** (`src/core/activity.ts`): a
   `freezedetect` pass tags spans where the video is (near-)frozen, and each
   silence gap is classified `static` (safe to shorten) vs `active` (screen is
   moving — leave it alone / shorten gently). Surfaced on the cut
   (`activity` field), in the CLI plan (`silence (active video)`), the web stats
   banner, and `cutplan.json`.
2. **Modes** (`src/core/modes.ts`, `--mode` CLI flag + web settings selector):
   `conservative` (Loom-like), `balanced` (new default), `aggressive`. A mode
   sets DEFAULTS; explicit flags/knobs still win.
3. **Honest metrics** (`CutPlan.stats`): splits removed seconds into
   *silence-shortened* vs *deleted content*, plus how many silences were
   shortened / left as-is / exempted as active — so the "Loom 21s" number is
   comparable.

### Freezedetect tuning (measured on demo.mp4)

Tried `n = 0.001 / 0.003 / 0.005 / 0.01`, `d = 1`. Higher `n` = more tolerant =
lumps moving footage in with frozen. **Chosen: `n = 0.001` (ffmpeg's strict
default), `d = 1.0`, static threshold = 0.7 frozen-overlap.** At n=0.001 the
truly-static stretches read ~1.00 frozen while genuinely-moving silences drop to
0.16–0.57, so 0.7 separates them cleanly; higher `n` blurs that boundary.

Frozen-overlap fraction of the three "known" gaps (n=0.001):

| gap             | window (s)  | frozen-frac | verdict |
| --------------- | ----------- | ----------- | ------- |
| ~10.8s @ 3:15   | 195–206     | 1.00        | STATIC  |
| ~45s   @ 4:57   | 297–343     | 0.98        | STATIC  |
| ~23s   @ 6:09   | 369–392     | 1.00        | STATIC  |

**Finding: the hypothesis was wrong for these gaps.** All three are essentially
frozen frames, not screen activity — so that is NOT why Loom left them. Loom is
just far more hands-off about long *static* silences too. The demo's genuinely
ACTIVE silences are elsewhere (tail gaps ~426/448/453s, frozen-frac 0.16–0.57);
those exercise the active path (10 exempted in balanced). A synthetic
moving-pattern + silent-audio clip confirms the classifier end to end (frozen
spans = 0 → active → exempted in conservative, gently shortened in balanced).

### Mode comparison on demo.mp4 (src 7:43.7 / 463.7s)

| mode         | total removed | silence-shortened | deleted | cuts | silences (det/short/exempt) |
| ------------ | ------------- | ----------------- | ------- | ---- | --------------------------- |
| conservative | 20.7s         | 20.7s             | 0.0s    | 9    | 12 / 9 / 3                  |
| balanced     | 127.1s        | 126.0s            | 1.1s    | 44   | 51 / 41 / 10                |
| aggressive   | 175.4s        | 174.3s            | 1.1s    | 97   | 94 / 94 / 0                 |

### Per-gap removal cap — shipped (2026-07-14)

The residual gap to Loom's 21s was legitimate long *static* silence: uncapped,
`conservative` collapsed a 40s frozen gap to a 1.5s pause (removing ~38.5s from
that one gap). Fixed with a per-gap cap knob `maxCutPerSilence`
(`--max-cut-per-silence`, web "Advanced" field; 0 = uncapped): a single silence
may lose at most N seconds, still removed from the middle, still respecting
`max-pause`. It binds when `gap − pause-kept > cap`.

**Chosen cap: `conservative` = 2.5s** (balanced/aggressive uncapped). Measured
cap sweep on demo.mp4's 9 static gaps (max-pause 1.5): cap 1.5→13.5s, 2.0→17.7s,
**2.5→20.7s**, 3.0→23.2s, 4.0→28.0s. 2.5s lands on Loom's ~21s and inside the
20–30s target. Each big static gap (≈40s, ≈19s, ≈9s) now loses only 2.5s, so
long quiet stretches are left almost intact — the Loom philosophy. Verified with
a real `--mode conservative` run: 20.7s across 9 cuts; balanced unchanged at
127.1s.

### Still open (needs the user's eyes)

- [ ] Side-by-side eyeball review: does balanced feel over-cut on pacing /
      breathing room? (Rendered balanced output plays fine; streams intact.)
