# D4 design — Codex cross-review (preserved)

This document preserves the round-2 Codex pressure-test of `v3-d4-design.md` so
the synthesis isn't lost when D4 is picked back up. Two rounds of review ran
on the design before it landed on the shelf.

**Status outcome (2026-05-27):** D4 deferred. Pivoting to Phase 4 (sequence
drag/drop) first; the design + this review history sit on the shelf until the
order is reassessed.

---

## Evolution from rev 1 → rev 2 (round 1 review)

The first version of `v3-d4-design.md` proposed a **merge-by-default** import:
when an imported condition references `&dur_short` and the user's doc also has
`&dur_short`, the design tried to detect equality (structural comparison) and
either merge or rename. Round 1 review caught:

- The anchor-resolution API was wrong — used name-based lookup instead of
  `alias.resolve(doc)`, which would silently bind to the wrong anchor value on
  duplicate names.
- `NodeBase.toJS()` requires a document argument; the equality check would have
  thrown.
- `docInsertCondition` (existing) builds nodes from JS objects, destroying
  imported comments and aliases. Needed new node-based helpers.
- Missing helpers for `variables:` and `plugins:` sections (and creating them
  when absent — `v3_no_variables.yaml` fixture proves the need).
- "Cross-condition trial reference" conflict was wrong scope (blocks/intertrials
  live in `experiment:`, not `conditions:`).
- "Pattern-missing" conflict had no source-of-truth — there's no validator for
  pattern-library contents in the current codebase.
- Bigger product question from Codex-adv: anchor name collisions in cross-lab
  YAMLs are usually **semantic** (same name, mechanically different value), not
  cosmetic. Silent merge by name+value equality is the worst-case footgun.

Rev 2 switched the product shape to **namespaced-default**: imported anchors
get a source-filename prefix (e.g., `&sibling_lab__dur_short`), imported plugins
get the same treatment, imported conditions keep their names (with suggested
suffix on collision). Eliminates the entire "value equality merge" path. Also
applied all the API fixes, dropped the wrong-scope conflicts, moved staging
into a new `js/v3-import.js` module so Node tests can exercise it, and bumped
realistic milestone estimates from 3 days to 5.

Rev 2 is the current state of `v3-d4-design.md`.

---

## Round 2 reconciliation (against rev 2 — the current doc)

### Where all three voices agree

- **Staging-buffer substrate (Option B) is correct.** Settled in round 1; no
  revision needed in round 2.
- **Cycle detection must use a visited-set, not depth-cap.** Rev 2's depth-of-10
  cap would reject a legitimate chain of 11 anchors and doesn't actually prevent
  cycles. Fix: track visited anchor names (or source node identities) in a Set
  and break when revisiting.
- **Per-batch dependency tracking, not per-item.** If two staged conditions
  reference the same source anchor `&dur_short`, the per-item `anchorsToImport`
  in rev 2 would try to insert two copies. Need a global dependency registry
  across the whole batch.

### New bugs in rev 2 (Codex-std caught)

- **Commit step doesn't rewrite the cloned condition's `name:` field.** Rev 2
  §5 step 5 clones the condition node, rewires aliases, splices in. But it
  never rewrites the cloned node's `name:` from `originalName` to `targetName`.
  The JS mirror would say `arena check_2` while the YAML still has
  `name: "arena check"`. Existing `docCloneCondition` has this rewrite — D4
  needs the same.
- **Transitive anchor cloning uses an empty rewrite map.** Rev 2 calls
  `cloneNodeAcrossDocs(srcValueNode, yoursDoc, {})` for value-node clones — but
  the value nodes themselves may contain aliases that need rewriting too. The
  fix: build `aliasRewriteMap` once after the closure walk completes; use the
  same map for the condition AND all of its value-node clones.
- **Aliases must appear after their anchors in document order.** yaml@2 enforces
  this at stringify time. Rev 2's closure walk produces
  dependency-after-dependent insertion order naturally (we walk the condition
  first, then its anchors, then their nested anchors), so insertion needs an
  explicit topological sort.
- **"Broken alias = informational" is impossible.** `parseV3Protocol` calls
  `doc.toJS()` immediately, which throws on unresolved aliases at the source.
  So a source with a broken alias would never even enter import mode. Make
  broken source aliases a hard-block, drop the "informational" framing.
- **`plugin_name` can itself be alias-bound.** If a condition has
  `plugin_name: *camera_plugin` and the anchor's value is the literal string
  `"camera"`, namespacing the *declaration* to `sibling__camera` but leaving
  the alias resolving to `"camera"` means the condition references a plugin
  that doesn't exist. Block this case at staging time for v1.
- **Lock should guard UI handlers, not `pushUndo()` globally.** Rev 2 said
  `pushUndo` triggers respect the import lock — but commit *itself* calls
  pushUndo. Globally locking pushUndo would break commit's own undo snapshot.
  Lock via UI event handlers instead.

### Bigger product question (Codex-adv pushed hard)

- **Plugin namespacing as default is the wrong call (vs anchors).** Anchors are
  data aliases — safe to namespace. Plugins are *runtime resources* representing
  physical hardware (cameras, controllers, serial ports). Duplicating `camera`
  → `sibling__camera` doesn't isolate the hardware; both YAML entries might
  point at the same physical device. Two declarations for one device is a real
  runtime problem.
  - **Recommendation:** anchors namespace by default; plugins *merge* by default
    when `matlab.class` + `config` match, namespace only on mismatch. This
    asymmetry is honest — anchors and plugins have different operational
    semantics. Cost: brings back a small structural-equality path scoped to
    plugins only.

- **Auto-add bare refs to sequence loses block/repetition/intertrial context.**
  Source condition may have run with `repetitions: 3` and `randomize: true` in
  its original sequence; auto-bare-ref strips all of that. Don't change the
  default (orphan conditions are worse), but make the lossy nature visible in
  the checkbox label: "Append bare refs to sequence (source block/repetition
  context is not preserved)."

- **Defer D4 until Phase 5 (Variables editor + rename cascade) ships.** D4
  creates the cleanup problem that Phase 5 solves. Doing them in the right
  order (Phase 5 first) means D4's prefix-noise is fixable in-tool. Doing D4
  first means users live with permanent prefix clutter until Phase 5 ships.
  - This is the strongest scope-level argument from round 2. Combined with
    "Phase 4 (drag/drop) is also a more universally-needed feature," the case
    for **pivoting to Phase 4 then Phase 5 first** is strong. That's the
    decision recorded at the top of this doc.

### Fix list that must apply before any D4 code lands

Even if D4 is picked up later and the rev 2 substrate is retained, the design
doc itself needs these corrections first:

1. Commit must rewrite the cloned condition node's `name:` field to `targetName`.
2. `cloneNodeAcrossDocs` must use the *same* `aliasRewriteMap` across the
   condition AND all of its value-node clones — not empty maps for each.
3. Topological sort of imported anchors by dependency order before insertion.
4. Per-batch dependency registry (anchors + plugins shared across staged items,
   not per-item).
5. Visited-set cycle detection (not depth-cap).
6. Block broken-alias source YAMLs at enter-import-mode (probably already
   happens via parse-throw).
7. Block alias-bound `plugin_name` at staging time.
8. Lock via UI handlers, not via global `pushUndo()` suppression.
9. Fix `sortedJson` pseudo-code (if structural equality is kept for plugin
   merge).
10. Add cross-buffer name collision check.
11. **If plugin-merge-by-default is adopted** (recommended), redesign §5 and §6
    around it. Anchors namespace by default; plugins merge when class+config
    match.

### What to do when D4 is picked up again

1. Re-read `v3-d4-design.md` (rev 2) — the staging buffer + module-first split
   + namespaced-anchor default are still the right substrate.
2. Apply the fix list above to produce rev 3.
3. Adopt the plugin-merge-by-default asymmetry.
4. **Verify Phase 4 (sequence drag/drop) and Phase 5 (Variables editor + rename
   cascade) ship first** — D4's biggest mitigations depend on them.
5. Re-run Codex on rev 3 before starting Milestone 1.

---

## Why this artifact exists

The raw Codex outputs lived under `.codex-review/` (gitignored). Without checking
the synthesis into the repo, the analysis would have been lost the moment the
branch was deleted or the working tree wiped. Future sessions that touch D4 can
read this doc + `v3-d4-design.md` and pick up exactly where round 2 left off,
without re-deriving the substrate decisions from scratch.
