#!/usr/bin/env node
/**
 * Tests for js/kinematics.js — the shared FicTrac kinematic derivations used by
 * BOTH the live oscilloscope and the offline analysis dashboard. Fixture-based
 * with KNOWN slopes so the two derivative paths (centralDiff / windowedDerived)
 * cannot silently diverge (oscilloscope-view-spec.md §3).
 *
 * Run: node tests/test-kinematics.js   (wired into `pixi run test`)
 */
'use strict';

const K = require('../js/kinematics.js');

let total = 0;
let failures = 0;
function approx(name, got, expected, tol) {
    total++;
    const t = tol == null ? 1e-9 : tol;
    const ok = got != null && Math.abs(got - expected) <= t;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}, expected ${expected} (±${t})`);
    if (!ok) failures++;
}
function checkBool(name, ok, info) {
    total++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

// ── angle helpers ────────────────────────────────────────────────────────────
console.log('=== wrap / unwrap ===');
approx('wrapToPi(0)', K.wrapToPi(0), 0);
approx('wrapToPi(2π)', K.wrapToPi(2 * Math.PI), 0, 1e-12);
approx('wrapToPi(3π/2) = -π/2', K.wrapToPi((3 * Math.PI) / 2), -Math.PI / 2, 1e-12);
approx('wrapToDeg180(190) = -170', K.wrapToDeg180(190), -170, 1e-9);
approx('wrapToDeg180(-190) = 170', K.wrapToDeg180(-190), 170, 1e-9);
approx('wrapToDeg180(180) = 180', K.wrapToDeg180(180), 180, 1e-9);
// unwrapDelta: shortest signed step, no spike across ±π.
approx('unwrapDelta small', K.unwrapDelta(0.2, 0.1), 0.1, 1e-12);
approx('unwrapDelta across +π wrap', K.unwrapDelta(-3.1, 3.1), 2 * Math.PI - 6.2, 1e-9);
// unwrap: a rising heading that crosses +π stays continuous (no 2π drop).
const uw = K.unwrap([3.0, 3.1, -3.08]);
checkBool(
    'unwrap continuous across wrap',
    uw[2] > uw[1] && uw[2] - uw[1] < 0.2,
    JSON.stringify(uw)
);

// ── OLS slope (known slope) ──────────────────────────────────────────────────
console.log('=== olsSlope ===');
approx('slope of y=3t+7', K.olsSlope([0, 1, 2, 3], [7, 10, 13, 16]), 3, 1e-9);
approx('slope with noise-free 2 pts', K.olsSlope([0, 2], [1, 5]), 2, 1e-9);
checkBool('slope null for <2 pts', K.olsSlope([1], [1]) === null);
checkBool('slope null for zero t-variance', K.olsSlope([2, 2, 2], [1, 2, 3]) === null);

// ── synthetic streams with KNOWN kinematics ──────────────────────────────────
// Straight-line walk: constant heading h0, constant forward speed vf (rad/s).
function straightLine(h0, vf, n, dtMs) {
    const s = [];
    for (let i = 0; i < n; i++) {
        const tMs = i * dtMs;
        const tS = tMs / 1000;
        s.push({
            ms: tMs,
            ft: tMs,
            fc: i + 1,
            idx: 0,
            x: vf * Math.cos(h0) * tS,
            y: vf * Math.sin(h0) * tS,
            hd: h0
        });
    }
    return s;
}
// Pure rotation at rate omega (rad/s), no translation.
function pureTurn(omega, n, dtMs) {
    const s = [];
    for (let i = 0; i < n; i++) {
        const tMs = i * dtMs;
        s.push({ ms: tMs, ft: tMs, fc: i + 1, idx: 0, x: 0, y: 0, hd: omega * (tMs / 1000) });
    }
    return s;
}

console.log('=== centralDiff: straight-line walk ===');
const h0 = 30 * K.DEG2RAD;
const vf = 2.0; // rad/s
const R = 4.5; // ball radius mm (9 mm dia)
const sl = straightLine(h0, vf, 200, 10); // 100 Hz, 2 s
const cd = K.centralDiff(sl, 100, { ballRadiusMm: R });
approx('forward_rad_s = vf', cd.forward_rad_s, vf, 1e-6);
approx('forward_mm_s = vf·R', cd.forward_mm_s, vf * R, 1e-6);
approx('side_rad_s ≈ 0', cd.side_rad_s, 0, 1e-6);
approx('turning_deg_s ≈ 0', cd.turning_deg_s, 0, 1e-6);
approx('speed_rad_s = vf', cd.speed_rad_s, vf, 1e-6);
approx('move_dir_deg = 30', cd.move_dir_deg, 30, 1e-6);
approx('heading_deg = 30', cd.heading_deg, 30, 1e-6);
checkBool('centralDiff null at first edge', K.centralDiff(sl, 0, {}) === null);
checkBool('centralDiff null at last edge', K.centralDiff(sl, sl.length - 1, {}) === null);

console.log('=== centralDiff: pure turn ===');
const omega = Math.PI; // rad/s = 180 deg/s
const pt = pureTurn(omega, 200, 10);
const cdt = K.centralDiff(pt, 100, { ballRadiusMm: R });
approx('turning_deg_s = 180', cdt.turning_deg_s, 180, 1e-6);
approx('turning_rad_s = π', cdt.turning_rad_s, Math.PI, 1e-6);
approx('forward ≈ 0 during pure turn', cdt.forward_rad_s, 0, 1e-9);
approx('speed ≈ 0 during pure turn', cdt.speed_rad_s, 0, 1e-9);

console.log('=== centralDiff: turning sign flip ===');
const cdtNeg = K.centralDiff(pt, 100, { turningSign: -1 });
approx('turningSign:-1 negates turning', cdtNeg.turning_deg_s, -180, 1e-6);

console.log('=== windowedDerived (smoothed live path) ===');
// Same straight-line data; a 0.25 s window centered at 1000 ms recovers vf.
const wd = K.windowedDerived(sl, 1000, { windowMs: 250, ballRadiusMm: R });
approx('windowed forward_rad_s = vf', wd.forward_rad_s, vf, 1e-6);
approx('windowed forward_mm_s = vf·R', wd.forward_mm_s, vf * R, 1e-6);
approx('windowed turning ≈ 0', wd.turning_deg_s, 0, 1e-6);
approx('windowed stamped at center', wd.t_ms, 1000, 1e-9);
// pure turn through the window recovers omega.
const wdt = K.windowedDerived(pt, 1000, { windowMs: 250 });
approx('windowed turning_deg_s = 180', wdt.turning_deg_s, 180, 1e-6);
// Gap rule: a window with <2 samples yields null (no bogus slope).
checkBool(
    'windowed null when window empty',
    K.windowedDerived(sl, 999999, { windowMs: 250 }) === null
);
const single = [{ ms: 500, ft: 500, x: 0, y: 0, hd: 0, fc: 1, idx: 0 }];
checkBool(
    'windowed null with a single sample',
    K.windowedDerived(single, 500, { windowMs: 250 }) === null
);

console.log('=== centralDiff vs windowedDerived agree on linear data ===');
// The two paths must not diverge: on noise-free linear motion both recover vf.
const cdMid = K.centralDiff(sl, 100, { ballRadiusMm: R });
const wdMid = K.windowedDerived(sl, sl[100].ms, { windowMs: 250, ballRadiusMm: R });
approx('forward agrees', wdMid.forward_rad_s, cdMid.forward_rad_s, 1e-6);
approx('turning agrees', wdMid.turning_deg_s, cdMid.turning_deg_s, 1e-6);

console.log('=== ballRadiusMm ===');
approx('default 9 mm dia → 4.5 mm radius', K.ballRadiusMm(), 4.5, 1e-12);
approx('12 mm dia → 6 mm radius', K.ballRadiusMm(12), 6, 1e-12);
approx('invalid dia → default 4.5', K.ballRadiusMm(0), 4.5, 1e-12);

console.log('\n=== Summary ===');
console.log(`${total - failures} / ${total} checks passed`);
process.exit(failures ? 1 : 0);
