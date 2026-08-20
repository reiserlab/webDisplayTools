# Closed-loop bias waveforms (LAB-185)

**Status: bench-validated on arena hardware (2026-08-04, and again 2026-08-12 on a
20-frame pattern — see "The frame modulus is load-bearing").** A full 8-condition run of
`protocols/fictrac_bias_test.yaml` drove a real G6 controller (32,499
`SET_FRAME_POSITION` commands) and the log reproduces
`round((heading + bias)/gain) mod 200` for all 328,733 frame rows — 4 mismatches
(0.0012%), all ±1 frame from millisecond rounding. `constant 90 deg/s` measured
50.0 frames/s = 90.0 deg/s = one revolution per 4.00 s; every waveform's amplitude
matched prediction exactly; `b(0) = 0` at all 16 epoch onsets. The rotation direction
was confirmed by eye (see below).

Still untested: an actual **behaving-fly experiment** (the validation run used a moving
ball, but nothing depended on the fly's behaviour). Web-only — MATLAB has no
`FicTracPlugin` (its closed loop is analog Mode 4, computed on the controller, where
the host cannot inject anything).

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

### Practical Amplitude and Frequency Limits
The practical limits of amplitude, `A`, and frequency, `ω`, in an experiment are determined by their ratio, `(A/ω)`, because of how the bias angle is calculated. For example, on a 10-column G6 arena, any `(A/ω)<1.8` fails to produce any visible motion since one LED pixel subtends `360°/200 LED = 1.8°/LED`. As a result, the Amplitude in degrees/s must be at least 1.8 times larger than the frequency in rad/s, `(A/ω)>1.8` or 11.3 times larger than the frequency in Hz, `(A/f)>11.3`.
As a general rule of thumb, we don't recommend using bias waveforms with frequency higher than 3 Hz. However, that limit can be extended if coupled with higher amplitude values according to our recommendations below. 

**Suggested Amplitude and Frequency values**
Below are a table of suggested values and limits for amplitude, in degrees/s, and frequency, in Hz.
The `(A/f)` ratio values in this table are calculated for sine wave bias waveforms because they have stricter limits. These values are slightly conservative for triangle waves, which have an absolute minimum, on-pixel bias value of `(A/f)>7.2`. 

| `(A/f)` Ratio | Physical description on 10-column G6 arena |
| --- | --- | 
| 11.3 | **Absolute minimum on 10-column G6 Arena** `(A/ω)=1.8°` or one LED |
| 56.5 | Practical minimum, `(A/ω)=9°`, 18° pp  or one column |
| 189 | Typical value, `(A/ω)=30°`, 60° pp|
| 565 | Hemispherical, `(A/ω)=90°`, 180° pp|
| 1130 | Likely absolute maximum, `(A/ω)=180°`, 360° pp|

### Direction, and the sign of `gain`

The bias angle is summed in the same **heading-equivalent degrees** space as the
existing `offset`:

```
rel     = wrap180(heading_deg - hd0_deg)          # turn since the epoch's tare
idx     = round((rel + offset + b(t)) / gain) mod n_frames
```

So a positive `bias_amplitude` moves the display the same direction as increasing fly
heading, and a **negative `gain` reverses the bias along with the fly coupling**.

### On-arena direction (confirmed by eye, 2026-08-04)

With a **positive `gain`** (the normal 1.8) on the fly-on-ball rig:

| `bias_amplitude` | Viewed from above | From the fly's point of view |
| --- | --- | --- |
| **positive** | **clockwise** | pattern sweeps **rightward** across the visual field |
| **negative** | counter-clockwise | pattern sweeps leftward |

Both descriptions agree on this rig geometry, so either phrasing is safe to use.

**This is the sign an analysis must assume.** Get it backwards and an apparent
disturbance-rejection response inverts: a fly correctly counter-turning against a
clockwise disturbance would read as following it. Note the qualifier — a negative
`gain` flips the table, because the bias is divided by `gain` along with the heading.

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

## The heading tare

FicTrac's integrated heading is **absolute** (and wraps 0–360°). Without a tare, the
first frame of a closed-loop epoch lands at `round(heading/gain)` — an essentially
arbitrary index. On the bench that looked like: the pattern loads centred in front of
the fly (`frame_index: 0`), then **jumps somewhere else on the very first FicTrac
frame**, possibly out of the fly's field of view.

Measured on the bench03 field logs (12 runs, 7 epochs each): a median jump of
**55–156 frames, up to 189 of 200 = 340° of azimuth** on a full-azimuth pattern, and
up to the whole pattern (19 of 20 frames) on a short tiled grating.

So every epoch **re-zeros the heading**. `hd0` is latched from the **first frame after
the epoch opens** — a config message can't sample a heading that hasn't arrived yet,
and the last-seen one may be stale. The epoch therefore opens at index 0, i.e. wherever
`frame_index` put it for the usual `frame_index: 0`, and moves relative to that:

- The fly's turn **since onset** drives the display, not its absolute heading.
- `offset` still applies on top, so it can deliberately place the start elsewhere
  (`offset = 90` at `gain 1.8` starts 50 frames round).
- **A bias epoch is the trigger.** Any `config` carrying `bias` re-tares — and the
  runner always sends one on `startClosedLoop` (self-describing epochs), so *every*
  condition tares, including a `bias_type: none` baseline.

The tared difference is wrapped into `(-180, 180]` so it reads as a true relative turn:
a fly tared at 350° that turns +20° reads 10° absolute, which naively is −340°. Those
differ by 360° = `360/gain` frames, which only aliases away when the pattern spans the
full azimuth — the wrap keeps the nearest-angle reading correct for **short tiled
patterns** too. Only the heading is wrapped; `bias_deg` stays unbounded so a constant
disturbance keeps rotating.

**Scope of the change:** the tare is armed by epochs only, *not* at bridge startup, so
the plain Console closed loop (no protocol, no bias key) still maps absolute heading
exactly as it always did. That path keeps the old jump; a protocol is what fixes it.

### `frame_index` other than 0

The tare zeroes to index **0**, not to the trialParams `frame_index`. With
`frame_index: 50` the pattern loads at 50 and the loop still moves it to 0 on the first
frame. Use `offset = frame_index × gain` to line them up (`50 × 1.8 = 90`). Pushing the
start index through to the bridge would remove the need for that, and is the obvious
follow-up if anyone authors a non-zero `frame_index` closed-loop condition.

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

## The frame modulus is load-bearing (bench, 2026-08-12)

The bridge wraps every index it computes with `% n_frames`, so **the loaded pattern's
frame count must reach the bridge or the closed loop streams frames that do not
exist.** The firmware is strict: `handleSetFramePosition` rejects
`index >= frame_count_` with `showError(CE_BAD_PARAM)`, which paints the error glyph
over the arena for `error_display_hold_ms`.

Found by Isabel with a **20-frame grating** (SD pat 5) where the validated protocol
had used the **200-frame** `frame2_h_ccw_200f`:

- The runner pushed no `frames`, so the bridge kept its `--frames` **default of 200**.
- A `constant 90 deg/s` bias swept the index 0→199 every 4 s against a 20-frame
  pattern. **1553 of 1705 commands (91%) came back status 1** — `showError` firing
  ~45×/s, i.e. a flickering error glyph with the real grating flashing through during
  the 9% of each sweep that was in range.
- Afterwards the arena stopped responding to Console `allOn`/`allOff` until a power
  cycle. **Cause unconfirmed.** One candidate: `SerialManager` holds **one** response
  slot and `flushResponses()` silently keeps it queued when the USB CDC TX buffer is
  full, so ~1500 41-byte error payloads (vs. the usual 3-byte ack) could overrun it and
  drop replies, desyncing the host's request↔response pairing. Not reproduced, and
  beware: a **blocked** command queue looks identical from the bench — a single
  `sendBulkRead` (the Console picker's preview fetch) holds `ArenaLink`'s serialized
  queue for up to 60 s while the UI keeps logging clicks as `›` sent. Isabel hit that
  separately on 2026-08-12 and recovered with Disconnect → Connect. **Before assuming
  the controller is wedged, check whether something is merely holding the queue.**

Note the *bias* was blameless — it just made the index sweep the whole modulus, which
a still fly never does. Any Mode-3 pattern shorter than 200 frames was exposed; the
200-frame validation pattern hid it by accidentally matching the bridge's default.

**A short pattern is not a bug.** A 20-px-period grating only needs 20 frames: with
`gain 1.8` (1 frame = 1 px = 1.8°) the modulus tiles it around the full azimuth. Keep
`gain = 360 / azimuth_pixels` and let the frame count be the modulus — don't rescale
`gain` to the frame count.

### How the count is resolved now

`ArenaRunner._resolveFrameModulus(acc)`, in order:

1. `resolvePatternFrames(cmd)` — the host hook. In the Studio this reads a `.pat`
   header the page already parsed, which in practice means **only** the pattern whose
   Console thumbnail was rendered (`Studio.onSdListing` builds every entry with
   `preview: null`; the card lists filenames, not frame counts). A fast path, never a
   guarantee — this is what returned `null` for pat 5.
2. **`GET_PATTERN_INFO` (0x88)** against the controller, which reports the
   authoritative `frameCount` for any 1-based SD index. Same query the Console's
   Mode-3 *Load* already does to bound its stepper. Cached per pattern index per run.

If neither answers, `startClosedLoop` **fails the step** and never calls
`setApply(true)` — the `duty`/bias precedent, and far better than 30 s of rejected
frames. As a second line of defence `FicTracBridgeClient` now defaults `clampFrame` to
wrap on the count it last pushed (`_clampToFrames`), which covers a config message
that never landed.

**When adding any new closed-loop entry point, resolve the modulus the same way** —
never let the bridge's default stand in for a real frame count.

### Bench-validated on a short pattern (2026-08-12)

The full 8-condition sweep re-run on the **20-frame grating** that first broke,
`runlogs/bench03/fictrac-closed-loop-bias-disturbance-grating__isabel__2026-08-12T17-16-07`:

- Every `config` push carries `"frames":20`, and **all 66,569 arena commands returned
  status 0** — zero rejections, down from 91%.
- All 68,638 `behavior_v1` rows reproduce
  `round((heading_deg + offset + b(t)) / gain) mod 20`, with **12 mismatches
  (0.0175%), every one ±1 frame** — the same millisecond-rounding signature as the
  200-frame validation. The rate tracks how much time a waveform spends at full
  speed (square 0.047% > constant 0.012% > sine 0.008% > none 0%), i.e. how often a
  1 ms timestamp discrepancy lands on a rounding boundary.
- All 16 epochs satisfy `b(0) = 0`, and every measured excursion matches the closed
  form exactly: constant ±90 → 2700° drift over 30 s; sine 90 @ 0.5/1 Hz → ±28.6°/
  ±14.3°; sine 30 @ 0.5 Hz → ±9.5°; square 90 @ 0.5/1 Hz → ±45.0°/±22.5°.

**Caveat for analysis on a periodic pattern.** A 20-frame, 20-px grating repeats every
36° of azimuth, so several of these excursions exceed one period (sine 90 @ 0.5 Hz
spans 1.6 periods; square 90 @ 0.5 Hz, 2.5). The *display* is therefore spatially
ambiguous beyond 36° — you cannot recover absolute pattern position from what the fly
saw. `b(t)` itself stays exactly reconstructable (it is analytic), so velocity-based
disturbance-rejection analysis is unaffected; position-referenced analysis needs a
non-repeating pattern.

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

Three records land in the run log:

- The raw `config` message, via the existing inbound logging (`rx_ms`, absolute).
- A bridge-authored `bias_config` event whose **`ms` is in the same relative timebase
  as the `behavior_v1` rows**.
- A bridge-authored `heading_tare` event, written when the tare latches on the epoch's
  first frame, in the same relative timebase:

```json
{"type":"bias_config","dir":"bridge","ms":4099,"bias":{"type":"sine","amplitude":90.0,"frequency":0.5}}
{"type":"heading_tare","dir":"bridge","ms":4107,"hd0_deg":137.25}
```

Together those make the whole mapping exactly reconstructable offline. For any logged
row at `ms`, take the latest `bias_config` and the latest `heading_tare` at or before
it, then:

```python
b   = bias_angle_deg(spec.type, spec.amplitude, spec.frequency, (ms - bias_ms) / 1000)
rel = ((hd_deg - hd0_deg + 180) % 360) - 180
idx = round((rel + offset + b) / gain) % n_frames
```

Because the waveform is analytic and deterministic, this recovers the exact value the
bridge used — no per-frame bias column is needed.

**`heading_tare` is not optional for analysis.** Omit it and every recomputed index is
off by `round(hd0/gain)` frames — up to 189 of 200 on the bench03 logs. (It is also
derivable as the `hd` of the first row at or after the epoch's `bias_config.ms`, but
the explicit event is what the bridge actually used, including across a dropped frame.)

**`BEHAVIOR_V1_COLS` was deliberately NOT widened.** The positional row format is
consumed by `js/runlog-replay.js` and the offline dashboard's vendored parser;
adding an eighth column would break every positional reader. A test asserts the rows
stay 7 wide.

`js/runlog-replay.js` surfaces each epoch as a **status event** with
`status.phase === 'bias_config'` and the spec on `status.bias`, so it flows through
`buildTimeline` like any other status item and every existing
`status.phase === '…'` consumer ignores it rather than breaking. Filter for that phase
to get the epoch list for reconstruction:

```js
const epochs = parsed.events
    .filter((e) => e.status && e.status.phase === 'bias_config')
    .map((e) => ({ ms: e.ms, bias: e.status.bias }));
const tares = parsed.events
    .filter((e) => e.status && e.status.phase === 'heading_tare')
    .map((e) => ({ ms: e.ms, hd0_deg: e.status.hd0_deg }));
```

Note the epoch `ms` is only used verbatim when the log carries its usual epoch-stamped
`logging_started` anchor (which tells the parser the origin is wall-clock). A
hand-written fixture without that anchor gets rebased against its own first record.

The live WebSocket frame message *does* carry a `bias` field (the current angle, deg)
when a bias is active. That is additive — unknown fields are ignored by older clients
— and exists only to drive the Studio's read-only readout.

## Where it lives

| Layer | File | What it owns |
| --- | --- | --- |
| Math | `fictrac-bridge/bridge.py` | `bias_angle_deg()` (pure), `BIAS_TYPES`, the `bias_deg` argument to `frame_index_from_fictrac()` |
| Heading tare | `fictrac-bridge/bridge.py` | `hd0` + `_tare_pending` on `Pipeline`, armed by `set_bias(tare=True)`, latched in `handle_line`, logged as `heading_tare` |
| Clock + logging | `fictrac-bridge/bridge.py` | `Pipeline.set_bias()` / `bias_now_deg()`, `LogWriter.write_event()`, the `config` dispatch, `--bias-type/--bias-amplitude/--bias-freq` |
| Transport | `js/fictrac-bridge-client.js` | `bias` as the one object-valued config key; `setBias()`, the `'bias'` event, `biasAngleDeg`; the default index clamp `_clampToFrames()` |
| Schema | `js/plugin-registry.js` | the three `startClosedLoop` params |
| Validation | `js/arena-runner-g6.js` | `normalizeBias()` → `{bias, warning}`; the `fictracApply` IR and its `_runIR` push |
| Frame modulus | `js/arena-runner-g6.js` | `_resolveFrameModulus()` — host hook, else 0x88, else fail the step |
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
- On an arena — **done 2026-08-04**, and the recipe to repeat it: run
  `protocols/fictrac_bias_test.yaml` with the bridge logging, then check the exported
  log with the reconstruction above. `constant 90 deg/s` → one revolution per 4 s;
  `sine 90 deg/s @ 0.5 Hz` → `±28.6°` (≈ ±16 frames) symmetric about the starting
  frame; `square 90 deg/s @ 0.5 Hz` → `±45°` reversals. The log check subsumes the
  "ball held still" version of this test, because it validates against the *logged*
  per-frame heading rather than assuming a constant one.
- **Direction, by eye** — the one thing no log can prove, since it depends on the
  pattern and panel wiring rather than on this code. Immobilise the ball, run a single
  `constant +90 deg/s` trial, and confirm the pattern turns clockwise. Re-check after
  any change to arena wiring, panel numbering, or the pattern's own direction.
- **Trial duration vs frequency:** keep `cl_dur` an integer number of bias cycles or
  the periodic waveforms carry a small DC term over the trial. At the committed
  `cl_dur: 30` both 0.5 Hz (15 cycles) and 1 Hz (30 cycles) are exact; a 15 s trial at
  0.5 Hz is 7.5 cycles and leaves ≈4% of peak as a net offset (they still *end* at
  `b = 0`, so there is no jump at `stopClosedLoop`).
