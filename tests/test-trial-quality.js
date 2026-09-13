#!/usr/bin/env node
/**
 * Tests for js/trial-quality.js — per-trial pass/fail/unknown from ring records.
 * Run: node tests/test-trial-quality.js
 */
'use strict';

const TQ = require('../js/trial-quality.js');

let total = 0;
let failures = 0;
function check(name, got, expected) {
    total++;
    const g = JSON.stringify(got);
    const e = JSON.stringify(expected);
    const ok = g === e;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${g}, expected ${e}`}`);
    if (!ok) failures++;
}

// record builders (the shapes js/arena-telemetry.js parseBlock() produces)
let seq = 100;
const S = (stateKind, code, arg, tUs, extra) =>
    Object.assign({ kind: 'state', stateKind, code, arg, seq: seq++, tUs }, extra || {});
const F = (idx, tUs, reqAgeUs, superseded) =>
    Object.assign(
        { kind: 'frame', idx, pattern: 36, sdLoadUs: 1200, spiUs: 770, seq: seq++, tUs },
        reqAgeUs == null ? {} : { reqAgeUs, superseded: superseded || 0, flags: 3 }
    );
const C70 = (idx, tUs, status) => ({
    kind: 'cmd',
    cmd: 0x70,
    status: status || 0,
    req:
        '0370' +
        (idx & 0xff).toString(16).padStart(2, '0') +
        (idx >> 8).toString(16).padStart(2, '0'),
    seq: seq++,
    tUs
});

console.log('=== idxFromReq ===');
check('index from req hex', TQ.idxFromReq('03704e00'), 78);
check('hi byte', TQ.idxFromReq('03700101'), 257);
check('short → null', TQ.idxFromReq('2d'), null);
check('firmware form (bytes after len,cmd)', TQ.idxFromReq('2d00'), 45);

console.log(
    '\n=== three trials: pass / fail (stall) / fail (frame age), reads + cmd accounting ==='
);
{
    const gaps = [];
    const closed = [];
    const q = TQ.createTrialQuality({
        onGap: (g) => gaps.push(g),
        onTrial: (t) => closed.push(t.index)
    });
    // trial 1: pattern 36, clean
    q.feed([S(7, 0, 36, 1000), S(11, 1, 8, 1001)]);
    q.feed([C70(1, 2000), F(1, 4000, 2000), C70(1, 6000), C70(2, 8000), F(2, 10000, 2500)]);
    q.feed([S(4, 2, 80, 12000, { readUs: 8000, phase: 'body' })]); // 8 ms: slow by fw threshold, under 10 ms
    q.feed([S(13, 0, 2, 13000, { reads: 2 })]); // reads while pattern 36 was open
    // trial 2: pattern 5, one 41 ms stall
    q.feed([
        S(7, 0, 5, 20000),
        C70(3, 21000),
        S(4, 2, 412, 30000, { readUs: 41200, phase: 'body' }),
        F(3, 31000, 43000, 1)
    ]);
    q.feed([S(13, 0, 1, 40000, { reads: 1 })]);
    // trial 3: pattern 36, a FRAME whose request is 12 ms old (no sd_slow record — e.g. loop stall)
    q.feed([S(7, 0, 36, 50000), C70(9, 51000), F(9, 63000, 12000, 0)]);
    const s = q.finish();
    check('closed order', closed, [1, 2, 3]);
    check(
        'statuses',
        s.trials.map((t) => t.status),
        ['pass', 'fail', 'fail']
    );
    check(
        'trial 1 accounting',
        [
            s.trials[0].cmds70,
            s.trials[0].index_changes,
            s.trials[0].reads,
            s.trials[0].frames,
            s.trials[0].slow_reads,
            s.trials[0].stalls
        ],
        [3, 2, 2, 2, 1, 0]
    );
    check('trial 1 max read 8 ms (recorded, not a fail)', s.trials[0].max_read_ms, 8);
    check(
        'trial 2 stall + frame age both flagged',
        [
            s.trials[1].stalls,
            s.trials[1].age_gaps,
            s.trials[1].max_read_ms,
            s.trials[1].max_age_ms,
            s.trials[1].superseded
        ],
        [1, 1, 41.2, 43, 1]
    );
    check(
        'trial 3 frame age gap only',
        [s.trials[2].stalls, s.trials[2].age_gaps, s.trials[2].max_age_ms],
        [0, 1, 12]
    );
    check('counts', s.counts, { pass: 1, fail: 2, unknown: 0, open: 0 });
    check('flagged trials', s.flagged_trials, [2, 3]);
    check('worst gap us', s.worst_gap_us, 43000);
    check(
        'gap events',
        gaps.map((g) => [g.event, g.trial, g.kind, g.ms, g.phase || g.idx]),
        [
            ['display_gap', 2, 'sd_slow', 41.2, 'body'],
            ['display_gap', 2, 'frame_age', 43, 3],
            ['display_gap', 3, 'frame_age', 12, 9]
        ]
    );
}

console.log('\n=== coverage → unknown, never pass; duplicates dropped; boot resets seq ===');
{
    seq = 500;
    const q = TQ.createTrialQuality();
    q.feed([S(7, 0, 36, 1000), C70(1, 2000)]);
    const dup = C70(2, 3000);
    q.feed([dup, dup]); // re-delivered record
    check('duplicate dropped', q.current.cmds70, 2);
    seq = 600; // a seq gap: records evicted before the drain
    q.feed([C70(3, 4000)]);
    q.noteCoverage('poller_paused', 'bridge not logging');
    q.feed([S(7, 0, 5, 9000)]); // closes trial 1
    // trial 2: clean, then a controller reboot (seq restarts)
    q.feed([C70(1, 9500)]);
    seq = 1; // fresh ring after a watchdog reset
    q.feed([S(1, 0x80, 0, 100)]);
    const s = q.finish();
    check(
        'trial 1 unknown with reasons',
        [s.trials[0].status, s.trials[0].coverage],
        ['unknown', ['seq_gap', 'poller_paused']]
    );
    check(
        'trial 2 unknown after reboot',
        [s.trials[1].status, s.trials[1].coverage],
        ['unknown', ['controller_reboot']]
    );
    check('duplicates counted', s.duplicates_dropped, 1);
    check('unknown trials listed', s.unknown_trials, [1, 2]);
}

console.log(
    '\n=== v1 firmware records (no req_age, code 0 sd_slow) still classify by read time ==='
);
{
    seq = 900;
    const q = TQ.createTrialQuality();
    q.feed([S(7, 0, 36, 1000), F(1, 2000), S(4, 0, 330, 3000), F(2, 4000)]); // arg 330 → 33 ms, phase unknown
    const s = q.finish();
    check(
        'v1 stall flagged',
        [s.trials[0].status, s.trials[0].stalls, s.trials[0].max_read_ms, s.trials[0].max_age_ms],
        ['fail', 1, 33, 0]
    );
}

console.log('\n=== reset() clears everything ===');
{
    const q = TQ.createTrialQuality();
    q.feed([S(7, 0, 36, 1000)]);
    q.reset();
    check('empty after reset', q.summary().trials.length, 0);
    check('threshold default', q.thresholdUs, 10000);
}

console.log(`\n${total - failures} / ${total} checks passed`);
process.exit(failures ? 1 : 0);
