# Controller telemetry ring buffer — feasibility + test proposal

Drafted 2026-09-07 17:38 ET (Michael + Claude). Status: **proposal, no code**. Companion to
`docs/development/analog-acquisition-handover.md` (§ 3.2 F3 / § 3.3 S4, the analog block
stream) and to Linear **LAB-149** ("controller and panel diagnostics with a retrievable
event log"). This document answers one question — *can the G6 controller keep an event log
without touching the SD card, and can the host drain it live?* — and lays out the bench
experiments that would settle it before anyone writes production firmware.

## 0. TL;DR

- **Yes, it is reasonable — and the RAM/CPU worries do not apply once the log never
  touches the SD card.** A RAM ring buffer that the host drains every 50–100 ms needs a
  few KB, not a 40-minute archive. Worst-case event traffic (500 fps frames + 100 Hz
  commands + 1 kHz two-channel analog) is 12.6 KB/s; a 5 s cushion is 62 KB. The Teensy
  has ~456 KB of unused OCRAM and ~132 KB of free DTCM. SD read+write concurrency never
  arises because nothing is written to the SD.
- **The one real obstacle is the wire protocol, not the controller.** Framed replies are
  capped at 197 B (one-byte length, 200 B response buffer). Draining 12.6 KB/s means
  either ~66 small framed replies per second or reusing the existing raw "bulk response"
  path that 0x84/0x8A use — and that path is the one macOS Chrome loses bytes on (#153).
  The proposal makes the drain **lossless regardless** (ack-cursor, sequence numbers,
  re-send) and tests both framings.
- **Yoke analog and frames, as Michael suggested.** When analog acquisition is on, one
  fixed-rate *tick* record carries `[frame_index, ain1, ain2]`; frame-change events are
  suppressed. When analog is off, the log is sparse frame-change + command + state events.
  One stream, one controller clock, both cases.
- **What it buys beyond analog:** exact display timing of every frame in Mode 2/4 (today
  the host knows nothing about what the controller showed when), controller-side receive
  time of every command (host→controller latency for Mode 3, cf. LAB-164), SD frame-load
  time per frame, and the PE/CE/reset/retry record LAB-149 asks for.
- **Recommendation:** run the six bench experiments in § 5 (about two bench days on a
  test firmware branch, no production code) and take the numbers to the group.
- **Two files first, timestamps everywhere, latency is measurable (§ 7–9, added after
  Michael's questions):** phase 1 writes a binary sidecar next to the run log and
  integrates later; every record carries controller µs and every block carries a
  controller↔host clock pair (a per-run *fit*, since crystal drift is 50–150 ms over
  40 min); the ring makes the host→controller→display segments of the FicTrac loop
  observable in every run, and two bench experiments (L1/L2) validate them physically.
  Only the camera segment needs its own one-time measurement (L3).

## 1. What exists today (facts, with sources)

Firmware (`LED-Display_G6_Firmware_Arena`, branch `arena-2x10-local`, PRs #46/#47 stacked
off main; survey 2026-09-07):

- `loop()` is a flat cooperative pipeline (`main.cpp:110-133`): USB service → command →
  `serviceDisplay()` → download/upload/archive service → flush. No RTOS. Ethernet is
  compiled out on this branch; USB CDC is the only transport.
- Exactly two ISRs, both trivial: `SpiManager::refreshISR()` sets a flag + counter
  (`SpiManager.cpp:14-19`), `dmaISR()` sets a flag. **Nothing touches SD or SPI data in
  interrupt context**; IRQ priorities are set so SD reads stay in the main loop
  (`main.cpp:161-168`).
- **One choke point for "a frame was displayed":** `transmitOnRefresh()` →
  `SpiManager::transferFrame()` (`CommandProcessor.cpp:1219-1224`, `SpiManager.cpp:175-268`,
  `++frames_sent_` at `:184`). `cur_frame_index_` is written in four places (0x70 handler
  `:1097`, open loop `:1486`, closed loop `:1529/1534`, `enterPatternMode`).
- **One choke point for commands:** `processCommand()`.
- SD: Arduino `SD.h` over SDIO; `readFrame()` is a blocking seek+read+CRC in loop
  context, called only on index change (`SdManager.cpp:316-347`, `loadFrame()`
  `CommandProcessor.cpp:1541-1565`). GS16 frame = 4064 B, GS2 = 1064 B. Every existing SD
  *write* path refuses unless the display is stopped (`CE_DISPLAY_ACTIVE`). There is no
  claim anywhere that concurrent SD read+write is safe — the firmware's stance is "don't".
- Reply framing: `sendResponse()` writes a **one-byte length**, `RESP_BUF_SIZE = 200`
  → max framed payload **197 B** (`SerialManager.cpp:240-253`, `constants.h:129`). No
  16-bit-length reply exists. Long replies use `sendRaw()`: a framed header carrying a
  byte count, then unframed bytes chunked to `Serial.availableForWrite()` with a 2 s
  stall abort (`SerialManager.cpp:190-238`). `flushResponses()` never blocks.
- USB CDC measured throughput ~1.37 MB/s (firmware README:153); pyserial sustains ~8 MB/s
  downloads on the same hardware (#153).
- Memory (perf build, `arm-none-eabi-size`): DTCM `.data`+`.bss` 163 KB, ITCM 218 KB →
  **~132 KB free in RAM1**; OCRAM `.bss.dma` 56 KB → **~456 KB free in RAM2**
  (addressable with `DMAMEM`). No `EXTMEM`/PSRAM on the Teensy (the "PSRAM" in this
  codebase is panel-side).
- Time: `micros()` everywhere (1 µs resolution, 32-bit wrap at 71.6 min — must be
  handled); no host↔controller clock sync opcode.
- Telemetry today: `frames_sent_` (0x33/0x34), `isr_count_` (debug only),
  `GET_FRAME_POSITION` 0x72. No timestamps, no counters for drops/errors, no event log.
- Analog after F1/F2: 12-bit, 16× averaging, **~40 µs blocking per `analogRead`**; Mode 4
  samples at 500 Hz in the main loop with EWMA + deadband; calibration `ainMv()`.

Studio / log pipeline (webDisplayTools):

- `ArenaLink.send()` is single-flight, echo-correlated, 500 ms timeout; `sendBulkRead()`
  handles the 0x84-style header-then-raw path (`js/arena-link.js`). `port.open` still
  passes no `bufferSize` (line 162) — the #153 mitigation is not on main.
- Every command the browser sends is already logged host-side as an `arena_command` echo
  with browser `t` and bridge `rx_ms` (`js/arena-session.js:311`); in `behavior_v2` that
  becomes the compact `["a", …]` row. Runner semantic events (`phase`, condition names)
  go to the bridge log too.
- The bridge is a pass-through writer for browser `{type:"log"}` objects; it calls
  `setdefault` on the parsed message, so a bare JSON **array** from the browser would
  currently be rejected — a one-line bridge change if we want compact array rows written
  verbatim (`fictrac-bridge/bridge.py:289-300`).
- Format invariants (runlog-behavior-v2 plan, PRs #183/#186/#188): uniform NDJSON, one
  `frame_schema` line, tagged compact arrays expanding losslessly to a canonical object,
  offsets from `t0`, converter + corpus gate, one shared `js/runlog-format.js`.

## 2. Why the SD-card event log was the wrong shape

The earlier idea (LAB-149 as originally imagined: controller writes a log file, host
fetches it at run end) has three costs that the ring buffer removes:

| Concern | SD event log | RAM ring + live drain |
|---|---|---|
| Storage for 20–40 min | must fit on SD or in RAM (15–30 MB) | a few KB; the host is the archive |
| SD concurrency | new *write* path racing the frame *read* path in the same loop; every existing write refuses while displaying, for this reason | none — the SD is never touched |
| Loss of the run on crash/power | whole log lost if the file isn't closed | at most the last drain interval (≤ 100 ms) |
| Merging with host/behavior logs | separate file, separate clock, post-hoc | rows land in the same JSONL as the FicTrac frames and arena echoes, stamped with both clocks |
| Performance | file writes cost ms and jitter the frame loop | recording a record is a few dozen cycles at the choke point |

## 3. Proposed design (for discussion — details are what the tests decide)

### 3.1 On the controller

**Ring buffer.** One byte ring in `DMAMEM` (OCRAM), 64 KB default (≈ 5 s of worst-case
traffic; ≥ 50 s of a typical Mode 2 run). Single producer (loop + analog ISR — see
below), single consumer (the drain handler). Records are variable-length with a type
byte; a running 32-bit **record sequence number** and a **drop counter** live beside the
ring. When the ring is full the producer drops the *newest* record and bumps the counter
(the host sees the gap in `seq` and the count in the next block header; nothing is
silently lost — it is explicitly counted).

**Record types (compact binary, little-endian).**

| Type | Bytes | Fields | When |
|---|---|---|---|
| `TICK` block | 8 + n×2 or n×6 | `t0_us u32, rate_hz u16, n u16`, then n × `idx u16` (+ `ain1 i16, ain2 i16` when analog on) | fixed-rate, produced by the sampling ISR; **the yoked record** |
| `FRAME` | 10 | `t_us u32, idx u16, pattern u16, sd_load_us u16` | at `transmitOnRefresh` when the displayed index changes; **suppressed while TICK runs** |
| `CMD` | 8 + ≤8 | `t_us u32, cmd u8, status u8, len u8, payload[0..8]` | in `processCommand`, after dispatch (controller receive time + result) |
| `STATE` | 8 | `t_us u32, kind u8, code u8, arg u16` | trial start/stop/mode change, PE/CE codes, resets, SPI retries, ring overrun, SD read > threshold — the LAB-149 payload |

Yoking rule: when analog acquisition is enabled the tick period (1 ms at 1 kHz) already
bounds frame timing to within one tick, and the refresh timer runs at 300 Hz (GS16) /
1000 Hz (GS2), so a `FRAME` event per change adds nothing but bytes; TICK carries the
index instead. When analog is off, no ticks are produced and `FRAME` events give exact
µs display times. A 1000 Hz GS2 refresh can alias a 1 kHz tick — sample at 2 kHz or keep
`FRAME` events on for GS2; test T3 decides.

**Sampling ISR.** An `IntervalTimer` at the tick rate reads the ADC(s) and appends a
tick. Concern: F1's 16× averaging makes `analogRead` block ~40 µs per channel, so 1 kHz ×
2 ch ≈ 8 % of CPU inside an ISR and up to 80 µs of added latency to the refresh ISR.
Options to measure in T2: 4× averaging (10 µs), one channel per alternate tick, or
hardware-triggered ADC with DMA (ADC_ETC) — deferred unless T2 forces it. **Mode 4 should
consume the same samples** (one sampling path; its EWMA/deadband stay in the loop on the
latest tick) — open question 6 in the handover, recommended answer here.

**Opcodes.** Firmware PR #47 fixed the `0xA_` allocation rule (A0–A3 analog out, A4–A9
analog in, AA–AF digital; set/get pairs on adjacent even/odd opcodes) and **reserved 0xA8 /
0xA9 for the sampled block stream** — which is this telemetry stream. `GET_CLOCK` goes in
the `0xC_` controller-info block next to 0xC2.

- `SET_TELEMETRY` **0xA8** — `[len, A8, flags, rate_lo, rate_hi]`: flags bit0 events on/off,
  bit1 analog ticks on/off, bit2 raw-vs-calibrated analog; rate in Hz (0 = tick off).
  Sampling and event recording run in any state, so the Console scope works outside trials.
- `GET_TELEMETRY_BLOCK` **0xA9** — `[len, A9, ack_seq u32, max_bytes u16]`: the controller frees
  everything up to `ack_seq`, then returns the next records from its read cursor **without
  freeing them** (freed only by the next ack). Header: `t_now_us u32, first_seq u32,
  n_records u16, dropped u32, more u8`. This makes a lost or timed-out reply harmless: the
  host simply re-asks with the same `ack_seq` and gets the same bytes again.
- `GET_CLOCK` — returns `micros()` and `millis()`; the host logs one pair per trial for
  wall-clock alignment (every block header also carries `t_now_us`, and the host stamps
  `rx_ms`, so a continuous pairing is available too).
- Capability bit 7 `telemetry` in the 0xC2 bitmap; the Studio greys the feature without it.

**Reply framing — the decision the tests make.** Two candidates, both to be implemented
on the test branch:

- **(A) Chunked framed.** Each `GET_TELEMETRY_BLOCK` reply is a normal `[len, status,
  echo, header, records…]` frame ≤ 197 B payload (≈ 180 B of records); `more=1` tells the
  host to ask again immediately. Worst case 12.6 KB/s → ~66 round trips/s; typical Mode 2
  without analog → 5–10/s. Uses the proven single-flight path, immune to #153, no new
  parser code. Cost: round-trip latency per chunk (expected 1–3 ms on USB CDC — T1
  measures it).
- **(B) Bulk.** Header via `sendResponse`, records via `sendRaw` (as 0x84 does); one
  transaction per poll of any size. Faster, but it is the exact path on which macOS Chrome
  loses bytes (#153) — though the losses were observed 5–20 KB into 21 KB bursts, and
  these blocks are ~0.6–1.3 KB. The ack-cursor makes a lost block recoverable; T1 tells us
  how often that would happen.

Prior: (A) as default, (B) only if T1 shows (A) cannot keep up with analog on. A third
option — a new 16-bit-length reply frame type — is not worth a parser change when (A)
exists.

### 3.2 On the host (Studio)

- A **telemetry poller** (pattern: `StudioAnalogIn.createPoller` — single-flight, gated on
  connection + capability, quiet) at 10–20 Hz, using `session.send` directly (not the
  Console's logging `send()`), looping on `more`. It runs during Mode 2/4 trials (idle
  link); in Mode 3 FicTrac trials, where 0x70 saturates the link, it runs with analog
  ticks **off** and events on (≈ 1 KB/s → 6 chunks/s), and the UI says so.
- Decoding lives in a new classic dual-export module `js/arena-telemetry.js` (record
  parsers, seq/drop accounting, µs-wrap handling, clock pairing) with a Node test; wire
  encoders/decoders in `js/arena-wire-g6.js` (export + test each — the missing-export
  gotcha).
- Live: ticks feed the oscilloscope as the analog trace set the handover describes;
  `FRAME`/`STATE` events feed the run-status pane (drops, PE/CE) and the Console log
  (state changes only).
- Run log: the browser expands each block into compact JSON rows and sends them to the
  bridge (§ 3.3). The bridge stays the single logger; it needs to accept arrays verbatim
  (or the browser wraps them — decide with the format).

### 3.3 Fit with the run-log format

One run = one artifact stays an invariant, so rows go into the same JSONL. Following the
`behavior_v2` model (tagged array, offsets from `t0`, lossless expansion in
`runlog-format.js`, converter + corpus gate):

```
["ct", t_off, rx_off, t_us, seq, rate_hz, [idx…], [ain1…], [ain2…]]   # tick block
["cf", t_off, rx_off, t_us, idx, pattern, sd_load_us]                # frame event
["cc", t_off, rx_off, t_us, cmd, status, "hex"]                      # command (controller side)
["cs", t_off, rx_off, t_us, kind, code, arg]                         # state / error
```

Schema: keep `behavior_v2` and add an optional `streams` object to the `frame_schema` line
(`{"ct": {cols:[…], rate_hz}, "cf": {…}, …}`) rather than bumping the level — readers that
don't know the tags already pass unknown rows through; readers that do get the columns from
the schema. Size estimate at 1 kHz analog + 20 Hz polls: ~15 KB/s of JSON (int arrays gzip
well because `idx` repeats) → roughly 50 MB/h raw, ~8–12 MB/h gzipped, under the 30 MiB
Contents-API path for runs up to ~2 h and always under the 100 MiB hard limit via the Git
Database path. Without analog (events only) the addition is < 1 MB/h. Test T6 measures the
real numbers on synthetic data before the format is frozen.

Alternative rejected: base64 of the raw binary block inside a row — smaller before gzip,
larger after, and opaque to every reader.

## 4. Budget (worst case, everything on at once)

| Source | Rate | Record | B/s |
|---|---|---|---|
| Frames (Mode 2, 500 fps, events mode) | 500/s | 10 B | 5,000 |
| Commands (Mode 3, 0x70 at 100 Hz) | 100/s | 16 B | 1,600 |
| Analog ticks, 2 ch, yoked idx | 1,000/s | 6 B | 6,000 |
| **Total** | | | **12,600 B/s ≈ 45 MB/h** |

USB CDC link occupancy at 1.37 MB/s: **< 1 %**. Ring holding 5 s: **62 KB** (of ~456 KB
free OCRAM). 40-minute run: 30 MB total drained, held on the host, never on the
controller. Per 50 ms poll: ~630 B → 4 framed chunks under (A), one block under (B).

## 5. Test plan — what to measure before anyone commits to the design

All on a **throwaway firmware branch** (`test/telemetry-ring`) with a synthetic producer
and both framings; host side via a Node/pyserial script *and* the Studio (Web Serial is the
production transport and the one with known problems). Instruments: framescan DIO role +
Saleae/AD3 (`instruments` skill), AO `frame_number` mode as an fps meter.

| # | Experiment | Setup | Pass criterion |
|---|---|---|---|
| **T1 Drain throughput & loss** | Synthetic producer fills the ring at 5 / 12.6 / 50 KB/s; host polls at 10 and 20 Hz with framing (A) and (B); 30 min each; Linux Chrome, macOS Chrome (with and without `bufferSize: 1 MiB`), pyserial as control | 0 unrecovered records (seq continuous after re-sends); measured max sustainable B/s and per-chunk round trip; how often (B) needs a re-send on macOS |
| **T2 Recording overhead / frame jitter** | Mode 2 from SD at 100, 300, 500 fps (GS16 and GS2), telemetry off vs events-on vs events+1 kHz ticks (16× and 4× averaging); framescan pin on the logic analyzer | Frame period jitter and dropped-refresh count unchanged within noise (target: < 50 µs added jitter, 0 extra drops); ISR duration measured |
| **T3 Yoking correctness** | AO in `frame_number` mode looped back into AI1 (the existing Console sweep); Mode 2 at 300 fps with ticks at 1 kHz and 2 kHz; generator sine on AI2 | Each tick's `ain1` matches its own `idx` (AO tracks the index) to within one tick; no aliasing at GS2 1 kHz refresh (or the doc records that GS2 needs 2 kHz / `FRAME` events); sine amplitude + frequency reconstructed from the log |
| **T4 Endurance** | 40-minute Mode 2 protocol on a real 2×10 arena, telemetry on, run through the Studio + bridge | Ring high-water mark; `dropped` stays 0; `micros()` wrap handled; log size raw and gzipped; commit path used |
| **T5 Latency insight (bonus)** | Mode 3 FicTrac closed loop with events on: compare host `t` of each 0x70 echo with the controller `CMD.t_us` and the following `FRAME.t_us` | Distribution of host→controller and command→display latency — the first direct measurement of the Mode 3 pipeline (LAB-164) |
| **T6 Format** | Convert T4's binary blocks to the § 3.3 rows; run the v2 round-trip test, the dashboard corpus parity, and the replay viewer | Lossless expansion; sizes match the § 3.3 estimate; old readers ignore the new rows without error |

Order: T1 first (it decides the framing and whether macOS is a problem), T2 (decides ISR
averaging and whether ticks are free), then T3/T4 together, T5/T6 opportunistic. Estimated
two bench days plus one day of scripting; no production code changes in any repo.

## 6. Decisions to bring to the group

1. Framing (A) chunked vs (B) bulk — after T1.
2. Tick rate default (500 Hz / 1 kHz / 2 kHz) and averaging — after T2/T3.
3. Calibrated mV on the controller vs raw counts + host-side calibration in the log
   (handover open question 2). Recommendation: calibrated on the controller, raw as a
   flag for diagnostics — one truth, and Mode 4 already uses calibrated volts.
4. Mode 4 consumes the tick samples (one sampling path) — recommended yes.
5. Schema: `streams` field on `behavior_v2` vs a `behavior_v3` level — recommended `streams`.
6. Whether `FRAME` events stay on alongside ticks for GS2 patterns — after T3.
7. Scope of `STATE` events for LAB-149 (which PE/CE/retry paths get instrumented first).

## 7. One file or two? (Michael's question 1)

**Recommendation: start with a separate controller-log sidecar; integrate as step 2.**

- Phase 1: the browser forwards each drained block to the bridge as a `ctl` message and the
  bridge writes it to a second file next to the run log, `<run>.ctl.bin` — the **raw binary
  blocks verbatim**, each prefixed by a small fixed header `{rx_ms u64, n_bytes u16}` (the
  host receive stamp; everything else is already in the block). No JSON, no schema design
  yet, ~12 KB/s worst case before gzip. The bridge change is a second file handle keyed by
  message type; the Studio commits both files (one Git Database tree with two entries —
  `directCommitLarge` builds a one-entry tree today, so a small extension). The dashboard
  catalog pairs files by basename.
- Why sidecar first: it decouples this work from the three unmerged `behavior_v2` PRs and
  from the format decision (§ 3.3 / decision 5), lets the bench experiments start with a
  10-line decoder, and keeps the controller log crash-safe (the bridge writes as it goes;
  browser memory is lost on a tab crash). The **same decoder module** (`js/arena-telemetry.js`)
  serves the live scope, the sidecar reader, and — later — the integration converter.
- Phase 2 (after the format settles): a converter merges `.ctl.bin` into the run log as the
  § 3.3 compact rows, with the round-trip test and corpus gate; from then on the bridge
  writes the rows directly and the sidecar is dropped. Existing sidecar runs are converted
  once. Pairing key = the `(t_now_us, rx_ms)` pairs in every block header, so integration
  loses nothing that phase 1 recorded.
- Cost of two files: two artifacts per run for the commit path, catalog, and replay until
  phase 2. Acceptable for a bench-and-first-release period.

## 8. Timestamps (Michael's question 2)

**Yes — every record carries the controller clock, and the drain carries the pairing
needed to map it to wall time.**

- Events (`FRAME`, `CMD`, `STATE`) carry an absolute `t_us` u32 (`micros()`, 1 µs). `TICK`
  blocks carry `t0_us` + `rate_hz`; sample times are implicit (`t0 + i/rate`), which is the
  "send deltas" idea taken to its limit — a constant delta costs zero bytes. Recommend
  `FRAME` stamp both the start and end of `transferFrame` (`t_us` + `spi_us` u16), since
  "frame on the SPI bus" is what the panel latches.
- Deltas on the wire for events: a u16 delta with an escape would save 2 B on a 10 B
  record (20 %) — about 1 KB/s at the 500 fps worst case against a link we use < 1 % of.
  Not worth the fragility: a ring-overrun drop breaks a delta chain unless each block
  restarts absolute. **Keep absolute u32 on the wire**; do the delta compression where it
  is free — `t_off` small-int offsets in the JSON rows and gzip on the file. Revisit only
  if T1 shows bandwidth matters.
- `micros()` wraps every 71.6 min. The host unwraps using the monotonic record `seq` and
  the block header `t_now_us`; a run may cross a wrap and must not care.
- **Clock mapping is a fit, not an offset.** Teensy crystal vs PC clock drift of a few
  tens of ppm is 50–150 ms over a 40-minute run — far larger than the latencies in § 9.
  Every drain block pairs `t_now_us` with the browser's `performance.now()`-derived
  receive time (sub-ms; `Date.now()` is only ms), so the host has ~20 pairs/s and fits a
  line per run (offset + rate), refined by the `GET_CLOCK` round trip whose RTT bounds the
  one-way uncertainty. The fit residuals are themselves a health metric for the link.

## 9. Glass-to-glass latency in FicTrac closed loop (Michael's question 3)

Goal: confirm — before committing to the plan — that the ring buffer plus a bounded bench
effort gives a **robust, repeatable** measurement of the delay from the ball moving to the
panels changing, in real experiments and not only on the bench.

### 9.1 The chain and its three clocks

```
ball moves → [camera exposure/readout] → FicTrac → UDP → bridge → WS → browser → 0x70 →
  USB → controller receive → SD loadFrame → wait refresh tick → SPI to panels → LEDs
```

| Segment | From → to | Clock(s) | Observable today | With the ring |
|---|---|---|---|---|
| S1 camera + FicTrac | exposure → UDP record out | camera hw clock (`ft`, col 22, ns) → PC | `ft` and bridge `rx` (frame row `ms`) exist, but the **camera↔PC offset is unknown** | unchanged — needs § 9.3 |
| S2 host stack | bridge rx → browser handler → 0x70 written | PC only (same machine) | bridge `ms`, browser `t` on the echo — already logged | add `performance.now()` sub-ms stamps to `_logCommand` |
| S3 USB one-way | 0x70 written → controller `processCommand` | PC → controller | only the RTT (echo receipt − send) | `CMD.t_us` + the § 8 clock fit: direct one-way per command |
| S4 controller | `CMD.t_us` → `FRAME.t_us` (+`spi_us`) | controller only | nothing | **exact, every frame**: SD load time, refresh-phase wait (uniform 0–3.3 ms at 300 Hz, 0–1 ms at 1 kHz), SPI duration |
| S5 panel | SPI end → LEDs at new brightness | external | nothing | one-time constant from § 9.3 (framescan DIO + photodiode) |

S2–S4 become **fully observable in software for every real run** once the ring exists; S1
and S5 are hardware constants (plus S1's jitter, which *is* observable as the spread of
`rx − ft`) measured once per hardware configuration on the bench. Glass-to-glass per frame
is then `S1 + S2 + S3 + S4 + S5` with S1's absolute part and S5 from the bench.

### 9.2 What the ring changes

Today the only latency number a run yields is the 0x70 RTT. With `CMD` and `FRAME`
records the run log gives, per closed-loop frame, the host→controller one-way, the SD
load, the refresh-phase wait and the SPI time — as a **histogram per run in the dashboard**,
not a one-off measurement. That also exposes the structural term nobody has measured: in
Mode 3 the controller waits for the next refresh tick after a 0x70, adding a uniformly
distributed 0–3.3 ms at GS16. If that matters, "display on receipt" for Mode 3 is a
firmware design question the numbers would justify (not proposed here).

### 9.3 Bench experiments (L-series, alongside T1–T6)

| # | Experiment | Setup | Output |
|---|---|---|---|
| **L1 software-chain glass-to-glass** (no camera) | A small Python sender (the FicTrac simulator, `pixi run sim`, extended) emits FicTrac-format UDP frames with a heading step **and toggles an AD3 digital line at the same instant** (`instruments` skill, pydwf). Saleae captures the AD3 line, the controller's `out_debug_framescan` DIO and a **photodiode on one panel**. Mode 3 closed loop through bridge + Studio + ring | Absolute delay UDP→photons, repeat ×200 for a distribution. Compared to `S2+S3+S4` reconstructed from the logs for the same frames → **validates the clock fit and the ring timestamps** to sub-ms |
| **L2 panel constant (S5)** | Framescan DIO vs photodiode edge on the same capture as L1 | S5 mean/spread (expected sub-ms; PWM period sets the floor) |
| **L3 camera + FicTrac (S1)** | IR LED in the camera field of view driven by the AD3; a short Spinnaker/Arena-SDK grab script records each frame's hardware timestamp and whether the LED is lit; FicTrac processing time from its own col 24 / a profiling run. Reuse LAB-164 if Isabel's numbers exist (the Linear issue records none) | S1 absolute = exposure→UDP-out, and the camera↔PC offset method: offset ≈ `min(rx − ft)` over a run, validated against the LED ground truth |
| **L4 true glass-to-glass (gold standard, optional)** | A motorized patterned ball or disk (stepper; step pulse on the Saleae) under the real camera, FicTrac tracking it, Mode 3 closed loop, photodiode on a panel | One end-to-end number per hardware configuration to compare with `L3 + L1`. Do this only if the group wants the physical number rather than the validated sum |

Order: L1 and L2 come free with T5 (same setup, one extra AD3 line and a photodiode). L3
is a half day with the camera. L4 is a day and some hardware.

### 9.4 Can this be done well? — assessment

- **Yes for S2–S4** (the software and controller chain): every quantity is a timestamp we
  control, on clocks we can fit, with L1 as the physical cross-check. Expected precision
  ≈ 0.2–0.5 ms per frame, set by the USB RTT asymmetry (T1 measures it).
- **Yes for S5** with one photodiode; it is a constant.
- **S1 is the only segment with a real uncertainty**: the camera clock is unsynchronized
  with the PC, so its absolute latency needs L3 (or LAB-164's data) once per camera model
  and setting; after that, `rx − ft` gives S1's jitter in every run. The `min(rx − ft)`
  offset trick assumes some frames arrive at the minimal latency during a run — true for a
  5–10 minute run, and L3 tells us how far off it is.
- **What would make the plan fail**: (a) T1 showing a Web Serial RTT so variable that
  S3 cannot be bounded — unlikely on USB CDC, and the fit residuals would show it; (b) the
  refresh-tick wait dominating (0–3.3 ms) and making the question "what is the latency"
  ill-posed — that is a finding, not a failure, and it points at the Mode 3 design change.
- Decision gate: run T1 + L1/L2 first (two bench days total). If L1's physical delay
  matches the log-reconstructed `S2+S3+S4` within ~1 ms, the method is proven and the rest
  is instrumentation of constants.

## 10. What this does not change

- The host-side `arena_command` echo logging stays: it is the *host* clock view and the
  proof of what was sent; `CMD` events add the controller's view. The bridge remains the
  single default-on logger.
- AO `frame_number` output stays for labs recording on a DAQ.
- Nothing here needs the SD card, the ISP path, or the panel firmware.
