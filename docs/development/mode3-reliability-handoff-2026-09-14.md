# Mode-3 reliability — the one hand-off document (firmware + Studio, 2026-09-11 → 09-14)

**Read this first.** Two problems made closed-loop (Mode-3) trials on the G6 arena unreliable. Both are now explained
and fixed on one firmware build and one Studio version, with instrumentation that shows, per trial, whether the display
did what the host asked. This document explains every change since Friday 2026-09-11 in one place: what, why, the wire
contract, how to test it, the evidence, and what is still open. Byte-level tables live in the firmware README (section
numbers given); this is the narrative and the map.

| | problem | cause | fix | evidence |
|---|---|---|---|---|
| A | **controller wedge**: ~1 in 10 Mode-3 runs the controller went 100–500 ms per command, power cycle only (fw #50) | a race in `IntervalTimer::end()`: SET_FRAME_POSITION disarmed/re-armed the refresh timer per command; a PIT interrupt landing between the two left the PIT firing with a null callback (an ISR storm) | **free-running refresh timer** — 0x70 never touches the PIT; plus an atomic `end()`; plus a hardware watchdog that resets and records the PC if anything like it ever recurs | 24 soak iterations, 5.15 M commands, 0 wedges (was 1 in 10 runs) |
| B | **display freezes of 30–90 ms** every ~24.5k frame reads of a large pattern (fw #54) | firmware FAT access: SdFat re-walked the file's cluster chain on backward seeks and looked up the next cluster inside every read that crossed a 4 KB cluster boundary; those FAT-sector reads hammered one physical block of the card until its read-disturb maintenance paused the card | **contiguous O(1) seeks** (`FsFile` + `contiguousRange()`): the FAT is read once at pattern open and never during a trial | 4-arm causal test 2026-09-13: FAT touched → stalls at the old spacing; FAT untouched, same read count → 0; production: 0 in 482k + 72k commands + 1 h at 286 Hz |

**Candidate build:** firmware `feat/sd-fastpath-2x10` @ `75405ee` (label `… freerun sdfast`, 0xCB flags `0x7C`);
Studio v0.77 (PRs #198 + #202). **Run sheet for the bench:** `soak-handoff-2026-09-14.md`; **lab test day on Windows (no Claude):** `lab-test-day-windows-2026-09-14.md`; **what the overnight tests:** `overnight-soak-test-plan-2026-09-13.md`.

---

## 1. How we got here (so the layers make sense)

1. **Fri 09-11 — see the wedge.** `GET_HEALTH` 0xCA (counters, loop timing, a reset-surviving *breadcrumb* of the last
   operation) and `GET_FIRMWARE_VERSION` 0xCB (build identity in every run log). Studio v0.76: the fault detector, the
   post-mortem probe sequence, the soak driver, `wedge-scan.py`. Result: the wedge reproduced, the breadcrumb pointed at
   the 0x70 handler but could not say what led up to it.
2. **Sat 09-12 — record the lead-up.** The **telemetry ring** (0xA8/0xA9): every command, every displayed frame change,
   every state change, in a 64 KiB RAM ring that survives a soft reset and is drained live over USB with an ack cursor.
   Then the **watchdog** (RTWDOG) with pre-reset PC capture and `GET_CRASHREPORT` 0xCC, because a wedged controller
   that resets itself in 2 s is better than one that needs a power cycle, and the captured PC is evidence. The ring +
   ISR breadcrumbs showed the wedge was the PIT: `IntervalTimer::end()` racing its own interrupt. Fix: **free-running
   refresh timer** (0x70 no longer disarms/re-arms it; the frame buffer is swapped under the running timer) and an
   atomic `end()`. A stand-alone reproducer (`tools/pit-race-repro`) demonstrates the storm on a bare Teensy.
3. **Sat night → Sun 09-13 — the stalls.** With the wedge gone, the ring's `sd_slow` records exposed problem B: 716 slow
   reads in 197 clusters over 9.9 M commands, count-triggered, only on the 813 KB pattern. The **SD fast path** build
   added attribution (which phase of the read stalled, driver error bits, per-pattern layout, read counts), the O(1)
   seek, a same-index read skip, `GET_SD_INFO` 0xCD (card identity) and, for the causal test, `SET_SD_DIAG` 0xCE
   (bench switches). Studio v0.77 added per-trial **pass / flagged / unknown** verdicts and the card identity in the
   run metadata. The causal test on Sunday afternoon settled the cause (§6).

## 2. Firmware changes, by layer (all on `arena-2x10-local`, 31 commits, fast-forward)

| layer | commits | opcodes / records | 0xCB flag | README § | HIL tests |
|---|---|---|---|---|---|
| Health + build identity | `06a6f25`, `506339a`, `22b756d` | `GET_HEALTH` 0xCA (ver 5, 89 B), `GET_FIRMWARE_VERSION` 0xCB (46 B) | capability bit 7 `health` gates both | Health + breadcrumb; Build identity | `test_health.py`, `test_firmware_version.py` |
| Telemetry ring | `280ecc2`..`64167f8` | `SET_TELEMETRY` 0xA8, `GET_TELEMETRY_BLOCK` 0xA9 (18 B header + records; CMD / FRAME / STATE) | bit 2 | Telemetry ring | `test_telemetry.py`, offline `test_telemetry_codec.py` |
| Watchdog + crash report | `fb11681`..`4860fef` | RTWDOG (~2 s, calibrated), `GET_CRASHREPORT` 0xCC (128 B), HEALTH v2 fields (prev ISR, captured PC, wdog flags), 0x70 sub-op breadcrumbs 6–9 | bit 3 | Watchdog, sub-op / ISR breadcrumbs | `test_health.py` (v2 fields), `test_crashreport_*` |
| Free-running refresh timer (fix A) | `eca07f6`, `394dee4` (+ `tools/pit-race-repro`, hygiene `8968fb7`) | none new; `STATE(timer_fail)` kind 10 if the timer cannot start | bit 4 | Free-running refresh timer | `test_health.py` timing checks |
| SD fast path (fix B) + attribution | `200fada`..`75405ee` | `GET_SD_INFO` 0xCD (30 B), `SET_SD_DIAG` 0xCE, FRAME 26 B (ring v2), STATE kinds 11–14, `sd_slow` phase byte | bit 5 (0xCD, FRAME v2, kinds 11–13), bit 6 (0xCE, kind 14) | SD fast path; SD card identity; A/B switches | `test_firmware_version.py` (0xCD/0xCE), `test_telemetry.py`, offline `test_sd_stall_stats.py` |

### 2.1 Design notes a maintainer needs

- **Gating rule.** Every new opcode is gated on a `GET_FIRMWARE_VERSION` flag bit, never on the 0xC2 capability byte
  (it is full) and never blind: this firmware answers an unknown opcode with `CE_UNKNOWN_CMD` and an error glyph on the
  arena. Bits: 2 telemetry, 3 crash report, 4 free-run, 5 SD fast path, 6 SD diag. `GET_HEALTH`'s `ver` byte is the
  health layout version and is not bumped for unrelated features.
- **Ring at a fixed OCRAM address** (`0x2026F000`, 64 KiB, below PJRC's CrashReport, in no linker section) so it
  survives SYSTEM_RESET and the bootloader reboot. Full ring = overwrite oldest (it is a crash recorder first).
  Records are freed only when the host's next request acknowledges their sequence number. A heap collision disables
  the ring and says so (`ring_overrun` code) rather than corrupting either. Ring `kVersion` 2 = 26 B FRAME; a version
  change re-initialises the ring once.
- **Watchdog semantics.** RTWDOG armed after boot, kicked from the main loop; long legitimate operations (uploads,
  ISP, SD format) kick inside their loops with a 30 s long-op window. Before it fires it captures PC/LR into the
  health record; the next boot reports `prev reset was watchdog` and the PC. The Studio treats a dropped link after a
  fault as the self-reset path.
- **Free-running timer invariant.** The refresh ISR runs at `refresh_rate_hz` (300 Hz default) regardless of command
  traffic; SET_FRAME_POSITION only swaps the frame buffer and the ISR pushes whatever is current. Rate changes go
  through `IntervalTimer::update()`; disarm preserves NVIC state. A frame requested twice inside one tick is
  *superseded* (counted in the FRAME record), not lost by the controller.
- **SD fast path invariants.** At pattern open: `FsFile` handle, `contiguousRange()` marks a contiguous file so
  `seekSet` is arithmetic; a fragmented file falls back to the chain walk and the trial's `sd_layout` record says so
  (bit 0 = 0). During a trial the FAT is never touched for a contiguous file. `frame_buf_is_frame_` (the buffer holds
  frame N of the open pattern) and `sd_cache_ok_` (its derived outputs are current) gate the same-index skip; every
  writer of the frame buffer clears the first, AO mode/LUT changes clear the second. **Never re-introduce a per-seek
  chain walk**: that is what caused problem B.
- **Bench switches** (`SET_SD_DIAG` 0xCE, flag bit 6): bit 0 = legacy chain-walking seek at the next open, bit 1 = no
  same-index skip; both off at boot; readback in `GET_SD_INFO` byte 29 (bit 2 = applied to the open file); every
  `sd_layout` record carries the arm. The harness restores the previous flags on exit. No-op on exFAT.

## 3. Studio changes (webDisplayTools, v0.76 → v0.77)

| area | module | what it does |
|---|---|---|
| Fault lifecycle (v0.76) | `js/fictrac-bridge-client.js` (`_recordApply`), `js/arena-session.js`, `js/arena-runner-g6.js`, `js/studio-postmortem.js` | ≥ 3 failed applies in the last 10 → latched fault → runner `fault()` → outcome `CONTROLLER_FAULT` auto-committed → post-mortem: quiet, confirm 0xC2, typed probes, policy `halt` / `reset-continue`; a dropped link takes the self-reset path (reconnect, MAC check, health, ring dump, crash report) |
| Soak driver (v0.76) | `arena_studio.html` `Studio.startSoak` (File ▾ → Soak…, `?soak=1`, advanced) | repeats a protocol; exposure-based iteration outcomes; halts on first fault by default; **v0.77: accepts open-loop protocols** (no FicTrac plugin) |
| Telemetry drain (v0.76/77) | `js/arena-telemetry.js` | decodes 0xA9 blocks; ack-cursor drainer (ack = stored by the bridge); 10 Hz poller gated on flag bit 2; rows `["cc"|"cf"|"cs", …]` into the run log; FRAME extras and STATE kinds 11–14; budget 200 chunks/poll |
| Build + card identity | `js/arena-wire-g6.js` | `decodeFirmwareVersion` (label, flag bits), `decodeHealth` (v2 fields), `decodeCrashReport`, `decodeSdInfo` (maker/product/serial/date/capacity/FAT/cluster) → `run_metadata.firmware`, `.sd_card` |
| Trial quality (v0.77) | `js/trial-quality.js` | per-trial **pass / flagged / unknown** from ring records in seq order: any SD read or request→display age > 10 ms flags (5 ms target); coverage gaps → unknown, never pass; `display_gap` + `trial_quality` run-log events; banner. Flag, never exclude |
| Bench switch (v0.77) | `Studio.setSdDiag(flags)` | console helper for the causal test; arm recorded in `run_metadata.sd_card.sd_diag` |
| Analysis | `scripts/wedge-scan.py`, `scripts/telemetry-report.py` | faults/resets per iteration; SD read cost by step class, stall clusters + phases, request ages, per-trial verdicts (reads Studio and harness logs) |
| Protocols + patterns | `protocols/soak_mode3_closed_loop.yaml`, `soak_mode3_stress.yaml`, `soak_mode2_open_loop.yaml`, `scripts/make-stress-patterns.js` | the wedge soak; the 8 MB + bar stress; the Mode-2 control; the pattern generator |

Run-log format review (row types, bytes per hour, compaction plan): `runlog-format-review-2026-09-13.md`.
Run-log contract (unchanged for readers of `behavior_v2`): string-tagged array rows are streams, only `"a"` rows are
behaviour samples; `cf` rows have 8 or 11 fields; readers go through `js/runlog-format.js`.

## 4. Bench tools (firmware repo, browser-free)

| tool | use |
|---|---|
| `scripts/soak_mode3.py` | Mode-3 soak/repro with the Studio's fault lifecycle (problem A) |
| `scripts/sd_stall_test.py` | SD stall / card comparison driver: one pattern, random walk + jumps, telemetry drained into its own log, exact stall statistics, `--sd-diag N` arms, exit 4 unless the measurement is complete (problem B) |
| `scripts/sd_upload_pat.py` | upload a `.pat` to the card and print its index + frame count |
| `scripts/sd_soak_campaign.sh` | alternate patterns in 10-min segments, stress rate then course rate until a stop time; survives reboots and failed segments |
| `scripts/flash_bootloader_route.sh` | flash a hex through HalfKay with the port free (6 s) |
| `tools/pit-race-repro` | stand-alone reproducer of the PIT storm (problem A's root cause) |

## 5. How to test

- **Offline:** firmware `pytest tests/test_telemetry_codec.py tests/test_sd_stall_stats.py`; web `pixi run test` +
  `pixi run format-check`.
- **HIL (port free, controller connected):** `pytest --transport=serial --port /dev/cu.usbmodemXXXX
  tests/test_firmware_version.py tests/test_health.py tests/test_telemetry.py tests/test_lab79_sd.py --pat <a .pat>`
  (the `--pat` file is uploaded as `conftest.pat`; delete it afterwards via 0x86). Known pre-existing flakes:
  `test_crashreport_passthrough` after a HalfKay reflash (junk RAM), `test_overfill_evicts_oldest…` (timing).
- **Bench smoke (Studio):** connect → label ends `freerun sdfast` → one 60 s Mode-3 trial with the simulator → the
  run log has `cc`/`cf`/`cs` rows, `run_metadata.firmware` + `.sd_card`, and a `trial_quality` event.
- **Soak:** `soak-handoff-2026-09-14.md` (2 h stress, overnight benchmark, pass criteria).

## 6. Evidence

**Problem A (wedge):** before — 6 occurrences incl. rig 2 (2026-07-11), ~1 in 10 Mode-3 runs on 2026-09-11/12 soaks.
After the free-running timer (`394dee4`, 09-12 night → 09-13): 24 iterations, 5.15 M commands, 0 wedges, 0 watchdog
resets. Root cause demonstrated stand-alone: stock `IntervalTimer::end()` dies in < 0.5 s under the reproducer,
PIT-masked variant runs 5.9 M cycles.

**Problem B (stalls) — the causal test, 2026-09-13 14:47–15:11 ET, `75405ee`, bar pattern (813 KB) only, 200 Hz,
6 min per arm, every capture complete:**

| arm | FAT touched | reads | stalls > 10 ms | clusters | worst read | request age max |
|---|---|---|---|---|---|---|
| 3 legacy seek, no skip | yes | 71,882 | 20 | 2 (spacing 23,275 commands = the old period) | 90.8 ms | 76.7 ms |
| 2 contiguous seek, no skip | no | 71,992 | **0** | 0 | 1.8 ms | 3.0 ms |
| 1 legacy seek, skip on | yes | 54,885 | 6 | 1 | 70.2 ms | — |
| 0 production | no | 54,900 | **0** | 0 | 1.8 ms | 2.9 ms |

Arms 2 and 3 have identical data-read exposure and differ only in FAT access → the FAT access was the cause; the
same-index skip does not affect the stalls (it saves 24 % of reads). Arm 3 also showed sixteen 12–19 ms stalls the old
20 ms threshold had hidden. Earlier: 482k commands / 40 of 40 trials pass on `3c71953`; 1 h at 286 Hz on `75405ee`
(see the bench log for the numbers). **Per-read cost on the production build:** +1 step 0.62 ms; random/backward
1.39–1.46 ms median, 1.8 ms max; request→display age 1.7 ms median, 2.9 ms max at 200 Hz.

**Overnight benchmark (candidate build):** *to be filled in the morning from `telemetry-report.py` over the campaign
segments — stalls, clusters, per-file read cost, request ages, reboots.*

## 7. Known limits and open items

- **Contiguity is a precondition** for O(1) seeks. Files written in one pass are contiguous; `sd_layout` bit 0 reports
  it per trial. A per-open cluster-chain (extent) table would remove the precondition entirely (~8 KB RAM worst case,
  built during the open-time chain walk the code already does); deferred, decide after the benchmark.
- **286 Hz** commands against a 300 Hz refresh: some request ages of 5–10 ms from tick coalescing are expected; that is
  a throughput property, not an SD problem. 200 Hz is clean.
- **Studio trial-quality banner** has not yet seen a real stall (the causal test ran through the harness); the path is
  unit-tested (22 tests). One bench trial with arm 3 set would exercise it.
- **AO mode / LUT change between two frame loads**: superseded accounting covered by code review, not by a HIL test.
- **Firmware `main` port**: `main` moved to per-board `-DARENA_HW_*` headers (#48); this stack is on the 2×10 branch
  and must be ported (supersedes fw #53).
- **Cards**: the comparison protocol (`sd_stall_test.py` on a candidate card) is optional now; never reformat the
  bench card, it is the baseline.
- **Sub-threshold stalls** (12–19 ms) exist on the legacy path; the 10 ms threshold and the 5 ms target are Michael's
  acceptance numbers, recorded in `trial-quality.js` defaults.

### 7.1 Deferred from the whole-stack reviews (2026-09-13, both repos)
Firmware: ring `seq` u32 rollover (~6 days continuous) and an incarnation id for the ack cursor; single ring header;
ISR breadcrumb cost with telemetry off; a lean "timer fix only" release if ever wanted; HIL tests for DAC-failure
retry, watchdog recovery and faster-than-refresh request storms; `soak_mode3.py` explicit unsynchronised state.
Studio: a session-owned run-finalization state machine; trial identity from runner ids rather than observed opens;
shared verdict conformance fixtures (JS ↔ Python); `SET_TELEMETRY(0)` for the "telemetry off" toggle; soak exposure
per interval; report truncation → unknown and bounded accumulators; controller-time clustering in the report;
`arena-link` write-timeout race; bridge rows-capability negotiation. None affects tonight's benchmark; all are
recorded so the next session starts from the list, not from a re-review.

## 8. Where things live

- Firmware: `src/Health.*`, `src/Telemetry.*`, `src/Watchdog*`/`Health` v2 fields, `src/SpiManager.*` (timer),
  `src/SdManager.*` (fast path), `src/CommandProcessor.*` (handlers), `src/Version.h` (flag bits), `README.md`
  (byte tables), `tests/telemetry_codec.py` (decoder), `scripts/` (bench tools).
- Web: `js/arena-wire-g6.js`, `js/arena-telemetry.js`, `js/trial-quality.js`, `js/studio-postmortem.js`,
  `js/fictrac-bridge-client.js`, `arena_studio.html` (soak driver, sinks), `scripts/telemetry-report.py`,
  `scripts/wedge-scan.py`, `docs/development/` (this file, `soak-handoff-2026-09-14.md`, `mode3-wedge-soak-plan.md`
  §10 bench log, `sd-read-jitter-2026-09-13.md` §8 diagrams, `sd-stall-causal-test-plan-2026-09-13.md`,
  `consolidation-plan-2026-09-13.md`, `telemetry-review-handoff-2026-09-13.md`).
- Issues: firmware #50 (wedge, Michael's thread), #54 (SD stalls), web #197, #200, #201.
