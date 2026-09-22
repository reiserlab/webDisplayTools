# Lab-PC handover — 2026-09-22: bring the rig to Studio v0.86 / bridge 3.3 and run the coupling × bias fly test

**Written for a fresh Claude Code session (or a human) on the lab PC.** It has no access to the
Mac session that did today's work; everything it needs is here or in the linked docs. State of
`reiserlab/webDisplayTools` `main` when this was written: **`dee5deb`** (Studio **v0.86**, bridge **3.3**).
GitHub Pages already serves v0.86 (deploy of `dee5deb` succeeded 20:38 UTC).

## 0. What changed today and why it matters on the rig

| Merged | What | Rig impact |
|---|---|---|
| #211 → Studio **v0.85**, bridge **3.3** | Closed-loop **`coupling`** (dimensionless, `-1` = the natural loop on the fly-on-ball rigs) replaces `gain`; heading is kept **unwrapped**, so fractional couplings no longer jump once per revolution; bias is defined in display degrees and is NOT flipped by a negative coupling | **The bridge must be restarted on 3.3.** A 3.2 bridge runs every coupling as 1:1 (the Studio warns). `gain: ±1.8` still runs (deprecation warning); any other `gain` is refused |
| cshl-2026-course #1 | All 37 course protocols migrated `gain` → `coupling` | Nothing to do; pull the course repo if it is cloned on the PC |
| #212 → Studio **v0.86** | LED activation = graded zones with linear ramps (`baseline`, `zones[{level, ramp_in, ramp_out}]`); `hysteresis` accepted + warned + ignored | Only matters for `led_activation` protocols; photodiode bench check still pending (§6) |

Full reference: `docs/development/closed-loop-bias.md` (coupling/bias semantics + bridge math),
`docs/development/arena-studio-release-notes.md` (v0.85, v0.86),
`docs/development/conditional-led-activation.md` (LED zones), `docs/development/model-fly-bench.md`
(hardware-free dry runs), `docs/development/telemetry-logging-reference.md` (run-log format).

## 1. Update the PC's clone (3 commands)

In the `webDisplayTools` clone (PowerShell or Git Bash):

```bash
git checkout main && git pull --ff-only && git log --oneline -1
```
Expect `dee5deb feat(led): graded LED zones with linear ramps replace hysteresis — Studio v0.86 (#212)`.
If `--ff-only` refuses (local edits / a stale branch), stop and report what `git status` shows — do not
reset anything that might be someone's uncommitted work.

```bash
pixi install
```
The lockfile changed on 2026-09-21 (#209/#210: the simulator gained the model fly; the bridge env pins
moved). This is a no-op if already current.

```bash
pixi run bridge
```
Banner MUST read **`bridge 3.3 · behavior_v2 (…) + bias waveforms + heading tare + coupling (unwrapped heading)`**,
`proto=udp, fictrac_port=60000, frames=200, coupling=1, deg_per_frame=1.8`. If it says 3.2 the pull did not
land, or an OLD bridge is still running — only one process can bind UDP 60000 / WS 8765; close it. Leave the
new bridge running in its own terminal for the whole session.

Windows gotchas (from earlier lab days): Git Bash has no tzdata — never stamp a footer with `date` there
(irrelevant unless editing HTML); the first Teensy upload attempt sometimes fails — re-run (fw #49); pixi
tasks run fine from PowerShell.

## 2. Studio v0.86 in the browser

Open `https://reiserlab.github.io/webDisplayTools/arena_studio.html` and **hard-refresh (Ctrl+Shift+R)**.
The footer must read **`Arena Studio v0.86 | 2026-09-22 00:50 ET`**. A normal reload can keep v0.85's
cached ES modules under a v0.86 page (the catastrophic-import gotcha) — if anything looks half-dead
(empty dropdowns), hard-refresh again or clear site data.

- **Connect** the controller. The top-bar firmware chip shows the controller build (`GET_FIRMWARE_VERSION`).
  CSHL 2×10 controllers should read `781efe2b 2x10 … feat/mode3-reliability` (or the `arena-2x10-local`
  tip). If the label has no `sdfast`/`freerun`, the controller is pre-fw-#56 — the fly test still runs, you
  just lack the SD fast path / watchdog. Flashing recipe, if wanted: fw repo `LED-Display_G6_Firmware_Arena`,
  branch `feat/mode3-reliability` (PR #56), `pio run -e teensy41-2-10-performance -t upload`. **Do NOT build
  fw `main` for a 2×10 arena** — main only has the 4×10 (`ARENA_HW_10_10`) and 4×12 variants and rejects
  every 2×10 pattern.
- Session rig (top bar): **CSHL G6 — 2×10 fly-on-ball (FicTrac)**. It supplies the display pitch (1.8°/frame).
- Run view → **Bridge Connect**: must show *bridge 3.3*. Frames start counting once FicTrac (or the sim)
  sends UDP to port 60000.

## 3. FicTrac (or the model-fly simulator)

FicTrac must emit its data socket to **UDP 127.0.0.1:60000** (the protocol's `fictrac` plugin config:
`bridge_url: ws://localhost:8765`, `fictrac_port: 60000`, `proto: udp`). Nothing else changed on that side.

Dry run without a fly (second terminal):
```bash
pixi run sim -- --model fly --kp 2 --frame-dir -1
```
A fixating model fly for a −1 rig: it watches the bridge's frames and closes the loop for real, so bias
rejection / frontal-fraction numbers come out meaningful. `--kp 0` gives a random wanderer.

## 4. Run the protocol: `fictrac_coupling_bias_fly_test`

- File ▾ → Open from library → **Closed-loop coupling × bias — fly test (Mode 3, natural coupling −1, ~13 min)**,
  or open `arena_studio.html?p=fictrac_coupling_bias_fly_test` (lands in Run).
- **Pattern needed: SD index 4 = `frame2_h_ccw_200f`** (200-frame full-azimuth rotation; standard card slot 4).
  The Console's SD listing shows it after Connect. If missing, upload `patterns/g6_2x10/patterns/004_frame2_h_ccw_200f.pat`
  from the Console (the protocol pins `pattern_ID: 4`).
- Fill **experimenter** and **genotype** (controlled lists), then **▶ Run experiment**. Safe mode is fine
  (no `?advanced=1` needed). ≈ 13 min: 20 s closed-loop trials, 5 s dark ITI, 2 reps, randomized.
- Blocks: A coupling only (−1 / −0.75 / −1.25 / +1) · B bias at −1 (constant ±30 °/s, sine 30 @ 0.25 Hz,
  sine 60 @ 0.5 Hz, square 30 @ 0.25 Hz) · C bias × coupling (−0.75 / −1.25 + constant 30 or sine 30) +
  **coupling 0 + constant 30** (open-loop replay control) · a −1 baseline at start and end.
- The run log auto-commits to the course repo as `runlogs/<bench>/<name>.jsonl.gz` when the Studio is
  signed in (token stored); otherwise use File ▾ → download the run log.

What you should SEE during the run: at coupling −1 the pattern counter-rotates the fly's turns 1:1; at +1
it runs away with the fly; with a constant bias the display drifts at 30 °/s (one revolution per 12 s)
while the fly counter-turns; the coupling-0 trials drift regardless of the fly. **No once-per-revolution
jump** at −0.75 / −1.25 (the old `gain` bug) — if you see one, the bridge is not 3.3.

## 5. Report

```bash
pixi run python scripts/closed-loop-report.py <runlog.jsonl.gz> --svg cl.svg
```
Per trial: fly turning, feature **frontal fraction**, reconstructed bias, **rejection index** (normalized by
the coupling; `—` at coupling 0), and an **idx-consistency** check (reconstructed vs logged frame index —
should be ~0 % mismatch on 3.3). Expect: high frontal fraction at −1 / −0.75 / −1.25 and none at +1;
rejection ≈ 1 on constant bias, 0.2–0.6 on sine; steady drift + `—` on the coupling-0 control. Yesterday's
model-fly run of exactly this protocol: 56 steps, 0 errors, 0 % idx mismatch, natural/under/over fixate
89–100 %, reversed 10–31 %.

## 6. Optional: LED graded-zones bench gate (#212)

Protocol `led_activation_quadrant_test` (~2 min, same pattern 4, BuckPuck LED on Analog Out, photodiode on
the LED). Conditions 3–4 ramp the LED over 10 frames and hold a dim 2 % baseline with a brighter probe zone
wrapping through frame 0. Pass = photodiode trace monotone through the ramps with no flicker, and the `cf`
rows' max `req_age_us` unchanged vs the hard-edged conditions 1–2 (`scripts/telemetry-report.py`). Recipe
and semantics: `docs/development/conditional-led-activation.md`.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bridge banner 3.2 | old checkout or old bridge process; `git pull`, kill the old bridge, `pixi run bridge` |
| Studio warns "bridge … predates coupling" | same — bridge 3.2 runs 1:1 whatever the protocol says |
| "closed loop not started: unknown frame count for pattern idx 4" | pattern 4 not on the SD (or the controller lacks `GET_PATTERN_INFO` 0x88) — upload the `.pat`; check the firmware chip |
| Run refused: "gain … retired" banner | protocol still carries a non-±1.8 `gain` — replace with `coupling` (library + course protocols are already migrated) |
| `TRIAL_PARAMS: load failed` / CE_ARENA_MISMATCH | controller flashed from fw `main` (4×10 build) — reflash from `feat/mode3-reliability` 2-10 env |
| Frames counter stays 0 after Bridge Connect | FicTrac not sending to UDP 60000 on THIS machine, or the Studio's plugin config re-bound the bridge to another port — check the bridge terminal's `[in] UDP listening` line |
| Report says idx mismatch ≫ 0 % | log from a 3.2 bridge, or the epoch's tare/bias push was missed — re-run on 3.3 |

## 8. Report back

Paste to Michael (or into the course Slack): the three banners (git log line, bridge banner, Studio footer),
the firmware chip label, the run-log filename, and the report's summary table (or `cl.svg`). If anything in
§7 hit, include the exact message.

## 9. Not in scope here

The "older" 2×10 bench arena on Michael's Mac was flashed today (controller → fw #56 tip `781efe2b`,
all 18 panels → active-LOW EINT `v0.3.1` build for a 2P external-trigger test). That is a different arena;
nothing about it applies to the lab rig.
