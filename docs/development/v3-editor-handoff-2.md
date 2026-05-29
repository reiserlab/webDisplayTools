# v3 Experiment Designer — Handoff for Next Session (Round 2)

**Last updated:** 2026-05-29 (Phase 6 + Phase 7 follow-up)
**Branch:** `phase7/test-hardening-and-line-numbers` → PR to `main` (Phase 6 already merged via #77)
**Editor version:** v3 Experiment Designer **v0.12** (validation line numbers + Phase 7 tests)
**Pinned upstream:** maDisplayTools `origin/version3` at `649d7ef`

This is the second handoff doc for the v3 designer. It supersedes the original
`v3-editor-handoff.md` (which covered up to v0.2). Read this file FIRST in a
new session — it has the post-Phase-4 picture, the Codex-flagged concerns to
clean up, and the prioritized open work.

---

## 0. TL;DR

The v3 designer is essentially feature-complete for single-document editing.
Phase 1 (viewer) through Phase 4 (sequence editing) all shipped this session
across 9 PRs (#65 → #74). Tests at **arena 10/10, v2 137/137, v3 369/369**.

The next session should pick **one** of:

- **(A) Phase-4 cleanup PR** — fix 4 Codex-flagged bugs (~½ day). Strongest
  case if the lab is actively using v0.8 right now.
- **(B) Phase 5 — Variables editor + rename cascade** (~4–5 days). Required
  before D4 can ship per Codex-adv recommendation in `v3-d4-design-reviews.md`.
- **(C) Phase 6 — full pre-export validation modal + Reset button** (~1 day).
  Builds on the soft-warn banner shipped in Tier 3.
- **(D) D4 cross-library import** (~5+ days, with rev-3 design fixes first).
  The big architectural-stress feature; design doc already on the shelf.

My recommendation: **A first** (small, fast, ships before users hit the bugs),
then **B** (largest user-impact feature still missing). D4 stays deferred
until B ships.

---

## 1. Codex review of landed work (Phase 4 + earlier)

Two-pass Codex GPT-5.5 diff-review of the Phase 4 work
(`84a5fb1...c5cf223`) ran 2026-05-27. Full report at
`.codex-review/report-20260527-214207.md` (gitignored — preserved here
since the synthesis is the load-bearing artifact).

### Significant bugs to fix as Phase-4 cleanup (~½ day)

**1. Event-listener accumulation on `#sequenceList`** — `experiment_designer_v3.html:1809`

`renderSequence()` calls `addEventListener('dragover'|'dragleave'|'drop', ...)`
on `#sequenceList` *every time it renders*. `list.innerHTML = ''` clears
children but doesn't remove listeners from `list` itself. After N renders
(every mutation triggers one), a single drop fires N handlers → **N
duplicate refs inserted + N pushUndo calls**. Surfaces within the first
session of normal editing.

**Fix:** Move the list-level handlers to a one-time wiring block at startup
(alongside `$('addRefBtn').addEventListener('click', onAddSeqRef)` etc.), OR
assign via `list.ondragover = ...` so each render replaces the handler. ~5
lines, straightforward.

**2. Selection index doesn't track displaced entries on move** — `experiment_designer_v3.html:1482`

`onMoveSequenceEntry` updates `selection.index` only when the moved entry was
the selected one. If another selected entry sits between `fromIdx` and
`toIdx`, its real position shifts but `selection.index` stays stale. The
inspector then shows the wrong entry.

Same class of bug for `onInsertSequenceRefFromLib`: dropping a library row
at idx 0 shifts everything down by one, but a `selection.index = 2` doesn't
follow.

**Fix:** Compute the new selected index across the full affected range in
each handler. ~10 lines.

**3. Timeline ruler ticks don't align with min-width-clamped step layout** — `experiment_designer_v3.html:3187`

Current ruler uses one global `pxPerSecRuler = totalWidthPx / realTotalSec`.
Step widths are individually clamped (`Math.max(60, dur * pxPerSec)`). Once
short steps clamp, time-position and pixel-position decouple. A "1m" tick
doesn't reliably land at the spot where 1 minute of cumulative real time
elapses.

**Fix:** Build tick positions piecewise — walk the step `layout` array, find
the step containing each tick's real time, position the tick proportionally
within that step's pixel range. ~20 lines. (Codex-std and I both spec'd this
approach.)

**4. Block→ref convert silently drops `_unknownKeys`** — `js/protocol-yaml-v3.js:1154`

`docReplaceSequenceEntry` swaps the whole YAML node. Any `_unknownKeys` on
the original block (forward-compat fields like `retry_on_fail`, `abort_if`)
are gone. This undermines the B5 unknown-passthrough we shipped in Tier 1.

**Fix:** In `isConvertibleBlock`, also check
`Object.keys(entry._unknownKeys || {}).length === 0`. Refuse to convert
blocks with non-empty unknown keys (extend the existing "Cannot convert"
error message). ~3 lines.

### Minor follow-ups (combine with #1–4 in the cleanup PR)

**5. `_buildSequenceEntry` accepts non-positive / non-integer `repetitions`** — `js/protocol-yaml-v3.js:1022`

Parser rejects `0`, negatives, decimals. Builder doesn't. Worst case:
`repetitions: 0` would emit `0` to YAML but mirror as `1` via the
`|| 1` default — silent doc/model divergence. Currently no caller hits
this path, but D4 / paste-import would.

**Fix:** Add `if (typeof entry.repetitions === 'number' && (!Number.isInteger(entry.repetitions) || entry.repetitions < 1)) throw new V3ParseError(...)` in `_buildSequenceEntry`. ~5 lines.

**6. No-op drops can pollute the undo stack** — multiple call sites

Some drop handlers' early-return paths happen *after* a `pushUndo` call.
Audit pass needed; not all paths exhibit it. Worth a 15-minute review.

### Architectural-level concerns (flagged by Codex-adv, not blocking)

**The path-based mirror model is showing strain.** 17 helpers now manage
the `_doc` + JS-mirror + selection + undo + render dance. Each new edit
path has to remember all of: mutate `_doc`, mutate JS mirror, preserve
comments, preserve unknown keys, update selection, dirty state, render
dependent panes, push undo at the right time. The two Significant bugs
above (event-listener accumulation, unknown-keys loss) are concrete
examples of "many edit paths, no centralized consistency gate."

Codex-adv's recommendation: a single `applySequenceEdit(experiment, op)`
reducer that validates pre-op + post-op and centralizes the bookkeeping.
**Don't preemptively refactor.** Monitor. The next feature that can't fit
cleanly into the current pattern is when this refactor pays for itself.
That trigger is likely D4 (cross-library import), per the D4 design
review history.

**Timeline scale: thousands of DOM nodes for large protocols.**
`flattenSequence` expands every repetition × trial. A 30-condition × 20-rep
protocol = 600+ cells. For current lab-scale protocols (dozens × a few
reps) it's fine. Worth bounding once a stress-test reveals the cliff.

---

## 2. What's shipped (Phase 1 through Phase 4)

| PR | Description | Tier | Status |
|---|---|---|---|
| #62 | v0.1 Viewer (parser, document round-trip) | Phase 1 | merged |
| #63 | v0.2 Editor (inspector edits, command CRUD, undo) | Phase 3 | merged |
| #64 | Load demo dropdown | extra | merged |
| #65 | Original handoff doc (now superseded) | doc | merged |
| #66 | Tier 1 — preamble (CI hardening, unknown-type passthrough, select dropdown) | Tier 1 | merged |
| #67 | Tier 2 — inline ref view, editable plugin head, plugin param CRUD | Tier 2 | merged |
| #68 | Tier 3 — export warnings, vendored yaml, library add/duplicate/blank | Tier 3 | merged |
| #69 | D4 design + review history (deferred) | doc | merged |
| #70 | Phase 4a — sequence reorder + Add ref/block + delete | Phase 4 | merged |
| #72 | Phase 4b — library→sequence drag + block trial editing | Phase 4 | merged |
| #73 | Timeline ribbon — cumulative-time ruler + click-to-select | Phase 4 (item C) | merged |
| #74 | Phase 4c — right-click ref↔block convert + missing-trial create | Phase 4 | merged |

**Net delta vs start of session:** ~10K lines added across HTML, JS,
fixtures, tests, and docs.

**Live:** <https://reiserlab.github.io/webDisplayTools/experiment_designer_v3.html>

### What the editor can do today (v0.8)

- Round-trip any v3 YAML (anchors, comments, formatting preserved).
- Edit any literal scalar in a command card; alias-bound scalars show
  read-only chips.
- Add/remove/reorder commands within a condition.
- Edit plugin command heads (cascading plugin/command selects with
  schema-driven param reconciliation).
- Add/remove plugin command params from the schema.
- Inline ref view (clicking a sequence ref inlines the condition's commands
  with full edit affordances + "shared with N refs" badge).
- Block-with-1-trial-no-iti also inlines (decorated-ref view).
- Library: add new condition (auto-appends bare ref to sequence),
  duplicate condition (preserves anchors), "New (blank)" demo.
- Sequence: + Ref / + Block buttons, drag-to-reorder, ✕ delete per entry,
  drag library row → insert ref at position, drag library row → add trial
  to block, drag trial chips within block to reorder, ✕ delete per chip,
  right-click ref↔block convert (where convertible).
- Missing-condition trial chips / refs / itis are clickable to create the
  condition with a placeholder wait command.
- Settings drawer with read-only Variables / Plugins / experiment info /
  rig path.
- Soft-warn export validation banner: unused conditions, unused anchors,
  undeclared plugins, raw-command cards.
- Forward-compat unknown command types passthrough.
- `yaml@2.9.0` vendored locally (no CDN dependency).
- 10 demo fixtures via the Load demo dropdown.
- Undo/redo with text-snapshot model (`Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`).
- Timeline ribbon: cumulative-time ruler with 10s ticks, 1m / 5m labels;
  click any step to select the underlying ref or block.
- `beforeunload` warning when dirty; import-while-dirty confirmation;
  library usage counts; alias chip rendering; numeric coercion for select
  schema fields.

### What the editor still can't do (deferred work)

- **Cross-library import** (D4) — design is on the shelf with a known fix
  list; deferred per Codex-adv concerns.
- **Pre-export validation line numbers** — the Phase 6 modal aggregates
  blocking errors but does not yet map them to source line numbers.
- **MATLAB-validation flow documentation** (Phase 8 in the original plan).

*(Shipped since the original deferred list: variables editing — Phase 5;
pre-export blocking validation modal, library-row delete, Reset button —
Phase 6.)*
- **Quickstart HTML doc** (Phase 9 in the original plan).
- Comment preservation tests at strategic positions (Phase 7 in the plan).

---

## 3. What's left to do — prioritized

### Tier 1: Phase 4 cleanup (highest priority — ~½ day)

A small PR addressing the four Significant Codex findings plus the minor
ones from §1. None require new design work; all are isolated to the
already-merged code.

- Bind `#sequenceList` drag/drop listeners once at startup (event-listener
  accumulation fix).
- Walk `selection.index` through move and insert mutations.
- Piecewise ruler tick positioning from the `layout` array.
- Refuse to convert blocks with non-empty `_unknownKeys`.
- Validate positive-integer `repetitions` in `_buildSequenceEntry`.
- Audit no-op-drop pushUndo placements.

**Why first:** the event-listener bug surfaces within a normal editing
session. If the lab is actively using v0.8, they'll hit it. Cheap to fix.

### Tier 2: Phase 5 — Variables UX ✅ SHIPPED (this session, v0.10)

Phase 5 landed in two PRs this session: cleanup (`#76`, v0.9) then
Phase 5 (this branch, v0.10). All three pieces are in:

1. **Inline-editable Variables table** in the Settings drawer (anchor
   name + value editable, ✕ delete with cascade-unbind, `+ Add` row).
   Complex anchors (Map/Seq) render as read-only "complex anchor"
   badges.
2. **Anchor binding popover** on every editable scalar (controller and
   plugin command fields) via a 🔗 button appended to each input.
   - Literal scalars: Bind-to-existing dropdown (with type-mismatched
     options visibly disabled) + Create-new-anchor section.
   - Aliased scalars: summary card with "Edit in Variables…" jump
     button, Rebind-to dropdown, and Unbind action.
3. **Rename cascade.** Modal lists every reference path that will
   update; single `pushUndo()` wraps the atomic `docRenameVariable`
   call (which walks every `*alias` source in one synchronous pass via
   `YAML.visit`). One undo step for the whole rename.

**New doc helpers** (10 added → 27 total):
`docCreateVariable`, `docDeleteVariable`, `docRenameVariable`,
`docSetVariableValue`, `docBindToAnchor`, `docUnbindAnchor`,
`findAliasesTo`, `variableIsComplex`, `isValidAnchorName`,
`anchorExists`.

**New UI primitive:** `confirmModal({title, body, list, confirmLabel}) →
Promise<bool>` — backdrop-dismiss + Escape/Enter keys. Reusable for
Phase 6's full validation modal.

**Test coverage:** 54 new tests in Suite 29 (Variable lifecycle +
anchor binding). Total: 429/429.

**D4 unblocked:** the prefix-clutter mitigation Codex-adv flagged in
the D4 design review now has its UX (Phase 5's Variables table makes
the renames trivial).

Complex anchors (maps, lists, merge keys `<<: *foo`) round-trip via
`_doc`, surface as read-only "complex anchor" badges in the Variables
table, and rename cascades work for them (the test suite covers a
merge-key case).

### Tier 3: Phase 6 — validation modal + Reset + library delete ✅ SHIPPED (this session, v0.11)

All three pieces landed on `phase5/variables-ux` after the Phase 5 commit:

1. **Pre-export validation modal.** The Export button now runs a blocking
   validator before writing. On errors it shows a `confirmModal` listing
   each error with an "Export anyway" escape hatch (Cancel aborts the
   download). Soft warnings stay in the non-blocking banner — the two
   tiers are distinct.
2. **Library-row delete.** Each library row has a `✕` button. Deletion is
   blocked while usage > 0 (shows "remove from sequence first"); when
   unused, a confirm modal precedes `docDelete(['conditions', idx])`.
   Selection clears if the deleted condition was selected.
3. **Reset button.** Header toolbar `⟲ Reset` confirms, then loads the
   blank skeleton. Reversible: `pushUndo()` runs first and `loadYamlText`
   gained a `{ keepUndo: true }` option, so a single Undo restores the
   prior doc.

**New validator:** `collectBlockingErrors(experiment)` in
`js/protocol-yaml-v3.js` — a blocking sibling to `collectExportWarnings`.
It *composes* `validateReferences` (folds in dup-condition-name and
missing-ref errors) and adds two CST checks via `YAML.visit`: **duplicate
anchor names** (yaml@2 silently accepts `&dup` twice, so it's counted) and
**dangling aliases** (an `*alias` whose anchor is gone — a safety net for
the in-memory mutation model, since a fully-dangling alias throws at
import). Returns `{ ok, errors }`, the same shape as `validateReferences`.
Exported from all three surfaces (ProtocolV3 object, named export, ESM
import in the HTML).

**Test coverage:** Suite 30 (17 checks) in `tests/test-protocol-roundtrip-v3.js`.
Total: **446/446**.

**Browser-verified (this session):** the 6 Phase 5 checks (rename cascade,
bind, unbind, create-and-bind, cascade-unbind delete, complex-anchor badge)
plus the 3 Phase 6 checks (validation modal blocks/cancels on duplicate
anchor, Reset collapses to skeleton and Undo restores, library delete
blocked-when-used / works-when-unused).

> **Preview caching note:** `python -m http.server` lets the browser
> heuristically cache `js/*.js`, which breaks ES-module verification after
> edits (a stale import silently kills the whole module). A no-cache static
> server (`.claude/nocache-server.py`, untracked) on a fresh port avoids it.

**Follow-up shipped (v0.12):** the validation modal now reports **source line
numbers** for anchor errors — e.g. `Duplicate anchor name: "&dup" declared 2
times (lines 5, 6)`. `collectBlockingErrors` re-parses `_doc.toString()` with a
`YAML.LineCounter` and maps each node's `range[0]` to a line. Structural
`validateReferences` errors stay line-less (model-based, no node handle).
Dangling-alias errors are also line-less by nature: a dangling alias makes the
doc non-serializable (`toString()` throws "Unresolved alias"), so the
re-parse can't run — the check falls back to a range-less scan and still
reports the error, just without a line. Also fixed a double-bullet in the
modal list (callers prefix `• `, so the `<li>` disc marker is suppressed).

### Tier 4: D4 — cross-library import (parked — ~5+ days when picked up)

Design is preserved at `docs/development/v3-d4-design.md` (rev 2) with
the review-fix list at `docs/development/v3-d4-design-reviews.md`. Before
implementation:

1. Apply the rev-2 review fix list (the design doc lists ~11 corrections
   needed before Milestone 1).
2. Switch from plugin namespacing default to **plugin merge-by-default
   when class+config match** (Codex-adv's strongest design point).
3. Verify Phase 5 has shipped (D4 mitigations depend on it).
4. Re-run Codex on the rev-3 doc.
5. Start Milestone 1 (cross-doc primitives).

### Tier 5: Phase 7-9 — polish (~1 day total)

- Phase 7 ✅ **largely done (v0.12)**: Suite 31 added comment-preservation at
  strategic positions (head / section / inline / between), anchor edge cases
  (two anchors same value, binding isolation), randomized-block semantics
  (`randomize: true`/`false` round-trip), and validation line-number coverage.
  Still open if wanted: params-level anchor cases, deeper validation-error
  matrices. v3 suite now **467/467**.
- Phase 8: write `docs/development/v3-matlab-validation.md` describing
  the MCP-driven MATLAB validation flow.
- Phase 9: `experiment_designer_v3_quickstart.html` step-by-step
  walkthrough.

---

## 4. Decisions waiting on the user

These should be resolved before the next session picks a direction:

1. **Which tier to start with?** My recommendation: Tier 1 (cleanup) →
   Tier 2 (Phase 5). Push back if the lab needs something else more.
2. **Architectural refactor?** Codex-adv has flagged the path-based mirror
   model as showing strain. Recommendation: monitor, refactor when D4
   demands it. Don't refactor preemptively.
3. **Timeline scale cap?** No cap today. Worth adding if anyone's running
   protocols with > 200 flattened steps. Probably defer.

---

## 5. Implementation patterns (crib sheet for the next session)

### YAML.Document as single source of truth

- `experiment._doc` is the YAML.Document. JS model (`experiment.conditions`,
  `experiment.sequence`, `experiment.variables`, `experiment.plugins`) is a
  derived mirror.
- **All mutations** go through helpers in `js/protocol-yaml-v3.js`. Current
  helper count: **17**.
- Export = `experiment._doc.toString()`. No constructive-emit path.

### Current helpers (alphabetical)

`docAddPluginParam`, `docAppendSequenceEntry`, `docBindToAnchor`,
`docCloneCondition`, `docCreateVariable`, `docDelete`,
`docDeletePluginParam`, `docDeleteVariable`, `docInsertCommand`,
`docInsertCondition`, `docInsertSequenceEntry`, `docInsertTrialInBlock`,
`docMoveCommand`, `docMoveSequenceEntry`, `docMoveTrialInBlock`,
`docRemoveSequenceEntry`, `docRemoveTrialFromBlock`,
`docRenameVariable`, `docReplaceSequenceEntry`, `docSet`,
`docSetPluginCommandHead`, `docSetVariableValue`, `docUnbindAnchor`.

Plus inspection helpers: `nodeIsAliasAt`, `aliasNameAt`,
`anchorExists`, `findAliasesTo`, `isValidAnchorName`,
`variableIsComplex`, `collectExportWarnings`, `validateReferences`,
`collectBlockingErrors` (Phase 6 — blocking pre-export validation).

### Helper anatomy (template for adding new ones)

Every helper follows this pattern:

```js
function docXxx(experiment, ...args) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docXxx: experiment has no _doc handle', 'NO_DOC');
    }
    // Bounds-check / input-shape validation
    if (badInput) throw new V3ParseError('docXxx: ...', 'BAD_PATH' | 'INVALID_INPUT');
    // Resolve the YAML node
    const node = experiment._doc.getIn([...path], true);
    if (!node || !validShape(node)) {
        throw new V3ParseError('docXxx: doc/model divergence', 'DOC_MODEL_DIVERGENCE');
    }
    // Mutate the doc-side
    node.items.splice(/* ... */) || experiment._doc.setIn(/* ... */);
    // Mirror into the JS model
    experiment.sequence /* or conditions */ .splice(/* ... */);
}
```

Then in the UI:

```js
function onUserAction(...) {
    pushUndo();
    try {
        docXxx(experiment, ...);
        setDirty(true);
        // Update selection if needed (watch for displacement bugs!)
        renderAll();
    } catch (err) {
        showError('...', err.message);
    }
}
```

### Undo/redo model

Text-snapshot based: `experiment._doc.toString()` + JSON snapshot of
`selection`. On undo, full re-parse via `parseV3Protocol(snap.text)`.
`pushUndo()` runs BEFORE every mutation; `_restoring` guard prevents
re-render-during-restore from polluting the stack. `UNDO_LIMIT = 50`.

### State coherence after mutations

After any mutation, call the right commit helper:

- `commitInspectorEdit()` — re-renders inspector + timeline.
- `commitBlockEdit()` — re-renders inspector + sequence + timeline +
  **library** (intertrial changes shift usage).
- `renderAll()` — everything. Used by all sequence mutations; can usually
  be optimized to one of the above but `renderAll` is always correct.

For sequence mutations, also remember to:
- Walk `selection.index` through any shift caused by insert/remove/move.
- Call `setDirty(true)`.
- Call `pushUndo()` BEFORE the mutation (so undo restores pre-mutation state).

---

## 6. Files that matter (current)

| File | Purpose |
|---|---|
| `experiment_designer_v3.html` | The editor (HTML + CSS + module script). At v0.8 it's ~3200 lines. |
| `js/protocol-yaml-v3.js` | Parser, generator, validation, 17 edit helpers, `collectExportWarnings`. ~1400 lines. |
| `js/plugin-registry.js` | Plugin command schemas, controller commands, v3 helpers (`findPluginDefByClass`, `getCommandsForClass`, `getV3PluginCommands`, `listV3PluginNames`, `getV3CommandParams`). |
| `js/vendor/yaml/browser/dist/` | Vendored `yaml@2.9.0` library (per Tier 3). |
| `tests/test-protocol-roundtrip-v3.js` | 369 v3 tests across 28 suites. |
| `tests/fixtures/v3_*.yaml` | 10 demo fixtures. |
| `docs/development/v3-spec.md` | Designer-side spec (anchors, comments, etc.). Pinned upstream SHA. |
| `docs/development/v3-d4-design.md` | Deferred D4 design doc (rev 2). |
| `docs/development/v3-d4-design-reviews.md` | D4 review history + fix list. |
| `docs/development/ROADMAP.md` | Project-wide roadmap. |
| `docs/development/v3-editor-handoff.md` | The original handoff (v0.2). Superseded by this doc. |

The **old** handoff (`v3-editor-handoff.md`) is now significantly out of
date — most of its items have shipped. Worth marking as superseded or
deleting in the next session.

---

## 7. How to verify after changes

```bash
npm test                       # arena 10/10, v2 137/137, v3 369/369+
python -m http.server 8080     # then open localhost:8080/experiment_designer_v3.html
```

For each behavioral change:
1. Load relevant demo fixture(s) via the Load demo dropdown.
2. Exercise the new behavior.
3. Make an edit elsewhere → verify undo restores correctly.
4. Export → diff against original → only the intended change should
   appear; anchors and comments preserved.

Pages auto-deploys from `main` — give it ~30s after merge to rebuild;
hard-refresh on first load.

---

## 8. External state to be aware of

- **maDisplayTools `origin/version3`** pinned at **`649d7ef`**. The
  authoritative spec lives at `docs/development/yaml_protocol_documentation_v3.md`
  on that branch.
- **Lisa was notified** (earlier session) about 3 syntactic typos in her
  `examples/yamls/full_experiment_test_v3.yaml`. Our local fixture has
  the fixes applied; upstream may still have them.
- **Codex review artifacts** for this session live in `.codex-review/`
  (gitignored). The reconciliation reports are inlined into
  `docs/development/v3-d4-design-reviews.md` for the D4 work, and this
  handoff captures the Phase 4 diff review. The raw outputs are
  ephemeral — re-run Codex if you need them.

---

## 9. Open questions for the next session

1. **Confirm Tier 1 (cleanup PR) is the right first move.** My
   recommendation is yes — the event-listener bug surfaces in normal use
   and the rest are cheap rides along with it.
2. **Phase 5 design pass needed?** The original plan covers Phase 5 in
   broad strokes but a Codex plan-review pass on a written-out design
   would be worth ~30 min before starting. Anchor binding popover and
   rename cascade have non-obvious failure modes (especially rename
   cascade — needs an "impacted aliases" enumeration similar to what
   D4's design has).
3. **Should the v3 designer status badge change?** Footer says "v0.8 |
   2026-05-27 17:28 ET" and the page header says "BETA / EDITOR". With
   sequence editing complete + working in production-like state, the
   lab might consider it ready for daily use. User judgment.
4. **What to do with the old `v3-editor-handoff.md`?** Replace with this
   doc, or keep both? My instinct: replace, with a short "superseded
   2026-05-27" stub pointing here.
