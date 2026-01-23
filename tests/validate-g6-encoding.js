#!/usr/bin/env node
/**
 * G6 Encoding Validation Test
 *
 * Compares JavaScript G6 encoding against MATLAB reference data.
 * Run with: node tests/validate-g6-encoding.js
 *
 * Exit codes:
 *   0 = All tests passed
 *   1 = One or more tests failed
 */

const fs = require('fs');
const path = require('path');

// Import the encoding module
const G6Encoding = require('../js/g6-encoding.js');

// Configuration
const REFERENCE_FILE = path.join(__dirname, '..', 'data', 'g6_encoding_reference.json');

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
        log(`Error: Reference file not found: ${REFERENCE_FILE}`, 'red');
        log('Run MATLAB generate_g6_encoding_reference.m first, then copy to data/', 'yellow');
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8'));
    return data;
}

/**
 * Create a 20x20 pixel array with a single pixel set
 */
function createSinglePixelArray(panelRow, panelCol, value = 1) {
    const arr = G6Encoding.createEmptyArray();
    arr[panelRow][panelCol] = value;
    return arr;
}

/**
 * Compare byte arrays and return differences
 */
function compareBytes(computed, reference) {
    const differences = [];

    if (computed.length !== reference.length) {
        return {
            pass: false,
            message: `Length mismatch: computed=${computed.length}, reference=${reference.length}`
        };
    }

    for (let i = 0; i < computed.length; i++) {
        if (computed[i] !== reference[i]) {
            differences.push({
                index: i,
                computed: computed[i],
                reference: reference[i]
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
    log('║            G6 Encoding Validation Test                     ║', 'cyan');
    log('╚════════════════════════════════════════════════════════════╝\n', 'cyan');

    const refData = loadReferenceData();

    log(`Reference data generated: ${refData.generated}`, 'dim');
    log(`Reference source: ${refData.source}`, 'dim');
    log(`Encoding convention: ${refData.encoding_convention.formula}\n`, 'dim');

    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    const failures = [];

    // ================================================================
    // Test 1: Validate encoding functions exist
    // ================================================================
    log('── Module Validation ──', 'cyan');

    totalTests++;
    if (typeof G6Encoding.encodeGS2 === 'function' &&
        typeof G6Encoding.encodeGS16 === 'function') {
        log('  ✓ Encoding functions exist', 'green');
        passedTests++;
    } else {
        log('  ✗ Missing encoding functions', 'red');
        failedTests++;
        failures.push({ test: 'Module', error: 'Missing encoding functions' });
    }

    // ================================================================
    // Test 2: Basic encoding sanity checks
    // ================================================================
    log('\n── Basic Sanity Checks ──', 'cyan');

    // All zeros should produce all zero bytes
    totalTests++;
    const emptyArray = G6Encoding.createEmptyArray();
    const emptyGS2 = G6Encoding.encodeGS2(emptyArray);
    const allZeros = emptyGS2.every(b => b === 0);
    if (allZeros) {
        log('  ✓ Empty array produces all-zero bytes (GS2)', 'green');
        passedTests++;
    } else {
        log('  ✗ Empty array should produce all-zero bytes', 'red');
        failedTests++;
        failures.push({ test: 'Sanity', error: 'Empty array not all zeros' });
    }

    // All ones should produce all 255 bytes (GS2)
    totalTests++;
    const fullArray = G6Encoding.createFilledArray(1);
    const fullGS2 = G6Encoding.encodeGS2(fullArray);
    const all255 = fullGS2.every(b => b === 255);
    if (all255) {
        log('  ✓ Full array produces all-255 bytes (GS2)', 'green');
        passedTests++;
    } else {
        log('  ✗ Full array should produce all-255 bytes', 'red');
        failedTests++;
        failures.push({ test: 'Sanity', error: 'Full array not all 255' });
    }

    // ================================================================
    // Test 3: Test vectors from MATLAB reference
    // ================================================================
    log('\n── Test Vectors (vs MATLAB) ──', 'cyan');

    if (refData.test_vectors && refData.test_vectors.length > 0) {
        for (const vector of refData.test_vectors) {
            totalTests++;

            const testName = vector.name;

            try {
                let pixelArray;
                let computedGS2 = null;
                let computedGS16 = null;

                // Create pixel array based on test type
                if (vector.panel_row !== undefined && vector.panel_col !== undefined) {
                    // Single pixel test
                    if (vector.gs2_bytes) {
                        pixelArray = createSinglePixelArray(vector.panel_row, vector.panel_col, 1);
                        computedGS2 = G6Encoding.encodeGS2(pixelArray);
                    }
                    if (vector.gs16_bytes) {
                        pixelArray = createSinglePixelArray(vector.panel_row, vector.panel_col, vector.gs16_value || 15);
                        computedGS16 = G6Encoding.encodeGS16(pixelArray);
                    }
                } else if (vector.description && vector.description.includes('row')) {
                    // Row or column tests
                    pixelArray = G6Encoding.createEmptyArray();

                    if (vector.description.includes('Bottom row')) {
                        // Bottom row = row 0
                        for (let c = 0; c < 20; c++) pixelArray[0][c] = 1;
                    } else if (vector.description.includes('Left column')) {
                        // Left column = col 0
                        for (let r = 0; r < 20; r++) pixelArray[r][0] = 1;
                    }

                    if (vector.gs2_bytes) {
                        computedGS2 = G6Encoding.encodeGS2(pixelArray);
                    }
                } else if (vector.gs2_values || vector.gs16_values) {
                    // Two adjacent pixels test
                    pixelArray = G6Encoding.createEmptyArray();
                    if (vector.gs16_values) {
                        pixelArray[0][0] = vector.gs16_values[0];
                        pixelArray[0][1] = vector.gs16_values[1];
                        computedGS16 = G6Encoding.encodeGS16(pixelArray);
                    } else {
                        pixelArray[0][0] = 1;
                        pixelArray[0][1] = 1;
                        computedGS2 = G6Encoding.encodeGS2(pixelArray);
                    }
                }

                // Compare results
                let pass = true;
                let errorMsg = '';

                if (computedGS2 && vector.gs2_bytes) {
                    const result = compareBytes(computedGS2, vector.gs2_bytes);
                    if (!result.pass) {
                        pass = false;
                        if (result.message) {
                            errorMsg = result.message;
                        } else {
                            const diff = result.differences[0];
                            errorMsg = `GS2 byte[${diff.index}]: got ${diff.computed}, expected ${diff.reference}`;
                        }
                    }
                }

                if (computedGS16 && vector.gs16_bytes) {
                    const result = compareBytes(computedGS16, vector.gs16_bytes);
                    if (!result.pass) {
                        pass = false;
                        if (result.message) {
                            errorMsg = result.message;
                        } else {
                            const diff = result.differences[0];
                            errorMsg = `GS16 byte[${diff.index}]: got ${diff.computed}, expected ${diff.reference}`;
                        }
                    }
                }

                if (pass) {
                    log(`  ✓ ${testName}`, 'green');
                    passedTests++;
                } else {
                    log(`  ✗ ${testName}: ${errorMsg}`, 'red');
                    failedTests++;
                    failures.push({ test: testName, error: errorMsg });
                }
            } catch (error) {
                log(`  ✗ ${testName}: ${error.message}`, 'red');
                failedTests++;
                failures.push({ test: testName, error: error.message });
            }
        }
    } else {
        log('  (No test vectors in reference data)', 'yellow');
    }

    // ================================================================
    // Test 4: Pattern encoding tests
    // ================================================================
    log('\n── Pattern Encoding (vs MATLAB) ──', 'cyan');

    if (refData.patterns) {
        for (const [patternName, patternData] of Object.entries(refData.patterns)) {
            totalTests++;

            try {
                // Get the pixel matrix from the reference data
                if (!patternData.pixel_matrix) {
                    // Skip patterns without pixel matrix (like all_off, all_on)
                    // We can still test them with known inputs
                    if (patternName === 'all_off') {
                        const arr = G6Encoding.createEmptyArray();
                        const computed = G6Encoding.encodeGS2(arr);
                        const result = compareBytes(computed, patternData.gs2_bytes);
                        if (result.pass) {
                            log(`  ✓ ${patternName}`, 'green');
                            passedTests++;
                        } else {
                            log(`  ✗ ${patternName}: byte mismatch`, 'red');
                            failedTests++;
                            failures.push({ test: patternName, error: 'Byte mismatch' });
                        }
                        continue;
                    } else if (patternName === 'all_on') {
                        const arr = G6Encoding.createFilledArray(1);
                        const computed = G6Encoding.encodeGS2(arr);
                        const result = compareBytes(computed, patternData.gs2_bytes);
                        if (result.pass) {
                            log(`  ✓ ${patternName}`, 'green');
                            passedTests++;
                        } else {
                            log(`  ✗ ${patternName}: byte mismatch`, 'red');
                            failedTests++;
                            failures.push({ test: patternName, error: 'Byte mismatch' });
                        }
                        continue;
                    }
                    log(`  - ${patternName} (skipped - no pixel_matrix)`, 'dim');
                    totalTests--;
                    continue;
                }

                // IMPORTANT: MATLAB pixel_matrix is stored in MATLAB row order (row 0 = top of visual)
                // JavaScript expects panel coordinates (row 0 = bottom of panel)
                // So we need to flip the matrix vertically
                const matlabMatrix = patternData.pixel_matrix;
                const pixelMatrix = matlabMatrix.slice().reverse();  // Flip rows

                let computed;
                let reference;

                if (patternData.mode === 'GS2' && patternData.gs2_bytes) {
                    computed = G6Encoding.encodeGS2(pixelMatrix);
                    reference = patternData.gs2_bytes;
                } else if (patternData.mode === 'GS16' && patternData.gs16_bytes) {
                    computed = G6Encoding.encodeGS16(pixelMatrix);
                    reference = patternData.gs16_bytes;
                } else {
                    log(`  - ${patternName} (skipped - no matching bytes)`, 'dim');
                    totalTests--;
                    continue;
                }

                const result = compareBytes(computed, reference);

                if (result.pass) {
                    log(`  ✓ ${patternName}`, 'green');
                    passedTests++;
                } else {
                    const diff = result.differences[0];
                    log(`  ✗ ${patternName}: byte[${diff.index}] got ${diff.computed}, expected ${diff.reference}`, 'red');
                    failedTests++;
                    failures.push({
                        test: patternName,
                        error: `byte[${diff.index}]: ${diff.computed} != ${diff.reference}`
                    });
                }
            } catch (error) {
                log(`  ✗ ${patternName}: ${error.message}`, 'red');
                failedTests++;
                failures.push({ test: patternName, error: error.message });
            }
        }
    } else {
        log('  (No patterns in reference data)', 'yellow');
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

    log('\nAll G6 encoding tests passed! ✓\n', 'green');
    return 0;
}

// Run tests and exit with appropriate code
const exitCode = runTests();
process.exit(exitCode);
