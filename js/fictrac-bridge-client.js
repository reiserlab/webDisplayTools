/**
 * fictrac-bridge-client.js — the shared WebSocket client for the local FicTrac
 * bridge (fictrac-bridge/bridge.py).
 *
 * Extracted verbatim-in-spirit from arena_console.html's `clBridge` so BOTH the
 * console and the v3 designer's web runner drive ONE tested code path. The client
 * is DOM-agnostic: it knows nothing about buttons or the stepper — the consumer
 * injects `applyFrame(index)` (how to push a frame to the arena) and `clampFrame`
 * / `canApply` policy, and subscribes to events for UI.
 *
 * WHAT THE BRIDGE SPEAKS (see fictrac-bridge/README.md):
 *   bridge → us:  {"type":"frame","index":<int>,"seq":<int>,"t":<ms>,
 *                  "ms":<int>,"fc":<int>,"idx":<int>,"ft":<ms|null>,
 *                  "x":<rad>,"y":<rad>,"hd":<rad>}   (behavior_v1 fields — the live
 *                    oscilloscope's raw state; index/seq/t kept for back-compat)
 *                 {"type":"log_export_result","name":..,"content":..}  (or {"error":..})
 *                 {"type":"hello_ack","bridge":..,"levels":[..],"level":..,"logging":..}
 *                    (bridge ≥ 3.0 only — an OLD bridge never answers hello)
 *                 {"type":"log_control_ack","enabled":..,"level":..,"requested":..,"file":..}
 *                    (`level` = the level the bridge will ACTUALLY write; an unknown
 *                     requested level is ignored by the bridge, so this is how a
 *                     stale bridge becomes visible instead of silently logging v1)
 *   us → bridge:  {"type":"hello","client":...,"v":1}
 *                 {"type":"config","fictrac_port":..,"gain":..,"offset":..,"frames":..}
 *                 {"type":"log_control","enabled":<bool>,
 *                                       "level":"behavior_v2"|"behavior_v1"|"full"}
 *                     (opens/closes the log file; level picks the frame-row format)
 *                 {"type":"log", ...}                        (an event to append)
 *                 {"type":"log_export"}                      (close + stream back the log)
 *
 * APPLY vs LOGGING are INDEPENDENT (per the open-loop requirement):
 *   - apply   = drive the arena (stream SET_FRAME_POSITION via applyFrame). Off ⇒
 *               FicTrac is still received/logged but the arena is untouched.
 *   - logging = tell the bridge to record this session to its JSONL file.
 * The apply loop is COALESCED + SINGLE-FLIGHT: only the newest index is ever in
 * flight, so a fast feed never backs up behind USB latency.
 *
 * LOADING: classic <script src> only — window-global + CommonJS dual-export, NO
 * ES `export` (same rule as arena-session.js — dodge the catastrophic
 * ES-import-failure-under-stale-cache bug; see CLAUDE.md).
 *
 * EVENTS (subscribe with .on(event, fn) — returns an unsubscribe fn):
 *   'status'  (text:string, kind:string)   — connection status changed
 *   'stats'   (stats:object)               — {recv, applied, drop, rateHz} updated
 *   'frame'   (index:int)                  — a frame index arrived (pre-apply)
 *   'sample'  (sample:object)              — behavior_v1 kinematic sample for the
 *                                            scope: {ms, fc, idx, ft, x, y, hd, t}
 *                                            (only when the bridge forwards them)
 *   'applied' (index:int)                  — a frame was applied to the arena
 *   'blocked' (reason:string)              — a frame could not be applied (canApply false)
 *   'apply'   (on:bool)                     — closed-loop apply was enabled/disabled
 *   'log'     (msg:string, kind:string)    — human-readable trace line
 *   'loglevel' (info:object)               — the bridge acknowledged a log level:
 *                                            {requested, level, ok, levels, enabled,
 *                                             file, source:'log_control'|'hello'}.
 *                                            ok=false ⇒ the bridge cannot write the
 *                                            requested level (too old) and `level`
 *                                            is what it logs instead.
 */
(function (global) {
    'use strict';

    const EVENTS = [
        'status',
        'stats',
        'frame',
        'sample',
        'applied',
        'blocked',
        'apply',
        'log',
        'loglevel',
        'fault'
    ];
    // Log levels this client knows how to request, most-preferred first. The
    // bridge advertises ITS list in hello_ack; a level missing there is one the
    // running bridge is too old for. Mirrors bridge.py LOG_LEVELS.
    const LOG_LEVELS = ['behavior_v2', 'behavior_v1', 'full'];

    class FicTracBridgeClient {
        /**
         * @param {object} [opts]
         * @param {function(number):Promise} [opts.applyFrame]  push a frame index to
         *        the arena (e.g. i => session.send(wire.encodeSetFramePosition(i))).
         *        Required to actually drive; without it apply is a no-op.
         * @param {function(number):number} [opts.clampFrame]   clamp an index into range
         * @param {function():boolean} [opts.canApply]          gate: may we apply now?
         *        (console: () => stepper.loaded && session.connected). Default: always.
         * @param {function} [opts.WebSocketImpl]  WebSocket ctor (default global WebSocket) — injectable for tests
         * @param {function():number} [opts.now]   clock (default Date.now) — injectable for tests
         */
        constructor(opts) {
            const o = opts || {};
            this._applyFrame = typeof o.applyFrame === 'function' ? o.applyFrame : null;
            this._clampFrame = typeof o.clampFrame === 'function' ? o.clampFrame : (i) => i;
            this._canApply = typeof o.canApply === 'function' ? o.canApply : () => true;
            this._WS = o.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
            this._now = typeof o.now === 'function' ? o.now : () => Date.now();

            this._handlers = {};
            EVENTS.forEach((e) => (this._handlers[e] = new Set()));

            this._ws = null;
            this._apply = false;
            this._logging = false;
            this._pending = null; // newest index awaiting send (coalesced)
            this._inFlight = false; // a drain loop is running
            this._exportPending = null; // single-in-flight log_export request
            this._recv = 0;
            this._applied = 0;
            this._rateCount = 0;
            this._rateHz = 0;
            this._rateTimer = null;
            this._lastBlockedMs = 0;
            // Fault detector (firmware #50 — the Mode-3 controller wedge). The
            // apply loop used to swallow every 0x70 timeout and keep spinning at
            // 2 Hz for the rest of the run, so a wedged controller produced a
            // "completed" run. Now a rolling window of apply outcomes trips a
            // latched fault once `faultThreshold` of the last `faultWindow`
            // applies failed ("≥3 of 10", not "3 consecutive": a late reply to
            // an earlier 0x70 can satisfy the next request and reset a
            // consecutive counter). On fault: apply is forced OFF (fail closed)
            // and a 'fault' event fires — ArenaSession routes it to the runner.
            this._faultThreshold = Number.isInteger(o.faultThreshold) ? o.faultThreshold : 3;
            this._faultWindow = Number.isInteger(o.faultWindow) ? o.faultWindow : 10;
            this._applyOutcomes = []; // most recent apply results, 1 = failed, 0 = ok
            this._applyFailures = 0; // total failed applies (timeouts, rejects, link errors)
            this._fault = null; // latched fault record, or null

            // Bridge config (mirrors the console inputs). Sent on connect + on change.
            // logLevel is the log format requested when logging starts
            // ('behavior_v2' default | 'behavior_v1' | 'full'); the browser ASSERTS
            // it so the runner logs deterministically regardless of how the bridge
            // process was launched. The bridge answers with the level it will
            // actually write (log_control_ack) — see ackedLogLevel.
            this._config = {
                fictrac_port: 60000,
                gain: 1.8,
                offset: 0,
                frames: null,
                logLevel: LOG_LEVELS[0]
            };
            this._bridgeInfo = null; // from hello_ack: {version, levels, level} (null = old bridge / not yet)
            this._ackedLevel = null; // from log_control_ack while logging is enabled
            this._ackWaiters = []; // waitForLogLevelAck() resolvers
        }

        // ---- events ----------------------------------------------------------
        on(event, fn) {
            if (!this._handlers[event])
                throw new Error('FicTracBridgeClient: unknown event "' + event + '"');
            this._handlers[event].add(fn);
            return () => this.off(event, fn);
        }
        off(event, fn) {
            if (this._handlers[event]) this._handlers[event].delete(fn);
        }
        _emit(event, ...args) {
            const set = this._handlers[event];
            if (!set) return;
            for (const fn of Array.from(set)) {
                try {
                    fn(...args);
                } catch (_) {
                    /* a subscriber must not break the client or siblings */
                }
            }
        }

        // ---- state -----------------------------------------------------------
        get connected() {
            return !!(this._ws && this._ws.readyState === 1 /* OPEN */);
        }
        get apply() {
            return this._apply;
        }
        get logging() {
            return this._logging;
        }
        get config() {
            return Object.assign({}, this._config);
        }
        get stats() {
            return {
                recv: this._recv,
                applied: this._applied,
                drop: Math.max(0, this._recv - this._applied),
                rateHz: this._rateHz,
                applyFailures: this._applyFailures,
                fault: this._fault
            };
        }

        /** The latched fault record ({kind, failures, window, …}) or null. */
        get fault() {
            return this._fault;
        }

        /** Clear the fault latch + outcome window (a new run / apply session starts clean). */
        resetFaultWindow() {
            this._applyOutcomes = [];
            this._fault = null;
        }

        // Record one apply outcome; trip the fault latch when the window fills
        // with failures. Fail closed: apply goes OFF before anyone is told.
        _recordApply(failed, err, index) {
            const w = this._applyOutcomes;
            w.push(failed ? 1 : 0);
            if (w.length > this._faultWindow) w.shift();
            if (!failed) return;
            this._applyFailures++;
            if (this._fault) return;
            const n = w.reduce((a, b) => a + b, 0);
            if (n < this._faultThreshold) return;
            this._fault = {
                kind: 'controller_unresponsive',
                failures: n,
                window: w.length,
                threshold: this._faultThreshold,
                lastIndex: index,
                lastError: err ? err.message || String(err) : null,
                t: this._now()
            };
            if (this._apply) {
                this._apply = false;
                this._emit('apply', false);
            }
            this._emit('fault', this._fault);
        }

        // ---- connection ------------------------------------------------------
        /**
         * Open the bridge WebSocket. Idempotent: if already open, does nothing.
         * @param {string} [url]  ws:// URL; remembered so a later connect() reconnects.
         */
        connect(url) {
            if (url) this._url = url;
            if (this.connected) return;
            if (!this._url) {
                this._emit('log', 'bridge: no URL to connect to', 'err');
                return;
            }
            if (!this._WS) {
                this._emit('log', 'bridge: WebSocket unavailable in this environment', 'err');
                return;
            }
            let ws;
            try {
                ws = new this._WS(this._url);
            } catch (e) {
                this._emit('log', 'bridge: bad URL — ' + (e && (e.message || e)), 'err');
                return;
            }
            this._ws = ws;
            this._recv = 0;
            this._applied = 0;
            this._pending = null;
            this._emit('status', 'connecting…', 'dim');
            ws.onopen = () => {
                this._emit('status', 'connected', 'accent');
                this._emit('log', 'bridge: connected to ' + this._url, 'info');
                this._send({ type: 'hello', client: 'webDisplayTools', v: 1 });
                this.sendConfig();
                if (this._logging)
                    this._send({
                        type: 'log_control',
                        enabled: true,
                        level: this._config.logLevel
                    });
                this._startRateTimer();
                this._emit('stats', this.stats);
            };
            ws.onmessage = (ev) => {
                let msg;
                try {
                    msg = JSON.parse(ev.data);
                } catch (_) {
                    return; // ignore non-JSON
                }
                if (msg && msg.type === 'frame') this.handleFrame(msg.index, msg);
                else if (msg && msg.type === 'log_export_result') this._handleExportResult(msg);
                else if (msg && msg.type === 'hello_ack') this._handleHelloAck(msg);
                else if (msg && msg.type === 'log_control_ack') this._handleLogControlAck(msg);
            };
            ws.onerror = () => this._emit('status', 'error', 'err');
            ws.onclose = () => {
                this._stopRateTimer();
                this._ws = null;
                this._bridgeInfo = null;
                this._ackedLevel = null;
                this._settleAckWaiters(null);
                this._settleExport('reject', new Error('bridge disconnected during log export'));
                this._emit('status', 'disconnected', 'dim');
                this._emit('stats', this.stats);
            };
        }

        /** Close the bridge WebSocket (idempotent). */
        disconnect() {
            if (this._ws) {
                try {
                    this._ws.close();
                } catch (_) {
                    /* closing socket can throw — ignore */
                }
            }
            this._ws = null;
            this._stopRateTimer();
        }

        // ---- config / logging ------------------------------------------------
        /** Merge config (any subset of fictrac_port/gain/offset/frames) and push if connected. */
        setConfig(partial) {
            if (partial && typeof partial === 'object') {
                for (const k of ['fictrac_port', 'gain', 'offset', 'frames']) {
                    if (partial[k] !== undefined && partial[k] !== null)
                        this._config[k] = partial[k];
                }
            }
            this.sendConfig();
        }
        /** Push the current config to the bridge (no-op when disconnected). */
        sendConfig() {
            const cfg = { type: 'config' };
            const c = this._config;
            if (Number.isFinite(c.fictrac_port)) cfg.fictrac_port = c.fictrac_port;
            if (Number.isFinite(c.gain)) cfg.gain = c.gain;
            if (Number.isFinite(c.offset)) cfg.offset = c.offset;
            if (Number.isFinite(c.frames)) cfg.frames = c.frames;
            this._send(cfg);
        }

        /** Set the clamp policy (index → in-range index). Consumer-specific. */
        setClampFrame(fn) {
            if (typeof fn === 'function') this._clampFrame = fn;
        }
        /** Set the apply gate (may we drive the arena right now?). Consumer-specific. */
        setCanApply(fn) {
            if (typeof fn === 'function') this._canApply = fn;
        }
        /** Set how a frame index reaches the arena. Consumer-specific. */
        setApplyFrame(fn) {
            if (typeof fn === 'function') this._applyFrame = fn;
        }

        /**
         * Enable/disable driving the arena from FicTrac frames (Mode-3 streaming).
         * Enabling does NOT flush a stale pending index (matches the console) — the
         * next incoming frame drives, so we never apply a heading from before activation.
         */
        setApply(on) {
            const next = !!on;
            const changed = next !== this._apply;
            if (changed && next) this.resetFaultWindow(); // a fresh apply session starts clean
            this._apply = next;
            if (changed) this._emit('apply', this._apply);
        }

        /**
         * Select the log level for the NEXT log the bridge opens: 'behavior_v2'
         * (compact arena echoes, the default), 'behavior_v1' (the pre-2026-09
         * format) or 'full' (25-column FicTrac record). Takes effect at the next
         * setLogging(true) / reconnect (the bridge applies it when it opens a fresh
         * file). Unknown values are ignored.
         */
        setLogLevel(level) {
            if (LOG_LEVELS.includes(level)) this._config.logLevel = level;
        }
        /** The level this client will request (not necessarily what the bridge writes). */
        get logLevel() {
            return this._config.logLevel;
        }
        /**
         * The level the bridge acknowledged for the CURRENT log file (log_control_ack
         * with enabled=true), or null: not yet acked, logging off, or an old bridge
         * that never acks (then it writes behavior_v1 / whatever --log-frames said).
         */
        get ackedLogLevel() {
            return this._ackedLevel;
        }
        /** hello_ack facts {version, levels, level} — null until a ≥3.0 bridge answers. */
        get bridgeInfo() {
            return this._bridgeInfo;
        }
        /**
         * Can the connected bridge write `level`? true/false from hello_ack; null when
         * unknown (no hello_ack yet — including every pre-3.0 bridge).
         */
        bridgeSupportsLevel(level) {
            const lv = level || this._config.logLevel;
            if (!this._bridgeInfo || !Array.isArray(this._bridgeInfo.levels)) return null;
            return this._bridgeInfo.levels.includes(lv);
        }
        /**
         * Resolve with the acked level once the bridge answers the pending
         * log_control (or immediately if it already has); null after `timeoutMs`
         * (default 1000) — i.e. an old bridge, or not connected.
         */
        waitForLogLevelAck(timeoutMs) {
            if (this._ackedLevel) return Promise.resolve(this._ackedLevel);
            if (!this.connected || !this._logging) return Promise.resolve(null);
            return new Promise((resolve) => {
                const w = { resolve, timer: null };
                w.timer = setTimeout(() => {
                    this._ackWaiters = this._ackWaiters.filter((x) => x !== w);
                    resolve(null);
                }, timeoutMs || 1000);
                this._ackWaiters.push(w);
            });
        }
        _settleAckWaiters(level) {
            const ws = this._ackWaiters;
            this._ackWaiters = [];
            for (const w of ws) {
                if (w.timer && typeof clearTimeout !== 'undefined') clearTimeout(w.timer);
                w.resolve(level);
            }
        }
        _handleHelloAck(msg) {
            this._bridgeInfo = {
                version: msg.bridge || null,
                levels: Array.isArray(msg.levels) ? msg.levels.slice() : [],
                level: msg.level || null
            };
            const requested = this._config.logLevel;
            const ok = this._bridgeInfo.levels.includes(requested);
            if (!ok) {
                this._emit(
                    'log',
                    'bridge ' +
                        (msg.bridge || '?') +
                        ' cannot write ' +
                        requested +
                        ' (it offers ' +
                        this._bridgeInfo.levels.join(', ') +
                        ') — restart `pixi run bridge` from the current checkout',
                    'err'
                );
            }
            this._emit('loglevel', {
                source: 'hello',
                requested: requested,
                level: ok ? requested : this._bridgeInfo.level,
                ok: ok,
                levels: this._bridgeInfo.levels,
                enabled: !!msg.logging,
                file: null
            });
        }
        _handleLogControlAck(msg) {
            const requested = msg.requested != null ? msg.requested : this._config.logLevel;
            const level = msg.level || null;
            const enabled = !!msg.enabled;
            this._ackedLevel = enabled ? level : null;
            const ok = !enabled || level === requested;
            if (!ok) {
                this._emit(
                    'log',
                    'bridge too old for ' +
                        requested +
                        ' — logging ' +
                        level +
                        ' instead (restart `pixi run bridge` from the current checkout)',
                    'err'
                );
            }
            this._emit('loglevel', {
                source: 'log_control',
                requested: requested,
                level: level,
                ok: ok,
                levels: this._bridgeInfo ? this._bridgeInfo.levels : null,
                enabled: enabled,
                file: msg.file || null
            });
            if (enabled) this._settleAckWaiters(level);
        }

        /** Turn the bridge's session log file on/off (sends log_control + the level). */
        setLogging(on) {
            this._logging = !!on;
            this._ackedLevel = null; // pending until the bridge acks this request
            const msg = { type: 'log_control', enabled: this._logging };
            if (this._logging) msg.level = this._config.logLevel;
            this._send(msg);
        }

        /** Append an event to the bridge log (only when logging is on + connected). */
        log(obj) {
            if (this._logging && this.connected) {
                this._send(Object.assign({ type: 'log' }, obj));
            }
        }

        /**
         * Ask the bridge for the current/most-recent log file (log_export →
         * log_export_result). The bridge CLOSES the active log first, so call
         * this at run completion (after the last log() event). The first
         * request/response pair in the protocol: single-in-flight — concurrent
         * calls share one Promise. Resolves {name, content}; rejects when
         * disconnected, on a bridge-side error, or after `timeoutMs` (15s
         * default — the file streams back as ONE message, so this is one
         * round-trip, not a transfer loop).
         * @param {number} [timeoutMs]
         * @returns {Promise<{name: string|null, content: string}>}
         */
        exportLog(timeoutMs) {
            if (this._exportPending) return this._exportPending.promise;
            if (!this.connected) {
                return Promise.reject(new Error('bridge not connected — no log to export'));
            }
            const pending = {};
            pending.promise = new Promise((resolve, reject) => {
                pending.resolve = resolve;
                pending.reject = reject;
            });
            pending.timer = setTimeout(() => {
                this._settleExport(
                    'reject',
                    new Error(
                        'log export timed out — no log_export reply from the bridge. ' +
                            'The running bridge may be an older build; restart `pixi run bridge` from the current version.'
                    )
                );
            }, timeoutMs || 15000);
            this._exportPending = pending;
            this._send({ type: 'log_export' });
            return pending.promise;
        }

        _handleExportResult(msg) {
            if (msg && msg.error) {
                this._settleExport('reject', new Error('bridge: ' + msg.error));
            } else {
                this._settleExport('resolve', {
                    name: (msg && msg.name) || null,
                    content: String((msg && msg.content) != null ? msg.content : '')
                });
            }
        }

        _settleExport(how, arg) {
            const p = this._exportPending;
            if (!p) return;
            this._exportPending = null;
            if (p.timer && typeof clearTimeout !== 'undefined') clearTimeout(p.timer);
            if (how === 'resolve') p.resolve(arg);
            else p.reject(arg);
        }

        // ---- frame handling (the coalesced single-flight apply loop) ---------
        /**
         * A frame index arrived from the bridge. Counts it, coalesces it as the
         * newest pending index, and (if applying + permitted) drains it to the arena.
         * The optional full `msg` carries the behavior_v1 kinematic fields — when
         * present they're re-emitted as a 'sample' event for the live oscilloscope
         * (the frame-driving path itself only needs the index).
         * PUBLIC so tests can drive it without a live WebSocket.
         */
        handleFrame(index, msg) {
            if (!Number.isFinite(index)) return;
            this._recv++;
            this._rateCount++;
            this._pending = index; // coalesce — only the newest index matters
            this._emit('frame', index);
            // behavior_v1 sample for the scope — only when the bridge forwards the
            // kinematic fields (older bridges send index-only → no 'sample').
            if (msg && (typeof msg.hd === 'number' || typeof msg.x === 'number')) {
                this._emit('sample', {
                    ms: typeof msg.ms === 'number' ? msg.ms : null,
                    fc: typeof msg.fc === 'number' ? msg.fc : msg.seq,
                    idx: typeof msg.idx === 'number' ? msg.idx : index,
                    ft: typeof msg.ft === 'number' ? msg.ft : null,
                    x: msg.x,
                    y: msg.y,
                    hd: msg.hd,
                    t: typeof msg.t === 'number' ? msg.t : this._now()
                });
            }
            this._emit('stats', this.stats);
            if (!this._apply) return;
            if (!this._applyFrame) return;
            if (!this._canApply()) {
                const now = this._now();
                if (now - this._lastBlockedMs >= 500) {
                    this._lastBlockedMs = now;
                    this._emit('blocked', 'cannot apply frame (no pattern loaded / disconnected)');
                }
                return;
            }
            this._drain();
        }

        async _drain() {
            if (this._inFlight) return; // a drain loop is already running
            this._inFlight = true;
            try {
                while (this._pending != null && this._apply && this._canApply()) {
                    const i = this._clampFrame(this._pending);
                    this._pending = null;
                    try {
                        await this._applyFrame(i);
                        this._applied++;
                        this._recordApply(false, null, i);
                        this._emit('applied', i);
                        this._emit('stats', this.stats);
                    } catch (e) {
                        this._emit('log', 'bridge apply failed: ' + (e && (e.message || e)), 'err');
                        // Counted, not swallowed (fw #50): enough failures in the
                        // window latch a fault and stop the loop (apply → false).
                        this._recordApply(true, e, i);
                    }
                }
            } finally {
                this._inFlight = false;
            }
        }

        // ---- internals -------------------------------------------------------
        _send(obj) {
            const ws = this._ws;
            if (ws && ws.readyState === 1 /* OPEN */) {
                try {
                    ws.send(JSON.stringify(obj));
                } catch (_) {
                    /* a closing socket can throw on send — ignore */
                }
            }
        }
        _startRateTimer() {
            if (this._rateTimer || typeof setInterval === 'undefined') return;
            this._rateTimer = setInterval(() => {
                this._rateHz = this._rateCount;
                this._rateCount = 0;
                this._emit('stats', this.stats);
            }, 1000);
        }
        _stopRateTimer() {
            if (this._rateTimer && typeof clearInterval !== 'undefined') {
                clearInterval(this._rateTimer);
            }
            this._rateTimer = null;
            this._rateHz = 0;
        }
    }

    // Dual-export: CommonJS (Node tests) + window global (classic <script src>).
    FicTracBridgeClient.LOG_LEVELS = LOG_LEVELS.slice();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FicTracBridgeClient;
    }
    if (typeof global !== 'undefined') {
        global.FicTracBridgeClient = FicTracBridgeClient;
    }
})(typeof window !== 'undefined' ? window : this);
