# Course Analysis Dashboard — Plan

**Status:** Concept/data-contract plan, not implemented. Written alongside
`oscilloscope-view-spec.md` so the live scope and offline dashboard converge on the
same signals and event vocabulary.

## 1. Purpose

Build a student-facing dashboard for CSHL course runlogs that parses experiment
structure from protocol YAML plus a small per-protocol `analysis.yaml`, without
requiring every condition to be pre-registered in application code.

The dashboard should make one run easy to inspect, then let instructors aggregate
runs by genotype, protocol, bench, or manually defined groups. It should use the same
kinematic channels and event overlays as the live oscilloscope in Arena Studio.

## 2. Core principles

- One runlog is one animal/session. A fly may have multiple runlogs, but runs are
  kept separate unless explicitly grouped.
- Protocol YAML is the execution recipe and should stay clean.
- A separate `analysis.yaml` in each protocol directory is the interpretation recipe:
  condition pairing, folding conventions, coordinate conventions, and event extraction
  hints.
- Aggregate trials within run first, then aggregate runs. Never pool all trial samples
  directly across runs by default.
- The dashboard must surface acquisition/configuration failures, such as a closed-loop
  bridge `frames` modulus that does not match the loaded pattern frame count.

## 3. Required run metadata

Extend run metadata collection so each run can carry:

- `run_id`
- `animal_id` or `fly_number`
- `genotype`
- `sex`
- `age`
- `experimenter`
- `bench` / rig id
- `protocol_filename` and protocol hash
- `date/time`
- free-text notes

The dashboard should allow missing metadata, but display a QC warning and make it
easy to filter/fix run identity fields.

## 4. Data inputs

- Bridge JSONL runlog: authoritative sample/event source.
- Protocol YAML: trial order, commands, pattern names, plugin commands, durations.
- Pattern manifest / parsed pattern metadata: pattern frame counts and display geometry.
- Protocol-local `analysis.yaml`: semantic pairing/folding conventions.
- Optional rig metadata: ball diameter/radius, arena alignment, front/back convention.

## 5. Normalized data model

### Runs

One row per runlog/session:

```text
run_id, animal_id, genotype, sex, age, experimenter, bench, protocol, protocol_sha, start_time
```

### Trials

One row per Runner step/condition:

```text
run_id, step_index, condition, block, repetition, start_ms, end_ms, duration_s,
pattern, pattern_ID, mode, frameRate, gain, initPos, plugin_commands
```

### Samples

Time series derived from FicTrac fields and shared with the live scope:

```text
run_id, step_index, t_ms, t_trial_s, heading_deg, turning_deg_s, forward_mm_s,
forward_rad_s, frame_index, x_rad, y_rad
```

### Events / epochs

Interval table for overlays and opto alignment:

```text
run_id, step_index, epoch_type, label, start_ms, end_ms, params
```

Required epoch types:

- `condition`
- `visual_stimulus`
- `opto_stimulus`
- `closed_loop_active`

## 6. Shared kinematic contract

The dashboard and live oscilloscope MUST use the same derivation code and defaults.
**As built (Arena Studio v0.15, 2026-07-07) that code is [`js/kinematics.js`](../../js/kinematics.js)**
— the dashboard imports the same module; do not fork the math.

- Input = the **`behavior_v1`** compact state `[ms, fc, idx, ft, x, y, hd]` (bridge
  WS frame + logged row; issue #140 comment 4900650706, the default level — `full`
  25-column logging is a File ▾ → Run logging opt-in). `x`/`y` = integrated
  lab-frame position (cols 15/16, rad); `hd` = integrated heading (col 17, rad);
  `ft` = FicTrac timestamp (col 22) as relative ms — the derivative time base.
- Turning velocity: OLS slope (live) / central difference (offline) of **unwrapped
  heading**, → deg/s.
- Forward velocity: **project dx/dy onto heading** — `forward = (dx·cos h + dy·sin h)/dt`
  (rad/s), × ball radius ⇒ mm/s when known (else retain rad/s, mark calibration
  missing). Side velocity = `-dx·sin h + dy·cos h`. This REPLACES the earlier
  "col-19 integrated forward motion" idea; timing uses `ft` (col 22), **never** col-24
  `dt` (unrecoverable across a skipped frame — Frank, #143).
- Offline default derivative = **central differences** (`Kinematics.centralDiff`):
  `dt_s=(ft[i+1]-ft[i-1])/1000`, `dx=x[i+1]-x[i-1]`, etc.; edges left undefined.
  Live smoothed trace = **windowed OLS** (`Kinematics.windowedDerived`), default
  0.25 s window, stamped at the window center.
- Default output grid: 10 Hz for the scope; the dashboard may also derive at
  native/sample-aligned resolution but must use the same functions for comparable views.
- Scope and dashboard use identical channel colors, units, and row order.
- Fixture tests with known slopes: `tests/test-kinematics.js` (keep both clients honest).

## 7. Protocol families

### Optomotor plus looming

Open-loop visual response protocol.

Views:

- Single trial traces: turning, forward velocity, heading, visual/opto overlays.
- Single-run condition averages: pale trials plus run mean.
- Folded/unfolded open-loop response by condition.
- Tuning curves generated dynamically from varying numeric parameters.
- Looming time-series plots with behavior and stimulus time course on aligned axes.

Conventions:

- Optomotor folding can use `sign(frameRate)` when the analysis config declares that
  the pattern's direction convention is valid.
- Looming folding: turn away from the looming object is positive.
- Looming x-axis is usually time; tuning/grouping variables include `r_over_v`, polarity,
  stimulus type, and azimuth/side.

### Object sweep with closed loop

Object motion and closed-loop object fixation/tracking.

Views:

- Object sweep time series, keeping CW positive and CCW negative.
- Per-condition and per-run averages, with optional aggregate across runs.
- Closed-loop time series: heading, commanded frame index, predicted frame index, turning,
  forward velocity.
- Closed-loop histograms only when the bridge frame modulus matches pattern frames.

Conventions:

- Object sweep sign: CW positive, CCW negative. Do not fold toward/away by default.
- Closed-loop pattern has object fixed in the pattern: frame 0 = behind, frame 100 = front,
  200 frames around the arena.
- Display histogram as arena angle with 0 deg directly in front, positive to the fly's
  right, negative to the fly's left.

### Optogenetic walking observation

Basic behavioral response to optogenetic stimulation, possibly embedded in other protocols.

Views:

- Forward velocity and turning velocity aligned to opto on/off.
- Pre/during/post summaries.
- Single-run traces and grouped genotype summaries.

Conventions:

- Opto epochs are inferred from logged commands, not from whole trial duration. A trial may
  last 5 s while opto is active for only 0.5 s.

## 8. Dynamic tuning curve builder

The dashboard should propose tuning curves by inspecting protocol/YAML-derived trial
parameters and `analysis.yaml` hints.

Default selection rules:

- Candidate x-axis: numeric parameters with more than one unique value.
- Preferred x-axis order: `speed_abs`, `frameRate_abs`, `temporal_frequency`,
  `spatial_frequency`, `r_over_v`, `azimuth_deg`, then other numeric params.
- Series/grouping: remaining varying categorical fields, unless hidden by the user.
- Point value: mean turning velocity over the full trial by default.
- Aggregation: average repeats within run, then average runs.
- Show individual run means as optional overlays.

## 9. `analysis.yaml` template

Keep this sparse and protocol-local. Example:

```yaml
analysis_contract_version: 1
protocol_family: optomotor_looming

metadata_required:
  - fly_number
  - genotype
  - sex
  - age
  - experimenter
  - bench

kinematics:
  velocity_window_s: 0.25
  ball_radius_mm: null

epochs:
  visual:
    infer_from: trialParams
  opto:
    infer_from_commands: [LED_AO_drive, setAnalogOut]

folding:
  optomotor:
    sign_field: frameRate
    response: turning_deg_s
  looming:
    side_field: azimuth_deg
    positive_response: turn_away
    pair_by: [r_over_v, polarity, stimulus_type]

closed_loop:
  frames: 200
  behind_frame: 0
  front_frame: 100
  angle_zero: front
  positive_angle: right
```

## 10. First implementation slice

Build the first dashboard against current bench02 data plus one corrected/synthetic
closed-loop run.

Minimum useful feature set:

- Load one or more JSONL runlogs.
- Parse protocol YAML and pattern manifest.
- Build run/trial/sample/event tables.
- Show run QC and metadata completeness.
- Plot open-loop single-trial traces and folded/unfolded condition averages.
- Build one dynamic tuning curve from detected parameters.
- Show closed-loop command/heading diagnostic and block invalid fixation histograms when
  `bridge.frames != pattern.frames`.
- Plot opto-aligned forward and turning traces when opto events are present.

## 11. Student/instructor UX

Default mode is guided and student-facing: run QC, trial explorer, open-loop plots,
closed-loop plots, opto plots.

Instructor controls should allow:

- grouping by genotype, protocol, bench, sex, age, or manual run selection;
- toggling individual run means;
- changing response metric and analysis window;
- exporting plots and per-run/aggregate summary tables.
