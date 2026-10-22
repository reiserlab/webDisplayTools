# LAB-303 okey-cokey — results, REISERLAB-WW14, 2026-10-22

Run sheet: [`okey-cokey-pc-2026-10-21.md`](okey-cokey-pc-2026-10-21.md). PC facts, setup, BIAS build and
the two no-flies smoke runs: [`okey-cokey-pc-ww14-setup-2026-10-22.md`](okey-cokey-pc-ww14-setup-2026-10-22.md).

**Status:** the full `g6_color_optomotor_test` run with flies passed: arena 48 / 48 trials, BIAS 58 / 58
replies `ok`, 70 953 camera frames at 73.3 fps over 968 s. The first full attempt died at minute 9 when
the Claude desktop app restarted (R1). Not done yet: the Foxglove replay of the full run, and copying
its files to the group share.

## Machine

As in the setup file (REISERLAB-WW14, BIAS v0.73.1 Spinnaker, FLIR BFS-U3-51S5M, firmware
`c15d840a 2x10 2026-09-29 restack/panel-boot freerun sdfast`), with one change: the controller was on
**COM5** for the full run (R2).

## Findings

| # | Step | Finding | Status |
|---|---|---|---|
| R1 | 5 | **The first full run died at 15:31:21, 9 min in** (during the CCW half of the first `blue_pair_d50`, pair 14 / 24). BIAS, the rig and the Studio server had all been started from a Claude Code session in the Claude desktop app. The app restarted itself (Windows Application log, `CoworkVMService` at 15:31:21–22), and every process it had started died with it. The controller stayed connected over USB. | **fixed** for the next run: `tools\okey-cokey-start.ps1` launches BIAS, the rig and the server through WMI, so they are children of `WmiPrvSE`, not of the launching app or terminal (checked: no `claude.exe` in their parent chain). The run sheet now says to start real runs this way. Tested from scratch at ~16:20 (BIAS, rig and server all stopped first): exit 0, all five ports up, every listener's parent chain runs through `WmiPrvSE`, BIAS on ufmf. The consoles open as **tabs of one Windows Terminal window**, which at first hid the rig's tab from the operator; the script and run sheet now say so. |
| R2 | 4 | The controller is **COM5** now, not COM3 as in setup. Two Teensys share VID 16C0 / PID 0483: `G6_Arena` (serial 12169940, COM5) and a "USB Serial" device (serial 17917130, COM3). | **docs**: pick it by name, `G6_Arena`, in the port picker (setup file C + run sheet step 4) |
| R3 | 6 | **A large occlusion makes the ufmf about 25× larger.** An operator leaned into the camera's view **on purpose** at 352 s into the video (frame #25 802, ≈ 15:42:50) for ~4 s. Frames: ~1.1 KB normally → ~4 MB during the occlusion → hundreds of KB/frame for ~3.3 min after it (352 → ~551 s, a mean of 1.3 MB/frame in minute 6), then back to ~1.1 KB. The run's file came to **11.8 GB** instead of ~0.5 GB. BIAS's background (`medianUpdateInterval` 50 frames, `medianUpdateCount` 100, threshold 40) had taken in part of the occluder, so reconstructed frames in that window show a dark ghost over part of the arena. BIAS's ufmf settings were identical to `config/bias/okey-cokey-bfs-u3-51s5m.json`. | info: budget disk for occlusions; video for pairs 9–14 (the 50 % block's `violet_pair_d50` CCW half … second `blue_pair_d50` CCW half) has the ghost artifact |
| R4 | 5 | **A panel glitch was reported by eye during the second half of the trials, sometimes.** The controller's telemetry shows nothing: all 57 810 displayed frames have `superseded` 0, SPI time 232–235 µs in every trial (first half and second half alike), SD reads ≤ 0.8 ms, no `error_glyph` / `boot` / `sd_slow` / `ring_overrun` / `timer_fail` events, `trial_quality` 48 / 48 pass. So the frames left the controller on time; a glitch would be panel-side (SPI signal to a panel, or the panel itself), which this telemetry cannot see. The camera does not see the LEDs either: ufmf frames stayed ~1.1 KB while gratings were running. | **open.** Operator, after the run: **several panels** at once, and what they showed **looked like numbers and letters**. That matches a *panel-side* error glyph (seen once before on the bench, "02/03" on one panel after a controller reset: `docs/development/mode3-wedge-soak-plan.md`, 2026-09-13 20:28), not the controller's own `CE NN` glyph, which the ring logs as `error_glyph` (none here). Panels draw it themselves, e.g. after a bad SPI message or a panel reset; "second half" overlaps the 50 % and 100 % duty blocks (more LED current). Next: reproduce with no flies, photograph the glyph text, and note the time, panels and block. |

## Runs

| run | time | what | arena | BIAS | files |
|---|---|---|---|---|---|
| partial | 15:22:09–15:31:20 | `g6_color_optomotor_test`, flies; died at pair 14 (R1) | 28 of 48 trials started, log cut off | `ok` until killed; 40 324 frames, 550 s | `color_optomotor_cam_0_date_2026_10_22_time_15_22_09_v001.ufmf` (76 MB), `runlogs/arena-log-20261022-152209-836.*`: **not usable** |
| full | 15:36:58–15:53 | `g6_color_optomotor_test`, flies (Canton-S, experimenter mreiser) | `runlog-check` **OK**: 48 pass / 0 fail / 0 unknown, 1 / 1 run files complete | 58 replies, all `ok`; 70 953 frames = 70 953 stamp-log lines, 968.08 s, 73.3 fps | `C:\rec\okey-cokey\color_optomotor_cam_0_date_2026_10_22_time_15_36_58_v001.ufmf` (11.8 GB, R3); `runlogs/arena-log-20261022-153658-696.bag`; export `runlogs/exports/arena-log-20261022-153658-696.jsonl` (63 464 lines) |

Direction on this rig is reversed relative to the protocol's labels (arena mounted upside down; setup
file, smoke run 1): protocol "CW" turns counterclockwise seen from above.
