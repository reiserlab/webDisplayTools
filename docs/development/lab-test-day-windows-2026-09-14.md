# Lab test day (Windows PC, no Claude) — Mode-3 reliability candidate, 2026-09-14

For whoever runs the bench tomorrow morning. Everything below is a command to type or a thing to look at, in order.
Budget: ~2 h for the first arena (1 h of it is the soak), ~1.5 h for the second (flash + sine + soak only).
**Streamlined 2026-09-14 09:30 ET:** the Studio runs from GitHub Pages (no local server), there is no separate smoke run (the
soak's first iteration is the smoke run), test E is dropped, test F is optional, and the benchmark table is filled by Michael
from the posted outputs. Background and the full pass criteria: `overnight-soak-test-plan-2026-09-13.md`;
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
git clone https://github.com/reiserlab/webDisplayTools.git; cd webDisplayTools        # for the bridge, simulator, pattern generator and analysis scripts
pixi install                              # Node + Python + websockets (needs pixi: https://pixi.sh)
cd ..; git clone https://github.com/reiserlab/LED-Display_G6_Firmware_Arena.git; cd LED-Display_G6_Firmware_Arena
git checkout feat/mode3-reliability
pixi install                              # PlatformIO (pinned >=6.1.19,<7), Teensy toolchain, Python, pyserial — all from pixi
```
**Do NOT `pip install platformio`** — the firmware repo is pixi-only (Frank's scheme); a pip PlatformIO next to the pixi one
gives two `pio` versions on PATH and version conflicts. Everything runs as `pixi run …` inside the firmware checkout.
The Studio itself is NOT served from this clone — use GitHub Pages (§2). Chrome or Edge (Web Serial). Use **PowerShell**,
not Git Bash, for anything with times (Git Bash prints UTC labelled ET).

## 2. Flash and identify (10 min)

```powershell
pixi run deploy-2-10-performance          # = pio run -e teensy41-2-10-performance -t upload; the pre-script finds the Teensy port
```
If the port finder picks the wrong device: `pixi run pio run -e teensy41-2-10-performance -t upload --upload-port COM5`
(COMx from Device Manager: "USB Serial Device").
Windows gotchas (fw PR #49 notes): the **first upload attempt often fails — run it again**; the arena must be powered;
if the port vanishes, unplug/replug once. Then in Chrome: **`https://reiserlab.github.io/webDisplayTools/arena_studio.html?advanced=1&soak=1`** (hard-refresh once,
Ctrl+Shift+R; the footer must read `Arena Studio v0.79`) → **Connect** → pick the Teensy port. The local FicTrac bridge
(`ws://localhost:8765`) is reachable from the Pages site — loopback is exempt from Chrome's mixed-content rule. Only if the
bridge Connect fails from Pages, serve locally instead: `pixi run python -m http.server 8092` in the webDisplayTools
checkout → `http://localhost:8092/arena_studio.html?advanced=1&soak=1`.
**Look for**, in the Console log: `firmware 781efe2b 2x10 2026-09-14 feat/mode3-reliability freerun sdfast`, then
`session rig follows the controller: cshl_g6_2x10_ball (2×10)` (v0.79) and an `sd card: … SD8GB … FAT32 4 KiB
clusters` line. If the label is not `781efe2b`, stop: wrong build. After ANY controller reset (flash, watchdog, power) glance at the arena: it should be dark; if a panel shows a glyph or the arena re-lights, send all-off from the Console (panel-side behaviour seen once on the bench).

## 3. Card check (2 min, or 10 with the one upload) — do this once per arena

Console → Arena Trial panel → SD listing → **Refresh**. Two names must be in the list (they are the only two patterns
the lab day needs; test B's drill protocol uses the bar only):

- **`p3_heisenberg_ts`** (813 KB, 200 frames — the course "bar"): on every CSHL course card, index 36. If it is missing,
  download it (no sign-in needed) from
  `https://raw.githubusercontent.com/reiserlab/cshl-2026-course/main/patterns/036_p3_heisenberg_ts.pat` and upload it
  with From local file… exactly like the sine below (or Add ▾ → From course repo… if you are signed in).
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

## 4. Bridge and simulator (2 min) — no separate smoke run

Two PowerShell windows in the webDisplayTools checkout:
```powershell
pixi run bridge -- --log-dir soak-logs
pixi run sim -- --count 0 --rate 200 --seed 1 --jump-every 100 --jump-deg 90
```
Studio: File ▾ → Open → `protocols/soak_mode3_stress.yaml` (from the clone's `protocols\` folder); rig
`cshl_g6_2x10_ball`; the FicTrac panel's Connect must go green. **This is the only protocol the lab day uses for the soak.**
Ignore the other `soak_*.yaml` files in that folder (`soak_mode2_open_loop`, `soak_mode3_closed_loop` are older campaign
protocols and need patterns that are not on the course card). Then go straight to test A — its first iteration IS the smoke
run, and the soak halts by itself on a first fault. **Look for** during each 21-min iteration: `telemetry poller … running`;
at its end the banner `stimulus quality: 20 pass · 0 flagged · 0 unknown`.

## 5. The tests (in order) and what each must show

| # | do | look for (Studio log / files) | pass |
|---|---|---|---|
| A | **Soak: ONE protocol (`soak_mode3_stress.yaml`, already open from §4) run 3 times (~1 h):** File ▾ → Soak…, `iterations 3, gap 10 s, first fault halt, then reset-continue, max resets 3`. "3 iterations" is the field in the Soak dialog, not three protocol files | `soak ended (iterations) after 3 iteration(s), 0 fault(s), 0 reset(s)`; every iteration banner `… pass · 0 flagged · 0 unknown` | 0 faults, 0 resets, 60 of 60 trials pass |
| B | **Injected stall** (checks the flagging path): in the browser console `await Studio.setSdDiag(3)`, open `protocols/mode3_drill_1trial.yaml` and run it as a 1-iteration Soak (File ▾ → Soak…, iterations 1), then `await Studio.setSdDiag(0)` | during the run: `display gap NN ms (sd_slow, body) in trial …` lines; at the end `⚠ stimulus quality: … flagged`; after `setSdDiag(0)`, Console identity shows `sd diag 0` | at least one trial flagged; the soak did NOT stop; switches back to 0 |
| C | **Simulator kill:** during a Soak (start a 2-iteration soak), close the sim window for 30 s, restart it | `soak: no FicTrac frames — waiting for the simulator`, then the next iteration starts | soak resumes by itself; no fault counted |
| D | **Link drop:** during a trial pull the controller's USB cable, wait 5 s, plug it back | `run ended by a link drop … treating as a controller event`; post-mortem lines (`confirm`, `probe`, `reconnect`); the run's outcome `CONTROLLER_FAULT`. The controller is powered from the arena supply, so it does NOT reset: the panels keep the last stimulus until the next trial or an all-off (bench 2026-09-13). If the Studio asks for the port again, pick the Teensy — on the bench it reconnected by itself | reconnects; next iteration runs |
| F | **Optional — only if you have a course-repo token:** sign in to the course repo (Settings), open rig1 `p3-heisenberg-ts-full.yaml`, run it once as a Test run (simulator running) | it runs to the end exactly as in July; banner `… pass`; the run log has `trial_quality` and `run_metadata.firmware` = `781efe2b …` | completes, all trials pass |

(Test E, a panel firmware update under the watchdog, is dropped from the lab day — it needs a spare panel and is covered by
the bench.) **Second arena:** repeat §2 (flash), §3 (sine upload) and test A only.

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

Zip `soak-logs\` and post the three outputs (and anything red, with the local time) in the lab-day Slack thread; Michael
moves them to webDisplayTools #201 / firmware PR #56 (a wedge goes to #197, an SD stall to firmware #54). Do not post to
firmware #50 or PJRC.

## 7. Cross-machine timing benchmark (macOS bench vs lab PC) — small, but keep it

Same controller, same card, same protocol, same simulator flags, three iterations on each machine. The controller-side
numbers must NOT change with the host; the host-side ones may — that difference is the benchmark.

| metric | source | macOS (2026-09-13 night) | Windows lab PC | expect |
|---|---|---|---|---|
| host round trip `a`-row dt p50 / p99 | `wedge-scan.py` | 3 / 4–11 ms (29 iterations; one 271 ms browser outlier) | 3 / 19–24 ms (test A iterations 1 and 3); **iteration 2 and every 09-15 drill ran at 60–120 ms after the first ~30 s** (host-side, see §7.1) | Windows USB-CDC often +1–3 ms; p99 must stay ≤ 11 ms |
| request→display `req_age_us` p50 / p99 / max | `telemetry-report.py` | 1.75 / 2.56 / 4.83 ms | 1.62 / 2.56 / 4.83 ms (one 21 ms card read excluded) | same on both (controller-side) |
| SD read cost +1 / random (p50, max) | `telemetry-report.py` | 0.62 / 1.39–1.46 ms, max 1.8 (sine / bar) | 0.62 / 1.16 ms, max 1.51 (both patterns, 4 KiB-cluster course card sn 000014ca) | same on both |
| drainer dropped / gaps / notStored | `runlog-check.py` (`drainer:`) | 0 / 0 / 0 (29 iterations) | 0 / 0 / 1 (one not-stored ack on the day's session) | 0 / 0 / 0; Chrome background-tab throttling is the usual culprit — keep the Studio tab visible |
| FicTrac rows per command | `runlog-check.py` (`fictrac_per_cmd`) | 1.32 (includes the 10 s gaps) | 1.51 (iter 1) / 4.03 (iter 3, includes idle tail); 23 in the slow iteration | ≈ 1.0–1.3 |
| commands accepted per iteration | `runlog-check.py` (`a_ok`) | 231–241 k | 165 938 / 174 025 (iter 1 / 3) — ≈ 30 % fewer than the Mac: the Windows host coalesces more frames per command | within 2 % |
| trials pass / flagged / unknown | banner / `trial_quality` | 20 / 0 / 0 (one iteration 19 / 1 / 0) | 59 / 1 / 0 over the 3 iterations (the flag: one 20.9 ms sine read, trial 1 of iteration 1) | 20 / 0 / 0 |

Windows column filled 2026-09-15 13:52 ET from Isabel's `soak-logs.zip` (TEST-MAP.md + the three analysis outputs).

### 7.1 Open host-side finding (Windows lab PC)

In test A iteration 2 and in every 09-15 drill run, the host round trip rose from 3 ms to 60–120 ms within the first
~30 s of the run and stayed there (command rate ≈ 9 Hz while FicTrac kept 200 Hz; controller-side `req_age` max 4.8 ms
throughout, so the controller is not involved). It is **not** Chrome background-tab throttling: the telemetry poller kept its
100 ms cadence in the slow state (a hidden tab would clamp it to 1 s). The poller's period stretched to ~150 ms, which points at
the page's main thread or the USB path on that PC being busy. Iterations 1 and 3 ran 21 min each at 3 ms. Same slow state made
the test-D attempt-2 post-mortem declare `self-reset-failed` on 36–80 ms probe replies (identity OK, every probe status 0).
To characterise on the PC (2 min each): Chrome Task Manager CPU of the Studio tab during a drill; the drill with the Console
log collapsed; a different USB port / no hub; `pixi run sim` on its own core. Until then, treat RTT numbers from that PC as
provisional.

## 8. Optional browser-free path (if the Studio misbehaves on the PC)

In the firmware checkout: `pixi run python scripts\sd_stall_test.py --port COM5 --pattern 46 --hz 200 --minutes 10 --sd-diag 0`
(then `--pattern 36`). Same analysis with `telemetry-report.py` on `soak-logs\sdstall-*.jsonl`. This tests the
controller and card, not the Studio.
