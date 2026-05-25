# Protocol v3 YAML — Spec by Example

This document describes the **Protocol v3** YAML format as implemented in
maDisplayTools at the pinned commit below. It is the JS-side reference for
the v3 Experiment Designer (`experiment_designer_v3.html`). It defers to the
MATLAB `ProtocolParser.m` as the ultimate authority — if this doc disagrees
with the canonical example files or the MATLAB parser, the latter wins.

---

## Pinned upstream version

- Repo: `reiserlab/maDisplayTools`
- Branch: `origin/version3`
- Commit SHA: **`00c8f9561bb1915a36d54054aeadf89778888ba2`** (`00c8f95`, captured 2026-05-23)

The two canonical example YAMLs from this commit are committed verbatim in
this repo as:

- `tests/fixtures/v3_canonical_a.yaml` ← `examples/yamls/experimentExampleVersion3.yaml`
- `tests/fixtures/v3_canonical_b.yaml` ← `examples/yamls/version3Attempt.yaml`

**These files are the spec.** The v3 parser exists to round-trip them; the
designer exists to view and edit data they could represent. Run
`tests/refresh-v3-canonical.sh` to re-fetch them at a newer SHA; any `git diff`
output is a signal the spec drifted upstream.

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
