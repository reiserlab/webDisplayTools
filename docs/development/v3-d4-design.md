# D4 — Cross-Library Import Design Doc (revision 2)

**Status:** **DEFERRED** (2026-05-27). Phase 4 (sequence drag/drop) takes
priority; D4 will be reassessed after Phase 4 + Phase 5 (Variables editor +
rename cascade) ship. See `v3-d4-design-reviews.md` for the round-2 review
that drove the deferral.

**When D4 is picked up again, this doc still needs corrections.** The fix list
is in `v3-d4-design-reviews.md` — read that *before* using this doc as the
implementation spec. The biggest one: plugin namespacing should NOT be the
default; plugins should merge-when-class+config-match.

**Owner:** Next session that touches D4.
**History:**
- rev 1 (2026-05-27): merge-by-default, monolithic helpers, optimistic milestones.
- **rev 2 (2026-05-27, current):** namespaced-default, module-first helpers, alias-node API, transitive closure, revised milestones.
- Round 2 review (2026-05-27): caught further bugs (see `v3-d4-design-reviews.md`); D4 deferred.
**Supersedes:** the D4 sketch in `docs/development/v3-editor-handoff.md` (lines 209–260).

---

## 1. Why we're stopping to design

D4 is the editor's first feature where *two parsed `YAML.Document`s coexist in memory simultaneously*. Every previous feature mutates one document at a time. D4 lets the user open a *second* "theirs" YAML, browse its conditions side-by-side, and copy selected ones into "yours."

This crosses a substrate boundary because:

- **`yaml@2`'s anchors are document-local.** A `&dur_short` in `theirs._doc` is unrelated to a `&dur_short` in `yours._doc`. The `Alias` node `*dur_short` carries only a string `source` — it dangles the moment its containing node lands in a different document.
- **`node.clone(schema)` is intra-document and shallow on `Alias` nodes.** It copies the `source` string but does not rewire it.
- **`yaml@2` resolves aliases by *last matching anchor before the alias in document order*, not by a global anchor table.** Name-based lookup is wrong; alias-node resolution via `alias.resolve(doc)` is the correct API.
- **The path-based mirror model works because paths are stable.** They stop being stable the moment a user can stage selections from one doc and commit a subset.

This doc is the substrate reassessment Codex flagged in the PR #63 review. The goal of D4 itself is unchanged: let a user import conditions from a sibling lab's protocol (or an earlier version of their own) without rewriting them by hand, preserving the anchors and plugin declarations those conditions depend on.

---

## 2. Constraints and assumptions

- **Single user, single tab.** No multi-user reconciliation, no real-time collaboration.
- **Hand-edited YAML is the user's source of truth.** The editor must preserve anchors, comments, formatting on round-trip. Load-bearing for every architectural choice so far.
- **`yaml@2.9.0` is the substrate.** Vendored in PR #68. Replacing it is out of scope.
- **The JS-side mirror is for UI rendering only.** All mutations go through helpers that touch `_doc` first.
- **Imports are additive.** D4 brings conditions *into* the user's document. It does not modify "theirs."
- **Anchor namespaces in cross-lab YAML are not guaranteed cosmetic.** Two labs may use `&dur_short` for *semantically different* values. Silent merge based on name + value equality is a footgun. *(Driver of rev 2's namespaced-default design.)*

---

## 3. Substrate: staging buffer with namespaced-default imports

### The substrate decision (Option B, staging buffer)

Settled in rev 1; no revision needed. The user enters import mode, browses "theirs," adds candidate conditions to a *staging buffer*, optionally adjusts what their imported names look like, then **Commit** in one batch (one undo step) or **Cancel** to discard. The buffer never mutates `yours._doc` until commit. Cross-doc primitives + commit pipeline live in a new `js/v3-import.js` module so Node tests can exercise them directly.

### The product-shape decision (namespaced-default)

When the user adds a "theirs" condition to the buffer, the defaults are:

- **Imported condition name** keeps its original name unless that name already exists in "yours." Conditions are user-facing and renaming the condition is more disruptive than namespacing — so for conditions we accept the risk of a name suggestion-with-suffix (e.g., `arena check_2`) on collision and don't prefix by default.
- **Imported anchor names** get a **source prefix** by default (e.g., `&sibling__dur_short`). The user must *opt in* to merging with an existing anchor.
- **Imported plugin names** get a **source prefix** by default (e.g., `sibling__camera`). The user must *opt in* to merging with an existing plugin entry.

The source prefix derives from the imported filename, sanitized to anchor-safe characters and stripped of extension: `sibling_lab.yaml` → `sibling_lab__`. User can override the prefix when entering import mode (default value pre-filled from the filename, editable).

**Why this defaults to namespacing for anchors/plugins but not conditions:**
- Conditions are *named tasks* the user picks from a list. A user importing "arena check" from a sibling lab wants to see "arena check" or "arena check_2" — not "sibling__arena check," which would just be confusing.
- Anchors are *internal references* the user mostly doesn't see except when something breaks. A user importing condition X doesn't care if X's internal `*dur_short` reference is to `&dur_short` or to `&sibling__dur_short` — they just want X to work. The cost of `sibling__` prefix is "slightly noisier YAML"; the benefit is no silent semantic merge.
- Plugins are *infrastructure* the user declares in `plugins:` but rarely thinks about command-by-command. Similar tradeoff as anchors.

**What namespaced-default eliminates:**
- "Anchor value mismatch" as a conflict kind — the import gets its own anchor namespace, no comparison needed.
- "Plugin class mismatch" as a conflict kind — the import gets its own plugin entry, no compatibility check needed.
- Structural-equality checks via `toJS(doc)` + `JSON.stringify` — no longer needed for the default path. (Still optional if the user *explicitly* asks to merge.)
- Duplicate anchor names in "theirs" — each anchor gets a unique prefixed name on the user's side, so source-side duplicates don't matter.

**What namespaced-default keeps as conflicts:**
- **Condition name collision** (still real — conditions aren't prefixed). Resolution: suggest `<name>_2`, user accepts or edits.
- **Unknown command type** (informational only — preserved as raw card).

**What namespaced-default trades away:**
- Slightly noisier YAML on import (`&sibling_lab__dur_short` vs `&dur_short`).
- The "merge equivalent anchors" optimization that rev 1 had as default is now an opt-in. Users who really do want to share anchors between source and target click a "merge with existing &dur_short" toggle per-anchor.

---

## 4. Cross-doc primitives — the right API

These live in a new `js/v3-import.js` module (so Node tests can exercise them) and are exported alongside the existing `js/protocol-yaml-v3.js` helpers.

### Primitive: walk a node tree for Alias references

```js
function collectAliasReferences(rootNode) {
    const aliases = [];  // Alias node refs
    YAML.visit(rootNode, {
        Alias(_, node) { aliases.push(node); }
    });
    return aliases;
}
```

Works on any node tree (`YAML.visit` accepts a subtree, not just a Document — confirmed against `js/vendor/yaml/browser/dist/visit.js`).

### Primitive: resolve an Alias to its actual source-doc value node

```js
function resolveAlias(aliasNode, sourceDoc) {
    return aliasNode.resolve(sourceDoc) || null;
}
```

This is the correct API per `js/vendor/yaml/browser/dist/nodes/Alias.js`. It implements yaml@2's last-wins resolution semantics. Returning `null` indicates an unresolvable alias (broken source YAML).

### Primitive: clone a node tree across documents with explicit alias rewriting

```js
function cloneNodeAcrossDocs(srcNode, targetDoc, aliasRewriteMap) {
    // aliasRewriteMap: { oldAnchorName: newAnchorName, ... }
    const cloned = srcNode.clone(targetDoc.schema);  // intra-doc clone; aliases still dangle
    YAML.visit(cloned, {
        Alias(_, node) {
            if (aliasRewriteMap[node.source]) {
                node.source = aliasRewriteMap[node.source];
            }
        }
    });
    return cloned;
}
```

`clone()` is intra-document; `cloned` lives logically in the target doc but its `Alias.source` strings still point at the *source* doc's anchor names. We rewrite them per the map provided. After rewriting, the cloned node's aliases will resolve against the target doc's anchors (which we'll insert separately).

### Primitive: insert a top-level section if it doesn't exist

```js
function ensureTopLevelSection(doc, key, defaultShape) {
    // defaultShape: 'map' or 'seq'
    const existing = doc.getIn([key], true);
    if (existing) return existing;
    const node = doc.createNode(defaultShape === 'seq' ? [] : {});
    doc.setIn([key], node);
    return doc.getIn([key], true);
}
```

Needed because some target YAMLs don't have a `variables:` section (e.g., `v3_no_variables.yaml`). Import must create it before splicing.

### Primitive: splice an already-cloned condition node into the target

```js
function docInsertConditionNode(experiment, clonedCondNode, derivedJsCond) {
    const condsNode = experiment._doc.getIn(['conditions'], true);
    if (!condsNode || !Array.isArray(condsNode.items)) {
        throw new V3ParseError('docInsertConditionNode: conditions seq missing', 'DOC_MODEL_DIVERGENCE');
    }
    condsNode.items.push(clonedCondNode);
    experiment.conditions.push(derivedJsCond);
}
```

Distinct from existing `docInsertCondition`, which builds a fresh YAML node from JS objects (losing imported comments/style). The new helper takes the already-cloned-and-rewired node and just splices.

Similar parallel helpers: `docInsertVariableNode`, `docInsertPluginNode`.

### Primitive: structural equality (only used on explicit merge path)

```js
function yamlNodeStructuralEquals(aNode, aDoc, bNode, bDoc) {
    try {
        const a = sortedJson(aNode.toJS(aDoc));
        const b = sortedJson(bNode.toJS(bDoc));
        return a === b;
    } catch {
        return false;  // unresolvable alias → not equal
    }
}

function sortedJson(value) {
    // JSON.stringify with deterministic key order — sort each object's keys
    return JSON.stringify(value, Object.keys(value).sort?.bind(Object.keys(value)) || null);
    // (Implementation note: use a custom replacer that sorts object keys recursively.
    //  Many libraries provide this; we'll handroll a small one.)
}
```

Only used when the user *explicitly* asks to merge an imported anchor with an existing one. Catches `toJS()` errors from unresolved aliases. Sorts keys to avoid key-order false-negatives.

---

## 5. Anchor handling — concrete algorithm

When the user adds a condition `srcCond` (a YAMLMap from `theirs._doc`) to the staging buffer:

1. **Find all aliases the condition uses.** `aliases = collectAliasReferences(srcCond)`.

2. **For each `aliasNode` in `aliases`:**
   - **Resolve to source value node.** `srcValueNode = resolveAlias(aliasNode, theirsDoc)`.
   - If `srcValueNode` is null: mark as `{kind: 'broken-alias', sourceName: aliasNode.source}` — informational; the imported alias will dangle in `yours._doc` and trigger an existing `unused-anchor` warning on export.
   - **Record the planned anchor name.** Default: `<prefix> + aliasNode.source` (e.g., `sibling_lab__dur_short`). User can override per-anchor in the staging UI.
   - **Record dependencies.** Each `srcValueNode` may itself contain Aliases. Recursively collect them.

3. **Transitive closure.** For each new source value node discovered in step 2, run steps 1–2 on it. Iterate until no new anchors discovered. Cap depth at 10 to detect cycles.

4. **Build the import plan for this condition:**
   ```js
   {
       sourceCondNode: srcCond,
       originalName: 'arena check',
       targetName: 'arena check',  // user-editable if collision
       conditionNameCollision: false | 'arena check_2',
       anchorsToImport: [
           { srcAnchor: 'dur_short', srcValueNode: <Node>, plannedName: 'sibling_lab__dur_short', action: 'add', mergeWith: null },
           ...
       ],
       pluginsToImport: [
           { srcName: 'camera', srcEntry: <plugin object>, plannedName: 'sibling_lab__camera', action: 'add', mergeWith: null },
           ...
       ],
       unknownCommandTypes: ['branch'],  // informational
       brokenAliases: []  // informational
   }
   ```

5. **Commit translates the plan into mutations:**
   - For each `anchorsToImport[i]`:
     - `cloneNodeAcrossDocs(srcValueNode, yoursDoc, {})` — recursive aliases inside the value node also need their `source` strings rewritten per the user's chosen names.
     - Tag the cloned value node with `clonedValueNode.anchor = plannedName`.
     - Insert into `yours._doc`'s `variables:` map with key `plannedName` (via `ensureTopLevelSection` then `docInsertVariableNode`).
   - For each `pluginsToImport[i]`:
     - Clone the plugin entry node, rewrite any internal aliases, tag with `plannedName`.
     - Insert into `yours._doc`'s `plugins:` seq via `docInsertPluginNode`.
   - For the condition itself:
     - Build the `aliasRewriteMap` from `anchorsToImport` (`{srcAnchor → plannedName}`).
     - `cloneNodeAcrossDocs(srcCond, yoursDoc, aliasRewriteMap)`.
     - Rewrite any `plugin_name` strings inside the cloned condition's commands per `pluginsToImport`.
     - Splice via `docInsertConditionNode`.

6. **Optional: append bare refs to sequence.** A checkbox in the staging UI (default ON) appends a bare ref to `yours.sequence` for each committed condition, via the existing `docAppendSequenceEntry`. See §7 for rationale.

---

## 6. Conflict kinds (much reduced post-namespacing)

The aggressive conflict catalog of rev 1 collapses to two real conflicts:

- **Condition name collision.** Imported condition name already exists in `yours.conditions[]`. Resolution: suggest `<name>_2`, `_3`, etc. User can edit. Mandatory before commit.
- **Plugin namespace collision** (rare). Imported plugin's prefixed name (`sibling__camera`) somehow already exists in `yours.plugins[]` — would only happen if the user had previously imported from the same source and renamed. Resolution: bump prefix to `sibling__camera_2`. Mandatory before commit.

Plus three informational annotations (not blocking conflicts):

- **Unknown command type** in an imported condition — preserved as raw card, shows up in `collectExportWarnings` after commit. No resolution required.
- **Broken alias in source YAML** (alias points at a non-existent anchor in `theirs`) — informational. The cloned node will have a dangling alias; `collectExportWarnings` will flag it post-commit. User can decide whether to import anyway.
- **Pattern file reference** like `pattern: "lisa_specific.pat"` — soft warning ("verify this pattern exists on your machine"). No blocking behavior.

Removed conflict kinds (vs rev 1):

- ❌ "Anchor value mismatch" — eliminated by namespacing.
- ❌ "Anchor name collision" — eliminated by namespacing.
- ❌ "Plugin class mismatch" — eliminated by namespacing.
- ❌ "Undeclared plugin" — irrelevant once we import plugin declarations alongside.
- ❌ "Override existing anchor" — removed entirely (was dangerous + underspecified per Codex-std).
- ❌ "Cross-condition trial reference" — wrong scope (blocks/intertrials live in `experiment:`, not `conditions:`).

---

## 7. Staging buffer — shape and lifecycle

### Data shape

```js
const staging = {
    src: { doc, conditions, variables, plugins, filename },  // parsed "theirs"
    prefix: 'sibling_lab__',  // user-editable, derived from filename
    items: [
        // one entry per condition the user has chosen to import
        {
            sourceCondIdx: 4,
            originalName: 'arena check',
            targetName: 'arena check',  // editable for collision
            conditionNameCollision: false | <suggestion>,
            anchorsToImport: [...],  // see §5 step 4
            pluginsToImport: [...],
            unknownCommandTypes: [...],
            brokenAliases: [...]
        },
        ...
    ],
    addBareRefs: true,  // checkbox state, default true
    locked: true  // "yours" pane is read-only while in import mode
};
```

### Lifecycle

- **Enter import mode** → file picker → parse + reject if duplicate anchors in source (preflight) → `staging.src` populated, three-pane layout swaps in, `staging.locked = true` disables `+ Add`, `dup`, inspector edits in "yours."
- **Add to buffer** → on ← click, compute the import plan for that source condition (§5 steps 1–4). Push into `staging.items`.
- **Adjust per-item** → user can edit the planned target name, individual anchor names, individual plugin names from the inspector. Each adjustment re-validates collision in `staging`. Bulk options (toolbar): "Reset all to default prefixes," "Use shorter prefix" (prompt for new prefix string, recompute all planned names).
- **Commit** → `pushUndo()` once → walk `staging.items[]` and apply §5 step 5 for each → if `addBareRefs`, append refs via existing helper → exit import mode → `selection` points to the first committed condition.
- **Cancel** → discard `staging`, exit import mode, restore the two-pane layout. No mutations.

### Re-using existing renderers (with caveats from Codex-std)

`renderLibrary` is too tightly bound to the global `experiment` for direct reuse. Tier 2's extraction-pattern applies: lift a `renderConditionList(conditions, opts)` helper that takes the conditions array + display options (`editable`, `showUsage`, `onClick`, `extraButtons`). Both the existing library and the new "theirs" library use the new helper. ~½ day of refactor in Milestone 3.

### Auto-add bare refs (the orphan problem)

Without auto-add, imported conditions land in `yours.conditions[]` but aren't referenced from `yours.sequence`. The user can't actually *run* the imported condition without editing YAML by hand (no "+ Use in sequence" UI for an existing condition exists yet). Solution: a default-on checkbox in the staging buffer ("Append bare refs to sequence after commit"). Toggleable per-session. If user unchecks it, the imported conditions show as unused in the warnings banner post-commit — they know what they're getting into.

### Locking "yours" during import

While `staging.locked === true`:
- `+ Add condition` button is disabled.
- Library row dup buttons are disabled.
- Inspector edits return early (no commit, show a tooltip "import mode — finish or cancel first").
- Export button is disabled.
- `addCondBtn`, `exportBtn`, command-card actions, `pushUndo` triggers all respect the flag.

This avoids the stale-resolution problem Codex-adv flagged: staged target-name suggestions become invalid if "yours" mutates underneath.

---

## 8. Three-pane import-mode UI

```
┌──────────────┬─────────────────────┬─────────────────┐
│ LIBRARY      │ LIBRARY (theirs) — │ INSPECTOR        │
│ (yours)      │ read-only           │ — staging-item   │
│              │                     │   detail OR      │
│ locked       │      ←              │   theirs-preview │
│              │      arrows         │                  │
│              │                     │                  │
└──────────────┴─────────────────────┴─────────────────┘
[Top banner: Importing from sibling_lab.yaml  Prefix: sibling_lab__ [edit]  3 staged  [✓ Add to sequence]  [Cancel] [Commit]]
```

Layout maps onto existing zones:
- "Yours" library → existing `libraryZone` (re-rendered with `locked` class for muted styling).
- "Theirs" library → existing `sequenceZone` repurposed for import mode (swap the contents, not the DOM node).
- Inspector → existing `inspectorZone`, renders either a staging-item detail panel (when buffer item selected) or a read-only "theirs" condition preview (when a "theirs" row hovered/selected).

Selection scope: a new `selection.kind = 'staging-item'` with `stagingIdx`, plus `selection.kind = 'theirs-preview'` with `theirsCondIdx`. The existing `selection.kind` values are still supported but disabled-via-locking.

The top banner above the panes carries the global import-mode controls (prefix edit, add-to-sequence toggle, Commit/Cancel).

---

## 9. Incremental implementation order (revised estimates)

### Milestone 1 — Cross-doc primitives + new node-based helpers (~1 day)

In a new module `js/v3-import.js`:
- `collectAliasReferences(node) → AliasNode[]`
- `resolveAlias(alias, doc) → ValueNode | null`
- `cloneNodeAcrossDocs(srcNode, targetDoc, aliasRewriteMap) → clonedNode`
- `yamlNodeStructuralEquals(aNode, aDoc, bNode, bDoc) → boolean`
- `sortedJson(value)` helper.

Add to `js/protocol-yaml-v3.js`:
- `ensureTopLevelSection(experiment, key, defaultShape)`
- `docInsertConditionNode(experiment, clonedCondNode, derivedJsCond)`
- `docInsertVariableNode(experiment, name, clonedValueNode)`
- `docInsertPluginNode(experiment, clonedPluginNode)`

Tests:
- Suite for the primitive functions: cross-doc clone with rewrite, alias resolution against last-wins ordering, transitive walks find nested anchors.
- Suite for the new doc helpers: insert into existing `variables:`, insert when `variables:` is absent (creates section), round-trip stable.

### Milestone 2 — Staging buffer + commit pipeline (no UI yet) (~1.5 days)

In `js/v3-import.js`:
- `createStagingBuffer(srcDoc, srcFilename, opts) → staging`
- `addToStaging(staging, sourceCondIdx, yoursExperiment) → updated staging`
- `removeFromStaging(staging, itemIdx) → updated staging`
- `setStagingPrefix(staging, newPrefix) → updated staging` (recomputes all planned anchor/plugin names)
- `setItemTargetName(staging, itemIdx, newName) → updated staging`
- `commitStaging(staging, yoursExperiment) → mutates yours._doc + yoursExperiment, returns commit summary`
- Conflict detection runs inside these helpers.
- Preflight: reject source YAMLs with duplicate anchor names.

Tests:
- Build staging in Node (no DOM), add items, verify planned names, commit, assert `yours._doc.toString()` matches expectations.
- Edge cases: source with no `variables:`, source with no `plugins:`, target with no `variables:`, condition with no aliases, condition with transitive aliases, broken alias, unknown command type, condition name collision.

### Milestone 3 — Three-pane UI + staging interactions (~2 days)

In `experiment_designer_v3.html`:
- "Import conditions from another YAML…" button + file picker.
- `enterImportMode(srcYamlText, srcFilename)`, `exitImportMode()`, `commitImport()`.
- New layout swap function: hides existing layout, renders three-pane import view in same DOM nodes.
- Extract `renderConditionList(conditions, opts)` helper. Refactor existing `renderLibrary` to use it.
- New `renderTheirsLibrary(staging)`, `renderStagingBuffer(staging)`, `renderStagingItemInspector(stagingItem)`, `renderTheirsPreview(theirsCondIdx)`.
- Inspector edit forms: condition target name input, per-anchor name input, per-plugin name input. Bulk: prefix input.
- Locking: `+ Add` / `dup` / inspector / Export disabled when `staging.locked`.

Browser smoke tests:
- Import a synthetic source with one clean condition → commit → verify.
- Import with a condition name collision → resolve → commit.
- Import with an anchor → verify namespaced anchor lands in `variables:` with prefix.
- Cancel mid-session → no mutations.
- Undo after commit → reverts everything in one step.

### Milestone 4 — Polish + docs (~½ day)

- `beforeunload` warning during import mode.
- CLAUDE.md updates documenting the import flow.
- Footer bump.

**Total: ~5 days realistic** (rev 1 said 3; the 50% bump matches what the review caught).

---

## 10. Test plan (consolidated)

### Node-side (run via `npm test`):

- **Suite N1 — `collectAliasReferences`:** finds direct + transitive aliases, deterministic order.
- **Suite N2 — `resolveAlias`:** correctly resolves against last-matching semantics; returns null on broken aliases.
- **Suite N3 — `cloneNodeAcrossDocs`:** clones structure; rewrites Alias `source` per map; leaves non-rewritten sources alone.
- **Suite N4 — `yamlNodeStructuralEquals`:** detects key-order-irrelevant equality; returns false on broken aliases; returns false on different types.
- **Suite N5 — `ensureTopLevelSection`:** idempotent on existing section; creates missing section.
- **Suite N6 — `docInsertConditionNode` + variable + plugin:** all three add to doc + mirror; round-trip stable.
- **Suite N7 — Staging buffer dry-run:** synthetic add + adjust prefix + commit → assert `yours._doc.toString()`.
- **Suite N8 — Each conflict kind triggered:** condition name collision, plugin namespace collision, broken alias, unknown command, transitive alias closure.
- **Suite N9 — Edge cases:** no `variables:` section, no `plugins:` section, condition with zero aliases, anchor → anchor → anchor chain (depth 3).
- **Suite N10 — Preflight rejection:** source YAML with duplicate anchor names is rejected at `enterImportMode`.

### Browser-side (manual checklist in PR):

- Clean import (no collisions) → commit → confirm conditions/anchors/plugins land with prefix on anchors/plugins, no prefix on conditions.
- Condition name collision → resolve via inline input → commit.
- Edit prefix mid-session → all planned names recompute → commit reflects new prefix.
- Toggle "Add to sequence" checkbox off → commit → conditions present in library, no new refs in sequence, warnings banner flags unused conditions.
- Cancel mid-session → no doc mutations.
- Undo immediately after commit → fully reverts.
- Lock check: try `+ Add` or Export during import mode → both disabled.

---

## 11. Open questions for the user

These can still be settled in-flight without blocking Milestone 1.

1. **Default prefix derivation.** Filename `sibling_lab.yaml` → `sibling_lab__`. Acceptable, or do you want shorter / different default?
2. **"Merge with existing" opt-in path.** Should v1 ship the per-anchor "merge with `&dur_short` from yours" toggle, or defer to v1.1? It's a small surface (one button per anchor row) but requires the `yamlNodeStructuralEquals` path. Defer if simpler.
3. **Bulk prefix override scope.** Editing the prefix mid-session recomputes ALL planned anchor/plugin names. Should per-item overrides persist across a prefix change, or get reset? Recommend: persist (user explicitly typed those names; respect their intent).
4. **Sequence ref auto-add default.** Defaults ON in this design. OK?
5. **What happens to imported plugin commands referencing controllers not in the registry?** E.g., source uses `command_name: foo` on a plugin and `foo` isn't in `getV3PluginCommands(yours, plugin)`. Currently: it imports as-is, `collectExportWarnings` doesn't flag (existing gap). Soft warning at commit?

---

## 12. What this doc still does NOT cover

- **Variables editor (Phase 5).** A read-only view of imported variables in Settings would mitigate the "user can't see what got namespaced" issue post-D4. Cheap to add but not strictly D4's job.
- **Rename cascade (Phase 5).** Once `sibling__dur_short` is in the user's doc, they have no in-tool way to rename it to something shorter. Cascading rename is Phase 5.
- **Sequence drag/drop (Phase 4).** Imported conditions are wired to the sequence end via auto-bare-ref; reordering them within the sequence is Phase 4.
- **Multi-doc YAML streams.** One doc per file assumed.
- **Pattern file path resolution.** Soft warning only; no validation.
- **Plugin command schema drift.** If "theirs" uses a plugin command the registry doesn't know about, it imports as-is. The export-warnings system catches some of this but not all.

---

## 13. Risk register (revised)

- **YAML library edge cases.** `clone(schema)` + `anchor` mutation + `createAlias`. Mitigation: Milestone 1's primitive tests cover the API surface before any commit logic uses them. Targeted edge cases: anchors on collection nodes, anchors on scalar nodes, anchor-points-at-alias chains.
- **Staging buffer becoming a parallel architecture.** Mitigation: explicit rule (in §7 and §13) — staging touches only its own state + commits via the documented primitives. No new undo/selection/validation paths.
- **Renderer reuse underestimated.** Codex-std flagged `renderLibrary` is tightly bound; my rev 2 explicitly budgets the `renderConditionList` extraction. Mitigation: extract early in Milestone 3, before per-pane rendering.
- **User confusion about prefix-by-default.** Some users will dislike noisy anchor names. Mitigation: the prefix-edit UI is prominent at the top of the buffer; users can shorten or use empty prefix if they want. Documentation in CLAUDE.md after Milestone 4.
- **Locking "yours" is restrictive.** A user mid-edit who wants to import will lose their place. Mitigation: enter import mode also calls `setDirty(true)` and the `beforeunload` is already set. Optionally: a "discard staging" Cancel that doesn't lose pre-import edits (already the default).
- **`alias.resolve` vs duplicate-anchor preflight.** We reject duplicate-anchor sources at enter, then use `alias.resolve` (which respects last-wins) for everything else. If a corner-case duplicate slips past (e.g., due to mid-stream additions to the source), `alias.resolve` will still give a defined answer. Belt-and-suspenders.

---

## 14. Decision needed before any code lands

Read this doc + (re-running Codex on this revision is included in the same PR). Then either:

- **Approve** — Milestone 1 starts.
- **Push back on the substrate or product shape** — revisit (return to merge-by-default, try Option C refactor, etc.).
- **Defer D4** — pivot to Phase 4 (sequence drag/drop) or Phase 5 (Variables editor) on the current architecture.

No code until we've explicitly picked one.
