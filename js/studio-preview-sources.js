/**
 * studio-preview-sources.js — where a pattern thumbnail's bytes come from (Arena Studio).
 *
 * The Studio previews a pattern by FILENAME from several byte sources that arrive at
 * different times: the site's built-in library (a same-origin manifest), the course
 * repo's shared `patterns/` folder (a GitHub listing), an opened protocol's colocated
 * `<proto>_patterns/` folder (another GitHub listing) and bytes uploaded to the SD card
 * this session. When two sources share a filename the more specific one must win:
 *
 *     builtin  <  shared  <  colocated  <  uploaded        (low → high precedence)
 *
 * This used to be "last write wins" on one Map, which only came out right because the
 * Studio AWAITED the shared GitHub listing before loading a `?p=` protocol. That await
 * is what left a `?p=` link empty until a refresh when api.github.com stalled (LAB-303
 * S2, ww18 2026-10-15). Layers make the precedence independent of arrival order, so no
 * best-effort listing has to gate the page.
 *
 * The registry reads like a Map of the EFFECTIVE sources: get / has / iteration
 * (`for (const [name, fn] of reg)`) see one entry per filename, from the highest layer
 * that has it. Writes name their layer: set(layer, name, fn), replaceLayer(layer, entries).
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES `export`).
 */
(function (global) {
    'use strict';

    const LAYERS = ['builtin', 'shared', 'colocated', 'uploaded'];

    function create(layers) {
        const order = Array.isArray(layers) && layers.length ? layers.slice() : LAYERS.slice();
        const maps = new Map(order.map((l) => [l, new Map()]));
        const byPrecedence = order.slice().reverse();
        const layerMap = (layer) => {
            const m = maps.get(layer);
            if (!m) throw new Error('StudioPreviewSources: unknown layer "' + layer + '"');
            return m;
        };
        const layerOf = (name) => {
            for (const l of byPrecedence) if (maps.get(l).has(name)) return l;
            return null;
        };
        return {
            /** Register one source in `layer` (replaces that layer's entry for `name`). */
            set(layer, name, fn) {
                layerMap(layer).set(name, fn);
                return this;
            },
            /** Drop one layer's entries and install `entries` ([name, fn] pairs) instead. */
            replaceLayer(layer, entries) {
                const m = layerMap(layer);
                m.clear();
                for (const [name, fn] of entries || []) m.set(name, fn);
                return this;
            },
            clearLayer(layer) {
                layerMap(layer).clear();
                return this;
            },
            /** The effective source for `name` (highest layer), or undefined. */
            get(name) {
                const l = layerOf(name);
                return l ? maps.get(l).get(name) : undefined;
            },
            has(name) {
                return layerOf(name) !== null;
            },
            /** Which layer serves `name` now, or null. */
            layerOf,
            /** Filenames registered in one layer. */
            namesIn(layer) {
                return Array.from(layerMap(layer).keys());
            },
            get size() {
                const names = new Set();
                for (const m of maps.values()) for (const k of m.keys()) names.add(k);
                return names.size;
            },
            /** Effective [name, fn] pairs, one per filename. */
            *[Symbol.iterator]() {
                const seen = new Set();
                for (const l of byPrecedence) {
                    for (const [name, fn] of maps.get(l)) {
                        if (seen.has(name)) continue;
                        seen.add(name);
                        yield [name, fn];
                    }
                }
            }
        };
    }

    const StudioPreviewSources = { create, LAYERS: LAYERS.slice() };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioPreviewSources;
    }
    if (typeof global !== 'undefined') {
        global.StudioPreviewSources = StudioPreviewSources;
    }
})(typeof window !== 'undefined' ? window : this);
