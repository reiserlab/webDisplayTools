/**
 * arena-telemetry.js — decoder + drainer for the G6 controller's telemetry RING
 * (firmware `feat/telemetry-ring`, design: docs/development/
 * controller-telemetry-ring-buffer-proposal.md § 3.1; first target: fw #50).
 *
 * The controller keeps a 64 KiB byte ring of timestamped records in
 * reboot-surviving OCRAM: CMD (every command it processed, with the reply
 * status), FRAME (each displayed frame change with its SD load + SPI time) and
 * STATE (mode changes, error glyphs, slow SD reads, overruns, boots). The host
 * drains it with GET_TELEMETRY_BLOCK 0xA9 using an ACK CURSOR: a block is only
 * freed by the NEXT request's ack_seq, so a lost or timed-out reply is harmless
 * — re-ask with the same ack and get the same bytes.
 *
 * Wire (little-endian):
 *   block payload: t_now_us u32 · first_seq u32 · n_records u16 · dropped u32 ·
 *                  more u8 · flags u8 (bit0 events on, bit1 contents survived a
 *                  reboot) · boot_count u16   = 18 B header, then records
 *   record: len u8 (total) · type u8 · seq u32 · t_us u32 · payload
 *     1 CMD   : cmd u8 · status u8 · plen u8 · payload[plen ≤ 8]   (request bytes)
 *     2 FRAME : idx u16 · pattern u16 · sd_load_us u16 · spi_us u16
 *     3 STATE : kind u8 · code u8 · arg u16
 *               kind 8 wdog_context (boot after a watchdog reset, fw eca07f6 follow-up): code = the
 *               watchdog handler's EXC_RETURN low byte (0xF9 preempted thread mode, 0xF1 a handler),
 *               arg bits 0–8 = stacked xPSR IPSR (0 = thread, 138 = the PIT handler), bits 9–15 =
 *               isr_last before the watchdog overwrote it. kind 9 prev_isr_count: code = ISR id,
 *               arg = previous boot's entry count >> 12 (saturating).
 *     0 PAD   : filler at the ring's wrap point (skipped)
 *
 * Log rows (behavior_v2 companion streams, proposal § 3.3; `rx` = host receive
 * epoch ms, `t_us` = raw controller micros(), `seq` = ring sequence):
 *   ["cc", rx, t_us, seq, cmd, status, "reqhex"]
 *   ["cf", rx, t_us, seq, idx, pattern, sd_load_us, spi_us]
 *   ["cs", rx, t_us, seq, kind, code, arg]
 *
 * Classic dual-export (window global + CommonJS), no bare ES `export`.
 */
(function (global) {
    'use strict';

    const HEADER_BYTES = 18;
    const REC = { PAD: 0, CMD: 1, FRAME: 2, STATE: 3 };
    const STATE_KINDS = {
        1: 'boot',
        2: 'state_change',
        3: 'error_glyph',
        4: 'sd_slow',
        5: 'ring_overrun',
        6: 'telemetry',
        7: 'sd_open',
        8: 'wdog_context',
        9: 'prev_isr_count'
    };
    const ISR_NAMES = [
        'none',
        'refresh_timer',
        'spi_dma',
        'watchdog',
        'usb',
        'sdhc',
        'lpspi',
        'pit'
    ];
    const ARENA_STATES = [
        'ALL_OFF',
        'ALL_ON',
        'STREAMING_FRAME',
        'OPEN_LOOP',
        'SHOW_FRAME',
        'CLOSED_LOOP',
        'PSRAM_PLAY',
        'ERROR_DISPLAY'
    ];
    const NO_ACK = 0xffffffff;

    const hex = (u8) =>
        Array.from(u8)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

    function u16(m, o) {
        return m[o] | (m[o + 1] << 8);
    }
    function u32(m, o) {
        return (m[o] | (m[o + 1] << 8) | (m[o + 2] << 16) | (m[o + 3] << 24)) >>> 0;
    }
    /** a is after b in modular u32 sequence space (half-range rule). */
    function seqAfter(a, b) {
        const d = (a - b) >>> 0;
        return d !== 0 && d < 0x80000000;
    }

    /** Parse one 0xA9 reply FRAME (as returned by session.send) → block or null. */
    function parseBlock(resp, wire) {
        const W = wire || (typeof global !== 'undefined' ? global.ArenaWireG6 : null);
        const d = W ? W.decodeResponse(resp) : null;
        if (!d || !d.ok) return null;
        const m = d.payload;
        if (!m || m.length < HEADER_BYTES) return null;
        const block = {
            tNowUs: u32(m, 0),
            firstSeq: u32(m, 4),
            nRecords: u16(m, 8),
            dropped: u32(m, 10),
            more: !!(m[14] & 1),
            flags: m[15],
            eventsEnabled: !!(m[15] & 1),
            survivedReboot: !!(m[15] & 2),
            disabledHeapCollision: !!(m[15] & 4), // ring refused: heap reached its address
            syntheticOn: !!(m[15] & 8), // T1 synthetic producer running
            bootCount: u16(m, 16),
            records: [],
            bytes: m.length - HEADER_BYTES,
            malformed: 0,
            rawHex: hex(m) // decoder-independent copy (kept only in crash dumps)
        };
        let o = HEADER_BYTES;
        while (o < m.length) {
            const len = m[o];
            if (len < 2 || o + len > m.length) {
                block.malformed++;
                break;
            }
            const type = m[o + 1];
            if (type === REC.PAD) {
                o += len;
                continue;
            }
            if (len < 10) {
                block.malformed++;
                o += len;
                continue;
            }
            const rec = { type, seq: u32(m, o + 2), tUs: u32(m, o + 6) };
            const p = o + 10;
            const plen = len - 10;
            if (type === REC.CMD && plen >= 3) {
                rec.kind = 'cmd';
                rec.cmd = m[p];
                rec.status = m[p + 1];
                const n = Math.min(m[p + 2], plen - 3, 8);
                rec.req = hex(m.subarray(p + 3, p + 3 + n));
            } else if (type === REC.FRAME && plen >= 10) {
                rec.kind = 'frame';
                rec.idx = u16(m, p);
                rec.pattern = u16(m, p + 2);
                rec.sdLoadUs = u32(m, p + 4); // u32: the 129 ms SD tail must fit (u16 caps at 65 ms)
                rec.spiUs = u16(m, p + 8);
            } else if (type === REC.STATE && plen >= 4) {
                rec.kind = 'state';
                rec.stateKind = m[p];
                rec.stateName = STATE_KINDS[m[p]] || 'kind_' + m[p];
                rec.code = m[p + 1];
                rec.arg = u16(m, p + 2);
                if (rec.stateKind === 2)
                    rec.codeName = ARENA_STATES[rec.code] || 'state_' + rec.code;
                if (rec.stateKind === 8) {
                    rec.ipsr = rec.arg & 0x1ff;
                    rec.priorIsr = rec.arg >> 9;
                    rec.priorIsrName = ISR_NAMES[rec.priorIsr] || 'isr_' + rec.priorIsr;
                    rec.preempted = rec.ipsr === 0 ? 'thread' : 'handler_' + rec.ipsr;
                }
                if (rec.stateKind === 9) {
                    rec.isrName = ISR_NAMES[rec.code] || 'isr_' + rec.code;
                    rec.countApprox = rec.arg * 4096;
                }
            } else {
                rec.kind = 'unknown';
                rec.raw = hex(m.subarray(p, p + plen));
                block.malformed++;
            }
            block.records.push(rec);
            o += len;
        }
        return block;
    }

    /** Compact log rows for a parsed block (proposal § 3.3). `rx` = receive epoch ms. */
    function toRows(block, rx) {
        const rows = [];
        for (const r of block.records) {
            if (r.kind === 'cmd') rows.push(['cc', rx, r.tUs, r.seq, r.cmd, r.status, r.req]);
            else if (r.kind === 'frame')
                rows.push(['cf', rx, r.tUs, r.seq, r.idx, r.pattern, r.sdLoadUs, r.spiUs]);
            else if (r.kind === 'state')
                rows.push(['cs', rx, r.tUs, r.seq, r.stateKind, r.code, r.arg]);
        }
        return rows;
    }

    /** The `streams` schema line the bridge log carries once per logging session. */
    const STREAM_SCHEMA = {
        cc: {
            cols: ['rx', 't_us', 'seq', 'cmd', 'status', 'req'],
            desc: 'controller-side command record'
        },
        cf: {
            cols: ['rx', 't_us', 'seq', 'idx', 'pattern', 'sd_load_us', 'spi_us'],
            desc: 'displayed frame change'
        },
        cs: {
            cols: ['rx', 't_us', 'seq', 'kind', 'code', 'arg'],
            desc: 'state/error/boot event',
            kinds: STATE_KINDS
        }
    };

    /**
     * Ack-cursor drainer. `session.send(bytes, {timeoutMs})` returns the reply
     * frame. State: `ackSeq` = last seq stored by the host (sent as the ack on
     * the next request), stats for the UI/log.
     * @param {object} d {session, wire, timeoutMs=1500, maxBytes=180, maxChunks=40, now,
     *        onRecords(block, rows, rx) → return false to REFUSE the rows (not stored):
     *        the drainer then withholds its ack so the controller keeps them.}
     */
    function createDrainer(d) {
        const session = d.session;
        const W = d.wire || (typeof global !== 'undefined' ? global.ArenaWireG6 : null);
        const timeoutMs = d.timeoutMs || 1500;
        const maxBytes = d.maxBytes || 180;
        // 40 chunks × ~180 B ≈ 7 KB per poll: under Chrome's background-tab timer
        // throttling a poll may run only once per second, and production during
        // Mode-3 streaming at 286 Hz is ~5–6 KB/s — the budget must exceed that.
        const maxChunks = d.maxChunks || 40;
        const now = d.now || (() => Date.now());
        const onRecords = d.onRecords || (() => {});
        const st = {
            ackSeq: NO_ACK, // nothing acked yet
            lastSeq: null, // highest seq seen
            records: 0,
            blocks: 0,
            bytes: 0,
            gaps: 0, // seq discontinuities seen (should equal controller-reported drops)
            dropped: 0, // controller's cumulative drop counter (last value)
            errors: 0,
            notStored: 0, // rows the sink refused (ack withheld, will be re-read)
            duplicates: 0, // records re-delivered after a rearm (already stored, dropped)
            incarnations: 0, // ring re-initialisations seen (power cycles)
            lastTNowUs: null,
            bootCount: null,
            survivedReboot: false,
            lastError: null
        };
        let busy = false;
        let peekNext = false; // next request goes out with NO_ACK (see rearm)
        const idleWaiters = [];

        /**
         * One poll: ask with the current ack, parse, ack what we got. Follows
         * `more` up to maxChunks. Resolves the array of parsed blocks.
         */
        async function drainOnce(opts) {
            if (busy) return [];
            busy = true;
            const blocks = [];
            try {
                for (let i = 0; i < maxChunks; i++) {
                    const ack = st.lastSeq == null || peekNext ? NO_ACK : st.lastSeq;
                    let resp;
                    try {
                        resp = await session.send(W.encodeGetTelemetryBlock(ack, maxBytes), {
                            timeoutMs,
                            silent: true // the reply IS the log; don't echo 20 requests/s into it
                        });
                    } catch (e) {
                        st.errors++;
                        st.lastError = (e && e.message) || String(e);
                        break;
                    }
                    const block = parseBlock(resp, W);
                    if (!block) {
                        st.errors++;
                        st.lastError = 'unparseable telemetry block';
                        break;
                    }
                    const rx = now();
                    // Ring incarnation check (review finding: an old ack after a power
                    // cycle would free unseen records). A different boot_count with the
                    // ring NOT marked survived ⇒ fresh ring: forget the cursor. Same
                    // incarnation after a rearm ⇒ drop records we already stored.
                    if (peekNext) {
                        peekNext = false;
                        if (st.bootCount != null && block.bootCount !== st.bootCount) {
                            if (!block.survivedReboot) st.lastSeq = null;
                            st.incarnations++;
                        }
                        if (st.lastSeq != null) {
                            const before = block.records.length;
                            block.records = block.records.filter((r) =>
                                seqAfter(r.seq, st.lastSeq)
                            );
                            st.duplicates += before - block.records.length;
                        }
                    }
                    st.blocks++;
                    st.bytes += block.bytes;
                    st.lastTNowUs = block.tNowUs;
                    st.dropped = block.dropped;
                    st.bootCount = block.bootCount;
                    st.survivedReboot = block.survivedReboot;
                    st.heapCollision = block.disabledHeapCollision;
                    if (block.records.length) {
                        // ACK MEANS STORED (review finding): hand the rows to the sink
                        // first; only when it accepted them does the cursor advance.
                        // A refused block is re-requested with the old ack next poll.
                        const accepted = onRecords(block, toRows(block, rx), rx) !== false;
                        if (!accepted) {
                            st.notStored++;
                            blocks.push(block);
                            break;
                        }
                        for (const r of block.records) {
                            if (st.lastSeq != null && r.seq !== (st.lastSeq + 1) >>> 0) st.gaps++;
                            st.lastSeq = r.seq;
                            st.records++;
                        }
                        st.ackSeq = st.lastSeq;
                    }
                    blocks.push(block);
                    if (!block.more || (opts && opts.single)) break;
                }
            } finally {
                busy = false;
                idleWaiters.splice(0).forEach((r) => r());
            }
            return blocks;
        }

        /** Drain until the controller reports nothing more (post-reboot crash dump). */
        async function drainAll(limitChunks) {
            const all = [];
            for (let i = 0; i < (limitChunks || 400); i++) {
                const refusedBefore = st.notStored;
                const blocks = await drainOnce({ single: true });
                if (!blocks.length) break;
                if (st.notStored > refusedBefore) break; // sink refused: don't spin on the same block
                all.push(blocks[0]);
                if (!blocks[0].more && !blocks[0].records.length) break;
                if (!blocks[0].more) break;
            }
            return all;
        }

        /** Forget the cursor entirely (test/reset helper). */
        function reset() {
            st.ackSeq = NO_ACK;
            st.lastSeq = null;
            peekNext = false;
        }

        /**
         * Re-arm after a (re)connection or a controller reboot: the NEXT request
         * carries NO_ACK, so nothing is freed until we have seen which ring
         * incarnation answers. Same incarnation ⇒ already-stored records are
         * dropped as duplicates and the cursor continues; fresh ring ⇒ cursor reset.
         */
        function rearm() {
            peekNext = true;
        }

        /** Resolves once no drain is in flight (post-mortem: own the link, THEN go quiet). */
        function idle() {
            return busy ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve();
        }

        return { drainOnce, drainAll, reset, rearm, idle, stats: st };
    }

    /**
     * Single-flight periodic poller (the Analog In poller's shape): `canPoll()`
     * gates each tick; `drainer.drainOnce()` does the work.
     */
    function createPoller(a) {
        const drainer = a.drainer;
        const canPoll = a.canPoll || (() => ({ ok: true }));
        const onState = a.onState || (() => {});
        let timer = null;
        let state = 'stopped';
        let reason = '';
        let ticks = 0;
        let skipped = 0;
        let running = false;
        function setState(s, r) {
            if (s === state && (r || '') === reason) return;
            state = s;
            reason = r || '';
            onState(state, reason);
        }
        async function tick() {
            ticks++;
            const g = canPoll();
            if (!(g && g.ok)) {
                setState('paused', (g && g.reason) || 'paused');
                return false;
            }
            if (running) {
                skipped++;
                return false;
            }
            running = true;
            try {
                await drainer.drainOnce();
                setState(
                    drainer.stats.lastError && drainer.stats.errors ? 'polling' : 'polling',
                    ''
                );
                return true;
            } finally {
                running = false;
            }
        }
        return {
            tick,
            start(ms, setIntervalImpl, clearIntervalImpl) {
                this.stop();
                const si =
                    setIntervalImpl || (typeof setInterval === 'function' ? setInterval : null);
                const ci =
                    clearIntervalImpl ||
                    (typeof clearInterval === 'function' ? clearInterval : null);
                // Plain calls only: window.clearInterval invoked as a METHOD of this
                // poller object throws "Illegal invocation" in browsers (found on the
                // bench 2026-09-12 — it would have aborted the fault post-mortem).
                this._clear = ci ? (h) => ci(h) : null;
                if (!si) throw new Error('telemetry poller: no setInterval available');
                timer = si(() => {
                    tick();
                }, ms || 100);
                setState('polling', '');
            },
            stop() {
                if (timer && this._clear) this._clear(timer);
                timer = null;
                setState('stopped', '');
            },
            get state() {
                return state;
            },
            get reason() {
                return reason;
            },
            get counts() {
                return { ticks, skipped };
            }
        };
    }

    const ArenaTelemetry = {
        HEADER_BYTES,
        REC,
        STATE_KINDS,
        ARENA_STATES,
        NO_ACK,
        STREAM_SCHEMA,
        parseBlock,
        toRows,
        createDrainer,
        createPoller
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = ArenaTelemetry;
    if (typeof global !== 'undefined') global.ArenaTelemetry = ArenaTelemetry;
})(typeof window !== 'undefined' ? window : this);
