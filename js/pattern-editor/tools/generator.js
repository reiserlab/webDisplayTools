/**
 * Pattern Generator Module
 * Generates various pattern types for LED arena displays
 *
 * @module pattern-editor/tools/generator
 */

// Import PANEL_SPECS if running in Node.js
let PANEL_SPECS_LOCAL;
let ArenaGeometry_LOCAL;
if (typeof PANEL_SPECS !== 'undefined') {
    PANEL_SPECS_LOCAL = PANEL_SPECS;
} else if (typeof require !== 'undefined') {
    try {
        const configs = require('../../arena-configs.js');
        PANEL_SPECS_LOCAL = configs.PANEL_SPECS;
    } catch (e) {
        // Will be set when module is used
        PANEL_SPECS_LOCAL = null;
    }
}

// Import ArenaGeometry for spherical coordinate patterns
if (typeof require !== 'undefined') {
    try {
        ArenaGeometry_LOCAL = require('../../arena-geometry.js');
    } catch (e) {
        ArenaGeometry_LOCAL = null;
    }
} else if (typeof window !== 'undefined' && window.ArenaGeometry) {
    ArenaGeometry_LOCAL = window.ArenaGeometry;
}

/**
 * Seeded random number generator (Mulberry32)
 * Provides reproducible random sequences for starfield patterns
 * @param {number} seed - Integer seed value
 * @returns {function} Random number generator function returning 0-1
 */
function createSeededRandom(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * Pattern Generator
 * Generates various pattern types compatible with the pat-encoder format
 */
const PatternGenerator = {
    /**
     * Generate a pattern based on type and parameters
     * @param {string} type - Pattern type: 'grating', 'sine', 'starfield', 'edge', 'offon', 'spherical-grating', 'spherical-sine'
     * @param {Object} params - Type-specific parameters
     * @param {Object} arena - Arena configuration object
     * @returns {Object} Pattern data compatible with pat-encoder
     */
    generate(type, params, arena) {
        switch (type) {
            case 'grating':
                return this.generateGrating(params, arena);
            case 'sine':
                return this.generateSine(params, arena);
            case 'spherical-grating':
            case 'spherical-sine':
                return this.generateSphericalGrating(params, arena);
            case 'starfield':
                return this.generateStarfield(params, arena);
            case 'edge':
                return this.generateEdge(params, arena);
            case 'offon':
            case 'off-on':
                return this.generateOffOn(params, arena);
            default:
                throw new Error(`Unknown pattern type: ${type}`);
        }
    },

    /**
     * Get panel specifications for a generation
     * @param {string} generation - Panel generation (G3, G4, G4.1, G6)
     * @returns {Object} Panel specifications
     */
    getPanelSpecs(generation) {
        const specs = PANEL_SPECS_LOCAL || (typeof PANEL_SPECS !== 'undefined' ? PANEL_SPECS : null);
        if (!specs) {
            throw new Error('PANEL_SPECS not available. Include arena-configs.js before this module.');
        }
        return specs[generation];
    },

    /**
     * Calculate arena dimensions
     * @param {Object} arena - Arena configuration
     * @returns {Object} Dimensions {rows, cols, pixelRows, pixelCols, panelSize}
     */
    getArenaDimensions(arena) {
        const generation = arena.generation || arena.arena?.generation;
        const numRows = arena.rows || arena.num_rows || arena.arena?.num_rows;
        const numCols = arena.cols || arena.num_cols || arena.arena?.num_cols;
        // For partial arenas, use columns_installed length instead of num_cols
        const columnsInstalled = arena.columns_installed || arena.arena?.columns_installed;
        const installedCols = columnsInstalled?.length || numCols;

        const specs = this.getPanelSpecs(generation);
        const panelSize = specs.pixels_per_panel;

        return {
            generation,
            rows: numRows,
            cols: numCols,           // Total arena slots (for geometry calculations)
            installedCols,           // Actual installed columns (for pattern dimensions)
            pixelRows: numRows * panelSize,
            pixelCols: installedCols * panelSize,  // Use installed columns for pattern width
            panelSize
        };
    },

    /**
     * Create an empty frame (all zeros)
     * @param {number} pixelRows - Number of pixel rows
     * @param {number} pixelCols - Number of pixel columns
     * @returns {Uint8Array} Empty frame data
     */
    createEmptyFrame(pixelRows, pixelCols) {
        return new Uint8Array(pixelRows * pixelCols);
    },

    /**
     * Set a pixel value with horizontal wrap-around
     * @param {Uint8Array} frame - Frame data array
     * @param {number} row - Row index (0 = bottom)
     * @param {number} col - Column index
     * @param {number} value - Pixel value
     * @param {number} pixelCols - Total columns for wrap calculation
     */
    setPixel(frame, row, col, value, pixelCols) {
        const wrappedCol = ((col % pixelCols) + pixelCols) % pixelCols;
        frame[row * pixelCols + wrappedCol] = value;
    },

    /**
     * Get a pixel value with horizontal wrap-around
     * @param {Uint8Array} frame - Frame data array
     * @param {number} row - Row index (0 = bottom)
     * @param {number} col - Column index
     * @param {number} pixelCols - Total columns for wrap calculation
     * @returns {number} Pixel value
     */
    getPixel(frame, row, col, pixelCols) {
        const wrappedCol = ((col % pixelCols) + pixelCols) % pixelCols;
        return frame[row * pixelCols + wrappedCol];
    },

    /**
     * Generate a square wave grating pattern
     * @param {Object} params - Grating parameters
     * @param {number} params.wavelength - Pixels per full cycle (on + off)
     * @param {string} params.direction - 'cw' (clockwise) or 'ccw' (counter-clockwise)
     * @param {number} [params.dutyCycle=50] - Duty cycle percentage (0-100)
     * @param {number} params.high - High brightness level
     * @param {number} params.low - Low brightness level
     * @param {number} [params.gsMode=16] - Grayscale mode (2 or 16)
     * @param {number} [params.stepSize=1] - Pixels to shift per frame
     * @param {Object} arena - Arena configuration
     * @returns {Object} Pattern data
     */
    generateGrating(params, arena) {
        const {
            wavelength,
            direction = 'cw',
            dutyCycle = 50,
            high,
            low,
            gsMode = 16,
            stepSize = 1
        } = params;

        const dims = this.getArenaDimensions(arena);
        const { pixelRows, pixelCols, generation, rows, cols } = dims;

        // Validate wavelength divides evenly into total pixels for seamless tiling
        if (pixelCols % wavelength !== 0) {
            console.warn(`Wavelength ${wavelength} does not divide evenly into ${pixelCols} pixels. Pattern may not tile seamlessly.`);
        }

        // Number of frames for one complete cycle
        const numFrames = Math.ceil(wavelength / stepSize);

        // Calculate duty cycle thresholds
        const onPixels = Math.round(wavelength * dutyCycle / 100);

        const frames = [];
        const stretchValues = [];

        for (let f = 0; f < numFrames; f++) {
            const frame = this.createEmptyFrame(pixelRows, pixelCols);
            // Phase offset for this frame (direction determines sign)
            const offset = (direction === 'cw' ? f : -f) * stepSize;

            for (let row = 0; row < pixelRows; row++) {
                for (let col = 0; col < pixelCols; col++) {
                    // Calculate phase position within wavelength
                    const phase = ((col + offset) % wavelength + wavelength) % wavelength;
                    const value = phase < onPixels ? high : low;
                    frame[row * pixelCols + col] = value;
                }
            }

            frames.push(frame);
            stretchValues.push(1);
        }

        return {
            generation,
            gs_val: gsMode,
            numFrames,
            rowCount: rows,
            colCount: cols,
            pixelRows,
            pixelCols,
            frames,
            stretchValues
        };
    },

    /**
     * Generate a sinusoidal grating pattern
     * @param {Object} params - Sine parameters
     * @param {number} params.wavelength - Wavelength in pixels
     * @param {string} params.direction - 'cw' (clockwise) or 'ccw' (counter-clockwise)
     * @param {number} params.high - Maximum brightness level
     * @param {number} params.low - Minimum brightness level
     * @param {number} [params.gsMode=16] - Grayscale mode (2 or 16)
     * @param {number} [params.stepSize=1] - Pixels to shift per frame
     * @param {Object} arena - Arena configuration
     * @returns {Object} Pattern data
     */
    generateSine(params, arena) {
        const {
            wavelength,
            direction = 'cw',
            high,
            low,
            gsMode = 16,
            stepSize = 1
        } = params;

        const dims = this.getArenaDimensions(arena);
        const { pixelRows, pixelCols, generation, rows, cols } = dims;

        // Validate wavelength divides evenly into total pixels
        if (pixelCols % wavelength !== 0) {
            console.warn(`Wavelength ${wavelength} does not divide evenly into ${pixelCols} pixels. Pattern may not tile seamlessly.`);
        }

        // Number of frames for one complete cycle
        const numFrames = Math.ceil(wavelength / stepSize);

        const frames = [];
        const stretchValues = [];

        for (let f = 0; f < numFrames; f++) {
            const frame = this.createEmptyFrame(pixelRows, pixelCols);
            const offset = (direction === 'cw' ? f : -f) * stepSize;

            for (let row = 0; row < pixelRows; row++) {
                for (let col = 0; col < pixelCols; col++) {
                    // Calculate phase and sine value
                    const phase = ((col + offset) / wavelength) * 2 * Math.PI;
                    const normalized = (Math.sin(phase) + 1) / 2; // 0 to 1
                    const value = Math.round(low + normalized * (high - low));
                    frame[row * pixelCols + col] = value;
                }
            }

            frames.push(frame);
            stretchValues.push(1);
        }

        return {
            generation,
            gs_val: gsMode,
            numFrames,
            rowCount: rows,
            colCount: cols,
            pixelRows,
            pixelCols,
            frames,
            stretchValues
        };
    },

    /**
     * Generate a spherical coordinate grating pattern
     *
     * Uses proper 3D geometry: generates arena coordinates, applies rotations,
     * converts to spherical, and evaluates pattern based on azimuthal angle (phi)
     * for rotation motion, polar angle (theta) for expansion, or a linear
     * transformation for translation.
     *
     * Direction is determined by pole position and the right-hand rule, matching
     * MATLAB behavior (no explicit CW/CCW parameter).
     *
     * @param {Object} params - Spherical grating parameters
     * @param {number} params.spatFreq - Spatial frequency in radians (wavelength = 2π/spatFreq)
     * @param {string} [params.motionType='rotation'] - 'rotation', 'translation', or 'expansion'
     * @param {string} [params.waveform='square'] - 'square' or 'sine'
     * @param {number} [params.dutyCycle=50] - Duty cycle percentage (0-100, for square wave)
     * @param {number} params.high - High brightness level
     * @param {number} params.low - Low brightness level
     * @param {number[]} [params.poleCoord=[0,0]] - Pattern pole [phi, theta] in radians (determines direction)
     * @param {number} [params.numFrames] - Number of frames (defaults to full cycle)
     * @param {number} [params.stepSize=1] - Step size in pixels per frame (positive = forward motion)
     * @param {number} [params.aaSamples=1] - Anti-aliasing samples (1=off, 15=standard)
     * @param {string} [params.arenaModel='smooth'] - 'smooth' (cylinder) or 'poly' (polygonal)
     * @param {number} [params.gsMode=16] - Grayscale mode (2 or 16)
     * @param {Object} arena - Arena configuration
     * @returns {Object} Pattern data
     */
    generateSphericalGrating(params, arena) {
        // Ensure ArenaGeometry is available
        const geom = ArenaGeometry_LOCAL || (typeof window !== 'undefined' ? window.ArenaGeometry : null);
        if (!geom) {
            throw new Error('ArenaGeometry module not available. Include arena-geometry.js before using spherical patterns.');
        }

        const {
            spatFreq,
            motionType = 'rotation',
            waveform = 'square',
            dutyCycle = 50,
            high,
            low,
            poleCoord = [0, 0],
            numFrames: requestedFrames,
            stepSize = 1,
            aaSamples = 1,
            arenaModel = 'smooth',
            gsMode = 16,
            phaseShift = 0  // Phase shift as percentage of wavelength (0-100%)
        } = params;

        const dims = this.getArenaDimensions(arena);
        const { pixelRows, pixelCols, generation, rows, cols, installedCols, panelSize } = dims;

        // Determine number of columns for full circle (Pcircle)
        // For partial arenas, numCircle is the FULL arena size (for correct angular spacing)
        // but numCols should be the installed columns (for pattern dimensions)
        const numCircle = arena.numCircle || arena.num_cols_full || arena.Pcircle || cols;

        // Generate arena coordinates
        // numCols = installed columns (pattern dimension)
        // numCircle = full circle columns (for angular spacing geometry)
        const arenaConfig = {
            panelSize,
            numCols: installedCols,      // Pattern covers installed columns only
            numRows: rows,
            numCircle: numCircle,        // Full circle panels (for correct angular spacing)
            model: arenaModel
        };
        const arenaCoords = geom.arenaCoordinates(arenaConfig);

        // Apply rotations to align pattern pole
        // poleCoord = [phi, theta] where phi is azimuthal, theta is polar from north (0 = top)
        // For rotation patterns, the pole is where all azimuthal lines converge
        // poleCoord = [0, 0] means pole at north (z=-1), giving horizontal bands for rotation
        //
        // MATLAB formula (make_grating_edge.m line 34):
        //   rotations = [-param.pole_coord(1) -param.pole_coord(2)-pi/2 0]
        // The -π/2 pitch offset aligns the pattern coordinate system properly
        const rotations = {
            yaw: -poleCoord[0],
            pitch: -poleCoord[1] - Math.PI / 2,
            roll: 0
        };
        const rotated = geom.rotateCoordinates(
            arenaCoords.x,
            arenaCoords.y,
            arenaCoords.z,
            rotations
        );

        // Convert to spherical coordinates
        const spherical = geom.cart2sphere(rotated.x, rotated.y, rotated.z);

        // Select coordinate based on motion type
        let coord;
        if (motionType === 'rotation') {
            // Use azimuthal angle (phi) - pattern rotates around pole
            coord = spherical.phi;
        } else if (motionType === 'expansion') {
            // Use polar angle (theta) - pattern expands/contracts from pole
            coord = spherical.theta;
        } else if (motionType === 'translation') {
            // Use tan(theta - π/2) for linear motion appearance
            coord = new Array(pixelRows);
            for (let r = 0; r < pixelRows; r++) {
                coord[r] = new Float32Array(pixelCols);
                for (let c = 0; c < pixelCols; c++) {
                    coord[r][c] = Math.tan(spherical.theta[r][c] - Math.PI / 2);
                }
            }
        } else {
            throw new Error(`Unknown motion type: ${motionType}. Use 'rotation', 'expansion', or 'translation'.`);
        }

        // Generate samples for anti-aliasing
        let samples;
        if (aaSamples > 1) {
            samples = geom.samplesByPRad(coord, aaSamples, arenaCoords.pRad);
        }

        // Calculate true step size in radians
        const trueStepSize = arenaCoords.pRad * stepSize;

        // Number of frames: default to one full spatial cycle
        const framesPerCycle = Math.ceil(spatFreq / Math.abs(trueStepSize));
        const numFrames = requestedFrames || framesPerCycle;

        // Direction is determined by step size sign (positive = one direction, negative = opposite)
        // Combined with pole position, this matches MATLAB's right-hand rule behavior
        const frames = [];
        const stretchValues = [];

        // Initial phase shift: percentage of spatial frequency (wavelength) converted to radians
        const initialPhase = (phaseShift / 100) * spatFreq;

        for (let f = 0; f < numFrames; f++) {
            const frame = this.createEmptyFrame(pixelRows, pixelCols);
            const phaseOffset = initialPhase + f * trueStepSize;

            for (let row = 0; row < pixelRows; row++) {
                for (let col = 0; col < pixelCols; col++) {
                    let value;

                    if (aaSamples > 1) {
                        // Average multiple samples for anti-aliasing
                        let sum = 0;
                        for (let s = 0; s < aaSamples; s++) {
                            const c = samples[row][col][s] - phaseOffset;
                            sum += this._evaluateWaveform(c, spatFreq, dutyCycle, waveform, high, low);
                        }
                        value = Math.round(sum / aaSamples);
                    } else {
                        // Single sample (no AA)
                        const c = coord[row][col] - phaseOffset;
                        value = this._evaluateWaveform(c, spatFreq, dutyCycle, waveform, high, low);
                    }

                    frame[row * pixelCols + col] = value;
                }
            }

            frames.push(frame);
            stretchValues.push(1);
        }

        return {
            generation,
            gs_val: gsMode,
            numFrames,
            rowCount: rows,
            colCount: cols,
            pixelRows,
            pixelCols,
            frames,
            stretchValues
        };
    },

    /**
     * Evaluate waveform value at a given coordinate
     * @private
     * @param {number} c - Coordinate value (phase)
     * @param {number} spatFreq - Spatial frequency in radians
     * @param {number} dutyCycle - Duty cycle percentage (for square wave)
     * @param {string} waveform - 'square' or 'sine'
     * @param {number} high - High brightness level
     * @param {number} low - Low brightness level
     * @returns {number} Pixel value
     */
    _evaluateWaveform(c, spatFreq, dutyCycle, waveform, high, low) {
        if (waveform === 'sine') {
            // Sine wave: matches MATLAB's sin() formula
            // MATLAB: (sin((coord+phase_shift)*2*pi/spat_freq)+1)/2
            const normalized = (Math.sin(c * 2 * Math.PI / spatFreq) + 1) / 2;
            return Math.round(low + normalized * (high - low));
        } else {
            // Square wave: matches MATLAB's square() function
            // MATLAB: square(t, duty) returns +1 when mod(t, 2*pi) < 2*pi*duty/100
            // In MATLAB: (square((coord)*2*pi/spat_freq, duty_cycle)+1)/2
            // The argument to square is: coord * 2*pi / spat_freq
            // Square returns +1 when mod(arg, 2*pi) < 2*pi * dutyCycle/100
            const arg = c * 2 * Math.PI / spatFreq;
            // Normalize arg to [0, 2*pi) range
            const argMod = ((arg % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            const threshold = 2 * Math.PI * dutyCycle / 100;
            return argMod < threshold ? high : low;
        }
    },

    /**
     * Generate a starfield pattern with random dots using spherical motion
     *
     * Matches MATLAB behavior: generates random dots in 3D space and moves them
     * using spherical coordinates. Direction is determined by pole position.
     *
     * @param {Object} params - Starfield parameters
     * @param {number} params.dotCount - Number of dots
     * @param {number} [params.dotSize=1] - Dot radius in pixels
     * @param {number} params.brightness - Dot brightness level
     * @param {number} [params.background=0] - Background brightness
     * @param {number} [params.seed=12345] - Random seed for reproducibility
     * @param {number} [params.gsMode=16] - Grayscale mode (2 or 16)
     * @param {number} [params.numFrames=1] - Number of frames
     * @param {string} [params.motionType='rotation'] - 'rotation', 'translation', or 'expansion'
     * @param {number[]} [params.poleCoord=[0,0]] - Pattern pole [phi, theta] in radians
     * @param {number} [params.stepSize=1] - Step size per frame (in pixels equivalent)
     * @param {string} [params.arenaModel='smooth'] - 'smooth' (cylinder) or 'poly' (polygonal)
     * @param {Object} arena - Arena configuration
     * @returns {Object} Pattern data
     */
    generateStarfield(params, arena) {
        // Ensure ArenaGeometry is available
        const geom = ArenaGeometry_LOCAL || (typeof window !== 'undefined' ? window.ArenaGeometry : null);
        if (!geom) {
            throw new Error('ArenaGeometry module not available. Include arena-geometry.js before using starfield patterns.');
        }

        const {
            dotCount,
            dotSize = 1,
            brightness,
            background = 0,
            seed = 12345,
            gsMode = 16,
            numFrames = 1,
            motionType = 'rotation',
            poleCoord = [0, 0],
            stepSize = 1,
            arenaModel = 'smooth',
            // Advanced options (MATLAB parity)
            dotBrightnessMode = 'fixed',    // 'fixed', 'random-spread', 'random-binary'
            dotSizeMode = 'static',          // 'static', 'distance'
            dotOcclusion = 'closest',        // 'closest', 'sum', 'mean'
            snapDots = true                  // Snap dots to pixel grid
        } = params;

        const dims = this.getArenaDimensions(arena);
        const { pixelRows, pixelCols, generation, rows, cols, installedCols, panelSize } = dims;

        // Determine number of columns for full circle (Pcircle)
        const numCircle = arena.numCircle || arena.num_cols_full || arena.Pcircle || cols;

        // Generate arena coordinates for projection
        const arenaConfig = {
            panelSize,
            numCols: installedCols,      // Pattern covers installed columns only
            numRows: rows,
            numCircle: numCircle,        // Full circle for angular spacing
            model: arenaModel
        };
        const arenaCoords = geom.arenaCoordinates(arenaConfig);

        // Calculate rotation matrix based on pole (same as grating)
        const rotations = {
            yaw: -poleCoord[0],
            pitch: -poleCoord[1] - Math.PI / 2,
            roll: 0
        };

        // Calculate step size in radians
        const trueStepSize = arenaCoords.pRad * stepSize;

        // Generate random dot positions in spherical coordinates using seeded random
        const random = createSeededRandom(seed);
        const dots = [];

        for (let i = 0; i < dotCount; i++) {
            // Generate random position in 3D space (uniform on sphere surface)
            // Using rejection sampling for uniform distribution
            let x, y, z, r2;
            do {
                x = random() * 2 - 1;
                y = random() * 2 - 1;
                z = random() * 2 - 1;
                r2 = x * x + y * y + z * z;
            } while (r2 > 1 || r2 < 0.01);

            // Normalize to unit sphere and convert to spherical
            const r = Math.sqrt(r2);
            x /= r; y /= r; z /= r;

            // Convert to spherical coordinates
            const phi = Math.atan2(y, x);
            const theta = Math.acos(z);

            // Determine dot brightness based on mode
            let dotBrightness;
            if (dotBrightnessMode === 'fixed') {
                dotBrightness = brightness;
            } else if (dotBrightnessMode === 'random-spread') {
                dotBrightness = Math.floor(random() * (brightness + 1));
            } else if (dotBrightnessMode === 'random-binary') {
                dotBrightness = random() > 0.5 ? brightness : 0;
            } else {
                dotBrightness = brightness;
            }

            // Store distance from center (for distance-relative size mode)
            // Distance is based on theta (angular distance from pole)
            const distance = Math.abs(theta - Math.PI / 2) / (Math.PI / 2);  // 0 at equator, 1 at poles

            dots.push({ phi, theta, rho: 1, brightness: dotBrightness, distance });
        }

        const frames = [];
        const stretchValues = [];

        for (let f = 0; f < numFrames; f++) {
            const frame = this.createEmptyFrame(pixelRows, pixelCols);

            // Fill background
            if (background > 0) {
                frame.fill(background);
            }

            // For occlusion tracking (closest mode)
            const closestDistance = dotOcclusion === 'closest' ?
                new Float32Array(pixelRows * pixelCols).fill(Infinity) : null;

            // For mean occlusion (need to track count and sum)
            const pixelCount = dotOcclusion === 'mean' ?
                new Uint8Array(pixelRows * pixelCols) : null;

            // Calculate dot positions for this frame
            for (const dot of dots) {
                // Apply motion
                let dotPhi = dot.phi;
                let dotTheta = dot.theta;

                if (motionType === 'rotation') {
                    // Motion through phi (azimuthal)
                    dotPhi = dot.phi + f * trueStepSize;
                } else if (motionType === 'expansion') {
                    // Motion through theta (polar)
                    dotTheta = dot.theta + f * trueStepSize;
                    // Wrap around
                    if (dotTheta > Math.PI) {
                        dotTheta = dotTheta - Math.PI;
                    }
                } else if (motionType === 'translation') {
                    // Motion through z coordinate
                    const x = Math.sin(dot.theta) * Math.cos(dot.phi);
                    const y = Math.sin(dot.theta) * Math.sin(dot.phi);
                    let z = Math.cos(dot.theta) + f * trueStepSize;
                    // Wrap z
                    while (z > 1) z -= 2;
                    while (z < -1) z += 2;
                    // Convert back to spherical
                    const rhoXY = Math.sqrt(x * x + y * y);
                    dotTheta = Math.atan2(rhoXY, z);
                    if (dotTheta < 0) dotTheta += Math.PI;
                }

                // Convert spherical to Cartesian
                const dotX = Math.sin(dotTheta) * Math.cos(dotPhi);
                const dotY = Math.sin(dotTheta) * Math.sin(dotPhi);
                const dotZ = Math.cos(dotTheta);

                // Apply inverse rotation to transform from pattern space to arena space
                // We need the inverse of the rotation applied to arena coordinates
                const cosYaw = Math.cos(-rotations.yaw);
                const sinYaw = Math.sin(-rotations.yaw);
                const cosPitch = Math.cos(-rotations.pitch);
                const sinPitch = Math.sin(-rotations.pitch);

                // Apply inverse pitch (around X axis)
                const y1 = dotY * cosPitch - dotZ * sinPitch;
                const z1 = dotY * sinPitch + dotZ * cosPitch;
                const x1 = dotX;

                // Apply inverse yaw (around Z axis)
                const x2 = x1 * cosYaw - y1 * sinYaw;
                const y2 = x1 * sinYaw + y1 * cosYaw;
                const z2 = z1;

                // Project to arena pixel coordinates
                // Find the pixel that this dot falls into
                const dotAzimuth = Math.atan2(y2, x2);  // -π to π
                const dotElevation = Math.asin(z2);     // -π/2 to π/2

                // Convert to pixel coordinates
                // Azimuth maps to columns (centered at 0)
                let pixelColFloat = (dotAzimuth / (2 * Math.PI) + 0.5) * pixelCols;
                let pixelCol = snapDots ? Math.round(pixelColFloat) : Math.floor(pixelColFloat);
                pixelCol = pixelCol % pixelCols;

                // Elevation maps to rows (centered at equator)
                const elevationRange = Math.PI * rows * panelSize / (cols * panelSize);  // Approximate vertical FOV
                let pixelRowFloat = (dotElevation / elevationRange + 0.5) * pixelRows;
                let pixelRow = snapDots ? Math.round(pixelRowFloat) : Math.floor(pixelRowFloat);

                // Check if dot is visible
                if (pixelRow >= 0 && pixelRow < pixelRows) {
                    const wrappedCol = ((pixelCol % pixelCols) + pixelCols) % pixelCols;

                    // Calculate dot radius based on size mode
                    let effectiveSize = dotSize;
                    if (dotSizeMode === 'distance') {
                        // Distance-relative: closer dots (lower theta) appear larger
                        effectiveSize = Math.max(1, Math.round(dotSize * (1 + (1 - dot.distance))));
                    }

                    // Draw dot with brightness and occlusion handling
                    const drawPixel = (r, c, val) => {
                        const idx = r * pixelCols + c;
                        if (dotOcclusion === 'sum') {
                            // Sum brightness (clamp to max)
                            const maxVal = gsMode === 2 ? 1 : 15;
                            frame[idx] = Math.min(frame[idx] + val, maxVal);
                        } else if (dotOcclusion === 'mean') {
                            // Accumulate for mean
                            frame[idx] += val;
                            pixelCount[idx]++;
                        } else {
                            // Closest wins (default) - use stored distance
                            if (dot.distance < closestDistance[idx]) {
                                frame[idx] = val;
                                closestDistance[idx] = dot.distance;
                            }
                        }
                    };

                    // Draw dot
                    if (effectiveSize <= 1) {
                        drawPixel(pixelRow, wrappedCol, dot.brightness);
                    } else {
                        // Draw filled circle
                        for (let dy = -effectiveSize; dy <= effectiveSize; dy++) {
                            for (let dx = -effectiveSize; dx <= effectiveSize; dx++) {
                                if (dx * dx + dy * dy <= effectiveSize * effectiveSize) {
                                    const r = pixelRow + dy;
                                    if (r >= 0 && r < pixelRows) {
                                        const c = ((wrappedCol + dx) % pixelCols + pixelCols) % pixelCols;
                                        drawPixel(r, c, dot.brightness);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // If using mean occlusion, divide accumulated values by count
            if (dotOcclusion === 'mean' && pixelCount) {
                for (let i = 0; i < frame.length; i++) {
                    if (pixelCount[i] > 0) {
                        frame[i] = Math.round(frame[i] / pixelCount[i]);
                    }
                }
            }

            frames.push(frame);
            stretchValues.push(1);
        }

        return {
            generation,
            gs_val: gsMode,
            numFrames,
            rowCount: rows,
            colCount: cols,
            pixelRows,
            pixelCols,
            frames,
            stretchValues
        };
    },

    /**
     * Generate an edge pattern (duty-cycle sweep using spherical coordinates)
     *
     * Matches MATLAB behavior: creates a grating pattern where the duty cycle
     * sweeps from 0% to 100%, creating an advancing edge effect. Uses the same
     * spherical coordinate system as gratings.
     *
     * @param {Object} params - Edge parameters
     * @param {number} params.spatFreq - Spatial frequency in radians (determines edge steepness)
     * @param {string} [params.motionType='rotation'] - 'rotation', 'translation', or 'expansion'
     * @param {number} params.high - High brightness level
     * @param {number} params.low - Low brightness level
     * @param {number[]} [params.poleCoord=[0,0]] - Pattern pole [phi, theta] in radians
     * @param {number} [params.numFrames] - Number of frames (defaults to pixelCols + 1)
     * @param {number} [params.aaSamples=1] - Anti-aliasing samples (1=off, 15=standard)
     * @param {string} [params.arenaModel='smooth'] - 'smooth' (cylinder) or 'poly' (polygonal)
     * @param {number} [params.gsMode=16] - Grayscale mode (2 or 16)
     * @param {Object} arena - Arena configuration
     * @returns {Object} Pattern data
     */
    generateEdge(params, arena) {
        // Ensure ArenaGeometry is available
        const geom = ArenaGeometry_LOCAL || (typeof window !== 'undefined' ? window.ArenaGeometry : null);
        if (!geom) {
            throw new Error('ArenaGeometry module not available. Include arena-geometry.js before using edge patterns.');
        }

        const {
            spatFreq,
            motionType = 'rotation',
            high,
            low,
            poleCoord = [0, 0],
            numFrames: requestedFrames,
            aaSamples = 1,
            arenaModel = 'smooth',
            gsMode = 16,
            phaseShift = 0  // Phase shift as percentage of wavelength (0-100%)
        } = params;

        const dims = this.getArenaDimensions(arena);
        const { pixelRows, pixelCols, generation, rows, cols, installedCols, panelSize } = dims;

        // Determine number of columns for full circle (Pcircle)
        const numCircle = arena.numCircle || arena.num_cols_full || arena.Pcircle || cols;

        // Generate arena coordinates
        const arenaConfig = {
            panelSize,
            numCols: installedCols,      // Pattern covers installed columns only
            numRows: rows,
            numCircle: numCircle,        // Full circle for angular spacing
            model: arenaModel
        };
        const arenaCoords = geom.arenaCoordinates(arenaConfig);

        // Apply rotations to align pattern pole (same as spherical grating)
        const rotations = {
            yaw: -poleCoord[0],
            pitch: -poleCoord[1] - Math.PI / 2,
            roll: 0
        };
        const rotated = geom.rotateCoordinates(
            arenaCoords.x,
            arenaCoords.y,
            arenaCoords.z,
            rotations
        );

        // Convert to spherical coordinates
        const spherical = geom.cart2sphere(rotated.x, rotated.y, rotated.z);

        // Select coordinate based on motion type
        let coord;
        if (motionType === 'rotation') {
            coord = spherical.phi;
        } else if (motionType === 'expansion') {
            coord = spherical.theta;
        } else if (motionType === 'translation') {
            coord = new Array(pixelRows);
            for (let r = 0; r < pixelRows; r++) {
                coord[r] = new Float32Array(pixelCols);
                for (let c = 0; c < pixelCols; c++) {
                    coord[r][c] = Math.tan(spherical.theta[r][c] - Math.PI / 2);
                }
            }
        } else {
            throw new Error(`Unknown motion type: ${motionType}`);
        }

        // Generate samples for anti-aliasing
        let samples;
        if (aaSamples > 1) {
            samples = geom.samplesByPRad(coord, aaSamples, arenaCoords.pRad);
        }

        // Number of frames: use requested frames, or default to gsMode + 1 for duty cycle sweep
        // gsMode + 1 gives frames for 0%, 100/(gsMode)%, 200/(gsMode)%, ..., 100% duty cycle
        const numFrames = requestedFrames || (gsMode + 1);

        const frames = [];
        const stretchValues = [];

        // Initial phase shift: percentage of spatial frequency (wavelength) converted to radians
        const initialPhase = (phaseShift / 100) * spatFreq;

        // MATLAB: duty_cycle = 0:100/(num_frames-1):100
        // Duty cycle sweeps from 0% to 100% across frames
        for (let f = 0; f < numFrames; f++) {
            const frame = this.createEmptyFrame(pixelRows, pixelCols);
            const dutyCycle = (f / (numFrames - 1)) * 100;

            for (let row = 0; row < pixelRows; row++) {
                for (let col = 0; col < pixelCols; col++) {
                    let value;

                    if (aaSamples > 1) {
                        // Average multiple samples for anti-aliasing
                        let sum = 0;
                        for (let s = 0; s < aaSamples; s++) {
                            const c = samples[row][col][s] + initialPhase;
                            sum += this._evaluateWaveform(c, spatFreq, dutyCycle, 'square', high, low);
                        }
                        value = Math.round(sum / aaSamples);
                    } else {
                        // Single sample (no AA)
                        const c = coord[row][col] + initialPhase;
                        value = this._evaluateWaveform(c, spatFreq, dutyCycle, 'square', high, low);
                    }

                    frame[row * pixelCols + col] = value;
                }
            }

            frames.push(frame);
            stretchValues.push(1);
        }

        return {
            generation,
            gs_val: gsMode,
            numFrames,
            rowCount: rows,
            colCount: cols,
            pixelRows,
            pixelCols,
            frames,
            stretchValues
        };
    },

    /**
     * Generate an off/on pattern (brightness ramp from low to high)
     *
     * Matches MATLAB behavior: generates |high - low| + 1 frames where each frame
     * is a uniform brightness level stepping from low to high (or high to low if
     * low > high). This creates a gradual brightness ramp for flicker stimuli.
     *
     * @param {Object} params - Off/On parameters
     * @param {number} params.high - High brightness level
     * @param {number} params.low - Low brightness level
     * @param {number} [params.gsMode=16] - Grayscale mode (2 or 16)
     * @param {Object} arena - Arena configuration
     * @returns {Object} Pattern data
     */
    generateOffOn(params, arena) {
        const {
            high,
            low,
            gsMode = 16
        } = params;

        const dims = this.getArenaDimensions(arena);
        const { pixelRows, pixelCols, generation, rows, cols } = dims;

        // MATLAB behavior: |high - low| + 1 frames
        // Each frame is uniform brightness stepping from low to high
        const numFrames = Math.abs(high - low) + 1;
        const frames = [];
        const stretchValues = [];

        for (let i = 0; i < numFrames; i++) {
            const frame = this.createEmptyFrame(pixelRows, pixelCols);
            // Step from low to high (or high to low if low > high)
            const brightness = low < high ? low + i : low - i;
            frame.fill(brightness);
            frames.push(frame);
            stretchValues.push(1);
        }

        return {
            generation,
            gs_val: gsMode,
            numFrames,
            rowCount: rows,
            colCount: cols,
            pixelRows,
            pixelCols,
            frames,
            stretchValues
        };
    },

    /**
     * Validate a generated pattern
     * @param {Object} pattern - Pattern data to validate
     * @returns {Object} Validation result {valid, errors, warnings}
     */
    validate(pattern) {
        const errors = [];
        const warnings = [];

        // Check required fields
        if (!pattern.generation) errors.push('Missing generation');
        if (!pattern.gs_val) errors.push('Missing gs_val (grayscale mode)');
        if (typeof pattern.numFrames !== 'number') errors.push('Missing or invalid numFrames');
        if (!pattern.frames || !Array.isArray(pattern.frames)) errors.push('Missing or invalid frames array');
        if (typeof pattern.pixelRows !== 'number') errors.push('Missing pixelRows');
        if (typeof pattern.pixelCols !== 'number') errors.push('Missing pixelCols');

        if (errors.length === 0) {
            // Check frame count matches
            if (pattern.frames.length !== pattern.numFrames) {
                errors.push(`Frame count mismatch: numFrames=${pattern.numFrames}, actual=${pattern.frames.length}`);
            }

            // Check frame sizes
            const expectedSize = pattern.pixelRows * pattern.pixelCols;
            pattern.frames.forEach((frame, i) => {
                if (frame.length !== expectedSize) {
                    errors.push(`Frame ${i} size mismatch: expected ${expectedSize}, got ${frame.length}`);
                }
            });

            // Check pixel values are in valid range
            const maxVal = pattern.gs_val === 2 ? 1 : 15;
            pattern.frames.forEach((frame, i) => {
                for (let j = 0; j < frame.length; j++) {
                    if (frame[j] < 0 || frame[j] > maxVal) {
                        errors.push(`Frame ${i} pixel ${j} out of range: ${frame[j]} (max ${maxVal})`);
                        break; // Only report first error per frame
                    }
                }
            });

            // Check stretch values
            if (pattern.stretchValues) {
                if (pattern.stretchValues.length !== pattern.numFrames) {
                    warnings.push(`Stretch values count mismatch: ${pattern.stretchValues.length} vs ${pattern.numFrames} frames`);
                }
            } else {
                warnings.push('Missing stretchValues array');
            }
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }
};

// Export for both browser and Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PatternGenerator;
}
// Make available globally in browser
if (typeof window !== 'undefined') {
    window.PatternGenerator = PatternGenerator;
}
