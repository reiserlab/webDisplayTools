# D4 — Cross-Library Import Design Doc (revision 3)

**Status:** **ACTIVE** (2026-05-30). Prerequisites met: Phase 4 (sequence
drag/drop) and Phase 5 (Variables editor + rename cascade) both shipped, so
D4's "prefix clutter is fixable in-tool" mitigation now holds. This revision
applies the full rev-2 → rev-3 fix list from `v3-d4-design-reviews.md`. The
executable milestone breakdown lives in `v3-d4-implementation-handoff.md`.

**This doc is now the implementation spec.** It folds in every correction the
round-2 Codex review caught — the biggest being **plugins merge by default
when `matlab.class` + `config` match** (anchors still namespace by default).

**Owner:** Session implementing D4.
**History:**
- rev 1 (2026-05-27): merge-by-default, monolithic helpers, optimistic milestones.
- rev 2 (2026-05-27): namespaced-default, module-first helpers, alias-node API, transitive closure, revised milestones.
- Round 2 review (2026-05-27): caught further bugs (see `v3-d4-design-reviews.md`); D4 deferred behind Phase 4/5.
- **rev 3 (2026-05-30, current):** applied the 11-item fix list — one shared `aliasRewriteMap`, visited-set cycle detection, per-batch dependency registry, topological anchor insert, commit rewrites `name:`, plugin-merge-by-default, alias-bound `plugin_name` block, cross-buffer collision check, fixed `sortedJson`, broken-alias hard-block, lock-via-UI-handlers.
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

## 3. Substrate: staging buffer; anchors namespace, plugins merge

### The substrate decision (Option B, staging buffer)

Settled in rev 1; no revision needed. The user enters import mode, browses "theirs," adds candidate conditions to a *staging buffer*, optionally adjusts what their imported names look like, then **Commit** in one batch (one undo step) or **Cancel** to discard. The buffer never mutates `yours._doc` until commit. Cross-doc primitives + commit pipeline live in a new `js/v3-import.js` module so Node tests can exercise them directly.

### The product-shape decision (anchors namespace, plugins merge)

When the user adds a "theirs" condition to the buffer, the defaults are:

- **Imported condition name** keeps its original name unless that name already exists in "yours." Conditions are user-facing and renaming the condition is more disruptive than namespacing — so for conditions we accept the risk of a name suggestion-with-suffix (e.g., `arena check_2`) on collision and don't prefix by default.
- **Imported anchor names** get a **source prefix** by default (e.g., `&sibling__dur_short`). The user must *opt in* to merging with an existing anchor.
- **Imported plugins MERGE by default** when an existing "yours" plugin is the
  *same runtime resource*. On a *mismatch* (or no same-named plugin exists), the
  imported plugin is added under a **source-prefixed** name (e.g., `sibling__camera`).
  See the plugin/anchor asymmetry rationale below — this is the rev-3 change.
  - **Identity projection (rev-3 review, Codex-std/adv):** structural equality is
    computed over **every plugin field except `name`** — `type`, `matlab`,
    `python`, `config`, `port`, `baudrate`, `script_path`, and unknown keys (all
    preserved by `extractPlugin`) — NOT `matlab.class` + `config` alone. Empty
    `config` is common, so class-only matching would merge unrelated hardware.
    When both candidates omit hardware-specific fields, also require the same
    top-level `rig` path before merging (hardware defaults can live in the rig
    file). The built-in `log` plugin is exempt (see §5).

The source prefix derives from the imported filename, sanitized to anchor-safe characters and stripped of extension: `sibling_lab.yaml` → `sibling_lab__`. User can override the prefix when entering import mode (default value pre-filled from the filename, editable).

**Why anchors namespace by default but plugins merge by default (the asymmetry):**
- Conditions are *named tasks* the user picks from a list. A user importing "arena check" from a sibling lab wants to see "arena check" or "arena check_2" — not "sibling__arena check," which would just be confusing.
- Anchors are *internal data references* the user mostly doesn't see except when something breaks. A user importing condition X doesn't care if X's internal `*dur_short` reference is to `&dur_short` or to `&sibling__dur_short` — they just want X to work. The cost of `sibling__` prefix is "slightly noisier YAML"; the benefit is no silent semantic merge. Two labs may use `&dur_short` for semantically different values, so namespacing is the safe default.
- Plugins are **runtime resources representing physical hardware** (cameras, controllers, serial ports) — not data. Duplicating `camera` → `sibling__camera` does **not** isolate the hardware: both YAML entries may point at the *same* physical device, and two declarations for one device is a real runtime bug (double-open of a serial port, conflicting camera handles). So plugins merge when `matlab.class` + `config` match (same hardware, same wiring → one declaration), and only namespace when they genuinely differ. This asymmetry is honest: anchors and plugins have different operational semantics.

**What this design eliminates:**
- "Anchor value mismatch" as a conflict kind — the import gets its own anchor namespace, no comparison needed.
- "Plugin class mismatch" as a blocking conflict — a mismatch just namespaces (adds a prefixed entry), it never blocks.
- Structural-equality checks on anchors — not needed; anchors always namespace. (The `yamlNodeStructuralEquals` path survives **scoped to plugins only**, for the merge-vs-namespace decision.)
- Duplicate anchor names in "theirs" — each anchor gets a unique prefixed name on the user's side, so source-side duplicates don't matter. (Source duplicate *anchors* are still preflight-rejected; see §5/§7 — `parseV3Protocol` throws on them anyway.)

**What this design keeps as conflicts:**
- **Condition name collision** (still real — conditions aren't prefixed). Resolution: suggest `<name>_2`, user accepts or edits. Mandatory before commit.
- **Plugin namespace collision** (rare) — a plugin that *doesn't* match an existing one structurally, but whose prefixed name already exists in `yours.plugins[]`. Resolution: bump the prefix (`sibling__camera_2`). Mandatory before commit.
- **Unknown command type** (informational only — preserved as raw card).

**What this design trades away:**
- Slightly noisier YAML on import for anchors (`&sibling_lab__dur_short` vs `&dur_short`).
- The "merge equivalent anchors" optimization that rev 1 had as default is now an opt-in (deferred to v1.1 per the implementation handoff). Users who really do want to share anchors between source and target would click a "merge with existing &dur_short" toggle per-anchor.
- Plugin merge introduces a small structural-equality path (`yamlNodeStructuralEquals` + `sortedJson`) — but only on the plugin path, and only to *decide* merge-vs-namespace. It never silently merges anchors.

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
        // Rewrite alias REFERENCES…
        Alias(_, node) {
            if (Object.prototype.hasOwnProperty.call(aliasRewriteMap, node.source)) {
                node.source = aliasRewriteMap[node.source];
            }
        },
        // …AND anchor DEFINITIONS carried inside the cloned subtree (Codex-std).
        // A source condition may define an inline anchor (`duration: &dur 5`) and
        // reference it (`*dur`). Cloning carries the inline `&dur` along; if we
        // only rewrote the alias we'd strand a stale `&dur` and risk a document-
        // wide duplicate-anchor blocker (anchorExists / collectBlockingErrors are
        // doc-wide). Rewrite any anchor whose name is in the map too.
        Node(_, node) {
            if (node && node.anchor &&
                Object.prototype.hasOwnProperty.call(aliasRewriteMap, node.anchor)) {
                node.anchor = aliasRewriteMap[node.anchor];
            }
        }
    });
    return cloned;
}
```

`clone()` is intra-document; `cloned` lives logically in the target doc but its `Alias.source` strings still point at the *source* doc's anchor names. We rewrite them per the map provided. After rewriting, the cloned node's aliases will resolve against the target doc's anchors (which we'll insert separately).

**Fix #2 — one shared `aliasRewriteMap`.** The *same* map must be passed to the
clone of the condition AND to every value-node clone. Building an empty `{}` per
value-node clone (as rev 2 did) leaves nested aliases inside an imported anchor's
value dangling. The map is built **once**, after the closure walk has discovered
every anchor and assigned its planned name (§5). `hasOwnProperty` (not truthiness)
guards the rewrite so a legitimately-empty-but-present mapping is honored and a
source name that is *not* being rewritten is left untouched.

**Rev-3 review add (Codex-std) — rewrite anchor definitions too.** The `Node`
visitor above closes the inline-anchor hole. The defining value node we import
into `variables:` gets its `.anchor` set to the planned name by the commit step
anyway; this visitor handles the case where an anchor is defined *inside* a
cloned condition/plugin subtree (not in `variables:`).

### Primitive: insert a top-level section if it doesn't exist

```js
function ensureTopLevelSection(experiment, key, defaultShape) {
    // defaultShape: 'map' or 'seq'. Operates on experiment._doc (signature
    // matches the ~23 other doc* helpers).
    const doc = experiment._doc;
    const existing = doc.getIn([key], true);
    if (existing) return existing;
    const node = doc.createNode(defaultShape === 'seq' ? [] : {});

    // CRITICAL (Claude finding): do NOT doc.set(key, node) — that APPENDS the new
    // pair to the END of the root map, i.e. AFTER conditions:. yaml@2 stringifies
    // with verifyAliasOrder:true (default), and an imported condition's *alias
    // would then precede its &anchor in document order → toString() THROWS
    // ("the anchor must be set before the alias"). Splice the new section at its
    // canonical position (before experiment:/conditions:) instead.
    const root = doc.contents;                         // YAMLMap
    const ORDER = KNOWN_TOP_LEVEL_KEYS;                // version, experiment_info, rig, variables, plugins, experiment, conditions
    const keyRank = ORDER.indexOf(key);
    let insertAt = root.items.length;
    for (let i = 0; i < root.items.length; i++) {
        const k = root.items[i].key && root.items[i].key.value !== undefined
            ? root.items[i].key.value : String(root.items[i].key);
        const rank = ORDER.indexOf(k);
        if (rank !== -1 && rank > keyRank) { insertAt = i; break; }
    }
    root.items.splice(insertAt, 0, new YAML.Pair(doc.createNode(key), node));
    return doc.getIn([key], true);
}
```

Needed because some target YAMLs don't have a `variables:` section (e.g., `v3_no_variables.yaml`). Import must create it before splicing — *and place it before the alias-bearing sections* so round-trip holds.

### Primitive: splice an already-cloned condition node into the target

```js
function docInsertConditionNode(experiment, clonedCondNode) {
    const condsNode = experiment._doc.getIn(['conditions'], true);
    if (!condsNode || !Array.isArray(condsNode.items)) {
        throw new V3ParseError('docInsertConditionNode: conditions seq missing', 'DOC_MODEL_DIVERGENCE');
    }
    condsNode.items.push(clonedCondNode);
    // Derive the JS mirror INTERNALLY (Codex-std) — these helpers live in the
    // same module as extractCondition, so reuse it instead of trusting a caller-
    // built object that can drift from the YAML after plugin-name rewrites.
    experiment.conditions.push(extractCondition(clonedCondNode.toJSON()));
}
```

Distinct from existing `docInsertCondition`, which builds a fresh YAML node from JS objects (losing imported comments/style). The new helper takes the already-cloned-and-rewired node, splices it, and re-derives the mirror with the same extractor `parseV3Protocol` uses.

Similar parallel helpers `docInsertVariableNode(experiment, name, clonedValueNode)`
and `docInsertPluginNode(experiment, clonedPluginNode)` likewise derive their
mirror entries internally (via `extractVariables`-equivalent logic / `extractPlugin`)
and `docInsertVariableNode` sets `clonedValueNode.anchor = name` itself so the map
key and the anchor can never diverge.

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
    // Deterministic, RECURSIVE key sort so {a:1,b:2} and {b:2,a:1} compare equal.
    // A JSON.stringify replacer cannot do this reliably (the replacer sees parent
    // objects, not a stable per-object key order), so we rebuild the value with
    // sorted keys at every depth, then stringify normally.
    function canon(v) {
        if (Array.isArray(v)) return v.map(canon);
        if (v && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
            return out;
        }
        return v;
    }
    return JSON.stringify(canon(value));
}
```

**Fix #9.** Rev 2's `sortedJson` was broken pseudo-code (it passed an array as
the stringify *replacer*, which is a key-allow-list, not a sorter). The recursive
`canon()` above sorts keys at every depth so plugin `config` maps compare equal
regardless of key order. Used **only on the plugin merge path** (deciding
merge-vs-namespace, §5) — `yamlNodeStructuralEquals` catches `toJS()` errors from
unresolved aliases and returns `false`.

---

## 5. Anchor + plugin handling — concrete algorithm

Two phases: **plan** (when items are added/adjusted in the buffer — pure, no
mutation) and **commit** (one batch, mutates `yours._doc`). The plan walk runs
against a **per-batch dependency registry** shared across every staged item
(fix #4), so two staged conditions that both reference `&dur_short` import it
*once*.

### 5a. Preflight (enter import mode)

- `parseV3Protocol(srcText)` — this calls `doc.toJS()` which **throws on any
  unresolved alias**, so a broken-alias source can never enter import mode (fix
  #6 — broken alias is a hard block, not "informational"). A clear error is
  surfaced to the user.
- Reject sources with **duplicate anchor names** (two `&dur_short` definitions).
  yaml@2 round-trips them but last-wins resolution makes the plan ambiguous; we
  reject up front. (In practice `parseV3Protocol`'s `toJS()` already rejects the
  pathological cases; this is belt-and-suspenders — see §13.)

### 5b. Plan — per condition `srcCond` (a YAMLMap from `theirs._doc`)

The batch carries a shared registry:

```js
batch = {
    anchorRegistry: Map<srcAnchorName, { srcValueNode, plannedName }>,  // dedup across items
    pluginRegistry: Map<srcPluginName, { srcEntryNode, plannedName, action, mergeWith }>,
    visitedAnchors: Set<srcAnchorName>  // cycle guard, fix #5
}
```

1. **Collect direct aliases.** `aliases = collectAliasReferences(srcCond)`.

2. **Transitive closure with a visited-set (fix #5 — NOT a depth cap).** Process a
   worklist of alias source-names. For each `srcName` not in `visitedAnchors`:
   - Add to `visitedAnchors`.
   - Resolve once: `srcValueNode = resolveAlias(<one alias with this source>, theirsDoc)`.
     `resolveAlias` returns `null` only for a broken alias — impossible past
     preflight, but guarded defensively.
   - Register in `anchorRegistry` (if absent) with `plannedName = prefix + srcName`
     (user-overridable).
   - Enqueue every alias *inside* `srcValueNode` (`collectAliasReferences(srcValueNode)`).
   A visited-set terminates the *walk* on cycles and never rejects a long
   legitimate chain (the depth-10 cap of rev 2 did both wrong). **It does NOT
   prove the dependency graph is acyclic (rev-3 review, Codex-std):** yaml@2
   permits self-referential anchors (`a: &A {self: *A}`), so the topo-sort in §5c
   must handle self-edges and genuine cycles explicitly rather than assuming the
   visited-set removed them.

3. **Plugins the condition references.** For each `plugin` command in `srcCond`,
   read its `plugin_name`:
   - **Built-in `log` (rev-3 review, Codex-std):** if `plugin_name === 'log'`,
     leave it unchanged — `log` is the always-declared built-in plugin
     (`collectExportWarnings` treats it as declared, [protocol-yaml-v3.js:626]).
     Do NOT require a source `plugins:` entry, do NOT namespace it, do NOT register
     it. Continue to the next command.
   - **If `plugin_name` is alias-bound** (`plugin_name: *camera_plugin`): **block
     at staging time** (fix #7). Namespacing the *declaration* to `sibling__camera`
     while the alias still resolves to the literal `"camera"` would strand the
     reference. v1 surfaces this as a blocking item ("alias-bound plugin_name not
     supported for import — edit the source YAML to use a literal name").
   - Otherwise look up the source plugin entry by that literal name and register
     it in `pluginRegistry` (if absent). Compute its `action`:
     - **`merge`** if a `yours.plugins[]` entry matches on the identity projection
       (§3 — all fields except `name`, + same `rig` when config-less), via
       `yamlNodeStructuralEquals` on the compared sub-shape (§4). `mergeWith` = the
       existing plugin name; `plannedName` = that same existing name (the condition
       will reference the name already in `yours`).
     - **`add`** otherwise; `plannedName = prefix + srcName`, namespaced.
   - **Plugin `config` aliases (rev-3 review, Codex-adv):** when an entry is
     registered with `action: add`, run the §5b-step-2 closure on its *value node*
     too — a `config: { port: *camera_port }` references an anchor the condition
     itself may not. Missing this clones a dangling alias into `yours`. The shared
     `anchorRegistry` absorbs it.

4. **Per-item plan** (references shared registry entries; names recomputed when
   the prefix changes, persisting explicit overrides — fix #4-defaults):
   ```js
   {
       sourceCondNode: srcCond,
       originalName: 'arena check',
       targetName: 'arena check',         // user-editable; rewritten into the clone (fix #1)
       conditionNameCollision: false | 'arena check_2',  // blocking
       anchorRefs:  ['dur_short', ...],   // keys into batch.anchorRegistry
       pluginRefs:  ['camera', ...],      // keys into batch.pluginRegistry
       unknownCommandTypes: ['branch'],   // informational
       aliasBoundPluginNames: [],         // blocking if non-empty (fix #7)
   }
   ```

### 5c. Commit — translate the batch into mutations (one `pushUndo`)

**Pre-commit validation pass (rev-3 review, Codex-std) — runs BEFORE any
mutation.** Reject (block) if: any planned anchor name fails `isValidAnchorName`;
any planned anchor name collides with an existing doc anchor (`anchorExists`) or
another planned anchor (incl. when the user set an empty prefix); any planned
plugin name collides with an existing/other-staged plugin (and isn't a merge);
any `targetName` collides with `yours.conditions[]` or another staged item.
Validating up front (rather than mid-mutation) is what makes commit safe to treat
as atomic — see §7.

Built once, used everywhere — **one shared `aliasRewriteMap`** (fix #2):

```js
aliasRewriteMap = {};
for (const [srcName, {plannedName}] of batch.anchorRegistry) aliasRewriteMap[srcName] = plannedName;
```

1. **Topologically sort `anchorRegistry` (fix #3).** yaml@2 enforces *anchor before
   alias* at stringify time. Order anchors so any anchor whose value references
   another imported anchor is inserted *after* its dependency. Build a dependency
   edge `A → B` when `A`'s value node contains `*B`; emit in dependency-first order.
   **Handle self-edges and real cycles explicitly (rev-3 review):** a self-edge
   (`a: &A {self: *A}`) is fine — the anchor resolves to itself once emitted, so
   ignore self-edges in the sort; a genuine multi-node cycle among imported anchors
   is rejected at validation (it cannot be stringified in any order). Do not assume
   §5b's visited-set made the graph acyclic.

2. **Insert anchors (variables).** For each anchor in topo order, where `action`
   is `add`:
   - `clonedValueNode = cloneNodeAcrossDocs(srcValueNode, yoursDoc, aliasRewriteMap)`
     — the **same** map, so nested aliases inside the value rewrite too.
   - `clonedValueNode.anchor = plannedName`.
   - `ensureTopLevelSection(yours, 'variables', 'map')` then
     `docInsertVariableNode(yours, plannedName, clonedValueNode)`.

3. **Insert / merge plugins.** For each plugin in `pluginRegistry`:
   - `action === 'merge'` → no insert; the condition's `plugin_name` already
     points at the existing `yours` plugin (`plannedName === mergeWith`).
   - `action === 'add'` → `cloneNodeAcrossDocs(srcEntryNode, yoursDoc, aliasRewriteMap)`,
     rewrite its `name:` to `plannedName`, `ensureTopLevelSection(yours, 'plugins', 'seq')`
     then `docInsertPluginNode(yours, clonedPluginNode)`.

4. **Insert the condition.** Per item, in buffer order:
   - `clonedCond = cloneNodeAcrossDocs(srcCond, yoursDoc, aliasRewriteMap)` — same map.
   - **Rewrite the cloned node's `name:` field to `targetName`** (fix #1 — rev 2
     forgot this; the JS mirror would say `arena check_2` while the YAML still
     said `arena check`). Mirror `docCloneCondition`.
   - Rewrite literal `plugin_name` scalars inside the cloned commands per
     `pluginRegistry` (`srcName → plannedName`) — leaving `log` untouched.
   - `docInsertConditionNode(yours, clonedCond)` — the helper derives the JS
     mirror internally via `extractCondition` (rev-3 review, Codex-std), so the
     mirror can't drift from the YAML after the name/plugin rewrites above.

5. **Optional: append bare refs to sequence.** A checkbox (default ON) appends a
   bare ref to `yours.sequence` for each committed condition via the existing
   `docAppendSequenceEntry`. See §7. Label notes the lossy nature (source
   block/repetition context is not preserved).

---

## 6. Conflict kinds (much reduced; plugins merge by default)

Two real (blocking) conflicts:

- **Condition name collision.** Imported condition name already exists in
  `yours.conditions[]`. Resolution: suggest `<name>_2`, `_3`, … User can edit.
  Mandatory before commit. The accepted name is rewritten into the cloned node's
  `name:` field (fix #1).
- **Plugin namespace collision (cross-buffer, fix #10).** A plugin that does *not*
  structurally match an existing one (so it must be added namespaced), but whose
  prefixed name `sibling__camera` already exists in `yours.plugins[]` — e.g. the
  user previously imported from the same source. Resolution: bump the prefix
  (`sibling__camera_2`). Mandatory before commit. (Distinct from the *merge* case,
  where a same-identity plugin merges silently.)
- **Planned anchor-name collision (rev-3 review, Codex-std).** Namespacing
  *usually* avoids this, but it is **not** eliminated: the user can set an empty/
  short prefix, or `sibling__dur_short` may already exist from a prior import. A
  planned anchor name that fails `isValidAnchorName`, collides with an existing
  doc anchor (`anchorExists`), or duplicates another planned anchor is **blocking**
  and checked in the pre-commit validation pass (§5c). Resolution: edit the
  anchor's planned name or the prefix.

Plus blocking-but-rare:

- **Alias-bound `plugin_name`** (fix #7) — `plugin_name: *camera_plugin` in the
  source. Blocked at staging time for v1. User must edit the source to use a
  literal name.

Plus informational annotations (not blocking):

- **Unknown command type** in an imported condition — preserved as a raw card;
  surfaces in `collectExportWarnings` after commit. Soft warning at commit.
- **Pattern file reference** like `pattern: "lisa_specific.pat"` — soft warning
  ("verify this pattern exists on your machine"). No blocking behavior.

Removed conflict kinds (vs rev 1):

- ❌ "Anchor value mismatch" — eliminated by namespacing anchors.
- ⚠️ "Anchor name collision" — *mostly* eliminated by namespacing, but retained as
  a pre-commit blocking check for the empty-prefix / prior-import cases (above).
- ❌ "Plugin class mismatch (blocking)" — a mismatch now just namespaces (adds a
  prefixed entry); never blocks.
- ❌ "Undeclared plugin" — irrelevant once we import/merge plugin declarations.
- ❌ "Override existing anchor" — removed entirely (was dangerous + underspecified).
- ❌ "Cross-condition trial reference" — wrong scope (blocks/intertrials live in
  `experiment:`, not `conditions:`).
- ❌ "Broken alias = informational" — now a **hard block** at preflight (fix #6);
  `parseV3Protocol` throws on it anyway.

---

## 7. Staging buffer — shape and lifecycle

### Data shape

```js
const staging = {
    src: { doc, conditions, variables, plugins, filename },  // parsed "theirs"
    prefix: 'sibling_lab__',  // user-editable, derived from filename
    batch: {
        // per-batch dependency registry — shared across ALL items (fix #4)
        anchorRegistry: Map<srcAnchorName, { srcValueNode, plannedName }>,
        pluginRegistry: Map<srcPluginName, { srcEntryNode, plannedName, action, mergeWith }>,
        visitedAnchors: Set<srcAnchorName>   // closure-walk cycle guard (fix #5)
    },
    items: [
        // one entry per condition the user has chosen to import
        {
            sourceCondIdx: 4,
            originalName: 'arena check',
            targetName: 'arena check',  // editable for collision; rewritten into clone (fix #1)
            conditionNameCollision: false | <suggestion>,
            anchorRefs: ['dur_short', ...],  // keys into batch.anchorRegistry (§5b step 4)
            pluginRefs: ['camera', ...],     // keys into batch.pluginRegistry
            unknownCommandTypes: [...],      // informational
            aliasBoundPluginNames: [...]     // blocking if non-empty (fix #7)
        },
        ...
    ],
    addBareRefs: true,  // checkbox state, default true
    locked: true  // "yours" pane is read-only while in import mode
};
```

The registry lives on `staging.batch`, not per-item, so an anchor or plugin
referenced by two staged conditions is imported exactly once (fix #4).

### Lifecycle

- **Enter import mode** → file picker → `parseV3Protocol` (throws on broken aliases → hard block, fix #6) + reject if duplicate anchors in source (preflight) → `staging.src` populated, three-pane layout swaps in, `staging.locked = true` disables `+ Add`, `dup`, inspector edits in "yours."
- **Add to buffer** → on ← click, run the plan walk for that source condition (§5b) against the shared `batch` registry. Push the per-item plan into `staging.items`.
- **Adjust per-item** → user can edit the planned target name, individual anchor names, individual plugin names from the inspector. Each adjustment re-validates collision in `staging`. Bulk options (toolbar): "Reset all to default prefixes," "Use shorter prefix" (prompt for new prefix string, recompute all planned names — explicitly-typed per-item names persist, fix #4-defaults).
- **Commit** → run the pre-commit validation pass (§5c) — if it reports any
  blocking item, abort with no mutation → else `pushUndo()` once → snapshot
  `yours._doc.toString()` for rollback → build the shared `aliasRewriteMap`,
  topo-sort anchors (fix #3), apply §5c → if `addBareRefs`, append refs via
  existing helper → exit import mode → `selection` points to the first committed
  condition.
  - **Atomicity (rev-3 review, Codex-std).** `commitStaging` performs many
    mutations after one `pushUndo`. If a later step throws (e.g. plugin insert
    fails after anchors landed), the doc is half-mutated. Mitigation: validate
    everything up front (above) so the happy path can't fail on policy; and wrap
    the mutation block so any unexpected throw restores the pre-commit
    `toString()` snapshot (re-parse) before surfacing the error. Net effect: commit
    is all-or-nothing.
- **Cancel** → discard `staging`, exit import mode, restore the two-pane layout. No mutations.

**Do NOT `setDirty(true)` on *entering* import mode (rev-3 review, Codex-std).**
The dirty flag means "the YAML has unsaved edits." Entering import mode and then
cancelling mutates nothing, so it must not mark the document dirty. Set dirty only
on a successful **commit** (or on a real target-document edit, which locking
otherwise blocks). The `beforeunload` guard during import mode is handled
separately (Milestone 4) and does not depend on the dirty flag.

### Re-using existing renderers (with caveats from Codex-std)

`renderLibrary` is too tightly bound to the global `experiment` for direct reuse. Tier 2's extraction-pattern applies: lift a `renderConditionList(conditions, opts)` helper that takes the conditions array + display options (`editable`, `showUsage`, `onClick`, `extraButtons`). Both the existing library and the new "theirs" library use the new helper. ~½ day of refactor in Milestone 3.

### Auto-add bare refs (the orphan problem)

Without auto-add, imported conditions land in `yours.conditions[]` but aren't referenced from `yours.sequence`. The user can't actually *run* the imported condition without editing YAML by hand (no "+ Use in sequence" UI for an existing condition exists yet). Solution: a default-on checkbox in the staging buffer ("Append bare refs to sequence after commit"). Toggleable per-session. If user unchecks it, the imported conditions show as unused in the warnings banner post-commit — they know what they're getting into.

### Locking "yours" during import

While `staging.locked === true`, the lock is enforced **in the UI event
handlers** (fix #8), NOT by globally suppressing `pushUndo()`. The lock must cover
**every target-document mutation path** (rev-3 review, Codex-std — the rev-2 list
was incomplete). On the v3 page that means:
- `+ Add condition`.
- Library row **delete (✕)** and **context-menu duplicate** ([experiment_designer_v3.html] renderLibrary).
- **Library → sequence drag/drop** sources.
- **Sequence edits** (reorder, +Ref/+Block, ref↔block convert) and **block trial edits**.
- **Variables / Settings edits** (anchor rename, value, +Add; experiment_info / rig fields).
- Inspector / command-card edits return early (tooltip "import mode — finish or cancel first").
- **Export** button.
- **Undo/Redo** keyboard + buttons (the target-doc undo stack is frozen during import; commit pushes exactly one entry).

**Why not lock `pushUndo` globally?** Commit *itself* calls `pushUndo()` (one
snapshot for the whole batch). A global `pushUndo` suppression would swallow
commit's own undo snapshot, making the import un-undoable. So the guard sits on
the user-facing handlers (`addCondBtn`, `dupBtn`, inspector inputs, `exportBtn`),
and commit's `pushUndo` runs unimpeded.

This also avoids the stale-resolution problem Codex-adv flagged: staged
target-name suggestions become invalid if "yours" mutates underneath.

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
- `docInsertConditionNode(experiment, clonedCondNode)`
- `docInsertVariableNode(experiment, name, clonedValueNode)`
- `docInsertPluginNode(experiment, clonedPluginNode)`

Tests:
- Suite for the primitive functions: cross-doc clone with rewrite, alias
  resolution against last-wins ordering, transitive walks find nested anchors,
  **anchor-definition rewrite** for an inline `&anchor` inside the cloned subtree
  (rev-3 review).
- Suite for the new doc helpers: insert into existing `variables:`, insert when
  `variables:` is absent (**created section lands BEFORE `conditions:` so an
  imported alias still re-parses** — rev-3 review), mirror derived internally,
  round-trip stable.

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
- **Suite N3 — `cloneNodeAcrossDocs`:** clones structure; rewrites Alias `source` per map; leaves non-rewritten sources alone; **rewrites an inline `&anchor` definition carried inside the cloned subtree when it's in the map** (rev-3 review).
- **Suite N4 — `yamlNodeStructuralEquals`:** detects key-order-irrelevant equality; returns false on broken aliases; returns false on different types.
- **Suite N5 — `ensureTopLevelSection`:** idempotent on existing section; creates missing section; **created section is spliced BEFORE `conditions:` (not appended)** so it round-trips (rev-3 review).
- **Suite N6 — `docInsertConditionNode` + variable + plugin:** all three add to doc + **mirror derived internally**; insert into existing & absent `variables:` (alias in a condition still re-parses after creating the section); round-trip stable.
- **Suite N7 — Staging buffer dry-run:** synthetic add + adjust prefix + commit → assert `yours._doc.toString()`.
- **Suite N8 — Each conflict / built-in kind:** condition name collision; plugin namespace collision (cross-buffer, fix #10); plugin **merge** on identity-projection match (fix #11); **merge false-positive guard** (same class + empty config + different `rig` ⇒ namespace, not merge); alias-bound `plugin_name` block (fix #7); **built-in `plugin_name: log` left unchanged, not namespaced**; planned anchor-name collision (empty prefix) blocks; unknown command; transitive alias closure (incl. **plugin `config` alias**).
- **Suite N9 — Edge cases:** no `variables:` section, no `plugins:` section, condition with zero aliases, anchor → anchor → anchor chain (depth 3), `A→B→A` cycle terminates the walk (fix #5), **self-referential anchor `&A {self: *A}` handled**, topological insert order so anchors precede their aliases (fix #3), **failed-commit rollback restores the pre-commit `toString()`**.
- **Suite N10 — Preflight rejection:** source YAML with duplicate anchor names is rejected at `enterImportMode`; broken-alias source is rejected at parse (fix #6).

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

**These are now pre-answered** in `v3-d4-implementation-handoff.md` §4 (defaults
for autonomous execution; change only if the user objects). Recorded here for
the record:

1. **Default prefix derivation.** Filename `sibling_lab.yaml` → `sibling_lab__`
   (sanitized stem + `__`). Editable at enter-import.
2. **"Merge with existing" anchor opt-in.** **Defer to v1.1.** Ship
   namespaced-default for anchors; the per-anchor merge toggle is extra surface.
   (Plugin merge-by-default from §3 still ships — it's not optional.)
3. **Bulk prefix override scope.** **Persist** per-item name overrides across a
   prefix change (respect explicitly-typed names).
4. **Sequence ref auto-add default.** **ON**, with the lossy-context label
   ("Append bare refs to sequence (source block/repetition context is not
   preserved)").
5. **Imported plugin command not in the registry.** Import as-is + **soft warning
   at commit** (informational, non-blocking).

---

## 12. What this doc still does NOT cover

- **Variables editor (Phase 5).** A read-only view of imported variables in Settings would mitigate the "user can't see what got namespaced" issue post-D4. Cheap to add but not strictly D4's job.
- **Rename cascade (Phase 5).** Once `sibling__dur_short` is in the user's doc, they have no in-tool way to rename it to something shorter. Cascading rename is Phase 5.
- **Sequence drag/drop (Phase 4).** Imported conditions are wired to the sequence end via auto-bare-ref; reordering them within the sequence is Phase 4.
- **Multi-doc YAML streams.** One doc per file assumed.
- **Pattern file path resolution.** Soft warning only; no validation.
- **Plugin command schema drift.** If "theirs" uses a plugin command the registry doesn't know about, it imports as-is. The export-warnings system catches some of this but not all.
- **Truly circular anchor values (M2 finding).** A genuinely circular anchor
  (`&A {self: *A}`) used as a command's `params` cannot be represented in the JS
  mirror — `extractCommand` deep-clones params via `JSON.parse(JSON.stringify(...))`,
  which throws on cycles. This is a pre-existing codebase limitation (not D4's),
  and `parseV3Protocol` itself can't mirror such a source. D4 fails *safe*: the
  topo sort handles anchor self-edges (no false cycle) and rejects genuine
  multi-node cycles; if a circular-params condition somehow reaches commit, the
  atomic rollback restores the pre-commit document. Not supported; not corrupting.
- **Product contract: snippet import, not behavior import (rev-3 review, Codex-adv).**
  D4 copies *conditions* + their direct YAML dependencies (anchors, plugin
  declarations) and appends bare sequence refs. It does **not** reproduce the
  source's block membership, repetitions, randomize, or intertrial placement —
  those live in `experiment:`, not `conditions:`. This is an accepted scope call
  (the auto-bare-ref label says so), but it means an imported condition is
  *runnable*, not *behaviorally identical to how the sibling ran it*. Sequence/
  block import is explicitly out of scope for D4 v1. Surfaced to the user as an
  open question.
- **Import provenance (rev-3 review, Codex-adv).** After export there is no durable
  record distinguishing a D4-imported `sibling__dur_short` from a user-typed one
  (only the naming convention hints at it). v1 accepts this as destructive
  copy/paste; a comment-stamp on imported nodes is a possible v1.1 add.

---

## 13. Risk register (revised)

- **YAML library edge cases.** `clone(schema)` + `anchor` mutation + `createAlias`. Mitigation: Milestone 1's primitive tests cover the API surface before any commit logic uses them. Targeted edge cases: anchors on collection nodes, anchors on scalar nodes, anchor-points-at-alias chains.
- **Staging buffer becoming a parallel architecture.** Mitigation: explicit rule (in §7 and §13) — staging touches only its own state + commits via the documented primitives. No new undo/selection/validation paths.
- **Renderer reuse underestimated.** Codex-std flagged `renderLibrary` is tightly bound; my rev 2 explicitly budgets the `renderConditionList` extraction. Mitigation: extract early in Milestone 3, before per-pane rendering.
- **User confusion about prefix-by-default.** Some users will dislike noisy anchor names. Mitigation: the prefix-edit UI is prominent at the top of the buffer; users can shorten or use empty prefix if they want. Documentation in CLAUDE.md after Milestone 4.
- **Locking "yours" is restrictive.** A user mid-edit who wants to import will lose their place. Mitigation: the `beforeunload` guard (Milestone 4) covers accidental navigation; Cancel discards staging without touching pre-import edits (the default). Note: entering import mode does **not** set dirty (rev-3 review — only commit does).
- **Partial commit (rev-3 review, Codex-std).** `commitStaging` makes many
  mutations after one `pushUndo`; a mid-commit throw could half-mutate the doc.
  Mitigation: full pre-commit validation (§5c) so the happy path can't fail on
  policy, plus a `toString()` snapshot/restore around the mutation block — commit
  is all-or-nothing. Covered by the N9 rollback test.
- **`alias.resolve` vs duplicate-anchor preflight.** We reject duplicate-anchor sources at enter, then use `alias.resolve` (which respects last-wins) for everything else. If a corner-case duplicate slips past (e.g., due to mid-stream additions to the source), `alias.resolve` will still give a defined answer. Belt-and-suspenders.

---

## 14. Decision status

**Decided (2026-05-30): APPROVED, building.** Prerequisites (Phase 4 + Phase 5)
shipped; the rev-2 → rev-3 fix list is applied in this revision; a fresh
`codex-plan-review` pass on rev 3 ran before Milestone 1 (findings reconciled).
Milestone 1 (cross-doc primitives + node-based helpers + suites N1–N6) is the
first committable unit — see `v3-d4-implementation-handoff.md` §5 for the
milestone gates.
