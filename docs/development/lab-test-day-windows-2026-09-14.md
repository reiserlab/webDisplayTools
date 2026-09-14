# Lab test day (Windows PC, no Claude) — Mode-3 reliability candidate, 2026-09-14

For whoever runs the bench tomorrow morning. Everything below is a command to type or a thing to look at, in order.
Budget: ~2.5 h including a 1 h soak. Background and the full pass criteria: `overnight-soak-test-plan-2026-09-13.md`;
what changed and why: `mode3-reliability-handoff-2026-09-14.md`.

## 0. Before you start (Michael)

- [x] Firmware branch **`feat/mode3-reliability`** pushed (18:55 ET) — merge-candidate PR
      [reiserlab/LED-Display_G6_Firmware_Arena#56](https://github.com/reiserlab/LED-Display_G6_Firmware_Arena/pull/56)
      against `main` (Frank's per-board scheme + a 2×10 variant); the lab builds the SAME identity from it
      (`781efe2` is compiled in from git).
- [ ] The CSHL 2×10 controller + its bench card (patterns 36 = bar, 46 = sine already on it) travel to the lab PC,
      or plan 10 extra minutes to upload the two patterns (step 3).
- [x] Overnight results from the Mac in §6 of the hand-off document (the reference numbers for §7 below).
- [x] Studio: PRs #198 + #202 squash-merged to `main` 2026-09-14 06:55 ET (main = `6c4edb2` v0.76 + `6e484cd` v0.79); revert is one
      `git revert` per commit if the lab finds a problem.

## 1. Install (once, ~15 min)

```powershell
git clone https://github.com/reiserlab/webDisplayTools.git; cd webDisplayTools        # Studio v0.79 is on main (merged 2026-09-14 06:55 ET)
pixi install                              # Node + Python + websockets (needs pixi: https://pixi.sh)
cd ..; git clone https://github.com/reiserlab/LED-Display_G6_Firmware_Arena.git; cd LED-Display_G6_Firmware_Arena
git checkout feat/mode3-reliability
pip install platformio pyserial          # or the PlatformIO VS Code extension; Teensy Loader comes with PlatformIO
```
Chrome or Edge (Web Serial). Use **PowerShell**, not Git Bash, for anything with times (Git Bash prints UTC labelled ET).

## 2. Flash and identify (10 min)

```powershell
pio run -e teensy41-2-10-performance -t upload --upload-port COM5   # 2×10 variant; find COMx in Device Manager: "USB Serial Device"
```
Windows gotchas (fw PR #49 notes): the **first upload attempt often fails — run it again**; the arena must be powered;
if the port vanishes, unplug/replug once. Then in Chrome: `pixi run python -m http.server 8092` in the webDisplayTools
checkout → `http://localhost:8092/arena_studio.html?advanced=1&soak=1` → **Connect** → pick the Teensy port.
**Look for**, in the Console log: `firmware 781efe2b 2x10 2026-09-14 feat/mode3-reliability freerun sdfast`, then
`session rig follows the controller: cshl_g6_2x10_ball (2×10)` (v0.79) and an `sd card: … SD8GB … FAT32 4 KiB
clusters` line. If the label is not `781efe2b`, stop: wrong build. After ANY controller reset (flash, watchdog, power) glance at the arena: it should be dark; if a panel shows a glyph or the arena re-lights, send all-off from the Console (panel-side behaviour seen once on the bench).

## 3. Card check (2 min, or 10 with the one upload) — do this once per arena

Console → Arena Trial panel → SD listing → **Refresh**. Two names must be in the list:

- **`p3_heisenberg_ts`** (813 KB, 200 frames — the course "bar"): on every CSHL course card, index 36. If it is missing
  the card is not a course card — Add ▾ → Single pattern → **From course repo…** → `patterns/036_p3_heisenberg_ts.pat`
  (needs the course sign-in), or copy that file from the course repo and use From local file… as below.
- **`sine_2000f_gs16`** (8 MB, 2000 frames): NOT on course cards. Make it and upload it:
  1. In the webDisplayTools checkout: `pixi run node scripts/make-stress-patterns.js --only sine` → writes
     `soak-patterns\sine_2000f_gs16.pat` (≈ 8 MB) and prints the re-parsed frame count (2000).
  2. Studio Console, connected, display stopped (**■ Stop**): SD listing → **Add ▾ → Single pattern (.pat) → From
     local file…** → pick that file. Log: `SD upload: 1 file(s)…` then `SD upload done: 1/1` (about a minute).
  3. **Refresh** the listing; `sine_2000f_gs16` appears (index = its place in the sorted filenames, the number does not
     matter — protocols resolve names). Click it, **↻ info** → 2000 frames, GS16.
  4. **Play it once** (10 s): Arena Trial → mode `2 · play`, rate 100, duration 10 → **▶ Start**. A sine grating rolls
     around the arena, no glyph, no error line in the log.
  5. **Contiguity is checked for you** in the first run (§4): `telemetry-report.py` must print `layout: contiguous` for
     both patterns; if the sine says fragmented, delete it from the card and upload again (a one-pass upload is contiguous).

If a run's log ever says `… not on the SD by name — the run will fall back to the numeric pattern_ID`, the upload did not
land or the name differs: stop and redo this step, do not run the tests on the fallback pattern.

## 4. Bridge, simulator, one smoke run (10 min)

Two PowerShell windows in the webDisplayTools checkout:
```powershell
pixi run bridge -- --log-dir soak-logs
pixi run sim -- --count 0 --rate 200 --seed 1 --jump-every 100 --jump-deg 90
```
Studio: File ▾ → Open → `protocols/soak_mode3_stress.yaml`; rig `cshl_g6_2x10_ball`; Run (Test is fine).
**Look for** during the 21 min: the Console log line `telemetry poller … running`; at the end the banner
`stimulus quality: 20 pass · 0 flagged · 0 unknown`. Anything flagged or unknown → keep the log, note the time, go on.

## 5. The tests (in order) and what each must show

| # | do | look for (Studio log / files) | pass |
|---|---|---|---|
| A | **Soak, 3 iterations (~1 h):** File ▾ → Soak…, `iterations 3, gap 10 s, first fault halt, then reset-continue, max resets 3` | `soak ended (iterations) after 3 iteration(s), 0 fault(s), 0 reset(s)`; every iteration banner `… pass · 0 flagged · 0 unknown` | 0 faults, 0 resets, 60 of 60 trials pass |
| B | **Injected stall** (checks the flagging path): in the browser console `await Studio.setSdDiag(3)`, open `protocols/mode3_drill_1trial.yaml` and run it as a 1-iteration Soak (File ▾ → Soak…, iterations 1), then `await Studio.setSdDiag(0)` | during the run: `display gap NN ms (sd_slow, body) in trial …` lines; at the end `⚠ stimulus quality: … flagged`; after `setSdDiag(0)`, Console identity shows `sd diag 0` | at least one trial flagged; the soak did NOT stop; switches back to 0 |
| C | **Simulator kill:** during a Soak (start a 2-iteration soak), close the sim window for 30 s, restart it | `soak: no FicTrac frames — waiting for the simulator`, then the next iteration starts | soak resumes by itself; no fault counted |
| D | **Link drop:** during a trial pull the controller's USB cable, wait 5 s, plug it back | `run ended by a link drop … treating as a controller event`; post-mortem lines (`confirm`, `probe`, `reconnect`); the run's outcome `CONTROLLER_FAULT`. The controller is powered from the arena supply, so it does NOT reset: the panels keep the last stimulus until the next trial or an all-off (bench 2026-09-13). If the Studio asks for the port again, pick the Teensy — on the bench it reconnected by itself | reconnects; next iteration runs |
| F | **An old course protocol runs unchanged:** sign in to the course repo (Settings), open rig1 `p3-heisenberg-ts-full.yaml`, run it once as a Test run (simulator running) | it runs to the end exactly as in July; banner `… pass`; the run log has `trial_quality` and `run_metadata.firmware` = `781efe2b …` | completes, all trials pass |
| E | **Panel firmware update still works with the watchdog** (5 min, only if a spare panel/known-good image is at hand): Console → Firmware → program one panel | progress completes; no controller reboot mid-update (the Console would show a disconnect) | update completes |

Never power-cycle the controller after something odd: the evidence is in RAM until the Studio's post-mortem has read it.

## 6. Analysis (5 min) — all three must be clean

```powershell
pixi run python scripts/wedge-scan.py soak-logs\
pixi run python scripts/runlog-check.py soak-logs\arena-log-*.jsonl*
pixi run python scripts/telemetry-report.py soak-logs\arena-log-*.jsonl*
```
- `wedge-scan`: **0 faults, 0 resets**, RTT p99 ≤ 11 ms.
- `runlog-check`: every file `OK` (metadata, `trial_quality` after the last controller row, command counts equal,
  drainer gaps/notStored/errors 0). The test-B file is allowed `flagged`; test D's file must say `CONTROLLER_FAULT`.
- `telemetry-report`: **0 SD reads > 10 ms** outside test B; `req_age_us` max < 10 ms; per-read cost ≈ 0.62 ms (+1) /
  ≤ 1.8 ms (random) for BOTH patterns; every trial's `layout: contiguous`.

Zip `soak-logs\` and post the three outputs (and anything red, with the local time) to webDisplayTools #201 (or #197
for a wedge, firmware #54 for an SD stall). Do not post to firmware #50 or PJRC.

## 7. Cross-machine timing benchmark (macOS bench vs lab PC) — small, but keep it

Same controller, same card, same protocol, same simulator flags, three iterations on each machine. The controller-side
numbers must NOT change with the host; the host-side ones may — that difference is the benchmark.

| metric | source | macOS (2026-09-13 night) | Windows lab PC | expect |
|---|---|---|---|---|
| host round trip `a`-row dt p50 / p99 | `wedge-scan.py` | 3 / 4–11 ms (29 iterations; one 271 ms browser outlier) | | Windows USB-CDC often +1–3 ms; p99 must stay ≤ 11 ms |
| request→display `req_age_us` p50 / p99 / max | `telemetry-report.py` | 1.75 / 2.56 / 4.83 ms | | same on both (controller-side) |
| SD read cost +1 / random (p50, max) | `telemetry-report.py` | 0.62 / 1.39–1.46 ms, max 1.8 (sine / bar) | | same on both |
| drainer dropped / gaps / notStored | `runlog-check.py` (`drainer:`) | 0 / 0 / 0 (29 iterations) | | 0 / 0 / 0; Chrome background-tab throttling is the usual culprit — keep the Studio tab visible |
| FicTrac rows per command | `runlog-check.py` (`fictrac_per_cmd`) | 1.32 (includes the 10 s gaps) | | ≈ 1.0–1.3 |
| commands accepted per iteration | `runlog-check.py` (`a_ok`) | 231–241 k | | within 2 % |
| trials pass / flagged / unknown | banner / `trial_quality` | 20 / 0 / 0 (one iteration 19 / 1 / 0) | | 20 / 0 / 0 |

Write the Windows column into this file and commit it on the branch (no Prettier on HTML; this is Markdown).

## 8. Optional browser-free path (if the Studio misbehaves on the PC)

In the firmware checkout: `python scripts\sd_stall_test.py --port COM5 --pattern 46 --hz 200 --minutes 10 --sd-diag 0`
(then `--pattern 36`). Same analysis with `telemetry-report.py` on `soak-logs\sdstall-*.jsonl`. This tests the
controller and card, not the Studio.
