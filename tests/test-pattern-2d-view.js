#!/usr/bin/env node
'use strict';

/**
 * Pattern Designer 2D view on partial arenas: physical panel numbers and the azimuth axis.
 *
 * - Panel numbers must name the PHYSICAL panel, the same as the 3D overlay: a partial PAT
 *   stores only the installed columns, so pattern block k sits on columns_installed[k]
 *   (G6_2x8of10: block 0 = column 1 = panels 2 / 12, not 1 / 11).
 * - The azimuth axis uses pattern coordinates (generator, Mollweide view): 0° at the middle of
 *   the pattern = straight ahead, negative to the fly's left.
 *
 * physicalPanelNumber / azimuthTicks / getDegreesPerPixel are extracted from
 * pattern_editor.html and run against the real arena configs and ArenaGeometry.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { STANDARD_CONFIGS, PANEL_SPECS } = require('../js/arena-configs.js');
global.PANEL_SPECS = PANEL_SPECS;
const PatternGenerator = require('../js/pattern-editor/tools/generator.js');
const AG = require('../js/arena-geometry.js');

const html = fs.readFileSync(path.join(ROOT, 'pattern_editor.html'), 'utf8');
const viewer = fs.readFileSync(
    path.join(ROOT, 'js', 'pattern-editor', 'viewers', 'three-viewer.js'),
    'utf8'
);

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

function editorFor(configName) {
    const sandbox = {
        PANEL_SPECS,
        PatternGenerator,
        Math,
        state: { arena: { config: configName ? STANDARD_CONFIGS[configName] : null } }
    };
    vm.createContext(sandbox);
    vm.runInContext(
        ['physicalPanelNumber', 'azimuthTicks', 'getDegreesPerPixel']
            .map(extractFunction)
            .join('\n'),
        sandbox
    );
    return sandbox;
}

/** The 3D overlay's numbering for a PHYSICAL column (three-viewer.js _createColumn labels). */
function viewerPanelNumber(arena, physCol, row) {
    return arena.generation === 'G6'
        ? row * arena.num_cols + physCol + 1
        : physCol * arena.num_rows + row + 1;
}

console.log('\n=== 2D panel numbers name the physical panel (same as the 3D overlay) ===');
check(
    '3D overlay numbering is still row-major for G6 / column-major otherwise',
    /row \* numCols \+ colIndex \+ 1/.test(viewer) && /colIndex \* numRows \+ row \+ 1/.test(viewer)
);
{
    const ed = editorFor(null);
    const a = STANDARD_CONFIGS.G6_2x8of10.arena;
    check(
        'G6_2x8of10: first pattern panel, bottom row = panel 2',
        ed.physicalPanelNumber(a, 0, 0) === 2
    );
    check(
        'G6_2x8of10: first pattern panel, top row = panel 12',
        ed.physicalPanelNumber(a, 0, 1) === 12
    );
    check(
        'G6_2x8of10: last pattern panel, bottom row = panel 9',
        ed.physicalPanelNumber(a, 7, 0) === 9
    );
    const full = STANDARD_CONFIGS.G6_2x10.arena;
    check(
        'G6_2x10: first panel bottom/top = 1 / 11',
        ed.physicalPanelNumber(full, 0, 0) === 1 && ed.physicalPanelNumber(full, 0, 1) === 11
    );
    const g4 = STANDARD_CONFIGS.G4_3x12of18.arena;
    check(
        'a block past the installed list labels its own number, never NaN',
        ed.physicalPanelNumber(a, 9, 0) === 10
    );
    check(
        'G4_3x12of18 (column-major): first column = panels 1, 2, 3',
        [0, 1, 2].every((r) => ed.physicalPanelNumber(g4, 0, r) === r + 1)
    );
}
for (const [name, cfg] of Object.entries(STANDARD_CONFIGS)) {
    const a = cfg.arena;
    const ed = editorFor(name);
    const installed = a.columns_installed || [...Array(a.num_cols).keys()];
    const bad = [];
    installed.forEach((physCol, block) => {
        for (let row = 0; row < a.num_rows; row++) {
            const got = ed.physicalPanelNumber(a, block, row);
            const want = viewerPanelNumber(a, physCol, row);
            if (got !== want) bad.push(`block ${block} row ${row}: ${got} != ${want}`);
        }
    });
    check(
        `${name}: every 2D panel number equals the 3D overlay's`,
        bad.length === 0,
        bad.slice(0, 3).join('; ')
    );
}

console.log('\n=== azimuth axis: 0° at the middle, same coordinates as the Mollweide view ===');
const SPANS = { G4_3x12of18: 120, G6_3x12of18: 120, G6_2x8of10: 144, G6_2x10: 180, G4_4x12: 180 };
for (const [name, cfg] of Object.entries(STANDARD_CONFIGS)) {
    const a = cfg.arena;
    const ed = editorFor(name);
    const ppp = PANEL_SPECS[a.generation].pixels_per_panel;
    const installed = a.columns_installed || [...Array(a.num_cols).keys()];
    const W = installed.length * ppp;
    const dpp = ed.getDegreesPerPixel();
    const ticks = ed.azimuthTicks(W, dpp, 10);
    const zero = ticks.find((t) => t.deg === 0);
    check(`${name}: 0° tick at the middle of the pattern`, zero && Math.abs(zero.x - W / 2) < 1e-9);
    check(
        `${name}: ticks stay inside the pattern`,
        ticks.every((t) => t.x >= -1e-9 && t.x <= W + 1e-9)
    );
    if (SPANS[name] !== undefined) {
        check(
            `${name}: pattern spans ±${SPANS[name]}°`,
            Math.abs((W * dpp) / 2 - SPANS[name]) < 1e-9
        );
    }
    // Mollweide/projection longitude of pixel-column centres (projection-viewer.js)
    const co = AG.arenaCoordinates({
        panelSize: ppp,
        numCols: installed.length,
        numRows: a.num_rows,
        numCircle: a.num_cols,
        model: 'smooth'
    });
    const phi = AG.cart2sphere(co.x, co.y, co.z).phi[Math.floor(co.rows / 2)];
    const bad = [];
    for (const c of [0, Math.floor(W / 3), W - 1]) {
        const tickAz = (c + 0.5 - W / 2) * dpp; // the axis's azimuth at this column centre
        const lon = (phi[c] * 180) / Math.PI;
        if (Math.abs(tickAz - lon) > 0.01)
            bad.push(`col ${c}: axis ${tickAz.toFixed(2)} vs Mollweide ${lon.toFixed(2)}`);
    }
    check(`${name}: axis azimuth = Mollweide longitude`, bad.length === 0, bad.join('; '));
}
{
    const ed = editorFor('G4_3x12of18');
    const deg = ed.azimuthTicks(192, 1.25, 20).map((t) => t.deg);
    check(
        'G4_3x12of18 ticks (≥20 px apart): −120 … +120 every 30°',
        JSON.stringify(deg) === JSON.stringify([-120, -90, -60, -30, 0, 30, 60, 90, 120]),
        JSON.stringify(deg)
    );
}

console.log('\n=== wiring ===');
check(
    'the 2D overlay labels panels through physicalPanelNumber',
    /physicalPanelNumber\(arena, pc, pr\)/.test(extractFunction('renderGridViewer'))
);
check(
    'the 2D view draws the azimuth axis',
    /drawAzimuthAxis\(canvas, pixelCols, pixelSize\)/.test(extractFunction('renderGridViewer'))
);
check(
    'the axis is its own canvas (edit-mode hit-testing reads gridCanvas only)',
    /axis\.id = 'gridAzimuthAxis'/.test(extractFunction('drawAzimuthAxis'))
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exit(1);
}
