# Analog input: validation, Console "Analog In" panel, calibration, Mode 4 closed loop — PLAN (no code)

Owner: Michael. Drafted 2026-09-07 from the firmware (`LED-Display_G6_Firmware_Arena`
main + `arena-2x10-local`), the controller schematic (`LED-Display_G6_Hardware_Arena`
`arena_10-10_v1/analog.kicad_sch`), Will's analysis in the IO Rodeo group DM
(2026-08-27), the G3 controller source (`LED-Display_G3_Software`, XmegaController
`main.c`) for the closed-loop gain heritage, and the Studio Console as of v0.73.
Status: **plan; decisions 1, 3, 5 taken 2026-09-07 (§6)**. Hardware fix tracked as
LAB-209 (Frank). Lands as a hardware fix, three firmware PRs, and three or four
Studio PRs (§7).

## 0. What we know (facts, with sources)

### Hardware — two channels, two-stage front end, and a known board bug

| BNC silkscreen | Schematic | Teensy pin | Path |
|---|---|---|---|
| `Analog In 1 (±10V)` | J28 | AIN0 / D14 | stage 1 OPA2277 (shift+scale ±10 V → 0–10 V, REF102AU 10 V reference) → stage 2 divider → ADC 0–3.3 V |
| `Analog In 2 (±10V)` | J29 | AIN1 / D15 | same, second channel (not used by Mode 4) |
| `Analog Out (0-5V)` | J27 | MCP4725 DAC (I²C) | 0–5000 mV; usable as a loopback source into either input |

Will (IO Rodeo, DM 2026-08-27):

- **Stage-2 resistors are swapped on both channels.** The divider should be
  10k/(10k+20k) = 1/3; the boards have 2/3. Consequence: only **−10 V … 0 V is
  measurable** — anything above 0 V saturates the ADC and reads as full scale. Fix:
  A0 channel **R180 = 20k, R178 = 10k**; A1 channel **R181 = 20k, R179 = 10k**. Will
  reworked both channels on his board and a ±10 V triangle then matched the expected
  linear transform. **The repo schematic still carries the swapped values**
  (R178 = 20k / R180 = 10k, R179 = 20k / R181 = 10k in `analog.kicad_sch`), so this is
  a design fix (next arena revision) plus a hot-air rework of every existing board.
  As of 2026-08-31 Frank and Andrea planned to flip the resistors on one 12-18 first;
  which 10-10s get reworked (Michael's office rig, the CSHL boards) is undecided.
- **Residual error after the fix** is set by resistor tolerance (shift, scale) and
  the 10 V reference (REF102AU, ±0.1 % → ±10 mV at 10 V). Small zero and scale
  offsets remain.
- **Two-point auto-calibration is easy.** With nothing connected, a channel reads
  **+10 V** (a 10k pull-up to the 10 V reference). With a **BNC ground cap** it reads
  **0 V**. Those two points calibrate offset and scale, assuming the reference is
  true 10 V. The only external item is a ground cap.

### Firmware (`LED-Display_G6_Firmware_Arena`, on `main` since the io_ext merge)

- `GET_ANALOG_IN` 0xA4 → two int16 LE mV. Conversion for both pins:
  `v = (raw / 1023 − 0.5) × 2 × 10 V`, i.e. the ADC span is assumed to map exactly onto
  ±10 V with midscale = 0 V. **No calibration constants exist.** `analogRead` runs at
  the Teensy default **10 bits, no averaging** (the Teensy 4.1 ADC supports 12 bits
  and hardware averaging; neither is configured). 1 LSB ≈ 19.6 mV of input.
- Mode 4 (`serviceClosedLoop`): samples AIN0 at **500 Hz**, `fps = v_in × gain / 10`,
  accumulates fractional frames, steps `cur_frame_index_` ±1 per whole frame (wrapping
  at `frame_count_`), and `loadFrame()`s from the SD on every change; `transmitOnRefresh`
  sends it. `gain` is the **int16 LE** trial-params field (the relayout), `init_frame`
  sets the start index, `duration` stops the trial. Capability bit 5 `io_ext`.
- **Docs disagree with the code on the gain formula.** `g6_03-controller.md` § Mode 4
  (and the `constants.h` comment) say `fps = V × 100 × gain / 10` ("1 V = 100 base
  counts"); the code has no ×100. With the code as written, gain = 20 gives 2 fps/V,
  so a 200-frame pattern at +10 V turns once every 10 s. This must be settled before
  the bench (§6, decision 2).
- **Gain heritage — the G3 controller (decoded 2026-09-07).** The G4.1 Slim firmware
  stored `gain_` but never read it (its "closed loop" ran on an internal counter), so
  the only real prior implementation is G3. In `XmegaController/main.c`:
  `xRate = gain × HzFromAdc(adc) / 10 + bias`, where `HzFromAdc` maps the 13-bit ADC
  (1 V = 819 counts on the ±5 V scale) to **100 per volt** ("1 volt == 100 fps") and the
  velocity ISR steps the frame `xRate` times per second — so `xRate` **is** fps. The gain
  byte is 10× the gain (10 = 1.0×; PControl's slider was ±10 sent as ×10). Hence on G3
  **unity gain = 100 fps/V, and the everyday gains of 0.2–0.5 gave 20–50 fps/V** — which
  matches Michael's recollection of "20 or 50 frames per volt". The ADC was smoothed with
  an EWMA (0.6 × previous + 0.4 × new) at a 400 Hz update. The G6 docs' `× 100 × gain/10`
  is therefore the G3-faithful formula (their "−20 = −2.0 fps/V" example is wrong: −20 is
  −2.0× = −200 fps/V); the G6 **code**, with no ×100, runs 100× slower than G3 for the
  same gain byte. See decision 2.
- **Teensy 4.1 ADC facts** (core `analog.c`): `analogReadResolution` 8/10/12 bits (12-bit =
  25 ADC clocks + 24 settling, ≈ 2.5 µs at the 20 MHz ADC clock); `analogReadAveraging`
  4/8/16/32 samples in hardware (a 32× averaged 12-bit read ≈ 80 µs, so two channels at
  1 kHz is < 20 % of the loop). The i.MX RT ADC is noisy at 12 bits (several LSB without
  averaging); averaging 16–32 typically buys ~1–1.5 bits. Practical input resolution:
  20 V / 4095 ≈ 4.9 mV/LSB nominal, expect ~10 mV effective after averaging, vs 19.6 mV
  today. `analogRead` blocks for the conversion — fine at these rates.
- Hardware test tooling exists: the firmware repo's pytest suite over USB serial
  (`tests/test_io_roles.py` already checks the 0xA4 reply shape/range; the AO
  `frame_number` DAC ramp test measured ±4 mV), plus the lab's Analog Discovery 3
  (`instruments` skill: wavegen + scope + logic).

### Studio today (v0.73)

- Console → I/O panel: one-shot **Read** of both channels (`cAiRead`), gated on the
  io_ext capability, labelled "±10V front-end · uncalibrated". No live view.
- Console → Arena Trial panel: **mode 4 is selectable** with `gain` (int16) and `start`
  fields; "Send trial params" encodes `TRIAL_PARAMS` mode 4, so closed loop can already
  be started from the Console (the controller does the loop — the browser is not in it).
- Rig YAML `io:` → Analog In role `in` is **locked "(bench-pending)"** pending
  calibration. The v3 designer and the web runner already carry mode 4 + gain through
  `trialParams` (runner dry-run lists mode 4), so a protocol-level Mode 4 trial needs
  no runner change.

## 1. Goals

1. **Validate the analog input end to end** — front end (after rework), firmware
   conversion, Studio display — on both channels over ±10 V, with numbers we can quote.
2. **A Console "Analog In" panel** (new left-rail button) with a **live ~10 Hz preview**
   of both channels, a strip chart, min/max, and the calibration + validation workflow.
3. **Decide where calibration lives** and add the firmware to store and apply it.
4. **Validate Mode 4 closed loop** from the Console with a function generator and with
   the board's own AO looped back, then from a protocol in the Run view.

## 2. Hardware (prerequisite)

- **Design:** fix the four resistor values in `analog.kicad_sch` (next arena revision) and
  note the rework in the hardware README / production notes so every board's state is
  known ("stage-2 divider fixed: yes/no" per serial number).
- **Rework:** flip R178/R180 and R179/R181 on the boards we will test with — at minimum
  Michael's office 10-10 (development) and the first 12-18. **Test §5.1 T1 tells you
  instantly whether a board has been reworked** (ground cap reads 0 V on a fixed board;
  ≈ +10 V full-scale on an unfixed one).
- Bench kit: BNC ground cap (×2), BNC cables + one T, function generator with ±10 V
  output (the AD3 wavegen is ±5 V — fine for dynamics and loopback, not for the range
  extremes), DMM, and the AD3 for scope/logging.

## 3. Firmware

### F1 — measurement quality + settle the formula (small, do first)

- **Decided (2026-09-07):** `analogReadResolution(12)` and `analogReadAveraging(16)` at
  boot; `adc_full_scale_counts` = 4095. Raises input resolution to ≈ 4.9 mV/LSB and cuts
  noise. Lands **before any calibration numbers are recorded** (it changes the raw scale).
  Keep a light EWMA in `serviceClosedLoop` as G3 did (0.6/0.4 at 500 Hz ≈ 60 Hz corner)
  so a single noisy read cannot step a frame.
- Settle the Mode 4 gain semantics (decision 2) and make code, `constants.h`, `g6_03`
  and the Studio tooltip say the same thing. Recommendation: **G3-faithful**
  `fps = V × 10 × gain` (gain byte = 10× the gain; 10 = 100 fps/V; typical 2–5 = 20–50
  fps/V), i.e. add the ×100 the docs already describe and fix the doc's example. Existing
  protocols with mode 4 gains are only test protocols, so nothing shipped speeds up.
- **Decided (2026-09-07): deadband.** A trial-params-independent config value (mV around
  the calibrated 0 V that yields 0 fps; default ~20 mV, settable with the calibration
  record) so a static input does not drift. G3 had a `bias` term instead; we can add one
  later if flight experiments want it.
- Extend the 0xA4 reply with a 5th byte `flags` (bit0 = ch1 calibrated, bit1 = ch2
  calibrated, bit2 = 12-bit). Backwards compatible: the Studio decoder reads ≥ 4 bytes.

### F2 — calibration: store on the controller, apply in 0xA4 and in Mode 4

- **Model:** per channel `mV = a × raw + b`, derived from two stored raw samples
  (`raw_open` ≙ +10 000 mV, `raw_gnd` ≙ 0 mV), each the mean of N = 256 reads. Store the
  raw pair (so the math can be redone) plus a magic/version/CRC and a "valid" flag.
- **Where — decided 2026-09-07: Teensy EEPROM, mirrored to the SD.** EEPROM (the 4.1
  emulates ~4 KB in flash, `EEPROM.h`, no wiring) is authoritative because calibration is
  a property of the **board's resistors and reference**, not of the SD card: cards move
  between controllers, get reformatted (0x8F wipes everything), and are absent on some
  benches. The record is also written best-effort to `/config/analog_cal.json` on the SD
  so it is human-inspectable and travels with the data; 0xA6 reports which source is in
  force and whether the two agree. A card carried to another controller never overrides
  that controller's EEPROM record.
- **Opcodes** (0xA_ I/O block: A0–A3 analog out, A4–A9 analog in, AA–AF digital; set/get on adjacent even/odd opcodes; capability bit 6 `ai_cal`):
  - `SET_ANALOG_CAL` 0xA6 `[len A6 ch action (mv_lo mv_hi)]` — ch 1|2 (silkscreen numbering), point
    1 = "sample now as the +10 V open-input point", 0 = "sample now as the 0 V ground-cap
    point", 0xFF = clear. Controller averages, stores, recomputes a/b when both points
    exist, persists. Reply: the new record.
  - `GET_ANALOG_CAL` 0xA7 `[01 A7]` → per channel `{valid, raw_open u16, raw_gnd u16,
    a (float32 mV/count), b (int16 mV), source (0 none / 1 eeprom / 2 sd)}` + ADC bits.
  - `GET_ANALOG_IN_RAW` 0xA5 `[01 A5]` → raw counts for both channels (the calibration
    screen shows counts and mV side by side).
- 0xA4 and `serviceClosedLoop` use the calibrated volts when valid, the current fixed
  formula otherwise. Optional but cheap while there: a Mode 4 **deadband** parameter
  (mV around 0 V that yields 0 fps) — an uncalibrated 50 mV offset at gain 20 is
  0.1 fps = 6 frames/minute of drift on a "static" 0 V input, which is exactly the
  failure students would see.
- pytest: calibration round trip (set both points → get → power-cycle → still valid),
  cleared state, 0xA4 flags, raw read, and a Mode 4 zero-input no-drift check.
- `g6_03` sync for 0xA4 flags, 0xA5–0xA7, the Mode 4 formula, and the calibration
  procedure.

## 4. Studio Console "Analog In" panel (new left-rail button)

New rail entry `data-panel="ai"` — **"Analog In"**, sub-label `AI1 — · AI2 —` (live
mV once connected) — with a panel section like the others (title, ✕ collapse, `crow`s).
Everything the panel does goes through the existing `send()` (echo-correlated,
single-flight) and logs to the Console log.

- **Live preview (S1, works on today's firmware).** While the panel is open and the
  controller is connected, poll 0xA4 at **10 Hz** with `setInterval`, single-flight
  (skip a tick if the previous send is still in flight), and **pause automatically while
  a run is active or an SD/ISP operation is in flight** (`session.running`; the panel
  shows "paused — run active"). Show per channel: mV (large), a ±10 V bar meter, min/max
  since reset, and a 30 s **strip chart** (small canvas; 10 Hz is a preview — Mode 4
  samples at 500 Hz, and the chart says so). Update the rail sub-label.
  Firmware without io_ext → the panel shows "needs io_ext firmware" (same wording as the
  I/O panel). Polling stops when the panel is collapsed or the link drops.
- **Loopback self-test (S1).** "AO → AI sweep": with a BNC cable J27 → J28 (or J29), step
  AO 0 → 5000 mV in 500 mV steps, read AI at each step, table of commanded vs measured
  with error and a fitted slope/offset; copy as CSV / write to the Console log. Needs no
  instrument, so every bench can run it; it covers only the positive half of the range.
  Restores the previous AO level (the BuckPuck LED shares that BNC) when done.
- **Calibration (S2, needs F2 / `ai_cal`).** Guided two steps per channel: "1 —
  disconnect the BNC → Sample +10 V", "2 — attach the ground cap → Sample 0 V"; shows raw
  counts, the computed a/b, the residual at both points, and "Save to controller";
  "Read calibration", "Clear". Status chip per channel: `calibrated (eeprom)` /
  `uncalibrated`. Calibration writes are **advanced-mode only** (`?advanced=1`); reading
  and the live preview are safe-mode visible. Every calibration action is also logged to
  the bridge run log as `event: 'analog_cal'` for provenance.
- **Provenance (S3).** When a recorded run's protocol uses Mode 4, put the controller's
  calibration record (0xA6) into `run_metadata` (`analog_cal`). Unlock the rig `io:`
  Analog In `in` role once §5 passes. Optional: during Mode 4 trials, log 0xA4 reads at
  10 Hz into the run log as `["ai", …]` rows so the analysis can see the drive signal.
- Housekeeping per CLAUDE.md: tooltips on every control, HELP-map entries for the rail
  button and panel, release-notes entry, footer bump, no Prettier on the HTML.

## 4b. Later phase — analog acquisition into the oscilloscope + run log (the flight path)

Michael's direction (2026-09-07): the Console panel's 10 Hz preview is a bench tool; the
place analog input really belongs is the **live oscilloscope view**, and if the Studio can
**log** it we have a path to run flight-arena experiments (wingbeat analyzer L−R, L+R,
frequency on the two BNCs, pattern position from the controller) **without a National
Instruments DAQ**. This is a separate, later step; nothing in §3–§4 depends on it.

- **Why polling 0xA4 is not enough.** A 10 Hz request/response read is far below the
  ≥ 500 Hz a WBA signal needs, and Web Serial is a single-flight, echo-correlated link.
  The fix is to move sampling into the controller and fetch **blocks**: the request rate
  stays ~10–20 Hz, but each reply carries every sample since the last one.
- **F3 firmware — sampled block stream.** A ring buffer of both channels sampled at a
  configurable rate (default 500 Hz, up to 1–2 kHz) with, per sample, `[ain1, ain2]`
  (calibrated int16 mV), plus per block a start timestamp (µs), the running sample
  index (drop detection) and the **current frame index** (`cur_frame_index_`, so the
  closed-loop record pairs stimulus position with the fly's signal at full rate — the
  thing the NI DAQ used to record from the AO). New opcodes: `SET_AI_STREAM` 0xA8
  `[.. A8 rate_hz_lo hi flags]` (0 = off), `GET_AI_BLOCK` 0xA9 `[01 A9]` → header
  `{t_start_us u32, seq u32, frame_index u16, n u16}` + n × 2 × int16. Bandwidth at 1 kHz
  is 4 KB/s — trivial. Sampling runs in Mode 2/3/4 and while idle; Mode 4 reuses the same
  samples for its loop. Buffer sized for ≥ 250 ms so a slow poll never drops.
- **S4 Studio — scope rows + run-log rows.** During runs (and in the Console panel) poll
  0xA9 at 10–20 Hz; push samples into the Scope as a new **analog** trace set (AI1, AI2,
  frame index) alongside or instead of the FicTrac rows, with the same overlays
  (condition / visual / LED epochs). Log each block into the bridge run log as compact
  rows — one row per sample `[ms, ain1, ain2, idx]` under a `frame_schema` level
  `analog_v1` (or one row per block) — so the existing gzip commit path and the
  `runlog-format.js` readers extend naturally; the dashboard gains an analog trace view
  and the kinematics module gets a WBA-derived channel set. Link budget: in Mode 4 the
  runner sends nothing per frame, so a 10–20 Hz poll owns the link; in Mode 3 FicTrac
  closed loop the 0x70 stream already saturates it, so the analog stream is Mode 2/4
  only (documented, not silently dropped).
- **What it replaces / keeps.** Replaces the NI DAQ recording of WBA + pattern position
  for G6 flight rigs; keeps the AO `frame_number` output for labs that still record on a
  DAQ. Timing provenance: controller µs timestamps in every block, host `rx_ms` per poll.
- Tests: pytest for the ring buffer (rate, drop counter, block framing), Node tests for the
  new log rows in `runlog-format.js` + dashboard parity, bench with a generator sine into
  AI1 (reconstruct amplitude/frequency from the log) and a Mode 4 run (frame index vs AI).

## 5. Test plan

### 5.1 Front end + conversion (per board, per channel; Console live panel + DMM)

| # | Test | Setup | Expect |
|---|---|---|---|
| T1 | Rework check / open + ground | nothing connected, then ground cap | open ≈ +10.0 V; ground cap ≈ 0 V. An **unfixed** board reads ≈ +10 V (saturated) with the cap on |
| T2 | DC linearity | generator or DMM-verified DC at −10, −5, −2, −1, 0, +1, +2, +5, +10 V | linear; before calibration residual set by tolerances (tens of mV); after F1 12-bit ≈ 5 mV/LSB |
| T3 | Noise | ground cap, 200 samples | std ≤ 1–2 LSB; no popcorn |
| T4 | Dynamics | ±10 V triangle at 0.2 Hz, then 1 Hz | strip chart shows the triangle, no clipping at the peaks; a 10 Hz sine visibly aliases (preview only — expected and labelled) |
| T5 | Cross-talk | drive AI1 ±10 V, ground AI2 | AI2 stays at 0 within noise |
| T6 | AO loopback sweep | J27 → J28 cable, panel's sweep | slope ≈ 1, offset small; repeat on J29 |
| T7 | Rate / link health | panel open 10 min at 10 Hz during Console use | no serial errors, no missed echoes, polling pauses during a run |

Automate T2/T4 with the AD3 (`instruments` skill) once the panel exists; the pytest suite
can sample 0xA4 directly for T3.

### 5.2 Calibration (needs F2)

- C1 Two-point procedure per channel; then DMM-verified −5 V and +5 V → error target
  ≤ 20 mV (12-bit).
- C2 Persistence: power-cycle → still calibrated; swap SD cards → still calibrated
  (EEPROM); clear → back to the fixed formula with flags = 0.
- C3 Provenance: the Console log and the run log carry the `analog_cal` events; a Mode 4
  run's `run_metadata.analog_cal` matches 0xA6.

### 5.3 Mode 4 closed loop from the Console

Preconditions: a 200-frame grating on the SD; Arena Trial mode 4; **AO role
`frame_number`** (0xA3) so the "Analog Out" BNC outputs the frame index as 0–5 V — on
the AD3 scope that is a sawtooth whose frequency = fps / frame_count, which gives an
instrumented fps measurement with no video.

| # | Test | Expect |
|---|---|---|
| CL1 | 0 V (ground cap), gain 20, 60 s | frame index does not advance (drift < 1 frame/min). Uncalibrated offset will show up here — this is the argument for calibration and the deadband |
| CL2 | DC steps +1, +2, +5, +10 V at gain 20 | fps = V × gain/10 (or the ×100 variant — this test settles decision 2); sawtooth frequency scales linearly |
| CL3 | −1 V | reverse direction (sawtooth slope flips) |
| CL4 | gain 10 / 20 / 50 at +2 V | fps linear in gain; check sign of negative gain |
| CL5 | ±5 V triangle at 0.1 Hz; then sine | frame velocity follows; index oscillates for the sine |
| CL6 | AO loopback closed loop: J27 → J28 with AO fixed at 2500 mV (programmable role) | constant fps; no generator needed (positive half only) |
| CL7 | duration + STOP | controller-timed stop at `duration`; STOP mid-trial blanks; a new trial resets `frame_accum_` |
| CL8 | Max fps | raise gain until the sawtooth stops being linear → the SD `loadFrame` per index step is the ceiling; record it |
| CL9 | Run view | a v3 protocol with a Mode 4 condition (gain, init) runs from the runner; run log shows the trial and (S3) the AI rows; dashboard opens it |

### 5.4 Panel acceptance

10 Hz visible refresh; both channels; min/max reset; polling pauses on run start and
resumes after; panel collapse stops polling; non-io_ext firmware shows the guidance
line; safe mode shows the preview but hides calibration writes; tooltips on every
control.

## 6. Decisions (2026-09-07)

1. **Calibration storage — DECIDED: EEPROM authoritative + SD mirror** (§3 F2).
2. **Mode 4 gain formula — OPEN, recommendation ready.** Michael recalled G3/G4 at
   "50 or 20 frames per volt" and asked for the prior code bases to be checked. Finding
   (§0): G3 was **100 fps/V at unity gain** with the gain byte = 10× gain, so the usual
   gains 0.2–0.5 were 20–50 fps/V. Recommend implementing the G3-faithful
   `fps = V × 10 × gain` in the G6 firmware (the ×100 the docs describe), fixing the doc
   example, and labelling the Studio field "gain ×10 — 10 = 100 fps/V". CL2 confirms on
   the bench. Alternative if 100 fps/V at unity feels too hot for ±10 V inputs: define
   the G6 byte as 100× the gain (1 = 10 fps/V, 5 = 50 fps/V) — same range, finer steps,
   but a different number from every G3 protocol note.
3. **12-bit + averaging before calibration — DECIDED: yes** (F1 first).
4. **Rework order** — default: office 10-10 first (development), then the 12-18s, then
   CSHL boards (LAB-209 covers the design; the rework list is Frank's).
5. **Deadband in Mode 4 — DECIDED: yes**, as a config value in F2.
6. **Analog rows in run logs** — superseded by §4b: not 10 Hz polling of 0xA4, but the
   controller-sampled block stream into the oscilloscope and the run log, as a later
   phase (F3/S4).

## 7. Sequencing — and what can be done before lab testing

Everything below the "bench" lines can be built, unit-tested and compiled now (no
hardware for a few days; the office board still needs the resistor rework anyway).

**Buildable now**
1. **FW F1** — 12-bit + averaging(16), EWMA in `serviceClosedLoop`, 0xA4 flags byte,
   G3-faithful gain formula (once decision 2 is confirmed), `constants.h` + `g6_03` sync;
   pytest updates; both PlatformIO envs compile.
2. **FW F2** — calibration record + EEPROM store + SD mirror, opcodes 0xA5 (raw) / 0xA6 (set cal) / 0xA7 (get cal),
   deadband, capability bit 6; pytest (round trip, persistence, cleared state, raw read).
   Code-complete without a board; the numbers come from the bench.
3. **Studio S1** — the Analog In rail panel: live 10 Hz preview, strip chart, min/max, AO →
   AI sweep, pause-during-run. Wire decoders for the 0xA4 flags byte and 0xA5–0xA7
   (`js/arena-wire-g6.js` + `tests/test-arena-wire-g6.js`). Testable in the browser
   against a mocked session (as the Console's offline tests do) — no controller needed.
4. **Studio S2** — calibration UI (advanced-only writes), driven by the same mocked
   session; S3 provenance (`run_metadata.analog_cal`) and the rig `ai: in` unlock are
   small once S2 exists.
5. **Docs/spec** — LAB-209 (done), `g6_03` § Mode 4 corrected formula + calibration
   procedure + new opcodes, hardware README rework list.

**Needs the bench** (in this order): T1 on the reworked office board → T2–T7 → CL1–CL8
(settles decision 2 if still open) → C1–C3 → CL9 from the Run view.

**Later phase:** §4b F3/S4 (analog block stream → oscilloscope + run log), after the
above lands and after the run-log v2 stack (#183/#186/#188) is merged, since S4's log
rows ride on `runlog-format.js`.
