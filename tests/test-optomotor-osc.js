#!/usr/bin/env node
/**
 * protocols/g6_optomotor_osc_walking.yaml, g6_optomotor_osc_flight.yaml and the patterns
 * scripts/make-optomotor-osc-patterns.js builds for them.
 *
 * Open loop plays frames at a constant rate, so the 0.2 Hz oscillation exists only as each
 * pattern's frame sequence; the patterns are generated (about 20 MB), not committed. This
 * test ties the pieces together:
 *   - both protocols parse, validate and round-trip; the run order and durations; the
 *     mode-2 wire parameters; the closed-loop trials and their bias (walking only); the
 *     flight protocol has no plugin;
 *   - the generator runs into a temp folder and passes its own decode checks (position of
 *     every frame against geometry it computes independently of the Pattern Designer's
 *     generator); its frame rate, frames per cycle and file names are the ones the
 *     protocols use; spot checks of the files, decoded here;
 *   - the data browser keeps both in the generic family.
 *
 * Run: node tests/test-optomotor-osc.js   (part of `pixi run test`)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    parseV3Protocol,
    generateV3Protocol,
    validateReferences,
    collectBlockingErrors,
    unsupportedRequires
} = require('../js/protocol-yaml-v3.js');
const R = require('../js/arena-runner-g6.js');
const _pp = require('../js/pat-parser.js');
const PatParser = _pp.default || _pp;
const A = require('../dashboard/data-browser/analysis-core.js');

const ROOT = path.join(__dirname, '..');
let checks = 0;
let failures = 0;
function check(name, ok, info) {
    checks++;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? ' — ' + info : ''}`);
}
function quiet(fn) {
    const log = console.log;
    console.log = () => {}; // PatParser.parsePatFile logs a summary per file
    try {
        return fn();
    } finally {
        console.log = log;
    }
}

// Run order: ascending depth, yaw and roll interleaved.
const OL = [
    ['yaw_osc_2p5hz', 'G6_2x10_sine45_yaw_osc_tf2p5'],
    ['roll_osc_2p5hz', 'G6_2x10_sine45_roll_osc_tf2p5'],
    ['yaw_osc_5hz', 'G6_2x10_sine45_yaw_osc_tf5'],
    ['roll_osc_5hz', 'G6_2x10_sine45_roll_osc_tf5'],
    ['yaw_osc_10hz', 'G6_2x10_sine45_yaw_osc_tf10'],
    ['roll_osc_10hz', 'G6_2x10_sine45_roll_osc_tf10']
];
const patOf = (cond) => OL.find((x) => x[0] === cond)[1];
const CL = [
    ['cl_grating_bias', 'G6_2x10_sine45_yaw_200f'],
    ['cl_stripe_bias', 'G6_2x10_stripe16_dark_200f']
];
const olNames = OL.map((x) => x[0]);

function load(name) {
    const text = fs.readFileSync(path.join(ROOT, 'protocols', name + '.yaml'), 'utf8');
    const exp = parseV3Protocol(text);
    const model = (e) => JSON.stringify(e, (k, v) => (k === '_doc' ? undefined : v));
    check(name + ': references resolve', validateReferences(exp).ok === true);
    check(name + ': no blocking errors', collectBlockingErrors(exp).ok === true);
    check(name + ': nothing the web runner lacks', unsupportedRequires(exp).length === 0);
    check(
        name + ': round trip keeps the data model',
        model(parseV3Protocol(generateV3Protocol(exp))) === model(exp)
    );
    check(name + ': rig', /cshl_g6_2x10_ball\.yaml$/.test(exp.rig_path), exp.rig_path);
    check(
        name + ': data browser family generic',
        A.protocolInfo(
            { protocol_filename: name + '.yaml' },
            exp.conditions.map((c) => c.name)
        ).family === 'generic'
    );
    const byName = new Map(exp.conditions.map((c) => [c.name, c]));
    const steps = R.flattenStructure(exp).steps;
    return { exp, byName, steps, order: steps.map((s) => s.conditionName) };
}
function openLoopChecks(p, label, fps) {
    for (const [cond, pat] of OL) {
        const cmds = p.byName.get(cond).commands;
        const k = cmds.find((c) => c.command_name === 'trialParams');
        const wire = R.buildTrialParams(k, { patternId: k.pattern_ID });
        const wait = cmds.find((c) => c.type === 'wait');
        check(
            `${label} ${cond}: ${pat}, mode 2 at +${fps} frames/s, 20 s = 4 cycles, plugin-free`,
            k.pattern === pat &&
                wire.mode === 2 &&
                wire.frameRate === fps &&
                k.duration === 20 &&
                wait.duration === 20 &&
                cmds.length === 2
        );
    }
}

// ── the generator, into a temp folder ────────────────────────────────────────
console.log('=== patterns (generated) ===');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'optomotor-osc-'));
let genOk = true;
try {
    execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'make-optomotor-osc-patterns.js'), '--out', out, '--quiet'],
        { stdio: 'pipe' }
    );
} catch (e) {
    genOk = false;
    console.log(String(e.stdout || '') + String(e.stderr || ''));
}
check('generator exits 0 (every decoded file passes its own checks)', genOk);
const meta = JSON.parse(fs.readFileSync(path.join(out, 'patterns.json'), 'utf8'));
check('generator reports ok', meta.ok === true);
check(
    'straight ahead = pixel column 49.5 (center of panel column 3)',
    meta.front_col === 49.5 && meta.arena === 'G6_2x10'
);
check(
    '45° wavelength, 0.2 Hz, peaks 2.5 / 5 / 10 Hz',
    meta.wavelength_deg === 45 && meta.osc_hz === 0.2 && meta.peaks_hz.join() === '2.5,5,10'
);
check(
    'one 5 s cycle per file, a whole number of 300 Hz GS16 refreshes per frame',
    meta.frames_per_cycle === meta.fps / meta.osc_hz && 300 % meta.fps === 0,
    meta.frames_per_cycle + ' frames at ' + meta.fps + ' frames/s'
);
check(
    'file names are the ones the protocols use',
    meta.open_loop.slice().sort().join() ===
        OL.map((x) => x[1])
            .sort()
            .join() && meta.closed_loop.join() === CL.map((x) => x[1]).join()
);
const pat = (name) =>
    quiet(() =>
        PatParser.parsePatFile(
            new Uint8Array(fs.readFileSync(path.join(out, name + '.pat'))).buffer
        )
    );
const W = 200;
const yaw = pat(patOf('yaw_osc_10hz'));
check(
    'open-loop file: GS16, 200 × 40 px, one cycle of frames',
    yaw.gs_val === 16 &&
        yaw.frames.length === meta.frames_per_cycle &&
        yaw.frames[0].length === W * 40
);
const rowsEqual = (fr) => {
    for (let i = W; i < fr.length; i++) if (fr[i] !== fr[i % W]) return false;
    return true;
};
check('yaw: every pixel row the same (vertical bars)', yaw.frames.every(rowsEqual));
const sameFrame = (a, b) => a.every((v, i) => v === b[i]);
check(
    'yaw: 25 px per wavelength, full gray range',
    // one gray level of slack: a value on a rounding boundary may fall either way
    Array.from(yaw.frames[0].slice(0, W - 25)).every(
        (v, c) => Math.abs(v - yaw.frames[0][c + 25]) <= 1
    ) &&
        Math.min(...yaw.frames[0]) === 0 &&
        Math.max(...yaw.frames[0]) === 15
);
// v = peak·sin(2π f t): zero speed at the start and at the half cycle (turnaround).
const half = meta.frames_per_cycle / 2;
const quarter = Math.round(half / 2);
check(
    'oscillation: at rest at the start and at the turnaround, moving in between',
    sameFrame(yaw.frames[0], yaw.frames[1]) &&
        sameFrame(yaw.frames[half], yaw.frames[half + 1]) &&
        !sameFrame(yaw.frames[quarter], yaw.frames[quarter + 1])
);
check(
    'oscillation: the second half cycle retraces the first',
    [1, 7, 100, half - 3].every((k) =>
        sameFrame(yaw.frames[k], yaw.frames[meta.frames_per_cycle - k])
    )
);
const roll = pat(patOf('roll_osc_5hz'));
check('roll: not a column pattern (bars change with height)', !roll.frames.every(rowsEqual));
// A rotation about the front-back axis by 180° maps the arena onto itself: the point at
// (column c, row r) goes to (mirror of c about the front, row 39 − r). With 8 cycles per
// turn the grating is unchanged by it. This holds for the true roll pattern and not for a
// yaw or pitch one.
const mirror = (fr) => {
    let diff = 0;
    for (let r = 0; r < 40; r++) {
        for (let c = 0; c < W; c++) {
            const c2 = (((99 - c) % W) + W) % W; // mirror about column 49.5
            diff += Math.abs(fr[r * W + c] - fr[(39 - r) * W + c2]);
        }
    }
    return diff / fr.length;
};
check(
    'roll: symmetric under a half turn about the axis through pixel column 49.5',
    mirror(roll.frames[0]) < 0.2 && mirror(roll.frames[200]) < 0.2,
    mirror(roll.frames[0]).toFixed(3)
);
check('roll: the yaw grating is not symmetric that way', mirror(yaw.frames[quarter]) > 1);
const stripe = pat(CL[1][1]);
const darkCols = (fr) => {
    const cols = [];
    for (let c = 0; c < W; c++) if (fr[c] === 0) cols.push(c);
    return cols;
};
check(
    'stripe: 200 frames, dark 16 px on bright, frame 0 centered straight ahead (columns 42..57)',
    stripe.frames.length === 200 &&
        stripe.frames.every(rowsEqual) &&
        darkCols(stripe.frames[0]).join() === Array.from({ length: 16 }, (_, i) => 42 + i).join() &&
        Math.max(...stripe.frames[0]) === 15
);
check(
    'stripe: frame k is k px toward increasing column index (as frame2_h_ccw_200f)',
    darkCols(stripe.frames[30])[0] === 72 &&
        darkCols(stripe.frames[158]).join() === Array.from({ length: 16 }, (_, i) => i).join()
);
check('closed-loop grating: 200 frames, 1 px per frame', pat(CL[0][1]).frames.length === 200);
fs.rmSync(out, { recursive: true, force: true });

// ── the protocols ────────────────────────────────────────────────────────────
console.log('=== walking protocol ===');
const w = load('g6_optomotor_osc_walking');
check(
    'walking order: setup, 6 open loop, 2 closed loop, finish',
    w.order.join() ===
        ['fictrac_setup', ...olNames, 'cl_grating_bias', 'cl_stripe_bias', 'finish'].join()
);
const sum = (p) => p.steps.reduce((a, s) => a + s.dur, 0);
check('walking: 2 min open loop + 2 min closed loop (+1 s to blank)', sum(w) === 241, sum(w));
openLoopChecks(w, 'walking', meta.fps);
check(
    'walking: fictrac is the only plugin',
    w.exp.plugins.length === 1 && w.exp.plugins[0].name === 'fictrac'
);
for (const [cond, patName] of CL) {
    const cmds = w.byName.get(cond).commands;
    const k = cmds.find((c) => c.command_name === 'trialParams');
    const start = cmds.find((c) => c.command_name === 'startClosedLoop');
    const order = cmds.map((c) => c.command_name || c.type).join();
    check(
        `walking ${cond}: ${patName}, mode 3 from frame 0, 60 s`,
        k.pattern === patName &&
            k.mode === 3 &&
            k.frame_index === 0 &&
            k.duration === 60 &&
            order === 'trialParams,startClosedLoop,wait,stopClosedLoop'
    );
    const b = R.normalizeBias(start.params);
    check(
        `walking ${cond}: coupling 1, sine bias 40°/s at 0.2 Hz (±32°)`,
        start.params.coupling === 1 &&
            start.params.bias_type === 'sine' &&
            start.params.bias_amplitude === 40 &&
            start.params.bias_frequency === 0.2 &&
            !b.warning,
        JSON.stringify(b.bias)
    );
}

console.log('=== flight protocol ===');
const f = load('g6_optomotor_osc_flight');
check(
    'flight order: the 6 open-loop trials twice, finish',
    f.order.join() === [...olNames, ...olNames, 'finish'].join()
);
check('flight: 4 min (+1 s to blank)', sum(f) === 241, sum(f));
openLoopChecks(f, 'flight', meta.fps);
const fc = f.exp.conditions.flatMap((c) => c.commands);
check(
    'flight: no plugin, only mode-2 trialParams, allOff and waits',
    (!f.exp.plugins || f.exp.plugins.length === 0) &&
        fc.every(
            (k) =>
                k.type === 'wait' ||
                (k.type === 'controller' &&
                    (k.command_name === 'allOff' ||
                        (k.command_name === 'trialParams' && k.mode === 2)))
        )
);

console.log('\n=== Summary ===');
console.log(`${checks - failures} / ${checks} checks passed`);
process.exit(failures ? 1 : 0);
