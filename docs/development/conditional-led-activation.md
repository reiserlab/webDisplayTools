# Conditional LED activation (index-gated LED in closed loop)

**Status:** implemented on the web path (Arena Studio v0.59), tested in Node +
in-browser, **not yet bench-validated**. Web-only (MATLAB does not read it).

## What it does

During a **Mode-3 (FicTrac closed-loop)** trial, drive the BuckPuck LED **ON only
while the displayed pattern frame index is inside author-specified bands**, with
optional hysteresis to prevent chatter at a band edge. The frame index is live
(driven by the fly's behavior via FicTrac), so this is a host-side reaction to
each displayed frame.

## YAML schema

`led_activation` is an **optional nested-object attribute on a `trialParams`
command** (NOT a separate command). Add it to a Mode-3 trialParams:

```yaml
- type: "controller"
  command_name: "trialParams"
  pattern: "closed_loop_grating"
  pattern_ID: 2
  duration: 30
  mode: 3                 # REQUIRED — led_activation only runs in Mode 3
  frame_index: 0
  frame_rate: 0
  gain: 0
  led_activation:
    level: 20            # LED brightness % when ON (BuckPuck curve; 0 = never lights)
    hysteresis: 3        # frames of overshoot past a band edge before OFF (0 = none)
    on_ranges:           # 0-based frame-index bands, inclusive, where the LED is ON
      - [50, 100]
      - [150, 180]
```

- **`on_ranges`** are **0-based** frame indices (same value the wire uses for
  `SET_FRAME_POSITION`), inclusive on both ends. A 200-frame pattern is `0..199`.
- **`level`** is a percentage (0–100) mapped to control voltage by the shared
  BuckPuck curve (`ledPercentToMv`); `0` never turns the LED on.
- **`hysteresis`** (integer ≥ 0): the LED turns **ON at the true band edge**, and
  turns **OFF only once the index is more than `hysteresis` frames outside every
  band**. `0` = flip exactly at the edges. Higher = stickier (kills chatter when
  the fly dithers on a boundary).
- Omit `led_activation` entirely for a normal trial (no LED gating).

## Semantics / guarantees

- **Transition-only:** the LED command (`SET_AO_VOLTAGE`, 0xA0) is sent **only when
  the ON/OFF state changes**, never every frame — so it doesn't compete with the
  per-frame `SET_FRAME_POSITION` traffic on the same serial link.
- **Self-contained per trial:** the LED is set to a known OFF baseline when the
  trial starts, and forced OFF at trial end, on the next trialParams, on
  allOff/stopDisplay, on Stop, and on disconnect.
- **Mode 3 only:** Mode 4 (analog closed loop) computes the frame on the
  controller, so the host can't gate on it; the runner ignores `led_activation`
  outside Mode 3 and the designer shows a warning.
- **Run-log provenance:** the trial's `led_activation` spec is recorded on the
  `trial-running` event, and each LED transition is logged as a `led-activation`
  event (`{on, index, ledPercent}`) in `runlog.json` / `runlog.txt`.

## How to author

- **Arena Studio designer (Edit view):** select the condition → on its
  `trialParams` card, use the **"+ add:" dropdown → `led_activation`**. A sub-panel
  appears with **level**, **hysteresis**, and an add/remove **on-ranges** list. The
  ✕ on its header removes it. Requires advanced mode (safe mode is read-only).
- **By hand / another tool:** write the `led_activation:` block shown above. It
  round-trips through load → edit → save unchanged.

## Where it lives (code)

- `js/arena-runner-g6.js` — `normalizeLedActivation()` (validate/normalize; throws
  → the trial is skipped, not the run) and `makeLedActivator()` (pure stateful
  index→{on,changed} with hysteresis). The `ArenaRunner` installs an activator on a
  Mode-3 trialParams, subscribes to the FicTrac bridge's `applied` event, and sends
  the LED command on transitions.
- `js/protocol-yaml-v3.js` — `led_activation` is a known controller key, deep-cloned
  so the nested object survives round-trips.
- `js/plugin-registry.js` — object-typed optional schema entry (advertises the
  `level`/`hysteresis` sub-fields; no default so it isn't auto-added).
- `arena_studio.html` — the `renderLedActivation` sub-editor + `controllerParamSeed`.

## Tests

- `tests/test-arena-runner-g6.js` — normalize validation, hysteresis transitions
  (incl. a dither-no-chatter case), the install→bridge-event→SET_AO_VOLTAGE wiring
  (transition-only + emit), and bad-spec-skips-trial.
- `tests/test-protocol-roundtrip-v3.js` Suite 36 — nested round-trip, omitted stays
  absent, schema shape.
- `tests/test-plugin-registry.js` — object schema.
- Run all: `pixi run test`.

## Bench testing (what to check on real hardware)

**Prerequisite:** fw #39+ controller, a rig with FicTrac + the BuckPuck LED wired to
Analog Out, and the FicTrac bridge running (`pixi run bridge`).

1. **Closed loop must actually be applying frames.** `led_activation` fires off the
   bridge's `applied` events — confirm the Run view / Console has closed-loop
   **apply enabled** for the Mode-3 trial (the LED won't gate if frames aren't being
   pushed). *This is the main open question to verify first.*
2. Author a trial with `on_ranges: [[a, b]]` covering a clearly-visible slice of the
   pattern. Run it closed-loop and rotate the ball so the displayed frame sweeps
   through `a..b`: the LED should come on entering the band and go off leaving it.
3. **Hysteresis:** with `hysteresis: 5`, dither the fly right at edge `b` — the LED
   should stay solidly on, not chatter.
4. **Teardown:** end the trial / press Stop — the LED must go off.
5. **Run log:** confirm `led-activation` events appear in the committed run log with
   plausible frame indices.

## Not done / caveats

- **No bench validation yet** (see above).
- **MATLAB** does not read `led_activation` (web runner only), like `duty`.
- **Wraparound:** `on_ranges` are compared linearly; a band that should wrap across
  the 0/last-frame seam isn't special-cased (author two ranges instead).
- **Standalone `experiment_designer_v3.html`** runs and round-trips `led_activation`
  but can't edit it (Studio only) — by design (maintenance mode).
