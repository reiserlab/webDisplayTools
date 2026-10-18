#!/usr/bin/env node
/**
 * test-studio-stream-geometry.js — js/studio-stream-geometry.js: where a Studio
 * test figure lands in a firmware-sized STREAM_FRAME. Regression cover for the
 * rc4 review blocker (2×8of10 shifted one panel / refused on pre-0xCB firmware).
 *
 *   pixi run node tests/test-studio-stream-geometry.js
 */
'use strict';

const SG = require('../js/studio-stream-geometry.js');
const AC = require('../js/arena-configs.js');

let failures = 0;
let total = 0;
function ok(name, cond, info) {
    total++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? ' — ' + info : ''}`);
    if (!cond) failures++;
}
const arena = (name) => AC.getConfig(name).arena;
// A figure that marks every grid panel with its 1-based number (pixel value = panel number).
function numbered(rig) {
    const g = new Uint8Array(rig.pixelRows * rig.pixelCols);
    for (let r = 0; r < rig.pixelRows; r++)
        for (let c = 0; c < rig.pixelCols; c++)
            g[r * rig.pixelCols + c] = Math.floor(r / 20) * rig.colCount + Math.floor(c / 20) + 1;
    return g;
}
const at = (grid, cols, pr, pc) => grid[(pr * 20 + 10) * cols * 20 + pc * 20 + 10]; // centre pixel of panel (pr, pc)

console.log('\n=== rigGeometry ===');
{
    const g = SG.rigGeometry(arena('G6_2x8of10'));
    ok(
        '2×8of10 keeps the FULL 2×10 grid',
        g.rowCount === 2 && g.colCount === 10 && g.pixelCols === 200
    );
    ok('2×8of10 installed = 1..8', g.installed.join(',') === '1,2,3,4,5,6,7,8');
    ok(
        'null arena → 2×10 default',
        SG.rigGeometry(null).colCount === 10 && SG.rigGeometry(null).installed.length === 10
    );
    const b = SG.rigGeometry(arena('G6_1x12of18'));
    ok(
        '1×12of18 full grid 1×18, installed 0..11',
        b.rowCount === 1 && b.colCount === 18 && b.installed[11] === 11
    );
    ok(
        'installedSpan 2×8of10 = px 20..180',
        SG.installedSpan(g).lo === 20 && SG.installedSpan(g).hi === 180
    );
}

console.log('\n=== 2×10 and 2×8of10 behave exactly as before ===');
for (const name of ['G6_2x10', 'G6_2x8of10']) {
    const rig = SG.rigGeometry(arena(name));
    const grid = numbered(rig);
    for (const fw of [null, { rows: 2, cols: 10 }]) {
        const t = SG.streamTarget(rig, fw);
        ok(
            name + ' on ' + (fw ? '2×10 firmware' : 'pre-0xCB firmware') + ': streamable as 2×10',
            t.ok && t.rows === 2 && t.cols === 10,
            t.reason
        );
        ok(
            name + ' ' + (fw ? '0xCB' : 'pre-0xCB') + ': identity (same array, no remap)',
            SG.toFirmwareGrid(grid, t) === grid && !SG.isMapped(t)
        );
    }
}
{
    // The rc4 bug: 2×8of10's first panel is physical column 1, not 0.
    const rig = SG.rigGeometry(arena('G6_2x8of10'));
    const out = SG.toFirmwareGrid(numbered(rig), SG.streamTarget(rig, { rows: 2, cols: 10 }));
    ok(
        '2×8of10: grid column 1 (first installed) lands on firmware column 1',
        at(out, 10, 0, 1) === 2 && at(out, 10, 0, 8) === 9
    );
}

console.log('\n=== 1×12of18 bench on the 4×12 arena_12-18 build ===');
{
    const rig = SG.rigGeometry(arena('G6_1x12of18'));
    const t = SG.streamTarget(rig, { rows: 4, cols: 12 });
    ok('streamable into 4×12', t.ok && t.rows === 4 && t.cols === 12 && SG.isMapped(t), t.reason);
    const out = SG.toFirmwareGrid(numbered(rig), t);
    ok('frame is 80×240 px', out.length === 80 * 240);
    ok(
        'column c → firmware column c (0 and 11)',
        at(out, 12, 0, 0) === 1 && at(out, 12, 0, 11) === 12
    );
    ok(
        'the one rig row is repeated in all 4 firmware rows',
        [0, 1, 2, 3].every((r) => at(out, 12, r, 5) === 6)
    );
    ok('pre-0xCB firmware: refused (not 20 panels)', !SG.streamTarget(rig, null).ok);
}

console.log('\n=== mismatches are refused with a reason ===');
{
    const rig = SG.rigGeometry(arena('G6_2x10'));
    const t = SG.streamTarget(rig, { rows: 1, cols: 12 });
    ok('2×10 rig on a 1-row build: refused', !t.ok && /streams 1×12/.test(t.reason), t.reason);
    const ring = SG.rigGeometry(arena('G6_3x10of14'));
    ok(
        '3×10of14 on 4×12: fits (installed 0..9 < 12, 3 ≤ 4 rows)',
        SG.streamTarget(ring, { rows: 4, cols: 12 }).ok
    );
    ok('3×10of14 on 2×10: refused (3 rows)', !SG.streamTarget(ring, { rows: 2, cols: 10 }).ok);
    const wide = SG.rigGeometry({ num_rows: 1, num_cols: 18, columns_installed: [0, 13] });
    ok(
        'an installed column beyond the firmware columns: refused',
        !SG.streamTarget(wide, { rows: 4, cols: 12 }).ok
    );
    ok(
        '2×10 rig on 4×10 firmware: streamable (rows repeated)',
        SG.streamTarget(rig, { rows: 4, cols: 10 }).ok
    );
}

console.log(`\n=== Summary ===\n${total - failures} / ${total} checks passed`);
process.exit(failures > 0 ? 1 : 0);
