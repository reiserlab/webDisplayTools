# Lab test day (Windows PC, no Claude) — Mode-3 reliability candidate, 2026-09-14

For whoever runs the bench tomorrow morning. Everything below is a command to type or a thing to look at, in order.
Budget: ~2.5 h including a 1 h soak. Background and the full pass criteria: `overnight-soak-test-plan-2026-09-13.md`;
what changed and why: `mode3-reliability-handoff-2026-09-14.md`.

## 0. Before you start (Michael)

- [ ] Firmware branch `feat/sd-fastpath-2x10` pushed to GitHub (it is still local on Michael's machine) — the lab
      builds the SAME identity from it (`e59767e5` is compiled in from git).
- [ ] The CSHL 2×10 controller + its bench card (patterns 36 = bar, 46 = sine already on it) travel to the lab PC,
      or plan 10 extra minutes to upload the two patterns (step 3).
- [ ] Overnight results from the Mac pasted into §6 of the hand-off document (the reference numbers for §5 below).

## 1. Install (once, ~15 min)

```powershell
git clone https://github.com/reiserlab/webDisplayTools.git; cd webDisplayTools; git checkout claude/mode3-perf-sd
pixi install                              # Node + Python + websockets (needs pixi: https://pixi.sh)
cd ..; git clone https://github.com/reiserlab/LED-Display_G6_Firmware_Arena.git; cd LED-Display_G6_Firmware_Arena
git checkout feat/sd-fastpath-2x10
pip install platformio pyserial          # or the PlatformIO VS Code extension; Teensy Loader comes with PlatformIO
```
Chrome or Edge (Web Serial). Use **PowerShell**, not Git Bash, for anything with times (Git Bash prints UTC labelled ET).

## 2. Flash and identify (10 min)

```powershell
pio run -e teensy41-performance -t upload --upload-port COM5      # find COMx in Device Manager: "USB Serial Device"
```
Windows gotchas (fw PR #49 notes): the **first upload attempt often fails — run it again**; the arena must be powered;
if the port vanishes, unplug/replug once. Then in Chrome: `pixi run python -m http.server 8092` in the webDisplayTools
checkout → `http://localhost:8092/arena_studio.html?advanced=1&soak=1` → **Connect** → pick the Teensy port.
**Look for**, in the Console log: `firmware e59767e5 2x10 2026-09-13 feat/sd-fastpath-2x10 freerun sdfast` and an
`sd card: … SD8GB … FAT32 4 KiB clusters` line. If the label is not `e59767e5`, stop: wrong build.

## 3. Card check (2 min, or 10 with uploads)

Console → the SD listing must show `frame2_h_ccw_200f` (200 frames) and `sine_2000f_gs16` (2000 frames). If not:
`pixi run node scripts/make-stress-patterns.js` writes both into `soak-patterns\`; upload them from the Console
(SD upload) with the display stopped. Indices are by sorted filename; the protocol resolves names, so numbers don't matter.

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
| B | **Injected stall** (checks the flagging path): in the browser console `await Studio.setSdDiag(3)`, run ONE Test run of the stress protocol, then `await Studio.setSdDiag(0)` | during the run: `display gap NN ms (sd_slow, body) in trial …` lines; at the end `⚠ stimulus quality: … flagged`; after `setSdDiag(0)`, Console identity shows `sd diag 0` | at least one trial flagged; the soak did NOT stop; switches back to 0 |
| C | **Simulator kill:** during a Soak (start a 2-iteration soak), close the sim window for 30 s, restart it | `soak: no FicTrac frames — waiting for the simulator`, then the next iteration starts | soak resumes by itself; no fault counted |
| D | **Link drop:** during a trial pull the controller's USB cable, wait 5 s, plug it back | `run ended by a link drop … treating as a controller event`; post-mortem lines (`confirm`, `probe`, `reconnect`); the run's outcome `CONTROLLER_FAULT`; the arena goes **dark** on replug and stays dark until the next trial | reconnects without a page reload; next iteration runs |
| F | **An old course protocol runs unchanged:** sign in to the course repo (Settings), open rig1 `p3-heisenberg-ts-full.yaml`, run it once as a Test run (simulator running) | it runs to the end exactly as in July; banner `… pass`; the run log has `trial_quality` and `run_metadata.firmware` = `e59767e5 …` | completes, all trials pass |
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
| host round trip `a`-row dt p50 / p99 | `wedge-scan.py` | fill in from the overnight | | Windows USB-CDC often +1–3 ms; p99 must stay ≤ 11 ms |
| request→display `req_age_us` p50 / p99 / max | `telemetry-report.py` | 1.7 / 2.6 / ~3 ms | | same on both (controller-side) |
| SD read cost +1 / random (p50, max) | `telemetry-report.py` | 0.62 / 1.46 ms, max 1.8 | | same on both |
| drainer dropped / gaps / notStored | `runlog-check.py` (`drainer:`) | | | 0 / 0 / 0; Chrome background-tab throttling is the usual culprit — keep the Studio tab visible |
| FicTrac rows per command | `runlog-check.py` (`fictrac_per_cmd`) | ≈ 1.0 during trials | | ≈ 1.0 |
| commands accepted per iteration | `runlog-check.py` (`a_ok`) | ≈ 240 k | | within 2 % |
| trials pass / flagged / unknown | banner / `trial_quality` | 20 / 0 / 0 | | 20 / 0 / 0 |

Write the Windows column into this file and commit it on the branch (no Prettier on HTML; this is Markdown).

## 8. Optional browser-free path (if the Studio misbehaves on the PC)

In the firmware checkout: `python scripts\sd_stall_test.py --port COM5 --pattern 46 --hz 200 --minutes 10 --sd-diag 0`
(then `--pattern 36`). Same analysis with `telemetry-report.py` on `soak-logs\sdstall-*.jsonl`. This tests the
controller and card, not the Studio.
