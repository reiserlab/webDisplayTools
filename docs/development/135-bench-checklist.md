# #135 session rig + firmware MAC — bench-test checklist

Session-1 gate (2026-07-03): everything below must pass on real hardware
before #135 is declared done (per the bench-parity discipline in
`arena-studio-parity.md`). Software-side verification (unit tests + headless
browser) already passed; these are the hardware-coupled checks.

Setup: controller flashed from `LED-Display_G6_Firmware_Arena` branch
`feat/controller-info-mac-0xc2` (`pio run -e teensy41 -t upload`), Arena
Studio v0.4 served via `.claude/nocache-server.py` (port 8091), hard refresh.

## A. Firmware MAC in 0xC2

- [ ] Connect in the Studio → run log shows
      `‹ controller info: fw v1 · caps […] · id XX:XX:XX:XX:XX:XX`
      (the `id` part is new — old firmware shows no `id`).
- [ ] Run view → provenance panel → `controller:` shows the MAC (not
      "— (needs fw with MAC in 0xC2)").
- [ ] Console ▾ Controller → **Get info** logs the same MAC; reply payload is
      8 bytes (`[version, caps, mac×6]`).
- [ ] MAC matches the Teensy's real one: compare against Console ▾ Controller
      → **Get IP** + your DHCP server's lease table (or the printed label).
- [ ] Ethernet unplugged: MAC still reported over USB serial (it comes from
      the Teensy fuses, not the link).
- [ ] Older production firmware (any pre-MAC build): connect still works,
      log says `(no MAC in reply — older fw)` — the decode is tolerant both ways.

## B. Session rig lock (one selector, three views)

- [ ] Top bar shows the rig selector 🔒-locked on load; picking is impossible
      until the lock is clicked (🔓).
- [ ] Load `?p=g6_2x10_smoke`: selector follows to `CSHL G6 — 2×10`, no chip.
- [ ] Unlock → pick `2×8 of 10` → re-lock: amber **⚠ bench ≠ protocol** chip
      appears in the top bar; URL gains `&rig=cshl_g6_2x8`.
- [ ] Console: stream **Panel map** now renders 2×8 geometry (16 panels) —
      the Console has no arena picker of its own anymore.
- [ ] With the 2×8 rig selected, ISP "show on arena" checkbox disables
      (progress map needs a 20-panel layout) — re-select 2×10, it re-enables.
- [ ] `arena_studio.html?rig=cshl_g6_2x10_ball` bookmark: opens with the ball
      rig selected + locked, in Run mode, before any protocol is chosen.
- [ ] Protocol load while an explicit rig is set does NOT flip the selector —
      chip shows instead.

## C. Rig io: power-on defaults

Temporarily edit `configs/rigs/cshl_g6_2x10.yaml` on the bench copy:
`dio` `port: 1` → `role: out_programmable, default: 1`; `ao` →
`role: programmable, default: 5.0`. Hard refresh. (Ports are 1-based ==
board silkscreen == 0xAA channel.)

- [ ] Connect → run log shows
      `rig io defaults applied (cshl_g6_2x10): Digital IO 1←HIGH · Analog Out←5 V`.
- [ ] Meter/scope: the BNC silkscreened "Digital IO 1 (5V)" reads TTL HIGH;
      "Analog Out (0-5V)" reads ~5.0 V **immediately after connect** (the
      5 V-idle hardware case).
- [ ] Console → hardware I/O → analog out field shows `5000` mV (read-back
      happened after the default was applied).
- [ ] Controller ▾ → Rig I/O rows show `out_programmable` / `default HIGH`
      and `programmable` / `default 5 V`; greyed options (`in_trigger`,
      `out_debug_framescan`, `frame_number`, AI `in`) are unpickable with
      tooltips naming the firmware dependency.
- [ ] Set DO1 role to `off` in the menu → **Apply rig defaults** → log shows
      AO applied but no DO line (session override respected; DO1 unchanged).
- [ ] Revert the YAML → reconnect → log shows no `rig io defaults applied`
      line (all-off rig is a no-op).

## C2. Negative frame_rate — Mode-2 reverse playback (fw #4 / ee74c33)

Firmware `main` reads trial-params `frame_rate` as **int16** (negative =
reverse); web tools now encode it signed. Never bench-verified on either side.
Use a multi-frame pattern with an obvious direction (e.g. panel-map or a
drifting grating).

- [ ] Console → params: `mode 2`, `rate 5` → frames advance forward (baseline).
- [ ] Same pattern, `rate -5` → frames count DOWN (G4-style reverse), wrapping
      from frame 0 to the last frame.
- [ ] `rate -30` vs `rate 30`: same speed, opposite directions.
- [ ] `rate 0` still shows a static frame (no motion).
- [ ] GET_FRAME_POSITION (0x72) polls a DECREASING index during reverse play
      (Controller ▾ / raw hex `01 72` if no button).
- [ ] A recorded run from a protocol with `frame_rate: -30` starts (run gate +
      runner no longer reject the sign) and the stimulus moves in reverse.
- [ ] OLD firmware caveat check (any pre-2026-06-25 build, if one is still on
      a bench): negative rates there alias to a huge forward rate — confirm
      the web tooltip's warning matches reality before the course.

## E. Extended I/O command set (fw branch `feat/dio-roles-ao-modes`, io_ext)

> **2026-07-03 bench run (automated):** the rig was flashed with the
> `teensy41` (debug) build of `feat/dio-roles-ao-modes` and the firmware
> repo's hardware suite ran against it over USB serial — the new
> `tests/test_io_roles.py` (role machine round-trip, 1-based-port rejection,
> 0xAA auto-promote + both refusals with remedy text, AO frame_number DAC
> ramp on a 200-frame pattern ±4 mV, 0xA0/0xA2 refusals, GET_ANALOG_IN
> shape/range) and the updated `test_get_controller_info` (8-byte reply,
> io_ext bit, real MAC) ALL PASS: 24/24, plus 44 passed / 3 skipped on the
> non-destructive regression sweep (signed frame rate, panel modes, diag,
> stream triggers). SD-destructive suites (sd_files/lab79/lab82/gh18) were
> deliberately NOT run — they DELETE_ALL_PATTERNS. The SD gained one file
> (`conftest.pat`, the test pattern) — delete via Console if unwanted.
> Remaining below = instrument/eyeball items only.
>
> **AD3-CONFIRMED same day (user, bench):** the Digital IO 1 framescan
> envelope pulses, and Analog Out sits at 5.00 V (the rig-YAML idle default).
> Also confirmed: reboot restores boot defaults (SPI 25 MHz / refresh 300 Hz)
> after the test suite had left 10 MHz / 60 Hz behind — that suite defect is
> fixed (fw `e051a5c`, round-trip tests now restore prior values).
> Still open: session-rig mismatch chip walkthrough (§B), reverse-playback
> visual (§C2), `01 AD` after power-cycle → `[02 xx 01 xx]` (DIO boot roles),
> and trigger-input into Digital IO 2 (deferred with the AI input tests).

The web apply-path isn't wired yet — drive these via Console → raw hex. Flash
the `feat/dio-roles-ao-modes` build (it stacks on the MAC branch).

- [ ] Connect → controller-info log line shows `io_ext` in the caps list
      (capability bitmap 0x23).
- [ ] **Boot contention fix:** power-cycle, then `01 AD` (GET_DIO_ROLE) →
      `[role1=2, level1, role2=1, level2]` — port 1 out_programmable, port 2
      in_trigger. Feed a 5 V level into "Digital IO 2 (5V)": `01 AD` again —
      level2 follows the BNC (live trigger readback, no contention heating).
- [ ] **External trigger still works** (J30 installed): panel display mode
      triggered/gated (`0x1B`) + pulses into Digital IO 2 → panels gate/step
      as before the refactor.
- [ ] **0xAA refusal:** `03 AA 02 01` (drive Digital IO 2 while in_trigger) →
      status 1, ASCII "role is in_trigger - SET_DIO_ROLE (0xAC)…" in the log;
      the trigger route is UNAFFECTED afterwards (`01 AD` unchanged).
- [ ] **Auto-promote:** `03 AC 01 00` (port 1 → off), then `03 AA 01 01` →
      succeeds and `01 AD` shows role1=2 (off auto-promoted); BNC reads 5 V.
- [ ] **Framescan envelope:** `03 AC 01 03` (port 1 → out_debug_framescan),
      display any pattern → scope on "Digital IO 1 (5V)": LOW between frames,
      HIGH exactly spanning each frame's SPI transmission (pulse width ≈
      transfer time; rep rate = refresh rate). Envelope present in ALL_ON /
      stream / pattern modes.
- [ ] **AO frame_number:** `02 A3 01`, run a pattern Mode 2 → "Analog Out
      (0-5V)" ramps 0→5 V once per pattern loop (sawtooth; reversed rate →
      reversed sawtooth). `03 A0 88 13` (SET_AO_VOLTAGE 5000 mV) or any 0xA2
      while active → status-1 refusal. `02 A3 00` restores programmable AO.
- [ ] **GET_ANALOG_IN:** `01 A4` → two int16 LE mV values; feed a known DC
      level into each "Analog In n (±10V)" BNC and note the reading vs meter
      (calibration TBD — record the offset/scale for the g6_03 cal item).

## D. Regression sweep (things this session touched)

- [ ] Stream figures (full-field / panel map / orientation / checker) on the
      2×10 rig — unchanged behavior.
- [ ] Paste-frame validates against the SESSION rig's dimensions.
- [ ] A recorded run end-to-end (`g6_2x10_smoke`) — run gate, run log, and
      `controller_id` in the exported run-log meta (now populated by the MAC).
- [ ] Back/forward after mode switches — no history spam; `?rig=` survives
      canonicalization.

Follow-ups queued (not gating): update `g6_03-controller.md` §0xC2 in
Modular-LED-Display with the MAC extension; firmware README opcode-table audit
(separate task chip).
