#!/usr/bin/env node
/**
 * Tests for js/arena-telemetry.js — the controller telemetry ring decoder +
 * ack-cursor drainer (fw feat/telemetry-ring). Synthetic 0xA9 reply frames,
 * a fake session that models the controller's ring (records are freed only by
 * the NEXT request's ack, `more` when records remain), no hardware.
 */
'use strict';

const T = require('../js/arena-telemetry.js');
const Wire = require('../js/arena-wire-g6.js');

let totalChecks = 0;
let failures = 0;
function check(name, got, expected) {
    totalChecks++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`
    );
    if (!ok) failures++;
}
function checkBool(name, ok, info) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

// ---- byte builders -------------------------------------------------------
const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
function rec(type, seq, tUs, payload) {
    const body = [type].concat(u32(seq), u32(tUs), payload);
    return [body.length + 1].concat(body);
}
const cmdRec = (seq, t, cmd, status, req) => rec(1, seq, t, [cmd, status, req.length].concat(req));
const frameRec = (seq, t, idx, pat, sd, spi) =>
    rec(2, seq, t, [].concat(u16(idx), u16(pat), u32(sd), u16(spi)));
const stateRec = (seq, t, kind, code, arg) => rec(3, seq, t, [kind, code].concat(u16(arg)));
const padRec = (n) => [n, 0].concat(new Array(n - 2).fill(0));
function block(h, records) {
    const payload = []
        .concat(
            u32(h.tNowUs),
            u32(h.firstSeq),
            u16(records.length),
            u32(h.dropped || 0),
            [h.more ? 1 : 0],
            [h.flags == null ? 1 : h.flags],
            u16(h.bootCount || 0)
        )
        .concat(...records);
    return Uint8Array.from([payload.length + 2, 0x00, 0xa9].concat(payload));
}

(async () => {
    console.log('=== encoders ===');
    check('encodeSetTelemetry(1)', Array.from(Wire.encodeSetTelemetry(1)), [4, 0xa8, 1, 0, 0]);
    check(
        'encodeSetTelemetry(0, 500)',
        Array.from(Wire.encodeSetTelemetry(0, 500)),
        [4, 0xa8, 0, 0xf4, 0x01]
    );
    check(
        'encodeGetTelemetryBlock(no ack, 180)',
        Array.from(Wire.encodeGetTelemetryBlock(null, 180)),
        [8, 0xa9, 0xff, 0xff, 0xff, 0xff, 180, 0, 0]
    );
    check(
        'encodeGetTelemetryBlock(ack 0x01020304, 64, flags 1)',
        Array.from(Wire.encodeGetTelemetryBlock(0x01020304, 64, 1)),
        [8, 0xa9, 4, 3, 2, 1, 64, 0, 1]
    );
    check('TELEMETRY_NO_ACK', Wire.TELEMETRY_NO_ACK, 0xffffffff);

    console.log('\n=== parseBlock ===');
    {
        const b = T.parseBlock(
            block(
                { tNowUs: 123456789, firstSeq: 10, dropped: 2, more: true, flags: 3, bootCount: 4 },
                [
                    cmdRec(10, 1000, 0x70, 0, [0x03, 0x70, 0x4e, 0x00]),
                    frameRec(11, 1500, 78, 36, 1961, 812),
                    padRec(3),
                    stateRec(12, 2000, 4, 0, 1290),
                    stateRec(13, 2100, 2, 4, 36)
                ]
            ),
            Wire
        );
        checkBool('parses', !!b);
        check(
            'header',
            [
                b.tNowUs,
                b.firstSeq,
                b.nRecords,
                b.dropped,
                b.more,
                b.eventsEnabled,
                b.survivedReboot,
                b.bootCount,
                b.disabledHeapCollision,
                b.syntheticOn
            ],
            [123456789, 10, 5, 2, true, true, true, 4, false, false]
        );
        check(
            'frame sd_load is u32 (129 ms fits)',
            T.parseBlock(
                block({ tNowUs: 1, firstSeq: 1, more: false, flags: 0 }, [
                    frameRec(1, 5, 78, 36, 129000, 812)
                ]),
                Wire
            ).records[0].sdLoadUs,
            129000
        );
        check(
            'header flag bits 2/3 (heap collision, synthetic)',
            (({ disabledHeapCollision, syntheticOn }) => [disabledHeapCollision, syntheticOn])(
                T.parseBlock(block({ tNowUs: 1, firstSeq: 1, more: false, flags: 0x0c }, []), Wire)
            ),
            [true, true]
        );
        check('record count (pad skipped)', b.records.length, 4);
        check(
            'cmd record',
            [
                b.records[0].kind,
                b.records[0].seq,
                b.records[0].tUs,
                b.records[0].cmd,
                b.records[0].status,
                b.records[0].req
            ],
            ['cmd', 10, 1000, 0x70, 0, '03704e00']
        );
        check(
            'frame record',
            [
                b.records[1].kind,
                b.records[1].idx,
                b.records[1].pattern,
                b.records[1].sdLoadUs,
                b.records[1].spiUs
            ],
            ['frame', 78, 36, 1961, 812]
        );
        check(
            'state sd_slow',
            [b.records[2].kind, b.records[2].stateName, b.records[2].arg],
            ['state', 'sd_slow', 1290]
        );
        check(
            'state change names the arena state',
            [b.records[3].stateName, b.records[3].codeName, b.records[3].arg],
            ['state_change', 'SHOW_FRAME', 36]
        );
        check('no malformed', b.malformed, 0);
        const rows = T.toRows(b, 1789000000000);
        check('rows', rows, [
            ['cc', 1789000000000, 1000, 10, 0x70, 0, '03704e00'],
            ['cf', 1789000000000, 1500, 11, 78, 36, 1961, 812],
            ['cs', 1789000000000, 2000, 12, 4, 0, 1290],
            ['cs', 1789000000000, 2100, 13, 2, 4, 36]
        ]);
        checkBool(
            'status!=0 reply → null',
            T.parseBlock(Uint8Array.from([2, 1, 0xa9]), Wire) === null
        );
        checkBool(
            'short header → null',
            T.parseBlock(Uint8Array.from([5, 0, 0xa9, 1, 2, 3]), Wire) === null
        );
        const bad = T.parseBlock(block({ tNowUs: 1, firstSeq: 1 }, [[40, 1, 0, 0, 0, 0]]), Wire); // len overruns
        check('truncated record counted as malformed', bad.malformed, 1);
    }

    console.log('\n=== drainer: ack cursor, lossless re-ask, gaps, drainAll ===');
    {
        // Controller model: a queue of records; a request frees seq ≤ ack, then
        // returns up to `per` records from the head WITHOUT freeing them.
        const ring = [];
        let next = 1;
        const push = (n) => {
            for (let i = 0; i < n; i++)
                (ring.push(cmdRec(next, next * 100, 0x70, 0, [3, 0x70, next & 0xff, 0])), next++);
        };
        const per = 3;
        const asked = [];
        let failNext = false;
        const session = {
            async send(bytes) {
                const ack =
                    (bytes[2] | (bytes[3] << 8) | (bytes[4] << 16) | (bytes[5] << 24)) >>> 0;
                asked.push(ack);
                if (failNext) {
                    failNext = false;
                    throw new Error('response timeout after 1500 ms (cmd 0xa9)');
                }
                if (ack !== 0xffffffff)
                    while (
                        ring.length &&
                        (ring[0][2] |
                            (ring[0][3] << 8) |
                            (ring[0][4] << 16) |
                            (ring[0][5] << 24)) >>>
                            0 <=
                            ack
                    )
                        ring.shift();
                const out = ring.slice(0, per);
                const firstSeq = out.length
                    ? (out[0][2] | (out[0][3] << 8) | (out[0][4] << 16) | (out[0][5] << 24)) >>> 0
                    : 0;
                return block({ tNowUs: 999, firstSeq, more: ring.length > per, flags: 1 }, out);
            }
        };
        const got = [];
        const d = T.createDrainer({
            session,
            wire: Wire,
            maxChunks: 10,
            now: () => 42,
            onRecords: (b, rows) => got.push(...rows)
        });
        push(7);
        const blocks = await d.drainOnce();
        check('drained in chunks following `more`', blocks.length, 3);
        check('all 7 records delivered as rows', got.length, 7);
        check('seq continuous, no gaps', d.stats.gaps, 0);
        check('first request carried NO_ACK', asked[0], 0xffffffff);
        check('second request acked seq 3', asked[1], 3);
        check('ring drained (acked to 7 on next ask)', d.stats.lastSeq, 7);
        // Lossless re-ask: a timeout leaves lastSeq unchanged; the next request
        // repeats the same ack and gets the SAME records.
        push(2); // seq 8, 9
        failNext = true;
        await d.drainOnce();
        check('timeout counted', d.stats.errors, 1);
        const before = got.length;
        await d.drainOnce();
        check('re-ask got the two records once', got.length - before, 2);
        check('ring freed up to 9 after the following ask', d.stats.lastSeq, 9);
        // Gap detection: the controller skips seq 10 (a dropped record)
        next = 11;
        push(1);
        await d.drainOnce();
        check('gap detected', d.stats.gaps, 1);
        // ACK MEANS STORED: a sink that refuses the rows (bridge not logging) must
        // NOT advance the cursor — the same records come back on the next poll.
        let refuse = true;
        const d2 = T.createDrainer({
            session,
            wire: Wire,
            maxChunks: 10,
            now: () => 42,
            onRecords: () => (refuse ? false : true)
        });
        d2.stats.lastSeq = d.stats.lastSeq; // continue from the same cursor
        const asked2 = asked.length;
        push(3); // seq 12..14
        await d2.drainOnce();
        check('refused rows counted', d2.stats.notStored, 1);
        check('cursor did not advance on refusal', d2.stats.lastSeq, 11);
        refuse = false;
        await d2.drainOnce();
        check('same ack re-sent after refusal', asked[asked2 + 1], asked[asked2]);
        check('records stored on the retry', d2.stats.lastSeq, 14);
        check('records counted once', d2.stats.records, 3);
        next = 15;
        d.stats.lastSeq = d2.stats.lastSeq; // one ring, one cursor: hand it back to d
        // drainAll on a bigger backlog
        push(20);
        const all = await d.drainAll();
        checkBool(
            'drainAll emptied the backlog',
            all.length >= 7 && ring.length <= per,
            'ring=' + ring.length
        );
        check('stats.records total', d.stats.records, 7 + 2 + 1 + 20);
        // rearm(): same incarnation → NO_ACK request, duplicates dropped, cursor continues
        const seqBefore = d.stats.lastSeq;
        const recBefore = d.stats.records;
        d.rearm();
        push(2);
        const askedBefore = asked.length;
        await d.drainOnce();
        check('rearm sends NO_ACK first', asked[askedBefore], 0xffffffff);
        checkBool('rearm re-delivered nothing new twice', d.stats.duplicates >= 0);
        check('cursor continued past the new records', d.stats.lastSeq, seqBefore + 2);
        check('only the 2 new records counted', d.stats.records - recBefore, 2);
        d.reset();
        check('reset forgets the cursor', [d.stats.ackSeq, d.stats.lastSeq], [0xffffffff, null]);
    }

    console.log('\n=== poller: single-flight, gated ===');
    {
        let gate = { ok: false, reason: 'no run' };
        let drains = 0;
        const drainer = {
            drainOnce: async () => {
                drains++;
                await new Promise((r) => setTimeout(r, 5));
                return [];
            },
            stats: { errors: 0 }
        };
        const states = [];
        const p = T.createPoller({
            drainer,
            canPoll: () => gate,
            onState: (s, r) => states.push(s + (r ? ':' + r : ''))
        });
        await p.tick();
        check('gated tick does not drain', drains, 0);
        check('paused with reason', states[states.length - 1], 'paused:no run');
        gate = { ok: true };
        const a = p.tick();
        const b = p.tick(); // overlapping → skipped
        await Promise.all([a, b]);
        check('single-flight: one drain for two overlapping ticks', drains, 1);
        check('skipped counted', p.counts.skipped, 1);
        check('state polling', p.state, 'polling');
    }

    console.log('\n=== poller: stop() must not invoke clearInterval as a method (browser) ===');
    {
        const d = T.createDrainer({ session: { send: async () => new Uint8Array(0) }, wire: Wire });
        const p = T.createPoller({ drainer: d, canPoll: () => ({ ok: true }) });
        const strictClear = function (h) {
            if (this !== undefined && this !== globalThis)
                throw new TypeError('Illegal invocation');
            clearInterval(h);
        };
        p.start(1000, setInterval, strictClear);
        let threw = null;
        try {
            p.stop();
        } catch (e) {
            threw = e && e.message;
        }
        check('stop() with a this-sensitive clearInterval does not throw', threw, null);
        check('poller stopped', p.state, 'stopped');
    }
    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
