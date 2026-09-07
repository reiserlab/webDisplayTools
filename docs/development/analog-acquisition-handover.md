# Handover: controller ↔ Studio interactions and analog acquisition without a NI DAQ

Written 2026-09-07 for a fresh session that will design **analog data acquisition
through the G6 controller** (wingbeat-analyzer signals for flight arenas, logged by
Arena Studio) in a way that fits the **run-log `behavior_v2` plans**. It summarizes
what exists, what is in flight, how the firmware and the Studio actually talk, and the
proposal that session should turn into a design. Nothing here has been bench-tested
yet — every PR below was built without hardware (2026-09-06/07).

## 0. Read first

1. `docs/development/runlog-behavior-v2-plan.md` — the run-log format + commit-path
   plan, with "PR 1/2/3 implementation notes" at the end (facts the readers rely on).
2. `docs/development/analog-input-plan.md` — analog input validation, calibration,
   Console panel, Mode 4 tests; **§ 4b is the seed of the acquisition proposal** and
   § 6 records the decisions taken.
3. `docs/development/oscilloscope-view-spec.md` — the live scope's data contract
   (`behavior_v1` samples, derived channels in `js/kinematics.js`, overlay vocabulary
   shared with the offline dashboard).
4. `CLAUDE.md` → "Arena Studio" (architecture, the § 6 mutation chokepoint, display
   quiesce, Console conventions incl. the *quiet poller* rule) and "Run logs are
   `.jsonl.gz`".
5. The `g6-orientation` skill for the repo map; the umbrella docs
   (`Modular-LED-Display/docs/development/g6_03-controller.md`) for the wire protocol.

## 1. State of the world

### Run-log format v2 stack (webDisplayTools, three stacked PRs, merge readers first)

| PR | Branch | What |
|---|---|---|
| #183 bridge | `claude/runlog-behavior-v2-bridge-d7554d` | `fictrac-bridge/bridge.py` 3.0: `behavior_v2` level — arena echoes as `["a", t_off, dt, hex, status, rx_off(, error)]`, `frame_schema` gains `arena_cols` + `t0`; `--convert` v1⇄v2 (+`.gz`); `hello_ack` / `log_control_ack` name the level in force; corpus gate 164/164 (1282 MB → 656 MB v2 → 211 MB v2.gz) |
| #186 Studio v0.72 | `claude/runlog-behavior-v2-studio` | gzip in the browser → `runlogs/<bench>/<name>.jsonl.gz`; `GH.commitFile` routes > 30 MiB through the Git Database API; bridge client handles the acks; `run_metadata.log_format` |
| #188 readers v0.73 | `claude/runlog-behavior-v2-readers` | shared **`js/runlog-format.js`** (vendored byte-identical in `dashboard/data-browser/vendor/`): `readRunlogText` (inflate on gzip magic), `createNormalizer().normalize(rec)` (expands `"a"` arrays to the exact v1 `arena_command` object), `detectFormat`, JS v1⇄v2 converters; wired into the dashboard, the replay parser and the Alt-Studio replay picker; dashboard parity 164/164 |

Facts an acquisition format must respect (all in the plan doc's implementation notes):

- A run log is **uniform NDJSON**; readers `JSON.parse` a line and dispatch on
  `Array.isArray` then on `arr[0]`: a **string tag** (`"a"`) means a compact record,
  a **number** means a `behavior_v1` frame row `[ms, fc, idx, ft, x, y, hd]`.
- The `frame_schema` line comes right after the opening `session` line and carries
  `level`, `cols`, and for v2 `arena_cols` + **`t0`** (= the session line's `ms`; every
  `*_off` is a small int offset from it). `cols` may be `null` for converted legacy
  files. Readers keep per-file state in a normalizer; the schema must precede the
  compact rows.
- Losslessness is proven by **v1→v2→v1 canonical-JSON identity** over the whole
  course corpus (bridge `scripts/runlog-v2-corpus.py`, dashboard
  `dashboard/data-browser/tests/corpus-v2-parity.js`). Any new row type needs the
  same treatment: a compact form, an expansion to a canonical object, tests, and a
  place in `runlog-format.js` (one shared module; the dashboard copy must stay
  byte-identical — a test enforces it).
- Time bases in a log today: bridge wall clock `ms` (frame rows, session lines),
  FicTrac camera clock `ft` (relative ms, col 22), browser `t`/`rx_ms` (epoch ms) on
  arena echoes and runner events. The `arena_command` echo carries the frame index
  only implicitly (the 0x70 payload in `head`); the replay decodes it.
- Commit path: gzip + Contents API up to 30 MiB, Git Database API above (GitHub hard
  limit 100 MiB per file). A 1 h `behavior_v2` run is ~4 MB gzipped, so there is
  headroom for an analog stream.

### Analog input work (plan PR #189; hardware issue LAB-209)

| Piece | Where | Status |
|---|---|---|
| Hardware | LAB-209 (Frank) | stage-2 divider resistors swapped on both AI channels (Will, 2026-08-27): only −10…0 V measurable until R178/R180 and R179/R181 are flipped; schematic still wrong |
| Firmware **F1** | `LED-Display_G6_Firmware_Arena` PR #46, `feat/ai-12bit-g3-gain` | 12-bit + 16× averaging; Mode 4 `fps = V × 100 × gain/10` (G3-faithful: gain byte ×10, unity = 100 fps/V); EWMA on the input; 0xA4 reply + flags byte |
| Firmware **F2** | branch `feat/ai-calibration` (stacked on F1; PR pending) | two-point calibration record in **EEPROM** (+ write-only SD JSON mirror `/config/analog_cal.json`), `SET_ANALOG_CAL` 0xA5 / `GET_ANALOG_CAL` 0xA6 / `GET_ANALOG_IN_RAW` 0xA7, deadband, capability bit 6 `ai_cal`; 0xA4 and Mode 4 use the calibrated volts |
| Studio **S1** v0.74 | webDisplayTools PR #190, `feat/console-analog-in` | Console "Analog In" rail panel: 10 Hz quiet poller, strip chart, min/max, AO→AI loopback sweep; `js/studio-analog-in.js` |
| Studio **S2** | branch `feat/console-analog-cal` (stacked on S1; in progress) | calibration UI (guided two points, deadband, clear, read), wire encoders/decoders for 0xA5–0xA7, `ai_cal` capability name |

## 2. How the firmware and the Studio interact (the facts)

**Transport.** Web Serial (Chromium ↔ Teensy 4.1 USB-CDC). One `ArenaLink` + one
`ArenaRunner` per page behind `ArenaSession.shared()` (`js/arena-session.js`, classic
script layer so Connect/STOP survive an ES-module failure). `session.send(bytes)` is
**single-flight and echo-correlated**: one request on the wire at a time, the reply is
matched by the echoed command byte, 500 ms timeout. Request frame `[len, cmd,
params…]`, reply `[len, status, echo, payload…]`; on a non-zero status the payload is a
human-readable reason (the Console's `send()` helper logs it).

**Two logging channels, do not confuse them.** (1) The Console log / transcript in the
page, fed by the Console's `send()` wrapper (every command TX/RX). (2) The **bridge run
log**: the browser sends `{type:"log", …}` JSON to `fictrac-bridge/bridge.py` over the
WebSocket and the bridge appends it to the JSONL — `arena_command` echoes (one per
Web Serial command, via `ArenaSession._logCommand`), runner events, `run_metadata`,
and the FicTrac frames the bridge itself receives over UDP. **The bridge is a separate
process that never touches serial;** the browser owns the controller.

**Who owns the link when.** During a run `session.running` is true and the runner
issues the trial commands; the Console's periodic reads must yield (the Analog In
poller gates on it). In **Mode 3 FicTrac closed loop** the browser streams
`SET_FRAME_POSITION` 0x70 at ~100 Hz — that saturates the link (each echo is logged;
76 % of a v1 log's bytes). In **Mode 2** and **Mode 4** the controller runs the trial
alone and the link is idle apart from the periodic `TRIAL_PARAMS`/`STOP` — that idle
link is what an analog acquisition poll can use.

**Capabilities.** `GET_CONTROLLER_INFO` 0xC2 → `{version, capability_bitmap, mac[6]}`;
`Studio.capabilities` holds the names (`js/arena-wire-g6.js` `CAPABILITY_BITS`: bit5
`io_ext`, bit6 `ai_cal` from F2). New firmware features get a bit and the Studio greys
or hides the control until the bit is present ("needs … firmware" text) — never
version-sniff.

**Analog I/O opcode family (0xA_)** — encoders/decoders live in `js/arena-wire-g6.js`
(every new one needs an export **and** a test; a missing export throws silently inside
async handlers):

| Op | Name | Payload → reply |
|---|---|---|
| 0xA0 | SET_AO_VOLTAGE | `[03 A0 mv_lo mv_hi]` 0–5000 mV on "Analog Out (0-5V)" (MCP4725; the BuckPuck LED shares this BNC) |
| 0xA1 | GET_AO_VOLTAGE | → u16 LE mV |
| 0xA2 | SET_AO_LUT | upload + start an AO waveform table |
| 0xA3 | SET_AO_MODE | 0 programmable · 1 **frame_number** (AO tracks the frame index 0–5 V — a free analog pattern-position output, and the fps meter for Mode 4 bench tests) |
| 0xA4 | GET_ANALOG_IN | → `[ain1 i16][ain2 i16][flags u8]` mV; flags bit0/1 = channel calibrated, bit2 = 12-bit (F1) |
| 0xA5 | SET_ANALOG_CAL (F2) | `[len A5 ch action (mv_lo mv_hi)]` — 0 sample 0 V point, 1 sample +10 V point, 2 set deadband, 0xFF clear → the record |
| 0xA6 | GET_ANALOG_CAL (F2) | → `[version adc_bits source flags]` + 2 × `[valid raw_open u16 raw_gnd u16 deadband u16]` (18 B) |
| 0xA7 | GET_ANALOG_IN_RAW (F2) | → raw counts, two u16 |
| 0xAA–0xAD | digital I/O | `SET/GET_DIGITAL_OUT`, `SET/GET_DIO_ROLE` (roles: off / in_trigger / out_programmable / out_debug_framescan) |

**Controller analog facts (after F1/F2).** Two channels: "Analog In 1 (±10V)" J28 →
AIN0/D14 (the Mode 4 input), "Analog In 2" J29 → AIN1/D15. OPA2277 two-stage front end
(±10 V → 0–3.3 V, REF102 10 V reference, 10k pull-up so an open input reads +10 V).
ADC 12-bit, 16× hardware averaging, ≈ 40 µs per `analogRead` (blocking). Mode 4 samples
in the main loop at 500 Hz (`serviceClosedLoop`), EWMA 0.4, deadband, integrates
fractional frames and `loadFrame()`s from the SD on each index change. The controller
has `micros()`; there is no host↔controller clock sync opcode today.

**Studio conventions that bind new work.** Periodic reads go through `session.send`
directly (the logging `send()` would flood the Console log) and reuse
`StudioAnalogIn.createPoller` (single-flight, gated, state-change logging). Every
control needs a tooltip and a HELP-map entry; footer version + ET timestamp bump per
edit; never Prettier the HTML; new shared logic goes in a classic dual-export `js/`
module with a Node test in `pixi run test`.

## 3. The proposal: analog acquisition through the controller (F3 / S4)

Goal (Michael, 2026-09-07): move the analog preview into the **oscilloscope** and **log
it**, so flight-arena experiments (wingbeat analyzer L−R, L+R, frequency on the BNCs,
pattern position from the controller) run **without a National Instruments DAQ**.

### 3.1 Why not just poll 0xA4

A 10 Hz request/response read is two orders of magnitude below what a WBA signal
needs, and Web Serial is single-flight. Sampling must move into the controller; the
host fetches **blocks**. The poll rate stays 10–20 Hz; each reply carries every sample
since the last.

### 3.2 Firmware F3 — sampled block stream

- Ring buffer of both channels at a configurable rate (default 500 Hz; 1–2 kHz should
  be possible), filled from an **`IntervalTimer` ISR**, not the main loop (the loop's
  cadence jitters with SD reads; Mode 4 can keep its own loop sampling or read the same
  buffer). Per sample `[ain1, ain2]` as calibrated int16 mV (or raw u16 + let the host
  apply the 0xA6 record — decide; calibrated-on-controller keeps one truth).
- Per block: `t_start_us` (u32, controller `micros()`), `seq` (u32 running sample index
  → drop detection), `frame_index` (u16, `cur_frame_index_` at block start — the
  stimulus position paired with the fly's signal), `n` (u16), then n × 2 × int16.
- Opcodes (next free in the 0xA_ block): `SET_AI_STREAM` 0xA8 `[.. A8 rate_lo rate_hi
  flags]` (rate 0 = off; flags: which channels, raw vs calibrated), `GET_AI_BLOCK` 0xA9
  `[01 A9]` → header + samples since the last read (cap the block; the host polls
  again if `n` hit the cap). Capability bit 7 `ai_stream`. Buffer ≥ 250 ms so a slow
  poll never drops; at 1 kHz that is 250 × 4 B = 1 KB.
- Bandwidth: 1 kHz × 2 ch × 2 B = 4 KB/s — trivial for USB-CDC; a 20 Hz poll is a
  ~212 B reply. Sampling runs in any state so the scope works outside trials too.
- Clock: blocks carry controller µs; the host stamps `rx_ms` per poll. For stimulus
  alignment the block's `frame_index` is what matters and is exact. If wall-clock
  alignment with the bridge's FicTrac clock is ever needed, add a `GET_CLOCK` (µs)
  opcode and log one pair per trial.
- Bench tooling exists to validate it: the firmware repo's pytest hardware suite over
  USB serial (`tests/`), the AD3 (`instruments` skill) as generator + scope, and AO
  `frame_number` mode as an fps meter.

### 3.3 Studio S4 — scope rows and run-log rows

- **Poll** 0xA9 at 10–20 Hz from a poller like the Analog In panel's (gated on
  connection, capability, and *not* on `session.running` — during Mode 2/4 trials the
  runner does not need the link; exclude Mode 3 FicTrac trials where 0x70 saturates
  it, and say so in the UI rather than dropping samples silently).
- **Scope:** today `Scope.pushSample({ms, ft, x, y, hd, idx, fc})` is the `behavior_v1`
  contract and `js/kinematics.js` derives turning/forward/side. Add a parallel
  **analog trace set** (`Scope.pushAnalog({ms, ain1, ain2, idx})` or a generic
  channel API) with the same overlays (condition / visual / LED epochs) and the same
  window/autoscale controls; WBA-derived channels (L−R, L+R → turning drive, frequency)
  go in a small shared module the dashboard reuses, mirroring how kinematics is shared.
- **Run log:** log each block into the bridge JSONL. The format must slot into the v2
  reader model — see 3.4.
- **Dashboard:** `analysis-core.js parseJsonl` already normalizes every line through
  `runlog-format.js`; add the analog rows there, an analog trace page in
  `plot-specs.js`, and a parity check in `corpus-v2-parity.js`.

### 3.4 Fitting the run-log v2 model (the design the other session must settle)

Constraints: one `frame_schema` line per file; tagged arrays for compact records;
offsets from `t0`; lossless expansion to a canonical object; a converter and a corpus
gate. Options:

1. **Per-sample rows** `["s", t_off_ms, ain1, ain2, idx]` (~25 B/row): simplest for
   readers (one sample per line, like frame rows), 25 KB/s at 1 kHz → ~90 MB/h raw,
   maybe 20 MB/h gzipped. Timestamps per sample are derived (t_start + i/rate), so
   they are redundant bytes.
2. **Per-block rows** `["ai", t_start_off_ms, t_start_us, seq, idx, rate_hz, [ain1…],
   [ain2…]]` (~10 B/sample): denser, one line per poll, exact controller timing kept.
   Readers expand a block into per-sample records at parse time — the same "expand once
   at parse time" move the `"a"` echo uses. **Recommended.**
3. A separate file per run for analog data — rejected: one run = one artifact is a
   pipeline invariant (commit path, dashboard catalog, replay).

Schema: either bump `level` to `behavior_v3` with `analog_cols`/`analog_rate_hz`
added, or keep `behavior_v2` and add an optional `streams: {"ai": {cols:[…],
rate_hz}}` field to the schema line (readers that do not know it ignore the `"ai"`
rows — the normalizer already passes unknown records through). Decide with the
dashboard's `detectFormat`/`normalize` in mind and add the expansion + tests to
`runlog-format.js`; the Python bridge only needs to pass the rows through (they are
browser-originated `log` messages, but they should be written compactly, not as
`{type:"log", …}` objects — so either the browser sends the compact array directly and
the bridge writes arrays verbatim, or the bridge learns a second compaction).

### 3.5 What it replaces and keeps

Replaces the NI DAQ recording of WBA + pattern position for G6 flight rigs. Keeps AO
`frame_number` for labs that still record on a DAQ. Provenance: controller µs in every
block, host `rx_ms` per poll, the calibration record (0xA6) in `run_metadata`.

## 4. Open questions for the acquisition session

1. Sample rate ceiling and jitter with an ISR at 1–2 kHz while Mode 4 also reads the
   ADC and the SD frame path runs — measure on the bench before fixing the spec.
2. Calibrated mV on the controller vs raw counts + host-side calibration in the log.
3. Row format (3.4 option 1 vs 2) and the schema extension (`behavior_v3` vs
   `streams`), including how `--convert` and the corpus gates treat the new rows.
4. Whether the FicTrac bridge remains the log writer for flight rigs that have no
   FicTrac — it already is the universal logger (memory: "bridge = single default-on
   logger"), so probably yes; it just never sees FicTrac frames.
5. Scope channel API generalization (behavior vs analog trace sets) without breaking
   the replay path (`js/runlog-replay.js` builds the scope timeline from log rows).
6. Whether Mode 4 should consume the same ISR-sampled buffer (one sampling path) or keep
   its loop-timed read.

## 5. Pointers

- Firmware: `src/CommandProcessor.cpp` (`GET_ANALOG_IN_CMD`, `SET_ANALOG_CAL_CMD`,
  `serviceClosedLoop`, `ainMv`, `ainCalLoad/Save`), `src/constants.h` (§ Mode 4, § ai_cal,
  capability bitmap), `src/commands.h`, `tests/test_io_roles.py`, `tests/test_analog_cal.py`.
- Studio: `js/arena-wire-g6.js` (encoders/decoders, `CAPABILITY_BITS`),
  `js/arena-session.js` (`send`, `_logCommand`), `js/studio-analog-in.js` (monitor,
  poller, sweep), `arena_studio.html` Console handlers (`caiget`, `caipoll`, …) and the
  `Scope` IIFE (`pushSample`, overlays), `js/kinematics.js`, `js/runlog-replay.js`.
- Log format: `fictrac-bridge/bridge.py` (`compact_arena_command`, `frame_schema_line`,
  `--convert`), `js/runlog-format.js` (`createNormalizer`, `expandV2Line`),
  `dashboard/data-browser/analysis-core.js` (`parseJsonl`).
- Memory notes for the assistant: `runlog-behavior-v2`, `analog-input-plan`,
  `safe-mode-oscilloscope-behavior-v1`, `fictrac-closed-loop-v3-runner`.
