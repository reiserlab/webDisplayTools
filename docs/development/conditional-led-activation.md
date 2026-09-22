# Conditional LED activation (index-driven LED in closed loop)

**Status:** graded zones implemented on the web path (Arena Studio v0.86), tested in
Node + in-browser, **not yet bench-validated with a photodiode**. Web-only (MATLAB does
not read it). The v0.59 hard-edged form (`level` + `on_ranges`) still works unchanged.

## What it does

During a **Mode-3 (FicTrac closed-loop)** trial, drive the BuckPuck LED as a
**function of the displayed pattern frame index**: a baseline level everywhere,
plus author-specified **zones**, each with its own level and **linear ramp edges**.
The frame index is live (driven by the fly's behavior via FicTrac, with any bias
waveform already folded in), so this is a host-side reaction to each displayed
frame — the LED marks *where the stimulus is on the arena*.

Ramps replace the old `hysteresis`: a fly dithering on a zone edge now modulates
the LED a little instead of chattering it on and off.

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
    baseline: 2           # % outside every zone (default 0 = dark)
    zones:
      - level: 10         # % inside the zone (fractional OK: 7.5)
        ramp_in:  [40, 50]   # baseline at frame 40 → level at frame 50
        ramp_out: [100, 110] # level at frame 100 → baseline at frame 110
      - level: 5
        ramp_in:  190        # one index = hard edge (≡ [190, 190])
        ramp_out: [5, 5]     # wraps through frame 0 (a > d is fine)
```

Semantics of one zone `{level, ramp_in: [a, b], ramp_out: [c, d]}`:

| frames | level |
|---|---|
| `< a` | baseline |
| `a .. b` | linear, baseline at `a` → `level` at `b` (`a == b`: `level` from `a`, a hard edge) |
| `b .. c` | `level` |
| `c .. d` | linear, `level` at `c` → baseline at `d` (`c == d`: baseline from `d`, a hard edge) |
| `≥ d` | baseline |

So a zone occupies frames `[a, d)` — `d` is the **first frame back at baseline**.
Frame indices are **0-based**, in the same space as `frame_index`/`setPositionX`
and the wire's `SET_FRAME_POSITION`. A zone may **wrap** through frame 0 (each edge
index is unrolled modulo the pattern's frame count). Where zones **overlap, the
brighter one wins**. A zone whose `level` is *below* the baseline is a dip.

Legacy sugar (unchanged since v0.59, still accepted):

```yaml
  led_activation:
    level: 20
    on_ranges: [[50, 99], [150, 180]]   # inclusive bands
```

`[s, e]` ≡ `{level, ramp_in: [s, s], ramp_out: [e + 1, e + 1]}`. Both forms may be
mixed in one object (sugar zones first). `hysteresis` is **accepted, warned about
in the run log, and ignored** — delete it and widen the ramps instead.

Levels are % of full brightness on the shared BuckPuck curve (`ledPercentToMv`,
same as `ledDrive`). Any non-zero level below **1 %** snaps up to 1 % — below that
the driver is in its dead zone and the LED is dark while the log says "on".

## Semantics / guarantees

- **Sends only on change:** the LED command (`SET_AO_VOLTAGE`, 0xA0) goes out when
  the commanded voltage moves by ≥ **4 mV** (~3 DAC LSB) or crosses dark/lit. A
  hard edge costs one write per crossing; a ramp about one write per frame *while
  ramping*; a plateau costs nothing.
- **Yields to the stimulus:** the LED write is single-flight, latest-wins, and is
  **never queued ahead of a frame the bridge client is about to send**
  (`FicTracBridgeClient.hasPending`). It waits for the next applied frame instead,
  so the per-frame `req_age_us` budget (≤ 10 ms) is not spent on LED traffic.
- **Self-contained per trial:** the LED is set to the **baseline** when the trial
  starts and forced **OFF** at trial end, on the next trialParams, on
  allOff/stopDisplay, on Stop, and on disconnect.
- **Mode 3 only:** Mode 4 (analog closed loop) computes the frame on the
  controller, so the host can't follow it; the runner ignores `led_activation`
  outside Mode 3 and the designer shows a warning.
- **Frame modulus:** the zone vector wraps on the same frame count the bridge
  uses. The runner sizes it from the page's pattern knowledge at trialParams time
  and **re-sizes it from the controller's answer (GET_PATTERN_INFO) at
  `startClosedLoop`**, before the first frame is applied.
- **Run-log provenance:** the trial's normalized `led_activation` (baseline + every
  zone, sugar unrolled) is recorded on the `trial-running` event; each LED write is
  a `led-activation` runner event `{on, index, ledPercent, mv}` — `ledPercent` is
  the level that took effect, so a ramp is reconstructable step by step.

## How to author

- **Arena Studio designer (Edit view):** select the condition → on its
  `trialParams` card, use the **"+ add:" dropdown → `led_activation`**. The
  sub-panel shows **baseline**, a **zones** list (**+ zone** adds a hard-edged
  placeholder; edit *level*, *in from/to*, *out from/to*; ✕ removes a zone) and, if
  the protocol still carries them, the legacy *level* + *on ranges* rows. Every
  number is path-bound, so it carries the 🔗 anchor button (`level: *opto_pct`,
  `ramp_in: [*z_a, *z_b]` all work). Requires advanced mode.
- **By hand / another tool:** write the `led_activation:` block shown above. It
  round-trips through load → edit → save unchanged. `validate-protocol.mjs` lints
  a leftover `hysteresis`, a zone missing a ramp, and a non-Mode-3 trial.

## Where it lives (code)

- `js/arena-runner-g6.js` — `normalizeLedActivation()` (validate/normalize; sugar →
  zones; throws → the trial is skipped, not the run), `buildLedLevelVector(spec, n)`
  (per-frame % vector, unroll + overlap + snap), `makeLedActivator(spec, n)` (stateful
  index → `{level, mv, on, changed}` with the ΔmV threshold, `setModulus`), and the
  `ArenaRunner` wiring: `_installLedActivator(spec, n)` (baseline send + `applied`
  subscription), `_drainLed()` (single-flight, `hasPending` yield, no-op skip),
  `_clearLedActivator()` (OFF). Constants `LED_MIN_LEVEL_PCT`, `LED_MIN_STEP_MV`.
- `js/fictrac-bridge-client.js` — `hasPending` getter.
- `js/protocol-yaml-v3.js` — `led_activation` is a known controller key, deep-cloned
  so the nested object survives round-trips.
- `js/plugin-registry.js` — object-typed optional schema entry: `fields.baseline`,
  `fields.level` (sugar, `seed: false`), `zoneFields.level` / `zoneFields.edge`.
- `arena_studio.html` — the `renderLedActivation` sub-editor + `controllerParamSeed`.
- `js/arena-session.js` — `_sanitizeRunStatus` allow-lists `on`, `ledPercent`, `mv`,
  `ledActivation`.

## Tests

- `tests/test-arena-runner-g6.js` — normalize (sugar, zones, inheritance, every
  malformed shape), level vector (ramps, baseline+probe, dip, wrap, whole-turn cap,
  overlap, unknown modulus, 1 % snap), activator (ΔmV threshold, prime, wrap,
  `setModulus`), runner wiring (coalesced sends with a tick between frames,
  latest-wins under an in-flight send, `hasPending` yield + supersede, baseline send
  vs OFF teardown, link-down), IR warning for `hysteresis`.
- `tests/test-fictrac-bridge-client.js` — `hasPending`.
- `tests/test-protocol-roundtrip-v3.js` Suite 36 (zones round-trip, schema) and
  Suite 37 (zone sub-fields by path: append, edit, bind, delete).
- `tests/test-plugin-registry.js` — schema shape.
- Run all: `pixi run test`.

## Bench testing (what to check on real hardware)

**Prerequisite:** fw #39+ controller, a rig with FicTrac + the BuckPuck LED wired to
Analog Out, the FicTrac bridge running (`pixi run bridge`), and a photodiode on the LED.

1. Run `protocols/led_activation_quadrant_test.yaml` (conditions 1–2 hard edges,
   3 ramped, 4 baseline + wrapping probe). Closed loop must actually be applying
   frames — if the arena rotates with the fly (or `pixi run sim --model fly`), the
   LED is receiving frames too.
2. **Ramps:** sweep through the 10-frame ramp — the photodiode trace must be
   monotone with ~10 steps and no flicker; with a fly dithering on the edge the
   LED should waver slightly, never chatter.
3. **Baseline + probe:** the LED must sit dim (2 %) between zones, never dark, and
   the ramp must start from that dim level.
4. **Stimulus budget:** in the committed run log, the `cf` rows' max `req_age_us`
   during condition 3/4 should match conditions 1/2 (the LED writes yield).
5. **Teardown:** end the trial / press Stop — the LED must go off (not to baseline).
6. **Run log:** `led-activation` events with plausible frame indices and a
   `ledPercent` staircase through each ramp.

## Not done / caveats

- **No photodiode bench validation yet** (see above).
- **MATLAB** does not read `led_activation` (web runner only), like `duty`.
- The dashboard's opto-epoch view (`analysis-core.js`) treats the first lit
  `led-activation` event of a run of lit events as the epoch level; ramps are
  logged step by step but drawn as one epoch at the entry level.
- **Standalone `experiment_designer_v3.html`** runs and round-trips `led_activation`
  but can't edit it (Studio only) — by design (maintenance mode).
