/**
 * Pattern Generator Module
 * Generates various pattern types for LED arena displays
 *
 * @module pattern-editor/tools/generator
 */

// Import PANEL_SPECS if running in Node.js
let PANEL_SPECS_LOCAL;
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
     * @param {string} type - Pattern type: 'grating', 'sine', 'starfield', 'edge', 'offon'
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

        const specs = this.getPanelSpecs(generation);
        const panelSize = specs.pixels_per_panel;

        return {
            generation,
            rows: numRows,
            cols: numCols,
            pixelRows: numRows * panelSize,
            pixelCols: numCols * panelSize,
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
     * Generate a starfield pattern with random dots
     * @param {Object} params - Starfield parameters
     * @param {number} params.dotCount - Number of dots
     * @param {number} [params.dotSize=1] - Dot radius in pixels
     * @param {number} params.brightness - Dot brightness level
     * @param {number} [params.background=0] - Background brightness
     * @param {number} [params.seed=12345] - Random seed for reproducibility
     * @param {number} [params.gsMode=16] - Grayscale mode (2 or 16)
     * @param {number} [params.numFrames=1] - Number of frames (for rotation)
     * @param {string} [params.direction='cw'] - Rotation direction
     * @param {number} [params.stepSize=1] - Pixels to rotate per frame
     * @param {Object} arena - Arena configuration
     * @returns {Object} Pattern data
     */
    generateStarfield(params, arena) {
        const {
            dotCount,
            dotSize = 1,
            brightness,
            background = 0,
            seed = 12345,
            gsMode = 16,
            numFrames = 1,
            direction = 'cw',
            stepSize = 1
        } = params;

        const dims = this.getArenaDimensions(arena);
        const { pixelRows, pixelCols, generation, rows, cols } = dims;

        // Generate star positions using seeded random
        const random = createSeededRandom(seed);
        const stars = [];

        for (let i = 0; i < dotCount; i++) {
            stars.push({
                col: Math.floor(random() * pixelCols),
                row: Math.floor(random() * pixelRows)
            });
        }

        const frames = [];
        const stretchValues = [];

        for (let f = 0; f < numFrames; f++) {
            const frame = this.createEmptyFrame(pixelRows, pixelCols);

            // Fill background
            if (background > 0) {
                frame.fill(background);
            }

            const offset = (direction === 'cw' ? f : -f) * stepSize;

            // Draw stars with offset
            for (const star of stars) {
                const baseCol = (star.col + offset) % pixelCols;

                // Draw dot (simple circle approximation for dotSize > 1)
                if (dotSize <= 1) {
                    this.setPixel(frame, star.row, baseCol, brightness, pixelCols);
                } else {
                    // Draw filled circle
                    for (let dy = -dotSize; dy <= dotSize; dy++) {
                        for (let dx = -dotSize; dx <= dotSize; dx++) {
                            if (dx * dx + dy * dy <= dotSize * dotSize) {
                                const r = star.row + dy;
                                if (r >= 0 && r < pixelRows) {
                                    this.setPixel(frame, r, baseCol + dx, brightness, pixelCols);
                                }
                            }
                        }
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
     * Generate an edge pattern (vertical line dividing bright/dark regions)
     * @param {Object} params - Edge parameters
     * @param {number} [params.edgePosition=0.5] - Edge position (0-1, 0.5 = middle)
     * @param {string} [params.polarity='light-to-dark'] - 'light-to-dark' or 'dark-to-light'
     * @param {number} params.high - High brightness level
     * @param {number} params.low - Low brightness level
     * @param {number} [params.gsMode=16] - Grayscale mode (2 or 16)
     * @param {number} [params.numFrames=2] - Number of frames (for edge movement)
     * @param {string} [params.direction='cw'] - Movement direction
     * @param {number} [params.stepSize=1] - Pixels to move per frame
     * @param {Object} arena - Arena configuration
     * @returns {Object} Pattern data
     */
    generateEdge(params, arena) {
        const {
            edgePosition = 0.5,
            polarity = 'light-to-dark',
            high,
            low,
            gsMode = 16,
            numFrames = 2,
            direction = 'cw',
            stepSize = 1
        } = params;

        const dims = this.getArenaDimensions(arena);
        const { pixelRows, pixelCols, generation, rows, cols } = dims;

        // Calculate edge column position
        const baseEdgeCol = Math.round(edgePosition * pixelCols);

        // Determine which side is bright
        const leftBright = polarity === 'dark-to-light';

        const frames = [];
        const stretchValues = [];

        for (let f = 0; f < numFrames; f++) {
            const frame = this.createEmptyFrame(pixelRows, pixelCols);
            const offset = (direction === 'cw' ? f : -f) * stepSize;
            const edgeCol = ((baseEdgeCol + offset) % pixelCols + pixelCols) % pixelCols;

            for (let row = 0; row < pixelRows; row++) {
                for (let col = 0; col < pixelCols; col++) {
                    // Determine which side of the edge this pixel is on
                    // Handle wrap-around: consider distance to edge in both directions
                    const distToEdge = col - edgeCol;
                    const isLeftOfEdge = distToEdge < 0 || distToEdge > pixelCols / 2;

                    let value;
                    if (leftBright) {
                        value = isLeftOfEdge ? high : low;
                    } else {
                        value = isLeftOfEdge ? low : high;
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
     * Generate an off/on pattern (alternating all-off and all-on frames)
     * @param {Object} params - Off/On parameters
     * @param {number} params.high - High brightness level (on)
     * @param {number} params.low - Low brightness level (off)
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

        // Frame 0: all off (low)
        const frameOff = this.createEmptyFrame(pixelRows, pixelCols);
        frameOff.fill(low);

        // Frame 1: all on (high)
        const frameOn = this.createEmptyFrame(pixelRows, pixelCols);
        frameOn.fill(high);

        return {
            generation,
            gs_val: gsMode,
            numFrames: 2,
            rowCount: rows,
            colCount: cols,
            pixelRows,
            pixelCols,
            frames: [frameOff, frameOn],
            stretchValues: [1, 1]
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
