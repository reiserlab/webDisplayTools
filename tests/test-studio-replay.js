#!/usr/bin/env node
/**
 * Tests for js/studio-replay.js — run-log replay in the Classic Arena Studio (v0.88).
 *
 * Covers the DOM-free core: committed run-log names, protocol lookup order (the
 * "upload only the log" path), the runlogs/<bench>/index.json merge behind "Recent
 * runs", the single replay projection shared by playback and seeking, a synthetic
 * behavior log end-to-end through js/runlog-replay.js, and the page wiring
 * (arena_studio.html + the 3D viewer's fly).
 *
 * Run: node tests/test-studio-replay.js   (wired into `pixi run test`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('../js/studio-replay.js');
const RR = require('../js/runlog-replay.js');

const ROOT = path.join(__dirname, '..');
const studioHtml = fs.readFileSync(path.join(ROOT, 'arena_studio.html'), 'utf8');
const viewerJs = fs.readFileSync(path.join(ROOT, 'js', 'arena-replay-viewer.js'), 'utf8');
const viewerHtml = fs.readFileSync(path.join(ROOT, 'arena_replay_viewer.html'), 'utf8');

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

const REAL =
    'p3-heisenberg-ts-short-led5-baseprobe3__shubhamtr__2026-09-23T20-18-00__ei1111av.jsonl.gz';

// ── names + paths ────────────────────────────────────────────────────────────
console.log('=== run-log names ===');
check('parse committed name', S.parseRunlogFilename('runlogs/rig03-sr/' + REAL), {
    protocolSlug: 'p3-heisenberg-ts-short-led5-baseprobe3',
    experimenter: 'shubhamtr',
    stamp: '2026-09-23T20-18-00',
    runId: 'ei1111av'
});
check('non-committed name → null', S.parseRunlogFilename('arena-log-20260923.jsonl'), null);
check('runlogFolder', S.runlogFolder('runlogs/rig03-sr/' + REAL), 'rig03-sr');
check('runlogFolder rejects non-runlog', S.runlogFolder('protocols/rig03-sr/x.yaml'), null);
checkBool('isSafeRunlogPath accepts .jsonl.gz', S.isSafeRunlogPath('runlogs/rig03-sr/' + REAL));
checkBool('isSafeRunlogPath rejects traversal', !S.isSafeRunlogPath('runlogs/../x.jsonl'));
checkBool('isSafeRunId', S.isSafeRunId('ei1111av') && !S.isSafeRunId('../x'));

console.log('=== protocol lookup order ===');
const META = {
    protocol_filename: 'p3-heisenberg-ts-short-led5-baseprobe3.yaml',
    rig_id: 'rig03-sr'
};
check('filename from run_metadata (slug variant deduped)', S.protocolFilenames(META, REAL), [
    'p3-heisenberg-ts-short-led5-baseprobe3.yaml',
    'p3_heisenberg_ts_short_led5_baseprobe3.yaml'
]);
check(
    'no metadata → slug + underscore spelling (fictrac_direction_test.yaml)',
    S.protocolFilenames(
        {},
        'fictrac-direction-test__mreiser__2026-09-10T15-24-35__oaec4gao.jsonl.gz'
    ),
    ['fictrac-direction-test.yaml', 'fictrac_direction_test.yaml']
);
check(
    'unsafe protocol_filename ignored',
    S.protocolFilenames({ protocol_filename: '../../x.yaml' }),
    ['x.yaml']
);
const paths = S.protocolSearchPaths(
    { protocol_filename: 'a.yaml', rig_id: 'rig03-sr' },
    {
        logPath: 'runlogs/bench02/a__x__y__abcdef12.jsonl.gz',
        benchId: 'rig03-sr',
        hintPath: 'protocols/elsewhere/a.yaml',
        extraDirs: ['rig1', '..', 'shared']
    }
);
check('search order: hint, rig_id, log folder, shared, others (deduped, safe only)', paths, [
    'protocols/elsewhere/a.yaml',
    'protocols/rig03-sr/a.yaml',
    'protocols/bench02/a.yaml',
    'protocols/shared/a.yaml',
    'protocols/rig1/a.yaml'
]);
check('no names → no paths', S.protocolSearchPaths({}, {}), []);

// ── recent-runs index merge ──────────────────────────────────────────────────
console.log('=== runlogs/<bench>/index.json merge ===');
const runs = S.mergeRunIndexes([
    {
        folder: 'rig03-sr',
        data: {
            runs: [
                { run_id: 'aaaaaaaa', file: 'old__x__y__aaaaaaaa.jsonl', started_ms: 1000 },
                {
                    run_id: 'ei1111av',
                    file: REAL,
                    started_ms: 3000,
                    protocol_filename: META.protocol_filename,
                    experimenter: 'shubhamTR',
                    genotype: 'Hot Cell (HC-Gal4) > CsChrimson',
                    fly_number: '1',
                    duration_s: 484.4
                },
                { run_id: 'bad', file: '../evil.jsonl', started_ms: 9999 },
                { run_id: 'bad2', file: 'notalog.txt', started_ms: 9999 }
            ]
        }
    },
    {
        folder: 'rig7',
        data: {
            runs: [
                {
                    file: 'b__x__y__bbbbbbbb.jsonl.gz',
                    timestamp_start: new Date(2000).toISOString()
                }
            ]
        }
    },
    { folder: 'rig5', data: null },
    { folder: '..', data: { runs: [{ file: 'c.jsonl', started_ms: 5000 }] } }
]);
check(
    'newest first, unsafe skipped',
    runs.map((r) => r.file),
    [REAL, 'b__x__y__bbbbbbbb.jsonl.gz', 'old__x__y__aaaaaaaa.jsonl']
);
check('path built from folder', runs[0].path, 'runlogs/rig03-sr/' + REAL);
const desc = S.describeRun(runs[0]);
check('describe title', desc.title, 'p3-heisenberg-ts-short-led5-baseprobe3');
check('describe bits', desc.bits, [
    'rig03-sr',
    'shubhamTR',
    'Hot Cell (HC-Gal4) > CsChrimson',
    'fly 1',
    '8:04'
]);
checkBool('filter: all words must match', S.runMatchesFilter(runs[0], 'shubham csChrimson'));
checkBool('filter: a missing word excludes', !S.runMatchesFilter(runs[0], 'shubham rig7'));
checkBool('filter: run id', S.runMatchesFilter(runs[0], 'ei1111av'));
checkBool('empty filter matches', S.runMatchesFilter(runs[2], '  '));

// ── projection semantics ─────────────────────────────────────────────────────
console.log('=== projection (one path for play + seek) ===');
const EXP = {
    conditions: [
        {
            name: 'bg',
            commands: [
                {
                    type: 'controller',
                    command_name: 'trialParams',
                    pattern: 'course_bg',
                    pattern_ID: 23,
                    mode: 2,
                    frame_rate: 10,
                    frame_index: 1
                }
            ]
        },
        { name: 'iti', commands: [{ type: 'wait', duration: 1 }] },
        {
            name: 'cl',
            commands: [
                {
                    type: 'controller',
                    command_name: 'trialParams',
                    pattern: 'p3_heisenberg_ts',
                    pattern_ID: 36,
                    mode: 3,
                    frame_index: 0
                }
            ]
        }
    ]
};
check('trialFromProtocol', S.trialFromProtocol(EXP, 'bg'), {
    condition: 'bg',
    patternName: 'course_bg',
    patternId: 23,
    mode: 2,
    frameRate: 10,
    frameIndex: 1,
    startMs: 0
});
let P = S.createProjection();
const ctx = {
    experiment: EXP,
    sequenceSteps: [{ kind: 'ref', seqIdx: 0 }],
    ledOffMv: 5000,
    patternFrames: 20
};
let r = S.applyStatus(P, { phase: 'step-start', index: 0, total: 3, condition: 'bg' }, 0, ctx);
check('step-start reports stepStarted, not a display change', r, {
    stepStarted: true,
    trialChanged: false
});
check(
    'step joins the nominal flattened step',
    [P.step.kind, P.step.seqIdx, P.step.conditionName],
    ['ref', 0, 'bg']
);
check('display still off before trialParams', P.displayMode, 'off');
r = S.applyStatus(
    P,
    {
        phase: 'command',
        op: 'trialParams',
        condition: 'bg',
        params: { mode: 2, patternId: 23, frameRate: 10, initPos: 1 }
    },
    10,
    ctx
);
check(
    'trialParams changes the display',
    [r.trialChanged, P.displayMode, P.trial.patternName, P.frame],
    [true, 'pattern', 'course_bg', 1]
);
check('mode 2 open-loop frame', S.openLoopFrame(P, 510, 20), 6);
check('open-loop frame wraps', S.openLoopFrame(P, 2010, 20), 1);
S.applyStatus(P, { phase: 'step-start', index: 1, condition: 'iti' }, 1000, ctx);
check(
    'an ITI (wait only) HOLDS the previous pattern',
    [P.condition, P.trial.condition, P.displayMode],
    ['iti', 'bg', 'pattern']
);
check('…and the open loop keeps running through it', S.openLoopFrame(P, 1510, 20), 16);
S.applyStatus(P, { phase: 'step-start', index: 2, condition: 'cl' }, 2000, ctx);
S.applyStatus(
    P,
    { phase: 'command', op: 'trialParams', condition: 'cl', params: { mode: 3, initPos: 5 } },
    2010,
    ctx
);
check(
    'closed-loop trial from protocol + log params',
    [P.trial.condition, P.trial.mode, P.trial.patternId, P.frame],
    ['cl', 3, 36, 5]
);
S.applyItem(P, { kind: 'frame', ms: 2100, index: 27 }, ctx);
check('0x70 frame item wraps on pattern frames', P.frame, 7);
S.applyItem(
    P,
    { kind: 'sample', ms: 2110, sample: { idx: 3 } },
    Object.assign({}, ctx, { hasFrameItems: true })
);
check('sample idx ignored when 0x70 records exist', P.frame, 7);
S.applyItem(
    P,
    { kind: 'sample', ms: 2120, sample: { idx: 3 } },
    Object.assign({}, ctx, { hasFrameItems: false })
);
check('sample idx drives mode 3 in logs without 0x70 records', P.frame, 3);
S.applyStatus(P, { phase: 'led-activation', on: true, ledPercent: 5 }, 2200, ctx);
check('led-activation on', [P.ledOn, P.ledPercent], [true, 5]);
S.applyStatus(P, { phase: 'command', op: 'setAnalogOut', value: 5000, ledPercent: 0 }, 2300, ctx);
check('AO 5000 mV = LED dark (BuckPuck inverted)', P.ledOn, false);
S.applyStatus(P, { phase: 'command', op: 'setAnalogOut', value: 2500 }, 2310, ctx);
check('AO between 0 and off = LED on', P.ledOn, true);
S.applyStatus(P, { phase: 'command', op: 'allOn' }, 2400, ctx);
check('allOn', P.displayMode, 'all-on');
S.applyStatus(P, { phase: 'command', op: 'stopDisplay' }, 2500, ctx);
check('stopDisplay blanks the display but not the LED', [P.displayMode, P.ledOn], ['off', true]);
S.applyStatus(P, { phase: 'sequence-complete' }, 2600, ctx);
check('sequence end: display + LED off', [P.displayMode, P.ledOn], ['off', false]);
check('isLedOnMv 0 mV reads off', S.isLedOnMv(0, 5000), false);
check('positiveModulo negative', S.positiveModulo(-3, 20), 17);
check('formatClock', S.formatClock(65432), '01:05.43');

// ── end to end: a synthetic behavior log through the real parser ─────────────
console.log('=== synthetic run log → timeline → projection ===');
const lines = [
    { type: 'session', event: 'logging_started', ms: 1000 },
    { type: 'frame_schema', level: 'behavior_v1', cols: ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd'] },
    {
        type: 'log',
        event: 'run_metadata',
        rig_id: 'rig03-sr',
        run_id: 'ab12cd34',
        protocol_filename: 'p3-test.yaml',
        protocol_sha256: 'ABC123',
        arena_config: 'G6_2x10',
        experimenter: 'shubhamTR',
        timestamp_start: '2026-09-23T20:09:55.910Z',
        rx_ms: 1001
    },
    { type: 'log', event: 'runner', phase: 'sequence-start', total: 3, rx_ms: 1001 },
    {
        type: 'log',
        event: 'runner',
        phase: 'step-start',
        index: 0,
        total: 3,
        condition: 'bg',
        rx_ms: 1002
    },
    {
        type: 'log',
        event: 'runner',
        phase: 'trial-running',
        index: 0,
        durationSec: 1,
        params: { mode: 2, patternId: 23, frameRate: 10, initPos: 0 },
        condition: 'bg',
        rx_ms: 1010
    }
];
for (let ms = 20; ms <= 4900; ms += 20) lines.push([ms, ms / 20, 0, ms, ms * 1e-4, 0, 0.001 * ms]);
lines.push(
    {
        type: 'log',
        event: 'runner',
        phase: 'step-start',
        index: 1,
        total: 3,
        condition: 'iti',
        rx_ms: 2010
    },
    {
        type: 'log',
        event: 'runner',
        phase: 'step-start',
        index: 2,
        total: 3,
        condition: 'cl',
        rx_ms: 3010
    },
    {
        type: 'log',
        event: 'runner',
        phase: 'trial-running',
        index: 2,
        durationSec: 2,
        params: { mode: 3, patternId: 36, initPos: 5 },
        condition: 'cl',
        rx_ms: 3020
    },
    { type: 'log', event: 'arena_command', t: 3100, head: '03 70 0a 00', ok: true, rx_ms: 3101 },
    { type: 'log', event: 'runner', phase: 'led-activation', on: true, ledPercent: 5, rx_ms: 3200 },
    {
        type: 'log',
        event: 'runner',
        phase: 'command',
        op: 'setAnalogOut',
        value: 5000,
        ledPercent: 0,
        condition: 'cl',
        rx_ms: 4500
    },
    { type: 'log', event: 'runner', phase: 'sequence-complete', rx_ms: 5020 }
);
const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"torn":';
const parsed = RR.parseRunLog(text);
const timeline = RR.buildTimeline(parsed);
check('metadata sha normalized', S.normalizeSha(parsed.protocolSha256), 'abc123');
check('log-only steps (no protocol)', S.logOnlySteps(parsed), [
    { index: 0, conditionName: 'bg', mode: 2, patternId: 23, durationSec: 1 },
    { index: 1, conditionName: 'iti', mode: null, patternId: null, durationSec: null },
    { index: 2, conditionName: 'cl', mode: 3, patternId: 36, durationSec: 2 }
]);
const lctx = {
    experiment: null,
    sequenceSteps: [],
    ledOffMv: 5000,
    patternFrames: 0,
    hasFrameItems: parsed.arenaFrames.length > 0
};
function walkTo(ms) {
    const p = S.createProjection();
    for (const it of timeline) {
        if (it.ms > ms) break;
        S.applyItem(p, it, lctx);
    }
    return p;
}
let w = walkTo(500);
check(
    't=0.5 s: bg, open loop, pattern #23 (log-only)',
    [w.condition, w.trial.mode, w.trial.patternId, w.displayMode],
    ['bg', 2, 23, 'pattern']
);
w = walkTo(1500);
check(
    't=1.5 s: ITI holds pattern #23',
    [w.condition, w.trial.patternId, w.displayMode],
    ['iti', 23, 'pattern']
);
w = walkTo(2150);
check(
    't=2.15 s: closed loop, 0x70 frame 10',
    [w.condition, w.trial.mode, w.trial.patternId, w.frame],
    ['cl', 3, 36, 10]
);
w = walkTo(2300);
check('t=2.3 s: LED on', w.ledOn, true);
w = walkTo(3600);
check('t=3.6 s: LED off (AO 5000)', w.ledOn, false);
w = walkTo(99999);
check('end: display off', w.displayMode, 'off');
// prime (seek) must agree with a sequential walk — one code path.
[500, 1500, 2150, 2300, 3600].forEach((ms) => {
    const end = S.seekIndex(timeline, ms + 1);
    const primed = S.primeProjection(timeline, end, lctx);
    const walked = walkTo(ms);
    check(
        'seek-prime == sequential walk at ' + ms + ' ms',
        [
            primed.condition,
            primed.frame,
            primed.ledOn,
            primed.displayMode,
            primed.trial && primed.trial.patternId,
            primed.ball.map((v) => v.toFixed(9))
        ],
        [
            walked.condition,
            walked.frame,
            walked.ledOn,
            walked.displayMode,
            walked.trial && walked.trial.patternId,
            walked.ball.map((v) => v.toFixed(9))
        ]
    );
});
check(
    'seekIndex = first item at/after target',
    timeline[S.seekIndex(timeline, 2010)].ms >= 2010,
    true
);

// ── ball rotation from FicTrac (the 3D window's ball) ───────────────────────
console.log('=== ball rotation from FicTrac ===');
const near = (q, e, tol) => q.every((v, i) => Math.abs(v - e[i]) < (tol || 1e-6));
function rollBall(samples) {
    const p = S.createProjection();
    samples.forEach((sm, i) =>
        S.applyItem(p, { kind: 'sample', ms: sm.ms || i * 10, sample: sm }, {})
    );
    return S.quatNormalize(p.ball);
}
const ballPath = (n, f) =>
    Array.from({ length: n }, (_, i) => Object.assign({ ms: i * 10, ft: i * 10 }, f(i)));
let q = rollBall(ballPath(101, (i) => ({ x: i * 0.01, y: 0, hd: 0 })));
checkBool(
    'walking forward 1 rad → ball top rolls BACK: −1 rad about +Z',
    near(q, [0, 0, -Math.sin(0.5), Math.cos(0.5)], 1e-6),
    JSON.stringify(q)
);
q = rollBall(ballPath(51, (i) => ({ x: 0, y: 0, hd: i * 0.01 })));
checkBool(
    'turning right 0.5 rad (heading up) → ball yaws CCW from above: +0.5 about +Y',
    near(q, [0, Math.sin(0.25), 0, Math.cos(0.25)], 1e-6),
    JSON.stringify(q)
);
q = rollBall(ballPath(41, (i) => ({ x: 0, y: i * 0.01, hd: 0 })));
checkBool(
    'side-step right 0.4 rad → top slides to the fly’s left: +0.4 about +X',
    near(q, [Math.sin(0.2), 0, 0, Math.cos(0.2)], 1e-6),
    JSON.stringify(q)
);
q = rollBall(ballPath(101, (i) => ({ x: 0, y: i * 0.01, hd: Math.PI / 2 })));
checkBool(
    'walking along a 90° heading is still forward for the fly (−Z roll only)',
    near(q, [0, 0, -Math.sin(0.5), Math.cos(0.5)], 1e-6),
    JSON.stringify(q)
);
q = rollBall([
    { ms: 0, ft: 0, x: 0, y: 0, hd: 0 },
    { ms: 400, ft: 400, x: 0.2, y: 0, hd: 0 },
    { ms: 410, ft: 410, x: 0.9, y: 0, hd: 0 }
]);
checkBool(
    'gaps (>250 ms) and FicTrac-reset jumps are not integrated',
    near(q, [0, 0, 0, 1]),
    JSON.stringify(q)
);
q = rollBall(ballPath(3, (i) => ({ x: 0, y: 0, hd: [3.1, -3.1, -3.0][i] })));
checkBool(
    'heading wrap at ±π is a small turn, not a spin',
    Math.abs(2 * Math.acos(Math.min(1, Math.abs(q[3]))) - (2 * Math.PI - 6.2 + 0.1)) < 1e-6,
    JSON.stringify(q)
);

// ── 3D window placement (out of the way of the replay controls) ─────────────
console.log('=== 3D window placement ===');
const SCREEN = { availLeft: 0, availTop: 25, availWidth: 1440, availHeight: 875 };
const MAXED = {
    screenX: 0,
    screenY: 25,
    outerWidth: 1440,
    outerHeight: 875,
    innerWidth: 1440,
    innerHeight: 790
};
let pl = S.viewerPlacement({
    screen: { availLeft: 0, availTop: 0, availWidth: 2560, availHeight: 1400 },
    win: {
        screenX: 0,
        screenY: 40,
        outerWidth: 1440,
        outerHeight: 900,
        innerWidth: 1440,
        innerHeight: 815
    }
});
check('screen has room → beside the Studio window, 4:3, ≤ 720 wide', pl, {
    width: 720,
    height: 540,
    left: 1444,
    top: 40
});
pl = S.viewerPlacement({
    screen: SCREEN,
    win: MAXED,
    panel: { left: 1012, top: 90, width: 300, height: 310 }
});
check('maximized Studio → over the Run-details column, below the top bar', pl, {
    width: 420,
    height: 280,
    left: 1012,
    top: 200
});
checkBool(
    '…and it stays inside the screen',
    pl.left + pl.width <= 1440 && pl.top + pl.height <= 900
);
pl = S.viewerPlacement({ screen: SCREEN, win: MAXED, panel: null });
check('no Run-details column (narrow layout) → bottom-right corner', pl, {
    width: 520,
    height: 390,
    left: 916,
    top: 480
});
pl = S.viewerPlacement({
    screen: { availLeft: 0, availTop: 39, availWidth: 1800, availHeight: 1083 },
    win: {
        screenX: 0,
        screenY: 1169,
        outerWidth: 252,
        outerHeight: 158,
        innerWidth: 1312,
        innerHeight: 822
    }
});
check('nonsense outer metrics (outer < inner, off-screen) are sanitized', pl, {
    width: 480,
    height: 360,
    left: 1316,
    top: 300
});
pl = S.viewerPlacement({});
checkBool(
    'no environment at all → still a sane on-screen size',
    pl.width >= 320 && pl.left >= 0 && pl.top >= 0
);

// ── page wiring ──────────────────────────────────────────────────────────────
console.log('=== arena_studio.html wiring ===');
const iReplay = studioHtml.indexOf('src="js/studio-replay.js');
checkBool(
    'studio-replay.js loaded (cache-versioned)',
    /src="js\/studio-replay\.js\?v=[^"]+"/.test(studioHtml)
);
checkBool(
    'loaded after runlog-replay + viewer protocol + github + url-state',
    iReplay > studioHtml.indexOf('src="js/runlog-replay.js') &&
        iReplay > studioHtml.indexOf('src="js/arena-replay-viewer-protocol.js"') &&
        iReplay > studioHtml.indexOf('src="js/studio-github.js') &&
        iReplay > studioHtml.indexOf('src="js/studio-url-state.js')
);
const iInstall = studioHtml.indexOf('window.StudioReplay.install(');
checkBool(
    'install glue is CLASSIC (before the module block), after the Scope is defined',
    iInstall > studioHtml.indexOf('window.Scope = Scope;') &&
        iInstall < studioHtml.indexOf('<script type="module">')
);
[
    'replayOpenBtn',
    'fmReplay',
    'replayOverlay',
    'rpdList',
    'rpdFilter',
    'rpdFolder',
    'rpdLocalInput',
    'rpdYamlInput',
    'rpdPatInput',
    'replayCard',
    'rplPlay',
    'rplSlider',
    'rplSpeed',
    'rplSound',
    'rplViewer',
    'rplLink',
    'rplStop',
    'rplProto'
].forEach((id) => checkBool('element #' + id, studioHtml.includes('id="' + id + '"')));
checkBool(
    'protocolDocSha hashes the designer serialization',
    /Studio\.protocolDocSha = async function \(text\) \{\s*return sha256Hex\(parseV3Protocol\(String\(text\)\)\._doc\.toString\(\)\);/.test(
        studioHtml
    )
);
checkBool(
    'highlightSeq exposed for replay',
    studioHtml.includes('Studio.highlightSeq = highlightSeq;')
);
checkBool(
    'webBytesForId (log-only pattern lookup)',
    studioHtml.includes('Studio.webBytesForId = function (id)')
);
checkBool(
    'updateUrl passes the replay link to encodeApp',
    /replayRepo: rp \? rp\.repo : null/.test(studioHtml)
);
checkBool(
    'initFromUrl opens ?replay=',
    /Studio\.replay\.openFromUrl\(\{\s*repo: state\.repo,\s*path: state\.replay,\s*runId: state\.replayRun/.test(
        studioHtml
    )
);
checkBool('Help text for the replay entry point', studioHtml.includes("'#replayOpenBtn':"));
checkBool(
    'footer v0.88',
    /Arena Studio v0\.88 \| \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET · <a/.test(studioHtml)
);
checkBool(
    'replay hides Test buttons',
    studioHtml.includes('body.replay-active .seqrow .play{display:none}')
);

console.log('=== 3D viewer fly ===');
checkBool(
    'fly built to scale on the 9 mm ball',
    /const FLY_LENGTH_MM = 2\.3;/.test(viewerJs) && /const BALL_DIAMETER_MM = 9;/.test(viewerJs)
);
checkBool(
    'fly added to the apparatus',
    viewerJs.includes('const fly = buildFly(BALL_DIAMETER_MM / 2 / flyScaleMm);') &&
        /const FLY_DISPLAY_SCALE = 2;/.test(viewerJs)
);
checkBool(
    'ball clears depth for the ball+fly domain',
    viewerJs.includes('ball.onBeforeRender = clearDepthBeforeDraw;') &&
        viewerJs.includes('renderer.state.buffers.depth.setMask(true);')
);
checkBool(
    'fly hidden near the camera (fly-eye view)',
    viewerJs.includes('function updateFlyVisibility()')
);
checkBool(
    '"Fly" camera preset button',
    viewerHtml.includes('id="view-fly"') && viewerJs.includes('function setFlyView()')
);

checkBool(
    'ball holder: black Ø12 mm cylinder up to 45% of the ball, from below the floor',
    /const HOLDER_DIAMETER_MM = 12;/.test(viewerJs) &&
        /const HOLDER_TOP_FRACTION = 0\.45;/.test(viewerJs) &&
        viewerJs.includes(
            'const holderBottom = arenaBottom - HOLDER_BELOW_FLOOR_MM / MM_PER_INCH;'
        ) &&
        viewerJs.includes('holder.renderOrder = 44.5;')
);

checkBool(
    'viewer has a compact layout for the small sidecar window',
    viewerHtml.includes('@media (max-width: 680px), (max-height: 500px)')
);
checkBool(
    'Studio opens the 3D window placed + sized (not a fixed 900×720)',
    fs
        .readFileSync(path.join(ROOT, 'js', 'studio-replay.js'), 'utf8')
        .includes('const place = currentViewerPlacement();')
);

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures ? 1 : 0);
