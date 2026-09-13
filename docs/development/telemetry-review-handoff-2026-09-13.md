# Handoff — telemetry review session: what is logged now, how the three clocks relate, how to measure round-trip latency, and what to test next (Teensy-only timing)

**Written:** 2026-09-13 (performance session, Studio v0.77 / firmware `feat/sd-fastpath-2x10` `3c71953`).
**For:** a review session that does NOT implement anything. Deliverables of that session: (1) an authoritative
"what gets logged" reference (the pieces below are scattered over five docs and three code bases); (2) a
timestamp/clock model for FicTrac → bridge → Studio → controller with the evidence for each edge; (3) a
round-trip-latency measurement plan; (4) the next experiments, favouring measurements the Teensy can make on
its own (no Analog Discovery, no Saleae). **Michael's acceptance numbers:** display freeze 5 ms target, 10 ms
worst case; ≥ 30 ms is a visible artifact.

Read in this order: this file → `telemetry-performance-handover-2026-09-12.md` §4–§6 (log format as of the
ring's first night) → `archive/mode3-2026-09/sd-read-jitter-2026-09-13.md` (what changed today and why) → firmware README
"Telemetry ring", "Health + breadcrumb", "Free-running refresh timer", "SD fast path" sections (ring
worktree `/Users/reiserm/Documents/GitHub/LED-Display_G6_Firmware_Arena-ring/README.md`) →
`controller-telemetry-ring-buffer-proposal.md` (the original design + §8 clock fit, §9 instrument plan).

---

## 1. The three systems and what each one stamps

| system | clock | what it stamps | where it lands |
|---|---|---|---|
| **FicTrac (or `fictrac_sim.py`)** | camera hardware clock (real rigs: col 22 in ns, converted to ms by the bridge; sim: `frame × dt_ms`, monotonic from 0) | one row per tracked frame: `fc` frame counter, `ft` col-22 timestamp, heading, x/y | behavior_v2 frame rows `[ms, fc, idx, ft, x, y, hd]` |
| **bridge** (`fictrac-bridge/bridge.py` 3.1, Python, same machine as the browser) | `time.time()` wall clock, epoch ms | `ms` = bridge receipt of the FicTrac packet; `rx_off` = bridge receipt of a Studio echo; `rx` = bridge receipt of a drained ring block; `t0` in `frame_schema` = log origin (epoch ms) | every row it writes; `frame_schema.t0`; `log_control_ack` |
| **Studio** (browser, `js/arena-session.js`) | `Date.now()` epoch for stamps, `performance.now()` for durations | `t_off` = `Date.now() − t0` when the command is SENT; `dt` = monotonic round trip **including queue wait** (single-flight link) | `["a", t_off, dt, hex, status, rx_off(, error)]` |
| **controller** (Teensy, `micros()` u32, wraps every 71.6 min) | `t_us` | CMD record: dispatch entry of every command; FRAME record: **start of the SPI transfer** of a displayed frame change; STATE records: at the event; 0xA9 block header `t_now_us`: reply time | ring records → `cc` / `cf` / `cs` rows (`rx` = bridge receipt of the DRAIN, not of the event) |

Known relationships (measured): host↔controller drift **−3 ppm** (fit of `a`-row send time vs `cc.t_us` paired by
order, 2026-09-12); Chrome background-tab throttling quantises timers to ~1 s (night 1). Missing today: **no field
links a FicTrac frame (`fc`) to the 0x70 it produced** — the bridge client coalesces frames (newest index wins,
`FicTracBridgeClient._drain`) and the `a` row carries only the request bytes. That is the first gap to close if
end-to-end latency (FicTrac frame → LED) is wanted (§4).

## 2. What gets logged, by layer (as of Studio v0.77 + fw 3c71953)

### 2.1 Bridge log file (behavior_v2 NDJSON, one file per run / soak iteration, rotated by `log_control`)

- Line 1 `{"type":"frame_schema","level":"behavior_v2","cols":[…],"arena_cols":["t_off","dt","hex","status","rx_off"],"t0":<epoch ms>}`.
- FicTrac rows `[ms, fc, idx, ft, x, y, hd]` (numbers first). `idx` = the frame index the bridge derived
  (gain × heading, wrapped modulo the trial's `frames` — pushed by the runner per trial via `config`).
- Host echoes `["a", t_off, dt, "03 70 lo hi", status|null, rx_off(, "error")]` for every arena command
  (0x70 stream + protocol commands); requests > 8 B (TRIAL_PARAMS) fall back to the v1 `arena_command` object.
- Controller ring rows, in **ring `seq` order** (never sort by `rx`/`t_us`):
  - `["cc", rx, t_us, seq, cmd, status, "reqhex"]` — every command the controller dispatched (except 0xA9);
    `reqhex` = first ≤ 8 request bytes AFTER `len cmd` (so `2d00` → index 45; the host `a` row keeps the full `03 70 2d 00`); `status` = the reply's status.
  - `["cf", rx, t_us, seq, idx, pattern, sd_load_us, spi_us, req_age_us, superseded, flags]` — a displayed frame
    CHANGE (held frames are not recorded). Last three fields are **ring v2 only** (fw 0xCB bit 5): `req_age_us` =
    dispatch of the 0x70 that requested this frame (or the `loadFrame` decision in Mode 2/4) → SPI start, u32;
    `superseded` = SD frames loaded into the buffer but replaced before any transfer since the last FRAME record;
    `flags` bit0 SD read, bit1 contiguous-file fast path.
  - `["cs", rx, t_us, seq, kind, code, arg]` — STATE: 1 boot (code = reset cause, arg = prev breadcrumb), 2 state_change,
    3 error_glyph, **4 sd_slow** (arg = read µs/100; threshold **10 ms** on v2 (20 ms on v1); v2 code bits 0-1 = slowest
    phase 1 seek / 2 body / 3 CRC trailer, bit7 = read error), 5 ring_overrun, 6 telemetry, 7 sd_open (arg = pattern),
    8 wdog_context, 9 prev_isr_count, 10 timer_fail, **11 sd_layout** (code bit0 contiguous, bit1 exFAT; arg =
    sectors/cluster), **12 sd_slow_ctx** (code = SdFat sticky errorCode, arg = USDHC IRQSTAT bits 16-31 at the last
    driver error), **13 sd_reads** (reads while the pattern was open, `arg << code`).
- Events (JSON objects): `run_metadata` (protocol, rig, `firmware` = 0xCB label, **`sd_card`** = 0xCD identity
  {manufacturer, pnm, prv, psn_hex, mdt, capacity_gb, card_type, fat, bytes_per_cluster, cid_hex, label},
  `telemetry` ring-10hz|off, `log_format`, `gap_threshold_ms`, `soak{…}`), `stream_schema` (the cc/cf/cs columns +
  kind names), `runner` phases, `soak` phases (`iteration-end` carries `applied_0x70`, drainer stats),
  **`display_gap`** (trial, pattern, seq, t_us, ms, kind sd_slow|frame_age, phase/idx) and **`trial_quality`**
  (per-trial table + counts, at run end), `probe` / `telemetry_dump` / `crash_report` (post-mortem),
  `health` snapshots, `soak_note`.
- Analyzers: `scripts/wedge-scan.py` (faults, RTT, controller states), **`scripts/telemetry-report.py`** (reads
  accounting, SD cost by step class, stall clusters with spacing in commands/index changes/seconds,
  request→presentation percentiles, per-trial pass/flagged/unknown), `js/runlog-format.js` readers skip tagged rows.

### 2.2 Controller-side, on demand (not streamed)

- `GET_HEALTH` 0xCA (v5, 114 B): uptime, loop max, sd_reads / sd_read_max_us / last_sd_read_us, frames, ISR counters,
  cmd70_count, state, reset cause, reset-surviving **breadcrumb** (last op + arg + stamp; 0x70 sub-ops preload/arm/
  respond), previous boot's slowest op, watchdog fields (`ver` is a wire byte — do NOT bump it per build).
- `GET_FIRMWARE_VERSION` 0xCB: sha, branch, date, arena, flags (bit2 ring, bit3 crashreport, bit4 freerun, **bit5 sdfast**).
- `GET_SD_INFO` 0xCD (new): CID/CSD identity + FAT type + cluster size (the bench card: MID 0x00 OEM "42" `SD8GB`,
  8 GB SDHC, FAT32, 4 KB clusters).
- `GET_CRASHREPORT` 0xCC: raw PJRC fault region (junk after a bootloader reflash — known).
- RAM-only counters not on the wire yet: `cmd70_same_index` (Health stats).

### 2.3 Standalone (no browser)

- Firmware `scripts/sd_stall_test.py` — Mode-3 driver + ring drainer writing the same row shapes + inline stall
  summary (card comparisons). **Codex review flagged it as not yet measurement-grade** (pacing bursts after stalls,
  backlog contamination, capture validity, clustering by host receipt time) — fixes are in the perf session's queue;
  do not compare cards with it until they land.
- Firmware `scripts/telemetry_drain.py`, `scripts/soak_mode3.py` (older, no 0xCB/0xCD).

## 3. Evidence for the clock model (what has actually been checked)

| edge | evidence | confidence |
|---|---|---|
| sim → bridge (`ft` vs `ms`) | sim `ft` is synthetic (frame × dt); `ms` is bridge receipt; UDP on localhost | trivial; **real FicTrac never measured** |
| bridge → Studio (WebSocket) | not separately stamped; `a.t_off` is the SEND time after the client coalesced frames | gap: no per-frame receipt stamp in the browser |
| Studio send → controller dispatch | pair `a` rows with `cc` 0x70 records by order (drop the pre-run ring backlog); linear fit `t_host = a + b·t_us` → −3 ppm; residual = USB/CDC queueing + `serviceUsb` (one command per `loop()` iteration) | measured once (T4 iteration 1) |
| dispatch → SPI start | `cc.t_us` → next `cf.t_us` (seq+1) = 4.7 ms median / 5.8 p99 at 100 Hz (2026-09-12); now directly as `cf.req_age_us` per displayed frame | measured; now first-class |
| SPI start → photons | `spi_us` 0.77 ms is the transfer; panel latch + LED update after that is **unmeasured** (needs an optical sensor) | not measured |
| controller reply → Studio | `a.dt` − (controller time) — `dt` includes queue wait, so subtract the in-controller time from `cc`/`cf` pairing | derivable |
| ring record → log | `rx` is drain receipt (≤ 100 ms late, up to seconds when the bridge refuses rows); ordering by `seq` is exact; a CMD is appended AFTER its handler's STATE records (lower seq for the STATEs, later `t_us`) | documented |

## 4. How to determine round-trip latency (recipe for the review)

Define the chain for one closed-loop step: FicTrac frame `k` (ft/ms) → bridge → browser `apply` → 0x70 sent
(`a.t_off`) → controller dispatch (`cc.t_us`) → SD read (`sd_load_us`, inside `req_age_us`) → SPI start
(`cf.t_us`) → LEDs (unknown) ; reply → browser (`a.t_off + a.dt`).

1. **Per run, fit the host↔controller clock**: pair 0x70 `a` rows with `cc` rows by order (counts differ by the
   in-flight ones; discard ring records whose `rx − t_us/1000` offset differs from the run's by > 2 s = backlog);
   fit `t_host = a + b·t_us`; report slope (ppm) and residual distribution = USB + CDC + parse latency.
2. **Dispatch → presentation**: `cf.req_age_us` directly (v2), or `cc→cf` by seq (v1). Split it into SD
   (`sd_load_us`) + wait-for-tick + queue.
3. **Host-observed**: `a.dt` minus the controller's dispatch→reply time (reply is queued right after the handler;
   approximate with `cf.req_age_us` when the frame changed, else ~0.1 ms).
4. **FicTrac → command**: **not derivable today** — add `fc` (or the FicTrac `ft`) to the `a` row (or a per-command
   `fc` field the bridge fills when it forwards the derived index) and, ideally, echo it in the 0x70 payload so it
   appears in `cc.req` too (a 2-byte extension the firmware ignores). Then FicTrac frame → LED = (a.t_off − ms) +
   host→controller offset + `req_age_us` + SPI + latch.
5. **Superseded / coalescing**: `superseded` per FRAME (controller side) + the bridge client's coalescing count
   (host side; not logged today — add a counter to `iteration-end`).

## 5. Timing directly on the Teensy — proposals that need no AD3 / Saleae

The controller already owns the two ends that matter (command arrival, SPI start). What it cannot see is the
light. Options, cheapest first:

1. **USB arrival stamp (free).** Today `cc.t_us` is dispatch entry; `SerialManager::parseIncoming` sets
   `cmd_ready_` when the frame is complete. Stamp `micros()` there and carry it on `ParsedCommand` → a new CMD field
   (or a STATE) gives USB-queue vs dispatch split with no hardware.
2. **Framescan loopback (a wire).** `out_debug_framescan` on Digital IO 1 already envelopes the SPI transfer;
   loop it to Digital IO 2 configured as an input with an edge interrupt → the controller timestamps its own frame
   envelope in `micros()` and can cross-check `spi_us` and the tick phase. Proves the DIO path; does not see light.
3. **Photodiode on Analog In (the real glass-to-glass measurement, Teensy-only).** A phototransistor/photodiode
   taped to one panel into "Analog In 1 (±10 V)"; the analog-in path (fw F1/F2, 12-bit, `GET_ANALOG_IN` 0xA4) exists.
   Two ways to timestamp the edge without busy-waiting the whole loop: (a) the i.MX RT ADC has a hardware
   **compare function with interrupt** — arm it after each transfer with a threshold, and the ISR records
   `micros()` → `light_us − cf.t_us` per frame as a new FRAME field or STATE; (b) bench-only diag mode: after
   `transferFrame`, poll the ADC for ≤ 5 ms (blocking, acceptable on a bench build) and record the crossing.
   Use a pattern that alternates a dark and a lit frame at the sensor's location (or the all-on/off glyph path).
   This gives **SPI start → LED update** per frame with the controller's own clock — the number nobody has.
4. **Panel-side confirmation.** The panels answer on CIPO (the DEBUG_SERIAL build captures 3 bytes per panel set
   every 300th frame). A per-frame "panel accepted" timestamp is possible but needs the debug capture path on
   every frame; lower value than 3.
5. **Refresh-tick phase.** Record `micros()` in `refreshISR` (or a 16-bit counter) and log tick→transfer latency
   per FRAME → separates "waited for the tick" from "loop was busy".
6. **Host-side without instruments:** the sim can stamp its send time into `ft`; the browser can add
   `performance.now()` at WebSocket receipt to the `apply` path; both are software.

## 6. Critical next experiments (with what they discriminate)

1. **Control iterations on the new build — DONE 2026-09-13 12:27 ET:** two iterations, 482k commands, **0 stalls**
   (baseline: 4 clusters per iteration on the same card); bar backward-seek cost 2.0 → 1.46 ms; reads/command 0.76;
   `req_age_us` p50 1.7 ms, max 4.8 ms; all 40 trials pass. Working explanation: the FAT-sector re-reads of the
   old seek path were the card's read-disturb hot spot (`archive/mode3-2026-09/sd-read-jitter-2026-09-13.md` §7, bench log 11:55). The
   causal test (reflash `394dee45` for one iteration) is pending Michael's decision.
2. **Working-set test on the same file** (`sd_stall_test.py --window 50/100/200`, after the harness fixes): does a
   50-frame working set inside the 813 KB file stall? Discriminates card read-cache vs placement explanations.
3. **`0x32` host streaming at 100/200/286 Hz** (existing opcode; no SD at all): does the failure vanish, and does USB
   meet the deadline under the real host load? Cheapest test of "remove SD from the trial".
4. **Photodiode-on-AIN glass-to-glass** (§5.3): the only way to turn `req_age_us` into a latency to light.
5. **FicTrac → command linkage** (§4.4) then the full chain on a real FicTrac rig (camera clock, not the sim).
6. **Telemetry-on vs -off control iteration** (Debug ▾ toggle): the instrumentation's own cost.
7. **Card screening** when cards arrive (protocol in `archive/mode3-2026-09/sd-read-jitter-2026-09-13.md` §5); never reformat the
   current card.
8. **Resident-decode proof** (next implementation session, not this review): LZ4/zlib per-frame RAM cache of the
   bar pattern loaded in the ITI; the read-free path (`archive/mode3-2026-09/sd-read-jitter-2026-09-13.md` §6).

## 7. Known gaps / caveats for the reviewer

- `cf.rx` is NOT the event time; FRAME `t_us` is SPI start, not photons; CMD `t_us` is dispatch entry, not USB arrival.
- FRAME records exist only for displayed CHANGES; held frames and superseded loads are invisible except via
  `superseded` and the per-trial `sd_reads`.
- `sd_slow_ctx` is sticky last-error context, not per-read evidence; `sd_slow` is a threshold event (10 ms).
- The bridge log's `rx` for ring rows can lag by the drain period (100 ms) or more when the bridge refuses rows.
- Ring capacity ≈ 5–6 s of Mode-3 traffic; drops are counted (`dropped`, seq gaps) — the trial-quality module marks
  such trials `unknown`.
- No log carries which physical card served runs before 2026-09-13 11:44 ET (0xCD did not exist).
