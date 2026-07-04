/**
 * studio-meta.js — Arena Studio run metadata helpers (DOM-free, testable).
 *
 * Pure helpers behind the Run-view metadata side panel and the read-only lock:
 *   - makeRunId(now, rand)  → short, time-ordered, collision-resistant run id
 *   - buildMeta({...})      → the `meta` object createRunLog() expects (run-log.js:127)
 *   - canMutate({mode, importMode}) → the single read-only chokepoint truth (design §6)
 *
 * The protocol sha256 is computed in the browser with crypto.subtle (async) and
 * passed IN as `doc.sha256` — this module stays synchronous so it is fully
 * Node-unit-testable. Clocks (now/rand) are injectable for deterministic tests.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES
 * `export`) — same pattern as arena-session.js / run-log.js, so it loads before
 * the module block and dodges the ES-import-cache gotcha.
 */
(function (global) {
    'use strict';

    /**
     * Short run id: base36(ms-since-epoch) + a base36 random suffix, last 8 chars.
     * Lexicographically time-ordered (base36 of ms is monotonic); the random
     * suffix breaks same-millisecond collisions. run-log.js filename() appends it.
     * @param {Function} [now]  () => ms-since-epoch (default Date.now)
     * @param {Function} [rand] () => [0,1) (default Math.random)
     */
    function makeRunId(now, rand) {
        const nowFn = now || Date.now;
        const randFn = rand || Math.random;
        const t = Math.floor(nowFn()).toString(36);
        const r = Math.floor(randFn() * 0x10000)
            .toString(36)
            .padStart(3, '0');
        return (t + r).slice(-8);
    }

    /**
     * Assemble the run-log metadata header. All string fields are trimmed;
     * missing provenance is null (run-log.js also nulls protocol_sha256 for
     * intent:'test'). No DOM, no clock — feed the pieces in.
     * @param {object} a
     * @param {object} a.panel   {experimenter, genotype, notes} from the side panel
     * @param {object} a.doc     {filename, sha256}  loaded/edited protocol
     * @param {object} a.session {firmware, controllerId} from GET_CONTROLLER_INFO 0xC2 only
     * @param {object} a.rig     {name, arenaConfig} from the loaded rig YAML (NOT the controller)
     * @param {string} a.toolVersion  e.g. 'Arena Studio v0.1'
     * @param {string} a.runId
     */
    function buildMeta(a) {
        const o = a || {};
        const panel = o.panel || {};
        const doc = o.doc || {};
        const session = o.session || {};
        const rig = o.rig || {};
        const s = (v) => (v == null ? '' : String(v)).trim();
        return {
            run_id: o.runId || null,
            experimenter: s(panel.experimenter),
            genotype: s(panel.genotype),
            notes: s(panel.notes),
            protocol_filename: doc.filename || 'untitled.yaml',
            protocol_sha256: doc.sha256 || null,
            arena_config: rig.arenaConfig || null,
            rig: rig.name || null,
            firmware: session.firmware || null,
            // Physical-setup identity: the controller's Ethernet MAC, derived
            // from the Teensy's burned-in unique ID. null until the firmware
            // ships it in the 0xC2 reply (tolerant decode on the web side).
            controller_id: session.controllerId || null,
            tool_version: o.toolVersion || null
        };
    }

    /**
     * The read-only lock truth (design §6): the protocol is mutable ONLY in Edit
     * mode and never during a D4 import. Wrapped by pushUndo() so the guard is
     * unavoidable at every mutation site.
     * @param {object} s {mode:'run'|'edit'|'console', importMode:boolean}
     */
    function canMutate(s) {
        const st = s || {};
        return st.mode === 'edit' && !st.importMode;
    }

    /**
     * Is the green "Run experiment" (recorded) action allowed? Requires a live
     * connection, a live FicTrac bridge (the universal run logger — a dead
     * bridge must block loudly, not lose data silently), both required
     * metadata fields, a saved (non-dirty) protocol, and every referenced
     * pattern resolvable on the SD (missingPatterns preflight — an
     * unresolvable name would otherwise fail MID-run).
     * Returns {ok, reason} so the UI can show a disabled-with-reason tooltip.
     * The blue "Test experiment" path ignores this (needs only `connected`);
     * Console/bench quick ops stay ungated.
     */
    function canRunExperiment(s) {
        const st = s || {};
        if (!st.connected) return { ok: false, reason: 'Connect to run' };
        if (!st.hasProtocol) return { ok: false, reason: 'Open a protocol to run' };
        if (st.dirty || st.unsaved)
            return { ok: false, reason: 'Save the protocol to run as an experiment' };
        if (!String(st.experimenter || '').trim())
            return { ok: false, reason: 'Experimenter is required' };
        if (!String(st.genotype || '').trim())
            return { ok: false, reason: 'Fly genotype is required' };
        if (!st.bridgeConnected)
            return {
                ok: false,
                reason: 'Bridge not connected — recorded runs are logged through it (pixi run bridge)'
            };
        if (Array.isArray(st.missingPatterns) && st.missingPatterns.length) {
            const names = st.missingPatterns.map((n) => '"' + n + '"').join(', ');
            return {
                ok: false,
                reason:
                    'Pattern ' +
                    names +
                    ' not on SD — upload it via Console → SD upload, then reconnect'
            };
        }
        return { ok: true, reason: '' };
    }

    const StudioMeta = { makeRunId, buildMeta, canMutate, canRunExperiment };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioMeta;
    }
    if (typeof global !== 'undefined') {
        global.StudioMeta = StudioMeta;
    }
})(typeof window !== 'undefined' ? window : this);
