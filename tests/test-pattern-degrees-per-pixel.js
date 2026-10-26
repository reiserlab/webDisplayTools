#!/usr/bin/env node
'use strict';

/**
 * Pattern Designer degrees-per-pixel regression (partial arenas).
 *
 * A partial arena keeps the FULL arena's pixel pitch: G4 3×12of18 has 12 of 18 columns
 * installed, 16 px per panel, so its pitch is 360° / (18 × 16) = 1.25°/px, not
 * 360° / (12 × 16) = 1.875°/px. The pattern generator already uses the full circle
 * (`numCircle = num_cols`); the editor's px↔° conversions must use the same pitch, or a
 * spatial period typed in pixels generates the wrong grating (24 px came out as 45°).
 *
 * The editor's helpers live inside pattern_editor.html's module script, so this test
 * extracts them by name and runs them against a stub `state`, together with the real
 * PatternGenerator and arena configs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { STANDARD_CONFIGS, PANEL_SPECS } = require('../js/arena-configs.js');
global.PANEL_SPECS = PANEL_SPECS;
const PatternGenerator = require('../js/pattern-editor/tools/generator.js');

const html = fs.readFileSync(path.join(ROOT, 'pattern_editor.html'), 'utf8');

let checks = 0;
let failures = 0;

function check(name, condition, detail) {
    checks++;
    if (condition) {
        console.log(`  PASS  ${name}`);
        return;
    }
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function near(a, b, tol = 1e-9) {
    return Number.isFinite(a) && Math.abs(a - b) <= tol;
}

/** Source of `function name(...) {...}` in the editor, by brace matching. */
function extractFunction(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`pattern_editor.html: function ${name} not found`);
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`pattern_editor.html: unbalanced braces in ${name}`);
}

const EDITOR_FUNCTIONS = [
    'getDegreesPerPixel',
    'convertSpatialFreqToRadians',
    'convertStepSizeToPixels',
    'convertStepSizeToRadians'
];

/** The editor's conversion helpers, bound to a stub state for one arena config. */
function editorFor(configName) {
    const sandbox = {
        PANEL_SPECS,
        PatternGenerator,
        Math,
        state: { arena: { config: configName ? STANDARD_CONFIGS[configName] : null } }
    };
    vm.createContext(sandbox);
    vm.runInContext(EDITOR_FUNCTIONS.map(extractFunction).join('\n'), sandbox);
    return sandbox;
}

function arenaFor(configName) {
    const a = STANDARD_CONFIGS[configName].arena;
    // Same object the editor's handleGenerate builds.
    return {
        generation: a.generation,
        rows: a.num_rows,
        cols: a.num_cols,
        columns_installed: a.columns_installed
    };
}

/** Expected pitch: full circumference = num_cols × pixels_per_panel around 360°. */
function expectedDegPerPx(configName) {
    const a = STANDARD_CONFIGS[configName].arena;
    return 360 / (a.num_cols * PANEL_SPECS[a.generation].pixels_per_panel);
}

console.log('\n=== editor getDegreesPerPixel: full circumference, every standard config ===');
const PINNED = {
    G4_3x12of18: 1.25, // 18 × 16 = 288 px around (12 installed)
    G6_3x12of18: 1.0, // 18 × 20 = 360 px around (12 installed)
    G6_2x8of10: 1.8, // 10 × 20 = 200 px around (8 installed)
    G6_2x10: 1.8,
    G6_3x10: 1.8,
    G6_4x10: 1.8,
    G6_3x16_full: 1.125,
    G4_3x12: 1.875,
    G4_4x12: 1.875,
    G41_2x12_cw: 1.875,
    G3_3x24: 1.875,
    G3_4x12: 3.75
};
for (const name of Object.keys(STANDARD_CONFIGS)) {
    const got = editorFor(name).getDegreesPerPixel();
    const want = PINNED[name] ?? expectedDegPerPx(name);
    check(`${name}: ${want}°/px`, near(got, want), `got ${got}`);
    check(
        `${name}: pinned value = 360 / (num_cols × px/panel)`,
        near(want, expectedDegPerPx(name))
    );
}
check(
    'no arena selected: G6 2×10 default 1.8°/px',
    near(editorFor(null).getDegreesPerPixel(), 1.8)
);

console.log('\n=== shared helper: PatternGenerator.getDegreesPerPixel ===');
check(
    'PatternGenerator.getDegreesPerPixel exists',
    typeof PatternGenerator.getDegreesPerPixel === 'function'
);
if (typeof PatternGenerator.getDegreesPerPixel === 'function') {
    for (const name of Object.keys(STANDARD_CONFIGS)) {
        const cfg = STANDARD_CONFIGS[name];
        check(
            `${name}: generator arena object`,
            near(PatternGenerator.getDegreesPerPixel(arenaFor(name)), expectedDegPerPx(name))
        );
        check(
            `${name}: raw config.arena (num_cols form)`,
            near(PatternGenerator.getDegreesPerPixel(cfg.arena), expectedDegPerPx(name))
        );
        check(
            `${name}: whole config ({arena: …} form)`,
            near(PatternGenerator.getDegreesPerPixel(cfg), expectedDegPerPx(name))
        );
    }
    const dims = PatternGenerator.getArenaDimensions(arenaFor('G4_3x12of18'));
    check('G4 12of18 dims: pattern is 192 px wide (installed)', dims.pixelCols === 192);
    check('G4 12of18 dims: 288 azimuth px (full circle)', dims.azimuthPixels === 288);
    check('G4 12of18 dims: circleCols = 18', dims.circleCols === 18);
}

console.log('\n=== px ↔ ° conversions on G4 3×12of18 (1.25°/px) ===');
{
    const ed = editorFor('G4_3x12of18');
    const rad = Math.PI / 180;
    check('24 px period = 30°', near(ed.convertSpatialFreqToRadians(24, 'px'), 30 * rad));
    check('30° period = 30°', near(ed.convertSpatialFreqToRadians(30, 'deg'), 30 * rad));
    check('1.25° step = 1 px', near(ed.convertStepSizeToPixels(1.25, 'deg'), 1));
    check('1 px step = 1 px', near(ed.convertStepSizeToPixels(1, 'px'), 1));
    check('1 px step = 1.25° (radians)', near(ed.convertStepSizeToRadians(1, 'px'), 1.25 * rad));
}

console.log('\n=== end to end: a period typed in px generates that period ===');
/**
 * Generate a rotation grating the way handleGenerate does and measure it: frame count
 * (= one period at a 1 px step) and the bright-run length along the middle row.
 */
function generateGrating(configName, spatialValue, spatialUnit, stepValue, stepUnit) {
    const ed = editorFor(configName);
    return PatternGenerator.generateSphericalGrating(
        {
            high: 15,
            low: 0,
            gsMode: 2,
            stretch: 1,
            spatFreq: ed.convertSpatialFreqToRadians(spatialValue, spatialUnit),
            motionType: 'rotation',
            waveform: 'square',
            dutyCycle: 50,
            stepSize: ed.convertStepSizeToPixels(stepValue, stepUnit),
            aaSamples: 1,
            arenaModel: 'smooth',
            phaseShift: 0,
            poleCoord: [0, -Math.PI / 2]
        },
        arenaFor(configName)
    );
}

function runLengths(pattern) {
    const row = Math.floor(pattern.pixelRows / 2);
    const f = pattern.frames[0];
    const vals = [];
    for (let c = 0; c < pattern.pixelCols; c++) vals.push(f[row * pattern.pixelCols + c] > 0);
    const runs = [];
    let len = 1;
    for (let c = 1; c < vals.length; c++) {
        if (vals[c] === vals[c - 1]) len++;
        else {
            runs.push(len);
            len = 1;
        }
    }
    runs.push(len);
    return runs.slice(1, -1); // interior runs only (the edges may be clipped)
}

const CASES = [
    // [config, value, unit, expected period px]
    ['G4_3x12of18', 24, 'px', 24],
    ['G4_3x12of18', 30, 'deg', 24],
    ['G6_3x12of18', 30, 'px', 30],
    ['G6_3x12of18', 30, 'deg', 30],
    ['G6_2x8of10', 20, 'px', 20],
    ['G6_2x8of10', 36, 'deg', 20],
    ['G6_2x10', 20, 'px', 20],
    ['G4_4x12', 24, 'px', 24]
];
for (const [name, value, unit, period] of CASES) {
    const pattern = generateGrating(name, value, unit, 1, 'px');
    const runs = runLengths(pattern);
    check(
        `${name}: ${value} ${unit} period → ${period} frames at a 1 px step`,
        pattern.numFrames === period,
        `got ${pattern.numFrames}`
    );
    check(
        `${name}: ${value} ${unit} period → ${period / 2}-px bars`,
        runs.length > 0 && runs.every((r) => r === period / 2),
        `runs ${JSON.stringify(runs)}`
    );
}
{
    const pattern = generateGrating('G4_3x12of18', 30, 'deg', 1.25, 'deg');
    check(
        'G4_3x12of18: 1.25° step on a 30° period → 24 frames',
        pattern.numFrames === 24,
        `got ${pattern.numFrames}`
    );
}

console.log('\n=== editor wiring ===');
check(
    'pattern_editor.html cache-busts generator.js (init calls the new helper)',
    /<script src="js\/pattern-editor\/tools\/generator\.js\?v=[^"]+"><\/script>/.test(html)
);
check(
    'getDegreesPerPixel delegates to the shared PatternGenerator helper',
    /PatternGenerator\.getDegreesPerPixel\(/.test(extractFunction('getDegreesPerPixel'))
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exit(1);
}
