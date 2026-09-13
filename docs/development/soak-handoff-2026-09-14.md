# Overnight soak hand-off — consolidated Mode-3 build (2026-09-14)

One page. Everything built since Friday 2026-09-11 is under test at once: controller health (0xCA/0xCB), the
telemetry ring, the hardware watchdog, the free-running refresh timer (the fw #50 "ISR guard"), and the SD fast
path. If the overnight run is clean, these are the branches to merge.

## What to flash / serve

| piece | where | identity |
|---|---|---|
| firmware | `reiserlab/LED-Display_G6_Firmware_Arena` branch `feat/sd-fastpath-2x10`, commit **`75405ee`** (2×10 bench branch; fast-forwards `arena-2x10-local`) | `pio run -e teensy41-performance` → `.pio/build/teensy41-performance/firmware.hex`, sha256 starts `5d912915dd0982d9`; Studio shows the label `75405ee 2x10 … freerun sdfast` |
| Studio | `reiserlab/webDisplayTools` PR #198 (v0.76) + PR #202 (v0.77, branch `claude/mode3-perf-sd`) | serve the branch locally: `python3 -m http.server 8092` in the checkout, open `http://localhost:8092/arena_studio.html?advanced=1&soak=1` |
| bridge + simulator | same checkout | `pixi run bridge -- --log-dir soak-logs` · `pixi run sim -- --count 0 --rate 200 --seed 1 --jump-every 100 --jump-deg 90` |

Flash only with the Studio disconnected (port free): `scripts/flash_bootloader_route.sh` in the firmware repo.
After connecting, the Studio's firmware label must end in `freerun sdfast`; **never power-cycle the controller
after a fault before the post-mortem has finished** (it drains the ring and the crash report — that is the evidence).

## Card contents (once)

Upload `soak-patterns/sine_2000f_gs16.pat` (8.1 MB, from `pixi run node scripts/make-stress-patterns.js`) through
the Studio Console in the same Studio session that will run the soak; `frame2_h_ccw_200f` (813 KB) must already be
on the card. `pixi run python scripts/telemetry-report.py <log>` must show `layout: contiguous` for both files.

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
