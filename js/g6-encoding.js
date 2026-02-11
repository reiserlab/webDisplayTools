/**
 * G6 Panel Encoding Module
 *
 * Provides encoding/decoding functions for G6 20x20 LED panels.
 * Works in both Node.js and browser environments.
 *
 * Encoding Convention (matching MATLAB g6_encode_panel.m):
 * - Origin (0,0) at bottom-left of panel
 * - Row-major ordering: pixel_num = row_from_bottom * 20 + col
 * - GS2: 1 bit per pixel, MSB-first, 50 bytes total
 * - GS16: 4 bits per pixel, high nibble = even pixel, 200 bytes total
 *
 * Coordinate System:
 * - Panel coordinates: row 0 = bottom, row 19 = top; col 0 = left, col 19 = right
 * - Array indices: [row][col] where row 0 = bottom in panel coordinates
 * - For display (top-to-bottom), use displayRow = 19 - panelRow
 */

const G6Encoding = (function () {
    'use strict';

    const PANEL_SIZE = 20;
    const TOTAL_PIXELS = PANEL_SIZE * PANEL_SIZE; // 400
    const GS2_BYTES = 50;
    const GS16_BYTES = 200;

    /**
     * Convert panel coordinates (row, col) to linear pixel number
     * @param {number} row - Row in panel coordinates (0 = bottom, 19 = top)
     * @param {number} col - Column (0 = left, 19 = right)
     * @returns {number} Pixel number (0-399)
     */
    function pixelToIndex(row, col) {
        // Row-major ordering: pixel_num = row * 20 + col
        return row * PANEL_SIZE + col;
    }

    /**
     * Convert linear pixel number to panel coordinates
     * @param {number} pixelNum - Pixel number (0-399)
     * @returns {{row: number, col: number}} Panel coordinates
     */
    function indexToPixel(pixelNum) {
        return {
            row: Math.floor(pixelNum / PANEL_SIZE),
            col: pixelNum % PANEL_SIZE
        };
    }

    /**
     * Convert display row (0=top) to panel row (0=bottom)
     * For UI rendering where array index 0 is displayed at top
     * @param {number} displayRow - Display row (0 = top of screen)
     * @returns {number} Panel row (0 = bottom of panel)
     */
    function displayRowToPanelRow(displayRow) {
        return PANEL_SIZE - 1 - displayRow;
    }

    /**
     * Convert panel row (0=bottom) to display row (0=top)
     * @param {number} panelRow - Panel row (0 = bottom of panel)
     * @returns {number} Display row (0 = top of screen)
     */
    function panelRowToDisplayRow(panelRow) {
        return PANEL_SIZE - 1 - panelRow;
    }

    /**
     * Encode a 20x20 pixel array to GS2 (binary) format
     *
     * @param {number[][]} pixelArray - 20x20 array where [row][col], row 0 = bottom
     *                                  Values: 0 = off, non-zero = on
     * @returns {Uint8Array} 50 bytes of encoded data
     */
    function encodeGS2(pixelArray) {
        const bytes = new Uint8Array(GS2_BYTES);

        for (let row = 0; row < PANEL_SIZE; row++) {
            for (let col = 0; col < PANEL_SIZE; col++) {
                if (pixelArray[row][col] > 0) {
                    const pixelNum = pixelToIndex(row, col);
                    const byteIdx = Math.floor(pixelNum / 8);
                    const bitPos = 7 - (pixelNum % 8); // MSB-first
                    bytes[byteIdx] |= 1 << bitPos;
                }
            }
        }

        return bytes;
    }

    /**
     * Encode a 20x20 pixel array to GS16 (4-bit grayscale) format
     *
     * @param {number[][]} pixelArray - 20x20 array where [row][col], row 0 = bottom
     *                                  Values: 0-15 intensity levels
     * @returns {Uint8Array} 200 bytes of encoded data
     */
    function encodeGS16(pixelArray) {
        const bytes = new Uint8Array(GS16_BYTES);

        for (let row = 0; row < PANEL_SIZE; row++) {
            for (let col = 0; col < PANEL_SIZE; col++) {
                const val = Math.max(0, Math.min(15, pixelArray[row][col])); // Clamp to 0-15
                const pixelNum = pixelToIndex(row, col);
                const byteIdx = Math.floor(pixelNum / 2);

                if (pixelNum % 2 === 0) {
                    // Even pixel -> high nibble
                    bytes[byteIdx] |= val << 4;
                } else {
                    // Odd pixel -> low nibble
                    bytes[byteIdx] |= val;
                }
            }
        }

        return bytes;
    }

    /**
     * Decode GS2 bytes to a 20x20 pixel array
     *
     * @param {Uint8Array} bytes - 50 bytes of GS2 encoded data
     * @returns {number[][]} 20x20 array where [row][col], row 0 = bottom
     */
    function decodeGS2(bytes) {
        const pixelArray = Array(PANEL_SIZE)
            .fill(null)
            .map(() => Array(PANEL_SIZE).fill(0));

        for (let pixelNum = 0; pixelNum < TOTAL_PIXELS; pixelNum++) {
            const byteIdx = Math.floor(pixelNum / 8);
            const bitPos = 7 - (pixelNum % 8); // MSB-first

            if ((bytes[byteIdx] & (1 << bitPos)) !== 0) {
                const { row, col } = indexToPixel(pixelNum);
                pixelArray[row][col] = 1;
            }
        }

        return pixelArray;
    }

    /**
     * Decode GS16 bytes to a 20x20 pixel array
     *
     * @param {Uint8Array} bytes - 200 bytes of GS16 encoded data
     * @returns {number[][]} 20x20 array where [row][col], row 0 = bottom, values 0-15
     */
    function decodeGS16(bytes) {
        const pixelArray = Array(PANEL_SIZE)
            .fill(null)
            .map(() => Array(PANEL_SIZE).fill(0));

        for (let pixelNum = 0; pixelNum < TOTAL_PIXELS; pixelNum++) {
            const byteIdx = Math.floor(pixelNum / 2);
            let val;

            if (pixelNum % 2 === 0) {
                // Even pixel -> high nibble
                val = (bytes[byteIdx] >> 4) & 0x0f;
            } else {
                // Odd pixel -> low nibble
                val = bytes[byteIdx] & 0x0f;
            }

            const { row, col } = indexToPixel(pixelNum);
            pixelArray[row][col] = val;
        }

        return pixelArray;
    }

    /**
     * Encode pixel array from display orientation (row 0 = top)
     * This is a convenience function for UI code that stores pixels
     * with row 0 at the top of the display.
     *
     * @param {number[][]} displayArray - 20x20 array where [row][col], row 0 = TOP
     * @param {string} mode - 'GS2' or 'GS16'
     * @returns {Uint8Array} Encoded bytes
     */
    function encodeFromDisplay(displayArray, mode) {
        // Convert display orientation to panel orientation
        const panelArray = Array(PANEL_SIZE)
            .fill(null)
            .map(() => Array(PANEL_SIZE).fill(0));

        for (let displayRow = 0; displayRow < PANEL_SIZE; displayRow++) {
            const panelRow = displayRowToPanelRow(displayRow);
            for (let col = 0; col < PANEL_SIZE; col++) {
                panelArray[panelRow][col] = displayArray[displayRow][col];
            }
        }

        if (mode === 'GS2') {
            return encodeGS2(panelArray);
        } else if (mode === 'GS16') {
            return encodeGS16(panelArray);
        } else {
            throw new Error(`Unknown mode: ${mode}`);
        }
    }

    /**
     * Compare two byte arrays for equality
     * @param {Uint8Array} a - First array
     * @param {Uint8Array} b - Second array
     * @returns {boolean} True if arrays are equal
     */
    function bytesEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    /**
     * Compare encoded bytes against reference with detailed diff
     * @param {Uint8Array} computed - Computed bytes
     * @param {number[]} reference - Reference bytes (as array)
     * @returns {{pass: boolean, differences: Array}} Comparison result
     */
    function compareBytes(computed, reference) {
        const differences = [];
        const refBytes = new Uint8Array(reference);

        if (computed.length !== refBytes.length) {
            return {
                pass: false,
                differences: [
                    {
                        type: 'length',
                        computed: computed.length,
                        reference: refBytes.length
                    }
                ]
            };
        }

        for (let i = 0; i < computed.length; i++) {
            if (computed[i] !== refBytes[i]) {
                differences.push({
                    byteIndex: i,
                    computed: computed[i],
                    reference: refBytes[i],
                    computedHex: '0x' + computed[i].toString(16).toUpperCase().padStart(2, '0'),
                    referenceHex: '0x' + refBytes[i].toString(16).toUpperCase().padStart(2, '0')
                });
            }
        }

        return {
            pass: differences.length === 0,
            differences: differences
        };
    }

    /**
     * Create an empty 20x20 pixel array
     * @returns {number[][]} Array filled with zeros
     */
    function createEmptyArray() {
        return Array(PANEL_SIZE)
            .fill(null)
            .map(() => Array(PANEL_SIZE).fill(0));
    }

    /**
     * Create a filled 20x20 pixel array
     * @param {number} value - Value to fill (default 1 for GS2, 15 for GS16)
     * @returns {number[][]} Array filled with value
     */
    function createFilledArray(value = 1) {
        return Array(PANEL_SIZE)
            .fill(null)
            .map(() => Array(PANEL_SIZE).fill(value));
    }

    // Public API
    const api = {
        // Constants
        PANEL_SIZE,
        TOTAL_PIXELS,
        GS2_BYTES,
        GS16_BYTES,

        // Coordinate helpers
        pixelToIndex,
        indexToPixel,
        displayRowToPanelRow,
        panelRowToDisplayRow,

        // Encoding/Decoding
        encodeGS2,
        encodeGS16,
        decodeGS2,
        decodeGS16,
        encodeFromDisplay,

        // Utilities
        bytesEqual,
        compareBytes,
        createEmptyArray,
        createFilledArray
    };

    return api;
})();

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = G6Encoding;
}

// Export for browser
if (typeof window !== 'undefined') {
    window.G6Encoding = G6Encoding;
}
