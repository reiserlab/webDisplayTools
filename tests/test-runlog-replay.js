#!/usr/bin/env node
/**
 * Tests for js/runlog-replay.js — the run-log → replay-timeline adapter/parser
 * used to stream a recorded run back through the live scope AND by the offline
 * analysis dashboard. Fixture-based (no browser). Run: node tests/test-runlog-replay.js
 */
'use strict';

const R = require('../js/runlog-replay.js');

let total = 0;
let failures = 0;
function check(name, got, expected) {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`}`
    );
    if (!ok) failures++;
}
function approx(name, got, expected, tol) {
    total++;
    const ok = got != null && Math.abs(got - expected) <= (tol == null ? 1e-9 : tol);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}, expected ${expected}`);
    if (!ok) failures++;
}
function checkBool(name, ok, info) {
    total++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + (info || '')}`);
    if (!ok) failures++;
}

// ── adaptRunnerEvent: sanitized log shape → live run-status shape ─────────────
console.log('=== adaptRunnerEvent ===');
// step-start: `condition` (flattened by _sanitizeRunStatus) → step.conditionName
check(
    'step-start condition → step.conditionName',
    R.adaptRunnerEvent({
        event: 'runner',
        phase: 'step-start',
        index: 0,
        total: 28,
        condition: 'sq_fwd_05'
    }),
    {
        phase: 'step-start',
        index: 0,
        total: 28,
        condition: 'sq_fwd_05',
        step: { conditionName: 'sq_fwd_05' }
    }
);
// v0.5 trial-running → current command/trialParams (drives the green visual span)
check(
    'v0.5 trial-running → command/trialParams',
    R.adaptRunnerEvent({
        event: 'runner',
        phase: 'trial-running',
        index: 0,
        durationSec: 10,
        condition: 'sq_fwd_05'
    }),
    {
        phase: 'command',
        index: 0,
        durationSec: 10,
        op: 'trialParams',
        value: 10,
        condition: 'sq_fwd_05',
        step: { conditionName: 'sq_fwd_05' }
    }
);
// current command with op/value passes through, condition → step
check(
    'command/setAnalogOut passthrough',
    R.adaptRunnerEvent({
        event: 'runner',
        phase: 'command',
        index: 3,
        op: 'setAnalogOut',
        value: 2500,
        condition: 'led_on'
    }),
    {
        phase: 'command',
        index: 3,
        op: 'setAnalogOut',
        value: 2500,
        condition: 'led_on',
        step: { conditionName: 'led_on' }
    }
);
// fictracApply keeps op/value (scope ignores it, but the shape must survive)
check(
    'command/fictracApply passthrough',
    R.adaptRunnerEvent({
        event: 'runner',
        phase: 'command',
        index: 24,
        op: 'fictracApply',
        value: true,
        condition: 'cl_rot'
    }),
    {
        phase: 'command',
        index: 24,
        op: 'fictracApply',
        value: true,
        condition: 'cl_rot',
        step: { conditionName: 'cl_rot' }
    }
);
check('sequence-start minimal', R.adaptRunnerEvent({ phase: 'sequence-start', total: 28 }), {
    phase: 'sequence-start',
    total: 28
});
// top-level conditionName (non-step events) also maps to step.conditionName
check(
    'top-level conditionName → step',
    R.adaptRunnerEvent({ phase: 'running', conditionName: 'sq_fwd_05' }),
    {
        phase: 'running',
        conditionName: 'sq_fwd_05',
        condition: 'sq_fwd_05',
        step: { conditionName: 'sq_fwd_05' }
    }
);
const richTrial = R.adaptRunnerEvent({
    event: 'runner',
    phase: 'trial-running',
    index: 2,
    condition: 'closed_loop_led',
    durationSec: 30,
    params: { mode: 3, patternId: 7, frameRate: 0 },
    ledActivation: { level: 20, hysteresis: 3, on_ranges: [[50, 99]] }
});
check('rich trial preserves params', richTrial.params, {
    mode: 3,
    patternId: 7,
    frameRate: 0
});
check('rich trial preserves durationSec', richTrial.durationSec, 30);
check('rich trial preserves ledActivation', richTrial.ledActivation, {
    level: 20,
    hysteresis: 3,
    on_ranges: [[50, 99]]
});
check('rich trial preserves condition', richTrial.condition, 'closed_loop_led');
check(
    'LED transition fields survive',
    R.adaptRunnerEvent({
        phase: 'led-activation',
        index: 73,
        condition: 'closed_loop_led',
        on: true,
        ledPercent: 20
    }),
    {
        phase: 'led-activation',
        index: 73,
        on: true,
        ledPercent: 20,
        condition: 'closed_loop_led',
        step: { conditionName: 'closed_loop_led' }
    }
);
checkBool('no phase → null', R.adaptRunnerEvent({ event: 'runner' }) === null);
checkBool('garbage → null', R.adaptRunnerEvent(null) === null);

// ── parseRunLog: FULL log (25-col fictrac; col-22 ns → ft ms) ─────────────────
console.log('=== parseRunLog: full log (ns col-22 → ms ft) ===');
// two frames 8_271_561 ns apart (= 8.271561 ms, ~120.9 Hz), heading advancing.
function fr(t, seq, index, fields) {
    return JSON.stringify({ type: 'fictrac_frame', seq: seq, index: index, t: t, fictrac: fields });
}
// build a 25-col record with the columns runlog-replay reads set explicitly.
function cols({ fc, x, y, hd, ts }) {
    const a = new Array(25).fill(0);
    a[0] = fc;
    a[14] = x;
    a[15] = y;
    a[16] = hd;
    a[21] = ts;
    return a;
}
const NS = 8271561; // ~8.27 ms in ns
const fullLog = [
    JSON.stringify({ type: 'session', event: 'logging_started', ms: 1000 }),
    JSON.stringify({
        type: 'log',
        event: 'runner',
        phase: 'sequence-start',
        total: 2,
        rx_ms: 1000
    }),
    JSON.stringify({
        type: 'log',
        event: 'runner',
        phase: 'step-start',
        index: 0,
        condition: 'condA',
        rx_ms: 1000
    }),
    fr(1000, 100, 5, cols({ fc: 100, x: 0.0, y: 0.0, hd: 0.0, ts: 20000000000000 })),
    fr(1008, 101, 5, cols({ fc: 101, x: 0.01, y: 0.0, hd: 0.02, ts: 20000000000000 + NS })),
    fr(1016, 102, 5, cols({ fc: 102, x: 0.02, y: 0.0, hd: 0.04, ts: 20000000000000 + 2 * NS })),
    JSON.stringify({
        type: 'log',
        event: 'runner',
        phase: 'trial-running',
        index: 0,
        durationSec: 3,
        condition: 'condA',
        rx_ms: 1016
    })
].join('\n');

const p = R.parseRunLog(fullLog);
check('format detected full', p.format, 'full');
check('3 samples parsed', p.samples.length, 3);
check('first sample ms = 0 (rebased)', p.samples[0].ms, 0);
check('third sample ms = 16 (wall-relative)', p.samples[2].ms, 16);
approx('first ft = 0', p.samples[0].ft, 0, 1e-9);
approx('second ft ≈ 8.271561 ms (ns→ms)', p.samples[1].ft, 8.271561, 1e-6);
approx('third ft ≈ 16.543122 ms', p.samples[2].ft, 16.543122, 1e-6);
check(
    'sample x/y/hd from cols 15/16/17',
    [p.samples[1].x, p.samples[1].y, p.samples[1].hd],
    [0.01, 0, 0.02]
);
check('sample fc from col 1', p.samples[1].fc, 101);
check('sample idx from frame index', p.samples[1].idx, 5);
const noWall = R.parseRunLog(
    [
        JSON.stringify({
            type: 'fictrac_frame',
            seq: 1,
            index: 0,
            fictrac: cols({ fc: 1, x: 0, y: 0, hd: 0, ts: 1000000 })
        }),
        JSON.stringify({
            type: 'fictrac_frame',
            seq: 2,
            index: 1,
            fictrac: cols({ fc: 2, x: 0, y: 0, hd: 0, ts: 9000000 })
        })
    ].join('\n')
);
check(
    'full frames without wall clock retain 8 ms fallback',
    noWall.samples.map((s) => s.ms),
    [0, 8]
);
// events: sequence-start, step-start, trial-running(→command)
check('3 runner events', p.events.length, 3);
check('event[0] sequence-start', p.events[0].status.phase, 'sequence-start');
check('event[1] step-start condA', p.events[1].status.step.conditionName, 'condA');
check(
    'event[2] trial-running normalized to command/trialParams',
    [p.events[2].status.phase, p.events[2].status.op, p.events[2].status.value],
    ['command', 'trialParams', 3]
);

// ── parseRunLog: behavior_v1 log (positional rows already in ms) ──────────────
console.log('=== parseRunLog: behavior_v1 log ===');
const behLog = [
    JSON.stringify({
        type: 'frame_schema',
        level: 'behavior_v1',
        cols: ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd']
    }),
    JSON.stringify([0, 100, 5, 0.0, 0.0, 0.0, 0.0]),
    JSON.stringify([8, 101, 5, 8.272, 0.01, 0.0, 0.02])
].join('\n');
const pb = R.parseRunLog(behLog);
check('format detected behavior_v1', pb.format, 'behavior_v1');
check('behavior_v1 2 samples', pb.samples.length, 2);
approx('behavior_v1 ft passthrough (already ms)', pb.samples[1].ft, 8.272, 1e-9);
// Controller telemetry rows ("cc"/"cf"/"cs", js/arena-telemetry.js) share the file
// with behavior rows — they are other streams, never samples (review finding).
const pbCtl = R.parseRunLog(
    behLog +
        '\n' +
        JSON.stringify(['cc', 9, 5000, 1, 112, 0, '03704e00']) +
        '\n' +
        JSON.stringify(['cf', 9, 5100, 2, 78, 36, 129000, 812]) +
        '\n' +
        JSON.stringify(['cs', 9, 5200, 3, 1, 0, 0])
);
check('tagged telemetry rows are not behavior samples', pbCtl.samples.length, 2);
check('samples unchanged by the tagged rows', pbCtl.samples[1].fc, 101);
check('behavior_v1 x/y/hd', [pb.samples[1].x, pb.samples[1].y, pb.samples[1].hd], [0.01, 0, 0.02]);

// ── metadata + explicit timing + arena frame commands ─────────────────────────────────────
console.log('=== parseRunLog: replay provenance + explicit timing ===');
const replayLog = [
    JSON.stringify({ type: 'session', event: 'logging_started', ms: 100000 }),
    JSON.stringify({
        type: 'log',
        event: 'run_metadata',
        run_id: 'run-42',
        protocol_filename: 'closed_loop.yaml',
        protocol_sha256: 'abc123',
        rig_id: 'bench01',
        rx_ms: 100001,
        dir: 'browser→bridge'
    }),
    JSON.stringify({
        type: 'log',
        event: 'runner',
        phase: 'trial-running',
        condition: 'closed_loop_led',
        durationSec: 30,
        params: { mode: 3, patternId: 7 },
        ledActivation: { level: 20, hysteresis: 3, on_ranges: [[50, 99]] },
        replay_ms: 25
    }),
    JSON.stringify({
        type: 'log',
        event: 'runner',
        phase: 'led-activation',
        condition: 'closed_loop_led',
        index: 50,
        on: true,
        ledPercent: 20,
        rx_ms: 100040
    }),
    JSON.stringify({
        type: 'log',
        event: 'arena_command',
        head: '03 70 02 01',
        ok: true,
        t: 100060,
        rx_ms: 100061
    }),
    JSON.stringify({
        type: 'log',
        event: 'arena_command',
        head: '03 70 ff 00',
        ok: false,
        t: 100070
    })
].join('\n');
const pr = R.parseRunLog(replayLog);
check('metadata run id extracted', pr.metadata.run_id, 'run-42');
check('metadata transport wrapper removed', pr.metadata.type, undefined);
check('protocol SHA extracted', pr.protocolSha256, 'abc123');
check('explicit replay_ms wins', pr.events[0].ms, 25);
check('wall-clock runner event rebased', pr.events[1].ms, 40);
check(
    'LED replay event keeps on + level',
    [pr.events[1].status.on, pr.events[1].status.ledPercent],
    [true, 20]
);
check('one successful frame command decoded', pr.arenaFrames, [
    { ms: 60, index: 258, source: 'arena_command' }
]);
check('framePositions aliases arenaFrames', pr.framePositions, pr.arenaFrames);
check('replay bounds', [pr.startMs, pr.endMs, pr.durationMs], [25, 60, 35]);
check(
    'direct frame decoder',
    R.decodeFramePosition({ event: 'arena_command', head: '70 0a 00' }),
    10
);
check(
    'non-frame command rejected',
    R.decodeFramePosition({ event: 'arena_command', head: '01 30' }),
    null
);

// ── parseRunLog: behavior_v2 log (compact arena echoes) ─────────────────────
console.log('=== parseRunLog: behavior_v2 log ===');
{
    const T0 = 100000;
    const v2Log = [
        JSON.stringify({ type: 'session', event: 'logging_started', file: 'x.jsonl', ms: T0 }),
        JSON.stringify({
            type: 'frame_schema',
            level: 'behavior_v2',
            cols: ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd'],
            arena_cols: ['t_off', 'dt', 'hex', 'status', 'rx_off'],
            t0: T0
        }),
        JSON.stringify({
            type: 'log',
            event: 'run_metadata',
            run_id: 'run-v2',
            protocol_filename: 'closed_loop.yaml',
            log_format: 'behavior_v2',
            rx_ms: T0 + 1,
            dir: 'browser→bridge'
        }),
        JSON.stringify([0, 100, 5, 0.0, 0.0, 0.0, 0.0]),
        JSON.stringify(['a', 60, 1, '03700201', 0, 61]), // SET_FRAME_POSITION(258) ok
        JSON.stringify([8, 101, 5, 8.272, 0.01, 0.0, 0.02]),
        JSON.stringify(['a', 70, 3, '0370ff00', 1, 73]), // rejected (status 1) → not a frame
        JSON.stringify([
            'a',
            80,
            505,
            '03700300',
            null,
            585,
            'response timeout after 500 ms (cmd 0x70)'
        ]),
        JSON.stringify({
            type: 'log',
            event: 'runner',
            phase: 'led-activation',
            condition: 'closed_loop_led',
            index: 50,
            on: true,
            ledPercent: 20,
            rx_ms: T0 + 40
        })
    ].join('\n');
    const pv2 = R.parseRunLog(v2Log);
    check('format detected behavior_v2', pv2.format, 'behavior_v2');
    check('v2 metadata run id', pv2.metadata.run_id, 'run-v2');
    check('v2 frame rows parsed like v1', pv2.samples.length, 2);
    approx('v2 ft passthrough', pv2.samples[1].ft, 8.272, 1e-9);
    check('only the OK compact echo becomes a frame (reject + timeout dropped)', pv2.arenaFrames, [
        { ms: 60, index: 258, source: 'arena_command' }
    ]);
    check('runner event rebased to the session clock', pv2.events[0].ms, 40);
    // Identical result to the equivalent v1 log.
    const v1Equivalent = R.parseRunLog(
        v2Log
            .split('\n')
            .map((ln) => {
                const o = JSON.parse(ln);
                if (Array.isArray(o) && o[0] === 'a') {
                    const parts = o[3].match(/../g);
                    return JSON.stringify({
                        type: 'log',
                        event: 'arena_command',
                        t: T0 + o[1],
                        dt: o[2],
                        len: parts.length,
                        head: parts.join(' '),
                        status: o[4],
                        echo: o[4] === null ? null : parseInt(parts[1], 16),
                        ok: o[4] === null ? null : o[4] === 0,
                        error: o.length === 7 ? o[6] : null,
                        dir: 'browser→bridge',
                        rx_ms: T0 + o[5]
                    });
                }
                if (o.type === 'frame_schema')
                    return JSON.stringify({
                        type: 'frame_schema',
                        level: 'behavior_v1',
                        cols: o.cols
                    });
                return ln;
            })
            .join('\n')
    );
    check('v2 arenaFrames == v1 arenaFrames', pv2.arenaFrames, v1Equivalent.arenaFrames);
    check('v2 samples == v1 samples', pv2.samples, v1Equivalent.samples);
    check('v2 events == v1 events', pv2.events, v1Equivalent.events);
    check(
        'v2 bounds == v1 bounds',
        [pv2.startMs, pv2.endMs],
        [v1Equivalent.startMs, v1Equivalent.endMs]
    );
}

// Canonical runlog.json uses t_offset_s rather than bridge rx_ms.
const canonical = R.parseRunLog(
    JSON.stringify(
        {
            schema: 'arena-studio-runlog/1',
            intent: 'experiment',
            meta: {
                run_id: 'canonical-1',
                protocol_filename: 'p.yaml',
                protocol_sha256: 'def456',
                timestamp_start: '2026-07-12T12:00:00.000Z'
            },
            events: [
                { t_offset_s: 0, phase: 'sequence-start', total: 1 },
                {
                    t_offset_s: 1.25,
                    phase: 'trial-running',
                    durationSec: 2,
                    step: { conditionName: 'a', kind: 'ref' },
                    params: { mode: 2, frameRate: 10 }
                }
            ],
            summary: { outcome: 'COMPLETED' }
        },
        null,
        2
    )
);
check('canonical format detected', canonical.format, 'runlog');
check('canonical protocol SHA', canonical.protocolSha256, 'def456');
check('canonical explicit t_offset_s → ms', canonical.events[1].ms, 1250);
check('canonical step details retained', canonical.events[1].status.step, {
    conditionName: 'a',
    kind: 'ref'
});
check('canonical summary retained', canonical.summary.outcome, 'COMPLETED');

const torn = R.parseRunLog(
    [
        JSON.stringify({
            type: 'runner',
            phase: 'sequence-start',
            total: 1,
            replay_ms: 10
        }),
        '{"type":"runner","phase":"step-start"'
    ].join('\n')
);
check('torn final JSONL line is ignored without losing prior events', torn.events.length, 1);
check('event before torn line retains explicit replay time', torn.events[0].ms, 10);

// Full course recordings routinely exceed the browser's function-argument
// limit. This must remain a constant-stack bounds scan rather than
// Math.min.apply/Math.max.apply over every sample timestamp.
const largeRowCount = 150000;
const largeLog = Array.from({ length: largeRowCount }, (_, i) =>
    JSON.stringify([i, i, i, i, 0, 0, 0])
).join('\n');
const largeParsed = R.parseRunLog(largeLog);
check(
    'large JSONL parses without overflowing the call stack',
    [largeParsed.samples.length, largeParsed.startMs, largeParsed.endMs],
    [largeRowCount, 0, largeRowCount - 1]
);

// ── buildTimeline: merged + ordered (status before sample at equal ms) ────────
console.log('=== buildTimeline ===');
const tl = R.buildTimeline(p);
check('timeline length = samples + events', tl.length, p.samples.length + p.events.length);
checkBool(
    'timeline sorted by ms',
    tl.every((it, i) => i === 0 || tl[i - 1].ms <= it.ms)
);
// at ms=0 the two runner events (status) precede the frame (sample)
check(
    'ms=0 order: status,status,sample',
    tl.slice(0, 3).map((it) => it.kind),
    ['status', 'status', 'sample']
);
const replayTimeline = R.buildTimeline(pr);
check(
    'frame command included in timeline',
    replayTimeline.map((it) => it.kind),
    ['status', 'status', 'frame']
);
check(
    'timeline exposes slider bounds',
    [replayTimeline.startMs, replayTimeline.endMs, replayTimeline.durationMs],
    [25, 60, 35]
);
check('seekIndex before start', R.seekIndex(replayTimeline, 0), 0);
check('seekIndex exact timestamp', R.seekIndex(replayTimeline, 40), 1);
check('seekIndex between timestamps', R.seekIndex(replayTimeline, 50), 2);
check('seekIndex after end', R.seekIndex(replayTimeline, 100), 3);

const tied = R.buildTimeline({
    events: [
        { ms: 10, status: { phase: 'sequence-start' } },
        { ms: 10, status: { phase: 'step-start' } }
    ],
    arenaFrames: [{ ms: 10, index: 4 }],
    samples: [{ ms: 10, fc: 1 }]
});
check(
    'equal-time replay order is status, status, frame, sample',
    tied.map((item) => item.kind),
    ['status', 'status', 'frame', 'sample']
);
check('seekIndex returns first item among duplicate timestamps', R.seekIndex(tied, 10), 0);
check('seekIndex advances past every duplicate timestamp', R.seekIndex(tied, 10.1), 4);
const noFrames = R.buildTimeline(
    { events: [], arenaFrames: [{ ms: 5, index: 1 }], samples: [{ ms: 8, fc: 2 }] },
    { includeFrames: false }
);
check(
    'buildTimeline can omit decoded frame commands',
    noFrames.map((item) => item.kind),
    ['sample']
);
const emptyTimeline = R.buildTimeline({});
check(
    'empty replay timeline has zero slider bounds',
    [emptyTimeline.startMs, emptyTimeline.endMs, emptyTimeline.durationMs],
    [0, 0, 0]
);
check('seekIndex accepts an empty timeline', R.seekIndex(emptyTimeline, 100), 0);

console.log('\n=== Summary ===');
console.log(`${total - failures} / ${total} checks passed`);
process.exit(failures ? 1 : 0);
