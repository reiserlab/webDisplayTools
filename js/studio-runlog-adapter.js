/**
 * studio-runlog-adapter.js — bridge ArenaSession 'runstatus' → run-log.js.
 *
 * ArenaSession re-broadcasts every ArenaRunner onProgress phase on its
 * 'runstatus' event (arena-session.js:352). run-log.js's createRunLog() accepts
 * exactly those phase strings (its formatLine switch was co-designed against
 * them), so this adapter is a thin router — NOT a translation layer:
 *   - intermediate phases  → log.event(phase, payload)
 *   - terminal phases      → log.event(...) then log.finish(summary, override?)
 *
 * Terminal detection + the disconnect override live here so the HTML wiring is
 * one call: feedRunStatus(log, s). Kept DOM-free + dependency-free for Node tests.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES `export`).
 */
(function (global) {
    'use strict';

    const TERMINAL = { 'sequence-complete': 1, aborted: 1 };
    // Phases the runner emits that carry real run content (all logged verbatim).
    const KNOWN = {
        'sequence-start': 1,
        'step-start': 1,
        'runtime-control-applied': 1,
        'trial-resolved': 1,
        'trial-running': 1,
        'led-activation': 1,
        command: 1,
        skip: 1,
        error: 1,
        'step-done': 1,
        'sequence-complete': 1,
        aborted: 1
    };

    function isTerminal(phase) {
        return !!TERMINAL[phase];
    }

    /**
     * Feed one 'runstatus' event into an active run-log accumulator.
     * @param {object} log  a createRunLog() instance (run-log.js)
     * @param {object} s    the runner status/progress event
     * @returns {{event: object|null, terminal: boolean, summary: object|null}}
     *   `event` is the stamped event appended (null if the phase was unknown/ignored);
     *   `terminal` true when the run closed; `summary` the finish() result if so.
     */
    function feedRunStatus(log, s) {
        if (!log || !s || typeof s !== 'object' || !s.phase) {
            return { event: null, terminal: false, summary: null };
        }
        const phase = s.phase;
        if (!KNOWN[phase]) {
            // Unknown/legacy single-trial phases (sending/running/…) are not part
            // of the recorded sequence record; ignore rather than pollute it.
            return { event: null, terminal: false, summary: null };
        }
        const ev = log.event(phase, s);
        if (isTerminal(phase)) {
            const override = phase === 'aborted' ? 'ABORTED_BY_USER' : undefined;
            const summary = log.finish(s.summary || null, override);
            return { event: ev, terminal: true, summary: summary };
        }
        return { event: ev, terminal: false, summary: null };
    }

    /**
     * Close a run-log out-of-band (e.g. involuntary disconnect mid-run, where no
     * 'aborted'/'sequence-complete' phase will arrive). Idempotent-ish: caller
     * should only invoke once per run.
     */
    function finishDisconnected(log, runnerSummary) {
        if (!log) return null;
        return log.finish(runnerSummary || null, 'DISCONNECTED');
    }

    const StudioRunLogAdapter = {
        feedRunStatus,
        finishDisconnected,
        isTerminal,
        KNOWN_PHASES: KNOWN
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioRunLogAdapter;
    }
    if (typeof global !== 'undefined') {
        global.StudioRunLogAdapter = StudioRunLogAdapter;
    }
})(typeof window !== 'undefined' ? window : this);
