/**
 * arena-link.js — Web Serial transport for the G6 Arena controller.
 *
 * Talks to the G6 Arena controller (Teensy 4.1) over its USB-CDC serial port.
 * This module is pure transport: it opens the port, runs a background reader
 * that de-frames the byte stream into length-prefixed frames, correlates each
 * response with the request that is waiting for it, and surfaces disconnects.
 * It has minimal protocol knowledge — only the length-prefix framing (first
 * byte = number of bytes that follow) and the echo_cmd byte used to correlate
 * a reply with its request. Build request bytes and decode response payloads
 * with js/arena-wire-g6.js.
 *
 *   const link = new ArenaLink({ onDisconnect: () => {...} });
 *   await link.requestPort();        // inside a user gesture (click)
 *   await link.open();               // baudRate defaults to 115200
 *   const frame = await link.send(ArenaWireG6.encodeGetControllerInfo());
 *   const info  = ArenaWireG6.decodeControllerInfo(ArenaWireG6.decodeResponse(frame));
 *
 * Correlation model — SINGLE-FLIGHT + echo-verified:
 *   The handoff requires correlating responses by echo_cmd. This protocol has
 *   no request id and can send the same opcode twice, so echo matching alone
 *   can't disambiguate two identical in-flight commands. We therefore serialize
 *   sends (only one outstanding at a time; concurrent send() calls queue) AND
 *   verify that the response's echo_cmd matches the in-flight request's opcode
 *   before resolving — a mismatch is surfaced as a desync rather than silently
 *   resolving the wrong request. On timeout the rx buffer is flushed so a late
 *   reply can't be mis-matched to the next request. This is a deliberate
 *   divergence from the reference scripts/web-serial/main.js, which resolves the
 *   oldest pending await regardless of echo (fine for its one-shot button UI,
 *   too loose for the shared substrate the runner will build on).
 *
 * Gotchas (from the reference README — all still apply):
 *   - Web Serial is Chromium-only (Chrome / Edge / Opera / Brave / Arc) on a
 *     desktop OS. Firefox and Safari do NOT implement navigator.serial — gate
 *     UI on ArenaLink.isSupported().
 *   - requestPort() must run inside a user gesture (e.g. a click handler).
 *   - Permissions are per-origin: opening from file:// and from an http origin
 *     prompts the port chooser separately for each.
 *   - baudRate is meaningless on USB CDC — the controller honors any value.
 *     115200 is a conventional placeholder.
 *   - Only one process can hold the port. Close pio device monitor / dwfpy /
 *     other terminals before connecting.
 *   - DEBUG_SERIAL firmware builds interleave diagnostic text on the same pipe;
 *     a stray byte is treated as a frame length and can stall the parser behind
 *     a bogus length. The single-flight timeout (which flushes the rx buffer) is
 *     the resync: the request times out, the buffer clears, the next command
 *     starts clean. Prefer a non-DEBUG_SERIAL build for interactive use.
 *
 * Browser-global + Node CommonJS export, mirroring js/crc.js / js/arena-wire-g6.js.
 * No ES `export` keyword (a top-level `export` would break plain `<script src=>`
 * loading). Browser callers load via `<script src="js/arena-link.js">` and read
 * `window.ArenaLink`. Loading in Node is safe (navigator is only touched inside
 * methods); isSupported() simply returns false there.
 */

const ArenaLink = (function () {
    'use strict';

    const DEFAULT_BAUD_RATE = 115200; // ignored by USB CDC; conventional placeholder
    const DEFAULT_TIMEOUT_MS = 500; // controller replies in well under 1 ms
    const HEX_LOG_LIMIT = 32; // truncate longer payloads in the trace log

    const hex = (bytes) =>
        Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');

    // Truncate long payloads (e.g. future stream frames) so the log stays readable.
    const hexDump = (bytes) =>
        bytes.length > HEX_LOG_LIMIT
            ? hex(bytes.subarray(0, 16)) + ' … (' + bytes.length + ' bytes)'
            : hex(bytes);

    class ArenaLink {
        /**
         * @param {object} [options]
         * @param {function():void}        [options.onDisconnect] device unplugged / port lost
         * @param {function(Error):void}   [options.onError]      background read-loop error
         * @param {function(string):void}  [options.onLog]        line-oriented trace log
         */
        constructor(options) {
            options = options || {};
            this._onDisconnect = options.onDisconnect || null;
            this._onError = options.onError || null;
            this._onLog = options.onLog || null;

            this._port = null;
            this._reader = null;
            this._writer = null;
            this._readLoopPromise = null;
            this._connected = false;
            this._closing = false;

            // Accumulator for incoming bytes — complete [length, ...] frames are
            // pulled off the front as they arrive.
            this._rxBuf = new Uint8Array(0);
            // The single outstanding request, or null. Shape:
            // { expectedCmd, resolve, reject, timer }. Single-flight: there is
            // never more than one.
            this._inflight = null;
            // Serializes concurrent send() callers into one-at-a-time requests.
            this._sendQueue = Promise.resolve();

            // Bind so add/removeEventListener share one reference.
            this._handleSerialDisconnect = this._handleSerialDisconnect.bind(this);
        }

        /** Feature-detect: Web Serial is Chromium-desktop only. */
        static isSupported() {
            return typeof navigator !== 'undefined' && !!navigator.serial;
        }

        get connected() {
            return this._connected;
        }

        get port() {
            return this._port;
        }

        _log() {
            if (this._onLog) this._onLog(Array.prototype.join.call(arguments, ' '));
        }

        _assertSupported() {
            if (!ArenaLink.isSupported()) {
                throw new Error(
                    'Web Serial API unavailable — use a Chromium-based browser ' +
                        '(Chrome / Edge / Opera) on desktop.'
                );
            }
        }

        /**
         * Prompt the OS serial-port chooser and remember the selection. MUST be
         * called from a user gesture (click). Optional `options` is passed
         * straight to navigator.serial.requestPort() (e.g. { filters }).
         */
        async requestPort(options) {
            this._assertSupported();
            this._port = await navigator.serial.requestPort(options || {});
            return this._port;
        }

        /**
         * Open the selected port and start the background reader.
         * @param {object} [opts]
         * @param {number} [opts.baudRate=115200]
         */
        async open(opts) {
            this._assertSupported();
            if (!this._port) {
                throw new Error('No port selected — call requestPort() first (in a user gesture).');
            }
            if (this._connected) return;

            const baudRate = (opts && opts.baudRate) || DEFAULT_BAUD_RATE;
            await this._port.open({ baudRate });

            try {
                this._writer = this._port.writable.getWriter();
                this._reader = this._port.readable.getReader();
            } catch (err) {
                // Roll back the open so we don't leak an opened-but-unusable port.
                this._writer = null;
                this._reader = null;
                try {
                    await this._port.close();
                } catch (_) {
                    /* best-effort */
                }
                throw err;
            }

            this._rxBuf = new Uint8Array(0);
            this._closing = false;
            this._connected = true;

            // Surface the device being physically unplugged.
            navigator.serial.addEventListener('disconnect', this._handleSerialDisconnect);

            this._readLoopPromise = this._readLoop();
            this._log('-- connected');
        }

        /** Convenience: requestPort() then open(). Must run in a user gesture. */
        async connect(opts) {
            opts = opts || {};
            await this.requestPort(opts.filters ? { filters: opts.filters } : undefined);
            await this.open(opts);
            return this._port;
        }

        /**
         * Write a request and resolve with the correlated response FRAME
         * (Uint8Array, including the length byte — pass it straight to
         * ArenaWireG6.decodeResponse). Concurrent calls are serialized
         * (single-flight). Rejects on write error, timeout, echo desync, or
         * disconnect.
         * @param {Uint8Array|number[]} bytes request frame
         * @param {object} [opts]
         * @param {number} [opts.timeoutMs=500]
         * @returns {Promise<Uint8Array>}
         */
        send(bytes, opts) {
            // Chain onto the queue so only one request is in flight at a time.
            // `run` fires whether the previous send resolved or rejected.
            const run = () => this._sendOne(bytes, opts);
            const result = this._sendQueue.then(run, run);
            // Keep the queue tail from rejecting so the next send still chains.
            this._sendQueue = result.then(
                () => {},
                () => {}
            );
            return result;
        }

        async _sendOne(bytes, opts) {
            if (!this._writer) throw new Error('ArenaLink.send: not connected');
            const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
            const payload = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
            const expectedCmd = payload[1]; // request frame is [length, cmd, ...params]

            // Park the await BEFORE writing so a very fast reply can't arrive
            // before its promise exists. The executor runs synchronously, so
            // `_inflight` is set before we write.
            const respPromise = new Promise((resolve, reject) => {
                const entry = { expectedCmd, resolve, reject, timer: null };
                entry.timer = setTimeout(() => {
                    if (this._inflight !== entry) return;
                    this._inflight = null;
                    // Flush partial/late bytes so a tardy reply can't be
                    // mis-matched to the NEXT request.
                    this._rxBuf = new Uint8Array(0);
                    reject(
                        new Error(
                            'response timeout after ' +
                                timeoutMs +
                                ' ms (cmd 0x' +
                                (expectedCmd === undefined ? '??' : expectedCmd.toString(16)) +
                                ')'
                        )
                    );
                }, timeoutMs);
                this._inflight = entry;
            });

            this._log('->', hexDump(payload));
            try {
                await this._writer.write(payload);
            } catch (err) {
                if (this._inflight) {
                    clearTimeout(this._inflight.timer);
                    this._inflight = null;
                }
                throw err;
            }
            return respPromise;
        }

        /** Close the port and tear down I/O. Safe to call when already closed. */
        async close() {
            const wasConnected = this._connected;
            this._closing = true;
            this._connected = false;
            if (ArenaLink.isSupported()) {
                navigator.serial.removeEventListener('disconnect', this._handleSerialDisconnect);
            }
            this._rejectInflight(new Error('port closed'));

            try {
                if (this._reader) {
                    await this._reader.cancel();
                    try {
                        this._reader.releaseLock();
                    } catch (_) {
                        /* already released */
                    }
                }
            } catch (_) {
                /* best-effort */
            }
            this._reader = null;

            try {
                if (this._writer) this._writer.releaseLock();
            } catch (_) {
                /* best-effort */
            }
            this._writer = null;

            try {
                if (this._readLoopPromise) await this._readLoopPromise;
            } catch (_) {
                /* read loop ended */
            }
            this._readLoopPromise = null;

            try {
                if (this._port) await this._port.close();
            } catch (_) {
                /* best-effort */
            }
            this._port = null;
            this._closing = false;
            if (wasConnected) this._log('-- disconnected');
        }

        // ───────────────────────── internals ─────────────────────────

        // Append a chunk and pull every complete [length, ...] frame off the
        // front. With single-flight, a complete frame belongs to the one
        // outstanding request — but only if its echo_cmd matches. Same framing as
        // the firmware's SerialManager / NetworkManager: first byte = count of
        // bytes that follow.
        _consumeIncoming(chunk) {
            const merged = new Uint8Array(this._rxBuf.length + chunk.length);
            merged.set(this._rxBuf, 0);
            merged.set(chunk, this._rxBuf.length);
            this._rxBuf = merged;

            while (this._rxBuf.length >= 1) {
                const claimedLen = this._rxBuf[0];
                const totalNeeded = 1 + claimedLen;
                if (this._rxBuf.length < totalNeeded) break;

                // Independent copy so the resolved frame doesn't alias rxBuf.
                const frame = this._rxBuf.slice(0, totalNeeded);
                this._rxBuf = this._rxBuf.slice(totalNeeded);

                // A real response is [len>=2, status, echo_cmd, ...]. Anything
                // shorter is a stray/runt byte (e.g. DEBUG noise) — ignore it.
                if (claimedLen < 2) {
                    this._log('  !! ignoring runt frame', hexDump(frame));
                    continue;
                }

                this._log('  <-', hexDump(frame));

                const entry = this._inflight;
                if (!entry) {
                    // No request is waiting — late/unsolicited frame.
                    this._log('  !! unsolicited frame, dropped');
                    continue;
                }

                const echoCmd = frame[2];
                if (echoCmd !== entry.expectedCmd) {
                    // Response opcode doesn't match the in-flight request: a
                    // host/firmware desync. Surface it rather than hide it.
                    clearTimeout(entry.timer);
                    this._inflight = null;
                    entry.reject(
                        new Error(
                            'response echo 0x' +
                                echoCmd.toString(16) +
                                ' does not match in-flight request 0x' +
                                (entry.expectedCmd === undefined
                                    ? '??'
                                    : entry.expectedCmd.toString(16)) +
                                ' (desync)'
                        )
                    );
                    continue;
                }

                clearTimeout(entry.timer);
                this._inflight = null;
                entry.resolve(frame);
            }
        }

        async _readLoop() {
            try {
                while (this._port && this._port.readable && this._reader) {
                    const { value, done } = await this._reader.read();
                    if (done) break;
                    if (value && value.length) this._consumeIncoming(value);
                }
            } catch (err) {
                if (this._closing) return; // intentional teardown via close()
                if (err && err.name !== 'AbortError') {
                    this._failConnection(err, true);
                }
            }
        }

        _rejectInflight(err) {
            if (this._inflight) {
                clearTimeout(this._inflight.timer);
                const entry = this._inflight;
                this._inflight = null;
                entry.reject(err);
            }
        }

        // Shared failure path for read-loop errors and device disconnects.
        // Idempotent: once disconnected (or after an explicit close()), it's a
        // no-op. Does NOT close the port (the caller may still want to), just
        // drops I/O state and notifies.
        _failConnection(err, reportError) {
            if (!this._connected) return;
            this._connected = false;
            this._rejectInflight(err);

            if (ArenaLink.isSupported()) {
                navigator.serial.removeEventListener('disconnect', this._handleSerialDisconnect);
            }
            try {
                if (this._reader) this._reader.releaseLock();
            } catch (_) {
                /* best-effort */
            }
            this._reader = null;
            try {
                if (this._writer) this._writer.releaseLock();
            } catch (_) {
                /* best-effort */
            }
            this._writer = null;
            this._rxBuf = new Uint8Array(0);
            this._readLoopPromise = null;

            this._log('-- connection lost:', (err && err.message) || err);
            if (reportError && this._onError) this._onError(err);
            if (this._onDisconnect) this._onDisconnect();
        }

        // navigator.serial 'disconnect' — the device was unplugged.
        _handleSerialDisconnect(event) {
            // Fail-safe: only ignore the event if we can POSITIVELY identify a
            // DIFFERENT port. Some Chromium versions deliver the event at
            // navigator.serial (target is the Serial object, not the SerialPort);
            // if we can't tell, fall through to cleanup rather than no-op.
            const target = event && event.target;
            const isPort = typeof SerialPort !== 'undefined' && target instanceof SerialPort;
            if (this._port && isPort && target !== this._port) {
                return; // a different port disconnected
            }
            this._failConnection(new Error('port disconnected'), false);
        }
    }

    return ArenaLink;
})();

// Export for Node.js (CommonJS) — used by tests/test-arena-link.js.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ArenaLink;
}

// Export for browser (global) — used by <script src=> callers (the G6 web
// console, LAB-93) which read window.ArenaLink.
if (typeof window !== 'undefined') {
    window.ArenaLink = ArenaLink;
}
