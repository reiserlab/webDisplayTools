---
name: protocol-yaml
description: Author or edit v3 protocol YAML files for the G6/G4 LED arenas (experiment protocols with conditions, trialParams, waits, blocks, variables/anchors, plugins). Use whenever writing a new protocol, adding/editing conditions, debugging "condition duration doesn't update" or "timeline looks wrong" complaints, choosing trial modes (2/3/4), sizing .pat patterns, or validating a protocol file. Triggers include "make a protocol", "new experiment YAML", "add a condition", "closed-loop condition", "why is this condition N seconds".
---

# v3 protocol YAML — authoring knowledge

Format home: this repo (parser `js/protocol-yaml-v3.js`, reference corpus
`tests/fixtures/v3_*.yaml`, executed by `js/arena-runner-g6.js` on the web and by
maDisplayTools in MATLAB). End-to-end repo workflow: `docs/protocol-pattern-workflow.md`.

## Skeleton

```yaml
version: 3
experiment_info:
  name: "looming_v1"
  date_created: "2026-07-05"
  author: "mreiser"
rig: "./configs/rigs/cshl_g6_2x10.yaml"
plugins: []                      # rig-provided; see Plugins below
variables:                       # optional — YAML anchors (define BEFORE first use)
  - &show_dur 4
experiment:                      # the run order: condition names and/or blocks
  - "baseline"
  - name: "main_block"
    trials: ["stim_a", "stim_b"]
    repetitions: 3
    intertrial: "blank"
conditions:
  - name: "stim_a"
    commands:
      - type: "controller"
        command_name: "trialParams"
        pattern: "G6_2x10_grating_20px"   # pattern FILENAME minus .pat (and minus any NNN_ prefix)
        pattern_ID: 2                      # SD-index fallback — keep it matching the card
        duration: *show_dur
        mode: 2
        frame_index: 0
        frame_rate: 5
        gain: 0
      - type: "wait"
        duration: *show_dur                # ← REQUIRED; see THE WAITS RULE
```

## THE WAITS RULE (the trap that costs sessions)

`trialParams` is **fire-and-forget**: it arms the controller and returns immediately —
it does NOT advance the protocol clock. Only `wait` commands do. Therefore:

- **Every `trialParams` with a duration needs a companion `wait` covering that
  duration** (usually equal). No wait → the condition ends instantly and the next
  command/condition fires while the display is still playing.
- A condition's wall-clock in the designer timeline = `max(trialParams.duration, Σ waits)`.
  Editing only ONE of the pair is **masked** by the other — "the timeline won't update"
  is almost always a half-edited pair, not a render bug.
- **Bind both fields to one anchor** (`duration: *show_dur` on both) so they can never
  drift — the `open_dur`/`cl_dur` pattern from `protocols/fictrac_direction_test`.
- Waits between two `trialParams` in one condition define how long the FIRST one
  actually shows (the second overrides it). Waits longer than the duration = intentional
  hold/blank; fine, but mean it.

## Trial modes

| mode | meaning | live fields | fixed |
|---|---|---|---|
| 2 | constant rate | `frame_rate` (Hz; **negative = reverse**, int16), `duration` | `gain: 0` |
| 3 | position / host-stepped | `frame_index` (start frame); frames driven by `setPositionX` or the **FicTrac closed loop** (web) | `frame_rate: 0`, `gain: 0` |
| 4 | analog closed-loop | `gain`, `frame_index` | `frame_rate: 0` (MATLAB/analog rig path) |

**Start position (`frame_index`):** most trials use `0` (the pattern's default start).
**Exception — stripe-fixation / object-orientation (open-loop) trials:** start with the
object *in front of* the fly, which is usually **not** frame 0. Where the object sits at a
given frame is baked into the pattern by a phase shift at design time, so the "front" frame
is a per-pattern property — e.g. a 200-frame stripe built so frame 0 = object *behind* the
fly and frame **100** = *directly in front* → set `frame_index: 100`. (On the 2×10 rig the
column over panel 8 is behind the fly; the opposite column is in front. Confirm the
azimuth↔frame mapping per pattern.) **Why this alignment:** patterns are phase-shifted so
frame 0/1 lands at the center of column 8 (behind the fly) — that makes the position index
map directly to azimuth, so recorded position data plots straight into a histogram with no
unwrapping needed in analysis. Keep the convention when building new fixation patterns.

`frame_index` is **0-based** (`0` = the first frame). `duration` is in **seconds** as a
**float** — fractional and sub-second are fine (`0.1`, `0.25`, `1.5`), preserved exactly
through parse/save; no whole-second quantization and no upper bound (60–300 s trials are
fine too). Caveat: the web runner is **host-timed** (`setTimeout`, ms resolution) until the
firmware enforces trial duration (FW#4), so it's soft real-time — very short trials
(≲ ~50 ms) and backgrounded tabs will jitter. `frame_rate` sets frame cadence on the
controller; `duration`/`wait` sets how long the host lets the trial run. (Note: a
MATLAB/G4 executor historically quantized duration to 0.1 s ticks — that's an executor
convention, not a YAML rule; confirm the target if a protocol will also run under MATLAB.)

**Optional `duty` (per-trial brightness, any mode):** `trialParams` accepts an optional
`duty: 0–255` — a per-trial brightness override for the whole pattern. **`0` (the default,
and the value sent when omitted) = use the pattern's own stored brightness** — so leave it
off unless you specifically want to dim/brighten this trial. Requires fw #33+. Web-only
(MATLAB ignores it). Distinct from `led_activation` (that gates the separate BuckPuck LED,
not the pattern brightness).

## FicTrac closed loop (Mode 3)

A closed-loop trial is a `trialParams` (mode 3) that loads the pattern + start frame,
then a `startClosedLoop` / `stopClosedLoop` pair around the `wait` that holds it — FicTrac
streams frames for the wait's duration. Declare a `fictrac` plugin. Shape:

```yaml
- name: "closed_loop_stim"
  commands:
    - type: "controller"
      command_name: "trialParams"
      pattern: "G6_2x10_grating_20px"
      pattern_ID: 2
      duration: *cl_dur
      mode: 3
      frame_index: 0
      frame_rate: 0        # mode 3: fixed 0
      gain: 0              # mode 3: fixed 0
    - type: "plugin"        # NOT "controller" — these are fictrac PLUGIN commands
      plugin_name: "fictrac"
      command_name: "startClosedLoop"
    - type: "wait"
      duration: *cl_dur    # FicTrac drives frames for this long (same anchor)
    - type: "plugin"
      plugin_name: "fictrac"
      command_name: "stopClosedLoop"
```

`startClosedLoop` / `stopClosedLoop` are **plugin** commands on the declared `fictrac`
plugin. Typing them as `controller` makes the runner skip them with a warning, so the
loop never opens and the trial silently runs open-loop.

**Coupling (Studio v0.85 / bridge 3.3).** `startClosedLoop` takes an optional `coupling`
(default `1`): the display turns `coupling ×` the fly's turn — `0.75`/`1.25` for a world
that under-/over-compensates, `-1` reversed, `0` = the display ignores the fly (pure bias
replay). The display pitch (°/frame) comes from the rig automatically; only set
`deg_per_frame` for a pattern that steps more than one pixel per frame. **`gain` is
retired** — the legacy `gain: ±1.8` still runs as coupling ±1 with a deprecation warning; any
other value is REFUSED with a migration message. Delete `gain`, and use `coupling` if you need ≠ 1.

### Bias / disturbance waveforms (LAB-185)

`startClosedLoop` takes three optional params that add a smooth disturbance to the
loop, so the display keeps moving even when the fly holds still (disturbance
rejection). Authored as an added rotational **velocity**:

```yaml
    - type: "plugin"
      plugin_name: "fictrac"
      command_name: "startClosedLoop"
      params:
        coupling: 1         # optional (default 1): the display follows the ball 1:1; 0.75 / 1.25 = less / more; -1 reversed; 0 = bias only
        bias_type: "sine"   # none | constant | sine | square
        bias_amplitude: 90  # PEAK velocity, deg/s — negate to reverse direction
        bias_frequency: 0.5 # Hz — sine/square only; ignored by constant
```

- `constant` drifts steadily; `sine`/`square` are **zero-mean in position**, so the
  display is pushed equally both ways and starts where it already was.
- Amplitude is a *velocity*, so the position excursion is derived and **shrinks as
  frequency rises**: `±A/(2πf)` for sine, `±A/(4f)` for square. At 90 deg/s a sine
  covers ±28.6° at 0.5 Hz but only ±14.3° at 1 Hz.
- `bias_frequency` **must be non-zero** for `sine`/`square` — 0 Hz fails the step.
  A negative frequency is a harmless no-op (warned): negate `bias_amplitude` instead.
- `stopClosedLoop` clears the bias automatically. Reference:
  `docs/development/closed-loop-bias.md`; worked example:
  `protocols/fictrac_bias_test.yaml`.

**Per-trial start position (`start_frame`, Studio v0.87 working tree).** Bridge 3.3 re-tares the
heading at every `startClosedLoop`, so a closed-loop trial always opens on frame 0. To open it on a
chosen frame (place learning: a fixed distance outside the safe zone, alternating sides), give
`startClosedLoop` `params: { start_frame: N }` (0-based, wraps mod n_frames; non-integer or
negative fails the step) AND set the trialParams `frame_index` to the same N so the display shows
it before the first FicTrac frame. Bind both to one anchor (`&start_frame_plus`) so they cannot
drift. The bridge turns it into `offset = N × pitch` for that epoch only.

```yaml
    - type: "plugin"
      plugin_name: "fictrac"
      command_name: "startClosedLoop"
      params:
        coupling: -1
        start_frame: *start_frame_plus
```

### Conditional LED activation (index-gated LED, Mode 3 only)

A Mode-3 `trialParams` may carry an optional **`led_activation`** attribute to drive
the BuckPuck LED **as a function of the live (displayed, post-bias) frame index**:
a baseline level plus **zones**, each with its own level and linear **ramp** edges
(host-side; the web runner watches each applied frame and re-sends the LED level when
it moves ≥ 4 mV, yielding to frame writes). It's an attribute ON the trialParams
command, NOT a separate command (Studio v0.86):

```yaml
- type: "controller"
  command_name: "trialParams"
  pattern: "closed_loop_grating"
  pattern_ID: 2
  duration: 30
  mode: 3
  frame_index: 0
  frame_rate: 0
  gain: 0
  led_activation:
    baseline: 2            # % outside every zone (default 0 = dark)
    zones:
      - level: 10          # % inside (fractional OK)
        ramp_in:  [40, 50]    # baseline at 40 → level at 50  (a == b: hard edge)
        ramp_out: [100, 110]  # level at 100 → baseline at 110 (c == d: hard edge)
      - level: 5
        ramp_in:  190         # one index ≡ [190, 190]; this zone WRAPS through frame 0
        ramp_out: [5, 5]
```

- Indices are **0-based** (same as `frame_index`/`setPositionX`); a zone occupies `[a, d)`
  (`d` is the first baseline frame); zones may wrap; overlapping zones → brighter wins.
- **Legacy sugar still works:** `level: 20` + `on_ranges: [[50, 99]]` (inclusive) ≡ a
  hard-edged zone `{level: 20, ramp_in: [50, 50], ramp_out: [100, 100]}`.
- **`hysteresis` is accepted, warned, IGNORED** since v0.86 — delete it; ramps of a few
  frames are the anti-chatter. Levels below 1 % snap to 1 % (driver dead zone).
- Omit `led_activation` for no LED drive. **Mode 3 only** (Mode 4 computes frames on the
  controller; the host can't follow it). Web-only — MATLAB does not read it. Full
  reference: `docs/development/conditional-led-activation.md`.

## Other controller commands

`allOn`, `allOff`, `stopDisplay`, `setPositionX` (Mode-3 frame jump), and the **G6-only**
`setAnalogOut` / `setDigitalOut`. The I/O commands take these exact fields (units matter):

```yaml
    - type: "controller"
      command_name: "setAnalogOut"
      mv: 2500              # MILLIVOLTS (0–5000 = 0–5 V); 0 to clear
    - type: "controller"
      command_name: "setDigitalOut"
      channel: 1            # 1-based — matches the board BNC silkscreen "Digital IO 1/2"
      state: 1             # 0 or 1 (int, not true/false)
```

These are instantaneous (like plugin commands) — they don't advance the clock. G6-only:
on non-G6 hardware they're rejected by the controller. A common pattern is a
`setDigitalOut … state: 1` before a trial and a `state: 0` after (in a trailing `wait`
window — that's a legitimate "waits exceed display" case).

## Full block example

A sequence entry is either a bare condition name or a block (define referenced conditions
in `conditions:`):

```yaml
experiment:
  - "baseline"                       # bare reference
  - name: "main_block"
    trials: ["stim_a", "stim_b"]     # array of condition names, run in order
    repetitions: 3                   # whole block repeats 3×
    intertrial: "blank"              # a condition run between trials (optional)
  - "shutdown"
```

## Patterns (made in the web Pattern Designer — only sizing/naming matters here)

- Reference by **filename minus `.pat`**; SD copies with `001_`-style prefixes still match.
  Keep the arena prefix in filenames (`G6_2x10_…`). Same name ⇒ assumed same content —
  never reuse a name for a different pattern; bump `_v2`.
- Colocation is the protocol↔set link: `protocols/<bench>/<name>_patterns/` next to
  `<name>.yaml`. Reusable patterns live in the repo-level `patterns/` shared library.
- Size math (G6 2×10, 20 panels): **GS2 ≈ 1.07 KB/frame, GS16 ≈ 4.07 KB/frame** + 17-byte
  header. A 200-frame GS16 pattern ≈ 0.8 MB — fine for the SD; uploads run a few seconds
  per MB. Gratings only need one spatial period of frames (playback wraps); wavelengths
  must divide the total azimuth pixels (200 for G6 2×10).
- Fresh patterns are direction-correct end-to-end (Designer CW = arena CW, verified
  2026-07-05); legacy `.pat` files may have baked-in reversed motion — regenerate rather
  than debug.

## Variables / anchors

YAML aliases must appear **after** their anchor textually — put `variables:` above
`conditions:`. Use anchors for anything two fields must agree on (the waits rule) and
anything a colleague will want to tweak (durations, gains). The Studio's Variables panel
edits them with rename-cascade; hand-edits are fine too.

### Runtime variables (operator-adjustable DURING a run — Studio v0.84)

Expose a variable to the rig operator by declaring it under `runtime_controls:` (only these
can change; everything else stays fixed). The Studio's Run view shows them in a "Runtime
variables" panel; **Apply** validates against the bounds and the change takes effect at the
**next trial boundary**, logged with operator/reason/old→new; the YAML is never rewritten.
The first use is opto LED intensity (`protocols/opto_intensity_runtime_test.yaml`):

```yaml
variables:
  opto_pct: &opto_pct 10        # the default = the value at run start
  pulse_s:  &pulse_s 5

runtime_controls:               # top level, after variables:
  opto_pct: {type: number, units: percent, minimum: 0, maximum: 100, label: "Opto LED intensity"}
  pulse_s:  {type: integer, units: s, minimum: 1, maximum: 20}
# types: number | integer | boolean | enum (values: [a, b]); number/integer need minimum+maximum
```

Bind them with ordinary aliases **inside command parameters** (`percent: *opto_pct`,
`duration: *pulse_s`, `led_activation: {level: *opto_pct, …}`). A control aliased anywhere
else — a `pattern`, a `command_name`, a block `repetitions` — is a validation error: runtime
changes may tune a trial, never restructure it. Web-only; MATLAB ignores `runtime_controls`.

### `requires:` — capabilities the runner must have

`requires: [flow_control]` marks a protocol that uses the trial-check / repeat-until constructs
(`docs/development/v3-flow-control-design.md`). The Studio opens it for editing but **refuses
to run it** until the web runner implements that capability; MATLAB may run it. Leave it out
otherwise.

## Plugins

`plugins:` normally comes from the rig (the Studio pre-fills New protocols from the rig
YAML; CSHL course rigs declare none). The **web runner executes only `fictrac` and `log`**
— `backlight`/`camera`/`temperature` are declared for MATLAB and skipped on the web.
FicTrac closed loop = a `fictrac` plugin + a Mode-3 condition.

## Validate before shipping

From the repo root (checks parse, references, blocking errors, export warnings, AND the
waits rule):

```bash
~/.pixi/bin/pixi run node --import ./tests/vendor-yaml.register.mjs \
    .claude/skills/protocol-yaml/bin/validate-protocol.mjs path/to/protocol.yaml
```

Exit 0 = clean (warnings printed), exit 1 = blocking. Cross-check the corpus in
`tests/fixtures/v3_*.yaml` for canonical shapes (`v3_g6_2x10_smoke.yaml` exercises every
G6 command; `v3_fictrac_closed_loop.yaml` shows Mode-3 closed loop). In the Studio, the
Editor's W/C chips and the Run view's pattern preflight are the live checks.
