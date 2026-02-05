/**
 * Arena Geometry Module
 *
 * Generates 3D Cartesian coordinates for cylindrical LED arenas
 * and provides coordinate transformation utilities.
 *
 * @module arena-geometry
 */

/* eslint-disable no-unused-vars */
// Functions are exported at bottom for both browser and Node.js

/**
 * Generate 3D Cartesian coordinates for every pixel in a cylindrical LED arena.
 *
 * @param {Object} config - Arena configuration
 * @param {number} config.panelSize - Pixels per panel side (8 for G3, 16 for G4, 20 for G6)
 * @param {number} config.numCols - Number of panel columns around arena
 * @param {number} config.numRows - Number of panel rows vertically
 * @param {number} config.numCircle - Panels needed for full 360° circle (usually same as numCols)
 * @param {string} config.model - 'smooth' (perfect cylinder) or 'poly' (polygonal)
 * @returns {Object} Coordinate data
 * @returns {Float32Array[]} returns.x - 2D array [rows][cols] of x coordinates
 * @returns {Float32Array[]} returns.y - 2D array [rows][cols] of y coordinates
 * @returns {Float32Array[]} returns.z - 2D array [rows][cols] of z coordinates
 * @returns {number} returns.pRad - Angular spacing between pixels in radians
 * @returns {number} returns.rows - Total pixel rows
 * @returns {number} returns.cols - Total pixel columns
 */
function arenaCoordinates(config) {
    const { panelSize, numCols, numRows, numCircle, model } = config;

    // Total pixel dimensions
    const rows = panelSize * numRows;
    const cols = panelSize * numCols;

    // Angular spacing
    const panRad = (2 * Math.PI) / numCircle; // Radians per panel
    const pRad = panRad / panelSize; // Radians per pixel

    // Initialize coordinate arrays as 2D Float32Array matrices
    const x = new Array(rows);
    const y = new Array(rows);
    const z = new Array(rows);

    for (let r = 0; r < rows; r++) {
        x[r] = new Float32Array(cols);
        y[r] = new Float32Array(cols);
        z[r] = new Float32Array(cols);
    }

    if (model === 'smooth') {
        // Smooth cylinder model (radius = 1)
        // Each pixel lies on a perfect cylinder surface
        //
        // IMPORTANT: Panel angles are centered around 0 (matching MATLAB convention)
        // Panel 0 center is at -panRad*(numCols-1)/2, panel (numCols-1) center is at +panRad*(numCols-1)/2

        for (let r = 0; r < rows; r++) {
            // Z coordinate: centered vertically
            const zVal = pRad * (r - (rows - 1) / 2);

            for (let c = 0; c < cols; c++) {
                // Determine which panel this pixel belongs to
                const panelIdx = Math.floor(c / panelSize);
                const pixelInPanel = c % panelSize;

                // Panel center angle (centered around 0, matching MATLAB)
                // cphi = -Pan_rad*(Pcols-1)/2 + Pan_rad*panelIdx
                const panelCenterAngle = (-panRad * (numCols - 1)) / 2 + panRad * panelIdx;

                // Pixel offset within panel (centered)
                // points = (p_rad-Pan_rad)/2:p_rad:(Pan_rad-p_rad)/2
                // This gives offsets centered within the panel
                const pixelOffset = pRad * (pixelInPanel - (panelSize - 1) / 2);

                // Total azimuthal angle for this pixel
                const colPhi = panelCenterAngle + pixelOffset;

                // Cartesian coordinates on unit cylinder
                x[r][c] = Math.sin(colPhi);
                y[r][c] = Math.cos(colPhi);
                z[r][c] = zVal;
            }
        }
    } else if (model === 'poly') {
        // Polygonal model (circumference = 2π)
        // Panels are flat, arranged in a polygon
        //
        // IMPORTANT: Panel angles are centered around 0 (matching MATLAB convention)

        // Apothem: distance from center to middle of panel face
        const apothem = panRad / (2 * Math.tan(Math.PI / numCircle));

        for (let r = 0; r < rows; r++) {
            // Z coordinate: same as smooth model
            const zVal = pRad * (r - (rows - 1) / 2);

            for (let c = 0; c < cols; c++) {
                // Determine which panel this pixel belongs to
                const panelIdx = Math.floor(c / panelSize);
                const pixelInPanel = c % panelSize;

                // Panel center angle (centered around 0, matching MATLAB)
                const cphi = (-panRad * (numCols - 1)) / 2 + panRad * panelIdx;

                // Pixel offset along the flat panel face (in radians, converted to linear)
                const pixelOffsetRad = pRad * (pixelInPanel - (panelSize - 1) / 2);

                // For polygonal model, the pixel offset is tangential to the panel
                // The panel face is perpendicular to the radial direction at cphi
                x[r][c] = apothem * Math.sin(cphi) + pixelOffsetRad * Math.cos(-cphi);
                y[r][c] = apothem * Math.cos(cphi) + pixelOffsetRad * Math.sin(-cphi);
                z[r][c] = zVal;
            }
        }
    } else {
        throw new Error(`Unknown model type: ${model}. Use 'smooth' or 'poly'.`);
    }

    return { x, y, z, pRad, rows, cols };
}

/**
 * Apply 3D rotations to coordinate arrays.
 *
 * Rotation order: yaw (z-axis) → pitch (x-axis) → roll (y-axis)
 * If reverse=true, applies in opposite order: roll → pitch → yaw
 *
 * @param {Float32Array[]} x - 2D array of x coordinates
 * @param {Float32Array[]} y - 2D array of y coordinates
 * @param {Float32Array[]} z - 2D array of z coordinates
 * @param {Object} rotations - Rotation angles in radians
 * @param {number} [rotations.yaw=0] - Rotation around z-axis
 * @param {number} [rotations.pitch=0] - Rotation around x-axis
 * @param {number} [rotations.roll=0] - Rotation around y-axis
 * @param {boolean} [reverse=false] - If true, apply rotations in reverse order
 * @returns {Object} Rotated coordinates
 * @returns {Float32Array[]} returns.x - Rotated x coordinates
 * @returns {Float32Array[]} returns.y - Rotated y coordinates
 * @returns {Float32Array[]} returns.z - Rotated z coordinates
 */
function rotateCoordinates(x, y, z, rotations, reverse = false) {
    const yaw = rotations.yaw || 0;
    const pitch = rotations.pitch || 0;
    const roll = rotations.roll || 0;

    const rows = x.length;
    const cols = x[0].length;

    // Create output arrays (deep copy)
    const xOut = new Array(rows);
    const yOut = new Array(rows);
    const zOut = new Array(rows);

    for (let r = 0; r < rows; r++) {
        xOut[r] = new Float32Array(x[r]);
        yOut[r] = new Float32Array(y[r]);
        zOut[r] = new Float32Array(z[r]);
    }

    /**
     * Apply yaw rotation (around z-axis)
     */
    function applyYaw() {
        if (yaw === 0) return;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const rho = Math.hypot(xOut[r][c], yOut[r][c]);
                const phi = Math.atan2(xOut[r][c], yOut[r][c]) + yaw;
                xOut[r][c] = rho * Math.sin(phi);
                yOut[r][c] = rho * Math.cos(phi);
            }
        }
    }

    /**
     * Apply pitch rotation (around x-axis)
     */
    function applyPitch() {
        if (pitch === 0) return;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const rho = Math.hypot(zOut[r][c], yOut[r][c]);
                const phi = Math.atan2(zOut[r][c], yOut[r][c]) + pitch;
                zOut[r][c] = rho * Math.sin(phi);
                yOut[r][c] = rho * Math.cos(phi);
            }
        }
    }

    /**
     * Apply roll rotation (around y-axis)
     * Note: negative roll for clockwise rotation convention
     */
    function applyRoll() {
        if (roll === 0) return;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const rho = Math.hypot(zOut[r][c], xOut[r][c]);
                const phi = Math.atan2(zOut[r][c], xOut[r][c]) - roll;
                xOut[r][c] = rho * Math.cos(phi);
                zOut[r][c] = rho * Math.sin(phi);
            }
        }
    }

    // Apply rotations in the specified order
    if (reverse) {
        // Reverse order: roll → pitch → yaw
        applyRoll();
        applyPitch();
        applyYaw();
    } else {
        // Normal order: yaw → pitch → roll
        applyYaw();
        applyPitch();
        applyRoll();
    }

    return { x: xOut, y: yOut, z: zOut };
}

/**
 * Convert Cartesian coordinates to spherical coordinates.
 *
 * @param {number[][]|Float32Array[]} x - 2D array of x coordinates
 * @param {number[][]|Float32Array[]} y - 2D array of y coordinates
 * @param {number[][]|Float32Array[]} z - 2D array of z coordinates
 * @returns {{phi: Float32Array[], theta: Float32Array[], rho: Float32Array[]}}
 *          Spherical coordinates where:
 *          - phi: azimuthal angle in range [-PI, PI]
 *          - theta: polar angle from north pole in range [0, PI]
 *          - rho: radial distance
 */
function cart2sphere(x, y, z) {
    const rows = x.length;
    const cols = x[0].length;

    // Allocate output arrays
    const phi = new Array(rows);
    const theta = new Array(rows);
    const rho = new Array(rows);

    for (let i = 0; i < rows; i++) {
        phi[i] = new Float32Array(cols);
        theta[i] = new Float32Array(cols);
        rho[i] = new Float32Array(cols);

        for (let j = 0; j < cols; j++) {
            const xVal = x[i][j];
            const yVal = y[i][j];
            const zVal = z[i][j];

            // Radial distance
            const rhoVal = Math.sqrt(xVal * xVal + yVal * yVal + zVal * zVal);
            rho[i][j] = rhoVal;

            // Azimuthal angle (phi)
            phi[i][j] = Math.atan2(xVal, yVal);

            // Polar angle (theta) - from north pole
            // Handle edge case where rho = 0 (theta is undefined)
            if (rhoVal === 0) {
                theta[i][j] = 0; // Convention: theta = 0 when at origin
            } else {
                theta[i][j] = Math.acos(-zVal / rhoVal);
            }
        }
    }

    return { phi, theta, rho };
}

/**
 * Convert spherical coordinates to Cartesian coordinates.
 *
 * @param {number[][]|Float32Array[]} phi - 2D array of azimuthal angles
 * @param {number[][]|Float32Array[]} theta - 2D array of polar angles from north pole
 * @param {number[][]|Float32Array[]|null} rho - 2D array of radial distances, or null to use 1
 * @returns {{x: Float32Array[], y: Float32Array[], z: Float32Array[]}}
 *          Cartesian coordinates
 */
function sphere2cart(phi, theta, rho = null) {
    const rows = phi.length;
    const cols = phi[0].length;

    // Allocate output arrays
    const x = new Array(rows);
    const y = new Array(rows);
    const z = new Array(rows);

    for (let i = 0; i < rows; i++) {
        x[i] = new Float32Array(cols);
        y[i] = new Float32Array(cols);
        z[i] = new Float32Array(cols);

        for (let j = 0; j < cols; j++) {
            const phiVal = phi[i][j];
            const thetaVal = theta[i][j];
            const rhoVal = rho !== null ? rho[i][j] : 1;

            const sinTheta = Math.sin(thetaVal);

            x[i][j] = rhoVal * Math.sin(phiVal) * sinTheta;
            y[i][j] = rhoVal * Math.cos(phiVal) * sinTheta;
            z[i][j] = -rhoVal * Math.cos(thetaVal);
        }
    }

    return { x, y, z };
}

/**
 * Generate sub-pixel samples for anti-aliasing.
 *
 * Creates multiple sample points within each pixel for smoother rendering.
 * Sample offsets span from -pRad/2 to +pRad/2 (exclusive of endpoints).
 *
 * @param {number[][]|Float32Array[]} coord - 2D array of coordinate values (pixel centers)
 * @param {number} numSamples - Number of samples per pixel (typically 15)
 * @param {number} pRad - Angular spacing between pixel centers
 * @returns {Float32Array[][]} 3D array [rows][cols][samples] of sampled coordinates
 */
function samplesByPRad(coord, numSamples, pRad) {
    const rows = coord.length;
    const cols = coord[0].length;

    // Handle trivial case: single sample returns original coord wrapped
    if (numSamples === 1) {
        const result = new Array(rows);
        for (let i = 0; i < rows; i++) {
            result[i] = new Array(cols);
            for (let j = 0; j < cols; j++) {
                result[i][j] = new Float32Array(1);
                result[i][j][0] = coord[i][j];
            }
        }
        return result;
    }

    // Precompute sample offsets
    // Offsets span from -pRad/2 to +pRad/2, distributed evenly
    const offsets = new Float32Array(numSamples);
    const halfRange = 0.5 * (1 - 1 / numSamples);
    for (let s = 0; s < numSamples; s++) {
        offsets[s] = pRad * (-halfRange + s / numSamples);
    }

    // Generate samples for each pixel
    const result = new Array(rows);
    for (let i = 0; i < rows; i++) {
        result[i] = new Array(cols);
        for (let j = 0; j < cols; j++) {
            result[i][j] = new Float32Array(numSamples);
            const centerVal = coord[i][j];
            for (let s = 0; s < numSamples; s++) {
                result[i][j][s] = centerVal + offsets[s];
            }
        }
    }

    return result;
}

// Export for both browser and Node.js
const ArenaGeometry = {
    arenaCoordinates,
    rotateCoordinates,
    cart2sphere,
    sphere2cart,
    samplesByPRad
};

// Browser global
if (typeof window !== 'undefined') {
    window.ArenaGeometry = ArenaGeometry;
}

// CommonJS export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ArenaGeometry;
}
