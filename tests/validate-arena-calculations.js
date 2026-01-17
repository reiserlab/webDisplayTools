#!/usr/bin/env node
/**
 * Arena Calculations Validation Test
 *
 * Compares JavaScript arena calculations against MATLAB reference data.
 * Run with: node tests/validate-arena-calculations.js
 *
 * Exit codes:
 *   0 = All tests passed
 *   1 = One or more tests failed
 */

const fs = require('fs');
const path = require('path');

// Import the calculation module
const { calculateGeometry, compareGeometry } = require('../js/arena-calculations.js');

// Configuration
const TOLERANCE = 0.0001;
const REFERENCE_FILE = path.join(__dirname, '..', 'data', 'reference_data.json');

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
        log('Run MATLAB generate_web_reference_data.m first, then copy to data/', 'yellow');
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8'));
    return data;
}

function runTests() {
    log('\n╔════════════════════════════════════════════════════════════╗', 'cyan');
    log('║         Arena Calculations Validation Test                 ║', 'cyan');
    log('╚════════════════════════════════════════════════════════════╝\n', 'cyan');

    const refData = loadReferenceData();

    log(`Reference data generated: ${refData.generated}`, 'dim');
    log(`Reference source: ${refData.source}`, 'dim');
    log(`Tolerance: ${TOLERANCE}\n`, 'dim');

    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    const failures = [];

    // Test each arena configuration in the reference data
    for (const refArena of refData.arenas) {
        totalTests++;

        const panelType = refArena.panel_type;
        const numPanels = refArena.num_panels;
        const configName = `${panelType} ${numPanels}-panel`;

        try {
            // Calculate using JavaScript
            const computed = calculateGeometry(panelType, numPanels);

            // Compare with reference
            const comparison = compareGeometry(computed, refArena, TOLERANCE);

            if (comparison.pass) {
                log(`  ✓ ${configName}`, 'green');
                passedTests++;
            } else {
                log(`  ✗ ${configName}`, 'red');
                failedTests++;

                // Show details of failures
                for (const detail of comparison.details) {
                    if (!detail.pass) {
                        log(`      ${detail.field}: computed=${detail.computed.toFixed(6)}, ref=${detail.reference.toFixed(6)}, diff=${detail.diff.toExponential(2)}`, 'yellow');
                        failures.push({
                            config: configName,
                            field: detail.field,
                            computed: detail.computed,
                            reference: detail.reference,
                            diff: detail.diff
                        });
                    }
                }
            }
        } catch (error) {
            log(`  ✗ ${configName}: ${error.message}`, 'red');
            failedTests++;
            failures.push({
                config: configName,
                error: error.message
            });
        }
    }

    // Summary
    log('\n────────────────────────────────────────────────────────────', 'dim');
    log(`\nResults: ${passedTests}/${totalTests} tests passed`, passedTests === totalTests ? 'green' : 'red');

    if (failedTests > 0) {
        log(`\n${failedTests} test(s) failed:`, 'red');
        for (const f of failures) {
            if (f.error) {
                log(`  - ${f.config}: ${f.error}`, 'red');
            } else {
                log(`  - ${f.config}: ${f.field} off by ${f.diff.toExponential(2)}`, 'red');
            }
        }
        log('\n', 'reset');
        return 1;
    }

    log('\nAll arena calculations match MATLAB reference! ✓\n', 'green');
    return 0;
}

// Run tests and exit with appropriate code
const exitCode = runTests();
process.exit(exitCode);
