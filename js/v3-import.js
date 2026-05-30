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
// Exports (dual: ES module + CommonJS + browser global)
// ════════════════════════════════════════════════════

const V3Import = {
    collectAliasReferences,
    resolveAlias,
    cloneNodeAcrossDocs,
    yamlNodeStructuralEquals,
    sortedJson
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
    collectAliasReferences,
    resolveAlias,
    cloneNodeAcrossDocs,
    yamlNodeStructuralEquals,
    sortedJson
};
export default V3Import;
