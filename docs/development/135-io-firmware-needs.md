# #135 rig I/O — exact firmware changes needed (review, 2026-07-03)

What the fw-gated `io:` roles need from `LED-Display_G6_Firmware_Arena`,
grounded in the current code (branch `feat/controller-info-mac-0xc2`, which
already carries the Session-1 MAC change). Written against the physical board
(user photo, 2026-07-03) — the BNC silkscreen is the naming vocabulary
everywhere:

| BNC silkscreen | Schematic | Teensy pins | Firmware today |
|---|---|---|---|
| `Digital IO 1 (5V)` | J3, U2 SN74LVC1T45 | data D37, dir D36 | boots OUTPUT LOW (`CommandProcessor::begin`) |
| `Digital IO 2 (5V)` | J4, U3 SN74LVC1T45 | data D35, dir D34 | boots OUTPUT LOW, then `setupExternalTriggerInput()` flips DIR to input — see bug below |
| `Analog In 1 (±10V)` | J28, OPA2277 front-end | AIN0 / D14 | Mode-4 closed-loop sampling (500 Hz) — **untested, calibration TBD** (`constants.h`) |
| `Analog In 2 (±10V)` | ? | **unmapped** | not referenced anywhere in firmware |
| `Analog Out (0-5V)` | J27, MCP4725 (I2C) | Wire @400 kHz | 0xA0 set / 0xA1 get / 0xA2 LUT playback |

Convention locked on the web side (2026-07-03): **rig `io:` `port` is 1-based
and equals both the silkscreen number and the 0xAA wire channel.** Any new
firmware opcode below should use the same 1-based port byte. (The #135
addendum's original sketch used 0-based ports — superseded; `parseRigIo`
rejects `port: 0` with a warning.)

## 0. Pre-existing bug to fix first: Digital IO 2 boot contention

`main.cpp setup()` calls `cmdProc.begin()` **before** `setupExternalTriggerInput()`:

- `CommandProcessor::begin()` sets D35 (`do2_data`) `OUTPUT LOW` and D34
  (`do2_dir`) `HIGH` (drive BNC).
- `setupExternalTriggerInput()` then flips D34 `LOW` (BNC → EINT input route)
  **but D35 stays an output driving LOW** — directly against U3.A, which now
  drives that same net from the BNC. Its own comment says "Leave pins 35 …
  as inputs so nothing else drives the EINT net", but `begin()` already made
  35 an output. Result: bus contention on every HIGH trigger pulse, and an
  unreliable EINT level.
- Worse, any `SET_DIGITAL_OUT` (0xAA) on channel 2 sets DIR back to HIGH —
  **silently destroying the external-trigger route until reboot**. Nothing
  reports this.

This is exactly the "explicit flagging" gap: the firmware has no notion of a
port's role, so nothing can refuse a conflicting command. Fix it as part of
change 1 (don't patch it separately — the role state machine IS the fix).

## 1. DIO role state machine + `in_trigger` (the priority)

The SN74LVC1T45 translators make each `Digital IO n (5V)` BNC genuinely
reversible; the EINT fanout (U3 → J30 shunt → R216 → 74LVC2G17 → every
panel's EINT/GP45) means **`in_trigger` on Digital IO 2 is the hardware
trigger for the panel display modes that already exist** (SET_PANEL_DISPLAY_MODE
0x1B, modes 2 `triggered` / 3 `gated`). `in_trigger` on Digital IO 1 has no
EINT route — it can only be a host-readable logic input (still useful, but a
different animal; the doc/UI should say so).

Firmware changes:

- Per-port role state: `off` (safe non-driving: DIR = B→A, data pin
  `pinMode(INPUT)`), `in_trigger` (same pin config as `off`; on port 2 the
  BNC now feeds EINT — J30 must be installed), `out_programmable` (DIR = A→B,
  data pin OUTPUT), `out_debug_framescan` (change 2). Boot defaults that
  reproduce today's *intended* behavior: port 1 = `out_programmable` LOW,
  port 2 = `in_trigger` **with D35 tri-stated** (folds
  `setupExternalTriggerInput()` into the state machine and kills the
  contention).
- New opcodes (suggested; keep the 0xA_ I/O block):
  - `SET_DIO_ROLE` `0xAC` — `[03 AC port role]`, port 1|2, role 0=off /
    1=in_trigger / 2=out_programmable / 3=out_debug_framescan. Sequencing
    inside the handler matters: **to input — `pinMode(data, INPUT)` first,
    then DIR LOW; to output — DIR HIGH first, then `pinMode(data, OUTPUT)`
    with a defined level** (never a moment where both sides drive).
  - `GET_DIO_ROLE` `0xAD` — `[01 AD]` → payload `[role1, level1, role2,
    level2]`; `level` is the live `digitalRead` of the data pin, which in
    input mode is the BNC level through the translator — gives the host a
    trigger-line readback for free.
- **Guard 0xAA**: `SET_DIGITAL_OUT` on a port whose role isn't
  `out_programmable` returns status 1 with an ASCII payload naming the fix
  ("port 2 role is in_trigger — SET_DIO_ROLE first"). Explicit, never a
  silent direction flip. (The Studio's `send()` already logs firmware error
  payloads, so the bench sees the reason immediately.)
- Optional but recommended: a **capability bit** in `controller_capability_bitmap`
  (0xC2) for "DIO roles supported", so the web un-greys `in_trigger` by
  capability detection instead of firmware-version guessing —
  `decodeControllerInfo` already surfaces the bits, and `RIG_IO_ROLES.fwGated`
  can become dynamic per-connection.

Web-side flip when this lands: wire encoders/decoders for 0xAC/0xAD (+ golden
vector tests), `applyRigIo` sends the role for every declared port before any
defaults, remove `in_trigger` from `RIG_IO_ROLES.fwGated.dio` (or key it off
the capability bit).

## 2. `out_debug_framescan` (cheap, high bench value)

Role value 3 in the same state machine — no extra opcode. Firmware toggles
(or pulses, ~10 µs) the port's data pin at the moment a frame is pushed to
the panels (the site where `spi_.framesSent()` increments / `serviceDisplay`
retransmits). Decision to make: toggle-per-frame (scope-friendly, half-rate
square wave) vs fixed-width pulse (unambiguous edges). Toggle is one line and
has no timing tail — recommended.

## 3. AO `frame_number` mode

- New `SET_AO_MODE` `0xA3` — `[02 A3 mode]`, 0 = programmable (today's
  behavior: 0xA0 levels + 0xA2 LUT), 1 = frame_number. (Reusing 0xA2's mode
  byte is possible but conflates waveform playback with position encoding —
  a separate opcode is clearer.)
- In frame_number mode the service loop writes the DAC whenever
  `cur_frame_index_` changes (5 assignment sites today — hook once in
  `serviceDisplay` on index change, not in each site):
  `mv = round(5000 * cur_frame_index_ / max(frame_count_ - 1, 1))` — 0 V =
  frame 0, 5 V = last frame, matching the G4 pattern-position convention.
- Constraint: MCP4725 is I2C @400 kHz ⇒ ~100 µs blocking per update. Fine at
  frame rates into the hundreds of Hz from the main loop; skip the write when
  the index hasn't changed, and never call it from an ISR.
- 0xA0/0xA2 while in frame_number mode should return status 1 (same
  explicit-refusal pattern as the 0xAA guard).

## 4. AI closed-loop (`in`) — validation, not construction

Mode 4 already samples `Analog In 1 (±10V)` (AIN0/D14, 500 Hz,
`fps = V·100·gain/10`), but `constants.h` flags the ±10 V front-end mapping
as **calibration TBD** and it has never been bench-validated — that, not new
code, is the gate for un-greying `ai: in`. Two additions worth making while
in there:

- `GET_ANALOG_IN` (suggest `0xA4`) — `[01 A4]` → `[ain1 int16 LE mV,
  ain2 int16 LE mV]` (signed, post-calibration). Diagnostic value at the
  bench (meter-vs-reading in seconds) and cheap.
- Map `Analog In 2 (±10V)`'s Teensy pin from the schematic (it is referenced
  nowhere in firmware today). The web `io:` schema keeps a single `ai:` entry
  until channel 2 has a defined use; the parser tolerates growing it into a
  per-channel list later.

## Sequencing / priorities

None of these block the CSHL course (course protocols use only
`out_programmable` + AO `programmable`, both live today). Recommended order:

1. **DIO role machine (change 1)** — it fixes the live Digital IO 2
   contention/trigger-clobbering bug even if `in_trigger` itself waits.
2. Framescan toggle (change 2) — one line once 1 exists.
3. AO frame_number (change 3).
4. Mode-4/AI calibration + `GET_ANALOG_IN` (change 4) — bench-time bound.

Already shipped (Session 1): MAC bytes in the 0xC2 reply
(`feat/controller-info-mac-0xc2`), tolerant on both sides.

Spec sync when any of this lands: `g6_03-controller.md` in
`reiserlab/Modular-LED-Display` — §5 (0xC2 MAC bytes, still pending from
Session 1) + new entries for 0xAC/0xAD/0xA3/0xA4 + the 0xAA/0xA0 refusal
semantics + capability-bit assignments.
