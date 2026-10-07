#!/usr/bin/env node
'use strict';

/**
 * ThreeViewer PAT lookup on partial arenas.
 *
 * A partial arena's PAT stores only the installed columns, in columns_installed order:
 * pattern panel block k is physical column columns_installed[k] (the icon generator's
 * convention). The 3D viewer used the PHYSICAL column as the block, so G6_2x8of10
 * (columns 1–8) showed the pattern one panel to the side, and physical column 8 read
 * block 0 of the NEXT pixel row.
 *
 * three-viewer.js imports Three.js from a CDN, so it is loaded here with those imports
 * stubbed out; the methods under test never touch THREE.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const { STANDARD_CONFIGS, PANEL_SPECS } = require('../js/arena-configs.js');

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

async function loadThreeViewer() {
    const src = fs.readFileSync(
        path.join(ROOT, 'js', 'pattern-editor', 'viewers', 'three-viewer.js'),
        'utf8'
    );
    const stubbed = src.replace(
        /^import[\s\S]*?CSS2DRenderer\.js';\n/m,
        'const THREE = {};\nconst OrbitControls = null;\n' +
            'const CSS2DRenderer = null;\nconst CSS2DObject = null;\n'
    );
    if (stubbed === src) throw new Error('three-viewer.js: Three.js import block not found');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-viewer-'));
    const file = path.join(dir, 'three-viewer.mjs');
    fs.writeFileSync(file, stubbed);
    try {
        return (await import(pathToFileURL(file).href)).default;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** A viewer instance with just the state the PAT lookup reads. */
function viewerFor(ThreeViewer, configName, pattern) {
    const viewer = Object.create(ThreeViewer.prototype);
    viewer.arenaConfig = STANDARD_CONFIGS[configName];
    viewer.state = { pattern, currentFrame: 0, phaseOffset: 0 };
    return viewer;
}

/**
 * A PAT-sized frame whose every pixel encodes where it came from:
 * value = (row % 2) * 100 + block + 1, so a wrong block OR a row spill is visible.
 */
function labelledPattern(arena) {
    const ppp = PANEL_SPECS[arena.generation].pixels_per_panel;
    const blocks = arena.columns_installed ? arena.columns_installed.length : arena.num_cols;
    const pixelCols = blocks * ppp;
    const pixelRows = arena.num_rows * ppp;
    const frame = new Uint8Array(pixelCols * pixelRows);
    for (let r = 0; r < pixelRows; r++) {
        for (let c = 0; c < pixelCols; c++) {
            frame[r * pixelCols + c] = (r % 2) * 100 + Math.floor(c / ppp) + 1;
        }
    }
    return { frames: [frame], pixelCols, pixelRows, gsMode: 16, numFrames: 1 };
}

(async () => {
    const ThreeViewer = await loadThreeViewer();

    console.log('\n=== physical column -> PAT panel block ===');
    {
        const map = viewerFor(ThreeViewer, 'G6_2x8of10', null)._getPatternColumnMap();
        check('G6_2x8of10: physical column 1 is block 0', map.get(1) === 0);
        check('G6_2x8of10: physical column 8 is block 7', map.get(8) === 7);
        check('G6_2x8of10: the gap columns 0 and 9 have no block', !map.has(0) && !map.has(9));
        const g4 = viewerFor(ThreeViewer, 'G4_3x12of18', null)._getPatternColumnMap();
        check(
            'G4_3x12of18: columns 0..11 map to blocks 0..11',
            [...Array(12).keys()].every((c) => g4.get(c) === c) && g4.size === 12
        );
        const full = viewerFor(ThreeViewer, 'G6_2x10', null)._getPatternColumnMap();
        check(
            'G6_2x10 (full; CSHL gap is preview-only): identity over all 10 columns',
            [...Array(10).keys()].every((c) => full.get(c) === c) && full.size === 10
        );
    }

    console.log('\n=== every LED reads its own block and row, every standard config ===');
    for (const name of Object.keys(STANDARD_CONFIGS)) {
        const arena = STANDARD_CONFIGS[name].arena;
        const ppp = PANEL_SPECS[arena.generation].pixels_per_panel;
        const pattern = labelledPattern(arena);
        const viewer = viewerFor(ThreeViewer, name, pattern);
        const installed = arena.columns_installed || [...Array(arena.num_cols).keys()];
        const bad = [];
        for (const col of viewer._getVisibleColumnsSet()) {
            const block = installed.indexOf(col);
            for (const px of [0, ppp - 1]) {
                for (const py of [0, pattern.pixelRows - 1]) {
                    const ledRef = {
                        colIndex: col,
                        patternCol: viewer._getPatternColumnMap().get(col),
                        px,
                        py,
                        totalPixelsH: ppp,
                        numCols: arena.num_cols,
                        numRows: arena.num_rows,
                        columnOrder: arena.column_order || 'cw'
                    };
                    const got = Math.round(viewer._getLEDBrightness(ledRef) * 15);
                    const want = (py % 2) * 100 + block + 1;
                    if (got !== want) bad.push(`col ${col} px ${px} py ${py}: ${got} != ${want}`);
                }
            }
        }
        check(
            `${name}: LEDs show their own panel block`,
            bad.length === 0,
            bad.slice(0, 3).join('; ')
        );
    }

    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
        console.log(`${failures} FAILED`);
        process.exit(1);
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
