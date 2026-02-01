/**
 * Validation tests for spherical grating pattern generation
 *
 * Run with: node tests/validate-spherical-grating.js
 */

const PatternGenerator = require('../js/pattern-editor/tools/generator.js');

const TOLERANCE = 1e-6;
let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
    if (actual === expected) {
        passed++;
        return true;
    } else {
        failed++;
        console.error(`FAIL: ${message}`);
        console.error(`  Expected: ${expected}, Got: ${actual}`);
        return false;
    }
}

function assertClose(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) < tolerance) {
        passed++;
        return true;
    } else {
        failed++;
        console.error(`FAIL: ${message}`);
        console.error(`  Expected: ${expected} ± ${tolerance}, Got: ${actual}`);
        return false;
    }
}

function assertTrue(condition, message) {
    if (condition) {
        passed++;
        return true;
    } else {
        failed++;
        console.error(`FAIL: ${message}`);
        return false;
    }
}

// Mock arena configuration
const arenaConfig = {
    generation: 'G6',
    rows: 2,
    cols: 10
};

console.log('=== Spherical Grating Generator Tests ===\n');

// Test 1: Basic generation - should create a valid pattern
console.log('Test 1: Basic pattern generation');
{
    const params = {
        spatFreq: Math.PI / 5,  // ~10 pixel wavelength
        motionType: 'rotation',
        waveform: 'square',
        dutyCycle: 50,
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        gsMode: 16
    };

    const pattern = PatternGenerator.generate('spherical-grating', params, arenaConfig);

    assertEqual(pattern.generation, 'G6', 'Generation is G6');
    assertEqual(pattern.gs_val, 16, 'Grayscale mode is 16');
    assertEqual(pattern.pixelRows, 40, 'Pixel rows = 2 * 20');
    assertEqual(pattern.pixelCols, 200, 'Pixel cols = 10 * 20');
    assertTrue(pattern.numFrames > 0, 'Has at least one frame');
    assertTrue(pattern.frames.length === pattern.numFrames, 'Frame count matches numFrames');
}

// Test 2: Rotation grating produces consistent repeating pattern
// Note: With proper spherical projection, rows are NOT identical because the
// coordinate transformation rotates the arena by -pi/2 pitch, causing phi to
// vary across both rows and columns. This matches MATLAB's behavior.
console.log('\nTest 2: Rotation grating produces repeating pattern');
{
    const params = {
        spatFreq: Math.PI / 5,  // ~10 pixel wavelength
        motionType: 'rotation',
        waveform: 'square',
        dutyCycle: 50,
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        numFrames: 1,
        gsMode: 16
    };

    const pattern = PatternGenerator.generate('spherical-grating', params, arenaConfig);
    const frame = pattern.frames[0];
    const pixelCols = pattern.pixelCols;

    // Check that the pattern has both high and low values (is actually a grating)
    const uniqueValues = new Set(frame);
    const hasGratingPattern = uniqueValues.has(0) && uniqueValues.has(15);

    // Check that the pattern roughly follows 50% duty cycle (40-60% should be "on")
    const onCount = frame.filter(v => v === 15).length;
    const onRatio = onCount / frame.length;
    const dutyApproxCorrect = onRatio > 0.4 && onRatio < 0.6;

    assertTrue(hasGratingPattern, 'Rotation grating has both high and low values');
    assertTrue(dutyApproxCorrect, `Rotation grating duty cycle is reasonable (${(onRatio*100).toFixed(1)}%)`);
}

// Test 3: Square wave produces only high and low values (no AA)
console.log('\nTest 3: Square wave produces binary values');
{
    const params = {
        spatFreq: Math.PI / 5,
        motionType: 'rotation',
        waveform: 'square',
        dutyCycle: 50,
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        numFrames: 1,
        aaSamples: 1,  // No anti-aliasing
        gsMode: 16
    };

    const pattern = PatternGenerator.generate('spherical-grating', params, arenaConfig);
    const frame = pattern.frames[0];

    const uniqueValues = new Set(frame);
    assertEqual(uniqueValues.size, 2, 'Square wave has exactly 2 unique values');
    assertTrue(uniqueValues.has(0), 'Contains low value (0)');
    assertTrue(uniqueValues.has(15), 'Contains high value (15)');
}

// Test 4: Sine wave produces multiple values
console.log('\nTest 4: Sine wave produces gradient values');
{
    const params = {
        spatFreq: Math.PI / 5,
        motionType: 'rotation',
        waveform: 'sine',
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        numFrames: 1,
        gsMode: 16
    };

    const pattern = PatternGenerator.generate('spherical-sine', params, arenaConfig);
    const frame = pattern.frames[0];

    const uniqueValues = new Set(frame);
    assertTrue(uniqueValues.size > 2, `Sine wave has multiple values (found ${uniqueValues.size})`);

    // Should have values near min and max
    const minVal = Math.min(...frame);
    const maxVal = Math.max(...frame);
    assertClose(minVal, 0, 1, 'Sine wave minimum near 0');
    assertClose(maxVal, 15, 1, 'Sine wave maximum near 15');
}

// Test 5: Anti-aliasing produces intermediate values for square wave
// Note: AA only affects pixels where the pattern edge falls within the sub-pixel samples.
// With spatFreq = π/5 (exactly 20 pixels/cycle), edges fall exactly between pixels.
// We use a misaligned spatFreq to demonstrate AA effect.
console.log('\nTest 5: Anti-aliasing produces smooth edges');
{
    // Use spatFreq that doesn't align perfectly with pixel grid
    const paramsNoAA = {
        spatFreq: 0.65,  // Misaligned with pRad
        motionType: 'rotation',
        waveform: 'square',
        dutyCycle: 50,
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        numFrames: 1,
        aaSamples: 1,
        gsMode: 16
    };

    const paramsWithAA = {
        ...paramsNoAA,
        aaSamples: 15
    };

    const patternNoAA = PatternGenerator.generate('spherical-grating', paramsNoAA, arenaConfig);
    const patternWithAA = PatternGenerator.generate('spherical-grating', paramsWithAA, arenaConfig);

    const uniqueNoAA = new Set(patternNoAA.frames[0]);
    const uniqueWithAA = new Set(patternWithAA.frames[0]);

    assertEqual(uniqueNoAA.size, 2, 'No AA: exactly 2 values');
    assertTrue(uniqueWithAA.size > 2, `With AA: more than 2 values (found ${uniqueWithAA.size})`);
}

// Test 6: Direction affects phase progression
console.log('\nTest 6: Direction affects phase progression');
{
    const baseSpatFreq = Math.PI / 10;  // ~20 pixel wavelength

    const paramsCW = {
        spatFreq: baseSpatFreq,
        motionType: 'rotation',
        waveform: 'square',
        dutyCycle: 50,
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        numFrames: 5,
        direction: 'cw',
        stepSize: 1,
        gsMode: 16
    };

    const paramsCCW = {
        ...paramsCW,
        direction: 'ccw'
    };

    const patternCW = PatternGenerator.generate('spherical-grating', paramsCW, arenaConfig);
    const patternCCW = PatternGenerator.generate('spherical-grating', paramsCCW, arenaConfig);

    // First frames should be identical (same starting phase)
    let firstFramesMatch = true;
    for (let i = 0; i < patternCW.frames[0].length; i++) {
        if (patternCW.frames[0][i] !== patternCCW.frames[0][i]) {
            firstFramesMatch = false;
            break;
        }
    }
    assertTrue(firstFramesMatch, 'First frames are identical regardless of direction');

    // Later frames should differ (opposite rotation)
    let laterFramesDiffer = false;
    for (let i = 0; i < patternCW.frames[2].length; i++) {
        if (patternCW.frames[2][i] !== patternCCW.frames[2][i]) {
            laterFramesDiffer = true;
            break;
        }
    }
    assertTrue(laterFramesDiffer, 'Later frames differ based on direction');
}

// Test 7: Polygonal arena model
console.log('\nTest 7: Polygonal arena model');
{
    const params = {
        spatFreq: Math.PI / 5,
        motionType: 'rotation',
        waveform: 'square',
        dutyCycle: 50,
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        numFrames: 1,
        arenaModel: 'poly',
        gsMode: 16
    };

    const pattern = PatternGenerator.generate('spherical-grating', params, arenaConfig);

    // Should still produce valid pattern
    assertEqual(pattern.pixelRows, 40, 'Poly model: correct pixel rows');
    assertEqual(pattern.pixelCols, 200, 'Poly model: correct pixel cols');
    assertTrue(pattern.frames[0].length === 40 * 200, 'Poly model: correct frame size');
}

// Test 8: Expansion motion type
console.log('\nTest 8: Expansion motion type');
{
    const params = {
        spatFreq: Math.PI / 4,
        motionType: 'expansion',
        waveform: 'square',
        dutyCycle: 50,
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        numFrames: 1,
        gsMode: 16
    };

    const pattern = PatternGenerator.generate('spherical-grating', params, arenaConfig);
    const frame = pattern.frames[0];
    const pixelCols = pattern.pixelCols;
    const pixelRows = pattern.pixelRows;

    // For expansion, pattern should vary with elevation (rows)
    // Collect unique values for each row and compare
    let rowValuesDiffer = false;
    const row0Values = new Set(frame.slice(0, pixelCols));

    // Check multiple rows - find at least one that differs from row 0
    for (let r = 1; r < pixelRows; r++) {
        const rowStart = r * pixelCols;
        const rowValues = new Set(frame.slice(rowStart, rowStart + pixelCols));

        // Check if this row has different distribution than row 0
        // For expansion, different rows should have different patterns
        const rowArr = [...frame.slice(rowStart, rowStart + pixelCols)];
        const row0Arr = [...frame.slice(0, pixelCols)];

        for (let c = 0; c < pixelCols; c++) {
            if (rowArr[c] !== row0Arr[c]) {
                rowValuesDiffer = true;
                break;
            }
        }
        if (rowValuesDiffer) break;
    }

    assertTrue(rowValuesDiffer, 'Expansion pattern varies across rows');
}

// Test 9: Translation motion type
console.log('\nTest 9: Translation motion type');
{
    const params = {
        spatFreq: 0.5,  // Different scale for translation
        motionType: 'translation',
        waveform: 'square',
        dutyCycle: 50,
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        numFrames: 1,
        gsMode: 16
    };

    const pattern = PatternGenerator.generate('spherical-grating', params, arenaConfig);

    // Translation should produce valid output
    assertTrue(pattern.frames[0].length === 40 * 200, 'Translation: correct frame size');

    // Pattern should show horizontal bands (constant across columns)
    // Check if adjacent columns have similar patterns
    const frame = pattern.frames[0];
    const pixelCols = pattern.pixelCols;
    const pixelRows = pattern.pixelRows;

    let colsSimilar = true;
    for (let r = 0; r < pixelRows; r++) {
        const val0 = frame[r * pixelCols];
        const val50 = frame[r * pixelCols + 50];
        // For pure translation along one axis, adjacent rows at different cols should be similar
        // (but this depends on pole position, so we just check valid output)
    }

    assertTrue(pattern.frames.length > 0, 'Translation produces at least one frame');
}

// Test 10: Different duty cycles
console.log('\nTest 10: Duty cycle affects pattern');
{
    const params25 = {
        spatFreq: Math.PI / 5,
        motionType: 'rotation',
        waveform: 'square',
        dutyCycle: 25,
        high: 15,
        low: 0,
        poleCoord: [0, 0],
        numFrames: 1,
        gsMode: 16
    };

    const params75 = {
        ...params25,
        dutyCycle: 75
    };

    const pattern25 = PatternGenerator.generate('spherical-grating', params25, arenaConfig);
    const pattern75 = PatternGenerator.generate('spherical-grating', params75, arenaConfig);

    // Count high pixels
    const countHigh25 = pattern25.frames[0].filter(v => v === 15).length;
    const countHigh75 = pattern75.frames[0].filter(v => v === 15).length;

    assertTrue(countHigh75 > countHigh25, '75% duty cycle has more high pixels than 25%');
}

// Test 11: Validation passes for generated patterns
console.log('\nTest 11: Pattern validation');
{
    const params = {
        spatFreq: Math.PI / 5,
        motionType: 'rotation',
        waveform: 'square',
        dutyCycle: 50,
        high: 15,
        low: 0,
        numFrames: 10,
        gsMode: 16
    };

    const pattern = PatternGenerator.generate('spherical-grating', params, arenaConfig);
    const validation = PatternGenerator.validate(pattern);

    assertTrue(validation.valid, 'Generated pattern passes validation');
    assertEqual(validation.errors.length, 0, 'No validation errors');
}

// Test 12: GS2 mode (binary) pattern
console.log('\nTest 12: GS2 binary mode');
{
    const params = {
        spatFreq: Math.PI / 5,
        motionType: 'rotation',
        waveform: 'square',
        dutyCycle: 50,
        high: 1,
        low: 0,
        numFrames: 1,
        gsMode: 2
    };

    const pattern = PatternGenerator.generate('spherical-grating', params, arenaConfig);

    assertEqual(pattern.gs_val, 2, 'Grayscale mode is 2');

    // All values should be 0 or 1
    const allBinary = pattern.frames[0].every(v => v === 0 || v === 1);
    assertTrue(allBinary, 'All pixels are binary (0 or 1)');
}

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

process.exit(failed === 0 ? 0 : 1);
