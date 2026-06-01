# v3 Experiment Designer — Handoff for Next Session (Round 2)

**Last updated:** 2026-06-01
**State:** D4 (cross-library import) shipped — M1+M2 (#84) and M3 UI (#85) merged to `main`. M4 (polish + docs) in progress.
**Editor version:** v3 Experiment Designer **v0.16** (M4 → v0.17)
**`main` HEAD:** `5bf08f4` (Merge #85) — D4 M1–M3
**Pinned upstream:** maDisplayTools `origin/version3` at `649d7ef`

This is the live handoff for the v3 designer. It supersedes the original
`v3-editor-handoff.md` (which covered up to v0.2). Read this FIRST in a new
session — it has the current state, what's left, the implementation crib-sheet,
and the known gotchas.

---

## 0. TL;DR

The v3 designer is **feature-complete for single-document editing** AND now ships
**D4 (cross-library import)** — Phases 1–7 plus D4 M1–M3 are merged to `main`.
Tests green at **arena 10/10, v2 137/137, v3 576/576**.

Live: <https://reiserlab.github.io/webDisplayTools/experiment_designer_v3.html>

**D4 is done** (M1 cross-doc primitives, M2 staging + commit, M3 three-pane UI;
M4 = polish + docs). The D4 reference now lives in **CLAUDE.md → "v3 Experiment
Designer — D4 Cross-Library Import"** plus the three `v3-d4-*` docs. What remains
is polish: a MATLAB-validation doc, a quickstart page, optional tech-debt. See §3.

If the next session is short, good quick wins are in §3 Tier 5 / §4.

---

## 1. Architectural notes (forward-looking)

The Phase-4 Codex review (2026-05-27) flagged four landed bugs — event-listener
accumulation on `#sequenceList`, stale `selection.index` on move/insert, ruler
ticks decoupled from clamped step widths, and block→ref convert dropping
`_unknownKeys`. **All four (plus the two minor follow-ups) were fixed in the
Phase 4 cleanup** that shipped inside #77. Tests cover the `repetitions`
validation (Suite 10b); the UI fixes were verified manually.

Two non-blocking concerns from that review remain worth watching:

**Path-based mirror model is showing strain.** ~23 `doc*` helpers each manage
the same dance: mutate `_doc`, mirror into the JS model, preserve comments +
unknown keys, update selection, set dirty, render the right panes, push undo at
the right time. Two of the Phase-4 bugs were "many edit paths, no centralized
consistency gate." Codex-adv's suggestion is a single
`applySequenceEdit(experiment, op)` reducer that validates pre/post and
centralizes the bookkeeping. **Don't refactor preemptively** — the trigger is
the first feature that can't fit the current pattern, most likely **D4**.

**Timeline scale: many DOM nodes for large protocols.** `flattenSequence`
expands every repetition × trial; a 30-condition × 20-rep protocol is 600+
cells. Fine at current lab scale (dozens × a few reps); worth bounding once a
stress test reveals the cliff.

---

## 2. What's shipped (Phases 1–7)

| PR | Description | Version |
|---|---|---|
| #62–#69 | Phase 1–3 + Tiers 1–3 (viewer, parser, inspector edits, command CRUD, inline ref view, plugin head/param edits, export warnings, vendored yaml, library add/dup/blank) | v0.1–v0.7 |
| #70–#74 | Phase 4 — sequence reorder, +Ref/+Block, drag library→sequence, block trial editing, timeline ribbon, ref↔block convert, missing-trial create | v0.8 |
| **#77** | Phase 4 cleanup (the 4 Codex bugs) + **Phase 5 Variables editor** + **Phase 6 validation modal / Reset / library delete** | v0.9 → v0.11 |
| **#78** | **Phase 7 test hardening** + **validation error line numbers** + modal double-bullet fix | v0.12 |
| #81 | Toolbar-reflow + editable-settings fixes | v0.13 |
| **#84** | **D4 M1** (cross-doc primitives + node helpers) + **D4 M2** (staging buffer + commit pipeline; suites N1–N10) | v0.14 → v0.15 |
| **#85** | **D4 M3** — three-pane cross-library import UI (`renderConditionList` extraction, import-mode swap, locking) | v0.16 |

### What the editor can do today (v0.12)

Everything from v0.8 (round-trip any v3 YAML with anchors/comments/formatting
preserved; command CRUD; plugin head/param edits; inline ref view; full
sequence editing — reorder, +Ref/+Block, drag library→sequence, block trial
editing, ref↔block convert, missing-condition create; timeline ribbon with
cumulative-time ruler; undo/redo; soft-warn export banner; unknown-key
passthrough; 10 demo fixtures), **plus**:

- **Variables editing (Phase 5).** Inline Variables table in Settings — anchor
  name + value editable; rename **cascades** to every `*alias` as one undo step;
  ✕ delete with cascade-unbind; `+ Add` row. Complex map/seq anchors render as
  read-only "complex anchor" badges (round-trip intact, edit YAML by hand).
- **🔗 anchor-binding popover** on every editable scalar — bind-to-existing
  (type-mismatched options disabled), create-and-bind, rebind, unbind, and an
  "Edit in Variables…" jump.
- **Pre-export validation modal (Phase 6).** Export runs `collectBlockingErrors`
  first; blocking errors show a modal (with **source line numbers** for anchor
  errors) and an "Export anyway" escape hatch. Soft warnings stay non-blocking.
- **Reset button** — clears to the blank skeleton; reversible (one Undo restores).
- **Library-row delete (✕)** — blocked while a condition is in use.
- **Toolbar no longer reflows on first edit (v0.13 fix).** The `● edited`
  badge moved to the LEFT cluster (before the flex spacer). Previously it sat
  among the action buttons and `display:none→inline-block` shoved Undo/Redo/
  **Reset** ~83px left on the first edit, so a click on Reset after editing
  missed it — the "create-anchor then Reset both fail" report. Both features
  always worked; the clicks were landing on shifted-away buttons.
- **Editable Settings (v0.13).** Experiment Info (name/date_created/author/
  pattern_library) and the Rig path are editable text fields (`docSet` on
  `['experiment_info', k]` / `['rig']`; blank info fields `docDelete`). Rig has
  a **Browse…** helper that fills in the picked filename while preserving the
  directory prefix — browsers can't read full filesystem paths, so the path is
  ultimately text. **Plugins stay read-only**: per the v3 spec the protocol's
  `plugins:` list is self-contained and the rig is a separate file MATLAB loads,
  which the web tool can't read off disk (no rig-plugin inheritance in-tool).

### Known by-design constraints (not gaps)

- **Plugins are not editable in-tool / not inherited from the rig file.** The
  rig path is a string MATLAB resolves; the browser has no access to that file.
  Editing plugin entries is a YAML-by-hand task (or a future cross-file feature
  like D4).

- Complex anchors (map/seq, merge keys `<<: *foo`) are read-only in the UI.
- Randomized blocks show a *sample* order in the timeline, labeled "randomized."
- Validation **line numbers** cover anchor errors only — structural errors
  (`validateReferences`) are model-based (no node handle), and dangling-alias
  errors make the doc non-serializable so they fall back to line-less. See §3.

---

## 3. What's left to do

Phases 1–7 are done. Remaining work, by size:

### Tier 4: D4 — cross-library import ✅ SHIPPED (M1–M3 merged; M4 in progress)

Pull conditions (+ their anchors and plugin declarations) from one protocol into
another. **Done across #84 (M1+M2) and #85 (M3).** Reference:
**CLAUDE.md → "v3 Experiment Designer — D4 Cross-Library Import"**, plus
`docs/development/v3-d4-design.md` (rev 3),
`docs/development/v3-d4-implementation-handoff.md`, and
`docs/development/v3-d4-design-reviews.md`.

How it landed vs. the original plan:
1. Rev-2→rev-3 fix list applied; a fresh `codex-plan-review` pass ran before M1.
2. Plugins **merge by default when class+config match** (Codex-adv's point);
   anchors namespace by default.
3. The `applySequenceEdit` reducer refactor (§1) was **NOT** needed — the staging
   buffer stayed self-contained and commits via the documented node primitives
   (design §13). The path-based mirror model held.
4. **M4 (this milestone):** `beforeunload` guard during import mode + these doc
   updates + footer bump. That completes D4 v1.

Explicitly **out of scope for D4 v1** (design §12): sequence/block-membership
import, multi-doc YAML streams, pattern-path validation, a per-anchor
"merge with existing" toggle. Candidates for a future v1.1.

### Tier 5: polish

- **Phase 8** — write `docs/development/v3-matlab-validation.md` describing the
  MCP-driven flow that confirms web output loads in MATLAB (the original Phase 1
  gate item 4, deferred).
- **Phase 9** — `experiment_designer_v3_quickstart.html`, a step-by-step
  walkthrough modeled on `experiment_designer_quickstart.html` (the v2 one).
- **Phase 7 leftovers** (optional): params-level anchor cases, deeper
  validation-error matrices. Core Phase 7 shipped in #78 (Suite 31).

### Small / optional

- **Validation line numbers for structural + dangling errors** — currently
  anchor-only. Structural errors would need node handles threaded through
  `validateReferences`; dangling errors are line-less by nature (see §2).
- **Helper-model refactor** — defer until D4 forces it (§1).
- **Timeline performance cap** for >200 flattened steps — none today (§1).
- **Drop the "Beta / Editor" badge** ([experiment_designer_v3.html](../../experiment_designer_v3.html), ~line 1050)
  now the editor is feature-complete and production-verified. One-line change;
  user judgment.

---

## 4. Open decisions for the user

1. **D4 — go / no-go and when?** It's the last big feature and a real
   architectural lift. Worth confirming the lab actually wants cross-library
   import before the ~5-day investment.
2. **Drop the Beta badge?** The editor is feature-complete for single-doc
   editing and has been browser-verified. User call.
3. **Architectural refactor timing** — recommendation stands: defer the
   `applySequenceEdit` reducer until D4 demands it.

---

## 5. Implementation patterns (crib sheet)

### YAML.Document as single source of truth

- `experiment._doc` is the YAML.Document. The JS model (`experiment.conditions`,
  `.sequence`, `.variables`, `.plugins`) is a derived mirror.
- **All mutations** go through helpers in `js/protocol-yaml-v3.js`
  (~23 `doc*` mutation helpers + ~9 inspection helpers).
- Export = `experiment._doc.toString()`. No constructive-emit path.

### Helpers (alphabetical)

Mutation: `docAddPluginParam`, `docAppendSequenceEntry`, `docBindToAnchor`,
`docCloneCondition`, `docCreateVariable`, `docDelete`, `docDeletePluginParam`,
`docDeleteVariable`, `docInsertCommand`, `docInsertCondition`,
`docInsertSequenceEntry`, `docInsertTrialInBlock`, `docMoveCommand`,
`docMoveSequenceEntry`, `docMoveTrialInBlock`, `docRemoveSequenceEntry`,
`docRemoveTrialFromBlock`, `docRenameVariable`, `docReplaceSequenceEntry`,
`docSet`, `docSetPluginCommandHead`, `docSetVariableValue`, `docUnbindAnchor`.

Inspection / validation: `nodeIsAliasAt`, `aliasNameAt`, `anchorExists`,
`findAliasesTo`, `isValidAnchorName`, `variableIsComplex`,
`collectExportWarnings` (soft, non-blocking), `validateReferences` (structural
errors), `collectBlockingErrors` (blocking pre-export gate — composes
`validateReferences` + duplicate-anchor + dangling-alias CST checks, with line
numbers via a `YAML.LineCounter` re-parse of `_doc.toString()`).

### Helper anatomy (template)

```js
function docXxx(experiment, ...args) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docXxx: experiment has no _doc handle', 'NO_DOC');
    }
    if (badInput) throw new V3ParseError('docXxx: ...', 'BAD_PATH' | 'INVALID_INPUT');
    const node = experiment._doc.getIn([...path], true);
    if (!node || !validShape(node)) {
        throw new V3ParseError('docXxx: doc/model divergence', 'DOC_MODEL_DIVERGENCE');
    }
    // mutate the doc side, then mirror into the JS model
}
```

UI call site:

```js
function onUserAction(...) {
    pushUndo();                  // BEFORE the mutation
    try {
        docXxx(experiment, ...);
        setDirty(true);
        // walk selection.index through any insert/remove/move displacement!
        renderAll();
    } catch (err) {
        showError('...', err.message);
    }
}
```

For destructive/wide-reaching actions, gate with
`confirmModal({title, body, list, confirmLabel, cancelLabel}) → Promise<bool>`
(backdrop/Escape = cancel, Enter = confirm). Used by rename cascade,
cascade-unbind delete, Reset, and the export validation modal. Its `<li>` list
suppresses the disc marker; callers prefix items with a literal `• `.

### Undo/redo

Text-snapshot based: `_doc.toString()` + JSON snapshot of `selection`. Undo
re-parses via `parseV3Protocol`. `pushUndo()` runs BEFORE every mutation;
`_restoring` guard stops re-render-during-restore from polluting the stack;
`UNDO_LIMIT = 50`. `loadYamlText(text, name, { keepUndo })` skips the usual
`clearUndo()` so Reset stays undoable.

### State coherence after mutations

- `renderAll()` — everything; always correct (used by sequence mutations).
- For sequence mutations also: walk `selection.index` through shifts, `setDirty(true)`,
  `pushUndo()` before.

---

## 6. Files that matter

| File | Purpose |
|---|---|
| `experiment_designer_v3.html` | The editor (HTML + CSS + module script). ~4,200 lines. Footer carries the version + ET timestamp (bump on every change). |
| `js/protocol-yaml-v3.js` | Parser, generator, validators, ~23 edit helpers. ~1,970 lines. |
| `js/plugin-registry.js` | Plugin command schemas + v3 lookup helpers. |
| `js/vendor/yaml/browser/dist/` | Vendored `yaml@2.9.0` (no CDN dependency). |
| `tests/test-protocol-roundtrip-v3.js` | **467** v3 tests across 31 suites. |
| `tests/fixtures/v3_*.yaml` | 10 demo fixtures (the Load-demo dropdown). |
| `docs/development/v3-spec.md` | Designer-side spec (anchors, comments, constraints). |
| `docs/development/v3-d4-design.md` / `…-reviews.md` | Deferred D4 design + review/fix list. |
| `docs/development/v3-editor-handoff.md` | Superseded original handoff (v0.2). |
| `.claude/nocache-server.py` | **Untracked.** No-cache static server for browser verification (see §7). |

---

## 7. How to verify after changes

```bash
npm test     # arena 10/10, v2 137/137, v3 467/467+
```

Browser verification via the `preview_*` MCP tools (or a local server):

1. Load a demo fixture (e.g. `v3_canonical_a.yaml`) via the Load-demo dropdown.
2. Exercise the change; check `preview_console_logs` for errors.
3. Make an edit elsewhere → confirm one Undo restores correctly.
4. Export → diff against the original → only the intended change appears;
   anchors and comments preserved.

> **Caching gotcha (important).** `python -m http.server` lets the browser
> heuristically cache `js/*.js`. Because the editor is an ES module, a stale
> cached `protocol-yaml-v3.js` makes an `import` fail and **silently kills the
> whole module** (no handlers, empty library — the symptom looks like a total
> breakage). Use `.claude/nocache-server.py` (untracked, in the repo) which
> sends `no-store`; if the browser already cached the old origin, serve on a
> **fresh port** (it's a new origin → no cache hit). `.claude/launch.json`
> points the preview server at this script.

Pages auto-deploys from `main` (~30s after merge; hard-refresh on first load).

---

## 8. External state to be aware of

- **maDisplayTools `origin/version3`** pinned at **`649d7ef`**. Authoritative
  spec: `docs/development/yaml_protocol_documentation_v3.md` on that branch.
- **Lisa** was notified (earlier session) about 3 syntactic typos in her
  `examples/yamls/full_experiment_test_v3.yaml`; our local fixture has the
  fixes, upstream may not.
- **Codex review artifacts** are gitignored under `.codex-review/` (ephemeral —
  re-run if needed). D4 reconciliations are inlined into
  `v3-d4-design-reviews.md`.
- `.claude/` (launch config, no-cache server) is **untracked** — never commit it;
  add only explicit files.
