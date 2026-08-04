# Closed-loop bias waveforms (LAB-185)

**Status:** implemented, unit- and end-to-end-tested against the real bridge over a
real WebSocket. **Not yet bench-validated on an arena with a fly.** Web-only —
MATLAB has no `FicTracPlugin` (its closed loop is analog Mode 4, computed on the
controller, where the host cannot inject anything).

## What it is and why

In the fly-on-ball assay, FicTrac streams the fly's integrated heading to the Python
bridge, which maps it to an arena frame index; the browser streams that index to the
controller as Mode-3 host-stepped frames. That loop is purely reactive: a fly holding
still sees a still display.

A **bias** is a smooth, known disturbance added into that loop, so the display keeps
moving even when the fly does not. Sweeping it measures **disturbance rejection** —
does the fly counter-turn to null the imposed motion, and how well does it do so as a
function of amplitude and frequency?

## Semantics

The bias is authored as an added rotational **velocity** in deg/s. What the mapping
consumes is its time-integral, a bias **angle**. For peak velocity `A` (deg/s),
frequency `f` (Hz), `ω = 2πf`, and `t` seconds since the closed-loop epoch began:

| `bias_type` | velocity `v(t)` | bias angle `b(t) = ∫v` | position range |
| --- | --- | --- | --- |
| `none` | 0 | 0 | — |
| `constant` | `A` | `A·t` | unbounded drift |
| `sine` | `A·cos(ωt)` | `(A/ω)·sin(ωt)` | `±A/(2πf)` |
| `square` | `A·sign(cos ωt)` | symmetric triangle | `±A/(4f)` |

Three properties are load-bearing, and each is pinned by a test:

1. **`b(0) = 0` for every waveform.** Closed-loop onset never jumps the display.
2. **The periodic waveforms are zero-mean in position.** The display is pushed
   equally left and right instead of drifting to one side. For `square` this is why
   the velocity is `sign(cos ωt)` and not `sign(sin ωt)` — the latter integrates to a
   one-sided `0 → +A/(2f)` ramp. An earlier draft of `sine` used `(A/ω)(1 − cos ωt)`,
   which has the same defect; `tests/test-bridge-behavior.py` asserts a negative
   trough at `3T/4` specifically to keep that from coming back.
3. **`b` is evaluated analytically, never integrated incrementally.** A dropped
   FicTrac frame costs nothing, and the value is exactly reproducible offline.

### Amplitude is a velocity — so excursion shrinks with frequency

Because `A` is a peak *velocity* for every waveform, the position excursion is
derived. At `A = 90 deg/s`, a sine covers `±28.6°` at 0.5 Hz but only `±14.3°` at
1 Hz. To hold excursion constant across a frequency sweep, scale `A` with `f`.

### Direction, and the sign of `gain`

The bias angle is summed in the same **heading-equivalent degrees** space as the
existing `offset`:

```
idx = round((heading_deg + offset + b(t)) / gain) mod n_frames
```

So a positive `bias_amplitude` moves the display the same direction as increasing fly
heading, and a **negative `gain` reverses the bias along with the fly coupling**.

**To reverse the disturbance, negate `bias_amplitude`.** Negating `bias_frequency` is
a **no-op**: both velocity waveforms are cosines, which are even in `ω`. (For the
sine's `b(t)`, the sign flips in `A/ω` and `sin(ωt)` cancel.) The runner warns when
it sees a negative frequency rather than silently doing nothing.

`gain == 0` short-circuits the mapping to index 0, bias included — with no
deg→index scale there is nothing to map. To watch the bias alone at the bench, keep a
real `gain` and hold the ball still.

## Authoring

Per-condition only, on the `fictrac` plugin's `startClosedLoop` command. There is
deliberately **no** copy in the plugin's `configFields` and **no** Console input, so
there is exactly one source of truth.

```yaml
- name: "cl_bias_sine"
  commands:
    - type: "controller"
      command_name: "trialParams"
      pattern: "frame2_h_ccw_200f"
      pattern_ID: 4
      duration: 30
      mode: 3
      frame_index: 0
      frame_rate: 0
      gain: 0
    - type: "plugin"
      plugin_name: "fictrac"
      command_name: "startClosedLoop"
      params:
        gain: 1.8
        bias_type: "sine" # none | constant | sine | square
        bias_amplitude: 90 # PEAK velocity, deg/s (negative reverses)
        bias_frequency: 0.5 # Hz — sine/square only; ignored by constant
    - type: "wait" # LOAD-BEARING: holds the loop open
      duration: 30
    - type: "plugin"
      plugin_name: "fictrac"
      command_name: "stopClosedLoop" # also CLEARS the bias
```

Worked example with all four waveforms: `protocols/fictrac_bias_test.yaml`.

The three fields render automatically in the v3 designer (and the Studio's embedded
one) from the registry schema — `bias_type` as a dropdown, the other two as number
inputs. No designer HTML knows about them by name.

## The phase clock

`t = 0` at the moment the bridge receives a `config` message **containing a `bias`
key** — presence of the key, not its value, re-zeros the clock. The runner bundles
`{frames, gain, bias}` into the one `setConfig` it already sends immediately before
`setApply(true)`, so every closed-loop epoch starts at phase 0 and is reproducible
trial to trial.

`stopClosedLoop` pushes `bias: {type:'none'}`. This is not cosmetic: the bridge
integrates from its own phase clock, so a waveform left installed would keep
accumulating into the frame index through every following trial.

### Two guards, because `stopClosedLoop` only runs on the happy path

A STOP pressed mid-trial aborts the sequence, so `stopClosedLoop` never executes.
Found on the bench (2026-08-04): that left the bias installed *and* its phase clock
running, so the next run inherited a stale, already-drifted disturbance until some
condition happened to push a new one — and separately left the bridge still streaming
`SET_FRAME_POSITION` at the arena after STOP. Two independent guards now cover it:

1. **Every teardown path clears the closed loop.** `ArenaRunner._clearClosedLoop()`
   does `setApply(false)` plus a `bias: {type:'none'}` push, and is called from all
   three teardown paths, symmetric with `_clearLedActivator()`: `runSequence`'s
   `finally` (normal end *and* abort unwind), `stop()` (the STOP button), and
   `_clear()`/`abort()` (involuntary disconnect). It is bridge-only, so it still works
   when the serial link is already gone. It clears the bias only when the *client* has
   one installed, so a bias set on the bridge's own CLI (`--bias-type`) survives a run
   instead of being silently stomped by it.
2. **Every closed-loop epoch is self-describing.** `startClosedLoop` always carries a
   bias in its IR — `{type:'none'}` when the condition authors none — so it can never
   inherit whatever the bridge still had installed. Same reasoning as `duty` in
   `buildTrialParams`: relying on someone else having cleared state leaks one trial's
   settings into the next.

When adding any new run-teardown path, call `_clearClosedLoop()` from it.

## Validation policy

| Input | Result |
| --- | --- |
| `bias_type` omitted / `none` / `""` | no bias; the IR shape is unchanged |
| unknown `bias_type` | **fails the step** (`{op:'error'}`), run continues |
| non-finite amplitude or frequency | **fails the step** |
| `sine`/`square` with `bias_frequency == 0` | **fails the step** — divide-by-`ω` |
| `constant` with `bias_frequency == 0` | fine; frequency is ignored |
| negative `bias_frequency` | **warns**, then runs (it is a no-op — see above) |

Failing the *step* rather than aborting the *run* follows the `duty` precedent in
`buildTrialParams`. The 0 Hz case is a hard failure specifically because the bridge's
defensive fallback returns a 0 bias, which at the bench reads as "the disturbance
didn't work" — a silent no-op is the worst outcome, so it is rejected where the
author gets told why. The bridge keeps its fallback anyway: it runs once per FicTrac
frame and must never raise mid-stream.

## Logging and offline reconstruction

Two records land in the run log:

- The raw `config` message, via the existing inbound logging (`rx_ms`, absolute).
- A bridge-authored `bias_config` event whose **`ms` is in the same relative timebase
  as the `behavior_v1` rows**:

```json
{"type":"bias_config","dir":"bridge","ms":4099,"bias":{"type":"sine","amplitude":90.0,"frequency":0.5}}
```

That second line is what makes `b(t)` exactly reconstructable offline: for any logged
row at `ms`, evaluate `bias_angle_deg(type, amplitude, frequency, (ms − bias_config.ms)/1000)`.
Because the waveform is analytic and deterministic, this recovers the exact value the
bridge used — no per-frame bias column is needed.

**`BEHAVIOR_V1_COLS` was deliberately NOT widened.** The positional row format is
consumed by `js/runlog-replay.js` and the offline dashboard's vendored parser;
adding an eighth column would break every positional reader. A test asserts the rows
stay 7 wide.

The live WebSocket frame message *does* carry a `bias` field (the current angle, deg)
when a bias is active. That is additive — unknown fields are ignored by older clients
— and exists only to drive the Studio's read-only readout.

## Where it lives

| Layer | File | What it owns |
| --- | --- | --- |
| Math | `fictrac-bridge/bridge.py` | `bias_angle_deg()` (pure), `BIAS_TYPES`, the `bias_deg` argument to `frame_index_from_fictrac()` |
| Clock + logging | `fictrac-bridge/bridge.py` | `Pipeline.set_bias()` / `bias_now_deg()`, `LogWriter.write_event()`, the `config` dispatch, `--bias-type/--bias-amplitude/--bias-freq` |
| Transport | `js/fictrac-bridge-client.js` | `bias` as the one object-valued config key; `setBias()`, the `'bias'` event, `biasAngleDeg` |
| Schema | `js/plugin-registry.js` | the three `startClosedLoop` params |
| Validation | `js/arena-runner-g6.js` | `normalizeBias()` → `{bias, warning}`; the `fictracApply` IR and its `_runIR` push |
| UI (read-only) | `arena_studio.html` | `#rbBias` in the Run-view bridge strip |

The vocabulary `none|constant|sine|square` is declared in three places (bridge
`BIAS_TYPES`, runner `BIAS_TYPES`, registry `bias_type.options`). A registry test
pins all three to the same list — keep them in step.

## Non-goals (v1)

- Bias as a **position** disturbance (the waveform is a velocity throughout).
- Phase offset, and a square-wave duty cycle.
- A live scope channel for the bias — that would mean touching `js/kinematics.js`,
  `runlog-replay.js`, and the vendored dashboard parser.
- Console panel bias inputs (protocol-authored only, by design).
- Any Mode-4 equivalent: the controller computes that frame from an analog input, so
  the host has no injection point.

## Verifying it

- `pixi run test` — `tests/test-bridge-behavior.py` pins the closed forms, `b(0)=0`,
  the zero-mean property, and the mapping with bias folded in; the runner, client,
  registry, and v3 round-trip suites cover validation, transport, schema, and YAML.
- Offline, with no arena: `pixi run bridge` plus a still-fly UDP feed. With
  `constant 90 deg/s` and `gain 1.8` the frame index must sweep 50 indices/s even
  though heading never changes, and every frame must satisfy
  `idx == round(bias / gain) mod frames`.
- On an arena (still outstanding): Mode-3 pattern, 200 frames, `gain 1.8`, ball held
  still. `constant 90 deg/s` → one revolution per 4 s. `sine 90 deg/s @ 0.5 Hz` →
  smooth back-and-forth over `±28.6°` (≈ ±16 frames), **symmetric about the starting
  frame**. `square 90 deg/s @ 0.5 Hz` → constant-speed reversals over `±45°`
  (±25 frames). Confirm `stopClosedLoop` freezes the display and that the next
  condition restarts from phase 0.
