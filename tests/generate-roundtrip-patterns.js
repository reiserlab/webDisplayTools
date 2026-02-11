#!/usr/bin/env node
/**
 * Generate Reference Patterns for Web → MATLAB Roundtrip Testing
 *
 * Creates deterministic .pat files using PatEncoder, then self-verifies
 * by parsing with PatParser. Writes files + JSON manifest to output dir.
 *
 * Usage:
 *   node tests/generate-roundtrip-patterns.js --outdir ../../maDisplayTools/tests/web_generated_patterns
 *
 * Test matrix: 8 patterns covering G4, G4.1, G6 × GS2/GS16 × full/partial arenas
 * Each pattern has 16-20 frames of full-cycle periodic motion.
 */

const fs = require('fs');
const path = require('path');

// Import modules
const _patParser = require('../js/pat-parser.js');
const PatParser = _patParser.default || _patParser;
const PatEncoder = require('../js/pat-encoder.js');
const { getArenaId } = require('../js/arena-configs.js');

// Parse command-line args
const args = process.argv.slice(2);
let outDir = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--outdir' && args[i + 1]) {
        outDir = path.resolve(args[i + 1]);
    }
}
if (!outDir) {
    console.error('Usage: node generate-roundtrip-patterns.js --outdir <path>');
    process.exit(1);
}

// Ensure output directory exists
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

// ─── Pattern generation functions ───────────────────────────────────────────

/**
 * Square grating: alternating ON/OFF vertical stripes
 * pixel[r][c] = ((c + shift) % period < period/2) ? maxVal : 0
 */
function squareGrating(pixelRows, pixelCols, period, shift, maxVal) {
    const frame = new Uint8Array(pixelRows * pixelCols);
    for (let r = 0; r < pixelRows; r++) {
        for (let c = 0; c < pixelCols; c++) {
            const phase = ((c + shift) % period + period) % period;  // handle negative shift
            frame[r * pixelCols + c] = phase < period / 2 ? maxVal : 0;
        }
    }
    return frame;
}

/**
 * Sine grating: smooth sinusoidal vertical pattern
 * pixel[r][c] = round(maxVal * (0.5 + 0.5 * sin(2π * (c + shift) / period)))
 */
function sineGrating(pixelRows, pixelCols, period, shift, maxVal) {
    const frame = new Uint8Array(pixelRows * pixelCols);
    for (let r = 0; r < pixelRows; r++) {
        for (let c = 0; c < pixelCols; c++) {
            const val = Math.round(maxVal * (0.5 + 0.5 * Math.sin(2 * Math.PI * (c + shift) / period)));
            frame[r * pixelCols + c] = Math.min(maxVal, Math.max(0, val));
        }
    }
    return frame;
}

/**
 * Horizontal square grating: alternating ON/OFF horizontal stripes
 * pixel[r][c] = ((r + shift) % period < period/2) ? maxVal : 0
 */
function horizontalGrating(pixelRows, pixelCols, period, shift, maxVal) {
    const frame = new Uint8Array(pixelRows * pixelCols);
    for (let r = 0; r < pixelRows; r++) {
        const phase = ((r + shift) % period + period) % period;
        const val = phase < period / 2 ? maxVal : 0;
        for (let c = 0; c < pixelCols; c++) {
            frame[r * pixelCols + c] = val;
        }
    }
    return frame;
}

/**
 * Checkerboard: alternating blocks with horizontal motion
 * pixel[r][c] = ((floor((r+shift)/block) + floor(c/block)) % 2) ? maxVal : 0
 */
function checkerboard(pixelRows, pixelCols, blockSize, shift, maxVal) {
    const frame = new Uint8Array(pixelRows * pixelCols);
    for (let r = 0; r < pixelRows; r++) {
        for (let c = 0; c < pixelCols; c++) {
            const rBlock = Math.floor(((r + shift) % pixelRows + pixelRows) % pixelRows / blockSize);
            const cBlock = Math.floor(c / blockSize);
            frame[r * pixelCols + c] = (rBlock + cBlock) % 2 === 0 ? maxVal : 0;
        }
    }
    return frame;
}

// ─── Test matrix ────────────────────────────────────────────────────────────

const testPatterns = [
    {
        name: 'web_G6_2x10_gs16_square_grating',
        generation: 'G6',
        arenaName: 'G6_2x10',
        rowCount: 2, colCount: 10,
        gs_val: 16, maxVal: 15,
        numFrames: 20, period: 20, stepPixels: 1,
        genFunc: 'squareGrating',
        description: 'G6 full arena, GS16 square grating, 20px period, 1px/frame'
    },
    {
        name: 'web_G6_2x10_gs2_square_grating',
        generation: 'G6',
        arenaName: 'G6_2x10',
        rowCount: 2, colCount: 10,
        gs_val: 2, maxVal: 1,
        numFrames: 20, period: 20, stepPixels: 1,
        genFunc: 'squareGrating',
        description: 'G6 full arena, GS2 square grating, 20px period, 1px/frame'
    },
    {
        name: 'web_G6_2x8of10_gs16_sine_grating',
        generation: 'G6',
        arenaName: 'G6_2x8of10',
        rowCount: 2, colCount: 8,
        gs_val: 16, maxVal: 15,
        numFrames: 20, period: 40, stepPixels: 2,
        genFunc: 'sineGrating',
        description: 'G6 partial arena (8of10), GS16 sine grating, 40px period, 2px/frame'
    },
    {
        name: 'web_G6_3x12of18_gs16_horiz_grating',
        generation: 'G6',
        arenaName: 'G6_3x12of18',
        rowCount: 3, colCount: 12,
        gs_val: 16, maxVal: 15,
        numFrames: 20, period: 20, stepPixels: 1,
        genFunc: 'horizontalGrating',
        description: 'G6 large partial arena (12of18), GS16 horizontal grating, 20px period'
    },
    {
        name: 'web_G4_4x12_gs16_square_grating',
        generation: 'G4',
        arenaName: 'G4_4x12',
        rowCount: 4, colCount: 12,
        gs_val: 16, maxVal: 15,
        numFrames: 16, period: 16, stepPixels: 1,
        genFunc: 'squareGrating',
        description: 'G4 full arena, GS16 square grating, 16px period (=panel width)'
    },
    {
        name: 'web_G4_4x12_gs2_square_grating',
        generation: 'G4',
        arenaName: 'G4_4x12',
        rowCount: 4, colCount: 12,
        gs_val: 2, maxVal: 1,
        numFrames: 16, period: 16, stepPixels: 1,
        genFunc: 'squareGrating',
        description: 'G4 full arena, GS2 square grating, 16px period'
    },
    {
        name: 'web_G41_2x12_gs16_sine_grating',
        generation: 'G4.1',
        arenaName: 'G41_2x12_cw',
        rowCount: 2, colCount: 12,
        gs_val: 16, maxVal: 15,
        numFrames: 16, period: 32, stepPixels: 2,
        genFunc: 'sineGrating',
        description: 'G4.1 treadmill, GS16 sine grating, 32px period, 2px/frame'
    },
    {
        name: 'web_G4_3x12of18_gs16_checkerboard',
        generation: 'G4',
        arenaName: 'G4_3x12of18',
        rowCount: 3, colCount: 12,
        gs_val: 16, maxVal: 15,
        numFrames: 16, period: 16, stepPixels: 1,
        genFunc: 'checkerboard',
        description: 'G4 partial arena (12of18), GS16 checkerboard, 16px blocks'
    }
];

// Map function names to actual functions
const genFunctions = {
    squareGrating,
    sineGrating,
    horizontalGrating,
    checkerboard
};

// ─── Generate and save patterns ─────────────────────────────────────────────

console.log('=== Web → MATLAB Roundtrip Pattern Generator ===\n');

const manifest = {
    generated: new Date().toISOString(),
    generator: 'webDisplayTools/tests/generate-roundtrip-patterns.js',
    description: 'Deterministic reference patterns for Web → MATLAB roundtrip validation',
    patterns: []
};

let allPassed = true;

for (const tp of testPatterns) {
    const panelSize = tp.generation === 'G6' ? 20 : 16;
    const pixelRows = tp.rowCount * panelSize;
    const pixelCols = tp.colCount * panelSize;
    const arena_id = getArenaId(tp.generation === 'G4.1' ? 'G4.1' : tp.generation, tp.arenaName);
    const genFunc = genFunctions[tp.genFunc];

    console.log(`Generating: ${tp.name}`);
    console.log(`  ${tp.description}`);
    console.log(`  Dims: ${pixelRows}×${pixelCols}, ${tp.numFrames} frames, arena_id=${arena_id}`);

    // Generate frames
    const frames = [];
    for (let f = 0; f < tp.numFrames; f++) {
        const shift = f * tp.stepPixels;
        if (tp.genFunc === 'checkerboard') {
            frames.push(genFunc(pixelRows, pixelCols, tp.period, shift, tp.maxVal));
        } else if (tp.genFunc === 'horizontalGrating') {
            frames.push(genFunc(pixelRows, pixelCols, tp.period, shift, tp.maxVal));
        } else {
            frames.push(genFunc(pixelRows, pixelCols, tp.period, shift, tp.maxVal));
        }
    }

    // Build pattern data object for encoder
    const patternData = {
        generation: tp.generation,
        gs_val: tp.gs_val,
        numFrames: tp.numFrames,
        rowCount: tp.rowCount,
        colCount: tp.colCount,
        pixelRows,
        pixelCols,
        frames,
        stretchValues: new Array(tp.numFrames).fill(1),
        arena_id
    };

    // Add G6-specific fields
    if (tp.generation === 'G6') {
        patternData.observer_id = 0;
    }

    // Encode
    let buffer;
    try {
        buffer = PatEncoder.encode(patternData);
    } catch (err) {
        console.log(`  FAIL: Encode error: ${err.message}`);
        allPassed = false;
        continue;
    }

    // Self-verify by parsing back
    let parsed;
    try {
        parsed = PatParser.parsePatFile(buffer);
    } catch (err) {
        console.log(`  FAIL: Parse error: ${err.message}`);
        allPassed = false;
        continue;
    }

    // Verify metadata
    let ok = true;
    if (parsed.pixelRows !== pixelRows) {
        console.log(`  FAIL: pixelRows ${parsed.pixelRows} != ${pixelRows}`);
        ok = false;
    }
    if (parsed.pixelCols !== pixelCols) {
        console.log(`  FAIL: pixelCols ${parsed.pixelCols} != ${pixelCols}`);
        ok = false;
    }
    if (parsed.numFrames !== tp.numFrames) {
        console.log(`  FAIL: numFrames ${parsed.numFrames} != ${tp.numFrames}`);
        ok = false;
    }

    // Verify pixel data for each frame
    for (let f = 0; f < tp.numFrames; f++) {
        const orig = frames[f];
        const loaded = parsed.frames[f];
        if (orig.length !== loaded.length) {
            console.log(`  FAIL: Frame ${f} length ${loaded.length} != ${orig.length}`);
            ok = false;
            break;
        }
        for (let p = 0; p < orig.length; p++) {
            if (orig[p] !== loaded[p]) {
                const row = Math.floor(p / pixelCols);
                const col = p % pixelCols;
                console.log(`  FAIL: Frame ${f} pixel (${row},${col}) = ${loaded[p]}, expected ${orig[p]}`);
                ok = false;
                break;
            }
        }
    }

    if (!ok) {
        allPassed = false;
        continue;
    }

    // Determine filename suffix based on generation
    const fileSuffix = tp.generation === 'G6' ? '_G6.pat' : '_G4.pat';
    const filename = tp.name + fileSuffix;
    const filepath = path.join(outDir, filename);

    // Write .pat file
    fs.writeFileSync(filepath, Buffer.from(buffer));
    console.log(`  OK: ${filename} (${buffer.byteLength} bytes)`);

    // Add to manifest
    manifest.patterns.push({
        filename,
        generation: tp.generation,
        arenaName: tp.arenaName,
        arena_id,
        gs_val: tp.gs_val,
        maxVal: tp.maxVal,
        pixelRows,
        pixelCols,
        numFrames: tp.numFrames,
        panelSize,
        rowCount: tp.rowCount,
        colCount: tp.colCount,
        patternType: tp.genFunc,
        period: tp.period,
        stepPixels: tp.stepPixels,
        fileSize: buffer.byteLength
    });
}

// Write manifest
const manifestPath = path.join(outDir, 'web_generated_manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\nManifest: ${manifestPath}`);

// Summary
console.log(`\n=== Summary ===`);
console.log(`Generated: ${manifest.patterns.length} / ${testPatterns.length} patterns`);
if (allPassed) {
    console.log('All patterns self-verified (encode → parse → pixel compare).');
    process.exit(0);
} else {
    console.log('Some patterns FAILED self-verification.');
    process.exit(1);
}
