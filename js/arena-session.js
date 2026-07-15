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
            // Optional: the FicTrac bridge client (js/fictrac-bridge-client.js). Only
            // needed to drive/log FicTrac; absent ⇒ fictrac ops degrade gracefully.
            const BridgeClientLib =
                o.BridgeClientLib ||
                (typeof window !== 'undefined' ? window.FicTracBridgeClient : undefined);
            if (!LinkClass)
                throw new Error('ArenaSession: window.ArenaLink not loaded (check <script> order)');
            if (!RunnerLib)
                throw new Error(
                    'ArenaSession: window.ArenaRunnerG6 not loaded (check <script> order)'
                );

            this._LinkClass = LinkClass;
            this._handlers = {};
            EVENTS.forEach((e) => (this._handlers[e] = new Set()));
            // Replay/viewer mode uses this broker-level latch to guarantee that
            // no NEW serial operation can be started while historical data is
            // being presented as if it were live.  The latch is deliberately in
            // ArenaSession (rather than in one UI) because console sends,
            // sequence runs, FicTrac frame application, and bulk reads all meet
            // here.  null means normal live operation.
            this._outputInhibitedReason = null;

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
            // The FicTrac bridge client. Its applyFrame routes through THIS session's
            // send() (not the bare link) so the command logger (below) captures the
            // streamed SET_FRAME_POSITION frames too. Consumers (console / designer)
            // override clampFrame / canApply and drive connect/apply/logging via
            // .bridge. Null when the module isn't loaded — the runner tolerates it.
            this._bridge = BridgeClientLib
                ? new BridgeClientLib({
                      applyFrame: (i) => this.send(this._wire.encodeSetFramePosition(i))
                  })
                : null;
            this._runner = new RunnerLib.ArenaRunner(this._link, this._wire, this._bridge);
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

        // ---- hardware-output interlock --------------------------------------

        /** True while new serial/hardware operations are blocked. */
        get outputInhibited() {
            return this._outputInhibitedReason !== null;
        }

        /** Human-readable owner/reason for the active interlock, or null. */
        get outputInhibitedReason() {
            return this._outputInhibitedReason;
        }

        /**
         * Enable/clear the page-wide hardware-output interlock.
         *
         * Pass a non-empty reason to enable it; pass null/false/'' to clear it.
         * Enabling while a runner is active is rejected: an already-started
         * wire transaction cannot be recalled safely, so the caller must stop
         * the live run before entering replay.  `disconnect()` remains allowed
         * under the interlock so the serial port can always be closed.
         *
         * @returns {boolean} true when the latch changed
         */
        setOutputInhibited(reason) {
            const next =
                reason === null || reason === undefined || reason === false
                    ? null
                    : String(reason).trim() || null;
            if (next && this._runner.active) {
                const e = new Error(
                    'Cannot inhibit arena output while a run is active — stop the live run first.'
                );
                e.code = 'ARENA_RUN_ACTIVE';
                throw e;
            }
            if (next === this._outputInhibitedReason) return false;
            this._outputInhibitedReason = next;
            this._emit('state');
            return true;
        }

        _assertOutputAllowed(operation) {
            if (!this.outputInhibited) return;
            const e = new Error(
                'Arena hardware output is inhibited' +
                    (this._outputInhibitedReason ? ' (' + this._outputInhibitedReason + ')' : '') +
                    '; cannot ' +
                    operation +
                    '.'
            );
            e.name = 'ArenaOutputInhibitedError';
            e.code = 'ARENA_OUTPUT_INHIBITED';
            e.reason = this._outputInhibitedReason;
            e.operation = operation;
            throw e;
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
            this._assertOutputAllowed('connect');
            await this._link.connect(opts);
            this._emit('state');
        }

        /**
         * User-initiated teardown: stop any active run (best-effort STOP), then
         * close the port. Emits 'disconnect' with involuntary:false. Always safe.
         */
        async disconnect() {
            if (this._runner.active) {
                // The interlock is normally enabled only while idle.  If an
                // injected/legacy runner nevertheless reports active, abort it
                // locally rather than violating the latch with a STOP frame.
                if (this.outputInhibited) this._abortRunner();
                else {
                    try {
                        await this._runner.stop();
                    } catch (_) {
                        /* best-effort */
                    }
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
            this._assertOutputAllowed('send');
            const p = this._link.send(bytes, opts);
            // Bridge-as-single-logger (default-on): when logging is active, post every
            // arena command to the bridge's unified JSONL — timestamped on the browser
            // side (t) and again by the bridge on receipt (rx_ms), so arena events and
            // FicTrac frames share one clock. Attaches to a branch of the promise so
            // the caller still sees the original resolution/rejection.
            if (this._bridge && this._bridge.logging) {
                const t = typeof Date !== 'undefined' ? Date.now() : 0;
                p.then(
                    (resp) => this._logCommand(bytes, t, resp, null),
                    (err) => this._logCommand(bytes, t, null, err)
                );
            }
            return p;
        }

        /** The FicTrac bridge client (or null if the module isn't loaded). */
        get bridge() {
            return this._bridge;
        }

        // First few bytes of a command frame as hex (for the command log).
        _head(bytes) {
            if (!bytes || !bytes.length) return '';
            const n = Math.min(8, bytes.length);
            const parts = [];
            for (let i = 0; i < n; i++) parts.push(bytes[i].toString(16).padStart(2, '0'));
            return parts.join(' ') + (bytes.length > n ? ' …' : '');
        }

        // Append one arena_command entry to the bridge log (decodes the reply if any).
        _logCommand(bytes, t, resp, err) {
            let status = null;
            let echo = null;
            let ok = null;
            try {
                const d = resp && resp.length ? this._wire.decodeResponse(resp) : null;
                if (d) {
                    status = d.status;
                    echo = d.echoCmd;
                    ok = d.ok;
                }
            } catch (_) {
                /* undecodable reply — log the request anyway */
            }
            this._bridge.log({
                event: 'arena_command',
                t,
                dt: (typeof Date !== 'undefined' ? Date.now() : 0) - t,
                len: bytes ? bytes.length : 0,
                head: this._head(bytes),
                status,
                echo,
                ok,
                error: err ? err.message || String(err) : null
            });
        }

        /**
         * Bulk-read variant: send a request, then stream response chunks until
         * the controller signals EOF. See ArenaLink.sendBulkRead for details.
         * @param {Uint8Array|number[]} bytes
         * @param {object} [opts] {timeoutMs?}
         * @returns {Promise<Uint8Array>}
         */
        sendBulkRead(bytes, opts) {
            this._assertOutputAllowed('bulk-read');
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
         * @param {object} a.params              encodeTrialParams arg {mode,patternId,frameRate,initPos,gain,duration,duty}
         * @param {number} [a.durationSec]        >0 arms a host-side auto-stop
         * @param {string} [a.conditionName]
         * @param {Function} [a.onStatus]         per-call status sink (also broadcast as 'runstatus')
         * @returns {Promise<object|null>} decoded trialParams response
         */
        async runTrial(a) {
            this._assertOutputAllowed('run a trial');
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
         * @param {Function} [a.resolveCondition] optional async trial-boundary resolver;
         *        forwarded verbatim to ArenaRunner.runSequence
         * @param {Function} [a.onProgress]       per-call progress sink (also broadcast as 'runstatus')
         * @param {Function} [a.timing]           host-timing fn (default runner's hostSideTrialEnd — FW#4 swap point)
         * @param {Function} [a.sleep]            sleep(ms) (default runner's abort-aware sleep; tests inject instant)
         * @returns {Promise<{completed,aborted,steps,errors,skipped}>}
         */
        async runSequence(a) {
            this._assertOutputAllowed('run a sequence');
            const args = a || {};
            if (this._runner.active) await this._runner.stop();
            return this._runner.runSequence({
                steps: args.steps,
                conditionsByName: args.conditionsByName,
                resolvePatternId: args.resolvePatternId,
                resolvePatternFrames: args.resolvePatternFrames,
                resolveCondition: args.resolveCondition,
                fictracPluginNames: args.fictracPluginNames,
                timing: args.timing,
                sleep: args.sleep,
                onProgress: (s) => this._onRunStatus(s, args.onProgress)
            });
        }

        /** Best-effort, queued STOP (STOP_DISPLAY 0x30). Idempotent; safe mid-run. */
        async stop() {
            this._assertOutputAllowed('send STOP');
            const r = await this._runner.stop();
            this._emit('state');
            return r;
        }

        // Forward a runner status/progress event to the broadcast channel + per-call sink.
        // Also route the SEMANTIC event to the bridge log (default-on logger): stim
        // type + timing + all protocol commands, on the bridge clock, interleaved with
        // FicTrac frames — the analysis-grade record (no raw byte-heads).
        _onRunStatus(s, perCall) {
            if (this._bridge && this._bridge.logging) {
                this._bridge.log({ event: 'runner', ...this._sanitizeRunStatus(s) });
            }
            this._emit('runstatus', s);
            this._emit('state');
            if (perCall) perCall(s);
        }

        // Pick JSON-safe, analysis-relevant fields off a runner status event (drops
        // Error objects / response Uint8Arrays; keeps trialParams params, op/value, etc.).
        _sanitizeRunStatus(s) {
            const out = {};
            if (!s || typeof s !== 'object') return out;
            const keys = [
                'phase',
                'index',
                'total',
                'op',
                'value',
                'reason',
                'message',
                'level',
                'durationSec',
                'conditionName',
                // conditional-LED-activation provenance: the per-transition ON/OFF
                // flag + brightness, and the spec on the trial-running event, so
                // the committed run log is self-contained (was dropped → the log
                // had transition times/index but not whether the LED went on/off).
                'on',
                'ledPercent',
                'ledActivation'
            ];
            for (const k of keys) if (s[k] !== undefined) out[k] = s[k];
            if (s.params && typeof s.params === 'object') out.params = s.params;
            if (s.step && s.step.conditionName) out.condition = s.step.conditionName;
            // Runtime-control boundary records are already JSON-safe and carry
            // the complete YAML/session/apply provenance.  Keep them nested so
            // bridge JSONL receives the authoritative record without expanding
            // the scalar allowlist every time the proposal grows a field.
            if (s.runtimeControlApply && typeof s.runtimeControlApply === 'object') {
                out.runtimeControlApply = s.runtimeControlApply;
            }
            if (s.runtimeRecord && typeof s.runtimeRecord === 'object') {
                out.runtimeRecord = s.runtimeRecord;
            }
            if (s.response && typeof s.response === 'object') {
                out.status = s.response.status;
                out.ok = s.response.ok;
            }
            if (s.error) out.error = s.error.message || String(s.error);
            return out;
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
