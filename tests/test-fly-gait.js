#!/usr/bin/env node
/**
 * Tests for js/fly-gait.js — the replay 3D fly's walking model (Studio v0.90).
 *
 * Covers the 2-D drive (100 ms sliding forward-speed / yaw-rate average → cadence + duty),
 * the tripod phase relations, no-slip stance feet (they ride the ball surface), and the
 * three turning regimes NeuroMechFly v2 encodes with its left/right descending drive:
 * straight = equal strides, gentle turn = longer outer strides, in-place turn = inner
 * legs stepping backward.
 *
 * Run: node tests/test-fly-gait.js   (wired into `pixi run test`)
 */
'use strict';

const G = require('../js/fly-gait.js');

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
const close = (a, b, tol) => Math.abs(a - b) < (tol || 1e-9);

// ── the 2-D drive → cadence ─────────────────────────────────────────────────
console.log('=== gaitDrive (speed + turn → cadence) ===');
let d = G.gaitDrive(0, 0);
check('standing fly: walk 0', d.walk, 0);
d = G.gaitDrive(0.5, 0);
check('0.5 mm/s drift: still standing', d.walk, 0);
d = G.gaitDrive(10, 0);
check('10 mm/s: fully walking', d.walk, 1);
checkBool('10 mm/s: 6.5 Hz stepping', close(d.freq, 6.5), String(d.freq));
checkBool('10 mm/s: duty 1 − 45 ms·f', close(d.duty, 1 - 0.045 * 6.5), String(d.duty));
d = G.gaitDrive(20, 0);
checkBool(
    '20 mm/s: 11 Hz, tripod duty ≈ 0.5',
    close(d.freq, 11) && d.duty < 0.52,
    JSON.stringify(d)
);
checkBool('backward walking: same cadence as forward', close(G.gaitDrive(-10, 0).freq, 6.5));
d = G.gaitDrive(0, 4);
checkBool('in-place turn (4 rad/s) walks', d.walk === 1 && d.freq > 3, JSON.stringify(d));
let mono = true;
let lastF = 0;
let dutyOk = true;
let strideOk = true;
for (let v = 0; v <= 60; v += 0.5) {
    const x = G.gaitDrive(v, 0);
    if (x.freq < lastF - 1e-12) mono = false;
    lastF = x.freq;
    if (x.duty < 0.5 - 1e-12 || x.duty > 0.8 + 1e-12) dutyOk = false;
    const arc = ((x.speed / G.GAIT_BALL_RADIUS_MM) * x.duty) / x.freq;
    if (x.freq < 16 && arc > G.GAIT_MAX_STRIDE_RAD + 1e-9) strideOk = false;
}
checkBool('cadence never falls as speed rises', mono);
checkBool('duty stays within tripod..slow walk (0.5–0.8)', dutyOk);
checkBool('stance arc capped (cadence rises instead) below the max frequency', strideOk);

// ── the 100 ms sliding average + phase ──────────────────────────────────────
console.log('=== stepGait (100 ms window) ===');
const R = G.GAIT_BALL_RADIUS_MM;
function run(n, perSample, dtMs) {
    const g = G.createGait();
    for (let i = 0; i < n; i++) G.stepGait(g, i * (dtMs || 10), i ? perSample(i) : null);
    return g;
}
// 10 mm/s forward at 100 Hz: pitch −(10/4.5) rad/s → −0.0222… rad per sample.
const fwdStep = { yaw: 0, pitch: -(10 / R) * 0.01, roll: 0 };
let g = run(40, () => fwdStep);
checkBool(
    'forward speed = 10 mm/s once the window fills',
    close(g.forward, 10, 1e-9),
    String(g.forward)
);
checkBool('yaw rate 0 walking straight', close(g.yaw, 0));
checkBool('cadence follows the average (6.5 Hz)', close(g.freq, 6.5, 1e-9), String(g.freq));
const p0 = g.phase;
G.stepGait(g, 400, fwdStep);
checkBool(
    'phase advances freq × dt per sample',
    close((g.phase - p0 + 1) % 1, 0.065, 1e-9),
    String(g.phase - p0)
);
g = run(40, () => ({ yaw: 0, pitch: 0, roll: 0 }));
check('still ball: phase stays put, walk 0', [g.phase, g.walk], [0, 0]);
// A 60 ms burst then stillness: the average decays to zero 100 ms after the burst.
g = run(30, (i) => (i < 7 ? fwdStep : { yaw: 0, pitch: 0, roll: 0 }));
checkBool('the average forgets motion older than 100 ms', close(g.forward, 0), String(g.forward));
g = G.createGait();
G.stepGait(g, 0, null);
G.stepGait(g, 10, fwdStep);
G.stepGait(g, 20, fwdStep);
const before = g.phase;
G.stepGait(g, 600, null); // 580 ms gap (a dropped stretch)
checkBool('no phase advance across a >250 ms gap', close(g.phase, before), String(g.phase));
check('the gap also empties the window', g.win.length, 0);
const turnStep = { yaw: 0.03, pitch: 0, roll: 0 }; // 3 rad/s right turn
g = run(40, () => turnStep);
checkBool('yaw rate = 3 rad/s (right turn)', close(g.yaw, 3, 1e-9), String(g.yaw));
check('gaitState carries only numbers the viewer needs', Object.keys(G.gaitState(g)), [
    'phase',
    'yaw',
    'pitch',
    'freq',
    'duty',
    'walk'
]);

// ── tripod ──────────────────────────────────────────────────────────────────
console.log('=== tripod phase ===');
let groupsOk = true;
let alwaysSupported = true;
let halfCycle = true;
for (let k = 0; k < 400; k++) {
    const ph = k / 400;
    [0.5, 0.65, 0.8].forEach((duty) => {
        const st = {};
        G.LEGS.forEach((leg) => (st[leg] = G.legPhase(ph, leg, duty).stance));
        if (st.L1 !== st.R2 || st.R2 !== st.L3) groupsOk = false;
        if (st.R1 !== st.L2 || st.L2 !== st.R3) groupsOk = false;
        if (!st.L1 && !st.R1) alwaysSupported = false;
        if (duty === 0.5 && st.L1 === st.R1) halfCycle = false;
    });
}
checkBool('L1-R2-L3 and R1-L2-R3 each move as one tripod', groupsOk);
checkBool('at least one tripod is always on the ball (duty ≥ 0.5)', alwaysSupported);
checkBool('at duty 0.5 the tripods strictly alternate', halfCycle);

// ── feet on the ball ────────────────────────────────────────────────────────
console.log('=== feet (stance rides the ball) ===');
// The viewer's geometry (model units): ball radius 2.25, centre 0.72 below the thorax.
const BR = 2.25;
const C = [0, -BR - 0.72, 0];
function onBall(x, z) {
    return [x, C[1] + Math.sqrt(BR * BR - x * x - z * z), z];
}
const NEUTRAL = {
    L1: onBall(-0.8, 0.46),
    L2: onBall(-0.12, 0.62),
    L3: onBall(0.62, 0.5),
    R1: onBall(-0.8, -0.46),
    R2: onBall(-0.12, -0.62),
    R3: onBall(0.62, -0.5)
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

const r = G.rotateAbout([1, 0, 0], [0, 1, 0], Math.PI / 2);
checkBool(
    'rotateAbout is right-handed (+X about +Y by 90° → −Z)',
    close(r[0], 0) && close(r[2], -1)
);

function foot(leg, gaitLike, walk) {
    const s = G.footTau(gaitLike.phase, leg, gaitLike.duty, gaitLike.freq);
    return G.footPosition(NEUTRAL[leg], C, [0, gaitLike.yaw, gaitLike.pitch], s.tau, s.lift, {
        walk: walk === undefined ? 1 : walk,
        liftHeight: 0.16
    });
}
const walkFwd = { phase: 0.1, duty: 0.7, freq: 6.5, yaw: 0, pitch: -10 / R };
// No slip: in stance the foot moves exactly with the ball surface, v = ω × (p − c).
const eps = 1e-6;
const pa = foot('L1', walkFwd);
const pb = foot('L1', Object.assign({}, walkFwd, { phase: walkFwd.phase + eps }));
const vel = sub(pb, pa).map((x) => x / (eps / walkFwd.freq));
const surf = cross([0, walkFwd.yaw, walkFwd.pitch], sub(pa, C));
checkBool(
    'stance foot moves with the ball surface (no slip)',
    norm(sub(vel, surf)) < 1e-4 * norm(surf),
    JSON.stringify({ vel, surf })
);
checkBool('stance foot on the ball surface', close(norm(sub(pa, C)), BR, 1e-9));
const midSwing = Object.assign({}, walkFwd, { phase: 0.35 }); // R1: 0.85 → mid-swing
const swing = foot('R1', midSwing);
const lp = G.legPhase(midSwing.phase, 'R1', midSwing.duty);
checkBool(
    'swing foot lifts off the ball',
    !lp.stance && norm(sub(swing, C)) > BR + 0.05,
    String(norm(sub(swing, C)) - BR)
);
check('standing (walk 0): feet at rest', foot('L2', walkFwd, 0), NEUTRAL.L2);

// Stance stride of a leg: foot at lift-off minus foot at touch-down.
function stride(leg, gaitLike) {
    const off = G.TRIPOD_OFFSETS[leg];
    const at = (u) =>
        foot(leg, Object.assign({}, gaitLike, { phase: (u * gaitLike.duty - off + 2) % 1 }));
    return sub(at(0.999999), at(0));
}
function drive(forwardMmS, yawRadS) {
    const dr = G.gaitDrive(forwardMmS, yawRadS);
    return { phase: 0, duty: dr.duty, freq: dr.freq, yaw: yawRadS, pitch: -forwardMmS / R };
}

console.log('=== turning (NeuroMechFly v2 left/right drive regimes) ===');
let sL = stride('L2', drive(10, 0));
let sR = stride('R2', drive(10, 0));
checkBool(
    'straight: both mid legs push back (+X) with equal strides',
    sL[0] > 0 && close(sL[0], sR[0], 1e-9),
    `${sL[0].toFixed(4)} vs ${sR[0].toFixed(4)}`
);
sL = stride('L2', drive(10, 1));
sR = stride('R2', drive(10, 1));
checkBool(
    'gentle right turn: outer (left) stride longer than inner (right), both backward',
    sL[0] > sR[0] && sR[0] > 0,
    `L ${sL[0].toFixed(4)}  R ${sR[0].toFixed(4)}`
);
sL = stride('L2', drive(0, 4));
sR = stride('R2', drive(0, 4));
checkBool(
    'in-place right turn: inner (right) legs step BACKWARD, outer legs forward',
    sL[0] > 0 && sR[0] < 0,
    `L ${sL[0].toFixed(4)}  R ${sR[0].toFixed(4)}`
);
const s1 = stride('L1', drive(0, 4));
const s3 = stride('L3', drive(0, 4));
checkBool(
    'turning also sweeps the front feet left and the hind feet right (off the yaw axis)',
    s1[2] > 0 && s3[2] < 0,
    `L1 z ${s1[2].toFixed(4)}  L3 z ${s3[2].toFixed(4)}`
);
sL = stride('L2', drive(0, -4));
sR = stride('R2', drive(0, -4));
checkBool('left turn mirrors it (inner = left legs backward)', sL[0] < 0 && sR[0] > 0);
sL = stride('L2', drive(-8, 0));
checkBool('walking backward: stance feet move forward (−X)', sL[0] < 0);

// The stride cap (legs can only reach so far).
const huge = { phase: 0, duty: 0.8, freq: 3, yaw: 0, pitch: -40 };
const tau = G.footTau(0, 'L2', huge.duty, huge.freq);
const capped = [0, 0.999999].map((u) => {
    const t = G.footTau(u * huge.duty, 'L2', huge.duty, huge.freq);
    return G.footPosition(NEUTRAL.L2, C, [0, 0, huge.pitch], t.tau, 0, {
        stanceTime: tau.tSt,
        maxStride: 0.6
    });
});
checkBool(
    'stance arc capped at maxStride',
    norm(sub(capped[1], capped[0])) <= 0.6 + 1e-6,
    String(norm(sub(capped[1], capped[0])))
);

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
if (failures) process.exit(1);
