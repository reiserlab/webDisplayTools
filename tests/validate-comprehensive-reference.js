/**
 * Comprehensive MATLAB Reference Validation Suite
 *
 * This script validates the JavaScript pattern generation against MATLAB reference data
 * across multiple arena configurations and pattern types.
 *
 * Usage: node tests/validate-comprehensive-reference.js
 */

const fs = require('fs');
const path = require('path');

// Load modules
const { PANEL_SPECS } = require('../js/arena-configs.js');
const ArenaGeometry = require('../js/arena-geometry.js');
const PatternGenerator = require('../js/pattern-editor/tools/generator.js');

// Make modules available to generator
global.PANEL_SPECS = PANEL_SPECS;
global.ArenaGeometry = ArenaGeometry;

// ANSI color codes
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
    dim: '\x1b[2m',
    reset: '\x1b[0m'
};

function log(msg, color = 'reset') {
    console.log(`${colors[color]}${msg}${colors.reset}`);
}

// Load reference data
const refPath = path.join(__dirname, '../data/comprehensive_pattern_reference.json');
let referenceData;
try {
    referenceData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
} catch (err) {
    log(`ERROR: Could not load reference data from ${refPath}`, 'red');
    log(`Run MATLAB generate_comprehensive_reference.m first`, 'dim');
    process.exit(1);
}

log('\n=== Comprehensive MATLAB Reference Validation Suite ===\n', 'blue');
log(`Reference data generated: ${referenceData.generatedAt}`, 'dim');
log(`MATLAB version: ${referenceData.matlabVersion}`, 'dim');
log(`Total test cases: ${referenceData.testCases.length}\n`, 'dim');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

for (const tc of referenceData.testCases) {
    process.stdout.write(`Testing: ${tc.name}... `);

    try {
        // Build arena config for JavaScript
        // For partial arenas, Pcircle may differ from cols (installed columns)
        const arena = {
            generation: tc.generation,
            rows: tc.rows,
            cols: tc.cols,
            num_rows: tc.rows,
            num_cols: tc.cols,
            Pcircle: tc.Pcircle || tc.cols  // Full circle panels
        };

        let jsPattern;

        // Handle different pattern types
        if (tc.patternType === 'offon') {
            jsPattern = PatternGenerator.generateOffOn({
                high: tc.high,
                low: tc.low,
                gsMode: tc.gsMode
            }, arena);
        } else if (tc.patternType === 'edge') {
            jsPattern = PatternGenerator.generateEdge({
                spatFreq: tc.spatFreq,
                motionType: tc.motionType,
                high: tc.high,
                low: tc.low,
                poleCoord: tc.poleCoord,
                aaSamples: tc.aaSamples,
                arenaModel: tc.arenaModel,
                gsMode: tc.gsMode,
                numFrames: tc.numFrames
            }, arena);
        } else {
            // Grating/Sine patterns
            jsPattern = PatternGenerator.generateSphericalGrating({
                spatFreq: tc.spatFreq,
                motionType: tc.motionType,
                waveform: tc.waveform,
                dutyCycle: tc.dutyCycle || 50,
                high: tc.high,
                low: tc.low,
                poleCoord: tc.poleCoord,
                aaSamples: tc.aaSamples,
                arenaModel: tc.arenaModel,
                gsMode: tc.gsMode,
                numFrames: 1
            }, arena);
        }

        // Compare reference frame (frame 0)
        const jsFrame = Array.from(jsPattern.frames[tc.testFrame || 0]);
        const matlabFrame = tc.referenceFrame;

        if (jsFrame.length !== matlabFrame.length) {
            throw new Error(`Dimension mismatch: JS=${jsFrame.length}, MATLAB=${matlabFrame.length}`);
        }

        // Compare pixel-by-pixel
        let mismatches = 0;
        let maxDiff = 0;
        let firstMismatchIdx = -1;

        for (let i = 0; i < jsFrame.length; i++) {
            const diff = Math.abs(jsFrame[i] - matlabFrame[i]);
            if (diff > 0) {
                mismatches++;
                maxDiff = Math.max(maxDiff, diff);
                if (firstMismatchIdx < 0) {
                    firstMismatchIdx = i;
                }
            }
        }

        if (mismatches === 0) {
            log('PASS ✓', 'green');
            passed++;
        } else {
            const mismatchPct = (mismatches / jsFrame.length * 100).toFixed(1);
            log(`FAIL - ${mismatches} mismatches (${mismatchPct}%), max diff: ${maxDiff}`, 'red');
            failed++;
            failures.push({
                name: tc.name,
                mismatches,
                total: jsFrame.length,
                maxDiff,
                firstIdx: firstMismatchIdx,
                jsVal: jsFrame[firstMismatchIdx],
                matlabVal: matlabFrame[firstMismatchIdx]
            });
        }

    } catch (err) {
        log(`ERROR - ${err.message}`, 'red');
        failed++;
        failures.push({ name: tc.name, error: err.message });
    }
}

// Summary
log('\n' + '='.repeat(60), 'blue');
log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`, failed > 0 ? 'red' : 'green');

if (failures.length > 0) {
    log('\nFailed tests:', 'red');
    for (const f of failures) {
        if (f.error) {
            log(`  - ${f.name}: ${f.error}`, 'red');
        } else {
            log(`  - ${f.name}: ${f.mismatches}/${f.total} mismatches, max diff=${f.maxDiff}`, 'red');
            log(`    First mismatch at pixel ${f.firstIdx}: JS=${f.jsVal}, MATLAB=${f.matlabVal}`, 'dim');
        }
    }
}

if (failed === 0) {
    log('\n✓ All patterns match MATLAB reference!\n', 'green');
}

process.exit(failed > 0 ? 1 : 0);
