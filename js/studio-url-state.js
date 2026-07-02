/**
 * studio-url-state.js — Arena Studio URL state codec (#107, DOM-free, testable).
 *
 * Encodes/decodes the shareable link params: mode / p / lib / dock / set.
 * Shareability boundary (design §9): `p`/`lib` resolve ONLY to committed
 * protocol keys (validated against protocols/index.json by the caller); a
 * locally file-picked YAML has NO shareable URL, so encode() omits p/set when
 * the doc is local. Running-experiment progress is deliberately NOT encoded.
 *
 * Security: decode() clamps `mode` to run|edit|console, drops unknown enum
 * values, and rejects path-traversal even though paths come from a committed
 * registry (belt-and-suspenders: a malformed committed index must not fetch
 * arbitrary URLs). A shared PRIMARY protocol (`p`) forces `edit` back to Run
 * (newbie-safety — never open someone's shared protocol in an editable view);
 * `console` is always honored (bench links; connect-gated, protocol-agnostic).
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES
 * `export`).
 */
(function (global) {
    'use strict';

    const MODES = ['run', 'edit', 'console'];
    const DOCKS = ['closed', 'quick', 'stepper', 'stream', 'raw', 'mem'];
    // A committed protocol/pattern-set key: conservative slug, no separators.
    const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
    // A safe committed path under an allowed dir — no traversal, no scheme.
    const SAFE_PATH_RE = /^\.\/(protocols|configs)\/[\w./-]+\.ya?ml$/;

    function isSafeKey(k) {
        return typeof k === 'string' && KEY_RE.test(k);
    }

    // Reject `..`, leading `/`, backslashes, and URL schemes; require the safe shape.
    function isSafePath(p) {
        if (typeof p !== 'string' || !p) return false;
        if (p.includes('..') || p.includes('\\')) return false;
        if (/^\//.test(p) || /^[a-z]+:/i.test(p) || p.startsWith('//')) return false;
        return SAFE_PATH_RE.test(p);
    }

    /**
     * Decode a location.search string into validated state + warnings.
     * @param {string} search  e.g. '?p=looming_v3&mode=edit'
     * @param {object} [opts]   {allowedKeys?: string[]} committed protocol keys
     * @returns {{state: object, warnings: string[]}}
     */
    function decode(search, opts) {
        const o = opts || {};
        const allowed = o.allowedKeys ? new Set(o.allowedKeys) : null;
        const warnings = [];
        const params = new URLSearchParams(search || '');
        const state = {};

        // p / lib — committed keys only.
        for (const key of ['p', 'lib']) {
            const v = params.get(key);
            if (v == null) continue;
            if (!isSafeKey(v)) {
                warnings.push('Ignored ' + key + '=' + v + ' (invalid key)');
                continue;
            }
            if (allowed && !allowed.has(v)) {
                warnings.push('Ignored ' + key + '=' + v + ' (not a known protocol)');
                continue;
            }
            state[key] = v;
        }

        // mode — clamp; shared links (a `p`/`lib` present) always open in Run.
        let mode = params.get('mode');
        if (mode != null && !MODES.includes(mode)) {
            warnings.push('Ignored mode=' + mode);
            mode = null;
        }
        // A shared PRIMARY protocol (`p`) always opens in Run (newbie-safety). A
        // `lib`-only link is a D4 import source → authoring intent → honor `edit`.
        if (mode === 'edit' && state.p) {
            warnings.push('Shared link opened in Run (mode=edit ignored for a shared protocol)');
            mode = 'run';
        }
        state.mode = mode || 'run';

        // dock / set — clamp to enum / safe key.
        const dock = params.get('dock');
        if (dock != null) {
            if (DOCKS.includes(dock)) state.dock = dock;
            else warnings.push('Ignored dock=' + dock);
        }
        const set = params.get('set');
        if (set != null) {
            if (isSafeKey(set)) state.set = set;
            else warnings.push('Ignored set=' + set);
        }

        return { state: state, warnings: warnings };
    }

    /**
     * Encode a state object to a query string (leading '?', or '' if empty).
     * A local (non-committed) doc omits p/set — they aren't shareable.
     * @param {object} state {mode, p, lib, dock, set, source?: 'local'|'committed'}
     */
    function encode(state) {
        const s = state || {};
        const params = new URLSearchParams();
        const local = s.source === 'local';
        if (s.mode && s.mode !== 'run' && MODES.includes(s.mode)) params.set('mode', s.mode);
        if (!local && isSafeKey(s.p)) params.set('p', s.p);
        if (isSafeKey(s.lib)) params.set('lib', s.lib);
        if (s.dock && DOCKS.includes(s.dock) && s.dock !== 'closed') params.set('dock', s.dock);
        if (!local && isSafeKey(s.set)) params.set('set', s.set);
        const q = params.toString();
        return q ? '?' + q : '';
    }

    const StudioUrlState = { encode, decode, isSafeKey, isSafePath, MODES, DOCKS };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioUrlState;
    }
    if (typeof global !== 'undefined') {
        global.StudioUrlState = StudioUrlState;
    }
})(typeof window !== 'undefined' ? window : this);
