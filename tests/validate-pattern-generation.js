#!/usr/bin/env node
/**
 * Pattern Generation Validation Test
 *
 * Validates JavaScript pattern generation against MATLAB reference data.
 * Run with: node tests/validate-pattern-generation.js
 *
 * Exit codes:
 *   0 = All tests passed
 *   1 = One or more tests failed
 */

const fs = require('fs');
const path = require('path');

// Import the pattern generator module
const PatternGenerator = require('../js/pattern-editor/tools/generator.js');

// Mock PANEL_SPECS for Node.js testing
if (typeof PANEL_SPECS === 'undefined') {
    global.PANEL_SPECS = {
        'G3': { pixels_per_panel: 8 },
        'G4': { pixels_per_panel: 16 },
        'G4.1': { pixels_per_panel: 16 },
        'G6': { pixels_per_panel: 20 }
    };
}

// Configuration
const REFERENCE_FILE = path.join(__dirname, '..', 'data', 'pattern_generation_reference.json');

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function loadReferenceData() {
    if (!fs.existsSync(REFERENCE_FILE)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8'));
}

/**
 * Compare two arrays of pixels
 */
function comparePixels(computed, reference, tolerance = 0) {
    if (computed.length !== reference.length) {
        return {
            pass: false,
            message: `Length mismatch: computed=${computed.length}, reference=${reference.length}`
        };
    }

    const differences = [];
    for (let i = 0; i < computed.length; i++) {
        const diff = Math.abs(computed[i] - reference[i]);
        if (diff > tolerance) {
            differences.push({
                index: i,
                computed: computed[i],
                reference: reference[i],
                diff
            });
        }
    }

    return {
        pass: differences.length === 0,
        differences
    };
}

function runTests() {
    log('\n╔════════════════════════════════════════════════════════════╗', 'cyan');
    log('║        Pattern Generation Validation Test                  ║', 'cyan');
    log('╚════════════════════════════════════════════════════════════╝\n', 'cyan');

    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    const failures = [];

    // ================================================================
    // Test 1: Module exists and has required methods
    // ================================================================
    log('── Module Validation ──', 'cyan');

    totalTests++;
    const requiredMethods = ['generate', 'generateGrating', 'generateSine', 'generateStarfield', 'generateEdge', 'generateOffOn', 'validate'];
    const missingMethods = requiredMethods.filter(m => typeof PatternGenerator[m] !== 'function');

    if (missingMethods.length === 0) {
        log('  ✓ All required methods exist', 'green');
        passedTests++;
    } else {
        log(`  ✗ Missing methods: ${missingMethods.join(', ')}`, 'red');
        failedTests++;
        failures.push({ test: 'Module', error: `Missing methods: ${missingMethods.join(', ')}` });
    }

    // ================================================================
    // Test 2: Basic sanity checks (no MATLAB reference needed)
    // ================================================================
    log('\n── Basic Sanity Checks ──', 'cyan');

    const testArena = {
        generation: 'G6',
        rows: 2,
        cols: 10
    };

    // Grating produces expected frame count
    totalTests++;
    try {
        const grating = PatternGenerator.generateGrating({
            wavelength: 20,
            direction: 'cw',
            dutyCycle: 50,
            high: 15,
            low: 0,
            gsMode: 16,
            stepSize: 1
        }, testArena);

        if (grating.numFrames === 20 && grating.frames.length === 20) {
            log('  ✓ Grating produces correct frame count (20 for wavelength 20)', 'green');
            passedTests++;
        } else {
            log(`  ✗ Grating frame count mismatch: expected 20, got ${grating.numFrames}`, 'red');
            failedTests++;
            failures.push({ test: 'Grating frame count', error: `Expected 20, got ${grating.numFrames}` });
        }
    } catch (error) {
        log(`  ✗ Grating generation failed: ${error.message}`, 'red');
        failedTests++;
        failures.push({ test: 'Grating generation', error: error.message });
    }

    // Sine values are in valid range
    totalTests++;
    try {
        const sine = PatternGenerator.generateSine({
            wavelength: 40,
            direction: 'cw',
            high: 15,
            low: 0,
            gsMode: 16
        }, testArena);

        let allInRange = true;
        for (const frame of sine.frames) {
            for (let i = 0; i < frame.length; i++) {
                if (frame[i] < 0 || frame[i] > 15) {
                    allInRange = false;
                    break;
                }
            }
        }

        if (allInRange) {
            log('  ✓ Sine values are in valid range (0-15)', 'green');
            passedTests++;
        } else {
            log('  ✗ Sine values out of range', 'red');
            failedTests++;
            failures.push({ test: 'Sine range', error: 'Values out of range' });
        }
    } catch (error) {
        log(`  ✗ Sine generation failed: ${error.message}`, 'red');
        failedTests++;
        failures.push({ test: 'Sine generation', error: error.message });
    }

    // Off/On has exactly 2 frames
    totalTests++;
    try {
        const offon = PatternGenerator.generateOffOn({
            high: 15,
            low: 0,
            gsMode: 16
        }, testArena);

        if (offon.numFrames === 2 && offon.frames.length === 2) {
            log('  ✓ Off/On has exactly 2 frames', 'green');
            passedTests++;
        } else {
            log(`  ✗ Off/On frame count mismatch: expected 2, got ${offon.numFrames}`, 'red');
            failedTests++;
            failures.push({ test: 'Off/On frame count', error: `Expected 2, got ${offon.numFrames}` });
        }
    } catch (error) {
        log(`  ✗ Off/On generation failed: ${error.message}`, 'red');
        failedTests++;
        failures.push({ test: 'Off/On generation', error: error.message });
    }

    // Starfield reproducibility with same seed
    totalTests++;
    try {
        const starfield1 = PatternGenerator.generateStarfield({
            dotCount: 50,
            brightness: 15,
            seed: 12345,
            gsMode: 16
        }, testArena);

        const starfield2 = PatternGenerator.generateStarfield({
            dotCount: 50,
            brightness: 15,
            seed: 12345,
            gsMode: 16
        }, testArena);

        const frame1 = Array.from(starfield1.frames[0]);
        const frame2 = Array.from(starfield2.frames[0]);

        const result = comparePixels(frame1, frame2);
        if (result.pass) {
            log('  ✓ Starfield is reproducible with same seed', 'green');
            passedTests++;
        } else {
            log('  ✗ Starfield not reproducible with same seed', 'red');
            failedTests++;
            failures.push({ test: 'Starfield reproducibility', error: 'Different results with same seed' });
        }
    } catch (error) {
        log(`  ✗ Starfield generation failed: ${error.message}`, 'red');
        failedTests++;
        failures.push({ test: 'Starfield generation', error: error.message });
    }

    // Pattern validation function works
    totalTests++;
    try {
        const validPattern = PatternGenerator.generateGrating({
            wavelength: 20,
            direction: 'cw',
            high: 15,
            low: 0
        }, testArena);

        const validationResult = PatternGenerator.validate(validPattern);
        if (validationResult.valid) {
            log('  ✓ Pattern validation accepts valid pattern', 'green');
            passedTests++;
        } else {
            log(`  ✗ Pattern validation rejected valid pattern: ${validationResult.errors.join(', ')}`, 'red');
            failedTests++;
            failures.push({ test: 'Pattern validation', error: validationResult.errors.join(', ') });
        }
    } catch (error) {
        log(`  ✗ Pattern validation failed: ${error.message}`, 'red');
        failedTests++;
        failures.push({ test: 'Pattern validation', error: error.message });
    }

    // ================================================================
    // Test 3: Compare against MATLAB reference (if available)
    // ================================================================
    log('\n── MATLAB Reference Comparison ──', 'cyan');

    const refData = loadReferenceData();

    if (!refData) {
        log('  (Reference data not found - skipping MATLAB comparison)', 'yellow');
        log(`  Run MATLAB generate_web_pattern_reference.m and copy output to:`, 'dim');
        log(`  ${REFERENCE_FILE}`, 'dim');
    } else {
        log(`  Reference data from: ${refData.source}`, 'dim');
        log(`  Generated: ${refData.generated}`, 'dim');

        const patterns = refData.patterns || {};

        for (const [patternName, refPattern] of Object.entries(patterns)) {
            totalTests++;

            try {
                // Build arena config from reference
                const arena = {
                    generation: refPattern.arena.generation,
                    rows: refPattern.arena.rows,
                    cols: refPattern.arena.cols
                };

                // Generate pattern with same parameters
                let computed;
                switch (refPattern.type) {
                    case 'grating':
                        computed = PatternGenerator.generateGrating({
                            wavelength: refPattern.params.wavelength,
                            direction: refPattern.params.direction,
                            dutyCycle: refPattern.params.dutyCycle,
                            high: refPattern.params.high,
                            low: refPattern.params.low,
                            gsMode: refPattern.result.gsMode
                        }, arena);
                        break;

                    case 'sine':
                        computed = PatternGenerator.generateSine({
                            wavelength: refPattern.params.wavelength,
                            direction: refPattern.params.direction,
                            high: refPattern.params.high,
                            low: refPattern.params.low,
                            gsMode: refPattern.result.gsMode
                        }, arena);
                        break;

                    case 'starfield':
                        computed = PatternGenerator.generateStarfield({
                            dotCount: refPattern.params.dotCount,
                            dotSize: refPattern.params.dotSize,
                            brightness: refPattern.params.brightness,
                            seed: refPattern.params.randomSeed,
                            gsMode: refPattern.result.gsMode
                        }, arena);
                        break;

                    case 'edge':
                        computed = PatternGenerator.generateEdge({
                            high: refPattern.params.high,
                            low: refPattern.params.low,
                            gsMode: refPattern.result.gsMode
                        }, arena);
                        break;

                    case 'offon':
                        computed = PatternGenerator.generateOffOn({
                            high: refPattern.params.high,
                            low: refPattern.params.low,
                            gsMode: refPattern.result.gsMode
                        }, arena);
                        break;

                    default:
                        log(`  - ${patternName} (skipped - unknown type: ${refPattern.type})`, 'dim');
                        totalTests--;
                        continue;
                }

                // Compare frame 0 pixels
                const computedPixels = Array.from(computed.frames[0]);
                const referencePixels = refPattern.result.frame0_pixels;

                const result = comparePixels(computedPixels, referencePixels, 1); // Allow tolerance of 1 for rounding

                if (result.pass) {
                    log(`  ✓ ${patternName}`, 'green');
                    passedTests++;
                } else {
                    const diff = result.differences[0];
                    log(`  ✗ ${patternName}: pixel[${diff.index}] got ${diff.computed}, expected ${diff.reference}`, 'red');
                    failedTests++;
                    failures.push({
                        test: patternName,
                        error: `pixel[${diff.index}]: ${diff.computed} != ${diff.reference}`
                    });
                }
            } catch (error) {
                log(`  ✗ ${patternName}: ${error.message}`, 'red');
                failedTests++;
                failures.push({ test: patternName, error: error.message });
            }
        }
    }

    // ================================================================
    // Summary
    // ================================================================
    log('\n────────────────────────────────────────────────────────────', 'dim');
    log(`\nResults: ${passedTests}/${totalTests} tests passed`, passedTests === totalTests ? 'green' : 'red');

    if (failedTests > 0) {
        log(`\n${failedTests} test(s) failed:`, 'red');
        for (const f of failures) {
            log(`  - ${f.test}: ${f.error}`, 'red');
        }
        log('\n', 'reset');
        return 1;
    }

    log('\nAll pattern generation tests passed! ✓\n', 'green');
    return 0;
}

// Run tests and exit with appropriate code
const exitCode = runTests();
process.exit(exitCode);
