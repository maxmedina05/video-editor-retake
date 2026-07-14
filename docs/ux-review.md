# clean-video — UI/UX review (Loom-parity)

Reviewer: driven end-to-end against `sample-videos/demo.mp4` (analysis-cached,
balanced mode → 44 cuts, −127.1s). Reference bar: Loom's built-in editor
(trim + "Remove filler words" / "Remove silences" toggles, edit-by-transcript,
waveform timeline, undo). No code changed.

Screenshots (in the session scratchpad dir
`…/0057f714-486d-4b85-803a-d4fcba21706c/scratchpad/`):

- `01-home.png` — home / open screen
- `02-editor-top.png` — editor: stacked banners, player, dense timeline, transcript wall
- `03-settings-closed.png` — settings drawer, mode + collapsed advanced
- `04-settings-advanced.png` — settings drawer, advanced expanded
- `05-narrow-1024.png` — editor at 1024px: three banners push player below the fold
- `06-watch-result.png` — "Watch result" mode

---

## Executive summary

The pipeline and the *rendered* result are strong; the **editing/review layer is
where it falls short of Loom**. Loom collapses "the machine found stuff" into a
handful of one-click category toggles and a scrubbable timeline. clean-video
instead surfaces all 44 cuts as individually-toggleable slivers on a 34px
timeline strip plus strike-throughs scattered through a ~2,000-word transcript,
with **no cut list, no bulk actions, no keyboard navigation, no per-cut preview,
and no undo**. For Max's actual job — glance at what got cut, veto the two or
three bad ones, render — that means hunting. The analysis, caching, stats, and
result playback are genuinely good and near-Loom; the gap is entirely in
*reviewing and adjusting the proposed cuts*.

Second theme: **the controls aren't live**. Changing Mode does nothing visible
until you find and click "Re-analyze"; even plan-only knobs (max pause, per-gap
cap, padding) force a full analyze round-trip with a progress bar. Loom re-flows
the moment you flip a toggle.

Third theme: **information hierarchy at laptop size**. Three stacked full-width
banners (cache badge, plan stats, render result) can push the video player
~570px down — below the fold on a 1024×700 laptop (`05-narrow-1024.png`).

Biggest wins, in order: (1) a right-hand **cut-review panel** grouped by
category with bulk toggles + counts, (2) **keyboard-driven step-through with
per-cut preview**, (3) **live re-plan** so mode/knob changes apply instantly,
(4) reclaim vertical space by collapsing banners into a compact status row.

---

## P1 — workflow-breaking friction

### P1-1. No cut list; reviewing 44 cuts means hunting slivers and strike-throughs
**Current** (`02-editor-top.png`): the only ways to see/adjust a proposed cut are
(a) click one of 44 colored regions crammed into a 34px timeline bar — many are
<2px wide and abut each other, so hitting the right one is a lottery — or (b)
scroll a ~2,000-word transcript looking for struck-through words. There is no
list, no ordering, no "next cut" affordance, no counts per type beyond the one
prose stats sentence. (The a11y snapshot of the editor is 2,000+ lines — the
transcript is one flat run of word spans.)
**Loom**: suggested edits live in a right-side panel; the timeline is scrubbable
and edits are discrete blocks you land on, not pixel-hunt targets.
**Change**: add a right-hand **Cuts panel** — a scrollable list, one row per cut:
reason chip, timecode, duration, transcript snippet, and a keep/cut toggle.
Clicking a row seeks the player to that cut. This is the single highest-value
change and reuses data already in `EditorCut[]`.
**Effort**: M

### P1-2. No bulk / per-category actions — 44 individual decisions, Loom has ~2 toggles
**Current**: every cut is its own independent toggle. To reject all filler cuts
or accept all silences you must click each one. The stats banner reports
categories ("41 shortened, 10 exempt") but you can't act on a category.
**Loom**: the entire feature is *one toggle per category* — "Remove filler
words", "Remove silences" — flip on/off wholesale, then optionally fine-tune.
**Change**: group the Cuts panel by reason (silence / filler / false-start /
ramble / manual) with a header per group showing count + total seconds and a
master keep/cut toggle for the whole group; individual rows still override.
Add top-level "Accept all / Reject all" too.
**Effort**: M

### P1-3. Controls aren't live — mode change is silent, and every knob forces a full re-analyze
**Current** (`03/04-settings*.png`): picking a Mode from the dropdown updates the
settings object but **nothing on screen changes** — cuts, stats, and the header
count stay put until you scroll the drawer and click "Re-analyze". Plan-only
knobs (max pause, max-cut-per-silence, min keep, padding) also route through
`/api/analyze` and show the "Analyzing…" progress bar, even though silence
detection + transcript are cached and unchanged. There's no separation between
"re-detect/transcribe" (expensive) and "re-shape the plan from existing
detections" (should be instant).
**Loom**: flip a toggle → the video re-flows immediately.
**Change**: (a) apply Mode/knob changes live with a debounce; (b) split the
server path so plan-only knobs recompute the cut plan from cached silence/freeze
data without the analyze progress UI (a cheap `/api/plan`), reserving the
progress bar + "Re-analyze" for changes that actually invalidate detection
(min-silence, threshold, model, smart, fillers-on). At minimum, make a Mode
change re-plan automatically.
**Effort**: M–L

### P1-4. No per-cut preview and no keyboard navigation
**Current**: you cannot audition a single cut. "Play edited" plays the *whole*
edited timeline skipping every cut; there's no "play this cut with 2s of context
either side" to judge whether a boundary is too tight. No keyboard shortcuts
exist anywhere (verified: no keydown handlers in the UI) — no j/k next/prev,
no space-to-play, no x-to-toggle. Reviewing 44 cuts is therefore all mouse,
all manual seeking.
**Loom**: you scrub and land on edit boundaries; playback makes the cut obvious.
**Change**: from the Cuts panel row, a "▶ preview" that seeks to `start − 2s`,
plays across the (kept-in) cut to `end + 2s`, then pauses. Add keys: `j/k`
prev/next cut (seek + select row), `space` play/pause, `x` toggle selected cut,
`←/→` nudge selected boundary. Pairs with P1-1.
**Effort**: M

---

## P2 — high-value improvements

### P2-1. "Play edited" toggle is undiscoverable
**Current** (`02-editor-top.png`): a bare checkbox labeled "Play edited" in the
top bar, no tooltip (confirmed: no `title`), no explanation. Max literally asked
"what is this toggle for?". It's actually "preview the result live in this
player by skipping cuts" — a great feature, unlabelled.
**Loom**: preview is the default player behavior, not a mystery switch.
**Change**: rename to "Preview edit" / "Skip cuts", add a tooltip ("Play the
video as it will render — cut sections are skipped live"), and consider making
it a segmented Original | Edited control so the two modes are obviously a pair.
**Effort**: S

### P2-2. Banners stack and push the player below the fold
**Current** (`05-narrow-1024.png`): cache badge + plan-stats + render-result are
three full-width stacked banners. At 1024×700 they occupy ~570px, so the video
player starts near the bottom of the viewport and the timeline is off-screen.
**Change**: collapse cache + stats into one compact single-line status strip
(e.g. "Balanced · 44 cuts · −127.1s · cached ✓" with a details popover); make
the render-result a slim bar or toast with the "Watch result" button, not a
tall block echoing three file paths.
**Effort**: S–M

### P2-3. Caption/output controls are stranded in the transcript header
**Current** (`02-editor-top.png`): "Embed captions", "Burn-in captions", and
"Cut selection" sit on the Transcript heading row — far from the Render button
they modify, and mixing an editing action (Cut selection) with output options.
**Change**: move Embed/Burn-in next to Render (they're render options) — ideally
a small "Render options" popover on the Render button. Keep "Cut selection" with
the transcript. CC styling itself is fine.
**Effort**: S

### P2-4. Timeline has no waveform and no thumbnail scrub
**Current**: the timeline is a flat colored bar; you can't see *where speech vs
silence* is except via the cut regions themselves, and there's no hover preview.
**Loom**: audio waveform timeline + scrub thumbnails — you locate content
visually.
**Change**: render a lightweight waveform (or an RMS/level strip from the
already-computed silence analysis) behind the regions; add hover-thumbnail
scrubbing over the player/timeline. Waveform is the higher-value half.
**Effort**: M (waveform) / M–L (thumbnails)

### P2-5. Number inputs display comma decimals ("1,2", "0,75")
**Current** (`04-settings-advanced.png`): on this locale the numeric fields
render "1,2" and "0,75". `parseDecimal` accepts commas so it *works*, but it
reads as broken/typo'd for seconds values.
**Change**: format displayed values with a dot, or use sliders with a numeric
readout for the bounded knobs (threshold, pauses) — sliders also make the
knobs feel live (ties into P1-3).
**Effort**: S

### P2-6. No head/tail trim handles
**Current**: trimming a dead intro/outro means selecting words in the transcript
and "Cut selection" — awkward for the very common "chop the first 4s / last 6s".
**Loom**: draggable trim handles at clip head/tail are the primary trim gesture.
**Change**: add draggable start/end handles on the timeline (or "Trim start to
playhead / Trim end to playhead" buttons). Worth it — intros/outros are the most
common manual edit.
**Effort**: M

---

## P3 — polish / nice-to-have

- **P3-1. Redundant controls in Watch-result mode** (`06-watch-result.png`): two
  "← Back to editing" buttons (top bar + banner), and the reason legend still
  renders under an empty timeline (no cuts in result mode). Drop the duplicate
  and hide the legend when there are no regions. **S**
- **P3-2. Binary-missing errors surface raw**: analyze/render failures print the
  raw error string in the red banner. A missing ffmpeg/whisper would read like
  "spawn … ENOENT". Map known cases to guidance ("ffmpeg not found — run
  `npm run fetch-binaries`"). **S**
- **P3-3. No drag-and-drop on home** (`01-home.png`): open is dialog / path /
  recents only. A drop zone is the fastest path for a single-file-at-a-time
  workflow. **S**
- **P3-4. No undo**: toggling a cut or making a manual "Cut selection" has no
  undo (verified: no history in the UI). A single-level undo covers the common
  misclick. **S–M**
- **P3-5. Reason-color contrast**: silence `#5b6472` is low-contrast against the
  panel, and "off" cuts use the same hatch treatment regardless of reason, so a
  disabled filler vs disabled silence look identical. Legend text is `--muted`
  and easy to miss. Consider brighter chips and a distinct "kept/off" style. **S**
- **P3-6. Home empty-state is thin**: "Nothing opened yet." with no hint about
  supported formats or that analysis is cached for instant reopen. One helper
  line would orient a first-timer. **S**
- **P3-7. Chapters / title / summary generation** (Loom AI): deliberately *skip*.
  For a personal Loom-*replacement* focused on cleaning a recording, these are
  bloat; the tool's job ends at a clean render + captions.

---

## Loom-parity scorecard (what to build vs skip)

| Loom capability | clean-video today | Verdict |
| --- | --- | --- |
| One-toggle-per-category removal | 44 individual toggles | **Build** (P1-2) |
| Suggested-edits side panel | none (timeline + transcript only) | **Build** (P1-1) |
| Live re-flow on toggle | manual Re-analyze | **Build** (P1-3) |
| Scrub + land on edit boundaries | pixel-hunt slivers | **Build** (P1-4) |
| Waveform timeline | flat color bar | **Build** (P2-4) |
| Edit by transcript | present (click word to cut) ✓ | keep + add search |
| Head/tail trim handles | transcript-select only | **Build** (P2-6) |
| Undo (clock icon) | none | Build small (P3-4) |
| Thumbnail scrubbing | none | Optional (P2-4) |
| Chapters / titles / AI summary | none | **Skip** (bloat) |

Already at/above Loom: local-only privacy, activity-aware silence modes, honest
split stats, transcript-word cutting, instant cached reopen, sidecar +
embedded + burned captions, "Watch result" playback.

---

## Suggested implementation order (batches)

**Batch 1 — the review surface (P1-1, P1-2, P1-4).** Ship the Cuts panel with
category grouping, bulk toggles, row-click seek, per-cut preview, and keyboard
nav together — they share the same component and data and together turn a
44-click hunt into a keyboard walk-through. Biggest perceived jump toward Loom.

**Batch 2 — make it live (P1-3, P2-5).** Split plan-only re-plan from
re-analyze, apply Mode/knob changes instantly (sliders where sensible). Removes
the "did anything happen?" confusion.

**Batch 3 — layout & discoverability (P2-1, P2-2, P2-3, P3-1).** Compact status
strip, relocate render/caption options, fix "Play edited" labeling, de-dupe
watch-result chrome. Cheap, high polish-per-hour.

**Batch 4 — timeline richness (P2-4, P2-6, P3-4).** Waveform, trim handles,
undo. Larger lift; do after the panel exists so they reinforce it.

**Batch 5 — edges (P3-2, P3-3, P3-5, P3-6).** Error mapping, drag-drop, color
contrast, empty-state copy.
