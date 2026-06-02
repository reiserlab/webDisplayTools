/**
 * js/v3-import.js — D4 cross-library import: cross-document primitives.
 *
 * D4 lets the user open a SECOND parsed YAML.Document ("theirs") alongside the
 * one they're editing ("yours") and copy conditions across, bringing the anchors
 * and plugin declarations those conditions depend on. yaml@2's anchors are
 * document-local, so copying a condition means cloning its node tree across docs
 * and explicitly rewiring every alias. These are the low-level primitives that
 * make that safe; the staging buffer + commit pipeline (Milestone 2) and the
 * three-pane UI (Milestone 3) build on top.
 *
 * Milestone 1 surface:
 *   - collectAliasReferences(rootNode)             → Alias node[]
 *   - resolveAlias(aliasNode, sourceDoc)           → value node | null
 *   - cloneNodeAcrossDocs(srcNode, targetDoc, map) → cloned, rewired node
 *   - yamlNodeStructuralEquals(aNode, aDoc, bNode, bDoc) → boolean
 *   - sortedJson(value)                            → deterministic JSON string
 *
 * Dual-export (mirrors js/protocol-yaml-v3.js): an `import * as YAML from 'yaml'`
 * resolves to the npm package under Node and to the vendored browser build via
 * the HTML import map. Node tests `require()` this file (Node ≥22 require(ESM));
 * the browser imports it as a module. The window-global + module.exports blocks
 * are no-ops in whichever environment they don't apply to.
 *
 * Reference: docs/development/v3-d4-design.md §4 (rev 3).
 */

'use strict';

import * as YAML from 'yaml';
import {
    parseV3Protocol,
    ensureTopLevelSection,
    docInsertConditionNode,
    docInsertVariableNode,
    docInsertPluginNode,
    docAppendSequenceEntry,
    isValidAnchorName,
    anchorExists
} from './protocol-yaml-v3.js';
import { WELL_KNOWN_RIG_PLUGIN_NAMES } from './plugin-registry.js';

// Command types the v3 schema knows (mirrors KNOWN_COMMAND_KEYS_BY_TYPE in
// protocol-yaml-v3.js). Anything else in a condition is an "unknown command
// type" — preserved as a raw card, surfaced as an informational note on import.
const KNOWN_COMMAND_TYPES = ['controller', 'wait', 'plugin'];

// The built-in always-declared plugin: a `plugin_name: log` command needs no
// source declaration and is never namespaced (collectExportWarnings treats it
// as declared). See docs/development/v3-d4-design.md §5.
const BUILTIN_PLUGIN_NAMES = ['log'];

/**
 * V3ImportError — import-pipeline failures (preflight rejection, blocked commit).
 * Carries a `code` and, for COMMIT_BLOCKED, a `blocking` array of conflict items.
 */
class V3ImportError extends Error {
    constructor(message, code, extra) {
        super(message);
        this.name = 'V3ImportError';
        this.code = code || 'IMPORT_ERROR';
        if (extra && typeof extra === 'object') Object.assign(this, extra);
    }
}

/**
 * collectAliasReferences(rootNode) → Alias node[]
 *
 * Walk a node SUBTREE (not just a Document) collecting every Alias reference, in
 * deterministic document order (depth-first pre-order, per YAML.visit). Works on
 * any node — a condition map, a value node, or a whole document.
 */
function collectAliasReferences(rootNode) {
    const aliases = [];
    if (!rootNode || typeof YAML.visit !== 'function') return aliases;
    YAML.visit(rootNode, {
        Alias(_key, node) {
            aliases.push(node);
        }
    });
    return aliases;
}

/**
 * resolveAlias(aliasNode, sourceDoc) → value node | null
 *
 * Resolve an Alias to the source-doc value node it points at, using yaml@2's
 * own `Alias.resolve(doc)`. That implements last-wins semantics: the LAST node
 * whose `.anchor` matches `aliasNode.source` and appears BEFORE the alias in
 * document order. Returns null for an unresolvable (broken) alias. This is the
 * correct API — NOT a name-based anchor-table lookup, which would bind to the
 * wrong value when a source has duplicate anchor names.
 */
function resolveAlias(aliasNode, sourceDoc) {
    if (!aliasNode || typeof aliasNode.resolve !== 'function') return null;
    return aliasNode.resolve(sourceDoc) || null;
}

/**
 * cloneNodeAcrossDocs(srcNode, targetDoc, aliasRewriteMap) → cloned node
 *
 * Deep-clone a node tree for insertion into `targetDoc`, rewriting both:
 *   - Alias REFERENCES  (`*old` → `*new`) whose `.source` is in the map, and
 *   - anchor DEFINITIONS (`&old` → `&new`) carried inside the cloned subtree
 *     whose `.anchor` is in the map.
 *
 * Rewriting anchor definitions matters for the inline-anchor case: a source
 * condition may both DEFINE and reference an inline anchor (`duration: &dur 5`
 * … `*dur`). Cloning carries the inline `&dur` along; rewriting only the alias
 * would strand a stale `&dur` and risk a document-wide duplicate-anchor blocker
 * (anchors are doc-wide in this codebase, not variables-only).
 *
 * `clone()` is intra-document: the clone lives logically in `targetDoc` (via the
 * passed schema) but its alias `.source` strings still point at the source doc's
 * anchor names until rewritten here. The SAME `aliasRewriteMap` must be used for
 * the condition AND every value-node clone in a batch so nested aliases rewrite
 * consistently. `hasOwnProperty` (not truthiness) guards each rewrite so an
 * unmapped name is left untouched and an explicit empty-string target is honored.
 */
function cloneNodeAcrossDocs(srcNode, targetDoc, aliasRewriteMap) {
    if (!srcNode || typeof srcNode.clone !== 'function') {
        throw new TypeError('cloneNodeAcrossDocs: srcNode is not a cloneable yaml node');
    }
    const map = aliasRewriteMap || {};
    const schema = targetDoc && targetDoc.schema ? targetDoc.schema : undefined;
    const cloned = srcNode.clone(schema);
    if (typeof YAML.visit === 'function') {
        YAML.visit(cloned, {
            Alias(_key, node) {
                if (node && Object.prototype.hasOwnProperty.call(map, node.source)) {
                    node.source = map[node.source];
                }
            },
            Node(_key, node) {
                if (node && node.anchor && Object.prototype.hasOwnProperty.call(map, node.anchor)) {
                    node.anchor = map[node.anchor];
                }
            }
        });
    }
    return cloned;
}

/**
 * sortedJson(value) → string
 *
 * Deterministic JSON with keys sorted recursively at every depth, so two maps
 * that differ only in key order serialize identically. A JSON.stringify replacer
 * cannot do this reliably (it sees parent objects, not a stable per-object key
 * order), so we rebuild the value with sorted keys, then stringify. `null` is
 * passed through (it is `typeof 'object'` but falsy); arrays keep their order.
 */
function sortedJson(value) {
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

/**
 * yamlNodeStructuralEquals(aNode, aDoc, bNode, bDoc) → boolean
 *
 * True when two nodes convert to structurally-equal JS values, ignoring key
 * order. `NodeBase.toJS(doc)` requires a Document argument (it throws without
 * one), so each node is resolved against its own document. An unresolvable alias
 * makes toJS throw → caught → not equal. Used ONLY on the plugin merge path
 * (deciding merge-vs-namespace); anchors never use it (they always namespace).
 */
function yamlNodeStructuralEquals(aNode, aDoc, bNode, bDoc) {
    if (!aNode || !bNode) return false;
    try {
        const a = sortedJson(aNode.toJS(aDoc));
        const b = sortedJson(bNode.toJS(bDoc));
        return a === b;
    } catch (e) {
        return false;
    }
}

// ════════════════════════════════════════════════════
// Milestone 2 — staging buffer + commit pipeline (no UI)
//
// The user enters import mode, browses "theirs", adds candidate conditions to a
// staging buffer, optionally adjusts planned names, then commits in one batch
// (one undo step) or cancels. The buffer never mutates yours._doc until commit.
// Plan (add) is pure; commit applies the §5c mutations. A per-batch dependency
// registry shared across all items dedups anchors/plugins. See design §5/§7.
// ════════════════════════════════════════════════════

// ── small pure utilities ────────────────────────────────────────────────────

/**
 * derivePrefix(filename) → 'stem__' (anchor-safe) | ''
 * `sibling_lab.yaml` → `sibling_lab__`. Strips any directory + extension and
 * replaces non-[A-Za-z0-9_-] characters with `_`.
 */
function derivePrefix(filename) {
    const base = String(filename || '')
        .replace(/^.*[\\/]/, '')
        .replace(/\.[^.]+$/, '');
    const safe = base.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe ? safe + '__' : '';
}

/** Find the unique value node defining `anchorName` in `doc` (null if none). */
function _findAnchorNode(doc, anchorName) {
    let found = null;
    if (!doc || typeof YAML.visit !== 'function') return null;
    YAML.visit(doc, {
        Node(_key, node) {
            if (node && node.anchor === anchorName) {
                found = node;
                return YAML.visit.BREAK;
            }
        }
    });
    return found;
}

/** Names of anchors defined more than once anywhere in `doc` (duplicate-anchor preflight). */
function detectDuplicateAnchors(doc) {
    const seen = Object.create(null);
    const dupes = [];
    if (!doc || typeof YAML.visit !== 'function') return dupes;
    YAML.visit(doc, {
        Node(_key, node) {
            if (node && node.anchor) {
                if (seen[node.anchor]) {
                    if (!dupes.includes(node.anchor)) dupes.push(node.anchor);
                } else {
                    seen[node.anchor] = true;
                }
            }
        }
    });
    return dupes;
}

/** A plugin mirror's identity projection = every field except `name`. */
function _pluginProjection(pluginMirror) {
    const out = {};
    for (const k of Object.keys(pluginMirror)) {
        if (k === 'name') continue;
        out[k] = pluginMirror[k];
    }
    return out;
}

/** True when a plugin declares no hardware-specific fields (config/port/baudrate/script_path). */
function _pluginIsConfigLess(p) {
    const hasConfig = p.config && typeof p.config === 'object' && Object.keys(p.config).length > 0;
    return (
        !hasConfig &&
        p.port === undefined &&
        p.baudrate === undefined &&
        p.script_path === undefined
    );
}

/** suggestUniqueName('arena check', set) → 'arena check' | 'arena check_2' | … */
function suggestUniqueName(base, takenSet) {
    if (!takenSet.has(base)) return base;
    let n = 2;
    while (takenSet.has(base + '_' + n)) n++;
    return base + '_' + n;
}

/** Prepend a provenance comment line to a node's commentBefore (idempotent-ish). */
function _stampProvenance(node, filename) {
    if (!node) return;
    const stamp = ' imported from ' + (filename || 'another protocol');
    if (node.commentBefore && node.commentBefore.indexOf(stamp) !== -1) return;
    node.commentBefore = node.commentBefore ? stamp + '\n' + node.commentBefore : stamp;
}

/**
 * Topologically order anchor source-names so any anchor whose value references
 * another imported anchor comes AFTER it (yaml@2 needs anchor-before-alias).
 * Self-edges (a: &A {self: *A}) are ignored. A genuine multi-node cycle throws
 * (it cannot be stringified in any order). registry: Map<srcName, {srcValueNode}>.
 */
function _topoSortAnchors(registry) {
    const names = Array.from(registry.keys());
    const inReg = new Set(names);
    // deps[name] = set of registry anchors that `name`'s value references
    const deps = new Map();
    for (const name of names) {
        const entry = registry.get(name);
        const refs = collectAliasReferences(entry.srcValueNode).map((a) => a.source);
        const d = new Set();
        for (const r of refs) {
            if (r !== name && inReg.has(r)) d.add(r); // ignore self-edge + external refs
        }
        deps.set(name, d);
    }
    const ordered = [];
    const state = new Map(); // name → 'visiting' | 'done'
    function visit(name, stack) {
        const s = state.get(name);
        if (s === 'done') return;
        if (s === 'visiting') {
            throw new V3ImportError(
                'topological sort: anchor dependency cycle among imported anchors (' +
                    stack.concat(name).join(' → ') +
                    ')',
                'ANCHOR_CYCLE'
            );
        }
        state.set(name, 'visiting');
        for (const dep of deps.get(name)) visit(dep, stack.concat(name));
        state.set(name, 'done');
        ordered.push(name);
    }
    for (const name of names) visit(name, []);
    return ordered; // dependency-first
}

/** Rewrite literal `plugin_name:` scalar values inside a cloned condition node. */
function _rewritePluginNamesInClone(clonedCondNode, pluginNameRewrite) {
    if (typeof YAML.visit !== 'function') return;
    YAML.visit(clonedCondNode, {
        Pair(_key, pair) {
            const k = pair.key && pair.key.value !== undefined ? pair.key.value : null;
            if (k !== 'plugin_name') return;
            const v = pair.value;
            if (v && !YAML.isAlias(v) && v.value !== undefined) {
                if (Object.prototype.hasOwnProperty.call(pluginNameRewrite, v.value)) {
                    v.value = pluginNameRewrite[v.value];
                }
            }
        }
    });
}

// ── staging buffer ───────────────────────────────────────────────────────────

/**
 * createStagingBuffer(srcExperiment, srcFilename, opts) → staging
 *
 * Build an empty staging buffer over a parsed "theirs" experiment. Runs the
 * duplicate-anchor preflight (#6) — broken-alias sources are already rejected by
 * parseV3Protocol's toJS(). opts.prefix overrides the filename-derived default.
 */
function createStagingBuffer(srcExperiment, srcFilename, opts) {
    if (!srcExperiment || !srcExperiment._doc) {
        throw new V3ImportError('createStagingBuffer: source has no _doc handle', 'NO_DOC');
    }
    const dupes = detectDuplicateAnchors(srcExperiment._doc);
    if (dupes.length > 0) {
        throw new V3ImportError(
            'createStagingBuffer: source YAML defines duplicate anchor name(s): ' +
                dupes.join(', ') +
                '. Resolve them in the source before importing.',
            'DUPLICATE_ANCHOR_SOURCE',
            { duplicates: dupes }
        );
    }
    const options = opts || {};
    const prefix = options.prefix !== undefined ? options.prefix : derivePrefix(srcFilename);
    // Extra canonical plugin names from a loaded TARGET rig (#89). The well-known
    // names (camera/backlight/temperature) are always treated as canonical; this
    // set adds any further plugin names the user's loaded rig declares.
    const rigPluginNames = new Set(Array.isArray(options.rigPluginNames) ? options.rigPluginNames : []);
    return {
        src: { doc: srcExperiment._doc, experiment: srcExperiment, filename: srcFilename || '' },
        prefix: prefix,
        rigPluginNames: rigPluginNames,
        batch: {
            anchorRegistry: new Map(), // srcName → { srcValueNode, plannedName, override }
            pluginRegistry: new Map(), // srcName → { srcEntryNode, plannedName, override, action, mergeWith, canonical }
            visitedAnchors: new Set()
        },
        items: [],
        addBareRefs: options.addBareRefs !== undefined ? !!options.addBareRefs : true,
        _yours: null // set on first addToStaging; used by validation refresh
    };
}

// True when `name` is a rig-canonical plugin name that must never be prefixed on
// import — a well-known rig key, or one the loaded target rig declares (#89).
function _isCanonicalRigName(staging, name) {
    if (WELL_KNOWN_RIG_PLUGIN_NAMES.indexOf(name) !== -1) return true;
    return !!(staging.rigPluginNames && staging.rigPluginNames.has(name));
}

// Walk a source value/condition node, registering every transitively-referenced
// anchor into the shared registry (visited-set closure, #5).
function _closeAnchors(staging, seedNode) {
    const reg = staging.batch.anchorRegistry;
    const visited = staging.batch.visitedAnchors;
    const work = collectAliasReferences(seedNode).map((a) => a.source);
    while (work.length) {
        const name = work.shift();
        if (visited.has(name)) continue;
        visited.add(name);
        const valNode = _findAnchorNode(staging.src.doc, name);
        if (!valNode) continue; // broken alias — preflight blocks; defensive skip
        if (!reg.has(name)) {
            reg.set(name, {
                srcValueNode: valNode,
                plannedName: staging.prefix + name,
                override: false
            });
        }
        for (const a of collectAliasReferences(valNode)) {
            if (!visited.has(a.source)) work.push(a.source);
        }
    }
}

// Decide merge-vs-namespace for a source plugin against yours (broadened identity).
function _computePluginAction(staging, srcPluginMirror, yoursExperiment) {
    const name = srcPluginMirror.name;
    // #89: the rig defines canonical plugin names; never prefix one. Bind to the
    // canonical name so the plugin inherits the target rig's config at runtime —
    // even when the target protocol doesn't declare it yet.
    if (_isCanonicalRigName(staging, name)) {
        const existing = (yoursExperiment.plugins || []).find((p) => p.name === name);
        if (existing) {
            return { action: 'merge', mergeWith: existing.name, plannedName: existing.name };
        }
        return { action: 'add', mergeWith: null, plannedName: name, canonical: true };
    }
    const srcProj = sortedJson(_pluginProjection(srcPluginMirror));
    const srcRig = staging.src.experiment.rig_path;
    const yoursRig = yoursExperiment.rig_path;
    for (const yp of yoursExperiment.plugins || []) {
        if (sortedJson(_pluginProjection(yp)) === srcProj) {
            // structurally identical (minus name); guard config-less cross-rig merges
            if (
                _pluginIsConfigLess(srcPluginMirror) &&
                _pluginIsConfigLess(yp) &&
                srcRig !== yoursRig
            ) {
                continue;
            }
            return { action: 'merge', mergeWith: yp.name, plannedName: yp.name };
        }
    }
    return { action: 'add', mergeWith: null, plannedName: staging.prefix + srcPluginMirror.name };
}

/**
 * addToStaging(staging, sourceCondIdx, yoursExperiment) → staging
 *
 * Compute the import plan for one source condition and push it as an item,
 * folding its anchor + plugin dependencies into the shared per-batch registry.
 * Idempotent on a sourceCondIdx already staged.
 */
function addToStaging(staging, sourceCondIdx, yoursExperiment) {
    staging._yours = yoursExperiment;
    if (staging.items.some((it) => it.sourceCondIdx === sourceCondIdx)) return staging;

    const srcCondNode = staging.src.doc.getIn(['conditions', sourceCondIdx], true);
    if (!srcCondNode || !Array.isArray(srcCondNode.items)) {
        throw new V3ImportError('addToStaging: bad sourceCondIdx ' + sourceCondIdx, 'BAD_INDEX');
    }
    const srcCondMirror = staging.src.experiment.conditions[sourceCondIdx];
    const originalName = srcCondMirror ? srcCondMirror.name : String(srcCondNode.get('name'));

    // 1. anchors referenced by the condition (transitive closure)
    _closeAnchors(staging, srcCondNode);

    // 2. plugins referenced by the condition's commands
    const anchorRefs = collectAliasReferences(srcCondNode).map((a) => a.source);
    const pluginRefs = [];
    const aliasBoundPluginNames = [];
    const unknownCommandTypes = [];
    const undeclaredPlugins = [];
    const cmdsSeq = srcCondNode.get('commands', true);
    if (cmdsSeq && Array.isArray(cmdsSeq.items)) {
        for (const cmdNode of cmdsSeq.items) {
            if (!cmdNode || typeof cmdNode.get !== 'function') continue;
            const typeNode = cmdNode.get('type', true);
            const type = typeNode && typeNode.value !== undefined ? typeNode.value : typeNode;
            if (type === 'plugin') {
                const pnNode = cmdNode.get('plugin_name', true);
                if (pnNode && YAML.isAlias(pnNode)) {
                    if (!aliasBoundPluginNames.includes(pnNode.source)) {
                        aliasBoundPluginNames.push(pnNode.source);
                    }
                    continue;
                }
                const pn = pnNode && pnNode.value !== undefined ? pnNode.value : pnNode;
                if (typeof pn !== 'string') continue;
                if (BUILTIN_PLUGIN_NAMES.includes(pn)) continue; // built-in: leave as-is
                if (!staging.batch.pluginRegistry.has(pn)) {
                    const srcPluginMirror = (staging.src.experiment.plugins || []).find(
                        (p) => p.name === pn
                    );
                    const srcEntryNode = _findPluginEntryNode(staging.src.doc, pn);
                    if (!srcPluginMirror || !srcEntryNode) {
                        if (!undeclaredPlugins.includes(pn)) undeclaredPlugins.push(pn);
                    } else {
                        const act = _computePluginAction(staging, srcPluginMirror, yoursExperiment);
                        staging.batch.pluginRegistry.set(pn, {
                            srcEntryNode: srcEntryNode,
                            plannedName: act.plannedName,
                            override: false,
                            action: act.action,
                            mergeWith: act.mergeWith,
                            canonical: !!act.canonical
                        });
                        // plugin config may reference anchors the condition doesn't
                        if (act.action === 'add') _closeAnchors(staging, srcEntryNode);
                    }
                }
                if (!pluginRefs.includes(pn)) pluginRefs.push(pn);
            } else if (type && !KNOWN_COMMAND_TYPES.includes(type)) {
                if (!unknownCommandTypes.includes(type)) unknownCommandTypes.push(type);
            }
        }
    }

    staging.items.push({
        sourceCondIdx: sourceCondIdx,
        originalName: originalName,
        targetName: originalName,
        targetNameOverride: false,
        conditionNameCollision: false,
        anchorRefs: anchorRefs,
        pluginRefs: pluginRefs,
        unknownCommandTypes: unknownCommandTypes,
        aliasBoundPluginNames: aliasBoundPluginNames,
        undeclaredPlugins: undeclaredPlugins
    });

    refreshStagingValidation(staging, yoursExperiment);
    return staging;
}

/** Find the plugins[] entry node whose name === pluginName (null if none). */
function _findPluginEntryNode(doc, pluginName) {
    const plugins = doc.getIn(['plugins'], true);
    if (!plugins || !Array.isArray(plugins.items)) return null;
    for (const entry of plugins.items) {
        if (!entry || typeof entry.get !== 'function') continue;
        const nameNode = entry.get('name', true);
        const n = nameNode && nameNode.value !== undefined ? nameNode.value : nameNode;
        if (n === pluginName) return entry;
    }
    return null;
}

/** removeFromStaging(staging, itemIdx) → staging. Rebuilds the registry from scratch. */
function removeFromStaging(staging, itemIdx) {
    if (itemIdx < 0 || itemIdx >= staging.items.length) return staging;
    staging.items.splice(itemIdx, 1);
    _rebuildRegistry(staging);
    if (staging._yours) refreshStagingValidation(staging, staging._yours);
    return staging;
}

// Recompute the shared registry from the remaining items (preserving overrides).
function _rebuildRegistry(staging) {
    const oldAnchors = staging.batch.anchorRegistry;
    const oldPlugins = staging.batch.pluginRegistry;
    staging.batch.anchorRegistry = new Map();
    staging.batch.pluginRegistry = new Map();
    staging.batch.visitedAnchors = new Set();
    const yours = staging._yours;
    const items = staging.items.slice();
    // re-derive from each item's source condition
    for (const it of items) {
        const srcCondNode = staging.src.doc.getIn(['conditions', it.sourceCondIdx], true);
        if (srcCondNode) _closeAnchors(staging, srcCondNode);
        for (const pn of it.pluginRefs) {
            if (staging.batch.pluginRegistry.has(pn)) continue;
            const srcPluginMirror = (staging.src.experiment.plugins || []).find(
                (p) => p.name === pn
            );
            const srcEntryNode = _findPluginEntryNode(staging.src.doc, pn);
            if (srcPluginMirror && srcEntryNode && yours) {
                const act = _computePluginAction(staging, srcPluginMirror, yours);
                staging.batch.pluginRegistry.set(pn, {
                    srcEntryNode: srcEntryNode,
                    plannedName: act.plannedName,
                    override: false,
                    action: act.action,
                    mergeWith: act.mergeWith,
                    canonical: !!act.canonical
                });
                if (act.action === 'add') _closeAnchors(staging, srcEntryNode);
            }
        }
    }
    // restore explicit name overrides
    for (const [name, entry] of staging.batch.anchorRegistry) {
        const old = oldAnchors.get(name);
        if (old && old.override) {
            entry.plannedName = old.plannedName;
            entry.override = true;
        }
    }
    for (const [name, entry] of staging.batch.pluginRegistry) {
        const old = oldPlugins.get(name);
        if (old && old.override && entry.action === 'add') {
            entry.plannedName = old.plannedName;
            entry.override = true;
        }
    }
}

/**
 * setStagingPrefix(staging, newPrefix) → staging
 * Recompute every non-overridden planned anchor/plugin name from the new prefix.
 * Explicitly-typed names (override) persist (#4-defaults).
 */
function setStagingPrefix(staging, newPrefix) {
    staging.prefix = String(newPrefix || '');
    for (const [name, entry] of staging.batch.anchorRegistry) {
        if (!entry.override) entry.plannedName = staging.prefix + name;
    }
    for (const [name, entry] of staging.batch.pluginRegistry) {
        // Canonical rig binds keep their (un-prefixed) name regardless of prefix (#89).
        if (entry.action === 'add' && !entry.override && !entry.canonical) {
            entry.plannedName = staging.prefix + name;
        }
    }
    if (staging._yours) refreshStagingValidation(staging, staging._yours);
    return staging;
}

/** setItemTargetName(staging, itemIdx, newName) → staging. Marks an explicit override. */
function setItemTargetName(staging, itemIdx, newName) {
    const item = staging.items[itemIdx];
    if (!item) return staging;
    item.targetName = String(newName);
    item.targetNameOverride = true;
    if (staging._yours) refreshStagingValidation(staging, staging._yours);
    return staging;
}

/** setAnchorPlannedName(staging, srcAnchorName, newName) → staging (explicit override). */
function setAnchorPlannedName(staging, srcAnchorName, newName) {
    const entry = staging.batch.anchorRegistry.get(srcAnchorName);
    if (!entry) return staging;
    entry.plannedName = String(newName);
    entry.override = true;
    if (staging._yours) refreshStagingValidation(staging, staging._yours);
    return staging;
}

/** setPluginPlannedName(staging, srcPluginName, newName) → staging (explicit override). */
function setPluginPlannedName(staging, srcPluginName, newName) {
    const entry = staging.batch.pluginRegistry.get(srcPluginName);
    if (!entry || entry.action !== 'add') return staging;
    // Canonical rig binds are non-renamable — renaming would re-break rig binding (#89).
    if (entry.canonical) return staging;
    entry.plannedName = String(newName);
    entry.override = true;
    if (staging._yours) refreshStagingValidation(staging, staging._yours);
    return staging;
}

/**
 * validateStaging(staging, yoursExperiment) → { ok, blocking: [...], warnings: [...] }
 *
 * Pure pre-commit validation (#2/#6/#7/#10): condition-name collisions, planned
 * anchor-name validity + collisions, plugin namespace collisions, alias-bound
 * plugin_name, real anchor cycles. Informational notes (unknown command,
 * undeclared plugin) go to warnings.
 */
function validateStaging(staging, yoursExperiment) {
    const blocking = [];
    const warnings = [];

    // condition target names: unique across yours + all staged items
    const existingCondNames = new Set((yoursExperiment.conditions || []).map((c) => c.name));
    const stagedNames = new Set();
    for (const item of staging.items) {
        if (existingCondNames.has(item.targetName) || stagedNames.has(item.targetName)) {
            blocking.push({
                kind: 'condition-name-collision',
                name: item.targetName,
                detail: 'condition "' + item.targetName + '" already exists'
            });
        }
        stagedNames.add(item.targetName);
        if (item.aliasBoundPluginNames && item.aliasBoundPluginNames.length) {
            for (const an of item.aliasBoundPluginNames) {
                blocking.push({
                    kind: 'alias-bound-plugin-name',
                    name: an,
                    detail:
                        'plugin_name is alias-bound (*' + an + '); use a literal name in the source'
                });
            }
        }
        if (item.unknownCommandTypes && item.unknownCommandTypes.length) {
            warnings.push({
                kind: 'unknown-command-type',
                name: item.targetName,
                detail: 'unknown command type(s): ' + item.unknownCommandTypes.join(', ')
            });
        }
        if (item.undeclaredPlugins && item.undeclaredPlugins.length) {
            warnings.push({
                kind: 'undeclared-plugin',
                name: item.targetName,
                detail: 'plugin(s) not declared in source: ' + item.undeclaredPlugins.join(', ')
            });
        }
    }

    // planned anchor names: valid + no collision with yours or each other
    const plannedAnchorNames = new Set();
    for (const [, entry] of staging.batch.anchorRegistry) {
        const pn = entry.plannedName;
        if (!isValidAnchorName(pn)) {
            blocking.push({
                kind: 'invalid-anchor-name',
                name: pn,
                detail: 'invalid anchor name "' + pn + '"'
            });
            continue;
        }
        if (anchorExists(yoursExperiment, pn) || plannedAnchorNames.has(pn)) {
            blocking.push({
                kind: 'anchor-name-collision',
                name: pn,
                detail: 'anchor "' + pn + '" already exists (edit the name or prefix)'
            });
        }
        plannedAnchorNames.add(pn);
    }

    // planned plugin names (action add): no collision with yours or each other
    const existingPluginNames = new Set((yoursExperiment.plugins || []).map((p) => p.name));
    const plannedPluginNames = new Set();
    for (const [, entry] of staging.batch.pluginRegistry) {
        if (entry.action !== 'add') continue;
        const pn = entry.plannedName;
        if (existingPluginNames.has(pn) || plannedPluginNames.has(pn)) {
            blocking.push({
                kind: 'plugin-name-collision',
                name: pn,
                detail: 'plugin "' + pn + '" already exists (bump the prefix)'
            });
        }
        plannedPluginNames.add(pn);
    }

    // real anchor cycle among imported anchors (self-edges are fine)
    try {
        _topoSortAnchors(staging.batch.anchorRegistry);
    } catch (e) {
        blocking.push({ kind: 'anchor-cycle', name: '', detail: e.message });
    }

    return { ok: blocking.length === 0, blocking: blocking, warnings: warnings };
}

// Refresh per-item collision flags + cache the validation result on staging.
function refreshStagingValidation(staging, yoursExperiment) {
    const existing = new Set((yoursExperiment.conditions || []).map((c) => c.name));
    const seen = new Set();
    for (const item of staging.items) {
        const taken = new Set([...existing, ...seen]);
        if (taken.has(item.targetName)) {
            item.conditionNameCollision = suggestUniqueName(item.targetName, taken);
        } else {
            item.conditionNameCollision = false;
        }
        seen.add(item.targetName);
    }
    staging._validation = validateStaging(staging, yoursExperiment);
    return staging._validation;
}

/**
 * commitStaging(staging, yoursExperiment) → summary
 *
 * Apply the whole batch to yours._doc + the JS mirror in one shot. Validates
 * first (throws V3ImportError COMMIT_BLOCKED with .blocking on any conflict),
 * then snapshots yours._doc.toString() and restores it on any mid-commit throw
 * (atomic — all-or-nothing). Does NOT call pushUndo (the UI wrapper does that
 * once, before calling this). Returns a summary of what changed.
 */
function commitStaging(staging, yoursExperiment) {
    const validation = validateStaging(staging, yoursExperiment);
    if (!validation.ok) {
        throw new V3ImportError(
            'commitStaging: ' +
                validation.blocking.length +
                ' blocking conflict(s) must be resolved first',
            'COMMIT_BLOCKED',
            { blocking: validation.blocking }
        );
    }

    const snapshot = yoursExperiment._doc.toString();
    const filename = staging.src.filename;
    const summary = {
        conditionsAdded: [],
        anchorsAdded: [],
        pluginsAdded: [],
        pluginsMerged: [],
        bareRefsAdded: 0,
        warnings: validation.warnings
    };

    try {
        // one shared alias rewrite map: srcAnchorName → plannedName
        const aliasRewriteMap = {};
        for (const [srcName, entry] of staging.batch.anchorRegistry) {
            aliasRewriteMap[srcName] = entry.plannedName;
        }
        // plugin_name rewrite map: srcName → plannedName (add AND merge)
        const pluginNameRewrite = {};
        for (const [srcName, entry] of staging.batch.pluginRegistry) {
            pluginNameRewrite[srcName] = entry.plannedName;
        }

        // 1. anchors → variables, in dependency-first (topological) order.
        // Stamp the inserted pair's KEY (not the value) so the provenance comment
        // renders cleanly above the `key: &anchor value` line instead of splitting it.
        for (const srcName of _topoSortAnchors(staging.batch.anchorRegistry)) {
            const entry = staging.batch.anchorRegistry.get(srcName);
            const clonedVal = cloneNodeAcrossDocs(
                entry.srcValueNode,
                yoursExperiment._doc,
                aliasRewriteMap
            );
            docInsertVariableNode(yoursExperiment, entry.plannedName, clonedVal);
            const varsNode = yoursExperiment._doc.getIn(['variables'], true);
            const insertedPair = varsNode.items[varsNode.items.length - 1];
            if (insertedPair && insertedPair.key) _stampProvenance(insertedPair.key, filename);
            summary.anchorsAdded.push(entry.plannedName);
        }

        // 2. plugins → merge (no-op) or add
        for (const [, entry] of staging.batch.pluginRegistry) {
            if (entry.action === 'merge') {
                summary.pluginsMerged.push(entry.mergeWith);
                continue;
            }
            const clonedPlugin = cloneNodeAcrossDocs(
                entry.srcEntryNode,
                yoursExperiment._doc,
                aliasRewriteMap
            );
            if (typeof clonedPlugin.set === 'function') clonedPlugin.set('name', entry.plannedName);
            _stampProvenance(clonedPlugin, filename);
            docInsertPluginNode(yoursExperiment, clonedPlugin);
            summary.pluginsAdded.push(entry.plannedName);
        }

        // 3. conditions
        for (const item of staging.items) {
            const srcCondNode = staging.src.doc.getIn(['conditions', item.sourceCondIdx], true);
            const clonedCond = cloneNodeAcrossDocs(
                srcCondNode,
                yoursExperiment._doc,
                aliasRewriteMap
            );
            if (typeof clonedCond.set === 'function') clonedCond.set('name', item.targetName);
            _rewritePluginNamesInClone(clonedCond, pluginNameRewrite);
            _stampProvenance(clonedCond, filename);
            docInsertConditionNode(yoursExperiment, clonedCond);
            summary.conditionsAdded.push(item.targetName);
        }

        // 4. optional bare sequence refs
        if (staging.addBareRefs) {
            for (const item of staging.items) {
                docAppendSequenceEntry(yoursExperiment, {
                    kind: 'ref',
                    condition_name: item.targetName
                });
                summary.bareRefsAdded++;
            }
        }
    } catch (err) {
        // atomic rollback: re-parse the pre-commit snapshot back into yoursExperiment
        _restoreExperimentInPlace(yoursExperiment, snapshot);
        throw new V3ImportError(
            'commitStaging: aborted and rolled back after error: ' + err.message,
            'COMMIT_FAILED',
            { cause: err }
        );
    }

    return summary;
}

// Re-parse `yamlText` and copy its fields onto `experiment` in place, so callers
// holding the same reference see the restored state (used by commit rollback).
// protocol-yaml-v3.js does not import this module, so the top-level import is
// cycle-free.
function _restoreExperimentInPlace(experiment, yamlText) {
    const fresh = parseV3Protocol(yamlText);
    for (const k of Object.keys(experiment)) delete experiment[k];
    Object.assign(experiment, fresh);
}

// ════════════════════════════════════════════════════
// Exports (dual: ES module + CommonJS + browser global)
// ════════════════════════════════════════════════════

const V3Import = {
    // Milestone 1 — cross-doc primitives
    collectAliasReferences,
    resolveAlias,
    cloneNodeAcrossDocs,
    yamlNodeStructuralEquals,
    sortedJson,
    // Milestone 2 — staging buffer + commit pipeline
    V3ImportError,
    derivePrefix,
    detectDuplicateAnchors,
    suggestUniqueName,
    createStagingBuffer,
    addToStaging,
    removeFromStaging,
    setStagingPrefix,
    setItemTargetName,
    setAnchorPlannedName,
    setPluginPlannedName,
    validateStaging,
    refreshStagingValidation,
    commitStaging
};

// Browser global
if (typeof window !== 'undefined') {
    window.V3Import = V3Import;
}

// Node.js / CommonJS (skipped under ESM, where `module` is undefined)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = V3Import;
}

// ES module export
export {
    // Milestone 1
    collectAliasReferences,
    resolveAlias,
    cloneNodeAcrossDocs,
    yamlNodeStructuralEquals,
    sortedJson,
    // Milestone 2
    V3ImportError,
    derivePrefix,
    detectDuplicateAnchors,
    suggestUniqueName,
    createStagingBuffer,
    addToStaging,
    removeFromStaging,
    setStagingPrefix,
    setItemTargetName,
    setAnchorPlannedName,
    setPluginPlannedName,
    validateStaging,
    refreshStagingValidation,
    commitStaging
};
export default V3Import;
