# Arena Studio — release notes

The Studio's footer used to carry the full changelog inline; it now shows one line and the
history lives here. Newest first. (Per-session engineering detail stays in
`arena-studio-handover.md` and the design docs — this file is the user-facing what-changed list.)

## v0.41 — 2026-07-08 · Per-trial brightness (duty) in protocols + Run view

- **`duty` is now a first-class protocol field.** A `trialParams` command can carry
  `duty: 0–255` (per-trial brightness override; 0 = the pattern's own stored
  brightness). It round-trips through load/edit/save, shows up in the command card,
  and the Run view sends it to the arena. New commands created in the designer start
  at duty 0 — the card says "(0 = pattern's own)" right next to the field — so adding
  a trialParams never changes brightness until you dial it in.
- **The runner always declares duty on the wire** — trials that don't set it send 0
  ("use the pattern's stored brightness"), so one trial's override can never leak
  into the next. Each trial's duty lands in `runlog.json` automatically as part of
  the recorded trial params.
- **Optional params can be added/removed on command cards.** Controller commands now
  have the same "+ add:" row plugin commands already had — add `duty` to an existing
  trialParams, or ✕ it off to go back to the pattern's own brightness.
- **Gain limits updated to the new firmware range** (±32767, was ±127) in the
  designer's field clamps — matching the int16 gain that shipped in v0.40's wire
  re-layout.

## v0.40 — 2026-07-08 · Console trial panel speaks the new TRIAL_PARAMS layout

- **New wire format for trials** (firmware #4 / #39 re-layout, via webDisplayTools
  [#155](https://github.com/reiserlab/webDisplayTools/pull/155)): gain is now a full
  ±32767 range, and the trial duration is sent to the controller so **the arena stops
  itself** when the trial ends — the browser's own STOP now fires 2 s later as a
  backup only (the log says which one fired). Requires the matching new firmware; an
  arena on older firmware will misread trial parameters, so flash first.
- **Per-trial brightness (duty) in the Arena Trial panel.** A new optional `duty`
  field (0–255) dims just that trial; leave it blank to use the pattern's own stored
  brightness. Cleared by ALL_OFF / pattern re-select on the controller side.
- **Full trial provenance in the console log** — the TRIAL_PARAMS log line now records
  rate, start frame, gain, duration, and duty (when sent), so a bench session's log
  is a complete record of what each trial actually ran with.
- **Fixed: Console buttons were dead in safe mode.** The console's click dispatcher
  referenced two helpers (`SAFE_BLOCKED_CMDS`, `showBanner`) that live in a different
  script scope, so in safe mode (the student default) every console button threw a
  silent ReferenceError instead of working — advanced-mode machines never saw it.
  Blocked ops now show the "Locked in safe mode" banner again and everything else
  dispatches normally.

## v0.39 — 2026-07-08 · Scope opens bigger, dead gap trimmed

- **The scope now opens at half the viewport** (was ~1/3) and sits directly under the
  sequence card — the empty band above it (row gap + strip margin) is trimmed to a few
  pixels. Still resizable via the drag handle. Net effect: a noticeably larger
  oscilloscope with almost no wasted space between it and the controls above.

## v0.38 — 2026-07-07 · Scope: fixed-axis limits for turning / forward

- **Type a ± limit for the turning and forward rows** (`turn ±` / `fwd ±` boxes on the
  scope header). Enter a magnitude and that row's Y axis fixes to ±value; leave it
  blank to auto-scale as before. Values persist across reloads. **Heading is always
  fixed at ±180** (unchanged).

## v0.37 — 2026-07-07 · Scope: per-trial direction glyph + live trial shading

- **Direction glyph on the scope.** Open-loop trials now show a large ►/◄ centered in
  their span, driven by the trial's `frame_rate` **sign** (Mode 2) — so ± variants read
  at a glance without reading the name. Blanks and closed-loop trials show none. The
  direction also appears in the hover tooltip.
- **Live "pattern displaying" shading fixed.** The green trial-span underlay listened
  for an event the runner only emits on log replay (`command`/`trialParams`); it now
  also handles the live `trial-running` event, so the shading (and the new glyph)
  appear during real FicTrac runs.

## v0.36 — 2026-07-07 · Scope: hover to reveal full trial name

- **Hover the scope to reveal the full condition name** for whichever trial the cursor
  is over — the header labels are truncated/thinned for space, so this recovers the
  complete name on demand without cluttering the plot.

## v0.35 — 2026-07-07 · Scope label layout polish

- **Live value readouts (turning / forward / heading) moved to the bottom of each
  trace row.** They used to sit at the top of row 0 and collide with the stim/LED
  overlay labels; the top of the plot is now reserved for those.
- **Condition (trial-name) labels are smaller and dimmer** — 9 px, non-bold, in a
  tighter two-row header lane — so they annotate the traces without dominating them.

## v0.34 — 2026-07-07 · Clean duration display (no float artifacts)

- **Durations no longer show IEEE float noise.** A condition whose waits summed to,
  say, `0.74 × 3` used to display as `2.2199999999999998 s` in the Run view; the
  duration math now rounds to millisecond precision (→ `2.22 s`). This flows to the
  Run chips, the finish estimate, and the Edit timeline (actual arena timing is
  unchanged — it uses each command's own duration, not this display value).
- **Editor number fields strip float noise too**, so a value stored with a long
  floating tail (e.g. from another tool) shows cleanly in the inspector.

## v0.33 — 2026-07-07 · Readable scope overlay labels

- **LED label is just the level** — the pink opto-stim box now reads `25%` instead of
  `LED 25%` (the box already says it's the LED).
- **Trial-name labels no longer collide.** At longer spans (30 s, 1/2/5 min) the
  condition names used to overlap into an unreadable smear. Now: the white boundary
  line always marks where each trial starts; names are drawn in a **two-row header
  lane** and **only when they won't overlap the previous name**, so they thin out
  gracefully as the span grows. Long names are truncated with an ellipsis and get a
  dark backing for contrast.

## v0.32 — 2026-07-07 · Run-time estimate self-calibrates

- **The projected finish time now learns from your runs.** v0.31 added a fixed
  0.03 s/command serial overhead, which fit a command-light protocol but overshot a
  command-heavy one by ~18 s. The overhead is now **learned**: after each clean run,
  the Studio solves `(actual − duration-sum) / command-count` and folds it into a
  stored moving average, so the estimate converges on your rig's real timing over a
  run or two. Seeded conservatively, clamped to a sane band, and only trained by
  completed runs (aborts/errors don't skew it).

## v0.31 — 2026-07-07 · Console pattern-picker step, sharper previews, runner fixes

Batch of post-bench fixes:

- **Console "upload a set" now asks which patterns.** Choosing **Upload ▾ → From
  course repo / library (whole set)** and picking a protocol now opens a **checkbox
  picker** of that set's `.pat` files (all selected by default, with a Select-all
  toggle and live count) before anything is written to the SD card. A colocated set
  can be dozens of files and the card can't hold every protocol's set at once — this
  replaces the old "pick a set → dump all of it" behaviour.
- **Pattern previews render at HiDPI.** Thumbnails/animations now supersample the
  canvas by `devicePixelRatio` (capped 3×), so they're crisp on Retina screens
  instead of pixelated/upscaled.
- **Multi-frame previews autoplay.** Pattern thumbnails now loop automatically as a
  lightweight GIF (Console picker, stream preview, and the Edit inspector) instead of
  only animating on hover. The loop self-stops when the thumbnail leaves the screen.
- **"W · web" patterns preview in the Edit inspector.** A loaded course/library
  protocol's colocated patterns now show their animated thumbnail (and read as
  **W · web** with a coherent source dropdown) in the condition inspector — previously
  only patterns loaded into the SD-bundle builder previewed there, so repo patterns
  showed a W badge but no image.
- **Run-time estimate counts per-command overhead.** The projected finish time added
  only display/wait durations and ran short (~8 s over a ~10 min run); it now includes
  an estimate of the serial round-trip each wire command costs, so the projection
  tracks wall-clock more closely.
- **Runner highlights the right block.** The "you are here" row in the Run view now
  matches by sequence position (and trial index within a block) instead of by
  condition name, so a condition reused across blocks (e.g. `blank_1s`) lights the
  occurrence that's actually running, not the first one in the list.

## v0.30 — 2026-07-07 · Course-repo quick-links moved into the footer

- The **course repo ↗ protocols / logs / patterns** links moved from the fixed
  bottom-left box (which overlapped the timeline preview) to the **right side of the
  footer**, on the same row as the version / timestamp / GitHub link.

## v0.29 — 2026-07-07 · Metadata vocabs come from the connected course repo

- **The connected course repo is now the source of truth for all metadata
  vocabularies.** When signed in to the configured repo, fly **age / sex / fly-number**
  load from its root-level `ages.yaml` / `sexes.yaml` / `fly_numbers.yaml` (joining
  experimenter `roster.yaml` and `genotypes.yaml`, which already did this), and each
  ↗ source link repoints to the repo. **Offline / not signed in → the webDisplayTools
  site library** (`configs/metadata/*.yaml`) is the fallback. The rule is documented
  in CLAUDE.md; new controlled vocabs must follow it (`fetchCourseVocab`).
- Seeded the three vocab files into `reiserlab/cshl-2026-course` so instructors curate
  the pick-lists there.

## v0.28 — 2026-07-07 · Scope mode maximizes the canvas

- **Scope controls (win / span / ball / auto-Y / clear) now ride the dock header
  row** in Scope mode, and the **STOP / All-on / All-off** buttons hide there (they
  live in the Console) — so the scope canvas gets the whole dock.
- **The "waiting for FicTrac…" message is now large, centered on the scope** instead
  of a small line in the controls; the live rate/samples status sits on the header
  when data is flowing.
- **LED intervals are labeled with the commanded power** (e.g. "LED 50%") at the top
  of the pink box — the % rides from `ledDrive` through the run-status to the scope.

## v0.27 — 2026-07-07 · Course-repo quick-links (bottom corner)

- A small **course repo ↗** widget in the bottom-left opens the configured repo's
  **protocols**, **logs** (`runlogs/`), and **patterns** folders on GitHub in a new
  tab. Links namespace to the current **bench id** when one is set (e.g.
  `protocols/bench02`, `runlogs/bench02`) and update live when the repo/bench change.

## v0.26 — 2026-07-07 · Run-details: fly age / sex / fly number

- Three new controlled-vocabulary dropdowns in Run details — **Fly age**
  (1-2 / 3-4 / 5-6 / 7-14 / 14+ days), **Sex** (M / F), and **Fly number**
  (N/A or 1–100) — each backed by a repo YAML (`configs/metadata/ages.yaml`,
  `sexes.yaml`, `fly_numbers.yaml`) with an ↗ source link, same as experimenter
  and genotype. Extend a list via a PR. Optional (not required for a recorded run).
- All three are written into the run-log `run_metadata` line (`age`, `sex`,
  `fly_number`), so recorded runs carry them for the analysis dashboard.

## v0.25 — 2026-07-07 · Oscilloscope readability pass

- **New 2-minute span** option (10 s / 30 s / 1 min / 2 min / 5 min).
- **Larger labels** (~25%) across the scope — axis ticks, condition labels, and the
  per-row value readouts (now bold) — easier to read from across the rig.
- **Trial-boundary lines are now bright white and thicker** (solid), so trial starts
  stand out clearly.
- **The LED (opto) interval is now a translucent pink box spanning all three traces**,
  drawn *under* the data — replacing the thin band that used to sit below the plot.

## v0.24 — 2026-07-07 · Run-log metadata version was stuck at "v0.5"

`tool_version` in every run-log's `run_metadata` was a hardcoded constant
(`Arena Studio v0.5`) that never got bumped with the footer — so all logs, even at
v0.23, were stamped v0.5. It now derives from the footer at load, so it can't drift
again. (Discovered while diagnosing a bench run whose bridge was an old build; the
metadata mislabel is unrelated to that bridge issue.)

## v0.23 — 2026-07-07 · Safe-mode fixes: GitHub padlock + File-menu Run-logging

- **The GitHub padlock is back in safe mode.** It was hidden, so bench setup looked
  unlocked; it now shows a 🔒 (locked) indicator, sign-in/out + repo/bench stay disabled,
  and clicking the padlock in safe mode explains it's instructor-only instead of unlocking.
  Returning to safe mode from advanced now re-locks GitHub automatically.
- **The Run-logging dropdown works.** Selecting it no longer slams the File menu shut — the
  menu now closes only on a click *outside* it, so its controls (the Run-logging `<select>`,
  checkboxes, inputs) are usable.
- Reminder: **enter advanced mode** by clicking the **🛡 Safe mode** chip (top bar) and
  entering the password (default `reiser`).

## v0.22 — 2026-07-07 · Run view opens on the Scope (≈⅓ screen); smaller Notes

- The Run view now **opens with the oscilloscope** by default, sized to about a third
  of the screen. (A one-time migration flips existing browsers to Scope once; a
  deliberate Log choice is kept, and you can still collapse it.)
- The **Notes** field in Run details is much shorter by default (it was ~⅓-screen tall) —
  still resizable.

## v0.21 — 2026-07-07 · Scope colors: readable, saturated traces

The turning trace (formerly light green) was invisible against the green trial
underlay. Traces are now saturated and distinct — **turning = bright blue,
forward = bright red, heading = bright green** — and the overlays are backed off
to faint underlays (the trial block is a very light green tint; the LED band is a
light pink) so they never wash out the traces.

## v0.20 — 2026-07-07 · Scope velocities: fix FicTrac timestamp units (ns→ms)

Testing the scope against a real recorded run (bench02, 2026-07-06) exposed a
units bug in the behavior stream: FicTrac's col-22 timestamp is the camera's
**nanosecond** hardware clock on our rigs, but the bridge treated it as
milliseconds. That inflated the velocity time-base ~1,000,000×, so **turning /
forward / side / speed collapsed to ≈0** on real data (heading, a position, was
unaffected). The bridge now normalizes col-22 to milliseconds
(`FT_TS_NS_PER_MS`), so `behavior_v1`'s `ft` is genuinely ms and the scope shows
real velocities again (turning up to hundreds of °/s, forward in mm/s). Per-frame
`ft` differencing is unchanged, so variable frame rates are still handled without
any calibration. Fixes the same bug for the offline analysis dashboard, which
shares the contract. (Bridge + `js/kinematics.js` docs; no UI change.)

## v0.19 — 2026-07-07 · Safe mode: view-everything, block-only-the-destructive

Safe mode was a blunt whole-view lockout — Edit and Console were unreachable behind
a password. It's now the guardrail it was meant to be: **every view is reachable; only
destructive actions are blocked.**

- **Edit is read-only** in safe mode (not hidden). Students can open and inspect any
  protocol; the §6 `canMutate` chokepoint turns every edit into a silent no-op, and a
  one-line "viewing read-only" notice explains why.
- **The Console is usable** — connect, query, run test trials, step frames, and drive
  the analog/digital outputs all work. Only the destructive/config ops are greyed and
  refused: pattern add/delete (SD purge/archive, load .pat/.bin, raw-hex send, ISP
  copy), panel + firmware programming (ISP batch, firmware pick/flash), and controller
  settings (panel mode, frame rate, SPI, system reset).
- **Bench setup** (GitHub token / repo / bench-id) stays visible but its unlock padlock
  is hidden, and the session-rig selector stays hard-locked — instructor-only, as before.
- Unlock advanced mode from the **🛡 Safe mode** chip (soft password); the Edit/Console
  tabs are now ordinary view switches.

## v0.18 — 2026-07-07 · Scope fixes: LED overlay on/off + working auto-Y

- **The scope's LED band now reads the BuckPuck driver correctly.** The LED (BuckPuck)
  drive is inverted — full dark is ≈5 V, brighter is a *lower* voltage — so a `ledDrive 0%`
  used to (wrongly) show the LED as on. The overlay now uses the driver's own "LED dark"
  threshold (`LED_OFF_MV`, shared from the runner) to tell on from off, so an LED turned
  off mid-run correctly closes the red band.
- **The scope's `auto-Y` button now does something.** With auto-Y on (default) each trace
  auto-scales to its data; turning it off **freezes** the current Y range so the trace stops
  rescaling as new data streams in. (Previously the button toggled but had no effect.)

## v0.17 — 2026-07-07 · Run-logging level is a File-menu setting

- **Pick the FicTrac frame-logging level from File ▾ → Run logging** — `behavior_v1`
  (compact, the default) or `full` (the whole 25-column record, for a debug/archival run).
  It's a **runtime/session setting** (remembered on the browser), not something baked into
  each protocol, and it sits with the other data-pipeline settings (next to "Archive SD
  patterns after each run"). Advanced-only — hidden in safe mode, so students always get the
  compact default.
- **The Console keeps its manual `log` toggle** for ad-hoc use — when you're just trying
  things out without a protocol, flip it on to capture data. The Console shows the *level*
  read-only next to it (change it in File ▾).
- **A recorded experiment run is deterministic:** it asserts the File-menu level + logging-on
  at run start, overriding whatever the Console toggle was doing.
- (Replaces the interim v0.16 approach of a per-protocol `log_level` plugin field — logging
  verbosity is a capture decision, not part of the experiment definition.)

## v0.16 — 2026-07-07 · Full-width scope + behavior_v1 logging is the runner default

- **The oscilloscope now spans the full width of the Run view** — edge to edge, matching
  the metadata column's right edge — instead of only the left column. The Log shares the
  same wider dock. (The dock moved to a full-width row below the two columns; it's still
  drag-resizable.)
- **Recorded runs log the compact `behavior_v1` frame by default.** The web runner now
  *asserts* that level to the bridge when it starts logging, so every run is captured as the
  compact `[ms, fc, idx, ft, x, y, hd]` row regardless of how `pixi run bridge` was launched
  — the same data the scope and analysis dashboard use.
- (The logging level was briefly a per-protocol plugin field here; v0.17 moved it to a
  File-menu runtime setting — see above.)

## v0.15 — 2026-07-07 · Live oscilloscope (watch the fly's behavior during a run)

- **The Run-view dock now offers a live oscilloscope.** A `Log | Scope | —` switch in
  the dock header flips the bottom pane between the run log and a scrolling, 3-channel
  scope: **turning rate** (°/s), **forward velocity** (mm/s) and **heading** (°),
  built up in real time from the FicTrac bridge. It replaces squinting at numbers
  flying by in the log during closed loop. Read-only, so it's fully available to
  students in safe mode.
- **Overlays line up with the traces:** condition boundaries (dashed lines + labels),
  the visual-stimulus interval (green band), and the LED/opto interval (red band under
  the traces) — all on the shared time axis.
- **Controls:** smoothing window (default 0.25 s), time span (10 s / 30 s / 1 min /
  5 min), fly-on-ball diameter (defaults from the rig's `ball_diameter_mm`, else 9 mm),
  auto-Y, and clear. Heading is fixed to ±180°; the velocity rows auto-scale.
- **Same numbers the analysis dashboard will plot.** The live scope and the offline
  dashboard share one derivation module (`js/kinematics.js`) and one compact data
  contract (`behavior_v1` = `[ms, fc, idx, ft, x, y, hd]`), so what you watch live is
  what you'll analyze later — same channels, units, and sign conventions. Forward
  velocity is computed by projecting the ball's motion onto heading; timing uses the
  FicTrac frame timestamp (robust to dropped frames).
- **Bridge:** `pixi run bridge` now forwards those behavioral fields to the browser
  and logs the compact `behavior_v1` row by default (the full 25-column record stays
  available via `--log-frames`). Restart the bridge from the current version to get
  the scope data.

## v0.14 — 2026-07-07 · Safe mode (student-friendly default; advanced behind a password)

- **The Studio now opens in a locked-down "safe mode" by default.** A plain load shows a
  **🛡 Safe mode** chip and keeps only the student-safe surfaces reachable: **▶ Run** and
  **▶ Test** the loaded protocol, enter run metadata, **Open a protocol to run it
  (read-only, from any source — local file / library / course repo)**, and connect/disconnect
  the arena. Editing, the Console (patterns/panels/ISP/SD/raw hex), the session-rig selector,
  and all GitHub save/setup are hidden or locked — so a student can't wander into a surface
  that could disrupt the rig.
- **Advanced (the full Studio) is one click + a password away.** Click the 🛡 chip (or a
  locked ✎ Edit / ⛭ Console tab) and enter the instructor password to unlock everything; the
  unlock is **remembered on that browser** so the instructor's machine stays in advanced mode
  across reloads. A **🔓 Advanced · lock** chip returns to safe mode. The default password is
  `reiser`; an instructor can set a per-bench one by storing `studio_advanced_pw` in the
  browser. This is a **guardrail, not security** (it's all client-side) — it just keeps
  students on the rails.
- **Link into advanced mode with `?advanced=1`** (still password-gated). The flag is kept in
  the URL only when you arrived with it; a remembered-unlocked browser keeps a clean URL.
- **Run-lock is now standard for everyone:** while a run is active, the ✎ Edit / ⛭ Console
  tabs are disabled, so a stray view switch can't perturb a running experiment. Press **STOP**
  first.

## v0.12 — 2026-07-07 · Pattern-set redundancy (archive the SD card after a run)

- **After a completed recorded run, the patterns actually on the SD card are snapshotted to
  the course repo** for safekeeping (requested by Frank). The Studio pulls the whole card
  (GET_SD_ARCHIVE) and commits it to `pattern-sets/<content-hash>/patterns.zip`, so a
  student's on-card renames or edits are captured even though the repo→SD half of the
  registry can't see them. Deduped by **content hash** — identical card contents are stored
  exactly once. It's best-effort and needs the arena connected + a firmware build with the
  SD-archive command. **Known issue (bench, 2026-07-07):** on a large (~1.7 MB) card the
  `GET_SD_ARCHIVE` bulk download aborts with a serial "Break received" and drops the arena
  connection — under investigation (see `docs/development/bench-testing-2026-07-08.md`). So the
  auto-archive is **OFF by default**; opt in via File ▾ → "Archive SD patterns to repo after
  each run" (an advanced course-pipeline checkbox) once the transfer is fixed.

## v0.11 — 2026-07-07 · Run log: paired two-color TX/RX lines

- **The run log pairs each command with its reply on one line, in two colors.** Data sent
  to the controller (TX, ›) is cyan and the reply coming back (RX, ‹) is green, shown
  together on a single line — more compact and the direction of flow is obvious at a glance.
  A command with no reply stays on its own line, and non-transport lines (bridge, errors,
  run events) are unchanged. (Closed-loop FicTrac frames don't flood this log — they go to
  the bridge's data file; the live oscilloscope view, planned separately, is where you'll
  watch that stream.)

## v0.10 — 2026-07-07 · BuckPuck LED-drive command (author LED brightness in %)

- **New `LED drive (% intensity)` protocol command.** Instead of programming the LED with a
  raw analog-output voltage, a condition can drive an LED (via a BuckPuck current driver on
  the "Analog Out (0-5V)" BNC) as a **percentage of full brightness** (0 = off, 100 = max,
  0.1% steps) — far easier for students to calibrate. The runner maps % to the control
  voltage using the BuckPuck datasheet transfer curve (so % ≈ % of light output) and sends
  SET_AO_VOLTAGE under the hood; 0% parks safely past the driver's shutoff. It's a G6-only
  controller command (like Set Analog/Digital Out) and appears in the Commands and Table
  editors with a Brightness (%) field. The datasheet curve is approximate — a measured
  per-rig calibration can refine it later.

## v0.9 — 2026-07-06 · Closed-loop frame-count fix (correct FicTrac modulus)

- **Fixed: closed-loop (FicTrac) runs used the wrong frame modulus.** The bridge needs the
  pattern's *true* frame count as the index modulus (e.g. 200 for a 200-frame pattern), but
  the Console thumbnail renderer was overwriting the pattern's stored frame count with the
  number of *preview thumbnails* it sampled (≤10). A run could therefore push `frames=10` to
  the bridge for a 200-frame pattern, wrapping the closed-loop heading→frame mapping every 10
  frames instead of 200 — silently corrupting the visual feedback. The preview now keeps the
  true parsed frame count. Reported from a bench run whose log showed
  `{"type":"config","gain":1.8,"frames":10}` for `frame2_h_ccw_200f`. (The standalone
  `experiment_designer_v3.html` had the same class of bug via a different field — its
  closed-loop frame resolver read a nonexistent `it.frames` and always got null — fixed too,
  v0.41.)

## v0.8 — 2026-07-06 · Constrained run metadata + run log collapsed by default

- **Experimenter and genotype are now controlled pick-lists**, not free-text fields. Both
  are `<select>` dropdowns fed from the controlled vocabulary (the course `roster.yaml` /
  `genotypes.yaml`, or the lab `configs/metadata/*.yaml` when no course repo is set). No
  free text means no typos leak into the recorded run data, so runs merge cleanly later. A
  genotype that isn't on the list is pre-registered by adding it to `genotypes.yaml` (the
  "↗ source" link). This also fixes the bench report that a picked value got **stuck and
  couldn't be changed** — the old `<datalist>` inputs could wedge Chrome's native
  autocomplete when the list rebuilt on connect; a `<select>` is always re-selectable, and
  the vocabulary is now cached so a reconnect no longer churns the options. (The Edit view's
  protocol *author* field is unchanged — it stays free text with roster suggestions.)
- **The run log starts collapsed** so a first look isn't a wall of transport hex. One click
  on the ▸ chevron opens it, and that choice is remembered per browser.

## v0.7 — 2026-07-05 · Edit toolbar + Settings diet (wireframe v6 issues 6/7/8)

- **Edit toolbar** is now just: Designer | YAML tabs · ● edited · ↶ ↷ · Settings ▾.
  Everything else moved into **File ▾**: Open demo… (picker over the 13 bundled demos),
  Save copy (download)… (was Export YAML), Copy conditions from another protocol… (was
  Import from YAML…), Reset protocol…. **Save = Ctrl+S / Cmd+S or File ▾ → Save** (the
  toolbar 💾 was removed); the toolbar "Import YAML" button was dropped as redundant with
  File ▾ → Open local file… (which also carries provenance + lands in the editor).
  Build pattern set… moved into Settings; Quick Start moved to the ? Help card.
- **Settings drawer, repo-connected**: three small sections — Experiment (name ·
  experimenter with the course-roster suggestions · date, auto-set on first save) · Rig
  (read-only "uses bench rig …" with a ≠ bench warning when the protocol differs, the
  arena line, and "rig provides" plugin chips) · Pattern set (Build pattern set… + the
  colocated-folder hint). Everything else — built-in rig dropdown, rig path + Browse…,
  pattern_library, an editable date, and the full plugin editor — lives under
  **Advanced…**, which auto-opens when the Studio is not repo-connected
  (standalone / local-MATLAB use).
- **New protocols pre-fill from the session rig**: File ▾ → New seeds `rig:` with the
  bench rig's path, declares the rig's enabled plugins, and stamps `date_created` with
  today. Opened protocols are never rewritten (the top-bar mismatch chip still owns
  disagreement); an empty `date_created` is stamped on first save.
- **Top bar slimmed**: the arena/firmware device line moved onto the status-dot hover;
  the ⚡ Plugins chip is gone (declared plugins → Settings; run-time skipped/executed
  lines were always in the run log); the "N cond · M blk" summary moved onto the Run
  view's sequence card (and no longer disappears on narrow windows).
- **? Help mode covers the editor**: hover tips on the toolbar, all three zones,
  Variables, the YAML tab, the Settings sections, and the relocated File ▾ items.
- Footer link now points at the **GitHub repo** (this release-notes file lives there
  under docs/development/). The Pattern Designer lost its orange top banner — it has
  the same one-line version/date/GitHub footer as the other tools now.
- **Save as… + repo overwrite guard**: File ▾ → *Save as…* saves under a new filename, and
  **any course-repo save that would overwrite an existing file now confirms first — even
  the file you opened.** A plain Save over an existing protocol stops and makes you choose
  (Overwrite it / pick another name / Cancel); only a brand-new filename saves without a
  prompt. No more silent clobbering of a repo protocol. *Save as…* names its destination
  (course repo / Pull Request / local file) in both the menu label and the prompt, and its
  filename defaults to the protocol's own name (`experiment_info.name`).
- **Build pattern set… knows the course repo** (#150): a "Course repo" source lists the
  shared `patterns/` library and this protocol's `_patterns/` folder; **Add referenced**
  seeds the set from the protocol's own pattern names (unresolved names reported loudly);
  **Commit set → repo** direct-commits the set into `protocols/<bench>/<name>_patterns/`
  with the Promote-style guard (identical files skipped, a different file under an
  existing name refused) and refreshes the W badges live. This is the one-click
  library → colocation path.
- **Studio ⇄ Designer are first-class neighbors**: an always-visible
  "Pattern Designer ↗" in the Studio's top bar and "Arena Studio ↗" in the Designer's
  header. The links reuse each other's tab — clicking focuses the existing tab instead
  of opening duplicates, so the Studio keeps its arena connection and the Designer
  keeps unsaved work; only a first click opens a tab (handing over arena + repo).
  The ⚙ gear menu is gone — replaced by an "Other tools" link on both pages (one
  reused index tab); its glyph moved onto the Editor's "⚙ Settings ▾" button.
- **Run confirms on a bench ≠ protocol rig mismatch** (2026-07-05): ▶ Run experiment and
  ▶ Test experiment now pop a one-time confirm when the session (bench) rig name differs from
  the loaded protocol's `rig:` — the bench geometry still wins and the protocol document is
  unchanged, but you acknowledge before driving the arena with the whole sequence. It does
  **not** hard-block (a protocol authored on a sibling bench with the same arena still runs),
  and single-condition ▶ Test is unaffected. The top-bar mismatch chip already surfaced this
  passively; this makes a full run an explicit choice. Keys on the rig *name* (cheap); a
  geometry-aware version would need to resolve the protocol's rig YAML.
- **Cross-tool links moved to the left** (2026-07-06): "Pattern Designer ↗" and "Other tools"
  now sit together on the left of the top bar (right after the brand) in all three views —
  previously "Pattern Designer ↗" was mid-bar and "Other tools" was at the far right.
- **Runner: active step stays visible + resizable run log** (2026-07-06): during a run the
  highlighted step now auto-scrolls into view (it used to drop below the fold on long
  sequences), and the Run-view log gained a drag divider that snaps to a few heights — the
  same behavior as the Console log.
- **Console log "hide" collapses to the bottom** (2026-07-06): the ▾ hide-log control now lets
  the panels expand and drops the "▴ show log" strip to the bottom of the window, instead of
  leaving a blanked drawer where the log used to be.

## v0.6 — 2026-07-04 · Console de-clutter (tool rail)

- **Console re-laid-out for bench use** (wireframe v6.2 made real): a left rail of 7 tool
  buttons — Patterns · Arena Trial · Step frames · Test display · I/O · Panel firmware ·
  FicTrac — opens compact one-row panels in the stage (several at once, each with ✕).
  Default layout opens everything except I/O and Panel firmware and fits a 1280×800 laptop.
- **Patterns panel = device memory + picker merged.** The SD (or built-in library) listing IS
  the picker: click a row to select (green highlight + ▸), with a large preview and the
  pattern-info line on the right. Toolbar: Refresh · ↻ info · Add ▾ · Download ZIP · Purge….
  The separate name dropdown and raw pat-idx box are gone; Debug ▾ raw-hex still covers
  arbitrary bytes.
  - Fix over the first slice: connected SD rows list raw filenames (`001_all_on.pat`) while
    the picker keys logical names (`all_on`) — row clicks now normalize through
    `sdLogicalName`, so picking works on real hardware, and the auto-picked row is
    highlighted after every SD refresh.
- **Arena Trial** — the one trial-params box (Modes 2/3/4 all send TRIAL_PARAMS); the mode
  picker dims fields that don't apply (rate = mode 2, gain = mode 4, start frame = 3/4;
  auto-stop works in any mode). ▶ Start / ■ Stop right-aligned. **Step frames** keeps the
  Mode-3 stepping workflow ("Load (mode 3)" → "Load pattern").
- **Bench strip + always-visible log**: Controller ▾ / Debug ▾ / All on / All off / ■ STOP on
  one strip; the timestamped bench log is pinned below the panels, fills the remaining
  height, and has a drag divider that snaps (~30/46/62/80%); collapsible only on demand.
  Raw-hex moved into Debug ▾.
- **? Help mode** (top-bar ?): hover any control for a plain-language explanation, plus a
  dismissible "first steps" card per view. Written for end users — no opcodes or internals
  (those stay on the regular engineer hovers when Help is off).
- **Opening a protocol lands in the Editor** (inspect before running); shared `?p=`/`?repo=`
  links still open in Run. File ▾ labels standardized: Open local file… / Open from Library… /
  Open from Repo….
- **W/C pattern badges fixed for repo protocols**: a condition now badges W when its pattern
  resolves on the SD card, in the pattern library, or in the opened protocol's colocated
  `_patterns/` folder (previously only a hand-loaded Pattern Set counted, so repo protocols
  showed C everywhere).
- **"Commit directly to default branch" stays visibly green when the kiosk lock disables it**
  (custom-drawn checkbox — the native disabled checkbox was nearly invisible).
- **"Patterns ↗" top-bar link** opens the Pattern Designer in a new tab with this session's
  arena + repo handed over (`?arena=` + `?repo=`); the GitHub sign-in carries over via
  same-origin storage.
- **Footer changelog** replaced by this document (one-line footer).

First bench-review fixes (2026-07-05):

- **Bench log never squeezes the panels**: the log scrolls inside whatever space is
  below the panels (flex-basis 0); only the drag divider changes the split.
- **GitHub repo defaults to the course repo** (`reiserlab/cshl-2026-course`) on a
  never-configured bench — sign-in is all a fresh bench needs. An explicit clear of
  the field sticks (falls back to PR-saves on reiserlab/webDisplayTools).
- **Pattern Designer "Save to Repo → shared library" fixed**: `patterns/` added to
  the GitHub path allowlist (it refused the new destination).
- **Panel-number overlays are row-major for G6** in all three places that draw them —
  the Pattern Designer's 2D grid, its 3D view, and the standalone Arena 3D View —
  matching the arena's own Panel map figure (bench-confirmed): 1–10 along the bottom
  panel row, 11–20 across the top.
- **Console Add ▾ → From course repo… now offers the shared pattern library** as its
  leading source (patterns/, where the Pattern Designer saves) alongside the protocol
  sets — pick one pattern or upload the whole folder. Bare directory listings
  (`patterns`, `protocols`) are now readable through the token guard.

## v0.5 — 2026-07-04 · course data pipeline

Course data pipeline: repo/bench-id settings (visible-but-locked in all views, GitHub
sign-in/out) + direct commit (protocols/<bench-id>/ + runlogs/<bench-id>/), universal bridge
run-logging (gated recorded runs, run_metadata line, auto-commit of the exported JSONL),
course roster.yaml + genotypes.yaml + dynamic source links (load on sign-in, no arena
needed), MAC cross-check chip, missing-pattern preflight (block) + name-mismatch warning, SD
pattern names matched by logical name (NNN_ index prefix + .pat tolerated, so one card holds
several protocols' sets), Console SD Upload ▾ (single pattern or whole set — from local
file/folder, library, or course repo, picked by protocol; uploaded bytes feed picker
previews, so "Load set…" is retired; per-file confirm log + settle pause + 1 retry for
reliability), manual "⇪ Push log" to re-commit a run log the auto-commit skipped/failed
(with a screen-greying upload modal that holds the exact error on failure; export timeout
now names a stale bridge build), io_ext caps resolved before the rig-I/O apply (no
first-connect race) + role options re-gate on GET_CONTROLLER_INFO + "Apply I/O roles" honors
session overrides, File ▾ in all views (Open pickers everywhere; write/settings Edit-only),
Console Debug ▾ + Controller ▾ advanced (panel mode / rig I/O) locked by default, Run view
has a FicTrac bridge strip (connect + live counts mirrored from the Console, one shared
connection; closed-loop indicator pulses green while active; gain/config stay in Console), a
live elapsed/estimated-total run timer under the step counter, and hides the per-condition
"▶ Test" buttons during a run, Run-view log is capped at 40vh (bottom-anchored, never
squeezes the launch card + sequence; sequence takes the flexible middle) and Notes defaults
roomy (~38vh, meta-panel scrolls), Open from library/course repo pickers, promote-to-shared
with hash guard, ?repo= links.

## v0.4 and earlier

- **v0.4** — session rig (top bar, locked) + mismatch chip + `?rig=` + rig `io:` power-on
  defaults incl. roles via SET_DIO_ROLE/SET_AO_MODE on io_ext firmware, capability-gated
  (#135; I/O names match the board silkscreen — Digital IO 1/2, ports 1-based) · negative
  frame_rate = Mode-2 reverse (int16, fw #4).
- **v0.3** — URL state read/write (#107) · Edit 💾 Save.
- **v0.2** — full three-zone Edit (embedded v3 designer + YAML tab, §6 canMutate chokepoint).
- **v0.1** — Run + unified run-log + metadata · full Console (bench).
