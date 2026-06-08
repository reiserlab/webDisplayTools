#!/usr/bin/env node
/**
 * Golden-vector tests for js/arena-wire-g6.js (the G6 wire encoders + decoder).
 *
 * Run: node tests/test-arena-wire-g6.js
 *
 * Every encoder is pinned against bytes lifted from the reference host
 * encoders and the firmware:
 *   - scripts/play_pattern.py  (trial-params, set-frame-position)
 *   - scripts/all_on.py        (all-on / all-off)
 *   - scripts/web-serial/main.js (every button's byte sequence)
 *   - src/commands.h           (opcodes)
 * in the sibling repo LED-Display_G6_Firmware_Arena. The negative-gain int8
 * Mode-4 case is pinned explicitly — it's the easy-to-get-wrong one.
 *
 * Exits 0 on PASS, 1 on any FAIL. Wired into `npm test` for CI.
 */

'use strict';

const Wire = require('../js/arena-wire-g6.js');

let totalChecks = 0;
let failures = 0;

const hex = (bytes) =>
    Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');

// Assert an encoder's bytes equal an expected hex string (e.g. '0c 08 02').
function checkBytes(name, got, expectedHex) {
    totalChecks++;
    const gotHex = hex(got);
    const ok = gotHex === expectedHex;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got [${gotHex}], expected [${expectedHex}]`);
    if (!ok) failures++;
}

function check(name, got, expected) {
    totalChecks++;
    const ok = got === expected;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}, expected ${expected}`);
    if (!ok) failures++;
}

function checkBool(name, ok, info) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

// Assert a call throws (used for encoder range validation).
function checkThrows(name, fn) {
    totalChecks++;
    let threw = false;
    try {
        fn();
    } catch (_) {
        threw = true;
    }
    console.log(`  ${threw ? 'PASS' : 'FAIL'}  ${name}: ${threw ? 'threw' : 'did NOT throw'}`);
    if (!threw) failures++;
}

console.log('=== Simple command frames (all_on.py / main.js) ===');
checkBytes('encodeAllOn', Wire.encodeAllOn(), '01 ff');
checkBytes('encodeAllOff', Wire.encodeAllOff(), '01 00');
checkBytes('encodeStop', Wire.encodeStop(), '01 30');
checkBytes('encodeGetIp', Wire.encodeGetIp(), '01 66');
checkBytes('encodeGetControllerInfo', Wire.encodeGetControllerInfo(), '01 67');
checkBytes('getControllerInfo (alias)', Wire.getControllerInfo(), '01 67');
checkBytes('encodeGetSpiClock', Wire.encodeGetSpiClock(), '01 18');
checkBytes('encodeGetFramesSent', Wire.encodeGetFramesSent(), '01 19');
checkBytes('encodeResetFramesSent', Wire.encodeResetFramesSent(), '01 1a');

console.log('\n=== uint16 set-commands (main.js framing) ===');
checkBytes('encodeSetSpiClock(20)', Wire.encodeSetSpiClock(20), '03 17 14 00');
checkBytes('encodeSetRefreshRate(100)', Wire.encodeSetRefreshRate(100), '03 16 64 00');
checkBytes('encodeSetRefreshRate(200)', Wire.encodeSetRefreshRate(200), '03 16 c8 00');
checkBytes('encodeSetFramePosition(10)', Wire.encodeSetFramePosition(10), '03 70 0a 00');
// index 258 = 0x0102 exercises the high byte of the u16 LE.
checkBytes('encodeSetFramePosition(258)', Wire.encodeSetFramePosition(258), '03 70 02 01');

console.log('\n=== trial-params (0x08) — golden vectors from play_pattern.py ===');
// Mode 2, pattern 1, 30 fps, init 0 — the canonical golden vector.
checkBytes(
    'trial mode2 pat1 30fps init0',
    Wire.encodeTrialParams({ mode: 2, patternId: 1, frameRate: 30, initPos: 0 }),
    '0c 08 02 01 00 1e 00 00 00 00 00 00 00'
);
// Defaults: mode=2, patternId=1, frameRate=0, gain=0, initPos=0.
checkBytes(
    'trial defaults (mode2 pat1)',
    Wire.encodeTrialParams(),
    '0c 08 02 01 00 00 00 00 00 00 00 00 00'
);
// Mode 4 closed-loop, NEGATIVE gain -50 -> int8 byte 0xCE (the must-pin case).
checkBytes(
    'trial mode4 gain -50 -> 0xCE',
    Wire.encodeTrialParams({ mode: 4, patternId: 1, frameRate: 0, gain: -50, initPos: 0 }),
    '0c 08 04 01 00 00 00 ce 00 00 00 00 00'
);
// play_pattern.py docstring example: Mode 4 gain -20 -> int8 byte 0xEC.
checkBytes(
    'trial mode4 gain -20 -> 0xEC',
    Wire.encodeTrialParams({ mode: 4, patternId: 1, gain: -20 }),
    '0c 08 04 01 00 00 00 ec 00 00 00 00 00'
);
// int8 boundaries: -128 -> 0x80, 127 -> 0x7F, -1 -> 0xFF.
check('gain -128 byte', Wire.encodeTrialParams({ gain: -128 })[7], 0x80);
check('gain 127 byte', Wire.encodeTrialParams({ gain: 127 })[7], 0x7f);
check('gain -1 byte', Wire.encodeTrialParams({ gain: -1 })[7], 0xff);
// Mode 3 show-frame with a large pattern id / init exercises both u16 hi bytes.
checkBytes(
    'trial mode3 pat300 init513',
    Wire.encodeTrialParams({ mode: 3, patternId: 300, initPos: 513 }),
    '0c 08 03 2c 01 00 00 00 01 02 00 00 00'
);
// Length byte is always 0x0C (12 bytes follow: cmd + 11 params); total = 13 B.
check('trial frame total length', Wire.encodeTrialParams().length, 13);
check('trial length byte', Wire.encodeTrialParams()[0], 0x0c);

console.log('\n=== encoder range validation (throws) ===');
checkThrows('gain -129 throws', () => Wire.encodeTrialParams({ gain: -129 }));
checkThrows('gain 128 throws', () => Wire.encodeTrialParams({ gain: 128 }));
checkThrows('patternId 70000 throws', () => Wire.encodeTrialParams({ patternId: 70000 }));
checkThrows('frame position -1 throws', () => Wire.encodeSetFramePosition(-1));
checkThrows('frame position 70000 throws', () => Wire.encodeSetFramePosition(70000));
checkThrows('non-integer mhz throws', () => Wire.encodeSetSpiClock(20.5));

console.log('\n=== firmware domain validation (modes 2/3/4, patternId>=1, SPI 1..30) ===');
// Firmware only accepts modes 2/3/4 — fail fast instead of emitting a bad frame.
checkThrows('mode 1 throws', () => Wire.encodeTrialParams({ mode: 1 }));
checkThrows('mode 5 (stream) throws', () => Wire.encodeTrialParams({ mode: 5 }));
checkThrows('mode 0 throws', () => Wire.encodeTrialParams({ mode: 0 }));
checkBool('mode 2 ok', Wire.encodeTrialParams({ mode: 2 })[2] === 2);
checkBool('mode 3 ok', Wire.encodeTrialParams({ mode: 3 })[2] === 3);
checkBool('mode 4 ok', Wire.encodeTrialParams({ mode: 4 })[2] === 4);
// patternId is 1-based on the firmware.
checkThrows('patternId 0 throws', () => Wire.encodeTrialParams({ patternId: 0 }));
// SPI clock is clamped to 1..30 MHz on the firmware.
checkThrows('SPI clock 0 throws', () => Wire.encodeSetSpiClock(0));
checkThrows('SPI clock 31 throws', () => Wire.encodeSetSpiClock(31));
checkBytes('SPI clock 1 ok', Wire.encodeSetSpiClock(1), '03 17 01 00');
checkBytes('SPI clock 30 ok', Wire.encodeSetSpiClock(30), '03 17 1e 00');

console.log('\n=== decodeResponse framing ===');
// get-controller-info reply: [len=4, status=0, echo=0x67, version=2, cap=0x11].
// length byte = 4 = status + echo + 2 payload bytes.
const ciFrame = Uint8Array.from([0x04, 0x00, 0x67, 0x02, 0x11]);
const ci = Wire.decodeResponse(ciFrame);
checkBool('decodeResponse returns object', !!ci);
check('  .length', ci.length, 4);
check('  .status', ci.status, 0);
check('  .echoCmd', ci.echoCmd, 0x67);
check('  .ok', ci.ok, true);
checkBytes('  .payload', ci.payload, '02 11');

// A rejected command: status != 0 -> ok false.
const rej = Wire.decodeResponse(Uint8Array.from([0x02, 0x01, 0x08]));
check('rejected status', rej.status, 1);
check('rejected ok=false', rej.ok, false);

// Absent / malformed / incomplete frames -> null.
checkBool('empty frame -> null', Wire.decodeResponse(new Uint8Array([])) === null);
checkBool('length<2 -> null', Wire.decodeResponse(Uint8Array.from([0x01, 0x00])) === null);
checkBool(
    'incomplete frame -> null',
    Wire.decodeResponse(Uint8Array.from([0x05, 0x00, 0x67, 0x02])) === null,
    'claims 5 bytes, only 3 present'
);
// Regression: a plain number[] must NOT throw (TypedArray.slice rejects a
// non-typed-array receiver — decodeResponse normalizes to Uint8Array first).
const ciArr = Wire.decodeResponse([0x04, 0x00, 0x67, 0x02, 0x11]);
checkBool('decodeResponse(number[]) does not throw', !!ciArr);
checkBytes('decodeResponse(number[]) payload', ciArr.payload, '02 11');

console.log('\n=== field decoders (main.js / controller_info.py) ===');
// 0x11 = bit0 (g6_mode) + bit4 (v3_gated).
const info = Wire.decodeControllerInfo(ci);
check('controller version', info.version, 2);
check('controller capability', info.capability, 0x11);
check('controller caps', info.capabilities.join(','), 'g6_mode,v3_gated');
// Field decoders also accept a raw frame directly (asResponse coercion).
checkBool(
    'decodeControllerInfo accepts raw frame',
    Wire.decodeControllerInfo(ciFrame).version === 2
);
// A non-OK controller-info reply must not be decoded as valid metadata.
checkBool(
    'decodeControllerInfo rejects status!=0',
    Wire.decodeControllerInfo(Uint8Array.from([0x04, 0x01, 0x67, 0x02, 0x11])) === null
);

// SPI clock reply: [len=4, status=0, echo=0x18, 20, 0] -> 20 MHz.
check('decodeSpiClock', Wire.decodeSpiClock(Uint8Array.from([0x04, 0x00, 0x18, 0x14, 0x00])), 20);
checkBool(
    'decodeSpiClock rejects status!=0',
    Wire.decodeSpiClock(Uint8Array.from([0x04, 0x01, 0x18, 0x14, 0x00])) === null
);

// frames-sent reply: u32 LE. 0x12345678 -> 78 56 34 12.
check(
    'decodeFramesSent',
    Wire.decodeFramesSent(Uint8Array.from([0x06, 0x00, 0x19, 0x78, 0x56, 0x34, 0x12])),
    0x12345678
);
// High-bit-set value confirms unsigned (>>> 0) handling: 0xFFFFFFFF.
check(
    'decodeFramesSent unsigned',
    Wire.decodeFramesSent(Uint8Array.from([0x06, 0x00, 0x19, 0xff, 0xff, 0xff, 0xff])),
    4294967295
);

// get-ip reply: ASCII payload "10.0.0.5".
const ipAscii = '10.0.0.5';
const ipBytes = [ipAscii.length + 2, 0x00, 0x66, ...Array.from(ipAscii, (c) => c.charCodeAt(0))];
check('decodeIp', Wire.decodeIp(Uint8Array.from(ipBytes)), '10.0.0.5');

console.log(`\n=== Summary ===\n${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
