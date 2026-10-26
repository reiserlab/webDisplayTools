# Protocol v3 YAML — Spec by Example

This document describes the **Protocol v3** YAML format as implemented in
maDisplayTools at the pinned commit below. It is the JS-side reference for
the v3 Experiment Designer (`experiment_designer_v3.html`).

**Authority (decision 2026-10-26, `rig-software-repos-and-runners.md`):** the protocol language is
defined by this spec plus the language-neutral conformance fixtures exported from the JS runner's
tests; the two live runners (web, Python headless) must both pass them. Until the fixtures cover flow
control, MATLAB `origin/version3` (`ProtocolParser.m`, `CriterionEvaluator.m`) remains the reference
for `requires: [flow_control]` only. Historically this doc deferred to the MATLAB parser for
everything; the MATLAB YAML runner is now G4.1-only and frozen (see "Runner compatibility" below).

---

## Pinned upstream version

- Repo: `reiserlab/maDisplayTools`
- Branch: `origin/version3`
- Commit SHA: **`649d7efd…`** (`649d7ef`, captured 2026-05-27)
- Previous pin: `00c8f95` (2026-05-23) — bumped after Lisa added docs +
  full-experiment example on 2026-05-26.

The reference YAMLs from this commit are committed verbatim in this repo as:

- `tests/fixtures/v3_canonical_a.yaml` ← `examples/yamls/experimentExampleVersion3.yaml`
- `tests/fixtures/v3_canonical_b.yaml` ← `examples/yamls/version3Attempt.yaml`
- `tests/fixtures/v3_full_experiment.yaml` ← `examples/yamls/full_experiment_test_v3.yaml`
  (Lisa's port of the v2 test experiment to v3; **three syntactic typos in the
  upstream file were fixed locally** — missing `commands:` key on the
  `start recording` condition, indent slip on a `wait`, missing close-quote on a
  `type: "controller` — pending a fix push upstream)

**These files plus Lisa's documentation were the spec until 2026-10-26** and remain the historical
reference the fixtures were derived from; the normative statement is the "Authority" paragraph at the
top of this file. The v3 parser exists to round-trip them; the designer exists to view and edit data
they could represent. Run `tests/refresh-v3-canonical.sh` to re-fetch them at a newer SHA;
any `git diff` output is a signal the spec drifted upstream.

### Authoritative spec docs (upstream)

- **`docs/development/yaml_protocol_documentation_v3.md`** on `origin/version3`
  (added by Lisa in `3e1eb63`, 2026-05-26). This is the human-readable spec for
  the v3 YAML format — three-tier config (arena/rig/experiment), all command
  types, plugin catalog, validation checklist. Historical reference: where it
  and this file disagree on a format detail that no fixture covers, raise it
  and add a fixture rather than defer silently. This file documents
  designer-specific concerns (round-trip strategy, designer constraints) and
  the JS-side parser contract.

### Spec details added by Lisa's documentation (2026-05-26)

These are documented upstream but were not surfaced in the original `00c8f95`
canonical examples; the designer should expect them eventually:

- **`DAQThermometerPlugin`** — third built-in class plugin alongside
  `BiasPlugin` and `LEDControllerPlugin`. Commands: `startContinuousLogging`,
  `stopContinuousLogging` (added in `dfbfd0b`), `get_temperature`,
  `log_temperature`. Config fields: `device_id`, `channels`,
  `thermocouple_type`, `sample_rate`, `sample_duration`, `generate_plots`.
- **Built-in `log` plugin** — `plugin_name: "log"`, `command_name: "log"`,
  params `{message, level}` where `level ∈ {DEBUG, INFO, WARNING, ERROR}`. Not
  declared in `plugins:`; treated as always-available.
- **Anchor as `command_name`** — a plugin command's `command_name:` field may
  be set via `*alias` (e.g. variables `&led_command "setRedLEDPower"` →
  `command_name: *led_command`). The editor's anchor-binding UI must support
  enum-style command-name fields, not just numeric/string scalars.
- **Negative `frame_rate`** — explicit: a negative value on `trialParams`
  plays the pattern in reverse.
- **`pattern_ID` auto-update at SD-card prep** — `pattern_ID` is rewritten
  during deployment to match SD slot, so its value in source YAML is
  informational. Author hint: use a `*var` so the value is in one place.

### MATLAB-side validation (manual flow)

The maDisplayTools v3 `ProtocolParser.m` calls `yaml.loadFile`, which lives in
the third-party [MartinKoch123/yaml](https://github.com/MartinKoch123/yaml)
library (NOT MATLAB base; NOT Text Analytics Toolbox). To validate a v3 YAML
against the upstream parser locally:

```matlab
% One-time setup (clone the YAML library and add it to the path):
%   git clone https://github.com/MartinKoch123/yaml.git /tmp/matlab-yaml-namespaced
addpath('/tmp/matlab-yaml-namespaced');
addpath(genpath('/path/to/maDisplayTools'));  % must be on origin/version3
parser = ProtocolParser();
result = parser.parse('tests/fixtures/v3_canonical_a.yaml');
```

The canonical fixtures use absolute paths pinned to a single developer's
machine. For portable MATLAB validation, use the rig-path-normalized copies in
`tests/fixtures/matlab_normalized/` (rewritten to the user's local
`maDisplayTools` checkout location).

### Cross-check (designer round-trip vs. MATLAB flattened step sequence)

For a regenerated YAML to be considered round-trip-equivalent to its original,
the MATLAB ProtocolParser must produce the same flattened `commandSequence`
when fed either version. Randomized blocks reorder per parse via `randperm`,
so the comparison is only meaningful with the RNG seeded:

```matlab
rng(42);
ro = ProtocolParser().parse('original.yaml');
rng(42);
rr = ProtocolParser().parse('regenerated.yaml');
% Compare step ids cell-array element-by-element (must be byte-identical).
```

When the RNG is seeded identically, randomized blocks produce identical
orderings. When unseeded, only the *multiset* of step ids per block is
guaranteed equal (and even that depends on whether MATLAB's `randperm` is
sampling with or without replacement — verify per block type before asserting).

---

## Top-level structure

Canonical field order, as emitted by the canonical examples:

```yaml
version: 3
experiment_info: {...}    # required
rig: '<path>'             # required — path to a rig YAML on disk
variables: {...}          # optional — YAML anchor definitions
plugins: [...]            # optional — class/script/serial plugin definitions
experiment: [...]         # required — ordered heterogeneous sequence
conditions: [...]         # required — flat library of named command sequences
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `version` | int | yes | Must equal `3` for the v3 designer; the parser rejects `1` and `2`. |
| `experiment_info` | map | yes | `name`, `date_created`, `author`, `pattern_library` |
| `rig` | string (path) | yes | Replaces v2's inline `arena_info`. The MATLAB parser loads this file. |
| `variables` | map | no | Map of name → value, declared with `&anchor`. Used via `*alias` anywhere in the file. |
| `plugins` | list | no | Each entry: `name`, `type` (`class`/`script`/`serial`), and a type-specific config block (`matlab: {class}` for class plugins). |
| `experiment` | list | yes | The ordered sequence — heterogeneous (see below). |
| `conditions` | list | yes | Flat library of `{name, commands}` objects. At least one required. |

---

## The `experiment:` sequence

The `experiment:` list is **heterogeneous**: each entry is either

- a **bare string** — a reference to a named condition in the library, or
- a **block object** — a map with the keys below.

```yaml
experiment:
  - "arena_check"               # bare reference — runs the named condition once
  - name: "main block"          # block object
    trials: ["cond_a", "cond_b", "cond_c"]
    repetitions: 3              # optional, default 1
    randomize: true             # optional, default false
    intertrial: "intertrial_c"  # optional — REFERENCE to a condition, not inline
  - "posttrial"
```

| Block key | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | Human-readable label. Defaults to an auto-generated `block_N` if omitted. |
| `trials` | list of condition names | yes | Each name must exist in `conditions`. Non-empty. |
| `repetitions` | int | no, default 1 | Number of times the `trials` list runs. |
| `randomize` | bool | no, default false | If true, each repetition shuffles `trials` independently (MATLAB uses `randperm`). |
| `intertrial` | condition name | no | Condition inserted between consecutive trials in this block (not after the final trial of the final rep). |

**Reserved future-compat keys** (not yet implemented in the MATLAB parser but
to be passed through by the designer): `retry_on_fail`, `abort_if`,
`repeat_until`, `branch_to`, `branch`, `adaptive`.

---

## The `conditions:` library

```yaml
conditions:
  - name: "arena_check"
    commands:
      - {type: "controller", command_name: "allOn"}
      - {type: "wait", duration: *dur_long}
      - {type: "controller", command_name: "allOff"}
```

Each condition is `{name: <string>, commands: <list>}`. Commands have a
`type` field (`controller`, `wait`, or `plugin`) plus type-specific fields,
exactly as v2 used. Notable v3 additions:

- `trialParams` commands carry a `pattern_ID: <int>` field (added during SD-card prep).
- Plugin commands include a `params: {...}` map.

---

## Variables / anchors / comments

Users hand-author v3 YAMLs and **rely on anchors and comments** to keep
protocols maintainable. The designer therefore must round-trip both.

**Anchors.** Defined in the optional `variables:` block (or anywhere in
the file). The designer uses `js-yaml` Document mode
(`yaml.parseDocument({keepSourceTokens: true})`) which preserves anchor names
and alias references at their source positions. A scalar that was written as
`*dur_long` round-trips as `*dur_long`, not as the literal value `10`.

**Comments.** Whole-line `# ...` comments and trailing `value  # ...` comments
are preserved by Document mode.

**Designer scope.** The editor UI supports binding/unbinding scalar anchors
(numbers, strings, booleans). Complex anchors that bind whole maps or lists
(or that use YAML merge keys `<<: *anchor`) round-trip transparently but
appear in the editor as read-only "advanced anchor" badges — the user must
hand-edit them in YAML.

---

## Designer constraints (known)

The designer is **not** the authoritative parser. If MATLAB accepts a file
the designer rejects, the designer is wrong. Known constraints:

- Complex anchors (map/list/merge) are read-only in the editor (see above).
- Randomized blocks: the timeline preview shows a *sample* order and labels
  the block "randomized". Runtime order in MATLAB will differ per repetition.
- Plugin types beyond `class` are accepted on import (passed through) but the
  Settings UI in v0.2 will not provide first-class affordances for them; users
  hand-edit those plugin entries in the Variables drawer.
- Unknown keys at any level (top-level, plugin, condition, command, params)
  are preserved via `_unknownKeys` slots in the data model.

---

## Runner compatibility (which runner executes what)

Four executors have read protocol YAML. Inventory 2026-10-26 (maDisplayTools `main` e3e36d0,
`origin/version3` ff008aa; webDisplayTools `origin/next` 8cd0148). "planned" = the Python headless
runner in `LED-Display_pyDisplayTools`, built on the same IR and fixtures as the web runner.

| Feature | MATLAB `main` (v2) | MATLAB `version3` (v3) | Web runner (v3) | Python runner (planned) |
|---|---|---|---|---|
| Hardware | G4.1 over TCP 62222 only | G4.1 only | G6 over Web Serial only | G6 over pyserial |
| `allOn` / `allOff` / `stopDisplay` / `setPositionX` | yes | yes | yes | yes |
| `setColorDepth` (gs 2/16) | yes | yes | no G6 equivalent; skipped with an error | no |
| `trialParams` modes 2 / 3 / 4 | yes | yes | yes | yes |
| Trial timing | controller-timed (duration on the wire) | controller-timed | host-timed (wire duration 0, host sends STOP) | host-timed; controller-timed mode proposed for both |
| Mode 4 analog closed loop | on the G4.1 controller | same | mode 4 + gain sent to G6 firmware | same as web |
| Mode 3 FicTrac closed loop (`startClosedLoop`, bias, coupling, `start_frame`) | no | no | yes, through the bridge / graph | yes, through the graph |
| `duty`, `led_activation` | no | no | yes | yes |
| `setAnalogOut` / `setDigitalOut` / `ledDrive` (G6 BNC I/O) | no | no | yes | yes |
| Blocks, repetitions, randomize, intertrial | v2 blocks, `rng`-seeded | `experiment:` blocks, `randperm` | `flattenStructure` | same IR as web |
| Variables / anchors | n/a | resolved by the YAML library | preserved + resolved | resolved |
| `requires:` / flow control (`trial_check`, `repeat_until`) | no | **yes** (`CriterionEvaluator`, `executed_trace`) | refused (`WEB_RUNNER_CAPABILITIES` empty); LAB-218 | with LAB-218, via fixtures |
| `runtime_controls` | no | no | yes (Studio v0.84) | planned |
| Plugins executed | any MATLAB class / script / YAML serial device; BIAS, LED controller | + NI DAQ thermometer, wingbeat monitor | `log`, FicTrac; BIAS + ScanImage connectors on the ROS 2 graph (#254) | same connector nodes as the web |
| Hardware-failure handling | operator retry prompt (`maxAttempts`) | same | controller-fault post-mortem, `BRIDGE_LOST` | same policy as web |
| Run log | `experiment.log`, `trial_order.mat` (no readers) | + `executed_trace.*` | behavior_v2 JSONL → MCAP record (LAB-303/309) | MCAP record |

Divergences are documented here, not engineered around. A feature lands with a fixture, then in both
live runners, or its row says which runner has it.

---

## Reference: features exercised by the canonical examples

- 1 block object with `trials`, `repetitions: 3`, `randomize: true`, `intertrial: "intertrial"`
- 2 bare refs before the block (`"arena check"`, `"start light and camera"`); 1 bare ref after (`"posttrial"`)
- 4 scalar anchors in `variables:` (`dur_long`, `dur_short`, `color_command`, `color_power`)
  - Strings AND numbers, used in `duration:`, `command_name:`, and inside `params:` maps
- 2 plugins, both `type: "class"` (`BiasPlugin`, `LEDControllerPlugin`), no inline `config:`
- 11 conditions in the library
- ~18 comment lines

**Coverage gaps the canonical examples don't exercise** (the designer test
suite synthesizes these — see `tests/fixtures/v3_*.yaml`):

- Multiple blocks at different repetition counts
- `randomize: false`
- No `variables:` section
- No `intertrial:`
- Consecutive bare refs (no block at all)
- Forward-compat keys (`retry_on_fail`, `abort_if`)
- Plugins with inline `config:` overrides
- Non-G4 arena generations
