# v3 Experiment Designer — Handoff for Next Session

> **⚠️ SUPERSEDED (2026-05-28).** This is the original handoff (covers up to
> v0.2). Most of its items have shipped. Read
> [`v3-editor-handoff-2.md`](v3-editor-handoff-2.md) instead — it has the
> current picture through Phase 6 (v0.11). This file is kept for history only.

**Last updated:** 2026-05-27
**Branch:** `main` at `6bacb46`
**Pinned upstream:** maDisplayTools `origin/version3` at `649d7ef`

Read this file first in a fresh session — it has everything needed to continue
work without re-deriving context from the chat history.

---

## Where we are

**Three PRs landed this thread**, all squash-merged into main:

| PR | Title | Sha |
|---|---|---|
| [#62](https://github.com/reiserlab/webDisplayTools/pull/62) | v3 Experiment Designer — v0.1 Viewer (parallel page beta) | `bdd905d` |
| [#63](https://github.com/reiserlab/webDisplayTools/pull/63) | v3 Experiment Designer — v0.2 Editor (inspector edits, command CRUD, undo) | `8fceb7c` |
| [#64](https://github.com/reiserlab/webDisplayTools/pull/64) | v3 editor: "Load demo" dropdown | `6bacb46` |

Tests: **210/210** v3, **137/137** v2, **10/10** arena calcs.

Live: <https://reiserlab.github.io/webDisplayTools/experiment_designer_v3.html>

### What the editor can do today

- Import a v3 YAML; export with anchors + comments preserved through any sequence of edits.
- Edit any literal scalar field in a command card (`duration`, `pattern`, `mode`, `frame_rate`, all plugin params, etc.).
- Add / delete / reorder commands within a condition. Picker grouped by Wait / Controller / Plugin:`<name>` / Plugin: `log` with registry-driven default params.
- Block property edits: `name`, `repetitions`, `randomize`, `intertrial` (dropdown from declared conditions).
- Undo / redo on every mutation (`Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`). Anchors and comments survive undo cycles.
- 10 demo fixtures one click away via the Load demo dropdown.
- Anchor-bound scalars render as read-only `→ &name` chips so a user can't accidentally unbind an anchor by typing over it.
- `beforeunload` warning when dirty; import-while-dirty confirmation; library usage counts refresh on intertrial change; numeric inputs reject empty-string commits.

### What it can't yet do

- Rename conditions (no rename cascade — this is the **single biggest constraint**, see below).
- Add new conditions to the library, delete conditions from the library.
- Edit a plugin command's `plugin_name` or `command_name`. Once a `setRedLEDPower` is in place, you can edit its `power` but not change it to `setBlueLEDPower`.
- Add / remove plugin command params (you can edit the value of an existing `panel_num` but can't add it to a command that didn't originally have it).
- Edit anything in the sequence pane itself — no "+ Add reference / + Add block", no drag/drop.
- Edit Variables / anchors.
- Validate command-level structure before export (parser only checks references).
- Create a YAML from scratch (no "New blank" option).

---

## User's feedback queue — priority order

This is what the user fed back during the testing session. The user said
"yes, lean (b) — your feedback freshest" — so this list is the **primary next-up**,
ahead of the original plan's Phase 4+.

### A. Inline ref view  *(small; user asked first, do first)*

**Problem.** Clicking a sequence ref entry today shows "This entry runs the
condition X once" with a "→ View condition details" button. One unnecessary
click to see anything useful.

**Change.** When the Inspector renders a sequence entry:

- **Bare ref** → inline the referenced condition's commands, with full edit
  affordances (same `renderCommandCard` machinery, edit inputs and `↑↓✕` actions).
  Header: `Reference (in sequence) → arena_check` with a small "open in library view" link.
- **Block with exactly 1 trial and no intertrial** → treat as decorated ref.
  Inline the single trial's commands below the block properties.
- **Block with multiple trials, OR with an intertrial** → keep the current
  block properties + trial-list view. Don't try to inline many conditions —
  becomes unscrollable.

Rule of thumb: 1 condition reachable → inline; ≥2 → navigation list.

**User confirmed**: edit affordances stay full in the inline view (same
condition, same edit surface, no reason to make it read-only).

Estimate: ~1 hour.

### B. Cheap polish items  *(small, ship as a batch after A)*

#### B1. `select` schema → real `<select>` dropdown

Today `renderEditableField` only branches on `typeHint === 'number'`; `select`
schema entries fall through to text input. Affects:

- `log.level` (DEBUG / INFO / WARNING / ERROR)
- `controller.command_name: setColorDepth` → `gs_val` (2 / 16)
- `controller.command_name: trialParams` → `mode` (2 / 4)

Path: lookup via `getV3CommandParams(experiment, type, pluginName, commandName)`,
branch on `schema.type === 'select'`, render `<select>` with options from
`schema.options`. ~30 min.

#### B2. Vendor `yaml@2.9.0` locally

Currently loaded from `https://cdn.jsdelivr.net/npm/yaml@2.9.0/...` via the
import map at the top of `experiment_designer_v3.html`. Lab is on the open
Janelia network so not urgent, but defensive.

Path: download `yaml@2.9.0/browser/dist/index.js` to `js/vendor/yaml.min.js`;
update the import map; verify in browser. ~30 min.

#### B3. Editable plugin command head

Today `renderCommandCard` for plugin type uses `detailKeys.plugin = []` —
only params render, not `plugin_name` or `command_name`. User can't change
`backlight.setRedLEDPower` to `backlight.setBlueLEDPower` without deleting
and re-adding the command.

Path: render two `<select>` fields in the plugin card head. First select
populated from `listV3PluginNames(experiment)`. Second select populated from
`getV3PluginCommands(experiment, pluginName)`. When plugin changes, command
list updates; when command changes, params re-derive from
`getV3CommandParams(...)`. ~1–2 hr.

#### B4. Plugin command param add/remove

Today you can edit existing params but can't add `panel_num: 2` to a
`setRedLEDPower` that didn't originally have one.

Path: per plugin command, render a `+ add param` picker showing params from
schema that aren't currently present. Per param row, add a `✕` button that
deletes the param via `docDelete`. ~1 hr.

#### B5. Forward-compat unknown command-type passthrough

`extractCommand` in `js/protocol-yaml-v3.js:271-285` throws `INVALID_SCHEMA`
for any type not in `{controller, wait, plugin}`. If MATLAB adds a new type
(`branch`, `loop`, etc.), the designer refuses to import perfectly valid
protocols.

Path: change `extractCommand` to preserve unknown types as a raw passthrough
with `_unknownKeys` capturing all fields. Render as a read-only "raw" card
type in the inspector (gray badge, "edit in YAML" hint). ~30 min.

### C. Timeline ribbon + click-to-select  *(small, fun)*

Cumulative-time ruler alongside the timeline preview at the bottom:

- Thin SVG strip above or below the existing step strip, in the same scroll container so they pan together.
- Ticks every 10s (light gray).
- Numerical labels every minute under ~15 min total experiment; every 5 min for longer. Format: `1m`, `2m`, `15m`, `1h 5m`.
- Click on any step → set `selection` to the underlying condition (or block) and bring it up in the Inspector.

Estimate: ~1 hour. The step-element `onclick` is essentially free since each
step already knows its source condition from the flatten pass.

### D. Library additions  *(several pieces — do in order)*

All four are wanted. Architectural note: the YAML-doc mutation pattern from
`docInsertCommand` already covers most of this — we just need to splice a
new YAMLMap into the `conditions` YAMLSeq instead of into a `commands`
sequence. Same `_doc.createNode({...})` + `items.splice` flow.

#### D1. "+ Add condition" button

Library pane header gets a `+ Add` button. Click → inline name prompt
(uniqueness checked against existing conditions). Creates skeleton:

```yaml
- name: "<user-chosen>"
  commands:
    - type: "wait"
      duration: 1
```

Splices into `experiment._doc`'s conditions YAMLSeq + JS-model
`experiment.conditions[]`. User edits like any other condition. ~30 min.

Open question: empty `commands: []` is invalid per spec (commands required),
so the wait-1 default is the minimum valid starter. Skip the prompt for an
auto-generated name like `condition_5` if user hits enter without typing?
Maybe.

#### D2. Duplicate condition

Right-click a library row → "Duplicate as…" → name prompt → deep-copy the
existing condition's commands into a new condition. Uses the same name-prompt
UI as D1. ~30 min.

#### D3. "New (blank)" demo entry

First option in the existing Load demo dropdown. Ships a literal skeleton
v3 YAML string (no anchors, placeholder `experiment_info.name`, empty
`plugins`, one starter `setup` condition, one sequence ref to it). Goes
through the existing import path — no constructive-emit needed.

Skeleton template (put in a `BLANK_TEMPLATE` const at the top of the module):

```yaml
version: 3
experiment_info:
  name: "New Experiment"
  author: ""
rig: "./configs/rigs/your_rig.yaml"
plugins: []
experiment:
  - "setup"
conditions:
  - name: "setup"
    commands:
      - type: "wait"
        duration: 1
```

~30 min.

#### D4. Cross-library import  *(biggest new UX, ~3 hr)*

**Trigger.** Button in library pane: "Import conditions from another YAML…"
or a dropdown menu next to + Add.

**Layout switch.** Sequence + Inspector temporarily replaced with a three-pane:

```
┌──────────────┬──────────────────┬──────────────┐
│ LIBRARY      │ LIBRARY (theirs) │ INSPECTOR    │
│ (yours)      │ — read-only      │ — read-only  │
│              │                  │   preview    │
│              │      ←           │              │
│              │      arrows      │              │
└──────────────┴──────────────────┴──────────────┘
```

- Top banner: `Importing from <other.yaml>` + a prominent **Done** button.
- User selects a "theirs" condition → inspector previews its commands (read-only).
- Click `←` to copy the selected condition into "yours."
- Multiple conditions can be brought over in one session before closing.

**Name collision.** If a "theirs" condition has the same name as one of
yours, the `←` action triggers an inline prompt:

```
A condition named "intertrial" already exists.
Save as: [intertrial_2     ]   [Copy]  [Cancel]
```

Auto-suffix `_2` pre-filled (or `_3` if `_2` also exists). User accepts the
suggestion, types a different name, or cancels. **This is critical** because
we don't have a rename cascade yet — once imported, the name is the name.

**Anchor handling — confirmed with user.** Auto-import only the anchors
actually referenced by imported conditions:

1. After picking conditions to copy, walk each imported command and collect
   all `*alias` references (use `nodeIsAliasAt` / `aliasNameAt` on the
   source `_doc`).
2. For each referenced alias, if the same name doesn't exist in
   `experiment.variables`, copy the anchor's value from source. If it does
   exist with the same value, no-op. If it exists with a different value,
   prompt user (similar to condition collision).
3. Append to `experiment._doc`'s `variables:` section + JS-model
   `experiment.variables[]`. Re-create the `*alias` references in the new
   condition's commands so they point at the new (or merged) anchors.

**Done button** exits import mode, restores normal Sequence + Inspector
layout. Any conditions/anchors copied are already in your library — no
"commit" needed.

---

## Codex review follow-ups (still open after PR #63 + the pre-merge batch)

Pre-merge batch (df1c184, merged via PR #63) handled: repetitions validation,
beforeunload, import-dirty check, commitBlockEdit re-render library, empty-
number reject, doc/SHA consistency.

**Still open** from the Codex cross-review (`.codex-review/report-20260527-105056.md`):

- B1 `select` → dropdown
- B2 Vendor `yaml`
- B3 Plugin head editable
- B4 Plugin param add/remove
- B5 Unknown command type passthrough
- **`extractVariables` only walks `variables:` section** — spec allows anchors
  defined anywhere. Round-trip still works (the YAML.Document captures them
  regardless); only the Variables panel in Settings is incomplete. Phase 5
  territory.
- **`plugin:<name>:<command>` split breaks on `:` in plugin name** — defensive,
  low priority. Fix: use structured option metadata (data attributes) instead
  of colon-encoded option values.
- **Path-based vs node-backed model architecture** — defer until Phase 4 or 5
  drag/drop forces the issue.
- **`validateReferences` doesn't check plugins** — Phase 6 territory.
- **No post-edit validation gate before export** — Phase 6.
- **CI `npm ci || npm install` fallback** — masks lockfile drift. Drop the
  fallback. `.github/workflows/validate-protocol-roundtrip.yml:46`.
- **CI path filters missing `package-lock.json`** — lockfile-only dependency
  bumps skip the workflow. Same file, `:14`.

---

## Phase 4+ from original plan (deferred until A–D land)

### Phase 4 — Sequence editing (~2–3 days)

- `+ Add reference` / `+ Add block` buttons at top of Sequence pane.
- Drag library item onto Sequence → creates a ref at drop position.
- Drag library item onto a block's trial chip strip → adds trial.
- Drag-to-reorder within sequence (refs and blocks both).
- Right-click context menu: convert ref ↔ block (when block has exactly 1 trial, 1 rep, no randomize, no ITI).
- Trial-chip "missing" badge gets a "→ Create this condition" affordance.

**This is what the original plan considered the big PR2 work.** User-fed feedback (sections A–D) takes priority because it's grounded in actual use.

### Phase 5 — Variables UX (~3–4 days)

- Settings drawer Variables table becomes inline-editable (name + value).
- Anchor-aware inputs everywhere in the Commands editor: bound fields show
  `→ &name` badge with a pencil icon → popover offering:
  - Edit literal (unbinds the anchor)
  - Bind to existing anchor (dropdown of available anchors)
  - Create new anchor (name + use current value)
- **Rename cascade with single undo entry** — confirm dialog showing all
  references that will be updated, then the cascade fires as one
  `pushUndo() → many docSet calls → renderAll` batch.
- Complex anchors (maps, lists, merge keys `<<: *anchor`) round-trip via
  the existing `_doc` mechanism but surface in the editor as read-only
  "advanced anchor" badges — user must hand-edit those in YAML.

The cross-library import D4's "save as" prompt is essentially a trivial
subset of the rename cascade. If that prompt UX feels good in practice,
reuse it here. If it doesn't, revisit both at once.

### Phase 6 — Validation, error UX, Reset (~1 day)

- **Accumulated validation report** at import time — collect ALL errors
  before showing the user (duplicate condition names, missing intertrial
  referents, missing trial referents in blocks, alias references to missing
  variables, duplicate anchor names, name-identity normalization issues).
  Display in a modal with line numbers where possible.
- Export-time warnings (non-blocking): unused conditions, unused anchors.
- Library: delete blocked when usage > 0; "remove from sequence first?" affordance.
- Reset button: clear sequence + conditions + variables to defaults (one
  empty condition, sequence = `[ref to it]`).

### Phase 7 — Test expansion (~1 day)

- Comment preservation at strategic positions (above keys, trailing-line,
  inside lists).
- Anchor edge cases: anchors bound to numbers, strings, used inside `params:`
  maps, two anchors with the same resolved value.
- Forward-compat passthrough at all nesting levels.
- Randomized-block MATLAB semantics: assert flattened-queue length and
  *set* match the original; don't assert order.
- Validation error cases: `version: 1` / `version: 2` input, duplicate
  condition names, missing intertrial referent, missing trial referent,
  unknown alias, complex-anchor-in-editable-position.

### Phase 8 — Manual MATLAB validation flow (~½ day)

- Write `docs/development/v3-matlab-validation.md` describing the
  MCP-driven flow: load a designer-exported YAML, run `ProtocolParser.m`
  via `mcp__matlab__run_matlab_file`, compare against expected.
- Add `tests/run-matlab-validation.md` — short checklist for "before merging,
  run these N fixtures through MATLAB."

### Phase 9 — Quickstart + final docs (~½ day)

- New file `experiment_designer_v3_quickstart.html` — step-by-step walkthrough
  showing library / sequence / blocks / variables / a worked example.
- Update `docs/development/ROADMAP.md`: PR2 status, v2 retirement schedule
  (some number of weeks after lab confirms v3 production use).

---

## Implementation patterns to remember (future-me crib sheet)

### YAML.Document as single source of truth

- `experiment._doc` is the YAML.Document. JS model (`experiment.conditions`,
  `experiment.sequence`, etc.) is a derived mirror.
- **All mutations** go through the helpers in `js/protocol-yaml-v3.js`:
  `docSet`, `docDelete`, `docInsertCommand`, `docMoveCommand`. Each mutates
  the `_doc` first, then mirrors into the JS model.
- Export = `experiment._doc.toString()`. No constructive-emit path.
- To add a new condition to the library: `experiment._doc.createNode({name, commands: [...]})` builds the YAMLMap; splice into the conditions YAMLSeq's `items[]` array; mirror to `experiment.conditions`. Same flow as docInsertCommand uses for command sequences.

### Anchor handling

- `nodeIsAliasAt(experiment, path)` — true if the YAML node at `path` is `*name`.
- `aliasNameAt(experiment, path)` — returns the anchor name when alias, else null.
- The editor renders alias-bound fields as read-only chips so a user can't
  accidentally unbind an anchor by typing over it. Phase 5 will add a
  pencil-popover to deliberately bind / unbind.

### Undo/redo

- Text-based snapshots: `experiment._doc.toString()` + JSON snapshot of `selection`.
- On undo, full re-parse via `parseV3Protocol(snap.text)` — no incremental restore.
- `_restoring` guard prevents re-renders during a restore from polluting the stack.
- Trigger: `pushUndo()` BEFORE every mutation. In text-input change handlers,
  pushUndo runs only when the new value differs from the old (no spurious
  snapshots from focus-then-blur without change).
- `UNDO_LIMIT = 50`. Each snapshot is ~text-size bytes.

### Path conventions (YAML vs JS model)

YAML field names → JS-model field names:

| YAML | JS model |
|---|---|
| `experiment` (the sequence) | `sequence` |
| `rig` | `rig_path` |

`mirrorIntoModel` and `docDelete` translate these at write time. Everything
else (`conditions`, `commands`, `params`, etc.) matches by name.

### Plugin lookup — v3 by class, not by name

v2 keyed `BUILTIN_PLUGINS` by canonical plugin name (`camera`, `backlight`).
v3 lets users name plugins anything, so v3 helpers look up by `matlab.class`:

- `findPluginDefByClass(className)` → registry entry
- `getCommandsForClass(className)` → command schema map
- `getV3PluginCommands(experiment, pluginName)` → full resolve chain: name → class → registry
- `listV3PluginNames(experiment)` → declared names + `"log"` at the end
- `getV3CommandParams(experiment, type, pluginName, commandName)` → schema for params

The built-in `log` plugin is in `LOG_PLUGIN` (not in BUILTIN_PLUGINS) because
it's always available regardless of whether it's declared in `plugins:`.

### State coherence after mutations

After any mutation, call the right commit helper:

- `commitInspectorEdit()` — re-renders inspector + timeline (does NOT re-render library; command edits don't shift usage counts).
- `commitBlockEdit()` — re-renders inspector + sequence + timeline + **library** (intertrial changes shift usage).
- For a library add (D1/D2/D4), re-render library + sequence (sequence cards show "missing" badges that may become valid).

### Snapshot trigger discipline

- Text/number input `change` handler: snapshot pushed before `docSet` only when value differs (`if (coerced === value) return;`).
- Checkbox / select `change` handler: snapshot pushed before `docSet`.
- Add/delete/move: snapshot pushed before the doc mutation.
- Never push during drag-hover, mid-typing keystrokes, or focus-without-change.

---

## Files that matter

- `experiment_designer_v3.html` — the editor page (HTML + CSS + module script).
- `js/protocol-yaml-v3.js` — parser, generator, edit helpers.
- `js/plugin-registry.js` — plugin definitions, v3 lookup helpers.
- `tests/test-protocol-roundtrip-v3.js` — 210 tests across 12 suites.
- `tests/fixtures/v3_*.yaml` — 10 fixtures.
- `tests/fixtures/matlab_normalized/` — MATLAB-validated copies with rig paths rewritten.
- `docs/development/v3-spec.md` — pinned upstream SHA, designer constraints, anchor/comment guarantees.
- `docs/development/ROADMAP.md` — v3 status, milestones, retirement plan.
- `~/.claude/plans/let-s-check-if-matlabtools-enumerated-acorn.md` — the original two-PR plan that drove PR #62 + #63. PR #63 finished Phase 3 ahead of schedule; sections A–D above are the new priority.

---

## Open design questions

1. **Cross-library anchor scope** — **resolved.** Auto-import only anchors
   referenced by imported conditions. Collision: prompt for new name.
2. **Rename cascade UI** — the cross-library "save as" prompt is the simplest
   subset. Use it as a UX testbed. If it feels good, reuse for full Phase 5
   rename cascade. If not, revisit both.
3. **"+ Add condition" default commands** — minimum valid is one wait
   command. Empty would violate the spec (commands required). Default to
   `[{type: 'wait', duration: 1}]`.
4. **Inline ref view: when block has 1 trial AND an intertrial — inline or nav?**
   Strict reading of "1 condition reachable" says nav, because clicking shows
   2 commands' worth of context (the trial + the iti). But the iti is usually
   trivial (`allOff` + short wait). My instinct: inline only when 1 trial AND
   no iti. Flag this for user feedback when shipping A.

---

## How to verify after changes

```bash
npm test                       # arena calc + v2 + v3 suites
python -m http.server 8080     # then open localhost:8080/experiment_designer_v3.html
```

For each behavioral change:

1. Load relevant demo fixture(s) via the Load demo dropdown.
2. Exercise the new behavior.
3. Make an edit elsewhere → verify undo restores correctly.
4. Export → diff against original → only the intended change should appear; anchors and comments preserved.

Pages auto-deploys from `main` — give it a minute after merging to rebuild.

---

## Relevant external state

- **maDisplayTools `origin/version3`** pinned at **`649d7ef`** (Lisa's docs +
  full-experiment fixture, 2026-05-26).
- **Lisa was notified via Slack** about 3 syntactic typos in her
  `examples/yamls/full_experiment_test_v3.yaml` (missing `commands:` on the
  `start recording` condition; indent slip on a wait; missing close-quote on
  `type: "controller`). Our `tests/fixtures/v3_full_experiment.yaml` has the
  three fixes applied locally. Upstream still has the typos as of last check —
  not blocking, our fixture works.
- **Authoritative spec doc** lives upstream at
  `docs/development/yaml_protocol_documentation_v3.md` on `origin/version3`.
  When in doubt about YAML format details, defer to Lisa's doc, not our
  `v3-spec.md` (which documents designer-specific concerns).
- **Codex cross-review** for PR #63 lives at `.codex-review/report-20260527-105056.md`
  (gitignored, local only). Full reconciliation between Claude's analysis,
  Codex standard pass, and Codex adversarial pass. Worth re-reading before
  major architectural changes.
