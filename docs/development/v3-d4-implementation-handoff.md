# D4 — Cross-Library Import ("library copy"): Implementation Handoff

**Purpose:** the executable handoff to *build* D4 — the last big feature in the
v3 Experiment Designer. It distills the design into milestones with concrete
completion gates so a fresh session (or a self-paced dynamic workflow) can pick
it up and drive it to done.

**Read these first, in order:**
1. This file (what to do, in what order, with done-gates).
2. `docs/development/v3-d4-design.md` (rev 2) — the full substrate + algorithm. **Authoritative for detail.**
3. `docs/development/v3-d4-design-reviews.md` — the Codex review history + the rev-2→rev-3 fix list.
4. `docs/development/v3-editor-handoff-2.md` §5 — implementation patterns (mirror model, helper anatomy, undo).

**Editor state:** v0.13 on `main`. **Prerequisites met:** Phase 4 (sequence
drag/drop) and Phase 5 (Variables editor + rename cascade) both shipped — D4's
"prefix clutter is fixable in-tool" mitigation now holds. Tests: arena 10, v2
137, v3 467.

---

## 0. What D4 is

Let the user open a *second* "theirs" YAML (a sibling lab's protocol, or an
older version of their own), browse its conditions side-by-side, and **copy
selected conditions into "yours"** — bringing along the anchors and plugin
declarations those conditions depend on, preserving comments/formatting.

This is the editor's first feature where **two parsed `YAML.Document`s coexist
in memory**. That's why it needs a design doc: anchors are document-local, so
copying a condition means cloning its node tree across docs and rewiring every
alias. See design doc §1.

---

## 1. Before writing any code (do these first)

1. **Re-run a Codex design pass on rev 3.** The design on the shelf is rev 2.
   Apply the fix list (§2 below) to produce rev 3 in `v3-d4-design.md`, then
   run the `codex-plan-review` skill on it. The design has non-obvious failure
   modes (cross-doc alias rewiring, topological insert order); a fresh review
   before Milestone 1 is cheap insurance.
2. **Confirm the substrate is unchanged.** Staging buffer (Option B) +
   module-first split (`js/v3-import.js`) + namespaced-default for
   anchors/plugins are settled. Don't relitigate unless something forces it.
3. **Decide the architectural refactor question.** The `applySequenceEdit`
   reducer (handoff-2 §1) is *not* required for D4 if staging stays isolated
   (it commits via documented primitives and never invents new undo/selection
   paths — design §13). Recommendation: **do not** refactor first; keep staging
   self-contained. Revisit only if commit logic starts duplicating mirror
   bookkeeping.

---

## 2. Rev-2 → rev-3 fix list (MUST apply before/while coding)

From `v3-d4-design-reviews.md`. These are corrections to the rev-2 design:

1. **Commit rewrites the cloned condition's `name:` field** to `targetName`
   (rev 2 forgot this; mirror would diverge from YAML). Mirror `docCloneCondition`.
2. **One shared `aliasRewriteMap`** across the condition AND all its value-node
   clones — not an empty map per clone. Build it once after the closure walk.
3. **Topological sort** imported anchors by dependency order before insertion
   (yaml@2 requires an alias to appear *after* its anchor at stringify time).
4. **Per-batch dependency registry** (anchors + plugins shared across all staged
   items) — not per-item, or two staged conditions referencing `&dur_short`
   insert two copies.
5. **Visited-set cycle detection**, not a depth cap (depth-10 rejects a
   legitimate 11-anchor chain and doesn't actually prevent cycles). Track
   visited anchor names/node identities in a Set.
6. **Block broken-alias source YAMLs at enter-import-mode** (drop the
   "informational" framing — `parseV3Protocol` calls `toJS()` which throws on
   unresolved aliases, so a broken source can't even enter import mode).
7. **Block alias-bound `plugin_name` at staging time** for v1 (e.g.
   `plugin_name: *camera_plugin`) — namespacing the declaration but leaving the
   alias resolving to the old name strands the reference.
8. **Lock via UI event handlers, not global `pushUndo()` suppression** — commit
   itself calls `pushUndo`, so a global lock breaks commit's own undo snapshot.
9. **Fix `sortedJson`** pseudo-code (recursive key sort) if structural equality
   is kept for the plugin-merge path.
10. **Cross-buffer name collision check** (prefixed plugin name already present).
11. **Adopt plugin-merge-by-default** (the big one — see §3). Redesign design-doc
    §5/§6 around it.

---

## 3. The plugin/anchor asymmetry (rev-3 decision — adopt it)

- **Anchors namespace by default.** They're data aliases — safe to prefix
  (`&dur_short` → `&sibling__dur_short`). No value comparison needed.
- **Plugins MERGE by default when `matlab.class` + `config` match**, namespace
  only on mismatch. Plugins are *runtime resources* representing physical
  hardware (cameras, controllers, serial ports). Duplicating `camera` →
  `sibling__camera` doesn't isolate hardware — both entries may point at the
  same device, and two declarations for one device is a real runtime bug.
- Cost: a small structural-equality path scoped to plugins only
  (`yamlNodeStructuralEquals` + `sortedJson`). That's why fixes #9/#10 matter.

---

## 4. Pre-answered open questions (so a dynamic run isn't blocked)

Design §11 left these open. Defaults for autonomous execution — change only if
the user objects:

1. **Prefix derivation:** filename → `<sanitized_stem>__` (e.g.
   `sibling_lab.yaml` → `sibling_lab__`). Editable at enter-import.
2. **Anchor "merge with existing" opt-in:** **defer to v1.1.** Ship
   namespaced-default for anchors; the per-anchor merge toggle is extra surface.
   (Plugin merge-by-default from §3 still ships — it's not optional.)
3. **Bulk prefix override:** **persist** per-item name overrides across a prefix
   change (respect explicitly-typed names).
4. **Sequence auto-add bare refs:** default **ON**, with the lossy-context label:
   "Append bare refs to sequence (source block/repetition context is not
   preserved)."
5. **Imported plugin command not in the registry:** import as-is + **soft
   warning at commit** (informational, non-blocking).

---

## 5. Milestones with completion gates

Each milestone is independently committable and has a machine-checkable gate.
**Commit + open a PR per milestone** (keeps reviews focused; matches repo flow).
Bump the footer version each PR.

### Milestone 1 — Cross-doc primitives + node-based helpers (~1 day)

**New module `js/v3-import.js`:** `collectAliasReferences`, `resolveAlias`
(via `alias.resolve(doc)` — NOT name lookup), `cloneNodeAcrossDocs`
(shared rewrite map per fix #2), `yamlNodeStructuralEquals`, `sortedJson`
(fix #9). **Into `js/protocol-yaml-v3.js`:** `ensureTopLevelSection`,
`docInsertConditionNode`, `docInsertVariableNode`, `docInsertPluginNode`
(node-based — preserve comments/aliases, unlike the JS-object-building
`docInsertCondition`). Export from all surfaces (ProtocolV3 object, named
export, and `js/v3-import.js` needs its own export pattern + a test `require`).

**Gate:** `npm test` green with new suites N1–N6 (design §10): cross-doc clone
with rewrite, last-wins alias resolution, transitive walks, insert into
existing/absent `variables:`, round-trip stable. Target ~25–35 new checks.

### Milestone 2 — Staging buffer + commit pipeline (no UI) (~1.5 days)

**In `js/v3-import.js`:** `createStagingBuffer`, `addToStaging` (computes the
import plan: closure walk with visited-set cycle detection #5, per-batch
dependency registry #4), `removeFromStaging`, `setStagingPrefix` (recompute
planned names; persist overrides #4-defaults), `setItemTargetName`,
`commitStaging` (applies design §5 step 5 — including the `name:` rewrite #1,
topological anchor insert #3, plugin merge-by-default #3, `plugin_name` rewrite,
alias-bound `plugin_name` block #7). Preflight: reject duplicate-anchor sources
#6.

**Gate:** `npm test` green with suites N7–N10: build staging in Node, add/adjust/
commit, assert `yours._doc.toString()`; every edge case (no `variables:`, no
`plugins:`, zero-alias condition, depth-3 anchor chain, condition-name collision,
plugin namespace collision, plugin merge-when-equal, unknown command type,
broken-alias preflight rejection). This is the substrate — **most of D4's risk
lives here, fully testable without a browser.** Target ~40+ new checks.

### Milestone 3 — Three-pane import UI + interactions (~2 days)

**In `experiment_designer_v3.html`:** "Import conditions from another YAML…"
button + file picker; `enterImportMode` / `exitImportMode` / `commitImport`;
layout swap to the three-pane import view (design §8) in the existing DOM zones;
extract `renderConditionList(conditions, opts)` and refactor existing
`renderLibrary` to use it (Codex flagged `renderLibrary` as too tightly bound —
budget ~½ day); `renderTheirsLibrary` / `renderStagingBuffer` /
`renderStagingItemInspector` / `renderTheirsPreview`; inspector edit forms
(target name, per-anchor/plugin name, bulk prefix); locking via UI handlers (#8 —
disable `+ Add` / `dup` / inspector / Export while `staging.locked`).

**Gate:** browser-verified via `preview_*` (see §6 caveats): clean import →
commit; condition-name collision → resolve → commit; anchor lands namespaced in
`variables:`; plugin merges when class+config match; cancel → no mutations; undo
after commit → one-step revert; lock blocks `+ Add`/Export. Zero console errors.

### Milestone 4 — Polish + docs (~½ day)

`beforeunload` during import mode; CLAUDE.md + handoff-2 updates; footer bump.

**Total: ~5 days realistic.**

---

## 6. Verification notes (learned the hard way)

- **`npm test` is the load-bearing gate.** Milestones 1–2 are ~70% of D4's risk
  and are 100% Node-testable. Prioritize them; don't rush to UI.
- **Browser verification caching trap:** the editor is an ES module — a stale
  cached `js/*.js` makes an `import` fail and silently kills the whole module
  (empty library, dead handlers; looks like total breakage). Use
  `.claude/nocache-server.py` (untracked) on a **fresh port** for preview
  checks. See handoff-2 §7.
- **Coordinate drift in screenshots is real** — verify clicks landed (probe the
  handler) rather than trusting "clicked successfully"; prefer element refs over
  hardcoded coordinates. (A dirty-state badge once shifted the toolbar 83px and
  caused false "button broken" reports.)

---

## 7. Running this as a self-paced (dynamic) workflow

D4 suits a `/goal`-style autonomous run because each milestone has a crisp,
machine-checkable completion condition (`npm test` green + specific new suites).

Suggested loop, one milestone at a time:
> Goal: "Implement D4 Milestone N per `docs/development/v3-d4-implementation-handoff.md`
> and `v3-d4-design.md`. Done when `npm test` passes with the milestone's new
> test suites present and green, the milestone's gate (§5) is met, and a PR is
> open. Apply the rev-3 fix list (§2). Commit per milestone."

- Works in **both the Claude Code desktop app and the CLI** — but the machine +
  session must stay running (closing either stops the run). For truly unattended
  background work, use a Routine / scheduled task / GitHub Action instead.
- Milestones 1–2 (pure logic + Node tests) are the best candidates for a
  hands-off run. Milestone 3 (UI) benefits from human spot-checks because the
  preview tooling is flaky and browser bugs are easy to miss.
- Keep undo/selection/validation paths centralized — do NOT let the staging
  buffer fork a parallel architecture (design §13).

---

## 8. Files

| File | Role |
|---|---|
| `js/v3-import.js` | **New.** Cross-doc primitives + staging buffer + commit pipeline. Dual-export so Node tests + the HTML both load it. |
| `js/protocol-yaml-v3.js` | Add `ensureTopLevelSection`, `docInsert{Condition,Variable,Plugin}Node`. |
| `experiment_designer_v3.html` | Import button, mode swap, three-pane UI, `renderConditionList` extraction, locking. |
| `tests/test-protocol-roundtrip-v3.js` (or a new `tests/test-v3-import.js`) | Suites N1–N10. |
| `docs/development/v3-d4-design.md` | Update to rev 3 (apply §2 fix list) before coding. |
| `tests/fixtures/v3_*.yaml` | May need a sibling-source fixture with anchors + plugins for import tests. |

---

## 9. Definition of done (whole feature)

- All four milestones merged to `main`; `npm test` green (467 + ~80 new D4 checks).
- Browser-verified: import a sibling YAML, copy a condition with anchors +
  plugins, commit, undo, re-import — all clean, comments/anchors preserved.
- Plugins merge when class+config match; anchors namespace by default.
- CLAUDE.md + handoff-2 document the flow; footer reflects the new version.
- Design doc is rev 3 (fix list applied) and matches what shipped.
