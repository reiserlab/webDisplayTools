/**
 * arena-runner-g6.js — condition → wire execution helpers + a small run-state
 * machine, shared by the Arena Console (LAB-93) and the v3 Experiment Designer
 * dry-run (LAB-94).
 *
 * This is the ONE home for "take a v3 condition's controller trialParams
 * command and drive it on the arena". It sits between the pure wire protocol
 * (js/arena-wire-g6.js) and the I/O transport (js/arena-link.js) but contains
 * NO DOM — pages own their own UI. That keeps it Node-testable with a faked
 * link (see tests/test-arena-runner-g6.js).
 *
 * Scope (v0, per the LAB-94 DoD): only the `trialParams` controller command is
 * sent. Other controller commands (allOn/allOff/setPositionX/…), plugins, and
 * waits are NOT executed — this is a "test the pattern", not a full
 * behaviourally-faithful condition run.
 */
'use strict';

var ArenaRunnerG6 = (function () {
    // ---- pure helpers (hardware-free, unit-tested) -----------------------

    /**
     * Find the controller `trialParams` command in a condition's command list.
     * IMPORTANT: a condition's controller commands are a family (allOn, allOff,
     * stopDisplay, setPositionX, setColorDepth, trialParams) — only trialParams
     * maps to encodeTrialParams, so we must match on command_name, not just
     * type === 'controller'.
     * @returns {object|null} the trialParams command, or null if none.
     */
    function findTrialParams(condition) {
        if (!condition || !Array.isArray(condition.commands)) return null;
        return (
            condition.commands.find(
                (c) => c && c.type === 'controller' && c.command_name === 'trialParams'
            ) || null
        );
    }

    /**
     * List the plugin commands in a condition that a dry-run will SKIP, so the
     * UI can warn about them (DoD: "plugin commands skipped with a visible
     * warning").
     * @returns {Array<{plugin_name:string, command_name:string}>}
     */
    function listSkippedPlugins(condition) {
        if (!condition || !Array.isArray(condition.commands)) return [];
        return condition.commands
            .filter((c) => c && c.type === 'plugin')
            .map((c) => ({
                plugin_name: c.plugin_name || '(unnamed)',
                command_name: c.command_name || '(unnamed)'
            }));
    }

    /**
     * Is a condition eligible for the web dry-run? The web runner only sends
     * arena/controller commands, so a condition is runnable iff it has a
     * trialParams command AND no plugin commands (camera/backlight/etc. can't be
     * driven from the browser). Waits and other controller commands are allowed.
     * Gates the ▶ button so it only appears where the run is faithful (no
     * silently-skipped plugins).
     * @returns {boolean}
     */
    function isDryRunEligible(condition) {
        return !!findTrialParams(condition) && listSkippedPlugins(condition).length === 0;
    }

    /**
     * Map a v3 `frame_index` to the wire `init_pos`.
     *
     * OPEN QUESTION (hardware-confirm): the handoff asserts frame_index == the
     * wire init_pos, but arena-wire-g6 documents init_pos as 0-based while v3
     * fixtures author `frame_index: 1`. We pass through for now — if hardware
     * shows an off-by-one, this is the ONE line to change (e.g. `n - 1`).
     */
    function frameIndexToInitPos(frameIndex) {
        if (frameIndex === undefined || frameIndex === null || frameIndex === '') return 0;
        const n = Number(frameIndex);
        if (!Number.isFinite(n)) {
            throw new Error('frame_index is not a number: ' + JSON.stringify(frameIndex));
        }
        return n; // pass-through (see note above)
    }

    function toNumber(value, name) {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            throw new Error(name + ' is not a number: ' + JSON.stringify(value));
        }
        return n;
    }

    /**
     * Build the encodeTrialParams() argument object from a condition's
     * trialParams command + an externally-resolved 1-based SD pattern index.
     *
     * Coerces every numeric field with Number() (defends against YAML parsers
     * that yield string scalars) and throws a CLEAR Error on values the wire
     * can't represent, before the encoder's terser RangeError would fire:
     *   - mode ∉ {2,3,4}
     *   - negative frame_rate (reverse playback — not supported over the wire yet)
     *   - non-integer / < 1 patternId
     * Gain is coerced; encodeTrialParams enforces the int8 range.
     *
     * @param {object} cmd  the trialParams controller command
     * @param {{patternId:number}} opts  the resolved 1-based SD index
     * @returns {{mode:number, patternId:number, frameRate:number, gain:number, initPos:number}}
     */
    function buildTrialParams(cmd, opts) {
        cmd = cmd || {};
        opts = opts || {};

        const mode = cmd.mode === undefined ? 2 : toNumber(cmd.mode, 'mode');
        if (mode !== 2 && mode !== 3 && mode !== 4) {
            throw new Error(
                'Unsupported mode ' +
                    mode +
                    ' — dry-run handles mode 2 (open-loop), 3 (show-frame), or 4 (closed-loop).'
            );
        }

        const frameRate = cmd.frame_rate === undefined ? 0 : toNumber(cmd.frame_rate, 'frame_rate');
        if (frameRate < 0) {
            throw new Error(
                'Negative frame_rate (' +
                    frameRate +
                    ', reverse playback) is not supported over the wire yet.'
            );
        }

        const gain = cmd.gain === undefined ? 0 : toNumber(cmd.gain, 'gain');
        const initPos = frameIndexToInitPos(cmd.frame_index);

        const patternId = toNumber(opts.patternId, 'patternId');
        if (!Number.isInteger(patternId) || patternId < 1) {
            throw new Error(
                'patternId must be an integer >= 1 (1-based SD index), got ' +
                    JSON.stringify(opts.patternId)
            );
        }

        return { mode, patternId, frameRate, gain, initPos };
    }

    // ---- run-state machine ----------------------------------------------

    /**
     * Owns one active run at a time: the send, the decoded status, and the
     * best-effort auto-stop timer. A double-click can't queue two trial frames
     * or two timers because start() rejects while active.
     *
     * STOP is best-effort: a closed/slept tab won't fire the timer, so manual
     * stop() is the primary mechanism and the timer is a convenience.
     */
    class ArenaRunner {
        /**
         * @param {object} link  an ArenaLink-like object with .send(bytes) and .connected
         * @param {object} [wire] the ArenaWireG6 module (defaults to window.ArenaWireG6)
         */
        constructor(link, wire) {
            this._link = link;
            this._wire = wire || (typeof window !== 'undefined' ? window.ArenaWireG6 : null);
            if (!this._wire) {
                throw new Error('ArenaRunner: ArenaWireG6 is not available.');
            }
            this._active = false;
            this._timer = null;
            this._conditionName = null;
            this._lastResponse = null;
        }

        get active() {
            return this._active;
        }
        get conditionName() {
            return this._conditionName;
        }
        get lastResponse() {
            return this._lastResponse;
        }

        /**
         * Send trialParams and (optionally) arm an auto-stop after durationSec.
         * @param {object} a
         * @param {object} a.params         encodeTrialParams() argument object
         * @param {number} [a.durationSec]  auto-stop after this many seconds (>0)
         * @param {string} [a.conditionName]
         * @param {function} [a.onStatus]   status callback (phase events)
         * @returns {Promise<object|null>}  the decoded response (or null)
         */
        async start(a) {
            a = a || {};
            if (this._active) {
                throw new Error('A run is already active — stop it first.');
            }
            if (!a.params) {
                throw new Error('ArenaRunner.start requires { params }.');
            }
            const emit = (s) => {
                if (typeof a.onStatus === 'function') a.onStatus(s);
            };

            this._active = true;
            this._conditionName = a.conditionName || null;

            let frame;
            try {
                emit({ phase: 'sending', conditionName: this._conditionName, params: a.params });
                frame = await this._link.send(this._wire.encodeTrialParams(a.params));
            } catch (e) {
                // never armed — reset and rethrow for the caller to surface
                this._clear();
                emit({ phase: 'error', error: e });
                throw e;
            }

            const resp = this._wire.decodeResponse(frame);
            this._lastResponse = resp;

            if (!resp || !resp.ok) {
                // controller refused the command — nothing is running
                this._clear();
                emit({ phase: 'rejected', response: resp });
                return resp;
            }

            emit({ phase: 'running', response: resp, conditionName: this._conditionName });

            const ms = Number(a.durationSec) > 0 ? Number(a.durationSec) * 1000 : 0;
            if (ms > 0) {
                this._timer = setTimeout(() => {
                    this._timer = null;
                    this.stop()
                        .then(() => emit({ phase: 'auto-stopped' }))
                        .catch(() => {
                            /* best-effort */
                        });
                }, ms);
            }
            return resp;
        }

        /**
         * Stop the active run: clear the timer, mark inactive, and send STOP if
         * the link is connected. Idempotent and NOT import-mode-guarded by the
         * UI — a run must remain stoppable.
         * @returns {Promise<object|null>} the STOP response (or null if offline)
         */
        async stop() {
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
            this._active = false;
            this._conditionName = null;
            if (this._link && this._link.connected) {
                return this._link.send(this._wire.encodeStop());
            }
            return null;
        }

        /** Clear run-state + timer without sending STOP (used on disconnect/error). */
        _clear() {
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
            this._active = false;
            this._conditionName = null;
        }
    }

    return {
        findTrialParams,
        listSkippedPlugins,
        isDryRunEligible,
        frameIndexToInitPos,
        buildTrialParams,
        ArenaRunner
    };
})();

// Export for Node.js (CommonJS) — used by tests/test-arena-runner-g6.js.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ArenaRunnerG6;
}

// Export for browser (global) — used by <script src=> callers (the Arena
// Console and the v3 Experiment Designer) which read window.ArenaRunnerG6.
if (typeof window !== 'undefined') {
    window.ArenaRunnerG6 = ArenaRunnerG6;
}
