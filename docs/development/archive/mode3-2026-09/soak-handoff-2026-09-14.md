# Overnight soak hand-off — consolidated Mode-3 build (2026-09-14)

Lab morning on a Windows PC, step by step, no Claude: `lab-test-day-windows-2026-09-14.md`.

One page. Everything built since Friday 2026-09-11 is under test at once: controller health (0xCA/0xCB), the
telemetry ring, the hardware watchdog, the free-running refresh timer (the fw #50 "ISR guard"), and the SD fast
path. If the overnight run is clean, these are the branches to merge.

## What to flash / serve

| piece | where | identity |
|---|---|---|
| firmware | `reiserlab/LED-Display_G6_Firmware_Arena` branch `feat/sd-fastpath-2x10`, commit **`e59767e`** (2×10 bench branch; fast-forwards `arena-2x10-local`; = `75405ee` + the whole-stack review fixes) | `pio run -e teensy41-performance` → `.pio/build/teensy41-performance/firmware.hex`; Studio shows the label `e59767e5 2x10 … freerun sdfast` |
| Studio | `reiserlab/webDisplayTools` PR #198 (v0.76) + PR #202 (v0.78, branch `claude/mode3-perf-sd`) | serve the branch locally: `python3 -m http.server 8092` in the checkout, open `http://localhost:8092/arena_studio.html?advanced=1&soak=1` |
| bridge + simulator | same checkout | `pixi run bridge -- --log-dir soak-logs` · `pixi run sim -- --count 0 --rate 200 --seed 1 --jump-every 100 --jump-deg 90` |

Flash only with the Studio disconnected (port free): `scripts/flash_bootloader_route.sh` in the firmware repo.
After connecting, the Studio's firmware label must end in `freerun sdfast`; **never power-cycle the controller
after a fault before the post-mortem has finished** (it drains the ring and the crash report — that is the evidence).

## Card contents (once)

Upload `soak-patterns/sine_2000f_gs16.pat` (8.1 MB, from `pixi run node scripts/make-stress-patterns.js`) — either
browser-free, `python3 scripts/sd_upload_pat.py --port … --file … --name sine_2000f_gs16.pat` in the firmware repo
(prints the index and frame count), or through the Studio Console. `frame2_h_ccw_200f` (813 KB, index 36 on the
bench card) must already be on the card. Patterns are numbered by sorted filename: after ANY upload re-check the
indices you use (`GET_PATTERN_INFO` frame counts: 200 for the bar, 2000 for the sine). The first segment's report
must show `layout: contiguous` for both files.

## Two ways to run the soak

- **Browser-free (what ran on 2026-09-13, recommended for unattended nights):** in the firmware repo
  `scripts/sd_soak_campaign.sh PORT "<sine idx> 36" 286 1815 200 0800 10` — 10-min Mode-3 segments alternating the
  two patterns with a random walk + 90° jumps, 286 Hz until 18:15 then 200 Hz until 08:00; per-segment logs
  `soak-logs/sdstall-*-camp-*.jsonl`, one line per segment in `soak-logs/campaign-*.log`. Survives a controller
  reboot; needs no bridge, simulator or browser. Report: `telemetry-report.py soak-logs/sdstall-*-camp-*.jsonl`.
- **Studio path (produces run logs with per-trial verdicts, the format the course pipeline commits):** the runs
  below.

## Runs, in order

1. **Causal arms** (~70 min, Michael/Claude): `docs/development/sd-stall-causal-test-plan-2026-09-13.md` §3.
2. **2 h stress**: simulator at `--rate 286`, protocol `protocols/soak_mode3_stress.yaml`, File ▾ → Soak… with
   `hours: 2`, first fault `halt`, then `reset-continue`.
3. **Overnight**: simulator at `--rate 200`, same protocol, `hours: 10`, same fault policy.

## What "clean" means

- `pixi run python scripts/wedge-scan.py soak-logs/` → **0 controller faults, 0 resets** (the watchdog never fired,
  no `timer_fail`), every iteration `completed`.
- `pixi run python scripts/telemetry-report.py soak-logs/arena-log-*.jsonl` → **0 SD reads > 10 ms**, every trial
  `pass`; `req_age_us` max < 10 ms at 200 Hz (5 ms is the target; a few 5–10 ms frames at 286 Hz are expected and
  are a refresh-coalescing finding, not an SD one). `unknown` trials mean telemetry coverage dropped — report it,
  do not count it as a failure.
- Anything else: keep the logs, note the ET time, post to firmware #54 (SD) or webDisplayTools #197 (wedge) with the
  `telemetry-report.py` output. Do not post to firmware #50 or PJRC (Michael owns those threads).

## After a clean night

Merge order: web #198 → #202. Firmware: `feat/sd-fastpath-2x10` fast-forwards `arena-2x10-local` (the branch the
CSHL controllers run); the port to `main` (per-board `-DARENA_HW_*` layout) is a separate PR that supersedes #53.
