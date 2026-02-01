/**
 * Pattern Icon Generator
 * Generates top-down cylindrical view icons from arena pattern data
 *
 * Supports:
 * - Full and partial arena configurations
 * - Single-frame and multi-frame (motion blur) rendering
 * - Configurable perspective (inner radius ratio)
 */

/**
 * Generate a single-frame pattern icon
 * @param {object} patternData - Pattern data from pat-parser { frames, rows, cols, generation, grayscaleMode }
 * @param {object} arenaConfig - Arena configuration { num_rows, num_cols, columns_installed, generation }
 * @param {object} options - Rendering options
 * @returns {string} PNG data URL
 */
function generatePatternIcon(patternData, arenaConfig, options = {}) {
    const opts = {
        frameIndex: null,           // null = middle frame
        width: 256,
        height: 256,
        innerRadiusRatio: 0.2,      // inner/outer radius (smaller = more perspective)
        backgroundColor: '#0f1419',
        showGaps: true,             // render missing panels as gaps
        ...options
    };

    // Select frame
    const frameIndex = opts.frameIndex !== null
        ? opts.frameIndex
        : Math.floor(patternData.frames.length / 2);

    if (frameIndex < 0 || frameIndex >= patternData.frames.length) {
        throw new Error(`Frame index ${frameIndex} out of range`);
    }

    const frameData = patternData.frames[frameIndex];

    // Render the frame
    return renderCylindricalIcon(frameData, patternData, arenaConfig, opts);
}

/**
 * Generate a multi-frame motion blur icon
 * @param {object} patternData - Pattern data from pat-parser
 * @param {object} arenaConfig - Arena configuration
 * @param {object} options - Rendering options including frameRange
 * @returns {string} PNG data URL
 */
function generateMotionIcon(patternData, arenaConfig, options = {}) {
    const opts = {
        frameRange: [0, patternData.frames.length - 1],  // [start, end] inclusive
        maxFrames: 10,                                    // max frames to sample
        weightingFunction: 'exponential',                 // 'exponential' or 'linear'
        width: 256,
        height: 256,
        innerRadiusRatio: 0.2,
        backgroundColor: '#0f1419',
        showGaps: true,
        ...options
    };

    const [startIdx, endIdx] = opts.frameRange;

    if (startIdx < 0 || endIdx >= patternData.frames.length || startIdx > endIdx) {
        throw new Error(`Invalid frame range [${startIdx}, ${endIdx}]`);
    }

    // Select frames to sample
    const totalFrames = endIdx - startIdx + 1;
    const frameIndices = selectFrames(startIdx, endIdx, opts.maxFrames);

    // Calculate weights (newest = highest weight)
    const weights = opts.weightingFunction === 'exponential'
        ? calculateExponentialWeights(frameIndices.length)
        : calculateLinearWeights(frameIndices.length);

    // Compute weighted average frame
    const averagedFrame = computeWeightedAverage(
        patternData.frames,
        frameIndices,
        weights,
        patternData.rows,
        patternData.cols
    );

    // Render the averaged frame
    return renderCylindricalIcon(averagedFrame, patternData, arenaConfig, opts);
}

/**
 * Select frames to sample from a range
 */
function selectFrames(startIdx, endIdx, maxFrames) {
    const totalFrames = endIdx - startIdx + 1;

    if (totalFrames <= maxFrames) {
        // Use all frames (reversed so newest is first)
        return Array.from({ length: totalFrames }, (_, i) => endIdx - i);
    }

    // Sample evenly, always include the newest (endIdx)
    const step = totalFrames / maxFrames;
    const indices = [];
    for (let i = 0; i < maxFrames; i++) {
        const idx = Math.round(endIdx - i * step);
        if (idx >= startIdx && idx <= endIdx) {
            indices.push(idx);
        }
    }
    return indices;
}

/**
 * Calculate exponential weights (newest = 1.0, each older = 0.5x previous)
 */
function calculateExponentialWeights(numFrames) {
    const weights = [];
    for (let i = 0; i < numFrames; i++) {
        weights.push(Math.pow(0.5, i));
    }
    // Normalize
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => w / sum);
}

/**
 * Calculate linear weights (newest = 1.0, linearly decreasing)
 */
function calculateLinearWeights(numFrames) {
    const weights = [];
    for (let i = 0; i < numFrames; i++) {
        weights.push(numFrames - i);
    }
    // Normalize
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => w / sum);
}

/**
 * Compute weighted average of multiple frames
 */
function computeWeightedAverage(frames, frameIndices, weights, rows, cols) {
    const totalPixels = rows * cols;
    const averagedFrame = new Array(totalPixels).fill(0);

    for (let i = 0; i < frameIndices.length; i++) {
        const frameIdx = frameIndices[i];
        const weight = weights[i];
        const frame = frames[frameIdx];

        for (let p = 0; p < totalPixels; p++) {
            averagedFrame[p] += frame[p] * weight;
        }
    }

    return averagedFrame;
}

/**
 * Render cylindrical icon from frame data
 */
function renderCylindricalIcon(frameData, patternData, arenaConfig, opts) {
    const canvas = document.createElement('canvas');
    canvas.width = opts.width;
    canvas.height = opts.height;
    const ctx = canvas.getContext('2d');

    // Enable smooth rendering
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Fill background
    ctx.fillStyle = opts.backgroundColor;
    ctx.fillRect(0, 0, opts.width, opts.height);

    // Calculate arena geometry
    const centerX = opts.width / 2;
    const centerY = opts.height / 2;
    const outerRadius = Math.min(opts.width, opts.height) / 2 - 10; // padding
    const innerRadius = outerRadius * opts.innerRadiusRatio;

    // Get panel specs
    const specs = PANEL_SPECS[arenaConfig.generation];
    if (!specs) {
        throw new Error(`Unknown panel generation: ${arenaConfig.generation}`);
    }

    const pixelsPerPanel = specs.pixels_per_panel;
    const numCols = arenaConfig.num_cols;
    const numRows = arenaConfig.num_rows;
    const columnsInstalled = arenaConfig.columns_installed ||
        Array.from({ length: numCols }, (_, i) => i);

    // Total pixels in arena
    const totalColPixels = numCols * pixelsPerPanel;
    const totalRowPixels = numRows * pixelsPerPanel;

    // Render each column
    for (const colIdx of columnsInstalled) {
        // Calculate angular position for this column
        const colStartAngle = (colIdx / numCols) * 2 * Math.PI;
        const colEndAngle = ((colIdx + 1) / numCols) * 2 * Math.PI;

        // Render each panel in this column
        for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
            // Render each pixel in this panel
            for (let py = 0; py < pixelsPerPanel; py++) {
                for (let px = 0; px < pixelsPerPanel; px++) {
                    // Calculate position in full arena grid
                    const arenaCol = colIdx * pixelsPerPanel + px;
                    const arenaRow = rowIdx * pixelsPerPanel + py;

                    // Get brightness from pattern data
                    const pixelIdx = arenaRow * totalColPixels + arenaCol;
                    const brightness = frameData[pixelIdx] || 0;

                    // Convert to color
                    const color = brightnessToRGB(brightness, patternData.grayscaleMode);

                    // Calculate angular position for this pixel
                    const pixelAngle = colStartAngle + (px / pixelsPerPanel) * (colEndAngle - colStartAngle);

                    // Calculate next pixel angle for width
                    const nextPixelAngle = colStartAngle + ((px + 1) / pixelsPerPanel) * (colEndAngle - colStartAngle);

                    // Draw as filled arc segment
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(centerX, centerY, outerRadius, pixelAngle, nextPixelAngle);
                    ctx.arc(centerX, centerY, innerRadius, nextPixelAngle, pixelAngle, true);
                    ctx.closePath();
                    ctx.fill();
                }
            }
        }
    }

    // Draw inner circle to create donut shape
    ctx.fillStyle = opts.backgroundColor;
    ctx.beginPath();
    ctx.arc(centerX, centerY, innerRadius, 0, 2 * Math.PI);
    ctx.fill();

    // Export as PNG
    return canvas.toDataURL('image/png');
}

/**
 * Convert brightness value to RGB color
 */
function brightnessToRGB(brightness, grayscaleMode) {
    let normalized;

    if (grayscaleMode === 'GS16') {
        // 4-bit grayscale (0-15)
        normalized = brightness / 15;
    } else {
        // GS2 binary (0-1)
        normalized = brightness;
    }

    // Apply gamma correction for better visibility
    normalized = Math.pow(normalized, 0.8);

    const value = Math.round(normalized * 255);
    return `rgb(${value}, ${value}, ${value})`;
}

/**
 * Generate icon with custom frame data (for testing)
 */
function generateTestIcon(width, height, generation, numCols, numRows, pattern = 'grating') {
    const specs = PANEL_SPECS[generation];
    const pixelsPerPanel = specs.pixels_per_panel;
    const totalColPixels = numCols * pixelsPerPanel;
    const totalRowPixels = numRows * pixelsPerPanel;
    const totalPixels = totalColPixels * totalRowPixels;

    // Generate test pattern
    const frameData = new Array(totalPixels);
    for (let row = 0; row < totalRowPixels; row++) {
        for (let col = 0; col < totalColPixels; col++) {
            const idx = row * totalColPixels + col;

            if (pattern === 'grating') {
                // Vertical stripes (20 pixels on/off)
                frameData[idx] = Math.floor(col / 20) % 2;
            } else if (pattern === 'sine') {
                // Sine wave
                frameData[idx] = (Math.sin(col * Math.PI / 30) + 1) / 2;
            } else {
                // All on
                frameData[idx] = 1;
            }
        }
    }

    const patternData = {
        frames: [frameData],
        rows: totalRowPixels,
        cols: totalColPixels,
        generation: generation,
        grayscaleMode: 'GS2'
    };

    const arenaConfig = {
        generation: generation,
        num_rows: numRows,
        num_cols: numCols,
        columns_installed: null
    };

    return generatePatternIcon(patternData, arenaConfig, { width, height });
}

// Export for browser
if (typeof window !== 'undefined') {
    window.IconGenerator = {
        generatePatternIcon,
        generateMotionIcon,
        generateTestIcon,
        selectFrames,
        calculateExponentialWeights,
        calculateLinearWeights
    };
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        generatePatternIcon,
        generateMotionIcon,
        generateTestIcon
    };
}
