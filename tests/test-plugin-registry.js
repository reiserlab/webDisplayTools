#!/usr/bin/env node
/**
 * Unit tests for js/plugin-registry.js pure helpers:
 *   - clampToSchema(value, schema) — the designer's clamp-to-legal coercion
 *   - isG6OnlyCommand(name)        — G6-only controller-command gate
 *
 * plugin-registry.js is an ES module; Node >= 22.12 allows require() of ESM
 * (same as the v3 protocol module), so this runs as plain CommonJS.
 *
 * Run: node tests/test-plugin-registry.js
 * Exit 0 = all passed, 1 = failures.
 */

'use strict';

const P = require('../js/plugin-registry.js');

let total = 0;
let failures = 0;
function check(name, got, expected) {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)}`);
    if (!ok) {
        failures++;
        console.log(`        expected ${JSON.stringify(expected)}`);
    }
}

console.log('\n=== clampToSchema ===');
const mv = P.CONTROLLER_COMMANDS.setAnalogOut.params.mv; // {min:0,max:5000,integer:true}
check('mv 2500 unchanged', P.clampToSchema(2500, mv), {
    value: 2500,
    changed: false,
    reason: null
});
check('mv 9999 -> 5000', P.clampToSchema(9999, mv), {
    value: 5000,
    changed: true,
    reason: 'clamped to maximum 5000'
});
check('mv -10 -> 0', P.clampToSchema(-10, mv), {
    value: 0,
    changed: true,
    reason: 'raised to minimum 0'
});
check('mv 12.7 -> 13 (round)', P.clampToSchema(12.7, mv), {
    value: 13,
    changed: true,
    reason: 'rounded to integer'
});

const gain = P.CONTROLLER_COMMANDS.trialParams.params.gain; // {min:-128,max:127,integer:true}
check('gain 500 -> 127', P.clampToSchema(500, gain).value, 127);
check('gain -500 -> -128', P.clampToSchema(-500, gain).value, -128);

const dur = P.CONTROLLER_COMMANDS.trialParams.params.duration; // {min:0, step:0.1} (not integer)
check('duration 2.5 kept (float allowed)', P.clampToSchema(2.5, dur), {
    value: 2.5,
    changed: false,
    reason: null
});
check('duration -1 -> 0', P.clampToSchema(-1, dur).value, 0);

// Non-numeric / no-schema inputs pass through untouched.
check('NaN passthrough', P.clampToSchema('abc', mv), {
    value: 'abc',
    changed: false,
    reason: null
});
check('null schema passthrough', P.clampToSchema(9999, null), {
    value: 9999,
    changed: false,
    reason: null
});
check('select schema passthrough', P.clampToSchema(2, { type: 'select' }), {
    value: 2,
    changed: false,
    reason: null
});

console.log('\n=== isG6OnlyCommand ===');
check('setAnalogOut is G6-only', P.isG6OnlyCommand('setAnalogOut'), true);
check('setDigitalOut is G6-only', P.isG6OnlyCommand('setDigitalOut'), true);
check('trialParams is NOT G6-only', P.isG6OnlyCommand('trialParams'), false);
check('allOn is NOT G6-only', P.isG6OnlyCommand('allOn'), false);

console.log(`\n${total - failures} / ${total} checks passed`);
process.exit(failures > 0 ? 1 : 0);
