/**
 * Validation tests for arena-geometry.js
 *
 * Run with: node tests/validate-arena-geometry.js
 */

const {
    arenaCoordinates,
    rotateCoordinates,
    cart2sphere,
    sphere2cart,
    samplesByPRad
} = require('../js/arena-geometry.js');

const TOLERANCE = 1e-6;
let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
    if (Math.abs(actual - expected) < TOLERANCE) {
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

console.log('=== arenaCoordinates tests ===\n');

// Test 1: Dimensions for G6 2x10 arena
{
    const config = { panelSize: 20, numCols: 10, numRows: 2, numCircle: 10, model: 'smooth' };
    const coords = arenaCoordinates(config);

    assertEqual(coords.rows, 40, 'G6 2x10: rows = 2 * 20 = 40');
    assertEqual(coords.cols, 200, 'G6 2x10: cols = 10 * 20 = 200');
    assertEqual(coords.x.length, 40, 'G6 2x10: x array has 40 rows');
    assertEqual(coords.x[0].length, 200, 'G6 2x10: x[0] has 200 cols');

    const expectedPRad = (2 * Math.PI) / 10 / 20;
    assertClose(coords.pRad, expectedPRad, TOLERANCE, 'G6 2x10: pRad = 2π/200');
}

// Test 2: Z coordinates are centered
{
    const config = { panelSize: 20, numCols: 10, numRows: 2, numCircle: 10, model: 'smooth' };
    const coords = arenaCoordinates(config);

    // Middle rows should have z ≈ 0
    const midRow = Math.floor(coords.rows / 2);
    assertClose(
        coords.z[midRow][0] + coords.z[midRow - 1][0],
        0,
        TOLERANCE * 10,
        'Z coords centered: z[19] + z[20] ≈ 0'
    );

    // Bottom row should have negative z, top row positive z
    assertTrue(coords.z[0][0] < 0, 'Bottom row has negative z');
    assertTrue(coords.z[coords.rows - 1][0] > 0, 'Top row has positive z');
}

// Test 3: Smooth cylinder - points lie on unit circle in XY plane
{
    const config = { panelSize: 20, numCols: 10, numRows: 2, numCircle: 10, model: 'smooth' };
    const coords = arenaCoordinates(config);

    // For smooth model, x² + y² should = 1 (on unit cylinder)
    const r = 20; // arbitrary row
    const c = 50; // arbitrary col
    const radiusSquared = coords.x[r][c] ** 2 + coords.y[r][c] ** 2;
    assertClose(radiusSquared, 1, TOLERANCE, 'Smooth model: x² + y² = 1');
}

// Test 4: Poly model - different from smooth
{
    const smoothConfig = { panelSize: 20, numCols: 10, numRows: 2, numCircle: 10, model: 'smooth' };
    const polyConfig = { panelSize: 20, numCols: 10, numRows: 2, numCircle: 10, model: 'poly' };

    const smooth = arenaCoordinates(smoothConfig);
    const poly = arenaCoordinates(polyConfig);

    // Poly model should produce different coordinates
    // At panel centers, poly should be closer to center (apothem < radius)
    const panelCenterCol = 10; // Center of panel 0
    const row = 20;

    const smoothRadius = Math.sqrt(
        smooth.x[row][panelCenterCol] ** 2 + smooth.y[row][panelCenterCol] ** 2
    );
    const polyRadius = Math.sqrt(
        poly.x[row][panelCenterCol] ** 2 + poly.y[row][panelCenterCol] ** 2
    );

    assertTrue(polyRadius < smoothRadius, 'Poly model: panel center closer to origin than smooth');
}

console.log('\n=== cart2sphere / sphere2cart tests ===\n');

// Test 5: Point on positive y-axis
{
    const x = [[0]];
    const y = [[1]];
    const z = [[0]];
    const result = cart2sphere(x, y, z);

    assertEqual(result.rho[0][0], 1, 'Point on +y: rho = 1');
    assertEqual(result.phi[0][0], 0, 'Point on +y: phi = 0');
    assertClose(result.theta[0][0], Math.PI / 2, TOLERANCE, 'Point on +y: theta = π/2');
}

// Test 6: Point on positive x-axis
{
    const x = [[1]];
    const y = [[0]];
    const z = [[0]];
    const result = cart2sphere(x, y, z);

    assertEqual(result.rho[0][0], 1, 'Point on +x: rho = 1');
    assertClose(result.phi[0][0], Math.PI / 2, TOLERANCE, 'Point on +x: phi = π/2');
    assertClose(result.theta[0][0], Math.PI / 2, TOLERANCE, 'Point on +x: theta = π/2');
}

// Test 7: North pole (z = -1)
{
    const x = [[0]];
    const y = [[0]];
    const z = [[-1]];
    const result = cart2sphere(x, y, z);

    assertEqual(result.rho[0][0], 1, 'North pole: rho = 1');
    assertEqual(result.theta[0][0], 0, 'North pole: theta = 0');
}

// Test 8: South pole (z = +1)
{
    const x = [[0]];
    const y = [[0]];
    const z = [[1]];
    const result = cart2sphere(x, y, z);

    assertEqual(result.rho[0][0], 1, 'South pole: rho = 1');
    assertClose(result.theta[0][0], Math.PI, TOLERANCE, 'South pole: theta = π');
}

// Test 9: Round-trip conversion
{
    const x0 = [
        [0.5, -0.3],
        [0.1, 0.8]
    ];
    const y0 = [
        [0.7, 0.9],
        [-0.5, 0.2]
    ];
    const z0 = [
        [-0.2, 0.4],
        [0.6, -0.3]
    ];

    const spherical = cart2sphere(x0, y0, z0);
    const cartesian = sphere2cart(spherical.phi, spherical.theta, spherical.rho);

    for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
            assertClose(cartesian.x[i][j], x0[i][j], TOLERANCE, `Round-trip x[${i}][${j}]`);
            assertClose(cartesian.y[i][j], y0[i][j], TOLERANCE, `Round-trip y[${i}][${j}]`);
            assertClose(cartesian.z[i][j], z0[i][j], TOLERANCE, `Round-trip z[${i}][${j}]`);
        }
    }
}

console.log('\n=== rotateCoordinates tests ===\n');

// Test 10: No rotation returns same coordinates
{
    const x = [
        [1, 0],
        [0, 1]
    ];
    const y = [
        [0, 1],
        [1, 0]
    ];
    const z = [
        [0, 0],
        [0, 0]
    ];

    const result = rotateCoordinates(x, y, z, { yaw: 0, pitch: 0, roll: 0 });

    assertClose(result.x[0][0], 1, TOLERANCE, 'No rotation: x unchanged');
    assertClose(result.y[0][1], 1, TOLERANCE, 'No rotation: y unchanged');
}

// Test 11: 90° yaw rotation
{
    const x = [[1]];
    const y = [[0]];
    const z = [[0]];

    // Yaw rotates in xy-plane: (1,0) -> (0,-1) for 90° clockwise?
    // Actually with atan2(x,y)+yaw convention: (1,0) at phi=π/2, adding π/2 -> phi=π -> (-1, 0)?
    // Let's check: sin(π)=0, cos(π)=-1, so x=0, y=-1? No, x=rho*sin(phi), y=rho*cos(phi)
    // Original: x=1, y=0 -> phi = atan2(1,0) = π/2
    // After +π/2 yaw: phi = π -> x = sin(π) = 0, y = cos(π) = -1
    const result = rotateCoordinates(x, y, z, { yaw: Math.PI / 2, pitch: 0, roll: 0 });

    assertClose(result.x[0][0], 0, TOLERANCE, '90° yaw: x = 0');
    assertClose(result.y[0][0], -1, TOLERANCE, '90° yaw: y = -1');
}

// Test 12: 180° yaw rotation
{
    const x = [[1]];
    const y = [[0]];
    const z = [[0]];

    const result = rotateCoordinates(x, y, z, { yaw: Math.PI, pitch: 0, roll: 0 });

    assertClose(result.x[0][0], -1, TOLERANCE, '180° yaw: x = -1');
    assertClose(result.y[0][0], 0, TOLERANCE, '180° yaw: y = 0');
}

console.log('\n=== samplesByPRad tests ===\n');

// Test 13: Single sample returns original value
{
    const coord = [
        [1.0, 2.0],
        [3.0, 4.0]
    ];
    const result = samplesByPRad(coord, 1, 0.1);

    assertEqual(result[0][0][0], 1.0, 'Single sample [0][0]');
    assertEqual(result[0][1][0], 2.0, 'Single sample [0][1]');
    assertEqual(result[1][0][0], 3.0, 'Single sample [1][0]');
    assertEqual(result[1][1][0], 4.0, 'Single sample [1][1]');
}

// Test 14: Multiple samples span ±pRad/2
{
    const coord = [[0]];
    const pRad = 1.0;
    const numSamples = 15;
    const result = samplesByPRad(coord, numSamples, pRad);

    assertEqual(result[0][0].length, 15, '15 samples generated');

    const min = Math.min(...result[0][0]);
    const max = Math.max(...result[0][0]);

    assertTrue(min >= -pRad / 2 - TOLERANCE, 'Min sample >= -pRad/2');
    assertTrue(max <= pRad / 2 + TOLERANCE, 'Max sample <= pRad/2');
}

// Test 15: Samples are symmetric around center
{
    const coord = [[5.0]];
    const pRad = 0.2;
    const numSamples = 5;
    const result = samplesByPRad(coord, numSamples, pRad);

    const samples = result[0][0];
    const firstOffset = samples[0] - 5.0;
    const lastOffset = samples[4] - 5.0;
    assertClose(firstOffset + lastOffset, 0, TOLERANCE, 'Samples symmetric around center');
}

console.log('\n=== Integration test: Arena -> Spherical -> Pattern Coordinates ===\n');

// Test 16: Full pipeline test
{
    const config = { panelSize: 20, numCols: 10, numRows: 2, numCircle: 10, model: 'smooth' };
    const arena = arenaCoordinates(config);
    const spherical = cart2sphere(arena.x, arena.y, arena.z);

    // For a smooth cylinder, phi should span approximately [-π, π] around the arena
    // Note: Must manually find min/max since Float32Array.flat() doesn't work like regular arrays
    let phiMin = Infinity,
        phiMax = -Infinity;
    for (let i = 0; i < spherical.phi.length; i++) {
        for (let j = 0; j < spherical.phi[i].length; j++) {
            const v = spherical.phi[i][j];
            if (v < phiMin) phiMin = v;
            if (v > phiMax) phiMax = v;
        }
    }

    assertTrue(phiMax - phiMin > Math.PI, 'Phi spans more than π radians');

    // Theta should be around π/2 (equator) for most pixels since z is small
    const thetaMid = spherical.theta[20][100]; // Middle of arena
    assertClose(thetaMid, Math.PI / 2, 0.5, 'Middle theta near π/2 (equator)');
}

// Test 17: Rotation grating symmetry - all rows should have same phi after generation
{
    const config = { panelSize: 20, numCols: 10, numRows: 2, numCircle: 10, model: 'smooth' };
    const arena = arenaCoordinates(config);

    // With no rotation applied, convert to spherical
    const spherical = cart2sphere(arena.x, arena.y, arena.z);

    // For a vertical cylinder with no rotation, all rows should have the same phi values
    // (phi only varies with column, not row)
    const row0Phi = spherical.phi[0];
    const row20Phi = spherical.phi[20];

    let phiMatch = true;
    for (let c = 0; c < arena.cols; c++) {
        if (Math.abs(row0Phi[c] - row20Phi[c]) > TOLERANCE) {
            phiMatch = false;
            break;
        }
    }
    assertTrue(phiMatch, 'Phi values same across all rows (rotation grating basis)');
}

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

process.exit(failed === 0 ? 0 : 1);
