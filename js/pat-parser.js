/**
 * .pat File Parser Module
 *
 * Parses G4/G4.1 and G6 binary pattern files (.pat) used by Reiser Lab LED displays.
 * Works in both Node.js and browser environments.
 *
 * Supported formats:
 * - G6: 20x20 pixel panels, 18-byte header with "G6PT" magic
 * - G4/G4.1: 16x16 pixel panels, 7-byte header
 *
 * Coordinate Convention:
 * - Origin (0,0) at bottom-left of arena
 * - Row 0 = bottom, increases upward
 * - Column 0 = leftmost (south in CW mode)
 */

const PatParser = (function() {
    'use strict';

    // Constants
    const G6_MAGIC = 'G6PT';
    const G6_HEADER_SIZE = 17;
    const G6_FRAME_HEADER_SIZE = 4;
    const G6_PANEL_SIZE = 20;
    const G6_GS2_PANEL_BYTES = 53;
    const G6_GS16_PANEL_BYTES = 203;

    const G4_HEADER_SIZE = 7;
    const G4_PANEL_SIZE = 16;

    /**
     * Detect pattern generation from file header
     * @param {ArrayBuffer} buffer - Raw file data
     * @returns {'G6'|'G4'} Generation type
     */
    function detectGeneration(buffer) {
        const view = new DataView(buffer);

        // Check for G6 magic bytes "G6PT"
        if (buffer.byteLength >= 4) {
            const magic = String.fromCharCode(
                view.getUint8(0),
                view.getUint8(1),
                view.getUint8(2),
                view.getUint8(3)
            );
            if (magic === G6_MAGIC) {
                return 'G6';
            }
        }

        // Assume G4 format (no magic bytes)
        return 'G4';
    }

    /**
     * Parse a .pat file (auto-detects G4 vs G6)
     * @param {ArrayBuffer} buffer - Raw file data
     * @returns {PatternData} Parsed pattern data
     */
    function parsePatFile(buffer) {
        const generation = detectGeneration(buffer);

        if (generation === 'G6') {
            return parseG6Pattern(buffer);
        } else {
            return parseG4Pattern(buffer);
        }
    }

    /**
     * Parse G6 format pattern file
     *
     * Header (17 bytes):
     *   Bytes 0-3:   "G6PT" magic
     *   Byte 4:      Version (1)
     *   Byte 5:      gs_val (1=GS2 binary, 2=GS16 grayscale)
     *   Bytes 6-7:   num_frames (uint16 LE)
     *   Byte 8:      row_count (panel rows)
     *   Byte 9:      col_count (installed columns)
     *   Byte 10:     checksum
     *   Bytes 11-16: panel_mask (6 bytes, 48-bit bitmask)
     *
     * @param {ArrayBuffer} buffer - Raw file data
     * @returns {PatternData} Parsed pattern data
     */
    function parseG6Pattern(buffer) {
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        // Verify magic
        const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        if (magic !== G6_MAGIC) {
            throw new Error(`Invalid G6 file: expected G6PT magic, got ${magic}`);
        }

        // Parse header
        const version = bytes[4];
        const gs_val_raw = bytes[5];  // 1=GS2, 2=GS16
        const numFrames = view.getUint16(6, true);  // little-endian
        const rowCount = bytes[8];
        const colCount = bytes[9];  // Installed columns
        const checksum = bytes[10];
        const panelMask = bytes.slice(11, 17);

        // Convert G6 gs_val to standard (2=binary, 16=grayscale)
        const gs_val = gs_val_raw === 1 ? 2 : 16;
        const isGrayscale = gs_val === 16;
        const panelBytes = isGrayscale ? G6_GS16_PANEL_BYTES : G6_GS2_PANEL_BYTES;

        // Count panels from mask
        let numPanels = 0;
        for (let i = 0; i < 6; i++) {
            for (let bit = 0; bit < 8; bit++) {
                if (panelMask[i] & (1 << bit)) numPanels++;
            }
        }

        // Pattern dimensions
        const pixelRows = rowCount * G6_PANEL_SIZE;
        const pixelCols = colCount * G6_PANEL_SIZE;
        const maxValue = isGrayscale ? 15 : 1;

        // Parse frames
        const frames = [];
        const stretchValues = [];
        let offset = G6_HEADER_SIZE;

        for (let f = 0; f < numFrames; f++) {
            // Verify frame header "FR"
            if (bytes[offset] !== 0x46 || bytes[offset + 1] !== 0x52) {  // 'F', 'R'
                console.warn(`Frame ${f}: expected FR header at offset ${offset}`);
            }
            offset += G6_FRAME_HEADER_SIZE;

            // Decode panels for this frame
            const frame = new Uint8Array(pixelRows * pixelCols);
            let frameStretch = 0;

            for (let panelRow = 0; panelRow < rowCount; panelRow++) {
                for (let panelCol = 0; panelCol < colCount; panelCol++) {
                    const panelBlock = bytes.slice(offset, offset + panelBytes);
                    offset += panelBytes;

                    // Get stretch from last byte of panel block
                    frameStretch = panelBlock[panelBytes - 1];

                    // Decode panel pixels
                    const panelPixels = isGrayscale
                        ? decodeG6PanelGS16(panelBlock)
                        : decodeG6PanelGS2(panelBlock);

                    // Copy to frame at correct position
                    // Panel row 0 = bottom of arena, displayed at bottom
                    for (let py = 0; py < G6_PANEL_SIZE; py++) {
                        for (let px = 0; px < G6_PANEL_SIZE; px++) {
                            const globalRow = panelRow * G6_PANEL_SIZE + py;
                            const globalCol = panelCol * G6_PANEL_SIZE + px;
                            const frameIdx = globalRow * pixelCols + globalCol;
                            frame[frameIdx] = panelPixels[py * G6_PANEL_SIZE + px];
                        }
                    }
                }
            }

            frames.push(frame);
            stretchValues.push(frameStretch);
        }

        // Console diagnostics
        console.group('Pattern loaded (G6)');
        console.log(`Generation: G6 (${G6_PANEL_SIZE}×${G6_PANEL_SIZE} panels)`);
        console.log(`Dimensions: ${rowCount} rows × ${colCount} cols = ${pixelRows}×${pixelCols} pixels`);
        console.log(`Frames: ${numFrames}`);
        console.log(`Grayscale: ${isGrayscale ? 'GS16 (4-bit, 0-15)' : 'GS2 (1-bit, 0-1)'}`);
        console.log(`Pixel (0,0) value: ${frames[0][0]} (frame 0)`);
        console.log(`Pixel (${pixelRows-1},${pixelCols-1}) value: ${frames[0][(pixelRows-1) * pixelCols + (pixelCols-1)]} (frame 0)`);
        console.groupEnd();

        return {
            generation: 'G6',
            gs_val,
            numFrames,
            rowCount,
            colCount,
            pixelRows,
            pixelCols,
            maxValue,
            frames,
            stretchValues,
            panelSize: G6_PANEL_SIZE,
            version,
            checksum
        };
    }

    /**
     * Decode G6 GS2 (binary) panel block to pixels
     *
     * Panel block: 53 bytes [header, cmd, 50 data bytes, stretch]
     * Data encoding: row-major, 1 bit per pixel, MSB first
     *
     * Row flip: Encoder flips rows (row_from_bottom = 19 - row), decoder flips back
     *
     * @param {Uint8Array} panelBlock - 53-byte panel block
     * @returns {Uint8Array} 400 pixels (20x20), row-major, row 0 = bottom
     */
    function decodeG6PanelGS2(panelBlock) {
        const pixels = new Uint8Array(G6_PANEL_SIZE * G6_PANEL_SIZE);
        const dataBytes = panelBlock.slice(2, 52);  // Skip header (1) and cmd (1), take 50 bytes

        for (let panelRow = 0; panelRow < G6_PANEL_SIZE; panelRow++) {
            for (let panelCol = 0; panelCol < G6_PANEL_SIZE; panelCol++) {
                const pixelNum = panelRow * G6_PANEL_SIZE + panelCol;
                const byteIdx = Math.floor(pixelNum / 8);
                const bitPos = 7 - (pixelNum % 8);  // MSB first
                const pixelVal = (dataBytes[byteIdx] >> bitPos) & 1;

                // Compensate for encoder's row flip
                // Panel row 0 (encoded) was originally row 19, map to output row 19
                const outputRow = (G6_PANEL_SIZE - 1) - panelRow;
                const outputIdx = outputRow * G6_PANEL_SIZE + panelCol;
                pixels[outputIdx] = pixelVal;
            }
        }

        return pixels;
    }

    /**
     * Decode G6 GS16 (grayscale) panel block to pixels
     *
     * Panel block: 203 bytes [header, cmd, 200 data bytes, stretch]
     * Data encoding: row-major, 4 bits per pixel (2 pixels per byte)
     *   - Even pixel: high nibble
     *   - Odd pixel: low nibble
     *
     * @param {Uint8Array} panelBlock - 203-byte panel block
     * @returns {Uint8Array} 400 pixels (20x20), row-major, row 0 = bottom
     */
    function decodeG6PanelGS16(panelBlock) {
        const pixels = new Uint8Array(G6_PANEL_SIZE * G6_PANEL_SIZE);
        const dataBytes = panelBlock.slice(2, 202);  // Skip header (1) and cmd (1), take 200 bytes

        for (let panelRow = 0; panelRow < G6_PANEL_SIZE; panelRow++) {
            for (let panelCol = 0; panelCol < G6_PANEL_SIZE; panelCol++) {
                const pixelNum = panelRow * G6_PANEL_SIZE + panelCol;
                const byteIdx = Math.floor(pixelNum / 2);
                let pixelVal;

                if (pixelNum % 2 === 0) {
                    // Even pixel: high nibble
                    pixelVal = (dataBytes[byteIdx] >> 4) & 0x0F;
                } else {
                    // Odd pixel: low nibble
                    pixelVal = dataBytes[byteIdx] & 0x0F;
                }

                // Compensate for encoder's row flip
                const outputRow = (G6_PANEL_SIZE - 1) - panelRow;
                const outputIdx = outputRow * G6_PANEL_SIZE + panelCol;
                pixels[outputIdx] = pixelVal;
            }
        }

        return pixels;
    }

    /**
     * Parse G4/G4.1 format pattern file
     *
     * Header (7 bytes):
     *   Bytes 0-1:   NumPatsX (uint16 LE)
     *   Bytes 2-3:   NumPatsY (uint16 LE)
     *   Byte 4:      gs_val (1 or 2 = binary, 4 or 16 = grayscale)
     *   Byte 5:      RowN (panel rows)
     *   Byte 6:      ColN (panel cols)
     *
     * Frame data follows header with subpanel messages
     *
     * @param {ArrayBuffer} buffer - Raw file data
     * @returns {PatternData} Parsed pattern data
     */
    function parseG4Pattern(buffer) {
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        // Parse header
        const numPatsX = view.getUint16(0, true);  // little-endian
        const numPatsY = view.getUint16(2, true);
        const gs_val_raw = bytes[4];
        const rowN = bytes[5];  // Panel rows
        const colN = bytes[6];  // Panel cols

        // Normalize gs_val (legacy 1→2, legacy 4→16)
        let gs_val;
        if (gs_val_raw === 1 || gs_val_raw === 2) {
            gs_val = 2;  // Binary
        } else {
            gs_val = 16;  // Grayscale
        }

        const isGrayscale = gs_val === 16;
        const numFrames = numPatsX * numPatsY;
        const pixelRows = rowN * G4_PANEL_SIZE;
        const pixelCols = colN * G4_PANEL_SIZE;
        const maxValue = isGrayscale ? 15 : 1;

        // Calculate frame size
        const numSubpanel = 4;
        const subpanelMsgLength = isGrayscale ? 33 : 9;
        const frameBytes = (colN * subpanelMsgLength + 1) * rowN * numSubpanel;

        // Parse frames
        const frames = [];
        const stretchValues = [];
        let offset = G4_HEADER_SIZE;

        for (let frameY = 0; frameY < numPatsY; frameY++) {
            for (let frameX = 0; frameX < numPatsX; frameX++) {
                const frameData = bytes.slice(offset, offset + frameBytes);
                offset += frameBytes;

                const { pixels, stretch } = decodeG4Frame(frameData, rowN, colN, isGrayscale);
                frames.push(pixels);
                stretchValues.push(stretch);
            }
        }

        // Console diagnostics
        console.group('Pattern loaded (G4)');
        console.log(`Generation: G4 (${G4_PANEL_SIZE}×${G4_PANEL_SIZE} panels)`);
        console.log(`Dimensions: ${rowN} rows × ${colN} cols = ${pixelRows}×${pixelCols} pixels`);
        console.log(`Frames: ${numFrames} (${numPatsX}×${numPatsY})`);
        console.log(`Grayscale: ${isGrayscale ? 'GS16 (4-bit, 0-15)' : 'GS2 (1-bit, 0-1)'}`);
        console.log(`Pixel (0,0) value: ${frames[0][0]} (frame 0)`);
        console.log(`Pixel (${pixelRows-1},${pixelCols-1}) value: ${frames[0][(pixelRows-1) * pixelCols + (pixelCols-1)]} (frame 0)`);
        console.groupEnd();

        return {
            generation: 'G4',
            gs_val,
            numFrames,
            numPatsX,
            numPatsY,
            rowCount: rowN,
            colCount: colN,
            pixelRows,
            pixelCols,
            maxValue,
            frames,
            stretchValues,
            panelSize: G4_PANEL_SIZE
        };
    }

    /**
     * Decode a G4 frame from binary data
     *
     * G4 uses subpanel addressing with 4 quadrants per panel column.
     * The encoding includes row inversions that must be compensated.
     *
     * @param {Uint8Array} frameData - Raw frame bytes
     * @param {number} panelRow - Number of panel rows
     * @param {number} panelCol - Number of panel columns
     * @param {boolean} isGrayscale - True for GS16, false for binary
     * @returns {{pixels: Uint8Array, stretch: number}}
     */
    function decodeG4Frame(frameData, panelRow, panelCol, isGrayscale) {
        const pixelRows = panelRow * G4_PANEL_SIZE;
        const pixelCols = panelCol * G4_PANEL_SIZE;
        const pixels = new Uint8Array(pixelRows * pixelCols);

        const numSubpanel = 4;
        const subpanelMsgLength = isGrayscale ? 33 : 9;
        let stretch = 0;

        let n = 0;

        for (let i = 0; i < panelRow; i++) {
            for (let j = 1; j <= numSubpanel; j++) {
                // Skip row header
                n++;

                for (let k = 1; k <= subpanelMsgLength; k++) {
                    for (let m = 0; m < panelCol; m++) {
                        if (k === 1) {
                            // Command byte contains stretch
                            stretch = frameData[n] >> 1;
                            n++;
                        } else {
                            if (isGrayscale) {
                                // GS16: each byte has 2 pixels (4 bits each)
                                const panelStartRowBeforeInvert = i * 16 + ((j - 1) % 2) * 8 + Math.floor((k - 2) / 4);
                                const panelStartRow = Math.floor(panelStartRowBeforeInvert / 16) * 16 + 15 - (panelStartRowBeforeInvert % 16);
                                const panelStartCol = m * 16 + Math.floor(j / 3) * 8 + ((k - 2) % 4) * 2;

                                const byte = frameData[n];
                                const px1 = byte & 0x0F;         // Low nibble = left pixel
                                const px2 = (byte >> 4) & 0x0F;  // High nibble = right pixel

                                if (panelStartRow < pixelRows && panelStartCol < pixelCols) {
                                    pixels[panelStartRow * pixelCols + panelStartCol] = px1;
                                }
                                if (panelStartRow < pixelRows && panelStartCol + 1 < pixelCols) {
                                    pixels[panelStartRow * pixelCols + panelStartCol + 1] = px2;
                                }
                            } else {
                                // Binary: each byte has 8 pixels (1 bit each)
                                const rowOffset = k - 2;  // 0-7
                                const panelStartRowBeforeInvert = i * 16 + ((j - 1) % 2) * 8 + rowOffset;
                                const panelStartRow = Math.floor(panelStartRowBeforeInvert / 16) * 16 + 15 - (panelStartRowBeforeInvert % 16);
                                const panelStartCol = m * 16 + Math.floor(j / 3) * 8;

                                const byte = frameData[n];
                                for (let p = 0; p < 8; p++) {
                                    const pixelVal = (byte >> p) & 1;
                                    const col = panelStartCol + p;
                                    if (panelStartRow < pixelRows && col < pixelCols) {
                                        pixels[panelStartRow * pixelCols + col] = pixelVal;
                                    }
                                }
                            }
                            n++;
                        }
                    }
                }
            }
        }

        return { pixels, stretch };
    }

    /**
     * Verify pattern orientation by checking known pixel positions
     * @param {PatternData} patternData - Parsed pattern
     * @returns {Object[]} Array of check results
     */
    function verifyPatternOrientation(patternData) {
        const checks = [];
        const { frames, pixelRows, pixelCols, generation, panelSize } = patternData;

        // Check 1: Bottom-left pixel accessible
        const bottomLeftValue = frames[0][0];
        checks.push({
            name: 'Bottom-left pixel (0,0) accessible',
            pass: bottomLeftValue !== undefined,
            value: bottomLeftValue
        });

        // Check 2: Dimensions match expected
        const expectedPixels = pixelRows * pixelCols;
        checks.push({
            name: 'Frame size matches dimensions',
            pass: frames[0].length === expectedPixels,
            expected: expectedPixels,
            actual: frames[0].length
        });

        // Check 3: Panel size correct for generation
        const expectedPanelSize = generation === 'G6' ? 20 : 16;
        checks.push({
            name: `Panel size is ${expectedPanelSize}x${expectedPanelSize}`,
            pass: panelSize === expectedPanelSize,
            expected: expectedPanelSize,
            actual: panelSize
        });

        // Check 4: Pixel rows divisible by panel size
        checks.push({
            name: 'Pixel rows divisible by panel size',
            pass: pixelRows % panelSize === 0,
            pixelRows,
            panelSize
        });

        // Check 5: Pixel cols divisible by panel size
        checks.push({
            name: 'Pixel cols divisible by panel size',
            pass: pixelCols % panelSize === 0,
            pixelCols,
            panelSize
        });

        // Log results
        console.group('Pattern Orientation Verification');
        checks.forEach(c => {
            console.log(c.pass ? '✓' : '✗', c.name, c.pass ? '' : c);
        });
        console.groupEnd();

        return checks;
    }

    /**
     * Get pixel value at (row, col) from frame
     * @param {PatternData} patternData - Parsed pattern
     * @param {number} frameIdx - Frame index (0-based)
     * @param {number} row - Pixel row (0 = bottom)
     * @param {number} col - Pixel column (0 = left)
     * @returns {number} Pixel value (0-1 for binary, 0-15 for grayscale)
     */
    function getPixel(patternData, frameIdx, row, col) {
        const { frames, pixelCols } = patternData;
        if (frameIdx < 0 || frameIdx >= frames.length) return 0;
        if (row < 0 || row >= patternData.pixelRows) return 0;
        if (col < 0 || col >= pixelCols) return 0;

        return frames[frameIdx][row * pixelCols + col];
    }

    /**
     * Find matching arena config based on pattern dimensions
     * @param {PatternData} patternData - Parsed pattern
     * @param {Object} STANDARD_CONFIGS - Arena configs from arena-configs.js
     * @returns {string|null} Config name or null if no match
     */
    function findMatchingConfig(patternData, STANDARD_CONFIGS) {
        const { generation, rowCount, colCount } = patternData;

        for (const [name, config] of Object.entries(STANDARD_CONFIGS)) {
            const arena = config.arena;

            // Match generation
            if (arena.generation !== generation &&
                !(generation === 'G4' && arena.generation === 'G4.1')) {
                continue;
            }

            // Match dimensions
            if (arena.num_rows !== rowCount) continue;

            // For partial arenas, check installed columns
            const installedCols = arena.columns_installed
                ? arena.columns_installed.length
                : arena.num_cols;

            if (installedCols === colCount) {
                return name;
            }
        }

        return null;
    }

    // Public API
    const api = {
        // Core parsing
        detectGeneration,
        parsePatFile,
        parseG6Pattern,
        parseG4Pattern,

        // Panel decoding (for testing)
        decodeG6PanelGS2,
        decodeG6PanelGS16,
        decodeG4Frame,

        // Utilities
        verifyPatternOrientation,
        getPixel,
        findMatchingConfig,

        // Constants
        G6_PANEL_SIZE,
        G4_PANEL_SIZE,
        G6_GS2_PANEL_BYTES,
        G6_GS16_PANEL_BYTES
    };

    return api;
})();

// Export for Node.js (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PatParser;
}

// Export for browser (global)
if (typeof window !== 'undefined') {
    window.PatParser = PatParser;
}

// Export for ES modules
export const parsePatFile = PatParser.parsePatFile;
export const detectGeneration = PatParser.detectGeneration;
export const verifyPatternOrientation = PatParser.verifyPatternOrientation;
export const findMatchingConfig = PatParser.findMatchingConfig;
export const getPixel = PatParser.getPixel;
export default PatParser;
