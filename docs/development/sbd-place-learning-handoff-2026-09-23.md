# SBD place-learning on the G6 2×10 rig — handoff (2026-09-23, rig03-sr)

Port of the G4.1 MATLAB place-learning protocol `p058.m` (SBD panorama = bars | horizontal
stripes | 45° diagonal, 90° safe zone on the bars/stripes seam, 15° heat ramps, alternating
±90° start offsets) to the CSHL fly-on-ball rig + Arena Studio. Work by Shubham Rathore with
Claude; this file is the pick-up point for the next session.

## Where everything is

| Thing | Location | State |
|---|---|---|
| Pattern (SD ID **46**) | `reiserlab/cshl-2026-course` → `patterns/046_p3_sbd_placelearning.pat` (source `patterns/p3_conditioning/011_…`) | **on GitHub main**, on the rig03 card, displays correctly |
| Pattern generator | `C:\Users\rathores\Desktop\sbd_g6\make_sbd_g6.mjs` (+ `_frame0.svg` preview) | local only |
| Protocol | `C:\Users\rathores\Documents\GitHub\cshl-2026-course\protocols\rig03-sr\p3-sbd-placelearning-led5.yaml` | **untracked, local only** (validates clean) |
| `start_frame` feature (runner + client + bridge + tests + docs) | webDisplayTools branch **`feat/start-frame-sbd`**, commit `02d6cc4`, pushed | branch only; PR not opened: https://github.com/reiserlab/webDisplayTools/pull/new/feat/start-frame-sbd |
| LED-event fix (lit-baseline / lit-teardown events) | webDisplayTools **main** `e2d3783`, Studio **v0.87**, live on Pages | done, verified on the rig twice |
| webDisplayTools working tree | checked out on `feat/start-frame-sbd` | `pixi run serve` / `pixi run bridge` from here = start_frame-capable Studio + bridge |
| Controller firmware | fw #56 `781efe2b 2x10 2026-09-23 feat/mode3-reliability freerun sdfast` | flashed today (first `deploy-2-10-performance` failed "error writing to Teensy", immediate retry succeeded) |
| Bridge | 3.3 (`pixi run bridge` from webDisplayTools) | run it in the user's own terminal; Claude must not start one (port collision 2026-09-23) |

Obsolete: `git stash@{0}` "start_frame … pre-v0.86" and `Desktop\sbd_g6\*.patch` — superseded by the branch, safe to drop.

## Why the Pages Studio cannot run the SBD protocol yet

Bridge 3.3 re-tares the heading at every `startClosedLoop` (`epoch: true`), so a Mode-3 trial
opens on `round(offset / pitch)` = **frame 0** whatever `frame_index` says. Frame 0 is INSIDE
the SBD safe zone. Run `2zo017ag` (2026-09-23 15:24, Pages v0.86) proved it: every epoch's
first frames were idx 0, and the first LED-on of each bout came at index 9 (fly walking out
of the zone). The branch adds `startClosedLoop params: {start_frame: N}` → runner IR
`startFrame` → client one-shot `start_frame` → bridge `offset = (N mod n_frames) × deg_per_frame`
(`Pipeline.start_frame_to_offset`). Until Michael merges it, SBD runs MUST use the local
Studio (`http://127.0.0.1:8000/arena_studio.html`, footer v0.87 from the branch).

## Protocol design (as in the YAML)

- Sequence: `start_bg` 3 s → `led_off` → `optomotor_cw` 20 s → `optomotor_ccw` 20 s → `preprobe` 30 s →
  `blank` 10 s → block `training` ×10 of [`train_minus` 40 s, `blank`, `train_plus` 40 s, `blank`] →
  `probe` 30 s → `blank` → optomotor cw/ccw → `post_dark` 30 s → `shutdown`. ≈ 19 min 54 s.
- Closed loop: `coupling: -1` (was gain −1.8), pitch from the rig (1.8°/frame), pattern 46.
- Start frames: `start_frame_plus` **57** (preprobe, even bouts), `start_frame_minus` **108** (odd
  bouts, probe) — p058 order (+ − + … + −). Both `frame_index` and `params.start_frame` bound to the
  same anchor.
- Safe zone frames **158–199 + 0–7** (seam assumed in front at frame **183**, from the course
  calibration "front = pixel column 49.5"). Heat zone `[8, 158)`:
  `led_activation: {baseline: 0, zones: [{level: *led_percent (5), ramp_in: [8,16], ramp_out: [150,158]}]}`
  = p058's 15° ramps (8 frames = 14.4°). Deviation: p058 ramped from a voltage floor
  (`OPTO_RAMP_MIN_V`), here the ramp starts at 0 (set `baseline: 1` if the floor is wanted — the LED
  would then be dimly on inside the zone).
- Preprobe/probe: uniform heat, legacy form `level: *baseprobe_led_percent (5), on_ranges: [[0,199]]`.
- Blanks/post: `ledDrive 0`, `stopDisplay`, `allOff`, wait (arena dark, as p058).
- Rig-check conditions NOT in the sequence (Run view → Test): `check_seam_front` (frame 183, 15 s),
  `check_start_plus` (57), `check_start_minus` (108). Validator warns "declared but never
  referenced" — intended.
- Header comments in the YAML document all of the above.

## Evidence from today's runs (bridge logs in the webDisplayTools root, `arena-log-*.jsonl`)

- `2zo017ag` 15:04–15:24, Pages v0.86: every epoch idx 0 → start_frame missing (see above).
- `knqkkyi3` 16:45–17:05, local Studio v0.87 (branch), FULL RUN completed (52 steps, 0 errors):
  - bridge configs carried `start_frame` 57/108 alternating; frames after each start tare = 57/108 ✔
  - LED ramps applied: entering heat `8:0 9:1 10:1.25 11:1.88 12:2.5 13:3.13 14:3.75 15:4.38 16:5`,
    leaving `150:5 … 157:1 158:0` (levels < 1 % snap to 1 %, driver dead zone) ✔
  - preprobe/probe: ON 5 % at start, OFF at teardown (the v0.87 LED events) ✔
  - `trial_quality` event present (fw #56 telemetry ring works) ✔
  - Oddity: bout `train_minus#6` first LED event at frame **148** (expected 108); other bouts clean.
    Hypothesis: one stale pre-tare frame applied at `setApply(true)` before the first post-tare
    frame — would show as a one-frame flick at bout start. Not chased yet.
- The dashboard/analysis read LED state from `led-activation` events: runs made BEFORE v0.87 show
  LED off in baseline/probe (false); the truth is in each trial's `ledActivation` spec.

## Open items / tomorrow

1. **Verify the front frame on the rig** — local Studio → open the SBD YAML → Test `check_seam_front`.
   Seam straight ahead at 183 ⇒ numbers stand. Otherwise report the frame F that centres it;
   everything shifts by F−183: zone edges F±25, starts F+75 and F−75, ramps (F+25)…(F+33) and
   (F−33)…(F−25), all mod 200.
2. Decide whether the ramp should start from a floor (`baseline: 1`) to mirror p058.
3. Ask Michael to take `feat/start-frame-sbd` as a PR (link above); until then keep SBD on the local
   Studio. Also flag the 148-frame oddity to him if it recurs.
4. Commit the protocol to `cshl-2026-course/protocols/rig03-sr/` once start_frame is merged (so the
   Pages picker + Pages Studio can run it). Additive only; never delete in that repo.
5. Optional: `runtime_controls:` for `led_percent` if live intensity changes are wanted.

## 2026-09-24 addendum

- Behaviour in run `knqkkyi3`: training 79 % of frames inside the defined cool zone (chance 25 %),
  preprobe 26 %, probe 0 % (fly parked at frames 150–157 — probably stopped walking). The zone as
  defined in frames works; whether it coincides with the visual seam still needs one look at the
  arena parked on frame 183 (the `check_*` conditions are NOT listed in the Run view because it
  lists only sequence entries — use Console → Step frames, or a separate checks protocol).
- The bout-6 "148/0 frame" glitch is a stale PRE-TARE frame applied at `setApply(true)`: fixed on
  this branch (bridge 3.4 stamps frames with `epoch`, +1 per tare; the client withholds frames
  carrying the pre-tare id; `stats.stale`). Restart the bridge (banner must say 3.4) and hard-refresh
  the local Studio to pick it up.

## Commands (all from `C:\Users\rathores\Documents\GitHub\webDisplayTools`, branch `feat/start-frame-sbd`)

```
pixi run bridge     # terminal 1 — banner must end in "coupling (unwrapped heading)"
pixi run serve      # terminal 2 — then http://127.0.0.1:8000/arena_studio.html (footer v0.87)
```
Studio: Connect controller → Bridge Connect → File ▾ → Open → the SBD YAML → Test check_seam_front → Run.
Validate the YAML after edits:
```
pixi run node --import ./tests/vendor-yaml.register.mjs .claude/skills/protocol-yaml/bin/validate-protocol.mjs ../cshl-2026-course/protocols/rig03-sr/p3-sbd-placelearning-led5.yaml
```
Firmware (only if needed again): `LED-Display_G6_Firmware_Arena` → `pixi run deploy-2-10-performance`
(Studio must be disconnected from COM4 first; retry once if the write fails).
