#!/usr/bin/env node
/**
 * protocols/g6_optomotor_open_loop_oscillation.yaml and its two patterns.
 *
 * Open loop plays frames at a constant rate, so the 1 Hz sinusoid exists only as the
 * oscillation pattern's frame sequence. This test ties the three pieces together:
 *   - the protocol parses, validates and round-trips; it has no plugin and no closed-loop
 *     command (the same file is run for a walking fly and a flying fly);
 *   - the run order, the durations and the mode-2 wire parameters of every stimulus;
 *   - the committed .pat files, decoded: the grating, the rotation pattern's 1 px per
 *     frame, and the oscillation as position against time AT THE PROTOCOL'S frame rate:
 *     frequency 1 Hz, amplitude one grating period, starts at zero moving toward
 *     increasing column index;
 *   - the data browser keeps this run in the generic family (its name must not start
 *     with `optomotor_`, the opto-LED family's prefix).
 *
 * Run: node tests/test-optomotor-oscillation.js   (part of `pixi run test`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
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
const NAME = 'g6_optomotor_open_loop_oscillation';
const YAML_PATH = path.join(ROOT, 'protocols', NAME + '.yaml');
const PAT_DIR = path.join(ROOT, 'protocols', NAME + '_patterns');

let checks = 0;
let failures = 0;
function check(name, ok, info) {
    checks++;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? ' — ' + info : ''}`);
}
// PatParser.parsePatFile logs a summary per file; keep the test output to the checks.
function quiet(fn) {
    const log = console.log;
    console.log = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
    }
}

// ── the protocol ─────────────────────────────────────────────────────────────
console.log('=== protocol ===');
const text = fs.readFileSync(YAML_PATH, 'utf8');
const exp = parseV3Protocol(text);
check('references resolve', validateReferences(exp).ok === true);
check('no blocking errors', collectBlockingErrors(exp).ok === true);
check('nothing the web runner lacks', unsupportedRequires(exp).length === 0);
// Round trip as tests/test-protocol-roundtrip-v3.js defines it: parse → generate → parse gives
// the same data model, and the anchors survive in the regenerated text.
const regen = generateV3Protocol(exp);
const model = (e) => JSON.stringify(e, (k, v) => (k === '_doc' ? undefined : v));
check('round trip: data model stable', model(parseV3Protocol(regen)) === model(exp));
check(
    'round trip: anchors survive',
    ['stim_dur', 'gap_dur', 'fps_cw', 'fps_ccw', 'osc_fps'].every(
        (a) => regen.includes('&' + a + ' ') && regen.includes('*' + a)
    )
);
check('rig is the 2x10 ball rig', /cshl_g6_2x10_ball\.yaml$/.test(exp.rig_path), exp.rig_path);
check('no plugins declared', !exp.plugins || exp.plugins.length === 0);

const cmds = exp.conditions.flatMap((c) => c.commands.map((k) => ({ cond: c.name, k })));
check(
    'only controller commands and waits',
    cmds.every(({ k }) => k.type === 'controller' || k.type === 'wait')
);
check(
    'controller commands are trialParams (mode 2) or allOff',
    cmds
        .filter(({ k }) => k.type === 'controller')
        .every(
            ({ k }) =>
                k.command_name === 'allOff' || (k.command_name === 'trialParams' && k.mode === 2)
        )
);
check('the run does not use the bridge', R.sequenceUsesBridge(exp) === false);

const steps = R.flattenStructure(exp).steps;
const order = steps.map((s) => s.conditionName);
const trio = ['grating_cw', 'gap', 'grating_ccw', 'gap', 'grating_osc_1hz'];
const want = ['gap'];
for (let r = 0; r < 4; r++) want.push(...trio, 'gap');
check('order: gap, 4 × (cw, ccw, osc) with gaps, gap', order.join() === want.join(), order.length);
const total = steps.reduce((a, s) => a + s.dur, 0);
check('total 185 s (~3 min)', total === 185, total);

const byName = new Map(exp.conditions.map((c) => [c.name, c]));
const tp = (cond) => {
    const k = byName.get(cond).commands.find((c) => c.command_name === 'trialParams');
    return { k, wire: R.buildTrialParams(k, { patternId: k.pattern_ID }) };
};
const cw = tp('grating_cw');
const ccw = tp('grating_ccw');
const osc = tp('grating_osc_1hz');
check('cw and ccw use one pattern', cw.k.pattern === ccw.k.pattern, cw.k.pattern);
check(
    'cw +80, ccw -80 frames/s',
    cw.wire.frameRate === 80 && ccw.wire.frameRate === -80,
    cw.wire.frameRate + ' / ' + ccw.wire.frameRate
);
check('osc at +200 frames/s', osc.wire.frameRate === 200, osc.wire.frameRate);
check(
    'every stimulus is 10 s, starts at frame 0, gain 0',
    [cw, ccw, osc].every(
        (s) => s.k.duration === 10 && s.wire.initPos === cw.wire.initPos && s.wire.gain === 0
    )
);

// ── the patterns ─────────────────────────────────────────────────────────────
console.log('=== patterns ===');
const load = (name) =>
    quiet(() =>
        PatParser.parsePatFile(
            new Uint8Array(fs.readFileSync(path.join(PAT_DIR, name + '.pat'))).buffer
        )
    );
const mod = (a, n) => ((a % n) + n) % n;
const PX_COLS = 200;
const PX_ROWS = 40;
const DEG_PER_PX = 360 / PX_COLS;

// Each frame must be a column-only pattern (every row the same); return its row.
function rowOf(fr) {
    for (let i = PX_COLS; i < fr.length; i++) if (fr[i] !== fr[i % PX_COLS]) return null;
    return Array.from(fr.slice(0, PX_COLS));
}
// Shift (px toward increasing column index) of `row` against `ref`, or -1.
function shiftOf(row, ref, period) {
    for (let s = 0; s < period; s++) {
        if (row.every((v, c) => v === ref[mod(c - s, PX_COLS)])) return s;
    }
    return -1;
}

const grat = load(cw.k.pattern);
const gRows = grat.frames.map(rowOf);
check('rotation: 200 × 40 px, 20 frames', grat.frames.length === 20 && gRows.every(Boolean));
const ref = gRows[0];
// Period of frame 0: the smallest circular shift that maps it onto itself.
let period = 0;
for (let p = 1; p <= PX_COLS && !period; p++) {
    if (ref.every((v, c) => v === ref[mod(c - p, PX_COLS)])) period = p;
}
check('grating period 20 px = 36°', period === 20, period * DEG_PER_PX + '°');
check(
    'square wave, half on / half off',
    ref.every((v) => v === 0 || v === 1) && ref.reduce((a, v) => a + v, 0) === PX_COLS / 2
);
check(
    'rotation: frame k is shifted k px',
    gRows.every((row, k) => shiftOf(row, ref, period) === k)
);
const tfHz = cw.wire.frameRate / period;
check('rotation: 4 Hz temporal frequency, 144°/s', tfHz === 4, cw.wire.frameRate * DEG_PER_PX);
check('rotation: 10 s is a whole number of periods', (cw.k.duration * 80) % period === 0);

const op = load(osc.k.pattern);
const oRows = op.frames.map(rowOf);
check('oscillation: every frame is the same grating', oRows.every(Boolean));
const N = op.frames.length;
const cycleS = N / osc.wire.frameRate;
check('oscillation: one cycle of frames lasts 1 s → 1 Hz', cycleS === 1, N + ' frames');
check('oscillation: 10 s is a whole number of cycles', Number.isInteger(osc.k.duration / cycleS));
// Position against time: the shift is known modulo the period; unwrap frame to frame.
const pos = [];
let good = true;
oRows.forEach((row, k) => {
    const s = shiftOf(row, ref, period);
    if (s < 0) good = false;
    if (k === 0) {
        pos.push(s);
    } else {
        let d = mod(s - mod(pos[k - 1], period), period);
        if (d > period / 2) d -= period;
        pos.push(pos[k - 1] + d);
    }
});
check('oscillation: starts at zero shift', good && pos[0] === 0);
// Fourier components of position(t), t = k / frame rate, over the one cycle.
const comp = (h) => {
    let s = 0;
    let c = 0;
    pos.forEach((p, k) => {
        const w = 2 * Math.PI * h * (k / osc.wire.frameRate / cycleS);
        s += p * Math.sin(w);
        c += p * Math.cos(w);
    });
    return [(2 * s) / N, (2 * c) / N];
};
const [s1, c1] = comp(1);
const amp = Math.hypot(s1, c1);
check(
    'oscillation: 1 Hz component is one grating period (±1 %)',
    Math.abs(amp - period) < 0.01 * period,
    amp.toFixed(3) + ' px = ±' + (amp * DEG_PER_PX).toFixed(1) + '°'
);
check(
    'oscillation: sine phase (moves toward increasing column first)',
    Math.abs(Math.atan2(c1, s1)) < (1 * Math.PI) / 180 && pos[1] >= 0 && pos[N / 4] === period
);
let harm = 0;
for (let h = 2; h <= 9; h++) harm = Math.max(harm, Math.hypot(...comp(h)));
check(
    'oscillation: harmonics 2..9 below 1 % of the amplitude',
    harm < 0.01 * period,
    harm.toFixed(3)
);
const rms = Math.sqrt(
    pos.reduce((a, p, k) => a + (p - period * Math.sin((2 * Math.PI * k) / N)) ** 2, 0) / N
);
check('oscillation: within 1/2 px RMS of the ideal sinusoid', rms < 0.5, rms.toFixed(3) + ' px');
const maxStep = Math.max(...pos.map((p, k) => Math.abs(pos[(k + 1) % N] - p)));
check('oscillation: never more than 1 px per frame (also across the wrap)', maxStep === 1);
check(
    'oscillation: peak speed 2π·f·A = 226°/s',
    Math.abs(2 * Math.PI * (1 / cycleS) * period * DEG_PER_PX - 226.2) < 0.1
);
check('pixel rows as the arena', grat.frames[0].length === PX_COLS * PX_ROWS);

// ── data browser family ──────────────────────────────────────────────────────
console.log('=== data browser ===');
const conds = exp.conditions.map((c) => c.name);
check(
    'classified generic, not the opto-LED optomotor family',
    A.protocolInfo({ protocol_filename: NAME + '.yaml' }, conds).family === 'generic' &&
        A.protocolInfo({ protocol_filename: NAME + '.yaml' }, []).family === 'generic'
);

console.log('\n=== Summary ===');
console.log(`${checks - failures} / ${checks} checks passed`);
process.exit(failures ? 1 : 0);
