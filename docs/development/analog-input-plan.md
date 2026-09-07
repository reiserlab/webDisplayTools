# Analog input: validation, Console "Analog In" panel, calibration, Mode 4 closed loop — PLAN (no code)

Owner: Michael. Drafted 2026-09-07 from the firmware (`LED-Display_G6_Firmware_Arena`
main + `arena-2x10-local`), the controller schematic (`LED-Display_G6_Hardware_Arena`
`arena_10-10_v1/analog.kicad_sch`), Will's analysis in the IO Rodeo group DM
(2026-08-27), and the Studio Console as of v0.73. Status: **plan only**. Lands as a
hardware fix, two firmware PRs, and two or three Studio PRs (§7).

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

- `analogReadResolution(12)` and `analogReadAveraging(4…8)` at boot; `adc_full_scale_counts`
  = 4095. Raises input resolution to ≈ 4.9 mV/LSB and cuts noise. **Do this before any
  calibration numbers are recorded** (it changes the raw scale).
- Settle the Mode 4 gain semantics (decision 2) and make code, `constants.h`, `g6_03`
  and the Studio tooltip say the same thing.
- Extend the 0xA4 reply with a 5th byte `flags` (bit0 = ch1 calibrated, bit1 = ch2
  calibrated, bit2 = 12-bit). Backwards compatible: the Studio decoder reads ≥ 4 bytes.

### F2 — calibration: store on the controller, apply in 0xA4 and in Mode 4

- **Model:** per channel `mV = a × raw + b`, derived from two stored raw samples
  (`raw_open` ≙ +10 000 mV, `raw_gnd` ≙ 0 mV), each the mean of N = 256 reads. Store the
  raw pair (so the math can be redone) plus a magic/version/CRC and a "valid" flag.
- **Where (decision 1).** Recommendation: **Teensy EEPROM** (the 4.1 emulates ~4 KB in
  flash, `EEPROM.h`, no wiring). Calibration is a property of the **board's resistors and
  reference**, not of the SD card: SD cards move between controllers, get reformatted
  (0x8F wipes everything), and are absent on some benches. If we also want the values
  human-inspectable and part of the data record, **mirror** them to `/config/analog_cal.json`
  on the SD (best effort) and let 0xA6 report the source. The pure-SD alternative Michael
  raised works too, but a card carried to another controller would then bring the wrong
  calibration with it, and the controller must be able to run Mode 4 with no card.
- **Opcodes** (0xA_ I/O block, io_ext-style, capability bit 6 `ai_cal`):
  - `SET_ANALOG_CAL` 0xA5 `[03 A5 ch point]` — ch 1|2 (silkscreen numbering), point
    1 = "sample now as the +10 V open-input point", 0 = "sample now as the 0 V ground-cap
    point", 0xFF = clear. Controller averages, stores, recomputes a/b when both points
    exist, persists. Reply: the new record.
  - `GET_ANALOG_CAL` 0xA6 `[01 A6]` → per channel `{valid, raw_open u16, raw_gnd u16,
    a (float32 mV/count), b (int16 mV), source (0 none / 1 eeprom / 2 sd)}` + ADC bits.
  - `GET_ANALOG_IN_RAW` 0xA7 `[01 A7]` → raw counts for both channels (the calibration
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

## 6. Open decisions for Michael

1. **Calibration storage:** EEPROM (recommended) · SD only · EEPROM + SD mirror
   (recommended if the values should travel in the data record).
2. **Mode 4 gain formula:** keep the code (`fps = V × gain/10`, so gain 20 = 2 fps/V; the
   int16 range already allows thousands of fps/V) and fix the docs — or implement the
   documented ×100. Recommend keeping the code and fixing the docs; CL2 confirms.
3. **12-bit + averaging (F1) before calibration** — yes/no (changes the raw scale).
4. **Rework order:** office 10-10 first (development), then the 12-18s, then CSHL boards.
5. **Deadband parameter** in Mode 4 — worth adding while F2 is open?
6. **AI logging during Mode 4 runs** (10 Hz `["ai", …]` rows in the run log) — include in S3?

## 7. Sequencing

1. **HW:** schematic fix + rework the office board (unblocks everything else).
2. **FW F1** (12-bit, averaging, 0xA4 flags, formula + doc sync) → bench §5.1 T1–T7 and
   §5.3 CL1–CL8 with the AD3 + generator. Studio **S1** (live panel + AO sweep) can be
   built and used against today's firmware in parallel.
3. **FW F2** (calibration opcodes + EEPROM ± SD mirror + tests) → Studio **S2** → bench §5.2.
4. **S3** (provenance, `ai: in` unlock, optional AI rows) → **CL9** from the Run view.
