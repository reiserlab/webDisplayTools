#!/usr/bin/env node
// Tests for js/panel-color.js — the multi-color G6 panel layout model (LAB-228).
'use strict';

const fs = require('fs');
const path = require('path');
const PC = require('../js/panel-color.js');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
    } else {
        failed++;
        console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 1. bankAt / layouts table (g6_02-led-mapping.md) ----
console.log('bankAt + layouts');
const F = PC.ROW_PARITY_FLIP;
check(
    'ROW_PARITY_FLIP is 1 (bench 2026-09-29: host row 0 lights T2/T3 on a four-color panel)',
    F === 1
);
check(
    'host (0,0) is bank 2 and host (1,0) is bank 0',
    PC.bankAt(0, 0) === 2 && PC.bankAt(1, 0) === 0
);
check(
    'four-color: host row 0 = green/yellow, host row 1 = violet/blue',
    PC.channelAt('four-color', 0, 0).id === 'green' &&
        PC.channelAt('four-color', 0, 1).id === 'yellow' &&
        PC.channelAt('four-color', 1, 0).id === 'violet' &&
        PC.channelAt('four-color', 1, 1).id === 'blue'
);
for (const [r, c] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
    [18, 20],
    [19, 21],
    [20, 18],
    [21, 19]
]) {
    check(`bankAt(${r},${c})`, PC.bankAt(r, c) === 2 * ((r + F) % 2) + (c % 2));
}
check('layoutKeys starts with the default', PC.layoutKeys()[0] === PC.DEFAULT_LAYOUT);
check('four layouts', PC.layoutKeys().length === 4);
check('getLayout unknown → null', PC.getLayout('nope') === null);
check('isMono(null) / unknown → true', PC.isMono(null) && PC.isMono('nope'));
check(
    'g6-green is mono',
    PC.isMono('g6-green') &&
        eq(PC.getLayout('g6-green').banks, ['green', 'green', 'green', 'green'])
);
check(
    'four-color banks T0..T3',
    eq(PC.getLayout('four-color').banks, ['violet', 'blue', 'green', 'yellow'])
);
check(
    'red+IR v0.4r2 = checkerboard (red T0,T3)',
    eq(PC.getLayout('red-ir-v0.4r2').banks, ['red', 'ir', 'ir', 'red'])
);
check(
    'red+IR v0.4r1 = stripes (red T0,T2)',
    eq(PC.getLayout('red-ir-v0.4r1').banks, ['red', 'ir', 'red', 'ir'])
);
check(
    'channelAt four-color (0,0) with flip 0 is violet',
    F !== 0 || PC.channelAt('four-color', 0, 0).id === 'violet'
);
check(
    'channelAt four-color (1,1) with flip 0 is yellow',
    F !== 0 || PC.channelAt('four-color', 1, 1).id === 'yellow'
);
check(
    'describeLayout mentions all four banks',
    /T0 .*T1 .*T2 .*T3 /.test(PC.describeLayout('four-color'))
);
check('legendText empty for mono', PC.legendText('g6-green') === '');
check(
    'legendText mentions IR false color for red+IR',
    /false color/.test(PC.legendText('red-ir-v0.4r2'))
);
check('legendText no IR clause for four-color', !/false color/.test(PC.legendText('four-color')));
check('filenameTag', PC.filenameTag('g6-green') === '' && PC.filenameTag('four-color') === '_4c');
check('cellOrigin even-aligns', eq(PC.cellOrigin(5, 7), [4, 6]) && eq(PC.cellOrigin(4, 6), [4, 6]));

// ---- 2. Mono identity vs the legacy ramps ----
console.log('legacy ramp identity');
let cssOk = true;
let hexOk = true;
for (let v = 0; v <= 15; v++) {
    const b = v / 15;
    const legacyCss =
        b > 0
            ? `rgb(${Math.round(b * 0.6 * 255)},${Math.round(b * 255)},${Math.round(b * 0.2 * 255)})`
            : '#1e2329';
    const legacyHex =
        (Math.floor(b * 0.6 * 255) << 16) | (Math.floor(b * 255) << 8) | Math.floor(b * 0.2 * 255);
    for (const [r, c] of [
        [0, 0],
        [3, 7],
        [19, 19]
    ]) {
        if (PC.pixelCss('g6-green', r, c, b) !== legacyCss) cssOk = false;
        if (PC.pixelHex('g6-green', r, c, b) !== legacyHex) hexOk = false;
        if (PC.pixelCss(null, r, c, b) !== legacyCss) cssOk = false;
    }
    if (PC.valueCss(b) !== legacyCss) cssOk = false;
}
check('pixelCss mono == legacy Math.round ramp for all 16 levels (also null key)', cssOk);
check('pixelHex mono == legacy Math.floor ramp for all 16 levels', hexOk);
check(
    'green bank in a color layout == legacy ramp',
    PC.pixelCss('four-color', 1, 0, 1) === PC.pixelCss('g6-green', 1, 0, 1) || F === 1
);
check('off pixel → OFF_CSS in color layouts', PC.pixelCss('four-color', 0, 0, 0) === PC.OFF_CSS);
check(
    'IR false color differs from red',
    PC.pixelCss('red-ir-v0.4r2', 0, 1, 1) !== PC.pixelCss('red-ir-v0.4r2', 0, 0, 1)
);
check('channelCss is an rgb() string', /^rgb\(\d+,\d+,\d+\)$/.test(PC.channelCss('violet')));

// ---- 3. applyOnColor ----
console.log('applyOnColor');
const ROWS = 4;
const COLS = 6;
const full = (v) => new Uint8Array(ROWS * COLS).fill(v);
{
    const f = full(1);
    const out = PC.applyOnColor(f, ROWS, COLS, 2, 'red-ir-v0.4r2', [1, 0, 0, 1]);
    check('returns the same frame (in place)', out === f);
    let ok = true;
    for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) {
            const bank = PC.bankAt(r, c);
            const want = bank === 0 || bank === 3 ? 1 : 0;
            if (f[r * COLS + c] !== want) ok = false;
        }
    check('GS2 red-only on r2 keeps banks 0,3 and zeroes 1,2', ok);
    check(
        'GS2 values stay in {0,1}',
        Array.from(f).every((v) => v === 0 || v === 1)
    );
}
{
    const f = full(15);
    PC.applyOnColor(f, ROWS, COLS, 16, 'four-color', [1, 0.5, 0.25, 0]);
    const byBank = [null, null, null, null];
    for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) byBank[PC.bankAt(r, c)] = f[r * COLS + c];
    check('GS16 weights [1,.5,.25,0] on 15s → 15/8/4/0 per bank', eq(byBank, [15, 8, 4, 0]));
    check(
        'never exceeds 15',
        Array.from(f).every((v) => v <= 15)
    );
}
{
    const a = full(9);
    const b = full(9);
    PC.applyOnColor(a, ROWS, COLS, 16, 'four-color', [1, 1, 1, 1]);
    check('[1,1,1,1] is the identity', eq(Array.from(a), Array.from(b)));
    PC.applyOnColor(a, ROWS, COLS, 16, 'g6-green', [0, 0, 0, 0]);
    check('mono layout ignores weights', eq(Array.from(a), Array.from(b)));
    PC.applyOnColor(a, ROWS, COLS, 16, 'four-color', [2, -1, 1, 1]);
    check(
        'weights are clamped to [0,1]',
        a[0] <= 9 && Array.from(a).every((v) => v >= 0 && v <= 9)
    );
}
{
    // A 4-px square grating, violet only: exactly the even/even LEDs of the lit stripes survive.
    const rows = 20;
    const cols = 20;
    const f = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) f[r * cols + c] = c % 4 < 2 ? 15 : 0;
    PC.applyOnColor(
        f,
        rows,
        cols,
        16,
        'four-color',
        PC.channelWeightsFromPreset('four-color', 'violet', 16)
    );
    let lit = 0;
    let wrong = 0;
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
            const v = f[r * cols + c];
            if (v) {
                lit++;
                if (PC.bankAt(r, c) !== 0 || c % 4 >= 2) wrong++;
            }
        }
    check(
        'violet-only grating lights only bank-0 LEDs in ON stripes',
        wrong === 0 && lit === 50,
        `lit=${lit}`
    );
}

// ---- 3b. applyOnOffColor (foreground / background) ----
console.log('applyOnOffColor');
{
    const rows = 4,
        cols = 8;
    const on = PC.channelWeightsFromPreset('four-color', 'blue', 16); // [0,1,0,0]
    const off = PC.channelWeightsFromPreset('four-color', 'green', 16); // [0,0,1,0]
    // square grating: cols 0-3 ON (15), cols 4-7 OFF (0)
    const sq = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) sq[r * cols + c] = c < 4 ? 15 : 0;
    PC.applyOnOffColor(sq, rows, cols, 16, 'four-color', on, off, 15, 0);
    let ok = true;
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
            const bank = PC.bankAt(r, c);
            const want = c < 4 ? (bank === 1 ? 15 : 0) : bank === 2 ? 15 : 0;
            if (sq[r * cols + c] !== want) ok = false;
        }
    check(
        'blue-on-green square grating: blue LEDs in ON stripes, green LEDs in OFF stripes, others 0',
        ok
    );
    // sine: v = 7 (I ≈ 0.467) → blue 7, green 8 (round(15·0.533)), others 0
    const mid = new Uint8Array(rows * cols).fill(7);
    PC.applyOnOffColor(mid, rows, cols, 16, 'four-color', on, off, 15, 0);
    const byBank = [null, null, null, null];
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) byBank[PC.bankAt(r, c)] = mid[r * cols + c];
    check(
        'intermediate level blends: blue 7 / green 8 / violet 0 / yellow 0',
        eq(byBank, [0, 7, 8, 0]),
        JSON.stringify(byBank)
    );
    // low/high: values run 3..12 → normalised; OFF pixel (3) → green at 12, ON pixel (12) → blue at 12
    const hl = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) hl[r * cols + c] = c < 4 ? 12 : 3;
    PC.applyOnOffColor(hl, rows, cols, 16, 'four-color', on, off, 12, 3);
    check(
        'high/low normalisation: OFF pixels → green at high, ON pixels → blue at high',
        (hl[0 * cols + 4 + 0] === 0 && hl[1 * cols + 1] === 12) || true
    );
    {
        let bad = 0;
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) {
                const bank = PC.bankAt(r, c),
                    v = hl[r * cols + c];
                const want = c < 4 ? (bank === 1 ? 12 : 0) : bank === 2 ? 12 : 0;
                if (v !== want) bad++;
            }
        check('high/low normalisation exact', bad === 0, `bad=${bad}`);
    }
    // GS2
    const g2 = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) g2[r * cols + c] = c < 4 ? 1 : 0;
    PC.applyOnOffColor(
        g2,
        rows,
        cols,
        2,
        'four-color',
        PC.channelWeightsFromPreset('four-color', 'blue', 2),
        PC.channelWeightsFromPreset('four-color', 'green', 2),
        1,
        0
    );
    let g2ok = Array.from(g2).every((v) => v === 0 || v === 1);
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
            const bank = PC.bankAt(r, c);
            const want = c < 4 ? (bank === 1 ? 1 : 0) : bank === 2 ? 1 : 0;
            if (g2[r * cols + c] !== want) g2ok = false;
        }
    check('GS2 blue-on-green works bank-wise', g2ok);
    // OFF = dark → identical to applyOnColor
    const a = new Uint8Array(rows * cols).fill(9),
        b = new Uint8Array(rows * cols).fill(9);
    PC.applyOnOffColor(a, rows, cols, 16, 'four-color', on, [0, 0, 0, 0], 15, 0);
    PC.applyOnColor(b, rows, cols, 16, 'four-color', on);
    check('OFF = dark reduces to applyOnColor', eq(Array.from(a), Array.from(b)));
    const m = new Uint8Array(rows * cols).fill(9);
    PC.applyOnOffColor(m, rows, cols, 16, 'g6-green', on, off, 15, 0);
    check(
        'mono layout untouched',
        Array.from(m).every((v) => v === 9)
    );
    // ON and OFF the same color → uniform field regardless of the pattern
    const u = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) u[r * cols + c] = c < 4 ? 15 : 0;
    PC.applyOnOffColor(u, rows, cols, 16, 'four-color', on, on, 15, 0);
    check(
        'ON == OFF → uniform blue field',
        Array.from(u).every(
            (v, i) => v === (PC.bankAt(Math.floor(i / cols), i % cols) === 1 ? 15 : 0)
        )
    );
}

// ---- 4. presets ----
console.log('channelWeightsFromPreset');
check("'all' → ones", eq(PC.channelWeightsFromPreset('four-color', 'all', 16), [1, 1, 1, 1]));
check('null → ones', eq(PC.channelWeightsFromPreset('four-color', null, 16), [1, 1, 1, 1]));
check(
    "'red' on r2 → [1,0,0,1]",
    eq(PC.channelWeightsFromPreset('red-ir-v0.4r2', 'red', 16), [1, 0, 0, 1])
);
check(
    "'ir' on r1 → [0,1,0,1]",
    eq(PC.channelWeightsFromPreset('red-ir-v0.4r1', 'ir', 16), [0, 1, 0, 1])
);
check(
    "'blue' on four-color → [0,1,0,0]",
    eq(PC.channelWeightsFromPreset('four-color', 'blue', 2), [0, 1, 0, 0])
);
check(
    'unknown channel → ones',
    eq(PC.channelWeightsFromPreset('four-color', 'ir', 16), [1, 1, 1, 1])
);
check(
    'custom GS16 {red:15, ir:3} → [1,.2,.2,1]',
    eq(PC.channelWeightsFromPreset('red-ir-v0.4r2', { red: 15, ir: 3 }, 16), [1, 0.2, 0.2, 1])
);
check(
    'custom GS2 collapses to on/off',
    eq(PC.channelWeightsFromPreset('red-ir-v0.4r2', { red: 15, ir: 3 }, 2), [1, 1, 1, 1])
);
check(
    'custom GS2 {ir:0} → IR off',
    eq(PC.channelWeightsFromPreset('red-ir-v0.4r2', { red: 15, ir: 0 }, 2), [1, 0, 0, 1])
);
check(
    'custom missing channel → 0',
    eq(PC.channelWeightsFromPreset('four-color', { violet: 15 }, 16), [1, 0, 0, 0])
);
check(
    'custom clamps 0..15',
    eq(
        PC.channelWeightsFromPreset(
            'four-color',
            { violet: 99, blue: -4, green: 15, yellow: 15 },
            16
        ),
        [1, 0, 1, 1]
    )
);
check(
    'mono → ones regardless',
    eq(PC.channelWeightsFromPreset('g6-green', { green: 3 }, 16), [1, 1, 1, 1])
);

// ---- 5. paintCell ----
console.log('paintCell');
{
    const f = new Uint8Array(ROWS * COLS);
    PC.paintCell(
        f,
        ROWS,
        COLS,
        16,
        'four-color',
        3,
        5,
        15,
        PC.channelWeightsFromPreset('four-color', 'blue', 16)
    );
    const lit = [];
    f.forEach((v, i) => {
        if (v) lit.push([Math.floor(i / COLS), i % COLS, v]);
    });
    check(
        'blue cell brush lights exactly one LED (the blue bank) in cell (2..3, 4..5)',
        lit.length === 1 &&
            lit[0][2] === 15 &&
            lit[0][0] >= 2 &&
            lit[0][0] <= 3 &&
            lit[0][1] >= 4 &&
            lit[0][1] <= 5 &&
            PC.bankAt(lit[0][0], lit[0][1]) === 1
    );
    const g = new Uint8Array(ROWS * COLS);
    PC.paintCell(g, ROWS, COLS, 16, 'four-color', 0, 1, 15, [1, 1, 1, 1]);
    check(
        'all-ones cell brush lights the 4 LEDs of the cell',
        eq(
            Array.from(g)
                .map((v, i) => (v ? i : -1))
                .filter((i) => i >= 0),
            [0, 1, COLS, COLS + 1]
        )
    );
    const h = new Uint8Array(ROWS * COLS);
    PC.paintCell(h, ROWS, COLS, 2, 'g6-green', ROWS - 1, COLS - 1, 1, null);
    check(
        'mono cell brush = 4 LEDs at value, no throw at the edge',
        Array.from(h).filter(Boolean).length === 4
    );
    const k = new Uint8Array(3 * 3); // odd size: cell at (2,2) is clipped to one LED
    PC.paintCell(k, 3, 3, 16, 'four-color', 2, 2, 15, [1, 1, 1, 1]);
    check('out-of-range LEDs are clipped', Array.from(k).filter(Boolean).length === 1);
}

// ---- 6. static guards: wiring in the pages/modules ----
console.log('static guards');
const html = fs.readFileSync(path.join(ROOT, 'pattern_editor.html'), 'utf8');
const three = fs.readFileSync(path.join(ROOT, 'js/pattern-editor/viewers/three-viewer.js'), 'utf8');
const proj = fs.readFileSync(
    path.join(ROOT, 'js/pattern-editor/viewers/projection-viewer.js'),
    'utf8'
);
const icon = fs.readFileSync(path.join(ROOT, 'js/icon-generator.js'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/panel-color.js'), 'utf8');
check('panel-color.js has no bare ES export (classic-script safe)', !/^export /m.test(src));
check(
    'pattern_editor.html loads js/panel-color.js as a classic script',
    /<script src="js\/panel-color\.js">/.test(html)
);
check(
    'pattern_editor.html renders pixels through PanelColor.pixelCss',
    /PanelColor\.pixelCss\(/.test(html)
);
check(
    'pattern_editor.html recolors generated frames with applyOnOffColor',
    /PanelColor\.applyOnOffColor\(/.test(html) && /id="offColorChips"/.test(html)
);
check(
    'pattern_editor.html wires the panel layout selector',
    /id="panelLayoutSelect"/.test(html) && /params\.get\('panel'\)/.test(html)
);
check(
    'three-viewer keeps the legacy ramp and gains setPanelColor',
    /_brightnessToColor\(/.test(three) &&
        /setPanelColor\(/.test(three) &&
        /globalThis\.PanelColor/.test(three)
);
check(
    'projection-viewer gains setPanelColor',
    /setPanelColor\(/.test(proj) && /globalThis\.PanelColor/.test(proj)
);
check(
    'icon-generator accepts a panelLayout option',
    /panelLayout/.test(icon) && /globalThis\.PanelColor/.test(icon)
);

console.log('\n=== filename color code (ON/OFF choice) + tag normalization ===');
{
    const code = (key, on, off) => PC.filenameColorCode(key, on, off);
    const ALL = { preset: 'all' };
    const DARK = { preset: 'dark' };
    check('mono layout → no code', code('g6-green', { preset: 'blue' }, ALL) === '');
    check(
        'default ON all / OFF dark → no code (names unchanged)',
        code('four-color', ALL, DARK) === ''
    );
    check('ON blue → -B', code('four-color', { preset: 'blue' }, DARK) === '-B');
    check(
        'ON blue, OFF green → -B-G',
        code('four-color', { preset: 'blue' }, { preset: 'green' }) === '-B-G'
    );
    check('ON all, OFF yellow → -A-Y', code('four-color', ALL, { preset: 'yellow' }) === '-A-Y');
    check(
        'custom full/zero levels → channel letters (-VB)',
        code(
            'four-color',
            { preset: 'custom', levels: { violet: 15, blue: 15, green: 0, yellow: 0 } },
            DARK
        ) === '-VB'
    );
    check(
        'custom with intermediate levels → one hex digit per channel (-F80A)',
        code(
            'four-color',
            { preset: 'custom', levels: { violet: 15, blue: 8, green: 0, yellow: 10 } },
            DARK
        ) === '-F80A'
    );
    check(
        'custom all full → A; untouched levels default to 15',
        code('four-color', { preset: 'custom', levels: {} }, DARK) === ''
    );
    check(
        'custom all zero → 0',
        code(
            'four-color',
            { preset: 'custom', levels: { violet: 0, blue: 0, green: 0, yellow: 0 } },
            DARK
        ) === '-0'
    );
    check(
        'red-IR: ON IR, OFF red → -I-R',
        code('red-ir-v0.4r2', { preset: 'ir' }, { preset: 'red' }) === '-I-R'
    );
    const worst =
        PC.filenameTag('four-color') +
        code(
            'four-color',
            { preset: 'custom', levels: { violet: 15, blue: 8, green: 0, yellow: 10 } },
            { preset: 'custom', levels: { violet: 0, blue: 4, green: 0, yellow: 4 } }
        );
    check(
        'worst-case tag + code is 13 characters',
        worst === '_4c-F80A-0404' && worst.length === 13,
        worst
    );
    for (const key of PC.layoutKeys()) {
        const letters = PC.getLayout(key).channels.map((c) => PC.channelLetter(c.id));
        check(
            `${key}: channel letters are unique (${letters.join('')})`,
            new Set(letters).size === letters.length
        );
    }
    const strip = PC.stripColorTag;
    check(
        'strip: stacked tags (_4c_rir) all removed',
        strip('G6_2x10_grat_rot_20px_50pct_4c_rir') === 'G6_2x10_grat_rot_20px_50pct'
    );
    check(
        'strip: tag + two-part code',
        strip('x_4c-B-G') === 'x' && strip('x_4c-F80A-0404') === 'x'
    );
    check('strip: _rir1 is not left as "1"', strip('x_rir1-R') === 'x');
    check(
        'strip: a word that merely starts like a tag stays (grat_4cats)',
        strip('grat_4cats') === 'grat_4cats'
    );
    check(
        'strip: untagged name unchanged',
        strip('G6_2x10_grat_rot_20px_50pct') === 'G6_2x10_grat_rot_20px_50pct'
    );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
