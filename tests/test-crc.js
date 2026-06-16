#!/usr/bin/env node
/**
 * CRC spec-vector + corruption tests for the JS implementation.
 *
 * Run: node tests/test-crc.js
 *
 * Exits 0 on PASS, 1 on any FAIL. Used in CI.
 */

const fs = require('fs');
const path = require('path');

const G6CRC = require('../js/crc.js');
const PatEncoder = require('../js/pat-encoder.js');
const _patParser = require('../js/pat-parser.js');
const PatParser = _patParser.default || _patParser;

let totalChecks = 0;
let failures = 0;

function check(name, got, expected) {
    totalChecks++;
    const ok = got === expected;
    const gotStr =
        typeof got === 'number'
            ? '0x' +
              got
                  .toString(16)
                  .toUpperCase()
                  .padStart(expected > 0xff ? 4 : 2, '0')
            : got;
    const expStr =
        typeof expected === 'number'
            ? '0x' +
              expected
                  .toString(16)
                  .toUpperCase()
                  .padStart(expected > 0xff ? 4 : 2, '0')
            : expected;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${gotStr}, expected ${expStr}`);
    if (!ok) failures++;
}

function checkBool(name, ok, info) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

console.log('=== CRC universal checks ===');
const enc = new TextEncoder();
check('CRC-8/AUTOSAR("123456789")', G6CRC.crc8Autosar(enc.encode('123456789')), 0xdf);
check('CRC-16/CCITT-FALSE("123456789")', G6CRC.crc16CcittFalse(enc.encode('123456789')), 0x29b1);

console.log('\n=== CRC-8 protocol vectors ===');
const v2L = new Uint8Array(53);
v2L[0] = 0x01;
v2L[1] = 0x10;
check('2L Oneshot all-zero (53B)', G6CRC.crc8Autosar(v2L), 0xc6);
const v16L = new Uint8Array(203);
v16L[0] = 0x01;
v16L[1] = 0x30;
check('16L Oneshot all-zero (203B)', G6CRC.crc8Autosar(v16L), 0x6d);

console.log('\n=== CRC-16 protocol vectors ===');
check(
    'Frame-header all-zero (FR + 0x00 0x00)',
    G6CRC.crc16CcittFalse(new Uint8Array([0x46, 0x52, 0x00, 0x00])),
    0xfd6b
);

console.log('\n=== Cross-check against g6_encoding_reference.json ===');
const refPath = path.resolve(__dirname, '../data/g6_encoding_reference.json');
const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
const crcRef = ref.crc_test_vectors;
checkBool('reference JSON has crc_test_vectors', !!crcRef);
checkBool(
    'reference JSON has crc8_autosar.vectors',
    !!(crcRef && crcRef.crc8_autosar && crcRef.crc8_autosar.vectors)
);
checkBool(
    'reference JSON has crc16_ccitt_false.vectors',
    !!(crcRef && crcRef.crc16_ccitt_false && crcRef.crc16_ccitt_false.vectors)
);

console.log('\n=== Round-trip + corruption tests ===');
const _g = console.group,
    _l = console.log,
    _ge = console.groupEnd,
    _w = console.warn;
const mute = () => {
    console.group = () => {};
    console.log = () => {};
    console.groupEnd = () => {};
    console.warn = () => {};
};
const unmute = () => {
    console.group = _g;
    console.log = _l;
    console.groupEnd = _ge;
    console.warn = _w;
};

const rows = 2,
    cols = 10,
    pixelRows = rows * 20,
    pixelCols = cols * 20,
    N = 8;
const frames = [];
for (let f = 0; f < N; f++) {
    const fr = new Uint8Array(pixelRows * pixelCols);
    for (let i = 0; i < fr.length; i++) fr[i] = (i + f) % 2;
    frames.push(fr);
}
const buf = PatEncoder.encode({
    generation: 'G6',
    gs_val: 1,
    numFrames: N,
    rowCount: rows,
    colCount: cols,
    pixelRows,
    pixelCols,
    frames,
    stretchValues: new Array(N).fill(1),
    arena_id: 1,
    observer_id: 0
});

mute();
let parsed;
try {
    parsed = PatParser.parsePatFile(buf, { strict: true });
} catch (e) {
    unmute();
    console.log('  FAIL  strict parse on clean file threw: ' + e.message);
    failures++;
}
unmute();
if (parsed) {
    checkBool('Strict parse of clean file succeeded', true);
    let mm = 0;
    for (let f = 0; f < N; f++)
        for (let i = 0; i < frames[f].length; i++) if (frames[f][i] !== parsed.frames[f][i]) mm++;
    checkBool('Pixel content survives encode→parse', mm === 0, `mismatches=${mm}`);
}

// Header corruption test
const bad = new Uint8Array(buf.slice(0));
bad[5] ^= 0x01;
let strictHeaderThrew = false;
mute();
try {
    PatParser.parsePatFile(bad.buffer, { strict: true });
} catch (e) {
    strictHeaderThrew = e.message.includes('header CRC-8 mismatch');
}
unmute();
checkBool('Strict mode throws on header CRC-8 corruption', strictHeaderThrew);

// Frame body corruption test
const bad2 = new Uint8Array(buf.slice(0));
const frameBytes = 4 + rows * cols * 53 + 2;
bad2[18 + 3 * frameBytes + 10] ^= 0x80;
let strictFrameThrew = false;
mute();
try {
    PatParser.parsePatFile(bad2.buffer, { strict: true });
} catch (e) {
    strictFrameThrew = e.message.includes('CRC-16 mismatch');
}
unmute();
checkBool('Strict mode throws on frame CRC-16 corruption', strictFrameThrew);

// Tolerant mode parses despite corruption
let tolerantOK = false;
mute();
try {
    const r = PatParser.parsePatFile(bad.buffer, { strict: false });
    tolerantOK = r && r.numFrames === N;
} catch (_) {}
unmute();
checkBool('Tolerant mode parses past header corruption', tolerantOK);

console.log(`\n=== Summary ===\n${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
