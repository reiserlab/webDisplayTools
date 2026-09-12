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
