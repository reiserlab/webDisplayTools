/**
 * .pat File Encoder Module
 *
 * Encodes pattern data to G4/G4.1 and G6 binary pattern files (.pat).
 * This is the inverse of pat-parser.js.
 * Works in both Node.js and browser environments.
 *
 * Supported formats:
 * - G6: 20x20 pixel panels, 18-byte V2 header with "G6PT" magic, arena_id + observer_id
 * - G4/G4.1: 16x16 pixel panels, 7-byte V2 header with generation_id + arena_id
 *
 * Coordinate Convention:
 * - Origin (0,0) at bottom-left of arena
 * - Row 0 = bottom, increases upward
 * - Column 0 = leftmost (south in CW mode)
 */

const PatEncoder = (function() {
    'use strict';

    // Constants - must match pat-parser.js
    const G6_MAGIC = 'G6PT';
    const G6_HEADER_SIZE = 18;       // V2: 18 bytes (always write V2)
    const G6_FRAME_HEADER_SIZE = 4;  // "FR" + 2 reserved bytes
    const G6_PANEL_SIZE = 20;
    const G6_GS2_PANEL_BYTES = 53;   // header(1) + cmd(1) + data(50) + stretch(1)
    const G6_GS16_PANEL_BYTES = 203; // header(1) + cmd(1) + data(200) + stretch(1)

    const G4_HEADER_SIZE = 7;
    const G4_PANEL_SIZE = 16;

    // Generation ID mapping (same as pat-parser.js)
    const GENERATION_IDS = {
        'G3': 1, 'G4': 2, 'G4.1': 3, 'G6': 4
    };

    /**
     * Encode pattern data to ArrayBuffer (auto-detects G4/G6)
     * @param {Object} patternData - Pattern data object
     * @returns {ArrayBuffer} Encoded binary data
     */
    function encode(patternData) {
        const generation = patternData.generation || 'G6';

        if (generation === 'G6') {
            return encodeG6(patternData);
        } else {
            return encodeG4(patternData);
        }
    }

    /**
     * Encode pattern data to G6 V2 format
     *
     * V2 Header (18 bytes):
     *   Bytes 0-3:   "G6PT" magic
     *   Byte 4:      [VVVV][AAAA] - Version (4 bits = 2) + Arena ID upper 4 bits
     *   Byte 5:      [AA][OOOOOO] - Arena ID lower 2 bits + Observer ID (6 bits)
     *   Bytes 6-7:   num_frames (uint16 LE)
     *   Byte 8:      row_count (panel rows)
     *   Byte 9:      col_count (installed columns)
     *   Byte 10:     gs_val (1=GS2, 2=GS16)
     *   Bytes 11-16: panel_mask (6 bytes, 48-bit bitmask)
     *   Byte 17:     checksum (XOR of frame data)
     *
     * @param {Object} patternData - Pattern data object
     * @returns {ArrayBuffer} Encoded binary data
     */
    function encodeG6(patternData) {
        const {
            gs_val = 16,
            numFrames,
            rowCount,
            colCount,
            pixelRows,
            pixelCols,
            frames,
            stretchValues = [],
            arena_id = 0,
            observer_id = 0
        } = patternData;

        // Validate dimensions
        if (pixelRows !== rowCount * G6_PANEL_SIZE) {
            throw new Error(`pixelRows (${pixelRows}) must equal rowCount (${rowCount}) * ${G6_PANEL_SIZE}`);
        }
        if (pixelCols !== colCount * G6_PANEL_SIZE) {
            throw new Error(`pixelCols (${pixelCols}) must equal colCount (${colCount}) * ${G6_PANEL_SIZE}`);
        }

        const isGrayscale = gs_val === 16;
        const panelBytes = isGrayscale ? G6_GS16_PANEL_BYTES : G6_GS2_PANEL_BYTES;
        const numPanels = rowCount * colCount;

        // Calculate total file size
        const frameDataSize = G6_FRAME_HEADER_SIZE + (numPanels * panelBytes);
        const totalSize = G6_HEADER_SIZE + (numFrames * frameDataSize);

        // Create buffer
        const buffer = new ArrayBuffer(totalSize);
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);

        // Write V2 header (18 bytes)
        // Magic bytes "G6PT"
        bytes[0] = 0x47;  // 'G'
        bytes[1] = 0x36;  // '6'
        bytes[2] = 0x50;  // 'P'
        bytes[3] = 0x54;  // 'T'

        // Byte 4: [VVVV][AAAA] - Version (4 bits = 2) + Arena ID upper 4 bits
        const version = 2;
        const clampedArenaId = Math.min(63, Math.max(0, arena_id));
        const clampedObserverId = Math.min(63, Math.max(0, observer_id));
        const arenaUpper = (clampedArenaId >> 2) & 0x0F;  // Upper 4 bits of 6-bit arena_id
        bytes[4] = (version << 4) | arenaUpper;

        // Byte 5: [AA][OOOOOO] - Arena ID lower 2 bits + Observer ID (6 bits)
        const arenaLower = clampedArenaId & 0x03;  // Lower 2 bits of arena_id
        bytes[5] = (arenaLower << 6) | (clampedObserverId & 0x3F);

        // Frame count (little-endian)
        view.setUint16(6, numFrames, true);

        // Row and column count
        bytes[8] = rowCount;
        bytes[9] = colCount;

        // GS mode (1=GS2, 2=GS16) - V2 puts this in byte 10
        bytes[10] = isGrayscale ? 2 : 1;

        // Panel mask (all panels active)
        const numPanelsTotal = rowCount * colCount;
        for (let i = 0; i < numPanelsTotal && i < 48; i++) {
            const byteIdx = Math.floor(i / 8);
            const bitIdx = i % 8;
            bytes[11 + byteIdx] |= (1 << bitIdx);
        }

        // Byte 17: checksum placeholder (will be computed after frame data)
        bytes[17] = 0;

        // Write frames
        let offset = G6_HEADER_SIZE;

        for (let f = 0; f < numFrames; f++) {
            const frame = frames[f];
            const stretch = stretchValues[f] !== undefined ? stretchValues[f] : 1;

            // Frame header "FR" + frame_idx (uint16 LE)
            bytes[offset] = 0x46;      // 'F'
            bytes[offset + 1] = 0x52;  // 'R'
            // Frame index as little-endian uint16
            bytes[offset + 2] = f & 0xFF;           // Low byte
            bytes[offset + 3] = (f >> 8) & 0xFF;    // High byte
            offset += G6_FRAME_HEADER_SIZE;

            // Encode panels in row-major order
            for (let panelRow = 0; panelRow < rowCount; panelRow++) {
                for (let panelCol = 0; panelCol < colCount; panelCol++) {
                    // Extract panel pixels from frame
                    const panelPixels = extractPanelPixels(
                        frame, pixelCols, pixelRows,
                        panelRow, panelCol, G6_PANEL_SIZE
                    );

                    // Encode panel block
                    const panelBlock = isGrayscale
                        ? encodeG6PanelGS16(panelPixels, stretch)
                        : encodeG6PanelGS2(panelPixels, stretch);

                    // Copy to buffer
                    bytes.set(panelBlock, offset);
                    offset += panelBytes;
                }
            }
        }

        // Compute checksum: XOR of all frame data bytes (after header)
        let checksum = 0;
        for (let i = G6_HEADER_SIZE; i < offset; i++) {
            checksum ^= bytes[i];
        }
        bytes[17] = checksum;

        return buffer;
    }

    /**
     * Extract pixels for a single panel from a frame
     * @param {Uint8Array} frame - Full frame pixel data
     * @param {number} frameCols - Frame width in pixels
     * @param {number} frameRows - Frame height in pixels
     * @param {number} panelRow - Panel row index (0 = bottom)
     * @param {number} panelCol - Panel column index
     * @param {number} panelSize - Panel size (20 for G6, 16 for G4)
     * @returns {Uint8Array} Panel pixels (panelSize x panelSize)
     */
    function extractPanelPixels(frame, frameCols, frameRows, panelRow, panelCol, panelSize) {
        const pixels = new Uint8Array(panelSize * panelSize);

        for (let py = 0; py < panelSize; py++) {
            for (let px = 0; px < panelSize; px++) {
                const globalRow = panelRow * panelSize + py;
                const globalCol = panelCol * panelSize + px;
                const frameIdx = globalRow * frameCols + globalCol;
                pixels[py * panelSize + px] = frame[frameIdx];
            }
        }

        return pixels;
    }

    /**
     * Encode a G6 panel to GS2 (binary) format
     *
     * Panel block: 53 bytes [header, cmd, 50 data bytes, stretch]
     * Data encoding: row-major, 1 bit per pixel, MSB first
     *
     * Row flip: Match parser's expectation - flip rows during encoding
     *
     * @param {Uint8Array} panelPixels - 400 pixels (20x20), row-major, row 0 = bottom
     * @param {number} stretch - Stretch value (default 1)
     * @returns {Uint8Array} 53-byte panel block
     */
    function encodeG6PanelGS2(panelPixels, stretch = 1) {
        const block = new Uint8Array(G6_GS2_PANEL_BYTES);

        // Header byte (panel address, typically 0)
        block[0] = 0x00;

        // Command byte
        block[1] = 0x00;

        // Data bytes: 50 bytes for 400 pixels (1 bit each, MSB first)
        const dataBytes = block.subarray(2, 52);

        for (let panelRow = 0; panelRow < G6_PANEL_SIZE; panelRow++) {
            for (let panelCol = 0; panelCol < G6_PANEL_SIZE; panelCol++) {
                // Flip rows to match encoder convention
                const inputRow = (G6_PANEL_SIZE - 1) - panelRow;
                const pixelVal = panelPixels[inputRow * G6_PANEL_SIZE + panelCol] > 0 ? 1 : 0;

                const pixelNum = panelRow * G6_PANEL_SIZE + panelCol;
                const byteIdx = Math.floor(pixelNum / 8);
                const bitPos = 7 - (pixelNum % 8);  // MSB first

                if (pixelVal) {
                    dataBytes[byteIdx] |= (1 << bitPos);
                }
            }
        }

        // Stretch byte
        block[52] = stretch;

        return block;
    }

    /**
     * Encode a G6 panel to GS16 (grayscale) format
     *
     * Panel block: 203 bytes [header, cmd, 200 data bytes, stretch]
     * Data encoding: row-major, 4 bits per pixel (2 pixels per byte)
     *   - Even pixel: high nibble
     *   - Odd pixel: low nibble
     *
     * @param {Uint8Array} panelPixels - 400 pixels (20x20), row-major, row 0 = bottom
     * @param {number} stretch - Stretch value (default 1)
     * @returns {Uint8Array} 203-byte panel block
     */
    function encodeG6PanelGS16(panelPixels, stretch = 1) {
        const block = new Uint8Array(G6_GS16_PANEL_BYTES);

        // Header byte
        block[0] = 0x00;

        // Command byte
        block[1] = 0x00;

        // Data bytes: 200 bytes for 400 pixels (4 bits each)
        const dataBytes = block.subarray(2, 202);

        for (let panelRow = 0; panelRow < G6_PANEL_SIZE; panelRow++) {
            for (let panelCol = 0; panelCol < G6_PANEL_SIZE; panelCol++) {
                // Flip rows to match encoder convention
                const inputRow = (G6_PANEL_SIZE - 1) - panelRow;
                const pixelVal = Math.min(15, Math.max(0, panelPixels[inputRow * G6_PANEL_SIZE + panelCol]));

                const pixelNum = panelRow * G6_PANEL_SIZE + panelCol;
                const byteIdx = Math.floor(pixelNum / 2);

                if (pixelNum % 2 === 0) {
                    // Even pixel -> high nibble
                    dataBytes[byteIdx] |= (pixelVal << 4);
                } else {
                    // Odd pixel -> low nibble
                    dataBytes[byteIdx] |= pixelVal;
                }
            }
        }

        // Stretch byte
        block[202] = stretch;

        return block;
    }

    /**
     * Encode pattern data to G4 V2 format
     *
     * V2 Header (7 bytes):
     *   Bytes 0-1:   NumPatsX (uint16 LE)
     *   Byte 2:      [V][GGG][RRRR] - Version flag + Generation ID + Reserved
     *   Byte 3:      Arena ID (8 bits, 0-255)
     *   Byte 4:      gs_val (2 or 16)
     *   Byte 5:      RowN (panel rows)
     *   Byte 6:      ColN (panel cols)
     *
     * @param {Object} patternData - Pattern data object
     * @returns {ArrayBuffer} Encoded binary data
     */
    function encodeG4(patternData) {
        const {
            gs_val = 16,
            numFrames,
            numPatsX = numFrames,
            numPatsY = 1,
            rowCount,
            colCount,
            pixelRows,
            pixelCols,
            frames,
            stretchValues = [],
            generation = 'G4',
            generation_id,
            arena_id = 0
        } = patternData;

        // Validate dimensions
        if (pixelRows !== rowCount * G4_PANEL_SIZE) {
            throw new Error(`pixelRows (${pixelRows}) must equal rowCount (${rowCount}) * ${G4_PANEL_SIZE}`);
        }
        if (pixelCols !== colCount * G4_PANEL_SIZE) {
            throw new Error(`pixelCols (${pixelCols}) must equal colCount (${colCount}) * ${G4_PANEL_SIZE}`);
        }

        const isGrayscale = gs_val === 16;
        const numSubpanel = 4;
        const subpanelMsgLength = isGrayscale ? 33 : 9;
        const frameBytes = (colCount * subpanelMsgLength + 1) * rowCount * numSubpanel;

        // Calculate total file size
        const totalSize = G4_HEADER_SIZE + (numFrames * frameBytes);

        // Create buffer
        const buffer = new ArrayBuffer(totalSize);
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);

        // Write V2 header
        view.setUint16(0, numPatsX, true);  // little-endian

        // Byte 2: [V][GGG][RRRR] - V2 flag + generation ID
        // Resolve generation_id: use explicit value, or look up from generation name
        const genId = generation_id !== undefined ? generation_id
            : (GENERATION_IDS[generation] || 0);
        const v2Flag = 0x80;  // Set MSB (bit 7)
        const genBits = (genId & 0x07) << 4;  // Bits 6-4
        bytes[2] = v2Flag | genBits;

        // Byte 3: Arena config ID
        bytes[3] = Math.min(255, Math.max(0, arena_id));

        bytes[4] = isGrayscale ? 16 : 2;    // gs_val (use normalized values: 2 or 16)
        bytes[5] = rowCount;
        bytes[6] = colCount;

        // Write frames
        let offset = G4_HEADER_SIZE;

        for (let f = 0; f < numFrames; f++) {
            const frame = frames[f];
            const stretch = stretchValues[f] !== undefined ? stretchValues[f] : 1;

            const frameData = encodeG4Frame(frame, rowCount, colCount, pixelCols, isGrayscale, stretch);
            bytes.set(frameData, offset);
            offset += frameBytes;
        }

        return buffer;
    }

    /**
     * Encode a G4 frame with subpanel addressing
     */
    function encodeG4Frame(frame, panelRows, panelCols, frameCols, isGrayscale, stretch) {
        const numSubpanel = 4;
        const subpanelMsgLength = isGrayscale ? 33 : 9;
        const frameBytes = (panelCols * subpanelMsgLength + 1) * panelRows * numSubpanel;
        const frameData = new Uint8Array(frameBytes);

        let n = 0;

        for (let i = 0; i < panelRows; i++) {
            for (let j = 1; j <= numSubpanel; j++) {
                // Row header: 1-based panel row index (matches MATLAB encoder)
                frameData[n++] = i + 1;

                for (let k = 1; k <= subpanelMsgLength; k++) {
                    for (let m = 0; m < panelCols; m++) {
                        if (k === 1) {
                            // Command byte: bit 0 = GS16 flag, bits 1+ = stretch
                            frameData[n++] = (isGrayscale ? 1 : 0) | (stretch << 1);
                        } else {
                            if (isGrayscale) {
                                // GS16: 2 pixels per byte
                                const panelStartRowBeforeInvert = i * 16 + ((j - 1) % 2) * 8 + Math.floor((k - 2) / 4);
                                const panelStartRow = Math.floor(panelStartRowBeforeInvert / 16) * 16 + 15 - (panelStartRowBeforeInvert % 16);
                                const panelStartCol = m * 16 + Math.floor(j / 3) * 8 + ((k - 2) % 4) * 2;

                                const px1 = getPixelSafe(frame, panelStartRow, panelStartCol, frameCols);
                                const px2 = getPixelSafe(frame, panelStartRow, panelStartCol + 1, frameCols);

                                // Low nibble = left pixel, high nibble = right pixel
                                frameData[n++] = (px1 & 0x0F) | ((px2 & 0x0F) << 4);
                            } else {
                                // Binary: 8 pixels per byte
                                const rowOffset = k - 2;
                                const panelStartRowBeforeInvert = i * 16 + ((j - 1) % 2) * 8 + rowOffset;
                                const panelStartRow = Math.floor(panelStartRowBeforeInvert / 16) * 16 + 15 - (panelStartRowBeforeInvert % 16);
                                const panelStartCol = m * 16 + Math.floor(j / 3) * 8;

                                let byteVal = 0;
                                for (let p = 0; p < 8; p++) {
                                    const pixelVal = getPixelSafe(frame, panelStartRow, panelStartCol + p, frameCols);
                                    if (pixelVal > 0) {
                                        byteVal |= (1 << p);
                                    }
                                }
                                frameData[n++] = byteVal;
                            }
                        }
                    }
                }
            }
        }

        return frameData;
    }

    /**
     * Get pixel value safely (returns 0 if out of bounds)
     */
    function getPixelSafe(frame, row, col, frameCols) {
        const frameRows = frame.length / frameCols;
        if (row < 0 || row >= frameRows || col < 0 || col >= frameCols) {
            return 0;
        }
        return frame[row * frameCols + col];
    }

    /**
     * Trigger file download of encoded pattern
     * @param {Object} patternData - Pattern data object
     * @param {string} filename - Output filename (should end with .pat)
     */
    function downloadPattern(patternData, filename) {
        const buffer = encode(patternData);
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'pattern.pat';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Compare two ArrayBuffers for equality
     * @param {ArrayBuffer} a - First buffer
     * @param {ArrayBuffer} b - Second buffer
     * @returns {{equal: boolean, differences: Array}} Comparison result
     */
    function compareBuffers(a, b) {
        const bytesA = new Uint8Array(a);
        const bytesB = new Uint8Array(b);
        const differences = [];

        if (bytesA.length !== bytesB.length) {
            return {
                equal: false,
                differences: [{
                    type: 'length',
                    a: bytesA.length,
                    b: bytesB.length
                }]
            };
        }

        for (let i = 0; i < bytesA.length; i++) {
            if (bytesA[i] !== bytesB[i]) {
                differences.push({
                    offset: i,
                    a: bytesA[i],
                    b: bytesB[i],
                    aHex: '0x' + bytesA[i].toString(16).padStart(2, '0').toUpperCase(),
                    bHex: '0x' + bytesB[i].toString(16).padStart(2, '0').toUpperCase()
                });
            }
        }

        return {
            equal: differences.length === 0,
            differences
        };
    }

    // Public API
    const api = {
        // Core encoding
        encode,
        encodeG6,
        encodeG4,

        // Panel encoding (for testing)
        encodeG6PanelGS2,
        encodeG6PanelGS16,
        encodeG4Frame,
        extractPanelPixels,

        // Utilities
        downloadPattern,
        compareBuffers,

        // Constants
        G6_PANEL_SIZE,
        G4_PANEL_SIZE,
        G6_GS2_PANEL_BYTES,
        G6_GS16_PANEL_BYTES,
        G6_HEADER_SIZE,
        G4_HEADER_SIZE
    };

    return api;
})();

// Export for Node.js (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PatEncoder;
}

// Export for browser (global)
if (typeof window !== 'undefined') {
    window.PatEncoder = PatEncoder;
}
