# Live Oscilloscope View — Specification

**Status:** ✅ IMPLEMENTED in Arena Studio v0.15 (2026-07-07). As-built notes below.

> **As built (2026-07-07) — the §3 data contract changed.** Per the #140 decision
> (comment 4900650706) the bridge now forwards + logs the **`behavior_v1`** schema
> `[ms, fc, idx, ft, x, y, hd]` (not the `heading`/`fwd` set drafted in §3). Forward
> velocity is derived by **projecting dx/dy onto heading** (from `x`/`y`/`hd`), and
> the derivative time base is **`ft` = FicTrac col-22 timestamp** (differenced),
> never col-24 `dt` (Frank, #143). The shared math lives in **`js/kinematics.js`**
> (`centralDiff` = simple offline central-difference; `windowedDerived` = the
> smoothed live OLS path) with `tests/test-kinematics.js`. The bridge WS payload and
> `behavior_v1` log rows are produced in `fictrac-bridge/bridge.py`; the client
> re-emits a `'sample'` event (`js/fictrac-bridge-client.js`). Everything else below
> (rows, overlays, dock, autoscale, window/span controls) shipped as written.

**Original spec (design record) follows.**
**Owner:** Reiser Lab (CSHL course). **Target:** `arena_studio.html` Run view.
**Related in-flight work:** BuckPuck LED plugin (`LED_AO_drive`), safe mode, run-log
compaction — see "Interactions" below.

---

## 0. Context for a fresh agent

Read first: the `g6-orientation` skill, `CLAUDE.md` (§ Arena Studio, § FicTrac
closed-loop), and the memory notes `fictrac-closed-loop-v3-runner` and
`g6-web-runner-impl`. This feature sits on top of the existing FicTrac closed-loop
bridge. The **single most important part of this spec is the data contract in §3** —
it must be agreed jointly with the upcoming *data-analysis* session, because the live
scope and the offline analysis should plot the **same quantities computed the same way**.

---

## 1. Purpose

Give students a live, oscilloscope-style view of the fly's behavior while an
experiment runs — the same three signals they will later plot in analysis, built up in
real time. It replaces "watch numbers scroll by in the log" (which is illegible during
closed loop) with an intuitive scrolling trace. Pedagogical, not for acquisition — the
**authoritative data is still the bridge JSONL** (full-fidelity, all 25 FicTrac fields).

### Relationship to the offline analysis dashboard

The scope is the real-time, single-run view of the same data model used by the
offline analysis dashboard. It should not grow a separate analysis vocabulary. For
v1, enforce this by sharing:

- the same raw FicTrac field names and units;
- the same derived kinematic channels: turning rate, forward velocity, heading;
- the same event/epoch vocabulary: condition, visual stimulus, opto stimulus;
- the same channel colors, row order, and axis labels;
- the same sign conventions, with no scope-only folding or protocol-specific
  response transforms.

The dashboard adds grouping, trial averaging, folded/unfolded responses, tuning
curves, and histograms. The scope remains a live preview of one run/session.

## 2. Where it lives

The bottom dock of the **Run view** becomes a three-way choice, reusing the existing
collapse/resize machinery (`#logChev`, `body.log-collapsed`, `.dock-pane`,
`.rlog-resizer` — `arena_studio.html:271-283, 2031-2053`):

```
[ Log | Scope | — ]     ← segmented control in the dock header
```

- **Log** — the existing run log (current behavior).
- **Scope** — this view.
- **—** — collapsed (neither), i.e. today's `log-collapsed`.

Log and Scope are mutually exclusive renderings of the same dock region.

## 3. Data contract — what the bridge must forward  ⚠ THE KEY AGREEMENT

### Current state
`fictrac-bridge/bridge.py:19-28` sends the browser only the *computed frame index*:
```json
{"type":"frame", "index":<int>, "seq":<int>, "t":<ms>}
```
The full 25-field FicTrac record is logged to JSONL (`bridge.py:204-236`) but **never
forwarded over the websocket**. The scope needs the raw kinematic fields, so the bridge
must forward a few more.

### FicTrac fields we need (0-based index into the record)
| idx | field | units | used for |
|-----|-------|-------|----------|
| 0 | frame_counter | count | seq/dedup |
| 14 | integrated_x_position | rad | (future) path plot |
| 15 | integrated_y_position | rad | (future) path plot |
| **16** | **integrated_heading** | **rad** | **heading channel + turning-rate channel** |
| **19** | **integrated_forward_motion** | **rad (cumulative)** | **forward-velocity channel** |
| 20 | integrated_side_motion | rad | (optional) sideslip |
| 21/23 | timestamp / delta_ms | ms | time base |

### ⚠ Live vs. simulator/offline: the FicTrac message tag (PR #152, `bridge.py`)
Real FicTrac's **live** UDP/TCP socket output prefixes every record with a
message-type tag — `FT` for a good frame, `FT_BADFR` (or similar) for a frame it
couldn't track. This tag does **not** appear in offline `.dat` logs or in
`fictrac_sim.py`'s synthetic output. The bridge now strips a leading `FT` tag and
**skips** any non-`FT` (bad) frame as having no usable data (`bridge.py:256-273`).
Consequences for this feature:
- The 0-based field indices in the table above are **post-strip** — valid for live,
  sim, and offline alike.
- Bad/untracked frames yield **no sample** → the time series has **gaps**. The windowing
  math (§4) must tolerate variable/low sample counts within a window (see §4 dropout note).

### Proposed forwarded message (superset — safe to add fields; consumers ignore extras)
```json
{"type":"frame",
 "index":<int>, "seq":<int>, "t":<ms>,          // unchanged (back-compatible)
 "heading":<fields[16]>,                          // rad
 "fwd":<fields[19]>,                              // rad, cumulative
 "x":<fields[14]>, "y":<fields[15]>}              // rad (reserved for path plot)
```
Four extra floats per frame. Even at 60 Hz this is trivial bandwidth. Keeping the
existing `index/seq/t` keys means the current frame-apply path is untouched.

**Decision to confirm with the analysis session:** exact field set + names. Lock this
before coding either side.

### Shared analysis contract with the dashboard

Before implementing the scope, create or identify one shared JavaScript module for
kinematic derivations. Both the scope and the offline dashboard must use it for:

- heading unwrap;
- heading wrap to +/-180 deg;
- windowed OLS slope;
- turning velocity from integrated heading;
- forward velocity from integrated forward motion;
- ball-radius conversion, when calibrated.

The module should expose a derived sample shape that both clients can consume:

```json
{
  "t_ms": 12345,
  "heading_deg": -42.1,
  "turning_deg_s": 180.4,
  "forward_mm_s": 7.2,
  "frame_index": 84,
  "source_seq": 3076
}
```

Offline analysis should be able to regenerate the same derived samples from JSONL
that the live scope displayed from websocket frames. Add fixture tests with known
slopes and a recorded bench log so the two paths cannot silently diverge.

## 4. Channel definitions & signal processing

Three stacked rows, shared X (time) axis, **independent autoscaling Y** each:

1. **Turning rate — deg/s.** Derivative of *unwrapped* heading.
2. **Forward velocity — mm/s.** Derivative of integrated forward motion × ball radius.
3. **Heading — deg, wrapped to ±180.** Field 16 wrapped; no derivative (it's a position).

### Velocity from integrated position (user's explicit requirement)
- **Window:** one exposed parameter, default **0.25 s** (UI slider/number box).
- **Method:** windowed **ordinary least-squares slope** (robust, cheap): over the
  samples in `[t_k − w/2, t_k + w/2]`, `slope = cov(t, y) / var(t)`. That slope *is* the
  derivative. (Theil–Sen is an option if outliers bite, but OLS is standard, fast, and
  matches "simple robust line fit." Recommend OLS for v1.)
- **Centered:** the output point is stamped at the window **center** `t_k`, per request.
  This adds ~w/2 = 125 ms of display latency — imperceptible for a live scope.
- **Output rate:** **10 Hz** (every 0.1 s), regardless of native FicTrac rate (~60 Hz).
- **Tracking dropouts / gaps:** bad frames are dropped upstream (see §3 tag note), so a
  window may hold few or zero samples. Require ≥2 samples to fit; on fewer, emit no point
  (gap in the trace) rather than a bogus slope. Don't assume a fixed sample count per window.
- **Heading unwrap:** before differentiating heading for turning rate, unwrap the ±π
  jumps (accumulate 2π corrections) so a wrap doesn't spike the derivative. The
  *displayed* heading channel stays wrapped to ±180.

### Unit conversions
- Turning: `deg/s = degrees(slope_of_unwrapped_heading_rad_per_s)`.
- Forward: `mm/s = slope_of_integrated_forward_rad_per_s × ball_radius_mm`
  (rad/s × mm/rad = mm/s).
- **Ball radius** is required and is currently unspecified. **Open question (§8):** put
  `ball_diameter_mm` in the rig YAML (preferred — travels with the bench), with a scope
  setting override. Typical fly-on-ball ≈ 9 mm diameter (4.5 mm radius).

### Where the math runs — recommend BROWSER
Bridge forwards raw fields (§3); the **browser** buffers and computes the windowed
slopes at 10 Hz. Rationale: (1) the bridge JSONL already holds the full raw record →
single source of truth for offline analysis; (2) the window size is a live UI control,
so recomputing client-side is natural; (3) keeps the bridge protocol minimal and stable.
The bridge stays "dumb" (forward + log); all display math is client-side and tunable.

## 5. Rendering

- **Canvas** (not SVG) — a scrolling 3-row scope at 10 Hz needs cheap redraws.
- **Scrolling view**, oscilloscope-style; newest data at the right edge.
- **X range** selectable: e.g. `10 s / 30 s / 1 min / 5 min` (spec says "few seconds to
  few minutes"). Default ~30 s.
- **Y autoscale** per row, with a **manual Y-scale override** per row (spec: "would be
  nice if the Y-axis scale could be changed").
- **Per-channel color** (distinct), on the dark theme (see `CLAUDE.md` palette).
- **Scrub slider** (pan back/forth over buffered history): **nice-to-have, may skip v1.**
  Buffer the whole run in memory — minutes × 10 Hz × a few floats is tiny — so scrub is
  cheap to add later.

## 6. Overlays (shared time axis)

- **Condition boundaries:** vertical lines with short text labels (if space). Source:
  the `runstatus` `step-start` events already consumed by `Studio.onRunStatus`
  (`arena_studio.html:2765-2791`) and the runlog adapter's `KNOWN_PHASES`
  (`js/studio-runlog-adapter.js`). Each step-start carries condition id + timestamp.
- **LED events:** light-shaded **red boxes** in a band under the three series, spanning
  LED-on → LED-off. Source: `setAnalogOut` / `LED_AO_drive` command events (see item 1,
  the BuckPuck plugin). Agree the event shape with that work so the box start/stop is
  derivable.
- **Visual stimuli:** thin-bordered **green boxes** enclosing the interval a visual
  pattern is displayed. Source: `trialParams` (pattern + duration) command spans.

## 7. Controls (UI summary)

- Dock segmented control: `Log | Scope | —`.
- Window size (default 0.25 s).
- X range preset.
- Per-row Y autoscale toggle + manual scale.
- (Optional) scrub/pause.

## 8. Interactions with other in-flight work

- **BuckPuck `LED_AO_drive` (item 1):** its `setAnalogOut` events are the source for the
  red LED-overlay boxes. Define the event/log shape once, use it in both.
- **Safe mode:** the scope is **read-only** → fully permitted for students. It's a strong
  argument for the whole feature (students watch, can't disrupt).
- **Run-log compaction (item 4):** the scope is the real fix for "closed-loop data flies
  by in the log." With the scope available, the log can just show a single in-place
  updating summary line during closed loop instead of a per-frame flood.

## 9. Out of scope for v1 / open questions

- **Ball radius source** — rig YAML vs scope setting (recommend rig YAML + override).
- **Exact forwarded field set & names** — lock with the analysis session (§3).
- **Sign conventions** — confirm turning sign (CW +?) and forward sign match the analysis
  pipeline so the live scope and offline plots agree.
- **Scrub slider** — defer if time-constrained.
- **Path plot (x/y)** — fields forwarded but not plotted in v1; reserved.
- **Persistence** — the scope displays; it saves nothing new. Analysis consumes the
  bridge JSONL (already full-fidelity).

## 10. Code anchors (as of 2026-07-06)

| What | File:line |
|------|-----------|
| Bridge → browser frame message | `fictrac-bridge/bridge.py:19-28` |
| Bridge JSONL log (full 25 fields) | `fictrac-bridge/bridge.py:204-236` |
| FicTrac field schema | `fictrac-bridge/fictrac_sim.py:22-36` |
| Live-tag strip + bad-frame skip (PR #152) | `fictrac-bridge/bridge.py:256-273` |
| Browser bridge client (`handleFrame`, events, rate) | `js/fictrac-bridge-client.js:321-379` |
| Bridge wired into session | `js/arena-session.js:98-102, 214-221` |
| Run-status sink (condition boundaries) | `arena_studio.html:2765-2791` |
| Dock / log collapse & resize machinery | `arena_studio.html:271-283, 2031-2053` |
| Run log line append | `arena_studio.html:2727-2739` |
