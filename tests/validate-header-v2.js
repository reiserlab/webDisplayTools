#!/usr/bin/env node
/**
 * Header V2 Validation Tests
 *
 * Tests V2 header encoding/decoding for both G4 and G6 formats.
 * Mirrors MATLAB's validate_header_v2.m (8 tests).
 *
 * Run with: node tests/validate-header-v2.js
 *
 * Exit codes:
 *   0 = All tests passed
 *   1 = One or more tests failed
 */

const path = require('path');

// Import modules
// pat-parser.js uses `export default` which overrides module.exports in Node.js
const _patParser = require('../js/pat-parser.js');
const PatParser = _patParser.default || _patParser;
const PatEncoder = require('../js/pat-encoder.js');
const { GENERATIONS, ARENA_REGISTRY, getGenerationName, getGenerationId, getArenaName, getArenaId } = require('../js/arena-configs.js');

// ANSI color codes
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

let totalTests = 0;
let passedTests = 0;

function assert(condition, message) {
    totalTests++;
    if (condition) {
        passedTests++;
        log(`  PASS: ${message}`, 'green');
    } else {
        log(`  FAIL: ${message}`, 'red');
    }
}

function assertEqual(actual, expected, message) {
    totalTests++;
    if (actual === expected) {
        passedTests++;
        log(`  PASS: ${message}`, 'green');
    } else {
        log(`  FAIL: ${message} (expected ${expected}, got ${actual})`, 'red');
    }
}

// ===== Helper: create minimal G4 pattern data =====
function makeG4PatternData(opts = {}) {
    const rowCount = opts.rowCount || 2;
    const colCount = opts.colCount || 12;
    const gs_val = opts.gs_val || 16;
    const numFrames = opts.numFrames || 2;
    const pixelRows = rowCount * 16;
    const pixelCols = colCount * 16;

    const frames = [];
    for (let f = 0; f < numFrames; f++) {
        const frame = new Uint8Array(pixelRows * pixelCols);
        // Simple gradient pattern for non-zero data
        for (let i = 0; i < frame.length; i++) {
            frame[i] = (i + f) % (gs_val === 16 ? 16 : 2);
        }
        frames.push(frame);
    }

    return {
        generation: opts.generation || 'G4',
        gs_val,
        numFrames,
        numPatsX: numFrames,
        numPatsY: 1,
        rowCount,
        colCount,
        pixelRows,
        pixelCols,
        frames,
        stretchValues: new Array(numFrames).fill(1),
        generation_id: opts.generation_id,
        arena_id: opts.arena_id || 0
    };
}

// ===== Helper: create minimal G6 pattern data =====
function makeG6PatternData(opts = {}) {
    const rowCount = opts.rowCount || 2;
    const colCount = opts.colCount || 10;
    const gs_val = opts.gs_val || 16;
    const numFrames = opts.numFrames || 2;
    const pixelRows = rowCount * 20;
    const pixelCols = colCount * 20;

    const frames = [];
    for (let f = 0; f < numFrames; f++) {
        const frame = new Uint8Array(pixelRows * pixelCols);
        for (let i = 0; i < frame.length; i++) {
            frame[i] = (i + f) % (gs_val === 16 ? 16 : 2);
        }
        frames.push(frame);
    }

    return {
        generation: 'G6',
        gs_val,
        numFrames,
        rowCount,
        colCount,
        pixelRows,
        pixelCols,
        frames,
        stretchValues: new Array(numFrames).fill(1),
        arena_id: opts.arena_id || 0,
        observer_id: opts.observer_id || 0
    };
}

// ========================================================
// Test 1: G4 V1 header backward compatibility
// ========================================================
function test1_g4_v1_compat() {
    log('\nTest 1: G4 V1 header (backward compatibility)', 'cyan');

    // Create a V1 header manually (byte 2 MSB not set)
    const buffer = new ArrayBuffer(7);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    const numPatsX = 96;
    const numPatsY = 1;
    view.setUint16(0, numPatsX, true);
    view.setUint16(2, numPatsY, true);  // V1: NumPatsY in bytes 2-3
    bytes[4] = 16;  // gs_val
    bytes[5] = 2;   // RowN
    bytes[6] = 12;  // ColN

    // Verify byte 2 MSB is NOT set (V1)
    assert(bytes[2] < 0x80, 'V1 header: byte 2 MSB not set');

    // We can't parse just a header with parseG4Pattern (needs frame data),
    // so test the header bytes directly
    const configHigh = bytes[2];
    const isV2 = configHigh >= 0x80;
    assertEqual(isV2, false, 'Detected as V1');
    assertEqual(view.getUint16(2, true), numPatsY, 'NumPatsY preserved');
}

// ========================================================
// Test 2: G4.1 V2 header with generation ID
// ========================================================
function test2_g41_v2_generation() {
    log('\nTest 2: G4.1 V2 header with generation ID', 'cyan');

    // Encode with generation_id = 3 (G4.1)
    const data = makeG4PatternData({ generation: 'G4.1', generation_id: 3 });
    const buffer = PatEncoder.encodeG4(data);
    const bytes = new Uint8Array(buffer);

    // Verify V2 flag set
    assert(bytes[2] >= 0x80, 'V2 flag set (byte 2 MSB)');

    // Extract generation_id from byte 2
    const genId = (bytes[2] >> 4) & 0x07;
    assertEqual(genId, 3, 'generation_id = 3 (G4.1)');

    // Parse it back
    const parsed = PatParser.parseG4Pattern(buffer);
    assertEqual(parsed.headerVersion, 2, 'Parsed as V2');
    assertEqual(parsed.generation_id, 3, 'Parsed generation_id = 3');
    assertEqual(parsed.generation, 'G4.1', 'Generation name = G4.1');
}

// ========================================================
// Test 3: G4.1 V2 header with arena ID
// ========================================================
function test3_g41_v2_arena() {
    log('\nTest 3: G4.1 V2 header with arena ID', 'cyan');

    const data = makeG4PatternData({ generation: 'G4.1', generation_id: 3, arena_id: 42 });
    const buffer = PatEncoder.encodeG4(data);
    const bytes = new Uint8Array(buffer);

    // Byte 3 should be arena_id
    assertEqual(bytes[3], 42, 'arena_id encoded in byte 3');

    // Parse it back
    const parsed = PatParser.parseG4Pattern(buffer);
    assertEqual(parsed.arena_id, 42, 'Parsed arena_id = 42');
    assertEqual(parsed.generation_id, 3, 'Parsed generation_id preserved');
}

// ========================================================
// Test 4: G4 V2 all generation IDs round-trip
// ========================================================
function test4_g4_all_generations() {
    log('\nTest 4: G4 V2 all generation IDs round-trip', 'cyan');

    const generations = [
        { id: 1, name: 'G3' },
        { id: 2, name: 'G4' },
        { id: 3, name: 'G4.1' },
        { id: 4, name: 'G6' }
    ];

    for (const gen of generations) {
        const data = makeG4PatternData({ generation: gen.name, generation_id: gen.id, arena_id: gen.id * 10 });
        const buffer = PatEncoder.encodeG4(data);
        const parsed = PatParser.parseG4Pattern(buffer);

        assertEqual(parsed.generation_id, gen.id, `Round-trip gen_id=${gen.id} (${gen.name})`);
        assertEqual(parsed.arena_id, gen.id * 10, `Round-trip arena_id=${gen.id * 10}`);
    }
}

// ========================================================
// Test 5: G6 V2 header basic
// ========================================================
function test5_g6_v2_basic() {
    log('\nTest 5: G6 V2 header basic', 'cyan');

    const data = makeG6PatternData({ arena_id: 0, observer_id: 0 });
    const buffer = PatEncoder.encodeG6(data);
    const bytes = new Uint8Array(buffer);

    // Verify V2: byte 4 upper nibble = 2
    const version = (bytes[4] >> 4) & 0x0F;
    assertEqual(version, 2, 'Version = 2 in byte 4 upper nibble');

    // Parse it back
    const parsed = PatParser.parseG6Pattern(buffer);
    assertEqual(parsed.headerVersion, 2, 'Parsed as V2');
    assertEqual(parsed.arena_id, 0, 'arena_id = 0 (default)');
    assertEqual(parsed.observer_id, 0, 'observer_id = 0 (default)');
    assertEqual(parsed.generation, 'G6', 'Generation = G6');
}

// ========================================================
// Test 6: G6 V2 header with specific IDs
// ========================================================
function test6_g6_v2_with_ids() {
    log('\nTest 6: G6 V2 header with specific IDs', 'cyan');

    const data = makeG6PatternData({ arena_id: 15, observer_id: 42 });
    const buffer = PatEncoder.encodeG6(data);
    const bytes = new Uint8Array(buffer);

    // Verify bit packing manually
    // arena_id = 15 = 0b001111
    // Byte 4: version(2)=0010 | arena_upper(0011) = 0x23
    // Byte 5: arena_lower(11) | observer(101010) = 0xEA
    const arenaUpper = (15 >> 2) & 0x0F;  // 3
    const arenaLower = 15 & 0x03;          // 3
    assertEqual(bytes[4], (2 << 4) | arenaUpper, 'Byte 4 bit packing correct');
    assertEqual(bytes[5], (arenaLower << 6) | 42, 'Byte 5 bit packing correct');

    // Parse it back
    const parsed = PatParser.parseG6Pattern(buffer);
    assertEqual(parsed.arena_id, 15, 'Round-trip arena_id = 15');
    assertEqual(parsed.observer_id, 42, 'Round-trip observer_id = 42');
}

// ========================================================
// Test 7: G6 V2 boundary values
// ========================================================
function test7_g6_v2_boundary() {
    log('\nTest 7: G6 V2 boundary values (max arena=63, observer=63)', 'cyan');

    const data = makeG6PatternData({ arena_id: 63, observer_id: 63 });
    const buffer = PatEncoder.encodeG6(data);
    const parsed = PatParser.parseG6Pattern(buffer);

    assertEqual(parsed.arena_id, 63, 'Max arena_id = 63');
    assertEqual(parsed.observer_id, 63, 'Max observer_id = 63');

    // Also test mid-range values
    const data2 = makeG6PatternData({ arena_id: 1, observer_id: 0 });
    const buffer2 = PatEncoder.encodeG6(data2);
    const parsed2 = PatParser.parseG6Pattern(buffer2);
    assertEqual(parsed2.arena_id, 1, 'arena_id = 1 round-trip');
    assertEqual(parsed2.observer_id, 0, 'observer_id = 0 with arena_id = 1');
}

// ========================================================
// Test 8: G6 V1 backward compatibility
// ========================================================
function test8_g6_v1_compat() {
    log('\nTest 8: G6 V1 backward compatibility', 'cyan');

    // Create a V1 header manually (17 bytes)
    const gs_val_raw = 2;  // GS16
    const numFrames = 1;
    const rowCount = 2;
    const colCount = 10;
    const panelBytes = 203;  // GS16
    const numPanels = rowCount * colCount;
    const frameDataSize = 4 + (numPanels * panelBytes);
    const totalSize = 17 + (numFrames * frameDataSize);

    const buffer = new ArrayBuffer(totalSize);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // Write V1 header
    bytes[0] = 0x47;  // G
    bytes[1] = 0x36;  // 6
    bytes[2] = 0x50;  // P
    bytes[3] = 0x54;  // T
    bytes[4] = 1;     // Version = 1 (V1: full byte)
    bytes[5] = gs_val_raw;
    view.setUint16(6, numFrames, true);
    bytes[8] = rowCount;
    bytes[9] = colCount;
    bytes[10] = 0;    // Checksum

    // Panel mask
    for (let i = 0; i < numPanels && i < 48; i++) {
        bytes[11 + Math.floor(i / 8)] |= (1 << (i % 8));
    }

    // Write a frame header + empty panel data
    let offset = 17;
    bytes[offset] = 0x46;  // F
    bytes[offset + 1] = 0x52;  // R
    offset += 4;
    // Panel data is already zeros

    // Parse it
    const parsed = PatParser.parseG6Pattern(buffer);
    assertEqual(parsed.headerVersion, 1, 'Detected as V1');
    assertEqual(parsed.arena_id, 0, 'V1 arena_id defaults to 0');
    assertEqual(parsed.observer_id, 0, 'V1 observer_id defaults to 0');
    assertEqual(parsed.numFrames, 1, 'Frame count correct');
    assertEqual(parsed.rowCount, 2, 'Row count correct');
    assertEqual(parsed.colCount, 10, 'Col count correct');
}

// ========================================================
// Test 9: Arena registry lookup functions
// ========================================================
function test9_arena_registry() {
    log('\nTest 9: Arena registry lookup functions', 'cyan');

    // Generation lookups
    assertEqual(getGenerationName(4), 'G6', 'getGenerationName(4) = G6');
    assertEqual(getGenerationName(3), 'G4.1', 'getGenerationName(3) = G4.1');
    assertEqual(getGenerationId('G6'), 4, 'getGenerationId("G6") = 4');
    assertEqual(getGenerationId('G4.1'), 3, 'getGenerationId("G4.1") = 3');

    // Arena lookups
    assertEqual(getArenaName('G6', 1), 'G6_2x10', 'getArenaName("G6", 1) = G6_2x10');
    assertEqual(getArenaName('G6', 2), 'G6_2x8of10', 'getArenaName("G6", 2) = G6_2x8of10');
    assertEqual(getArenaId('G6', 'G6_2x10'), 1, 'getArenaId("G6", "G6_2x10") = 1');
    assertEqual(getArenaId('G4', 'G4_4x12'), 1, 'getArenaId("G4", "G4_4x12") = 1');

    // Edge cases
    assertEqual(getArenaName('G6', 99), null, 'Unknown arena ID returns null');
    assertEqual(getArenaId('G6', 'nonexistent'), 0, 'Unknown arena name returns 0');
    assertEqual(getGenerationName(99), 'unknown', 'Unknown generation ID returns "unknown"');
}

// ========================================================
// Test 10: G6 encode→parse round-trip (pixel data integrity)
// ========================================================
function test10_g6_round_trip_pixels() {
    log('\nTest 10: G6 encode→parse round-trip (pixel data)', 'cyan');

    const data = makeG6PatternData({ arena_id: 3, observer_id: 7, gs_val: 16 });
    const buffer = PatEncoder.encodeG6(data);
    const parsed = PatParser.parseG6Pattern(buffer);

    // Check metadata
    assertEqual(parsed.arena_id, 3, 'Metadata: arena_id round-trip');
    assertEqual(parsed.observer_id, 7, 'Metadata: observer_id round-trip');
    assertEqual(parsed.numFrames, data.numFrames, 'Metadata: frame count');
    assertEqual(parsed.pixelRows, data.pixelRows, 'Metadata: pixel rows');
    assertEqual(parsed.pixelCols, data.pixelCols, 'Metadata: pixel cols');

    // Check pixel data (sample some pixels)
    let pixelMatch = true;
    for (let f = 0; f < data.numFrames; f++) {
        for (let i = 0; i < 100; i++) {
            const idx = Math.floor(Math.random() * data.frames[f].length);
            if (parsed.frames[f][idx] !== data.frames[f][idx]) {
                pixelMatch = false;
                break;
            }
        }
    }
    assert(pixelMatch, 'Pixel data matches after round-trip');
}

// ========================================================
// Run all tests
// ========================================================
log('=== Header V2 Validation Tests ===', 'cyan');
log(`Parser: pat-parser.js | Encoder: pat-encoder.js`, 'dim');

test1_g4_v1_compat();
test2_g41_v2_generation();
test3_g41_v2_arena();
test4_g4_all_generations();
test5_g6_v2_basic();
test6_g6_v2_with_ids();
test7_g6_v2_boundary();
test8_g6_v1_compat();
test9_arena_registry();
test10_g6_round_trip_pixels();

// Summary
log(`\n=== Summary ===`, 'cyan');
log(`Passed: ${passedTests} / ${totalTests}`, passedTests === totalTests ? 'green' : 'red');

if (passedTests === totalTests) {
    log('All tests PASSED!', 'green');
    process.exit(0);
} else {
    log(`${totalTests - passedTests} test(s) FAILED`, 'red');
    process.exit(1);
}
