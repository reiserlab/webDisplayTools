/**
 * arena-session.js — the single shared arena connection broker (Stage A).
 *
 * Owns ONE ArenaLink + ONE ArenaRunner for a page, multicasts the link's
 * callbacks (log / error / disconnect) to any number of subscribers, and
 * exposes the union of what arena_console.html and experiment_designer_v3.html
 * need: connection lifecycle, a raw queued send (console), and the run
 * mechanism — single trial + whole sequence + STOP (designer).
 *
 * WHY THIS EXISTS: both pages today each `new window.ArenaLink(...)` (console
 * ~:1139 classic; designer ~:5216 inside its ES-module block) and the designer
 * also `new ArenaRunner(...)` and pokes the runner's private `_clear()` on
 * disconnect. This module collapses that duplicated ownership into one place so
 * the console, the (Stage B) runner page, and the (Stage C) merged page can all
 * drive the same broker with identical, tested logic.
 *
 * LOADING: classic <script src> only — window-global + CommonJS dual-export, NO
 * ES `export` (a bare `export` breaks classic loading and the whole point is to
 * dodge the catastrophic ES-import-failure-under-GitHub-Pages-cache bug; see
 * CLAUDE.md). Load order: the classic <script src> tags for arena-wire-g6.js,
 * arena-link.js, arena-runner-g6.js MUST appear before this one, and this one
 * before any module block that reads window.ArenaSession.
 *
 * NOT YET WIRED: as of Stage A first commit, no HTML page loads this file. It is
 * the contract for review; the two pages are retrofitted in a later step.
 *
 * EVENTS (subscribe with .on(event, fn) — returns an unsubscribe fn):
 *   'log'        (msg:string)                  — transport trace line (tx/rx/notes)
 *   'error'      (err:Error)                    — background read-loop error
 *   'disconnect' ({ involuntary:boolean })      — port closed (cable-pull = true, user Disconnect = false)
 *   'state'      ()                             — connection/run state changed; re-evaluate UI gating
 *   'runstatus'  (s:object)                     — runner status/progress phase (single-trial AND sequence)
 *
 * SEND / STOP SEMANTICS: ArenaLink.send is single-flight + echo-correlated +
 * FIFO-queued (arena-link.js). STOP therefore QUEUES behind any in-flight send
 * — it is best-effort, not a wire interrupt — and on a slept/backgrounded tab
 * host-side timers may not fire. This module does not pretend otherwise.
 */
(function (global) {
    'use strict';

    // Page-wide singleton (one connection per page). Held in closure scope.
    let _shared = null;

    const EVENTS = ['log', 'error', 'disconnect', 'state', 'runstatus'];

    class ArenaSession {
        /**
         * @param {object} [opts]
         * @param {object} [opts.wire]      ArenaWireG6-like encoder set (default window.ArenaWireG6)
         * @param {Function} [opts.LinkClass]  ArenaLink ctor (default window.ArenaLink) — injectable for tests
         * @param {object} [opts.RunnerLib]    ArenaRunnerG6 module (default window.ArenaRunnerG6) — injectable for tests
         */
        constructor(opts) {
            const o = opts || {};
            this._wire = o.wire || (typeof window !== 'undefined' ? window.ArenaWireG6 : undefined);
            const LinkClass =
                o.LinkClass || (typeof window !== 'undefined' ? window.ArenaLink : undefined);
            const RunnerLib =
                o.RunnerLib || (typeof window !== 'undefined' ? window.ArenaRunnerG6 : undefined);
            if (!LinkClass)
                throw new Error('ArenaSession: window.ArenaLink not loaded (check <script> order)');
            if (!RunnerLib)
                throw new Error(
                    'ArenaSession: window.ArenaRunnerG6 not loaded (check <script> order)'
                );

            this._LinkClass = LinkClass;
            this._handlers = {};
            EVENTS.forEach((e) => (this._handlers[e] = new Set()));

            // ONE link with the three callbacks fanned out to subscribers. On an
            // INVOLUNTARY loss (cable-pull / read-loop death) abort the runner
            // WITHOUT sending STOP (the port is gone) via the new public abort().
            // Fall back to the legacy private _clear() if abort() is absent — this
            // tolerates a GitHub-Pages stale-cache window where a freshly-deployed
            // arena-session.js runs against an older cached arena-runner-g6.js that
            // predates abort(). Harmless once caches catch up.
            this._link = new LinkClass({
                onLog: (msg) => this._emit('log', msg),
                onError: (err) => this._emit('error', err),
                onDisconnect: () => {
                    this._abortRunner();
                    this._emit('disconnect', { involuntary: true });
                    this._emit('state');
                }
            });
            this._runner = new RunnerLib.ArenaRunner(this._link, this._wire);
        }

        /** Web Serial available? (Chromium-desktop only.) Gate every connect UI on this. */
        static isSupported() {
            const LinkClass = typeof window !== 'undefined' ? window.ArenaLink : undefined;
            return !!(LinkClass && LinkClass.isSupported && LinkClass.isSupported());
        }

        /** The lazily-created page-wide singleton. Every consumer calls this. */
        static shared(opts) {
            if (!_shared) _shared = new ArenaSession(opts);
            return _shared;
        }

        /** Test/teardown hook: drop the singleton (does not close any open port). */
        static _resetShared() {
            _shared = null;
        }

        // ---- events ----------------------------------------------------------

        /** Subscribe. Returns an unsubscribe fn. */
        on(event, handler) {
            if (!this._handlers[event])
                throw new Error('ArenaSession: unknown event "' + event + '"');
            this._handlers[event].add(handler);
            return () => this.off(event, handler);
        }

        off(event, handler) {
            if (this._handlers[event]) this._handlers[event].delete(handler);
        }

        _emit(event, ...args) {
            const set = this._handlers[event];
            if (!set) return;
            // Copy so a handler that unsubscribes mid-dispatch can't mutate the live set.
            for (const fn of Array.from(set)) {
                try {
                    fn(...args);
                } catch (e) {
                    // A subscriber throwing must not break the broker or sibling subscribers.
                    if (event !== 'error') this._emit('error', e);
                }
            }
        }

        // Abort a run WITHOUT a STOP send (the port is gone). Prefers the public
        // abort(); falls back to the legacy private _clear() for a stale-cache runner.
        _abortRunner() {
            if (typeof this._runner.abort === 'function') this._runner.abort();
            else if (typeof this._runner._clear === 'function') this._runner._clear();
        }

        // ---- connection lifecycle -------------------------------------------

        /** True while the serial port is open. */
        get connected() {
            return this._link.connected;
        }

        /**
         * Open the port. MUST be called inside a user gesture (the OS port
         * chooser runs on the first await). Convenience requestPort()+open().
         * @param {object} [opts] {filters?, baudRate?} — forwarded to ArenaLink.connect
         */
        async connect(opts) {
            await this._link.connect(opts);
            this._emit('state');
        }

        /**
         * User-initiated teardown: stop any active run (best-effort STOP), then
         * close the port. Emits 'disconnect' with involuntary:false. Always safe.
         */
        async disconnect() {
            if (this._runner.active) {
                try {
                    await this._runner.stop();
                } catch (_) {
                    /* best-effort */
                }
            }
            try {
                await this._link.close();
            } catch (_) {
                /* best-effort */
            }
            this._emit('disconnect', { involuntary: false });
            this._emit('state');
        }

        // ---- raw transport (console: raw-hex, stream frames, .pat playback) --

        /**
         * Send a request frame and await its echo-correlated response FRAME
         * (Uint8Array incl. leading length byte — feed straight to
         * ArenaWireG6.decodeResponse; do NOT slice). Queues FIFO behind any
         * in-flight send.
         * @param {Uint8Array|number[]} bytes
         * @param {object} [opts] {expectedCmd?, timeoutMs?} — pass expectedCmd:0x32 for STREAM_FRAME
         * @returns {Promise<Uint8Array>}
         */
        send(bytes, opts) {
            return this._link.send(bytes, opts);
        }

        /**
         * Bulk-read variant: send a request, then stream response chunks until
         * the controller signals EOF. See ArenaLink.sendBulkRead for details.
         * @param {Uint8Array|number[]} bytes
         * @param {object} [opts] {timeoutMs?}
         * @returns {Promise<Uint8Array>}
         */
        sendBulkRead(bytes, opts) {
            return this._link.sendBulkRead(bytes, opts);
        }

        /** Convenience accessor for the wire encoder set (callers may also use window.ArenaWireG6). */
        get wire() {
            return this._wire;
        }

        // ---- run mechanism (designer: single-trial + whole-sequence + STOP) --

        /** True while a single-trial or sequence run is active. */
        get running() {
            return this._runner.active;
        }

        /** Name of the condition currently running (or null). */
        get runConditionName() {
            return this._runner.conditionName;
        }

        /**
         * Run a SINGLE trial (LAB-94 dry-run): sends only trialParams, arms an
         * optional host-timed auto-stop. Pre-empts any active run first.
         * @param {object} a
         * @param {object} a.params              encodeTrialParams arg {mode,patternId,frameRate,gain,initPos}
         * @param {number} [a.durationSec]        >0 arms a host-side auto-stop
         * @param {string} [a.conditionName]
         * @param {Function} [a.onStatus]         per-call status sink (also broadcast as 'runstatus')
         * @returns {Promise<object|null>} decoded trialParams response
         */
        async runTrial(a) {
            const args = a || {};
            if (this._runner.active) await this._runner.stop();
            return this._runner.start({
                params: args.params,
                durationSec: args.durationSec,
                conditionName: args.conditionName,
                onStatus: (s) => this._onRunStatus(s, args.onStatus)
            });
        }

        /**
         * Run a WHOLE flattened sequence (LAB-97). Pre-empts any active run.
         * @param {object} a
         * @param {Array}  a.steps               flattenStructure(experiment,...).steps
         * @param {Map}    a.conditionsByName     name -> condition
         * @param {Function} [a.resolvePatternId] trialParamsCmd -> 1-based SD index | null
         * @param {Function} [a.onProgress]       per-call progress sink (also broadcast as 'runstatus')
         * @param {Function} [a.timing]           host-timing fn (default runner's hostSideTrialEnd — FW#4 swap point)
         * @param {Function} [a.sleep]            sleep(ms) (default runner's abort-aware sleep; tests inject instant)
         * @returns {Promise<{completed,aborted,steps,errors,skipped}>}
         */
        async runSequence(a) {
            const args = a || {};
            if (this._runner.active) await this._runner.stop();
            return this._runner.runSequence({
                steps: args.steps,
                conditionsByName: args.conditionsByName,
                resolvePatternId: args.resolvePatternId,
                timing: args.timing,
                sleep: args.sleep,
                onProgress: (s) => this._onRunStatus(s, args.onProgress)
            });
        }

        /** Best-effort, queued STOP (STOP_DISPLAY 0x30). Idempotent; safe mid-run. */
        async stop() {
            const r = await this._runner.stop();
            this._emit('state');
            return r;
        }

        // Forward a runner status/progress event to the broadcast channel + per-call sink.
        _onRunStatus(s, perCall) {
            this._emit('runstatus', s);
            this._emit('state');
            if (perCall) perCall(s);
        }
    }

    // Dual-export: CommonJS (Node tests) + window global (classic <script src>).
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ArenaSession;
    }
    if (typeof global !== 'undefined') {
        global.ArenaSession = ArenaSession;
    }
})(typeof window !== 'undefined' ? window : this);
