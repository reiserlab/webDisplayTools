/**
 * Pattern Combiner Module for Pattern Editor
 *
 * Provides operations to combine two patterns:
 * - Sequential: Concatenate frames from A and B
 * - Mask/Blend: Spatial combination using threshold or 50% blend
 * - Split: Left/Right or top/bottom spatial division
 */

/**
 * Combine two patterns sequentially (concatenate frames)
 * @param {Object} patternA - First pattern
 * @param {Object} patternB - Second pattern
 * @returns {Object} Combined pattern with all frames from A followed by all frames from B
 */
export function combineSequential(patternA, patternB) {
    // Validate patterns have compatible dimensions
    if (patternA.pixelRows !== patternB.pixelRows || patternA.pixelCols !== patternB.pixelCols) {
        throw new Error(`Pattern dimensions must match. A: ${patternA.pixelCols}x${patternA.pixelRows}, B: ${patternB.pixelCols}x${patternB.pixelRows}`);
    }

    if (patternA.gsMode !== patternB.gsMode) {
        throw new Error(`Grayscale modes must match. A: GS${patternA.gsMode === 2 ? '2' : '16'}, B: GS${patternB.gsMode === 2 ? '2' : '16'}`);
    }

    // Concatenate frames
    const combinedFrames = [...patternA.frames, ...patternB.frames];

    return {
        ...patternA,
        frames: combinedFrames,
        numFrames: combinedFrames.length,
        filename: null // Clear filename since this is a new pattern
    };
}

/**
 * Combine two patterns using mask/blend
 * @param {Object} patternA - First pattern (background)
 * @param {Object} patternB - Second pattern (foreground)
 * @param {Object} options - { mode: 'threshold'|'blend', threshold: number (0-15 for GS16, 0-1 for GS2) }
 * @returns {Object} Combined pattern
 */
export function combineMask(patternA, patternB, options = {}) {
    const { mode = 'blend', threshold = 7 } = options;

    // Validate patterns have compatible dimensions
    if (patternA.pixelRows !== patternB.pixelRows || patternA.pixelCols !== patternB.pixelCols) {
        throw new Error(`Pattern dimensions must match. A: ${patternA.pixelCols}x${patternA.pixelRows}, B: ${patternB.pixelCols}x${patternB.pixelRows}`);
    }

    if (patternA.gsMode !== patternB.gsMode) {
        throw new Error(`Grayscale modes must match. A: GS${patternA.gsMode === 2 ? '2' : '16'}, B: GS${patternB.gsMode === 2 ? '2' : '16'}`);
    }

    // Use the longer pattern's frame count
    const numFrames = Math.max(patternA.numFrames, patternB.numFrames);
    const pixelsPerFrame = patternA.pixelRows * patternA.pixelCols;

    const combinedFrames = [];

    for (let f = 0; f < numFrames; f++) {
        // Wrap around if one pattern is shorter
        const frameA = patternA.frames[f % patternA.numFrames];
        const frameB = patternB.frames[f % patternB.numFrames];

        const newFrame = new Uint8Array(pixelsPerFrame);

        for (let i = 0; i < pixelsPerFrame; i++) {
            const valA = frameA[i];
            const valB = frameB[i];

            if (mode === 'threshold') {
                // Use B where A exceeds threshold, otherwise use A
                newFrame[i] = valA > threshold ? valB : valA;
            } else {
                // Blend: average of A and B
                newFrame[i] = Math.round((valA + valB) / 2);
            }
        }

        combinedFrames.push(newFrame);
    }

    return {
        ...patternA,
        frames: combinedFrames,
        numFrames: combinedFrames.length,
        filename: null
    };
}

/**
 * Combine two patterns with left/right or top/bottom split
 * @param {Object} patternA - First pattern (left/top side)
 * @param {Object} patternB - Second pattern (right/bottom side)
 * @param {Object} options - { direction: 'horizontal'|'vertical', splitPosition: number (0-1, default 0.5) }
 * @returns {Object} Combined pattern
 */
export function combineSplit(patternA, patternB, options = {}) {
    const { direction = 'horizontal', splitPosition = 0.5 } = options;

    // Validate patterns have compatible dimensions
    if (patternA.pixelRows !== patternB.pixelRows || patternA.pixelCols !== patternB.pixelCols) {
        throw new Error(`Pattern dimensions must match. A: ${patternA.pixelCols}x${patternA.pixelRows}, B: ${patternB.pixelCols}x${patternB.pixelRows}`);
    }

    if (patternA.gsMode !== patternB.gsMode) {
        throw new Error(`Grayscale modes must match. A: GS${patternA.gsMode === 2 ? '2' : '16'}, B: GS${patternB.gsMode === 2 ? '2' : '16'}`);
    }

    const numFrames = Math.max(patternA.numFrames, patternB.numFrames);
    const rows = patternA.pixelRows;
    const cols = patternA.pixelCols;
    const pixelsPerFrame = rows * cols;

    const combinedFrames = [];

    // Calculate split point
    const splitCol = Math.floor(cols * splitPosition);
    const splitRow = Math.floor(rows * splitPosition);

    for (let f = 0; f < numFrames; f++) {
        const frameA = patternA.frames[f % patternA.numFrames];
        const frameB = patternB.frames[f % patternB.numFrames];

        const newFrame = new Uint8Array(pixelsPerFrame);

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const idx = row * cols + col;

                if (direction === 'horizontal') {
                    // Left/Right split: A on left, B on right
                    newFrame[idx] = col < splitCol ? frameA[idx] : frameB[idx];
                } else {
                    // Top/Bottom split: A on top (low row index), B on bottom
                    newFrame[idx] = row < splitRow ? frameA[idx] : frameB[idx];
                }
            }
        }

        combinedFrames.push(newFrame);
    }

    return {
        ...patternA,
        frames: combinedFrames,
        numFrames: combinedFrames.length,
        filename: null
    };
}

/**
 * Main combine function that dispatches to appropriate method
 * @param {Object} patternA - First pattern
 * @param {Object} patternB - Second pattern
 * @param {string} mode - 'sequential', 'mask', 'blend', or 'split'
 * @param {Object} options - Mode-specific options
 * @returns {Object} Combined pattern
 */
export function combinePatterns(patternA, patternB, mode, options = {}) {
    if (!patternA || !patternB) {
        throw new Error('Both patterns must be loaded');
    }

    switch (mode) {
        case 'sequential':
            return combineSequential(patternA, patternB);

        case 'mask':
            return combineMask(patternA, patternB, { ...options, mode: 'threshold' });

        case 'blend':
            return combineMask(patternA, patternB, { ...options, mode: 'blend' });

        case 'split':
            return combineSplit(patternA, patternB, options);

        default:
            throw new Error(`Unknown combine mode: ${mode}`);
    }
}

export default {
    combineSequential,
    combineMask,
    combineSplit,
    combinePatterns
};
