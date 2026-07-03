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
