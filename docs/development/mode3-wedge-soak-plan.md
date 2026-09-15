# Mode-3 controller wedge (fw #50) — findings, soak harness, campaign spec

**Status:** harness BUILT 2026-09-11 (Studio v0.76 + firmware branch `feat/controller-health` +
`scripts/wedge-scan.py` + pyserial `scripts/soak_mode3.py`), **nothing bench-tested yet**.
Companion to `controller-telemetry-ring-buffer-proposal.md` (PR #192) and Linear LAB-149. Codex
cross-review of the plan: `.codex-review/report-20260911-wedge-soak.md` (gpt-6-astra).

## 1. The bug in one paragraph

[reiserlab/LED-Display_G6_Firmware_Arena#50](https://github.com/reiserlab/LED-Display_G6_Firmware_Arena/issues/50)
(Isabel, 2026-09-11): during sustained Mode-3 host-stepped streaming (SET_FRAME_POSITION 0x70 at
100–286 Hz over USB CDC) the controller stops answering within one command of running perfectly
and never recovers without a power cycle. Reproduced on 2 controllers / 2 rigs / 2 users /
2 protocols; ~292k good 0x70s before the failures; `status` never non-zero; time to failure
79 s → 1035 s; rate ≈ 1 in 10 experiments. `scripts/wedge-scan.py` over the course data repo
found a **sixth, earlier occurrence** — rig2, 2026-07-11, `p3-heisenberg-slashes-full`
(Olenka), a third controller — with the identical signature (six replies at 1–3 ms, then
`03 70 a6 00` times out, 32 unanswered 0x70s, then 0x08 fails). First sighting is therefore
two months earlier than the report. The five reported wire logs are **not** in the course repo
(aborted runs were never auto-committed; bench03 has no folder) — they live on the rigs.

## 2. What the code says (verified 2026-09-11)

### Host (webDisplayTools, before v0.76)

- The closed-loop drain loop (`js/fictrac-bridge-client.js`) **swallowed every 0x70 timeout**
  and kept spinning at 2 Hz; a wedged run therefore *completed* and auto-committed looking
  normal. A 0x08 timeout in the runner hard-aborted. That asymmetry was the core host defect.
- Every command is already logged host-side (`arena_command` → `behavior_v2` `["a", …]` row) with
  `dt` = host-observed round trip **including queue time** behind other queued commands.
- `SYSTEM_RESET` 0x01 exists on the wire and in both UIs, never used programmatically; the link
  had no `getPorts()` path, so an unattended reconnect was impossible.

### Firmware (`main` d6358d2)

- `handleSetFramePosition` does an **uncached SD seek + read per 0x70** (`loadFrame`), plus a
  blocking I2C DAC write when AO is in `frame_number` mode. IntervalTimer end/begin churn is
  **benign** (the core re-scans PIT channels; ~4 register writes) — issue lead #1 downgraded.
- SD is Teensy `SD.h` over PJRC SdFat in **polled `FIFO_SDIO`** mode: every non-sequential
  sector does CMD12 `syncDevice` + `readStart`, each gated on `BUSY_TIMEOUT_MICROS` = 1 s, plus
  an unbounded spin on `SDHC_PRSSTAT_BREN`. No retry, no re-init (`SD.begin` once in `setup()`),
  no error surface. `transferPanelSet` also spins unbounded on `dmaComplete_`.
- `SerialManager::flushResponses()` ignores `Serial.write()`'s short return; the Teensy core's
  `usb_serial_write` has a sticky 120 ms `TX_TIMEOUT_MSEC` path → USB twin of fw #28.
- **No watchdog, no loop timing, no SD error surface** (before `feat/controller-health`).
- **0xE3 is the PANEL image footer** (`/firmware/panel.bin`), not controller build info; its
  status 1 is correct on a card without a panel image. There is **no controller-version opcode**
  (LAB-150). 0xC2 already returns the MAC (fw #24 done).
- 0x01 = `SCB_AIRCR SYSRESETREQ` after an ack: resets MCU + USDHC, does **not** power-cycle the
  card.

### Correction to the issue's "two latency tiers"

0x82 (`GET_PATTERN_FILENAME`) is a **RAM lookup** (`names_[]`), not an SD read. The 1.3–2.4 s
replies were a 7-command connect-time burst queued FIFO behind each other, so their `dt` includes
queue time. The SD-touching 0xE3 took 121 ms. Best estimate of the degraded per-command RTT:
**~100–500 ms (50–250×), no SD-specific tier.** The quantitative match to the SDIO 1 s busy
timeout is therefore gone; H1 and H2 below are peers.

## 3. Hypothesis ladder (to be settled by the harness)

| # | Mechanism | Evidence for | Evidence against | Discriminator |
|---|---|---|---|---|
| H1 | SDIO polled-busy latch (card or USDHC stuck in a retry/busy state; every SD op ~1 s) | per-0x70 random seeks are the highest-rate SD path; only a power cycle clears | 0x82 (RAM) was as slow as anything; 0xE3 (SD) only 121 ms | GET_HEALTH `sd_read_max_us` / `sd_err`; 0x01 (resets USDHC but not the card) |
| H2 | USB-CDC reply path / loop stall (device-side TX state, 120 ms `TX_TIMEOUT` signature; a slow op inflating every loop iteration) | 0xE3 = 121 ms ≈ `TX_TIMEOUT_MSEC`; host reconnect (no re-enumeration) doesn't clear it | nothing yet | GET_HEALTH `loop_max_us`, breadcrumb/slowest-op after 0x01; pyserial arm (no Chrome) |
| H3 | Host/Chrome side (Web Serial, OS USB stack) | — | wedge survives a port close/reopen; controller answers slowly (so it is the device) | pyserial arm reproduces ⇒ not H3 |

The single most valuable experiment remains: **on the next wedge, send `01 01` before power
cycling and read health/0xC2/0x88 afterwards.** The harness does exactly that (policy
`reset-continue`), after a first-fault halt for hands-on inspection.

## 4. What shipped (2026-09-11) and how it fits together

| Piece | Where | What it does |
|---|---|---|
| Fault detector | `js/fictrac-bridge-client.js` | ≥ 3 failed applies in the last 10 → latched `fault`, apply forced OFF, event to the session |
| Runner fault path | `js/arena-runner-g6.js` `fault()` | wakes the trial wait, `summary.fault`, `stopAcked`; a timed-out protocol command is labelled the same |
| Session | `js/arena-session.js` | bridge `fault` → `runner.fault`; runner sends go through `session.send` (logged); `reconnect()`, `flushRx()`; `dt` on the monotonic clock |
| Link | `js/arena-link.js` | `reconnect()` from granted ports (VID/PID match, ambiguity refused), write-stall deadline |
| Outcome | `js/run-log.js`, `js/studio-runlog-adapter.js` | `CONTROLLER_FAULT` (auto-commits; `ABORTED_BY_USER` still doesn't) |
| Post-mortem | `js/studio-postmortem.js` | quiet → confirm → probe window → halt \| reset → reconnect → MAC check → post-reset probe |
| Soak driver | `arena_studio.html` (File ▾ → Soak…, `?soak=1`) | repeats `runOnce()`; refuses without a `behavior_v2` ack or without frames; halt-first |
| Health opcode | firmware `feat/controller-health` (0xCA, cap bit 7) | loop timing, SD read stats + error, counters, reset cause, previous-boot breadcrumb + slowest op |
| Wire | `js/arena-wire-g6.js` | `encodeGetHealth`/`decodeHealth` (55 B + 11 B tail), `GET_FRAME_POSITION` |
| Analyzer | `scripts/wedge-scan.py` | per-run table (onset, RTTs, timeouts, soft degradation) over v1/v2/gz/`.runlog.json` |
| Pyserial driver | firmware `scripts/soak_mode3.py` | browser-free Mode-3 soak, same fault lifecycle + log format |
| Simulator | `fictrac-bridge/fictrac_sim.py` `--turn-sigma`, `--jump-every`, `--jump-deg` | FicTrac-like ±1–2 frame walk vs wide seeks |
| Protocol | `protocols/soak_mode3_closed_loop.yaml` | 20 × 60 s Mode-3 trials alternating the 200-frame bar and 20-frame grating |

## 5. Campaign spec — one definition, both drivers

- **Fault** = ≥ 3 failures (timeout / non-zero status / transport error) within the last 10
  frame commands. Not "3 consecutive": a late reply to an earlier 0x70 can satisfy the next
  request (same echo byte) and reset a consecutive counter.
- **Lifecycle** = latch → apply OFF → run aborts (`CONTROLLER_FAULT`, `stopAcked` recorded) →
  **quiet period ≥ 1 s + rx flush** → confirmation 0xC2 (2 s) → **probe window ≥ 60 s**
  (0xC2, 0x33, 0x72, 0xCA, 0x88 idx 1, 0xE3; 5 s timeouts; every 2 s) → policy.
- **Policy**: `halt` (default for the campaign's FIRST fault: leave the controller wedged for
  hands-on inspection — DEBUG_SERIAL, manual port close/reopen, manual 0x01 with a human
  watching) or `reset-continue` (one 0x01, settle 3 s, reconnect from granted ports, verify MAC,
  post-reset probe; recovered ⇒ a NEW soak iteration, never a resume; ≤ 3 resets then halt).
- **Log rows** (bridge NDJSON, `behavior_v2`): every command as `["a", …]`; typed
  `{"event":"probe", phase, name, cmd, req, resp, dt, status, ok, decoded|error}`;
  `{"event":"health", …}`; `{"event":"soak", phase: start|iteration-start|iteration-end|paused|end}`;
  `runner` events carry `summary.fault` / `stopAcked`. `dt` is host-observed latency.
- **Never count a dead simulator/bridge as a controller fault**: the Studio soak pauses when no
  frames arrive; the pyserial driver has no such dependency.
- **Instrumentation is a factor**: record whether GET_HEALTH polling was on (1 Hz is negligible
  but say so).

## 6. Bench recipe (CSHL 10-10 controller, no FicTrac → simulator path)

Upgrade first (all benches): `git pull`, restart `pixi run bridge`, hard-refresh the Studio, and
confirm the Console FicTrac panel's log-level mirror reads `behavior_v2` without ⚠.

Studio arm (one controller, one night):
```
pixi run sim -- --count 0 --rate 100 --seed 1              # ±1.6-frame walk; --rate 286 for the fast arm
pixi run sim -- --count 0 --rate 100 --jump-every 50       # wide-seek arm
pixi run bridge -- --log-dir soak-logs
# Studio ?advanced=1&soak=1 → File ▾ → Open → protocols/soak_mode3_closed_loop.yaml → connect
# → File ▾ → Soak…  (iterations=0 hours=12 gap=10 first=halt then=reset max=3)
```
Pyserial arm (the following night — the two drivers cannot share one USB port):
```
cd LED-Display_G6_Firmware_Arena && python scripts/soak_mode3.py --port /dev/cu.usbmodemXXX \
   --hz 100 --index-walk walk --pattern 4 --hours 12 --on-fault halt --log-dir soak-logs
```
Mode-2 control arm: `soak_mode3.py --mode 2 --fps 300 --hours 8` (health tick only).
Morning: `pixi run python scripts/wedge-scan.py soak-logs/` (markdown table; `--verbose` for onset
context; `--json` for the dashboard).

**Expected yield.** At ~1 wedge per 10 × 40-min experiments, a 12 h night ≈ 18 iterations ≈
1–2 events with high variance. A quiet night is censored exposure, not evidence of a fix; plan
≥ 3 nights per arm before drawing conclusions, and compare arms across nights, not
simultaneously.

## 7. Experiment matrix

| Arm | Driver | Rate | Index pattern | Question |
|---|---|---|---|---|
| A | Studio + sim | 100 Hz | ±1.6-frame walk, 200 f + 20 f patterns | baseline reproduction under the deployed path |
| B | Studio + sim | 286 Hz | walk | rate dependence (bench03 failed faster at 286) |
| C | Studio + sim | 100 Hz | `--jump-every 50` | does defeating the SD sequential path matter? (H1) |
| D | pyserial | 100 Hz | walk | Chrome/Web Serial out of the loop (H3) |
| E | pyserial | 100 Hz | `seq` | pure sequential reads — H1 predicts fewer wedges |
| F | pyserial | Mode 2 300 fps | — | does the wedge need 0x70 at all? |
| G | any, after ≥ 1 baseline wedge | — | — | fw cache candidate A/B (held until then) |

## 8. Decisions taken (Michael, 2026-09-11)

1. Fail closed on repeated 0x70 timeouts in ALL runs; faulted runs auto-commit as `CONTROLLER_FAULT`.
2. First fault of the campaign halts; later faults reset-continue (one 0x01 per fault, ≤ 3).
3. Runner sends are logged through the session.
4. Frame-cache firmware candidate is **held** until a baseline wedge reproduces on stock firmware
   (Codex: it changes the very access pattern under suspicion).
5. GET_HEALTH (0xCA) ships first as additive observation, with the `.noinit`-style breadcrumb.
6. Self-healing is issues-only this pass; the runner-level recovery policy comes after the soak
   data (if 0x01 does not clear the wedge, the recovery primitive changes).
7. Logs are `behavior_v2` everywhere; the soak refuses otherwise.

## 9. Open items

- Bench-test the whole chain on the 10-10 controller (unplug test for the disconnect path; a
  Node-only test covers the timeout path); first soak night.
- Flash `feat/controller-health` and run `tests/test_health.py`; confirm the breadcrumb survives 0x01.
- Get the five reported wire logs off bench03/rig03-sr (not in the course repo) and run
  `wedge-scan.py` on them to confirm the issue's numbers.
- Firmware follow-ups filed as issues: `flushResponses` short-write (#28 twin), SD error surface +
  `SD_REINIT`, controller-version opcode (LAB-150), close #24.
- Ring buffer T1–T6 (PR #192) unchanged: sidecar-first, 10–20 Hz drain; T4/T5 run on this soak
  workload once the ring exists.

## 10. Bench log

**2026-09-11/12 — first night (CSHL 10-10, MAC 04:E9:E5:12:91:E2, stock course fw, sim 100 Hz, Studio soak, halt-first).**
Smoke + 3 full iterations clean (2,001 + 110,641 + 121,670 + 121,685 0x70 OK; RTT 2 / 4–9 ms). **Iteration 4
wedged at 187.8 s** (frame 78 of the 200-frame trial) after 18,128 clean commands — ≈ 374k good 0x70s over
~70 min of streaming before failure. The controller was **fully silent**, not slow: 5/10/20 s probes from
Chrome, port close+reopen, and pyserial outside Chrome all returned zero bytes; USB stayed enumerated; the
display held its last frame. **0x01 SYSTEM_RESET got no ack** (parser lives in the stuck loop); only a power
cycle recovered it. Consequences: H3 (browser/host stack) is out; the fault looks like `loop()` stopped
(unbounded spin), not a slow path; the host-side recovery primitive must be a hardware watchdog or the
Teensy bootloader route (134-baud reboot → HalfKay → `teensy_loader_cli -b`). Attempting the latter half by
flashing #53 remotely put the Teensy in HalfKay with **no HID interface attached on macOS 26**, so no loader
could see it — do not flash without someone at the bench; test the bootloader route with a finger on the
button first. Also: the Studio tab was in the background (timer throttling ⇒ ~1 s-aligned timeout durations in
the log; not causal). Harness bugs found and fixed live: protocol `fictrac.disconnect` took the logger down;
a remembered v1 session setting overrode the soak's v2; one out-of-range 0x70 per trial with a smaller frame
count (#199). Logs: `soak-logs/arena-log-20260912-001625-545.jsonl` (wedge) and siblings, bench-local.

- **2026-09-12 11:24 ET →** soak night 2 continues on `22b756dd` (health + version), halt-first, 10 h. Iteration 1 completed 11:5x.
- **2026-09-12 12:00 ET** Codex (gpt-6-astra) status + diff review reconciled — `.codex-review/report-20260912-status.md`. 16 diff findings, 11 verified and fixed on the branch (deferred commit on fault, recovery predicate, ack-means-stored, tagged-row readers, 0xCB-bit-2 telemetry gate, identity per link-up, exclusive post-mortem link, telemetry off switch, analyzer declared fault, bridge row shapes, soak `unexercised`); 2 deferred (write-timeout transport generation; session-owned lifecycle → LAB-212), 1 rejected (sidecar). Full suite green.
- **2026-09-12 12:0x ET** ring firmware `feat/telemetry-ring-2x10` = `ac4c08f` pushed (0xA8/0xA9, u32 sd_load, heap guard, eviction-first commit, synthetic producer, 0xCB flags bit 2). **Not flashed** — waits for a human at the bench (night-1 lesson) at an iteration boundary: `Studio.stopSoak()`, restart bridge (3.1), flash, verify 0xCB bit 2 + 0xA8 ack, restart soak = T4.

- **2026-09-12 12:20 ET** Codex (gpt-6-astra) diff review of the ring FIRMWARE (`ac4c08f`) — reconciled in the ring worktree `.codex-review/report-20260912-ring.md`. 19 findings: blocking ones are in the reference pyserial drainer (health-gated 0xA8, peek loop, ack-before-flush) and the HIL tests; runtime fixes = ack ≥ next_seq ignored, seq 0/0xFFFFFFFF never emitted, heap guard in ack/peek/configure, exact-size boot repair. Host mirror: drainer `rearm()` (NO_ACK first after connect / before the post-reboot dump; incarnation check). Deferred for the diagnostic build: dual headers, linker reservation, PSRAM/stream FRAME identity, 64-bit cursor. Flash = go once the fix commit builds; target boundary 12:49 ET.

- **2026-09-12 13:00–13:45 ET — T4 flash + iteration-1 gate (Michael at the bench).** Ring fw `c47ee684` flashed via the button (`teensy_loader_cli -w -v`; macOS has no `timeout`). Iteration 1 (1,238 s, 104,895 0x70s) checked against the host echoes: CMD 0x70 count matches the host (2 in flight), seq 1..178k contiguous, 0 dropped / 0 refused, FRAME idx = last request 16,562/16,564, sd_load median 1.2 ms p99 2.3 ms p99.9 3.4 ms max 19.4 ms, spi 0.77 ms flat, host↔controller drift −3 ppm, dispatch→SPI 4.7 ms median (display lags the reply by ~2.7 ms). GET_HEALTH prev_slow_op after the iteration: op 1, **70.6 ms** (not a FRAME load — the slowest op covers sd_open/other SD ops too). **Reboot survival: PASS both routes** — 0x01 SYSTEM_RESET (ack, gesture-free reconnect, boot_count 0→1, survived flag, seq continuous, boot record kind 1 code 2 arg 1, pre-reset records incl. the 0x01 CMD with status 0xFF) and the bootloader route (134-baud → HalfKay HID in 1 s → `-b` → CDC in 1 s; boot_count 2, resetCause 1, 1 duplicate dropped by rearm). Two bugs found by running it in Chrome and fixed: `poller.stop()` called `window.clearInterval` as a method (Illegal invocation — would have aborted the post-mortem), and the 9-byte 0xA9 request was logged as a 207 B object 20×/s (20 % of the file) → `send({silent:true})`. Soak restarted 13:45 as T4 proper (same protocol sha 49313f52, hours=10, halt-first).

- **2026-09-12 15:44 ET — WEDGE #2 (first on instrumented firmware), CAPTURED.** Ring fw `c47ee684`, T4 iteration 6, 1181 s into the run (after 112,344 clean 0x70s; ~2 h of streaming since 13:38; total instrumented exposure before it ≈ 6 iterations). Host: three 0x70 timeouts with write stalls (dt 1.2 s, 3.0 s, 3.0 s), then STOP unanswered; post-mortem (halt): 21 probes, 0 answered, ~1 s write stall on each 5 s probe. pyserial: write ok, no reply. USB stayed enumerated. **Capture route worked on the real wedge**: Studio disconnect → 134-baud → HalfKay HID in 1 s → `teensy_loader_cli -b` → CDC in 1 s → reconnect (MAC verified) → GET_HEALTH → ring drain → probes. No power cycle. Log: `soak-logs/wedges/wedge2-20260912-1544-ring-c47ee684.jsonl(.gz)`.
  **Evidence:** GET_HEALTH `prev_breadcrumb = OP_CMD arg 0x70`, stamp 3.3 ms after the last ring record (FRAME idx 136 = the last host command that was answered, `03 70 88 00` at t_off 1181.389 s; the first timed-out command was `03 70 8a 00` idx 138). `prev_slow_op = sd_read 89.2 ms`. `reset_cause` after the bootloader reboot = 1. Ring survived (boot_count 2→3, 185 records recovered incl. 119 pre-boot, 0 gaps, no heap collision); the last 60 s show normal 0x70/FRAME alternation, sd_load ≤ 2.4 ms, **no STATE records** (no sd_slow, no error glyph). **Reading of the crumb:** `Health::clear()` sets OP_IDLE (does not restore the outer OP_CMD), so OP_CMD/0x70 means the main loop stopped between `Health::mark(OP_CMD)` in `handleBinaryCommand` and `Health::mark(OP_SD_READ)` in `loadFrame` — the SET_FRAME_POSITION preamble (length/pattern/index checks, `spi_.disarmRefreshTimer()` = `IntervalTimer::end()`, `cur_frame_index_ = index`). Nothing in that window can block by itself ⇒ the CPU was taken away: an ISR that never returned, an interrupts-disabled spin elsewhere, or a Cortex-M LOCKUP. Not a plain hard fault: the Teensy core's fault handler reboots after 8 s (we saw > 60 s of silence). **H1 (stuck in the SDIO read) is NOT supported by this sample**; the 89 ms SD read that boot is real but was not the hang site.
  **Next:** diagnostic build (agent, in progress): hardware watchdog kicked from `loop()` (converts the hang into a reboot with the ring intact = self-healing + crash dump), finer sub-op breadcrumbs in the 0x70 window, an ISR breadcrumb byte, CrashReport passthrough in GET_HEALTH. At the next wedge: **look at the Teensy LED** (fault handler blinks? — no, the core keeps the LED untouched by default; skip) and read the ISR crumb. Soak restarted 15:53 on `c47ee684` (8 h, halt-first) for a second sample with the current crumbs.
  Corrected false lead: `cores/teensy4/IntervalTimer.cpp` has `printf("beginCycles …")` but `debug/printf.h` compiles it out (macro), confirmed by objdump.

- **2026-09-12 16:27 ET — WEDGE #3, CAPTURED.** Same ring fw `c47ee684`, soak restarted 15:53, iteration 2, 741 s in, on the 20-frame grating (pattern 5; first unanswered 0x70 idx 18) — so not pattern-specific. Same host signature (write stalls, total silence, 21/21 probes unanswered). Bootloader capture route worked again (HalfKay 1 s, CDC 1 s). **Breadcrumb identical to #2: `OP_CMD` arg `0x70`; `prev_slow_op = sd_read` 88.1 ms**; ring intact (boot_count 3→4, 0 gaps); last 60 s normal, SD loads ~1 ms, no STATE records. Two samples, same code window. Log `soak-logs/wedges/wedge3-20260912-1627-ring-c47ee684.jsonl(.gz)`. Exposure on the ring build: wedges after ~2 h 06 min and ~34 min of streaming.
- **16:25 ET Codex (gpt-6-astra) review of the watchdog build `fb11681`** (`LED-Display_G6_Firmware_Arena-ring/.codex-review/codex-diff-review-20260912-162501-19350/`): NOT flashed as-is. Blocking: rejected pattern upload (`drainBulkData`, up to 15 s) would trip the 2 s watchdog; HIL test module cannot import (duplicate namedtuple field) and two assertions are wrong (CrashReport `len` is 11 WORDS; sub-ops carry arg 0x70); the watchdog PC capture shares the breadcrumb's checksum line with main-context writes → a torn record at boot discards the PC. Significant: starve flag bypassed by `sendRaw` kicks; `wd_armed_` cleared even when programming fails; long ops disable recovery entirely (use a longer finite deadline); every SET_TELEMETRY reasserts watchdog policy; 0xCC needs its own 0xCB flag (bit 3) for rollback safety; `soak_mode3.py` decodes only the 66 B prefix. Deferred: temp-file pattern replacement, recovery-mode boot, versioned crash envelope, ISR hooks bracketing driver code. Fix commit requested from the agent 16:33; host side fixed (CrashReport len in words, 0xCC gated on 0xCB bit 3, `f49bd4c`). Soak restarted 16:33 on `c47ee684` (halt-first) until the fixed build is ready.

- **2026-09-12 16:36 ET — WEDGE #4, CAPTURED**, 5.5 min after the 16:33 restart (31,222 clean 0x70s; pattern 5 idx 4). Same crumb `OP_CMD`/`0x70`; this boot's slowest SD read only 3.4 ms (so the 88–129 ms reads are NOT a prerequisite). Ring boot_count 5. **Intervals between wedges on `c47ee684` after MCU-only reboots: 2 h 06 m → 33 m → 5.5 m** — shrinking. Every recovery so far reset the MCU (bootloader / SYSRESETREQ) but never the SD card or other peripherals; night 1's power cycle was followed by 12 clean iterations. Hypothesis: peripheral (SD card) state degrades across MCU resets → **power-cycle experiment** requested from Michael 16:42 before the next soak.
- **16:40 ET flashed the watchdog build from HalfKay** (software route, no button): identity reads `fb11681e dirty` (hex built before commit `4d1b61c`; binary has the fixes — 0xCB flags 0x0d, HEALTH ver 2 89 B, 0xCC answers). **RTWDOG configuration FAILED on hardware** (`wdog_flags` 0x49: armed + compiled-in + config-failed); OFF→ON reprogramming via SET_TELEMETRY bit4 does not clear it; kicks = loop count (4.3 M/s). Agent investigating (clock gate / unlock window / 16-vs-32-bit key). Sub-op breadcrumbs + CrashReport readout are live regardless.
- Log: `soak-logs/wedges/wedge4-20260912-1636-ring-c47ee684.jsonl(.gz)`.

- **2026-09-12 17:04 ET — watchdog build `86eeb4a` flashed from HalfKay (software route, no button) and PROVEN.** Root cause of the earlier failure: the Teensy core never opens WDOG3's clock gate (`CCM_CCGR5`), so every RTWDOG register write was dropped. After the fix: HEALTH ver 3 (97 B), `wdog_cs_boot` 0x2520, `wdog_cs_now` 0x35e0 (EN set), kicks == loop count. **Starve test (SET_TELEMETRY 0x31): reset 0.5 s after the reply, CDC back at 0.8 s; previous-boot record = reset by watchdog, ISR marker = watchdog IRQ, captured PC 0x3aa2 / LR 0xc74d, ring survived (boot 1→2).** Two follow-ups sent to the agent (non-blocking): `wdog_flags` bit 6 "config failed" is a false negative (hardware says EN); the effective timeout is ≈0.5 s, not 2 s (clock/prescaler math) — wanted 2 s so SdFat's 1 s busy timeouts are not clipped. Power-cycle interval test: iteration 1 after the power cycle ran clean (21 min > wedge #4's 5.5 min); continuing on 86eeb4a. Reconciliation: ring worktree `docs/development/codex-review-2026-09-12-watchdog.md`.

- **2026-09-12 17:28 ET — `54b57d0` flashed from HalfKay** (bit-6 false negative fixed: flags 0x09 → 0x0f after the starve reset; HEALTH v4 106 B). Starve test again: **reset 0.52 s** after the reply (port back 0.80 s), PC 0xca4c → `loop` (addr2line), ring survived (boot 3→4). Discrepancy: firmware measures the RTWDOG tick at 127 Hz and computes TOVAL 254 = 2.0 s, but the real expiry is ≈500 Hz — measurement off ~4×; agent asked to calibrate/hard-code 500 Hz. Running the night at the **effective 0.5 s** timeout (every observed slow SD op is ≪ 0.5 s; a legit > 0.5 s stall would self-reset with PC evidence). Studio reloaded with link-drop-as-fault handling (`18ceeda`) and HEALTH v4 decoding (`1b5de7e`). Soak restarted 17:31 (10 h, halt-first; watchdog self-resets take the post-mortem's self-reset path and the soak continues). Post-power-cycle: 43 min clean before this boundary.

- **2026-09-12 17:53 ET — `320e26d` flashed from HalfKay.** Starve test with TOVAL 1000: expiry **6.37 s** (TOVAL 254 earlier: 0.52 s) ⇒ comparator runs at ~127 Hz with a constant ≈190-tick (~1.5 s) offset: expiry ≈ TOVAL/127 − 1.5 s. The "500 Hz" reading was wrong; the CNT measurement was right. Agent asked to explain the offset and calibrate TOVAL for a 2 s expiry (≈445). Tonight runs at the ≈6.4 s effective expiry; host post-mortem gains link-drop handling during the probe window so a reboot mid-window takes the self-reset path. Ring 5→6 survived; PC 0x1664 captured.

- **2026-09-12 18:20 ET — `4860fef` flashed from HalfKay; watchdog expiry calibrated: starve → port gone at 2.02 s (target 2.0), back 2.29 s.** TOVAL 444 = 127 Hz × 2 s + 190-tick offset. HEALTH v5's kick-path diagnostics read `WDOG3_CNT` = 0 before and after every refresh and live, so the readable counter does not expose the running count; the 190-tick offset is a comparator-side constant on this silicon (documented as empirical). PC 0x6e1c captured, ring 7→8 survived. Soak restarted ~18:22 (10 h, halt-first, self-reset path live). Post-power-cycle exposure before this boundary: 92 min clean. **Final firmware for the night: `4860fef8`.**

- **2026-09-12 22:31 ET — operating point raised (Michael):** simulator restarted at **286 Hz** with a **90° jump every 100 frames** (`fictrac_sim.py --rate 286 --seed 1 --jump-every 100 --jump-deg 90`); soak restarted (9 h, halt-first) on `4860fef8`; `soak_note` event in the log marks the switch. First 84 s: FicTrac 286/s, 0x70 delivered **264/s** (0 timeouts, 0 rejects), RTT median 2 ms, p99 7 ms, p99.9 21 ms, max 29 ms; 77 % of consecutive requests change the index (median step 1 frame, 4.9 % > 10 frames), so the SD random-access path runs ~200 loads/s vs ~60/s at 100 Hz; ring 294 rec/s ≈ 4.7 KiB/s, 0 drops/gaps/refused. The 100 Hz block (13:38–22:29, 12 clean iterations = 4 h 10 m since the 16:45 power cycle) is one exposure block; 286 Hz + jumps from 22:31 is the second. Fallback if the instrumentation struggles: 200 Hz.

- **2026-09-12 23:05 ET — FINDING (Michael, watching the arena): the display updates LESS at 286 Hz than at 100 Hz.** Ring data: at 100 Hz ≈ 5,000 commands/min → 3,500–4,000 displayed frame changes/min (60/s); at 286 Hz ≈ 14,000 commands/min → only 1,000–1,400 displayed changes/min (17–23/s). Mechanism (firmware): `handleSetFramePosition` does `disarmRefreshTimer()` → `loadFrame()` → `armRefreshTimer(refresh_rate_hz_)`, i.e. every 0x70 **restarts the refresh period** (`refresh_rate_gs16_default = 300` Hz → 3.3 ms; GS2 1000 Hz). At 286 Hz the host command spacing is median 3 ms (p90 5 ms), so the timer is usually restarted before it can fire; frames reach the panels only in gaps longer than the period (≈10–20 % of gaps). The SD-load and USB paths are still exercised per command (77 % index changes), so the wedge stress stands; the *display* is starved. Not a new bug in the instrumented builds — the same code path is on `main`/`arena-2x10-local`. This is the second half of the held fix candidate ("skip disarm/re-arm when already in SHOW_FRAME at the same rate"): arm once, let the timer free-run, and 0x70 only swaps the buffer. File as a firmware issue tomorrow (perf/latency, LAB-164) and hand to the parallel SD-jitter session. Decision: keep 286 Hz for the night (wedge stress), option 200 Hz (5 ms spacing > 3.3 ms period) if Michael prefers a visibly moving display.

- **2026-09-12 23:15 ET — FINDING (Michael: "faster in minute 1 than minute 20"): a HOST-side slowdown within every iteration.** At 286 Hz, commands delivered per 60 s trial fall from 16.4k (trial 1) to ~8k (trial 20) and host-observed RTT p99 climbs 7 → 140 ms, while the controller side is flat (sd_load p99 2.3 ms, cc→cf 4.9 ms median in every trial). Cause: the Studio's raw log panel (`#runlogBox`) appends one DOM row per arena command with no cap and scrolls to the bottom on each — 43k rows after 10 min at 286 Hz; each append + layout gets slower, the apply loop yields less, `dt` (host-observed, includes queue) inflates. The panel is cleared at run start, which is why each iteration starts fast. At 100 Hz the same effect was ~18 % over an iteration (6.0k → 4.9k commands/trial). **Fix:** bounded raw log (keep 3,000 lines, trim 500 at a time, follow the tail only when not scrolled up) — hot-patched into the live page 23:12 (trimmer interval), source fixed for the next reload. This affects any long closed-loop run in the field (course experiments at 100 Hz lose apply throughput over 20+ min) — release note + probably its own issue.

- **2026-09-12 23:36 ET — 200 Hz block starts** (Michael: 286 Hz too fast for smooth display given the timer-restart effect). Sim `--rate 200 --jump-every 100 --jump-deg 90`; Studio reloaded with the bounded raw log (`df5ce7c`); soak restarted (8 h, halt-first). 286 Hz block result: 3 clean iterations (22:31–23:35); with the live raw-log trim, iteration 3 delivered 329,637 commands vs 232,547 in iteration 1 — the host slowdown confirmed as the DOM log. No wedge since the 16:45 power cycle (6 h 50 m; 100 Hz 12 iterations, 286 Hz 3 iterations). Decision: the free-running-refresh-timer fix waits for a watchdog-captured PC (it would confound the hang window); Isabel note deferred until things are cleaned up.

- **2026-09-12 23:51 ET — WEDGE #5, caught by the WATCHDOG; first captured PC.** 200 Hz block, iteration 1, 909 s in (171k clean 0x70s; 7 h 06 m after the power cycle). Lifecycle fully automatic: 2 timeouts → controller self-reset (watchdog) → link dropped → `link_dropped` fault → post-mortem self-reset path → reconnect (MAC verified) → health → ring dump → probes → **soak continued** (iteration 2 started 10 s later). Evidence (GET_HEALTH v5 after the reset): `prev_breadcrumb = cmd_disarm_timer (6) arg 0x70`, `prev_isr_last = watchdog` (the pre-reset IRQ ran ⇒ the core was taking interrupts), `prev_wdog_pc = 0x000212f4`, `prev_wdog_lr = 0x000212eb`, `prev_slow_op = sd_read 89.6 ms`, reset cause 0x80 (wdog3). **addr2line (ELF 4860fef, built 17:58): both in `IntervalTimer::end()`**; the disassembly puts the PC on `str r1, [r3, #8]` = **`channel->TCTRL = 0`, the PIT channel register write** (LR = return from the `funct_table[index] = nullptr` inplace_function call just before). The last ring record (FRAME idx 152) is 5.5 ms before the breadcrumb stamp; the ring's last 60 s show three `sd_slow` records (32, 41, 88 ms) — the first wedge with slow SD reads in the final minute. No crash record.
  **Reading:** the main loop sat on a store to a PIT peripheral register for 2 s while still able to take the watchdog interrupt — the signature of a **hung peripheral (IPS/AIPS) bus transaction**: the write never completes, and every other peripheral access (USB registers in the USB ISR, USDHC) blocks behind it, which is exactly the total silence we see. Whether the PIT itself hangs (end/begin churn at 200–286/s: `PIT_MCR` rewrite + channel re-scan on every command) or another master (USDHC/SD DMA, LPSPI DMA) hangs the bus and the PIT write is merely the first access to block is the next question — the free-running-timer change is the discriminator: with no PIT writes in the 0x70 path, a bus hang would move the captured PC to the SD read or the USB write; a PIT-specific hang would disappear. Three earlier breadcrumbs (`OP_CMD`/0x70 before the SD mark) are consistent with the same site.

- **2026-09-12 23:55 ET — host bug after the self-reset (fixed live, proper fix tomorrow):** the iteration after the watchdog recovery faulted 63 s in with three REJECTS (idx 161/162 sent to the 20-frame grating): the bridge `config` carried `frames: 200` for the grating because the Studio rebuilds `Studio.patternSet` from the SD listing on every connect, which erased the in-page `preview.frames` patch for the card-only patterns (`patternFramesByName` then fell back). The post-mortem correctly saw a healthy controller (`transient`) and the soak ended `fault-transient`. Live fix: a re-patch hook on the session state event (+2 s interval); soak restarted 23:56; first grating trial confirmed `frames: 20`, 0 rejects. Proper fix: resolve the frame count from the controller (GET_PATTERN_INFO 0x88) at trial start when the pattern set lacks it, and do not end a soak on a `transient` outcome that immediately follows a self-reset iteration. Tracked in the close-out issue #201.

- **2026-09-13 00:05 ET — standing order (Michael):** soak continues to ~08:00 on `4860fef8`. On the next near-identical wedge (disarm breadcrumb / PC in `IntervalTimer::end()`), flash the **free-running refresh timer** variant (being built: 0x70 no longer disarms/re-arms the PIT; arm once on SHOW_FRAME entry; 0xCB flags bit 4 marks it) and continue the soak on it as the A/B. Each further wedge is a PC data point.

- **2026-09-13 00:41–00:50 — Codex reviews of the evidence doc and of `eca07f6`.** Plan review (adversarial) found
  the `IntervalTimer::end()` null-callback/`TFLG` race in the Teensy core → PIT interrupt storm with the main
  context's return address exactly at the captured PC (`channel->TCTRL = 0`); verified in the installed core
  1.160.0; quantitatively consistent with Isabel's ~292 k commands/failure (≈ 11 ns window). Now the leading
  mechanism; bus hang is the alternative. Reconciliation: `archive/mode3-2026-09/codex-review-2026-09-13-mode3-wedge-fix.md`; evidence
  doc §2b. Diff review of the free-running commit: keep the timer policy; fix the non-atomic ISR-lite record
  update, sticky `armed_hz_` on a failed `begin()`, the lost pre-watchdog ISR identity, the historical-record
  test assertion; README claims softened. All folded into one follow-up firmware commit (safe PRIMASK-guarded
  disarm at the remaining `end()` sites, PIT ISR trampoline id 7 + STATE kind 9 counts, watchdog context xPSR/
  EXC_RETURN → STATE kind 8), to be diff-reviewed before it is the build that the standing order flashes. Soak on
  `4860fef8` at 200 Hz + jumps continues (iteration 3, trial 21 at 00:47; no wedge since 23:56).

- **2026-09-13 01:25 — fix build candidate `394dee45`** (`eca07f6` free-running refresh + one amended follow-up):
  `disarmRefreshTimer()` masks only `IRQ_PIT` at the NVIC around `IntervalTimer::end()` (watchdog IRQ stays
  live); full and lite ISR hooks are atomic with save/restore of the enclosing id; PIT vector trampoline (ISR
  id 7) re-installed after every `begin()`; watchdog ISR captures stacked xPSR + `EXC_RETURN` + prior `isr_last`
  into a re-laid-out 3-line record (context line sealed and flushed first); boot after a watchdog reset emits ring
  STATE kind 8 `wdog_context` / 9 `prev_isr_count`; kind 10 `timer_fail`; old record location invalidated. Two
  Codex diff reviews reconciled (D1–D12, E1–E13), third running on the round-3 delta. Host decode pushed
  (`69c14e6`, `d234f6e`). Flash gate: Codex round 3 reconciled → flash at a wedge (standing order) or at an
  iteration boundary if Michael prefers → starve test must yield a decodable kind-8 record → soak restarts.

- **2026-09-13 01:14:37 ET — WEDGE #6 (baseline `4860fef8`, 200 Hz + jumps, iteration 4, 192 k 0x70s, 83 min
  after wedge #5).** Watchdog self-reset; lifecycle automatic again (link_dropped → self-reset path → health →
  ring dump → probes → iteration 5 started 01:14:48). Evidence: `prev_breadcrumb = cmd_disarm_timer (6) arg 0x70`,
  `prev_isr_last = watchdog`, **`prev_wdog_pc = 0x000212f2`**, LR 0x212eb, slow op sd_read 88.9 ms, 18 `sd_slow`
  records in the run (five in the last 4 s: 32–88 ms). Disassembly of `IntervalTimer::end()` (4860fef ELF rebuilt
  in the session scratchpad, identical resolution): `212f0 str r3,[r6,r5]` = `funct_table[i] = nullptr`; `212f2
  ldr r3,[r7]` = load `channel`; `212f4 str r1,[r3,#8]` = `TCTRL = 0`. Wedge #5's PC (0x212f4) and wedge #6's
  (0x212f2) are exactly the two return addresses that exist between the callback being nulled and the channel
  being disabled — a hung store would give a fixed PC, an interrupt taken inside the race window gives exactly
  these two. Evidence for the `IntervalTimer::end()` race is now two-for-two. Log archived as
  `soak-logs/wedges/wedge6-20260913-0114-wdog-4860fef8.jsonl(.gz)`.
- **01:17:35 ET — standing order executed: flashed `394dee45`** (bootloader route, Studio released the port;
  HalfKay immediate; CDC back in ~1 s). Identity: 0xCB `394dee45 2x10 2026-09-13 feat/telemetry-ring-2x10`, flags
  0x1C (telemetry + crashreport + **freerun**, clean). HEALTH v5, wdog armed + HW enabled.
- **01:19 ET — flash gate: starve test passed.** `SET_TELEMETRY 0x31` → reset after ~3.8 s (host-observed) →
  reconnect → HEALTH: watchdog reset, PC 0x634c = `CommandProcessor::serviceDisplay()`, LR = `loop`. Ring boot
  records (drained by the poller into the still-open bridge file): `boot 128`, **kind 8 `wdog_context` code 0xE9
  arg 0** (thread mode preempted, FP state stacked, no ISR active — exactly the expected starve signature), kind 9
  `prev_isr_count` for usb only (display was off, so no refresh/PIT entries). The expanded capture completes inside
  the pre-reset window (context line AND counts valid).
- **01:20:08 ET — soak restarted on `394dee45`**, 200 Hz + jumps, 6.6 h (to ~07:56), halt-first / reset-continue
  ×3, protocol `soak_mode3_card.yaml` unchanged, frames re-patch hook alive. A PIT storm on this build would read
  kind 8 `code 0xF1/0xE1, IPSR 138, prior isr 7` with the PIT count ≫ refresh count.

- **2026-09-13 07:58 ET — morning summary (soak still running, iteration 20 on `394dee45`).**
  Exposure in the 200 Hz + jumps block: baseline `4860fef8` 1.96 h streaming, 1.42 M 0x70s, **2 wedges** (#5 at
  909 s of its run, #6 at 1022 s); fix build `394dee45` 6.53 h, 4.41 M 0x70s, **0 wedges**, 19/19 runs completed
  (P ≈ 0.002 for zero events at the baseline's rate). Full table: `archive/mode3-2026-09/mode3-wedge-night2-scan-2026-09-13.md`.
  Display: 34–45 → 73–75 distinct frames/s at 190 commands/s (145 distinct requests/s), same SD/SPI timings; host
  RTT median 2 → 3 ms, p99 8–9 → 11 ms (more transfers competing in `loop()`). No kind 8/9 records on the fix build
  (no watchdog reset). fw #50 comment drafted (session scratchpad `fw50-comment-draft.md`) — outward-facing, for
  Michael's review. Next on the bench (Michael's call): the 10-minute `end()`/`begin()` stress reproducer on the
  stock core, then the PJRC report; the "mechanism arm" night is optional now that two captures sit inside the race
  window and the fix build is clean.

- **2026-09-13 08:58–09:12 ET — MECHANISM REPRODUCED on the bench (stand-alone sketch, no arena code).**
  `tools/pit-race-repro/` in the firmware repo (commit `3ae478d`): one `IntervalTimer` at 10 kHz, loop =
  `begin()` → cycle-accurate wait that sweeps `end()` across the expiry (±2 µs) → `end()`. **Stock core: main
  loop dead within 0.5 s** (no heartbeat, status unanswered, USB still enumerated, 134-baud reboot works — the
  storm leaves the USB ISR alive exactly as on the arena). **PIT-masked `end()`: 5.92 M cycles / 2.72 M expiries
  in 10 min, no stall.** A first attempt with a tight `end(); begin()` loop (no wait) ran 53 M cycles with ZERO
  timer expiries — `begin()` restarts the period every iteration, which is the display-starvation effect in
  pure form. Soak was stopped at the iteration-2 boundary (3 clean runs, 0 faults) and restarted 09:12 on
  `394dee45` after re-flashing (4 h). fw #50 comment draft updated with the reproducer; PJRC report ready to
  write (fix = acknowledge `TFLG` in `pit_isr()` regardless of the callback, and/or disable the channel before
  nulling the callback).

- **2026-09-13 09:40 ET — soak wound down (operator stop; iteration 2 of the third soak aborted).** Fix build
  `394dee45` totals: 24 runs, 5.15 M 0x70s, ~7.7 h streaming, 0 wedges. Codex review of the findings/fix/upstream
  note reconciled (`archive/mode3-2026-09/mode3-wedge-upstream-note-2026-09-13.md` — baseline restated to the 200 Hz block, conditional
  3 % instead of P ≈ 0.0007, invariant-framed upstream fix); final texts await Michael. Handover for the
  performance session: `archive/mode3-2026-09/mode3-perf-handover-2026-09-13.md`. Controller left on `394dee45`, Studio connected idle.

- **2026-09-13 09:53–11:30 ET — performance session (Claude, worktree `vigilant-tereshkova`, host branch
  `claude/mode3-perf-sd` on #198; firmware `feat/sd-fastpath-2x10` on the ring branch, local).** Bench untouched so far
  (Studio connected idle on `394dee45`, bridge + sim still up). Log analysis of the 75 ring-era files: per-read cost by
  index step (+1 620 µs; non-sequential 1.18 ms grating / 1.46–2.0 ms bar — SdFat FAT-chain walk on backward seeks);
  **the 30–90 ms stalls are card-internal**: 716 stalls / 197 clusters, quantised 23/33/41/67/89 ms, every ~48k accepted
  0x70s at every rate, **712/716 while the 813 KB bar pattern was open** (24,573 bar reads between clusters, IQR
  23.5–25.5k), position-dependent inside the file (frames 80–160 stall 1.5× the mean, frames 20–59 0.2×), unbroken
  across the 16:45 power cycle; displayed-frame gap = stall + ~2 ms. Michael: acceptable freeze 5 ms target / 10 ms
  worst case; ≥ 30 ms invalidates a trial; cards for comparison available later, not today. Codex plan review
  (`.codex-review/report-20260913-1030-sd-stalls.md`): copy rotation withdrawn (conservation), FAT-cache explanation
  corrected (separate FAT cache on ARM), u32 request age, screen ≠ qualify, current card is the untouched baseline.
  Built + reviewed: fw `200fada` (contiguous O(1) seeks, same-index skip, sd_slow phase + ctx, sd_layout/sd_reads,
  FRAME 26 B ring v2, GET_SD_INFO 0xCD, 0xCB bit 5) + `8968fb7` hygiene + `519d794` Codex round-1 fixes (skip requires
  a running timer; presentation accounting on every transfer; provenance reset; USDHC error bits; sd_reads shift) +
  `3c71953` `scripts/sd_stall_test.py`; host Studio v0.77 (`b96ea85`, `cfbe8a8`): trial-quality pass/flagged/unknown,
  0xCD → `run_metadata.sd_card`, telemetry-report.py; all suites green. Read-free access-pattern research (agent +
  Codex brainstorm): every course motion pattern except looming is an exact +1 px/frame roll; independent-frame LZ4
  shrinks the 813 KB bar to 15 KB → complete compressed RAM cache loaded in the ITI is the recommended next step;
  panel PSRAM write path is specified but unimplemented in panel firmware (`docs/development/archive/mode3-2026-09/sd-read-jitter-2026-09-13.md` §6).
  Codex round 2 on the round-1 fixes running; flash follows its reconciliation.

- **2026-09-13 11:35:07–11:35:13 ET — flashed `3c71953` (SD fast path build) via the bootloader route** after Michael
  disconnected the old Studio tab (port free; HalfKay immediate; CDC back in 6 s; no button). Codex round 2 on the
  round-1 fixes: firmware accepted, harness findings deferred (`.codex-review/report-20260913-fw-sdfast-rounds.md` in
  the ring worktree). HIL subset (version/health/telemetry) run with the port free before the Studio reconnects.

- **2026-09-13 11:36–11:48 ET — HIL on `3c71953` (port free):** version/health/telemetry: same-index skip verified
  (3 repeated 0x70s → cmd70 +3, sd_reads +0), frame storm: 26 B FRAMEs, `sd_layout` + trailing `sd_reads` after
  ALL_OFF as designed (needed an 81 KB grating uploaded as `conftest.pat`, deleted again; listing back to 45 files,
  idx 36/5 unchanged). **Card identity (0xCD): MID 0x00, OEM "42", PNM `SD8GB`, PRV 0.0, PSN 0x14d4, made 2025-06,
  8.0 GB SDHC, FAT32, 4 KB clusters (8 sectors/cluster)** — an unbranded 8 GB card; the 4 KB clusters (≈ 200-cluster
  chain for the 813 KB pattern → two FAT sectors) are what made the backward-seek FAT walk cost ~0.5 ms. Two unrelated
  failures noted, not chased: `test_crashreport_passthrough` (PJRC CrashReport region holds junk after the HalfKay
  reflash, len 35340264) and `test_overfill_evicts_oldest_and_reports_dropped` (ring_overrun marker position, timing
  sensitive). Next: Studio v0.77 on :8092 connects (user gesture), soak protocol rebuilt, 2 iterations.

- **2026-09-13 11:45 ET — soak restarted on `3c71953`** from Studio v0.77 (worktree served on :8092; new origin →
  Michael clicked Connect once). Protocol `soak_mode3_card.yaml` rebuilt from the repo soak protocol (ids 36/5, frames
  200/20 via the `__framesRepatch` hook), rig set explicitly to `cshl_g6_2x10_ball` (the page derived `g6_3x10`; the
  mismatch chip still reads "bench ≠ protocol" — cosmetic, to check), advanced mode forced on the new origin,
  `startSoak({iterations:2, gapS:10, firstFault:'halt', policy:'reset-continue'})`; sim 200 Hz + 90° jumps unchanged,
  bridge 3.1 logging behavior_v2. This is the CONTROL iteration on the new build (same card, same workload).

- **2026-09-13 11:46 ET — first look at the control iteration (66 s snapshot, `telemetry-report.py`):** fw reads per
  accepted 0x70 = **0.755** (8,972 reads / 11,884 commands on the bar — the same-index skip removes the 24 % as
  predicted); bar pattern non-sequential reads now **all ≈ 1.46 ms** (−1 was 2.00 ms: the FAT-walk penalty is gone;
  +2..9 unchanged at 1.44; jumps 1.96 → 1.46); grating non-sequential 1.18 ms as before; +1 sequential 620 µs both.
  Bar (813 KB) still costs ~280 µs more per random read than the grating (81 KB) with identical code paths → consistent
  with the card serving part of the small working set from its own cache (the H-cache reading of the small file's
  stall immunity). `req_age_us` (0x70 dispatch → SPI start) p50 1.77 ms, p99 2.56 ms, max 2.56 ms; superseded 1.2 %
  of frames. No stall yet in 66 s (expected spacing ~250 s). Layout: contiguous, 8 sectors/cluster, both patterns.

- **2026-09-13 11:55 ET — prediction recorded before the iteration completes:** 10 min / 11 trials into the control
  iteration on `3c71953`, **zero `sd_slow` records** (baseline `394dee45`: a cluster every ~250 s at this rate; with 24 %
  fewer reads the first cluster was due by ~330 s). Hypothesis H-FAT: the card's read-count hot spot was the **FAT
  sector(s)**, not the pattern data — on this 4 KB-cluster card the 813 KB pattern's cluster chain (≈ 200 entries ×
  4 B = 800 B) spans TWO FAT sectors, so every backward seek's chain walk (`FatFile::seekSet` from the first cluster)
  missed SdFat's one-sector FAT cache and re-read a FAT sector from the card (~12k FAT reads per 24.5k pattern reads);
  the 81 KB grating's chain (80 B) lives in one FAT sector that stays cached → never a FAT read → never a stall.
  Explains: per-file, count-based, rate-independent, power-cycle-persistent, position-dependent (seeks to high frames
  cross the FAT-sector boundary), non-sequential-only. `contiguousRange()` (fix A) removed every FAT read, so if the
  full iteration and iteration 2 stay at zero stalls, the stall was firmware-induced (a read-disturb hot spot on the
  FAT's flash block) and fix A is the fix for this workload. Discriminator if wanted: one iteration on `394dee45`
  (stalls return at ~24.5k reads) or a build with `contiguousRange()` disabled — the new `sd_slow` phase byte would
  read `seek`.

- **2026-09-13 12:00 ET — offline check of H-FAT on the 200 Hz fix-build block (21 files, 200 bar trials, 1.77 M reads,
  308 stalls):** a one-sector FAT-cache simulation of SdFat's chain walk (unknown first-cluster offset swept 0–127)
  puts 42–77 % of stalls on FAT-fetching reads, but only by driving the fetch rate toward 100 %, and it does not
  reproduce the position dependence (stalls 14–17 % in bins 4–8 vs 9–13 % simulated). Inconclusive — the model may
  miss SdFat details or the stall may attach to a later command than the fetch. The bench A/B (zero stalls on
  `3c71953` vs one cluster per ~250 s on `394dee45`, same card, same workload) is the discriminator.

- **2026-09-13 12:06 ET — control iteration 1 on `3c71953` COMPLETE (1273 s, 20 trials, 240,258 accepted 0x70s, 0 faults)
  vs the baseline iteration `arena-log-20260913-014056-656.jsonl` on `394dee45` (same card, same sim/protocol):**
  | quantity | baseline 394dee45 | new 3c71953 |
  |---|---|---|
  | stalls > 10 ms / clusters | 15 / 4 (every 253 s ≈ 47.4k cmds) | **0 / 0** |
  | bar −1 / −2..−9 / jump / +2..9 (p50 µs) | 1999 / 1998 / 1977 / 1461 | **1460 / 1460 / 1460 / 1460** |
  | bar +1 | 621 | 621 |
  | grating non-sequential | 1181 | 1181 |
  | max sd_load (bar) | 88.6 ms | **1.8 ms** |
  | SD reads per accepted 0x70 | 1.0 (every command read) | **0.761** (= index changes; kind 13 confirms) |
  | req_age (0x70 dispatch → SPI start) | n/a | p50 1.73 ms · p99 2.56 · **max 4.8 ms** (under the 5 ms target) |
  | superseded loads | n/a | 0.6 % of frames |
  | trials flagged (> 10 ms) | 4 of 20 | **0 of 20** |
  All 20 trials `pass` with full coverage. Zero clusters where ~3 were expected (P ≈ 0.05 for one iteration under the
  baseline rate × 0.76) — iteration 2 doubles the exposure. If it stays clean, H-FAT (the FAT-sector re-reads were the
  card's hot spot) is the working explanation and fix A removed the stalls on this card; a back-to-back reflash of
  `394dee45` for one iteration would make it causal (proposed to Michael).

- **2026-09-13 12:27 ET — iteration 2 COMPLETE, soak ended (2 iterations, 0 faults, 0 resets, 2576 s).** Iteration 2:
  1281 s, 242,178 accepted 0x70s, **0 reads > 10 ms**, 20/20 trials pass, reads/cmd 0.76, req_age p50 1.72 ms / max
  4.8 ms, superseded 0.5 %. Two iterations on `3c71953`: **482k commands, 2554 s of streaming, 0 stalls** where the
  baseline rate (4 clusters / 1238 s, scaled by 0.76 reads/cmd) predicts ≈ 6 clusters (P(0) ≈ 0.003). Controller left
  idle on `3c71953`, Studio v0.77 (:8092) connected. Awaiting Michael's decision on the causal test (reflash
  `394dee45` for one iteration).

- **2026-09-13 12:29 ET — session closed at the bench (Michael: laptop must disconnect; no third trial).** Causal
  reflash test of `394dee45` DEFERRED (next bench session: one iteration on the old build, stalls expected at ~24.5k bar
  reads; then back to the fast-path build). Controller left on `3c71953`, display stopped, Studio disconnected (port
  free); the :8092 worktree server stopped; bridge 3.1 + sim (200 Hz) left as Michael started them. Host branch
  `claude/mode3-perf-sd` pushed; firmware `feat/sd-fastpath-2x10` stays local (tip `f6c11d2` built, `3c71953` on the
  controller). Standing next steps: causal reflash; card screening with `sd_stall_test.py` when cards arrive; read-free
  path (compressed RAM cache in the ITI, `archive/mode3-2026-09/sd-read-jitter-2026-09-13.md` §6); Codex diff review of `f6c11d2` before it
  is flashed; #201 PR consolidation; telemetry review session (`telemetry-review-handoff-2026-09-13.md`).

- **2026-09-13 12:45 ET — causal test prepared (bench later, Michael):** firmware `2c83f45` adds `SET_SD_DIAG` 0xCE
  (bit0 legacy FAT-chain seek at the next open, bit1 no same-index skip; readback 0xCD byte 29; `sd_layout` bits 2/3;
  STATE marker), built, Codex round 3 running — NOT flashed (controller stays on `3c71953`). Studio v0.77 gains
  `Studio.setSdDiag(flags)` + `run_metadata.sd_card.sd_diag`; telemetry-report labels the arm. Plan with predictions,
  stopping rules and procedure: `docs/development/archive/mode3-2026-09/sd-stall-causal-test-plan-2026-09-13.md` (arms 3 → 1 → 2 → 0 on one
  build, ~70 min; H-FAT fingerprint = `sd_slow` phase `seek` in the legacy-seek arms).

- **2026-09-13 13:00 ET — Codex round 3 on the 0xCE build (`.codex-review/codex-diff-review-20260913-123149-22302`):**
  blocking — `openPattern` reused the open handle on a same-pattern restart, so the legacy-seek arm would not have
  applied there (fixed `35bb196`: reopen when the applied mode differs; 0xCD byte 29 bit 2 = applied); also fixed:
  cache reuse separated from presentation accounting (`sd_cache_ok_`), checkpoints as STATE kind 14 (kind 13 unchanged),
  0xCB bit 6 gates 0xCE, exFAT caveat documented; harness `sd_stall_test.py` hardened (capture completeness incl.
  trial open/close + command reconciliation + incarnation check, exact over-gap counter, block-anchored wrap-safe
  controller time, bounded stall detail, per-open read totals, resync after a timeout, `--sd-diag N` arm with
  applied-mode verification, exit 4 unless usable). Firmware tip built, NOT flashed; a Codex diff review of the
  round-3 delta is owed before it goes on the controller. Extended campaign matrix (patterns × Mode 2/3 × speeds)
  added to `archive/mode3-2026-09/sd-stall-causal-test-plan-2026-09-13.md` §7.
- **2026-09-13 13:30–14:15 ET — Michael back online (remote, no bench). Codex round 4 on the round-3 delta
  (`0fc6b01..9de97fe`, `.codex-review/codex-diff-review-20260913-133230-26229`, report `report-20260913-fw-round4.md`):
  no blocking firmware finding; harness/codec fixes committed as `75405ee` (exact worst/cluster statistics, legacy
  kind-13 checkpoint decode, `--allow-v1` completion, single-probe resync, arm restore + consistency, exFAT refusal,
  offline `tests/test_sd_stall_stats.py`, two stale comments) and built — **`75405ee` is the build to flash next
  session** (bootloader route, port released first). Campaign trimmed to stress-first (plan §7: S1 8 MB sine + 813 KB
  bar at 286 Hz overnight, S2 at 200 Hz, C1 Mode-2 200 fps control); new `protocols/soak_mode3_stress.yaml`,
  `protocols/soak_mode2_open_loop.yaml`, `scripts/make-stress-patterns.js` (8.1 MB `sine_2000f_gs16`, 213 KB
  `bar_200f_gs2`, verified by re-parse), Studio soak driver accepts open-loop protocols (v0.77, 13:58 ET). Michael's
  design question answered in plan §5: cache the cluster chain per pattern open (extent table) → no contiguity
  precondition; to implement after the causal test.
- **2026-09-13 14:30–14:55 ET — hand-off shape (Michael: 2 h stress, not overnight; then ONE consolidated build
  soaked overnight, clean and mergeable for the lab tomorrow).** Finding: the consolidated build already exists —
  firmware `feat/sd-fastpath-2x10` `75405ee` is a linear stack of health → ring → watchdog → free-running timer (fw #50
  fix) → SD fast path on top of `arena-2x10-local` (fast-forward, 31 commits; conflicts with `main` only because #48
  moved main to per-board `-DARENA_HW_*` headers — the main port is a later PR, superseding #53). Web: PR #202 opened
  (`claude/mode3-perf-sd` → `claude/mode3-wedge-soak`, stacked on #198; both merge cleanly onto main, #198 CI green,
  `pixi run test` green). One-page run sheet `docs/development/archive/mode3-2026-09/soak-handoff-2026-09-14.md` (flash, serve, card,
  three runs, pass criteria, merge order). Firmware branch still LOCAL — push + PR against `arena-2x10-local`
  awaits Michael's go. RAM-cached FAT chain (extent table): deferred — decide on the 70-min causal result
  (§5 of the causal plan).
- **2026-09-13 14:46 ET — Michael at the bench (35–40 min).** Flashed `75405ee` (bootloader route, 6 s; label
  `75405ee6 2x10 2026-09-13 feat/sd-fastpath-2x10 freerun sdfast`). Causal test shortened: bar-only, 6 min per arm,
  driven by `scripts/sd_stall_test.py --sd-diag N` (first hardware use). **14:46:22 smoke, arm 3, 15 s:** 2,936
  commands, reads/cmd 1.00 (skip off), `sd_layout` legacy+no-skip, contiguous = 0 → **one cluster after ~600 reads:
  32.5 / 41.3 / 95.4 ms, all phase `body`, sd_slow_ctx 0/0** (card held the bus, no driver error). Phase body is
  consistent with H-FAT (SdFat `fatGet` at cluster crossings inside `read`, verified in `FatFile.cpp`); the plan's
  "phase = seek" fingerprint corrected. 14:47 arms started in order 3 → 2 → 1 → 0, 6 min each (logs
  `soak-logs/sdstall-*-armN.jsonl` in the ring worktree).
- **2026-09-13 15:04 ET — arms 3 and 2 done (each 6 min, 200 Hz, bar id 36 only, capture valid, no reboot, cmds
  reconciled).** **Arm 3** (legacy seek, no skip): 71,882 commands = 71,882 reads → **2 clusters**, spacing **23,275
  commands** (= the baseline 24.5k period): one of 16 stalls of 12–19 ms (a sub-20 ms signature never visible under the
  old 20 ms threshold) at 309 s and one classic 21.6 / 41.4 / 48.2 / **90.8 ms** at 426 s; phases body (one seek);
  bar −1 step 2.0 ms p50. **Arm 2** (contiguous seek, no skip): 71,992 commands = 71,992 reads — the SAME read count —
  → **0 reads over 10 ms, 0 slow reads at all, worst read 1.8 ms, req_age max 3.0 ms**; bar −1 step 1.46 ms.
  ⇒ **H-count and H-data rejected, H-FAT confirmed:** identical data-read exposure, the only difference is whether the
  FAT is touched. The same-index skip (B) is not what removed the stalls. Arms 1 and 0 running (1 = legacy seek with
  skip on → clusters expected, closes the "B did it" loophole from the other side; 0 = production on `75405ee`).
- **2026-09-13 15:08 ET — arm 1 done** (legacy seek, skip ON): 71,959 commands, 54,885 reads (0.763 reads/cmd) →
  **1 cluster of 6 stalls (21.4 / 19.5 / 22.9 / 48.0 / 19.1 / 70.2 ms)**, capture valid. Stalls persist with 24 % fewer
  data reads and the FAT still touched ⇒ the same-index skip is irrelevant to the stalls (as arm 2 vs 3 already showed).
  Arm 0 (production) running until ~15:12.
- **2026-09-13 15:11 ET — arm 0 done, causal test COMPLETE (4 × 6 min, all captures valid, 0 reboots).**

  | arm | FAT touched | reads/cmd | reads | stalls > 10 ms | clusters | worst read | req_age max |
  |---|---|---|---|---|---|---|---|
  | 3 legacy seek, no skip | yes | 1.00 | 71,882 | 20 | 2 (spacing 23,275 cmds) | 90.8 ms | 76.7 ms |
  | 2 contiguous, no skip | no | 1.00 | 71,992 | **0** | 0 | 1.8 ms | 3.0 ms |
  | 1 legacy seek, skip | yes | 0.76 | 54,885 | 6 | 1 | 70.2 ms | — |
  | 0 production | no | 0.76 | 54,900 | **0** | 0 | 1.8 ms | 2.9 ms |

  **Conclusion: H-FAT confirmed, H-count and H-data rejected.** The stalls were induced by the firmware's FAT access
  (SdFat chain walk on backward seeks + `fatGet` at cluster crossings inside `read`) hammering the card's FAT block;
  the contiguous-seek fix removes them at identical data-read exposure; the same-index skip is irrelevant to them.
  Production build `75405ee`: bar −1 step 1.46 ms p50 / 1.8 ms max, req_age p50 1.7 ms / max 2.9 ms at 200 Hz.
  15:12 started the 2 h production run at 286 Hz on the bar (`--label prod-286hz-2h`), unattended.
- **2026-09-13 15:20–15:50 ET — whole-stack Codex reviews + fixes (Michael: laptop stays; review, adversarial pass,
  one hand-off document; 2 h stress then the candidate overnight).** Firmware `arena-2x10-local..75405ee` and web
  `main..claude/mode3-perf-sd` reviewed whole (`.codex-review/report-20260913-fw-fullstack.md`, `…-web-fullstack.md`).
  Fixed and re-reviewed (fw round 5): **firmware `e59767e`** (panels blanked at boot after a watchdog/software reset,
  watchdog kicked inside the ISP loops, same-index skip only after a successful DAC/LUT update, exFAT refusal for the
  legacy arm, harness backlog drain, campaign/upload script fixes; built, hex sha `578cc29e…`, NOT yet flashed) and
  **Studio v0.78** (verdict + final drain before the export, drain problems → unknown, bridge send failure not acked,
  FRAME read time in verdicts, link-drop = CONTROLLER_FAULT, stress gain 0.18; PR #202 updated, `pixi run test`
  green). New docs: `mode3-reliability-handoff-2026-09-14.md` (the one hand-off document),
  `runlog-format-review-2026-09-13.md` (≈133 MB/h raw, 35–40 gz at 200 Hz; R1 stream-gzip, R2 schema v3),
  `archive/mode3-2026-09/consolidation-plan-2026-09-13.md`. Plan for 16:12: stop the 286 Hz run (1 h), flash `e59767e`, HIL subset, upload
  the 8 MB sine browser-free, verify indices, start the alternating campaign (286 Hz → 18:15, 200 Hz → 21:00).
- **2026-09-13 16:02 ET — overnight test plan written (`overnight-soak-test-plan-2026-09-13.md`: timing T1–T7, log
  completeness L1–L7, recovery R1–R5 + a pre-overnight drill: injected stall via 0xCE, injected watchdog reset via
  0xA8 flags 0x31, simulator kill). New `scripts/runlog-check.py`; on this morning's v0.77 log it FAILS as predicted:
  `trial_quality` 359 lines before the last controller row, 22 command records lost to the export, ring dropped
  1,157 between runs — the v0.78 fix is what the overnight must prove.**
- **2026-09-13 16:12 ET — switch.** 1 h production run on `75405ee`, bar only, **286 Hz: 1,036,992 commands, 788,704
  reads, 0 reads > 10 ms (worst 1.8 ms), req_age p50 1.7 / max 3.0 ms, 0.76 reads/cmd, capture valid, usable.**
  Flashed **`e59767e`** (bootloader route, 7 s). HIL subset (`-x`, no `--pat`): `test_firmware_version` passed;
  `test_health.py::test_loop_max_1s_window_is_populated` FAILED (`loop_max_1s_us == 0` at ~3 s uptime) — open item:
  re-run at the drill, decide flake vs regression before the overnight. Uploaded `sine_2000f_gs16.pat` browser-free:
  **index 46, 2000 frames, 8.1 MB in 1.4 s (5.7 MB/s)**; verified idx 36 = 200 frames, idx 46 = 2000. Campaign started
  16:12:53 (`sd_soak_campaign.sh … "46 36" 286 1815 200 2100 10`, detached under caffeinate): segment 1 = sine at
  286 Hz, `sd_layout` code 1 → **contiguous**, 8 sectors/cluster.
- **2026-09-13 16:23 ET — campaign segment 1, 8 MB sine (idx 46) at 286 Hz on `e59767e`, 10 min: 171,482 commands,
  130,758 reads, 0 reads > 10 ms (worst 1.8 ms), random-step read p50 1.39 ms — the same as the 813 KB bar —
  req_age p50 1.67 / max 2.94 ms, contiguous, usable.** First evidence that the fast path has no size dependence
  (2000-entry chain, 2 MB seeks). Segment 2 = bar at 286 Hz.
- **2026-09-13 17:27 ET — segments 1–7 (286 Hz, sine/bar alternating) all clean:** ~171.5k commands each, 0 reads
  > 10 ms, worst 1.8 ms, random read p50 1.39 (sine) / 1.46 (bar) ms, req_age max 2.9–3.0 ms, 0 reboots.
- **2026-09-13 17:35 ET — hand-off paths decided (Michael):** firmware stays on `feat/sd-fastpath-2x10` as the merge
  candidate — PUSHED, PR reiserlab/LED-Display_G6_Firmware_Arena#55 against `arena-2x10-local`; Studio #198 + #202
  go to `main` tomorrow morning without a separate review once the night is clean (revert if needed).
- **2026-09-13 18:16 ET — stress phase done (13 segments at 286 Hz, ~2.2 M commands, ~1.7 M reads); ONE slow read.**
  Segment 9 (`sdstall-20260913-173259-camp-286-p46`, 8 MB sine), 472 s in: frame 47 → 44 (−3 step), **body phase,
  19.4 ms, `sd_slow_ctx` 0/0 (no driver error), single event (no cluster), next read 0.62 ms; req_age max 19.6 ms.**
  Not the FAT signature (contiguous file, no FAT access, not quantised 23/33/41…, not clustered) — the exact
  "phase body on the 8 MB file" watch item from the campaign plan (a data-region event?). Rate so far: 1 in
  ~2.5 M fast-path reads today; below Michael's 30 ms "detectable" line, above the 10 ms flag line → that trial would
  be *flagged*. Night phase (200 Hz) started 18:16; watching for recurrence and whether it stays on the 8 MB file.
- **2026-09-13 18:25–18:58 ET — port onto `main` (Michael: build tonight's candidate on Frank's #48).** A Fable
  sub-agent produced `feat/mode3-reliability` = main + the stack + a 2×10 variant (`ARENA_HW_2_10`, envs
  `teensy41-2-10[-performance]`), three commits (`6782cda` variant, `165dc8f` stack, `488d5b9` tests+tools); all
  three arena variants build; `src/` byte-identical to `e59767e` except the variant plumbing; 2×10 `panel_sets`
  (50 numbers) and tie-high list verified equal to the bench build. Codex pass (`…-port/.codex-review/report-20260913-port.md`):
  nothing against the plumbing; HIL `SET_SD_DIAG` tests made exFAT-aware; blank-before-`sd.begin()` and the test
  geometry fixture deferred. **Pushed; PR #56 against `main` = merge candidate; #55 and #53 closed.** Hex
  `firmware-488d5b9-2-10.hex` (sha `d8b31ca7…`) archived in the scratchpad; flash at the drill. Studio v0.79 (session
  rig follows the controller's rows × cols — fresh profiles came up `g6_3x10`). Docs: wedge-era notes archived;
  PRs #198/#202 carry a History-and-tests section; hand-off §6.0 test history.
- **2026-09-13 19:09 ET — campaign stopped (18 complete segments: 13 × 286 Hz, 5 × 200 Hz, all usable; the only
  event the 19.4/6.4 ms pair in segment 9); flashed `488d5b9` (2×10 variant on main) 19:09:59.** HIL subset: 26 passed,
  3 failed = the two pre-existing flakes (`test_crashreport_passthrough` after HalfKay, `test_overfill…`) +
  `test_loop_max_1s_window_is_populated` at ~3 s uptime, which **passes when re-run at normal uptime** → early-boot
  artefact, not a regression. Studio v0.79 on :8092 (Michael picked the port after the re-enumeration): label
  `488d5b9b 2x10 2026-09-13 feat/mode3-reliability freerun sdfast`, **session rig derived `cshl_g6_2x10_ball`** (the
  log shows the g6_3x10 io defaults applied first, then re-applied for the derived rig one second later — ordering
  follow-up, same io values), sd card line, `sdDiag` 0, telemetry available. 19:17 drill step 1: `setSdDiag(3)` +
  one-trial drill protocol (`protocols/mode3_drill_1trial.yaml`).
- **2026-09-13 19:17–19:30 ET — drill step 1 (injected stall), two runs.** (a) 60 s Test run via `runOnce(false)`:
  ran **pattern 4** (`p100_slow_bar`), not the bar — the bench card is the COURSE card (36 = `p3_heisenberg_ts`, the
  813 KB/200-frame file used all day; 5 = `course_grating_36deg`; 46 = the sine) and the protocols' names
  `frame2_h_ccw_200f`/`grating_sq` do not exist on it, so they fell back to `pattern_ID`; the Test-run log had no
  `run_metadata` and v1-style `arena_command` objects instead of `a` rows. Fixed the protocols (names + ids 36/46,
  drill 180 s) and documented "drill via a 1-iteration soak". (b) **180 s via the soak driver, arm 3 (legacy seek +
  no skip), pattern 36: 34,903 commands, 34,904 reads, reads/cmd 1.00, sd_layout = legacy applied + no-skip —
  0 stalls, worst read 2.0 ms, −1 step p50 1.39 ms (the FAST-path cost; the same arm showed 2.0 ms and clusters
  every 23k reads at 15:00 on `75405ee`).** Log completeness on this soak-path file: `run_metadata` (label
  `488d5b9b…`, card + arm), 34,905 `a` rows vs 34,903 `cc`, drainer gaps/notStored/errors 0, `trial_quality` AFTER
  the last controller row → **the v0.78 export-ordering fix confirmed on a real run**; `runlog-check` fails it only
  for the expected arm ≠ 0. Frame-count-from-0x88 fill added to the Studio (v0.79) — the sine would otherwise have
  run with the bridge's 200-frame default modulus tonight. 19:32: harness arm 3 on `488d5b9` to see whether the
  legacy arm stopped biting because of the Studio path or the build.
- **2026-09-13 19:35 ET — RESOLVED: the Studio drill ran a 20-frame loop.** Harness arm 3 on `488d5b9`, 3 min,
  pattern 36: −1 step 1.99 ms, 1 stall (21.8 ms) → the build and the arm are fine. Index coverage: harness 200
  distinct frames, uniform; **Studio drill: frames 0–19 only** — the bridge's heading→index modulus was still 20
  (the last `config.frames` it had received, the grating this morning) because the Studio had no frame count for
  `p3_heisenberg_ts` and passed none. 20 frames = 80 KB inside one FAT sector → no chain walk, no stall, fast-path
  costs. The frames-from-`GET_PATTERN_INFO` fill (v0.79, 19:25) is the fix; without it the overnight would have run
  every pattern as a 20-frame loop. Lesson for the test plan: **index coverage (distinct frames per trial) is a
  pass criterion**, added as T8.
- **2026-09-13 19:49–19:55 ET — drill via the reloaded Studio (frame counts from the card: bar 200, sine 2000;
  index coverage 200/200):** the legacy arm now bit through the Studio path too — −1 step 1.99 ms, **one 18.3 ms
  body-phase stall** in 35.7k reads. But the Studio's verdict said `pass` with two phantom trials: my two start
  commands overlapped; the first soak was aborted and its LATE terminal event finalized the second run's trials one
  second in (v0.78 finalize memoised per run, reset at run start, so the second run's own finalize was a no-op and the
  stall was fed with no open trial). **Fixed (v0.79): the finalize is bound to the run id; a stale caller is
  ignored.** Also fixed: simulator field 22 written in ms instead of ns (every sim log's `ft` was 1000× too small;
  found by the telemetry-review session) — sim restarted 19:55 with the fix; a footer stamp mangled by `sed -E`.
  `pixi run test` green. Retrying the drill with a single start.
- **2026-09-13 20:09–20:13 ET — drill, single start, arm 3, pattern 36, 180 s:** 34,821 reads over **200/200
  frames**, legacy arm applied, −1 step at the legacy cost; **0 stalls this time** (max read 3.4 ms); verdict 1 trial
  `pass`, `trial_quality` after the last controller row, counts reconciled (34,820 cc / 34,822 a). The Studio banner
  for a real stall therefore remains unexercised (the 19:49 run had the stall but the overlapping-run bug ate it).
  20:14: arm back to 0 (production); watchdog drill next.
- **2026-09-13 20:14–20:17 ET — drill step 2, forced watchdog reset (R2):** production arm, drill trial started
  20:14:05; `SET_TELEMETRY` flags 0x31 (starve) sent 20:15:07 → controller reset ≈ 2 s later → link dropped →
  runner aborted → **post-mortem `self-reset`**: quiet → confirm 0xC2 → HEALTH → ring dump (`survivedReboot: true`,
  19 records, the last FRAMEs before the reset intact) → crash report (`present: false`, as expected for a watchdog
  reset) → probes → firmware identity; ring rows include kind 1 `boot` and kind 8 `wdog_context`; **the Studio
  reconnected WITHOUT a port picker** (the Web Serial grant survived the re-enumeration — the unattended night can
  recover from a watchdog reset); soak iteration-end `outcome: fault, fault: link_dropped, postmortem: self-reset`;
  the trial `unknown` (correct). Two findings: (1) **two panels stayed lit after the reset** (Michael) — the boot
  blank's three dark frames did not reach them; all-off sent 20:17:08 to see whether the bus takes it now; (2) the
  runner's terminal event carried `fault: null` because the disconnect listener ran after the broker's abort → the
  run's stored outcome would read ABORTED_BY_USER — fixed in v0.79 (link down at an unrequested abort ⇒ fault).
- **2026-09-13 20:17 ET — all-off from the Studio blanked the two panels** (bus fine; the boot blank was too early for
  them) → one-line firmware fix: a second `blankPanelsAtBoot()` at the END of setup (`f736cae` in the port worktree,
  built; Codex pass running; flash before the overnight with Michael's OK).
- **2026-09-13 20:18–20:21 ET — drill step 3, USB cable pulled 5 s during a trial (Michael):** link dropped → runner
  aborted → post-mortem `self-reset` path → ring dump `survivedReboot: true`, **no boot record: the controller never
  rebooted** (it is powered from the arena supply; USB is data only) → crash report read → probes → **reconnected
  without a port picker**; soak iteration-end `fault: link_dropped, postmortem: self-reset`. Panels kept the running
  stimulus through the unplug (no reset, no blank) — expected; only a controller reset blanks them.
- **2026-09-13 20:20–20:23 ET — drill step 4, arena power pulled ~10 s during a trial (Michael):** the controller
  is on the arena supply → full power-on: link dropped → post-mortem `self-reset` → **fresh ring** (`survivedReboot:
  false`, bootCount 0, records `boot`, `state_change ALL_OFF` from the boot blank), drainer incarnations 1 → 2
  (old cursor discarded, not trusted), crash report read, probes, identity, reconnected; soak ended on the fault.
  Codex on the boot-blank one-liner: no defect, "an unverified retry" — comment reworded, rebuilt `781efe2`;
  verification = one forced reset with Michael counting dark panels after the flash.
- **2026-09-13 20:23–20:30 ET — flashed `781efe2` (boot-blank retry); all 20 panels dark after the flash reboot;
  the Studio reconnected by itself (grant survived the bootloader trip). Forced watchdog reset 20:28:34 on a trial:**
  recovery chain complete again (fault, self-reset, boot + wdog_context records, reconnect); **panels: 19 dark, one
  showed a panel-side error glyph ("02/03"), then the arena came back lit** — the ring holds NO frame transfer after
  the reboot (only identity/header reads incl. 48 × 0x88 from the frame-count fill, which reads headers via
  `readPatternInfo`, no display), so the re-lighting is panel-side (persistent panels restoring their last frame after
  the glyph), not a controller command. Not blocking for the night; lab plan: after any reset, check the arena and
  send all-off if lit. Steady state to be confirmed by Michael.
- **2026-09-13 20:35 ET — OVERNIGHT STARTED** (Studio v0.79 build 20:17 with all of tonight's fixes, firmware
  `781efe2`, `protocols/soak_mode3_stress.yaml` = sine idx 46 (2000 frames, gain 0.18) ⇄ bar idx 36 (200 frames,
  gain 1.8), simulator 200 Hz seed 1 jumps 90°/100 (restarted 19:55 with the ft fix), bridge 3.1 logging behavior_v2,
  `sdDiag` 0, rig `cshl_g6_2x10_ball` derived, `hours: 10, gapS: 10, firstFault: halt, policy: reset-continue,
  maxResets: 3`). Michael: "super fast pattern movement" — the sine at 0.18°/frame, as designed. Judge in the morning
  per `overnight-soak-test-plan-2026-09-13.md` (T1–T8, L1–L7, R1–R5).
- **2026-09-13 21:36 ET — overnight, 1 h in: 2 iterations complete (1238 s each, ~231.7k commands each), 40/40
  trials pass, 0 reads > 10 ms, req_age p50 1.68 / max 4.83 ms (under the 5 ms target), drainer dropped/gaps/
  notStored/errors 0/0/0/0, both files contiguous; per-read cost sine 1.385 ms p50 random (max 1.80) vs bar 1.459
  (max 1.80); superseded share 3.6 % (200 Hz commands vs 300 Hz refresh); `trial_quality` after the last controller
  row in both files. Only checker complaint: host-accepted exceeds controller-recorded 0x70 by 21 per file (0.01 %,
  the last ~100 ms before the file rolls) — tolerance question for `runlog-check`, morning item.
- **2026-09-13 22:36 ET — overnight, 2 h in: 5 iterations complete, 100/100 trials pass, 0 reads > 10 ms, req_age max
  4.83 ms in every iteration, drainer 0/0/0/0 throughout, ~1.16 M commands; bridge + simulator alive.**
- **2026-09-13 23:45 ET — overnight event: one 26 ms body-phase read on the 8 MB sine (pattern 46, frame 1942,
  trial 3 of iteration 9, no driver error) → the Studio emitted `display_gap` (sd_slow 26 ms + frame_age 26.2 ms) and
  will flag the trial — the real-stall verdict path exercised for the first time; the soak continues (a stall is not
  a fault).** Second data-region event of the day on the sine (17:40: 19.5 + 6.4 ms), none on the bar; both on the
  contiguous fast path with no FAT access → card-internal, rate ≈ 1 per 2–3 M reads of the large file (≈ one per
  3 h at 200 Hz). Below Michael's 30 ms "detectable" line, above the 10 ms flag line.
- **2026-09-14 06:52 ET — OVERNIGHT COMPLETE: 29 iterations / 10.3 h (reason `hours`), 0 faults, 0 resets,
  6.85 M commands, 579 trials pass / 1 flagged / 0 unknown; the only event the 23:45 26 ms read; every other read
  ≤ 1.8 ms; req_age p50 1.75 / p99 2.56 / max 4.83 ms; superseded 1.39 %; host RTT 3 ms median every file, p99
  4–11 ms; drainer 0/0/0/0 in every iteration; `runlog-check` 29/29 complete (after correcting its host-side count to
  0x70 rows in both hex spellings); `wedge-scan` 0 onsets. Full table: hand-off §6. Next: Studio #198 → #202 to
  `main` (squash), lab day on PR #56's `781efe2`.**

- **2026-09-14 18:55 ET — first field data on the candidate (rig03-sr, Shubham, Windows lab PC, real flies).** 13 runs committed to the course repo
  between 11:59 and 18:12 ET: 3 short (26 trials) + 10 full `p3-heisenberg-ts-full-led3` (56 trials, 18 min), fw `781efe2b`,
  Studio v0.79, log level behavior_v1 (bench setting), card `SD8GB mid_0x00 sn 000009de FAT32 32 KiB clusters` (same generic
  model as the bench card sn 000014d4, 4 KiB clusters). All 13 sequences completed; `wedge-scan` 0 faults / 0 resets, RTT median
  2 ms, p99 8–13 ms; `runlog-check` 13/13 structurally complete; 638 trials = 632 pass / 6 flagged / 0 unknown. **The 6 flags are
  all the same event on pattern 41 (`p3_heisenberg_ts_shift90`)**: 16 body-phase reads of 18.8/22.4 ms alternating, then one
  73 ms, ≈ 400 ms of frozen display inside a 20 s trial; identical signature six times, at frame indices 12, 17, 0–112, 58–112,
  97–116, 153–167 (no position dependence), every 15.5–19.8 k reads of pattern 41 (cumulative across runs), while pattern 36
  (same size, same read count 126 k vs 123 k) never stalled. Both files `contiguous`, contiguous-path share 1.0, no FAT access:
  this is the card's own count-triggered maintenance on the physical block holding pattern 41, not H-FAT. The Studio flagged
  every one (trial_quality + 34 display_gap events per run). Logs reviewed offline from the course repo; nothing changed on the rig.

- **2026-09-15 13:52 ET — Isabel's lab-day logs reviewed (`soak-logs.zip`, 20 files, TEST-MAP.md + her three analysis outputs).** Card
  `SD8GB sn 000014ca FAT32 4 KiB` (course card), sine landed at index 54 (name resolution worked). **A:** 3 iterations, 0 faults /
  0 resets, 59 pass / 1 flagged (one 20.9 ms sine read, trial 1) — but iteration 2 ran the whole 21 min at ~110 ms host RTT
  (≈ 9 Hz commands, controller clean). **B:** arm 3 confirmed in force (`FRAGMENTED, LEGACY-SEEK, NO-SKIP`) but only 8.4 k reads in
  3 × 180 s because the host was in the slow state — no stall, so B is *inconclusive*, not a pass (the bench card needed ≈ 24.5 k
  reads per cluster). **C:** pass (40 s simulator outage, trial completed, soak resumed). **D:** attempt 1 under arm 3
  (discarded); attempt 2 `self-reset-failed` although reconnected + MAC verified + all probes status 0 — the 50 ms
  `degradedDtMs` rule tripped on 36–80 ms host-slow replies; attempt 3 `self-reset` in 3.5 s, probes 0–4 ms, soak continued,
  D passes. Isabel found two analyzer defects, both confirmed in code: `wedge-scan` counts post-mortem `phase: reset/post-reset`
  rows as resets (10 per link drop; real 0/0/1); `runlog-check` FAILs by design cases (header fragments without run_metadata,
  fault files whose post-reset ring dump lands after `trial_quality`, cumulative session drainer counters). Windows benchmark
  column filled in the lab plan; open host-side finding in its §7.1.

- **2026-09-15 17:04 ET — Windows "slow host" explained and fixed.** Isabel (16:25 ET): the slowdown is watching the Run log during
  a run (dock on Log); Scope/Console are fast; the arena visibly chugs. Root cause in `arena_studio.html`: each transport
  line appended to the visible log with a forced layout before and after (≈ 400 layouts/s at 200 Hz); the Scope hides the
  box so the same reads cost nothing. Measured on the Mac bench, dock on Log, 8000 lines: v0.79 18.5 s (2.3 ms/line) →
  v0.81 5 ms to queue + 10 ms to flush (PR #205, stacked on the analyzer fixes #204). Post-mortem recovery rule fixed in
  the same PR (host latency no longer vetoes a healthy controller). Isabel re-ran test B watching the Scope (16:44 ET,
  three files posted in #panels) — to be reviewed once downloaded.

## 11. T4 as built (2026-09-12) — soak with ring-buffer logging

Decision (Michael, 11:30 ET): skip the instrument-dependent T2/T3 for now; build the ring (T1
scope) and run the soak on it (T4). Host side landed in PR #198; firmware on
`feat/telemetry-ring-2x10` (built off `feat/controller-health-2x10`).

- **Ring** (firmware): 64 KiB byte ring at OCRAM `0x2026F000`, below the breadcrumb, NOT in any
  linker section → **survives SYSTEM_RESET and the bootloader reboot** (init only when the header
  magic/checksum is invalid, i.e. after power-on). Records `len,type,seq u32,t_us u32,payload`:
  `CMD` (cmd, status, ≤8 request bytes), `FRAME` (idx, pattern, sd_load_us, spi_us — on index
  change), `STATE` (boot, state_change, error_glyph, sd_slow >20 ms, ring_overrun, telemetry,
  sd_open). Newest dropped when full (counted). Opcodes 0xA8 SET_TELEMETRY (events default ON),
  0xA9 GET_TELEMETRY_BLOCK — 18 B header `{t_now_us, first_seq, n_records, dropped, more, flags,
  boot_count}` + whole records ≤ 180 B; **ack cursor**: records are freed only by the NEXT
  request's ack_seq, so a lost reply is re-asked, never lost (framing "A", one framed reply).
- **Host**: `js/arena-telemetry.js` (`parseBlock`, `toRows`, `createDrainer` with seq/gap/drop
  accounting, `createPoller` single-flight), `Studio.initTelemetry()` on every link-up (gated on
  the `health` capability + a SET_TELEMETRY ack), 10 Hz drain while connected (pauses during the
  post-mortem), rows via `bridge.logRows()` → bridge 3.1 writes `["cc"|"cf"|"cs", rx, t_us, seq,
  …]` verbatim; one `stream_schema` event per log. `Studio.drainTelemetry()` = drain-all crash
  dump, wired into the post-mortem's `afterReconnect`. `wedge-scan.py` gains `ctl recs`, `sd max
  us`, `ctl states`, `ctl rejects` and prints the last 40 controller records before a wedge under
  `--verbose`.
- **Cost**: ~2.6 KB/s of records in Mode 3 at 100 Hz (CMD 1.6 KB/s + FRAME ~1 KB/s) → ~2 framed
  chunks per 100 ms poll; recording a record is a few dozen cycles at the choke points.
- **Deferred**: TICK/analog yoking (needs F1/F2 + AD3), T2/T3 (instruments), clock fit (§ 8) —
  rows carry raw `t_us` + host `rx`; the fit is an analysis step.
