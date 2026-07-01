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
checkBytes('encodeGetIp', Wire.encodeGetIp(), '01 c1');
checkBytes('encodeGetControllerInfo', Wire.encodeGetControllerInfo(), '01 c2');
checkBytes('getControllerInfo (alias)', Wire.getControllerInfo(), '01 c2');
checkBytes('encodeGetSpiClock', Wire.encodeGetSpiClock(), '01 c6');
checkBytes('encodeGetFramesSent', Wire.encodeGetFramesSent(), '01 33');
checkBytes('encodeResetFramesSent', Wire.encodeResetFramesSent(), '01 34');

console.log('\n=== uint16 set-commands (main.js framing) ===');
checkBytes('encodeSetSpiClock(20)', Wire.encodeSetSpiClock(20), '03 c5 14 00');
checkBytes('encodeSetRefreshRate(100)', Wire.encodeSetRefreshRate(100), '03 16 64 00');
checkBytes('encodeSetRefreshRate(200)', Wire.encodeSetRefreshRate(200), '03 16 c8 00');
checkBytes('encodeSetFramePosition(10)', Wire.encodeSetFramePosition(10), '03 70 0a 00');
// index 258 = 0x0102 exercises the high byte of the u16 LE.
checkBytes('encodeSetFramePosition(258)', Wire.encodeSetFramePosition(258), '03 70 02 01');

console.log('\n=== G6 analog/digital output (0xA0 / 0xAA) ===');
// set-ao-voltage (0xA0): mv as u16 LE. 2500 = 0x09C4 -> lo C4, hi 09.
checkBytes('encodeSetAoVoltage(2500)', Wire.encodeSetAoVoltage(2500), '03 a0 c4 09');
checkBytes('encodeSetAoVoltage(0)', Wire.encodeSetAoVoltage(0), '03 a0 00 00');
checkBytes('encodeSetAoVoltage(5000)', Wire.encodeSetAoVoltage(5000), '03 a0 88 13');
// set-digital-out (0xAA): [channel, state].
checkBytes('encodeSetDigitalOut(1,1)', Wire.encodeSetDigitalOut(1, 1), '03 aa 01 01');
checkBytes('encodeSetDigitalOut(2,0)', Wire.encodeSetDigitalOut(2, 0), '03 aa 02 00');

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
checkThrows('ao voltage 6000 mV throws', () => Wire.encodeSetAoVoltage(6000));
checkThrows('ao voltage -1 mV throws', () => Wire.encodeSetAoVoltage(-1));
checkThrows('digital out channel 3 throws', () => Wire.encodeSetDigitalOut(3, 1));

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
checkBytes('SPI clock 1 ok', Wire.encodeSetSpiClock(1), '03 c5 01 00');
checkBytes('SPI clock 30 ok', Wire.encodeSetSpiClock(30), '03 c5 1e 00');

console.log('\n=== stream-frame (0x32) — firmware SerialManager stream header ===');
check('OPCODES.STREAM_FRAME', Wire.OPCODES.STREAM_FRAME, 0x32);
check('STREAM_FRAME_BYTES.GS2', Wire.STREAM_FRAME_BYTES.GS2, 1064);
check('STREAM_FRAME_BYTES.GS16', Wire.STREAM_FRAME_BYTES.GS16, 4064);
// On-wire: [0x32, len_lo, len_hi, ...payload]. GS16 len 4064 = 0x0FE0 LE.
const sfGs16 = Wire.encodeStreamFrame(new Uint8Array(4064));
checkBytes('stream GS16 header', sfGs16.subarray(0, 3), '32 e0 0f');
check('stream GS16 total length', sfGs16.length, 4067);
// GS2 len 1064 = 0x0428 LE.
const sfGs2 = Wire.encodeStreamFrame(new Uint8Array(1064));
checkBytes('stream GS2 header', sfGs2.subarray(0, 3), '32 28 04');
check('stream GS2 total length', sfGs2.length, 1067);
// Payload is copied verbatim after the 3-byte header (first + last byte).
const sfMarked = new Uint8Array(1064);
sfMarked[0] = 0x46;
sfMarked[1063] = 0xab;
const sfM = Wire.encodeStreamFrame(sfMarked);
check('stream payload[0] copied', sfM[3], 0x46);
check('stream payload[last] copied', sfM[1066], 0xab);
// Accepts a plain number[] receiver too.
checkBool(
    'stream accepts number[]',
    Wire.encodeStreamFrame(new Array(1064).fill(0)).length === 1067
);
// Only the two firmware-accepted sizes are valid (mode inferred from size).
checkThrows('stream wrong size 100 throws', () => Wire.encodeStreamFrame(new Uint8Array(100)));
checkThrows('stream wrong size 4063 throws', () => Wire.encodeStreamFrame(new Uint8Array(4063)));

console.log('\n=== decodeResponse framing ===');
// get-controller-info reply: [len=4, status=0, echo=0xC2, version=2, cap=0x11].
// length byte = 4 = status + echo + 2 payload bytes.
const ciFrame = Uint8Array.from([0x04, 0x00, 0xc2, 0x02, 0x11]);
const ci = Wire.decodeResponse(ciFrame);
checkBool('decodeResponse returns object', !!ci);
check('  .length', ci.length, 4);
check('  .status', ci.status, 0);
check('  .echoCmd', ci.echoCmd, 0xc2);
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
    Wire.decodeResponse(Uint8Array.from([0x05, 0x00, 0xc2, 0x02])) === null,
    'claims 5 bytes, only 3 present'
);
// Regression: a plain number[] must NOT throw (TypedArray.slice rejects a
// non-typed-array receiver — decodeResponse normalizes to Uint8Array first).
const ciArr = Wire.decodeResponse([0x04, 0x00, 0xc2, 0x02, 0x11]);
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
    Wire.decodeControllerInfo(Uint8Array.from([0x04, 0x01, 0xc2, 0x02, 0x11])) === null
);

// SPI clock reply: [len=4, status=0, echo=0xC6, 20, 0] -> 20 MHz.
check('decodeSpiClock', Wire.decodeSpiClock(Uint8Array.from([0x04, 0x00, 0xc6, 0x14, 0x00])), 20);
checkBool(
    'decodeSpiClock rejects status!=0',
    Wire.decodeSpiClock(Uint8Array.from([0x04, 0x01, 0xc6, 0x14, 0x00])) === null
);

// frames-sent reply: u32 LE. 0x12345678 -> 78 56 34 12.
check(
    'decodeFramesSent',
    Wire.decodeFramesSent(Uint8Array.from([0x06, 0x00, 0x33, 0x78, 0x56, 0x34, 0x12])),
    0x12345678
);
// High-bit-set value confirms unsigned (>>> 0) handling: 0xFFFFFFFF.
check(
    'decodeFramesSent unsigned',
    Wire.decodeFramesSent(Uint8Array.from([0x06, 0x00, 0x33, 0xff, 0xff, 0xff, 0xff])),
    4294967295
);

// get-ip reply: ASCII payload "10.0.0.5".
const ipAscii = '10.0.0.5';
const ipBytes = [ipAscii.length + 2, 0x00, 0xc1, ...Array.from(ipAscii, (c) => c.charCodeAt(0))];
check('decodeIp', Wire.decodeIp(Uint8Array.from(ipBytes)), '10.0.0.5');

console.log('\n=== set-pattern-filename (0x83) opcode-first framing ===');
// Short name: [0x83, idx_lo, idx_hi, name_len, chars...] — NO leading length byte.
// "a.pat" (5 chars), idx=0 → [83 00 00 05 61 2e 70 61 74]
checkBytes(
    'encodeSetPatternFilename idx=0 short',
    Wire.encodeSetPatternFilename(0, 'a.pat'),
    '83 00 00 05 61 2e 70 61 74'
);
// 50-char name (the failing case): length would have been 0x36 > 0x32 in the old framing.
// With opcode-first, the first byte is always 0x83 regardless of name length.
const longName = '0019_right_window_yaw_stepsize0.46875_final_G6.pat'; // 50 chars
const longFrame = Wire.encodeSetPatternFilename(0, longName);
check('encodeSetPatternFilename long: first byte is opcode 0x83', longFrame[0], 0x83);
check(
    'encodeSetPatternFilename long: length byte absent (frame.length = 4+name)',
    longFrame.length,
    54
);
check('encodeSetPatternFilename long: name_len byte = 50', longFrame[3], 50);
checkThrows('encodeSetPatternFilename 64-char name throws', () =>
    Wire.encodeSetPatternFilename(0, 'a'.repeat(64))
);
checkThrows('encodeSetPatternFilename empty name throws', () =>
    Wire.encodeSetPatternFilename(0, '')
);

console.log('\n=== panel firmware / ISP (0xE0 / 0xE3 / 0xC8) ===');

// get-firmware-info (0xE3): plain [01 E3].
checkBytes('encodeGetFirmwareInfo', Wire.encodeGetFirmwareInfo(), '01 e3');

// g6-program-panel (0xC8): [02 C8 panel_number], 1-based panel number.
checkBytes('encodeG6ProgramPanel(1)', Wire.encodeG6ProgramPanel(1), '02 c8 01');
checkBytes('encodeG6ProgramPanel(20)', Wire.encodeG6ProgramPanel(20), '02 c8 14');
checkThrows('encodeG6ProgramPanel(0) throws (1-based)', () => Wire.encodeG6ProgramPanel(0));
checkThrows('encodeG6ProgramPanel(256) throws', () => Wire.encodeG6ProgramPanel(256));

// g6-verify-panel (0xC9): [02 C9 panel_number], 1-based panel number.
checkBytes('encodeG6VerifyPanel(1)', Wire.encodeG6VerifyPanel(1), '02 c9 01');
checkBytes('encodeG6VerifyPanel(20)', Wire.encodeG6VerifyPanel(20), '02 c9 14');
checkThrows('encodeG6VerifyPanel(0) throws (1-based)', () => Wire.encodeG6VerifyPanel(0));
checkThrows('encodeG6VerifyPanel(256) throws', () => Wire.encodeG6VerifyPanel(256));

// set-firmware-file (0xE0): opcode-first, NO index, uint64 LE length then data.
// data [01 02 03 04] → [e0, 04 00 00 00 00 00 00 00, 01 02 03 04].
checkBytes(
    'encodeSetFirmwareFile([1,2,3,4])',
    Wire.encodeSetFirmwareFile(Uint8Array.from([1, 2, 3, 4])),
    'e0 04 00 00 00 00 00 00 00 01 02 03 04'
);
check(
    'encodeSetFirmwareFile total length = 9 + data',
    Wire.encodeSetFirmwareFile(new Uint8Array(100)).length,
    109
);

// set-firmware-file reply: uint32 LE CRC-32 (0x12345678 → 78 56 34 12).
check(
    'decodeSetFirmwareFileResponse',
    Wire.decodeSetFirmwareFileResponse(Uint8Array.from([0x06, 0x00, 0xe0, 0x78, 0x56, 0x34, 0x12])),
    0x12345678
);
checkBool(
    'decodeSetFirmwareFileResponse rejects status!=0',
    Wire.decodeSetFirmwareFileResponse(Uint8Array.from([0x05, 0x01, 0xe0, 0, 0, 0, 0])) === null
);

// get-firmware-info reply: 32-byte footer {magic[8], version[16], crc32 LE, size LE}.
const footer = new Uint8Array(32);
footer.set(
    Array.from('G6PANFW\0', (c) => c.charCodeAt(0)),
    0
);
footer.set(
    Array.from('1a2b3c4d', (c) => c.charCodeAt(0)),
    8
); // version, NUL-padded
footer.set([0x21, 0x12, 0x23, 0x21], 24); // crc32 = 0x21231221 LE
footer.set([0x00, 0x67, 0x01, 0x00], 28); // size = 91904 (0x00016700) LE
const fwInfoFrame = Uint8Array.from([2 + 32, 0x00, 0xe3, ...footer]);
const fwInfo = Wire.decodeFirmwareInfo(fwInfoFrame);
checkBool('decodeFirmwareInfo returns object', !!fwInfo);
check('decodeFirmwareInfo magic', fwInfo && fwInfo.magic, 'G6PANFW');
check('decodeFirmwareInfo version', fwInfo && fwInfo.version, '1a2b3c4d');
check('decodeFirmwareInfo imageCrc32', fwInfo && fwInfo.imageCrc32, 0x21231221);
check('decodeFirmwareInfo imageSize', fwInfo && fwInfo.imageSize, 91904);
checkBool(
    'decodeFirmwareInfo short payload -> null',
    Wire.decodeFirmwareInfo(Uint8Array.from([0x03, 0x00, 0xe3, 0x00])) === null
);

// g6-program-panel reply: status + ASCII detail.
const okFlash = Wire.decodeProgramPanelResponse(Uint8Array.from([0x02, 0x00, 0xc8]));
checkBool('decodeProgramPanelResponse success ok=true', okFlash && okFlash.ok === true);
const failAscii = 'ISP_ENTER failed';
const failFrame = [
    failAscii.length + 2,
    0x01,
    0xc8,
    ...Array.from(failAscii, (c) => c.charCodeAt(0))
];
const failFlash = Wire.decodeProgramPanelResponse(Uint8Array.from(failFrame));
checkBool('decodeProgramPanelResponse failure ok=false', failFlash && failFlash.ok === false);
check('decodeProgramPanelResponse failure message', failFlash && failFlash.message, failAscii);

console.log('\n=== get-pattern-info (0x88) — issue #18 ===');
check('OPCODES.GET_PATTERN_INFO', Wire.OPCODES.GET_PATTERN_INFO, 0x88);
// [03 88 idx_lo idx_hi], 1-based. 1 -> 01 00; 258 = 0x0102 exercises the hi byte.
checkBytes('encodeGetPatternInfo(1)', Wire.encodeGetPatternInfo(1), '03 88 01 00');
checkBytes('encodeGetPatternInfo(258)', Wire.encodeGetPatternInfo(258), '03 88 02 01');
checkThrows('encodeGetPatternInfo(0) throws (1-based)', () => Wire.encodeGetPatternInfo(0));
// decodePatternInfo: 12-byte LE payload
//   frame_count u16 · gs u8 · rows u8 · cols u8 · arena u8 · obs u8 · file_size u32 · stretch u8
// length byte = 2 + 12 = 0x0E. Values: frames 258, GS2, 2x10, arena 5, obs 9,
// file_size 91904 (0x00016700 LE), stretch 0xAB.
const piFrame = Uint8Array.from([
    0x0e, 0x00, 0x88,
    0x02, 0x01, 0x02, 0x02, 0x0a, 0x05, 0x09, 0x00, 0x67, 0x01, 0x00, 0xab
]);
const pi = Wire.decodePatternInfo(piFrame);
checkBool('decodePatternInfo returns object', !!pi);
check('  .frameCount', pi && pi.frameCount, 258);
check('  .gsVal', pi && pi.gsVal, 2);
check('  .rows', pi && pi.rows, 2);
check('  .cols', pi && pi.cols, 10);
check('  .arenaId', pi && pi.arenaId, 5);
check('  .observerId', pi && pi.observerId, 9);
check('  .fileSize', pi && pi.fileSize, 91904);
check('  .stretch', pi && pi.stretch, 0xab);
checkBool(
    'decodePatternInfo rejects status!=0',
    Wire.decodePatternInfo(Uint8Array.from([0x0e, 0x01, 0x88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) === null
);
checkBool(
    'decodePatternInfo short payload -> null',
    Wire.decodePatternInfo(Uint8Array.from([0x03, 0x00, 0x88, 0x02])) === null
);

console.log('\n=== set/get-panel-display-mode (0x1B / 0x1C) — issue #19 ===');
check('OPCODES.SET_PANEL_DISPLAY_MODE', Wire.OPCODES.SET_PANEL_DISPLAY_MODE, 0x1b);
check('OPCODES.GET_PANEL_DISPLAY_MODE', Wire.OPCODES.GET_PANEL_DISPLAY_MODE, 0x1c);
check('PANEL_DISPLAY_MODE_NAMES[0]', Wire.PANEL_DISPLAY_MODE_NAMES[0], 'oneshot');
check('PANEL_DISPLAY_MODE_NAMES[1]', Wire.PANEL_DISPLAY_MODE_NAMES[1], 'persist');
check('PANEL_DISPLAY_MODE_NAMES[3]', Wire.PANEL_DISPLAY_MODE_NAMES[3], 'gated');
// set: [02 1B mode].
checkBytes('encodeSetPanelDisplayMode(0)', Wire.encodeSetPanelDisplayMode(0), '02 1b 00');
checkBytes('encodeSetPanelDisplayMode(1)', Wire.encodeSetPanelDisplayMode(1), '02 1b 01');
checkBytes('encodeSetPanelDisplayMode(3)', Wire.encodeSetPanelDisplayMode(3), '02 1b 03');
checkThrows('encodeSetPanelDisplayMode(4) throws', () => Wire.encodeSetPanelDisplayMode(4));
checkThrows('encodeSetPanelDisplayMode(-1) throws', () => Wire.encodeSetPanelDisplayMode(-1));
// get: [01 1C].
checkBytes('encodeGetPanelDisplayMode', Wire.encodeGetPanelDisplayMode(), '01 1c');
// decode: single mode byte from a 0x1C reply [03 00 1C mode] or 0x1B echo.
check('decodePanelDisplayMode(0x1C=2)', Wire.decodePanelDisplayMode(Uint8Array.from([0x03, 0x00, 0x1c, 0x02])), 2);
check('decodePanelDisplayMode(0x1B echo=1)', Wire.decodePanelDisplayMode(Uint8Array.from([0x03, 0x00, 0x1b, 0x01])), 1);
checkBool(
    'decodePanelDisplayMode rejects status!=0',
    Wire.decodePanelDisplayMode(Uint8Array.from([0x03, 0x01, 0x1c, 0x02])) === null
);

console.log(`\n=== Summary ===\n${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
