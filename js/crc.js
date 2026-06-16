/**
 * G6 pattern-file CRC helpers — canonical source-of-truth.
 *
 * - CRC-8/AUTOSAR — header byte 17 (poly 0x2F, init 0xFF, xorout 0xFF, no reflection)
 * - CRC-16/CCITT-FALSE — per-frame trailer (poly 0x1021, init 0xFFFF, xorout 0x0000)
 *
 * LUTs are built once from the polynomial constants. The module runs the
 * universal-check vectors at load time and THROWS on mismatch — that's the
 * gate that catches LUT-construction bugs before any encoder/parser runs.
 *
 * IMPORTANT (sync pointer): pat-encoder.js and pat-parser.js carry inlined
 * COPIES of the same LUT-builder + helpers, kept identical to this file by
 * convention. The inlining works around Node's ESM/CJS interop friction when
 * pat-parser.js is loaded as ESM via `import` from pattern_editor.html. This
 * file remains the canonical reference and is the version consumed by the
 * test scripts (tests/test-crc.js, tests/verify-pat-crc.js). If you change
 * the polynomial constants or LUT logic here, mirror the change to both
 * inlined copies and rerun `node tests/test-crc.js`.
 *
 * Spec: Modular-LED-Display/docs/development/g6_01-panel-protocol.md § CRC-8 algorithm
 *       Modular-LED-Display/docs/development/g6_04-pattern-file-format.md § Frame Format
 *
 * Browser-global + Node CommonJS export. No ES module export — to avoid the
 * dual-format trap, callers in the browser load via `<script src=>` and read
 * `window.G6CRC`; Node callers use `require('./crc.js')`.
 */

const G6CRC = (function () {
    'use strict';

    const CRC8_AUTOSAR_POLY = 0x2f;
    const CRC8_AUTOSAR_INIT = 0xff;
    const CRC8_AUTOSAR_XOROUT = 0xff;

    const CRC16_CCITT_FALSE_POLY = 0x1021;
    const CRC16_CCITT_FALSE_INIT = 0xffff;
    const CRC16_CCITT_FALSE_XOROUT = 0x0000;

    function buildCrc8Lut(poly) {
        const lut = new Uint8Array(256);
        for (let b = 0; b < 256; b++) {
            let crc = b;
            for (let i = 0; i < 8; i++) {
                crc = crc & 0x80 ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
            }
            lut[b] = crc;
        }
        return lut;
    }

    function buildCrc16Lut(poly) {
        const lut = new Uint16Array(256);
        for (let b = 0; b < 256; b++) {
            let crc = b << 8;
            for (let i = 0; i < 8; i++) {
                crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
            }
            lut[b] = crc;
        }
        return lut;
    }

    const CRC8_LUT = buildCrc8Lut(CRC8_AUTOSAR_POLY);
    const CRC16_LUT = buildCrc16Lut(CRC16_CCITT_FALSE_POLY);

    function crc8Autosar(bytes) {
        let c = CRC8_AUTOSAR_INIT;
        for (let i = 0; i < bytes.length; i++) {
            c = CRC8_LUT[(c ^ bytes[i]) & 0xff];
        }
        return c ^ CRC8_AUTOSAR_XOROUT;
    }

    function crc16CcittFalse(bytes) {
        let c = CRC16_CCITT_FALSE_INIT;
        for (let i = 0; i < bytes.length; i++) {
            c = ((c << 8) ^ CRC16_LUT[((c >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
        }
        return c ^ CRC16_CCITT_FALSE_XOROUT;
    }

    const UNIVERSAL_INPUT = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]); // "123456789"

    const crc8Check = crc8Autosar(UNIVERSAL_INPUT);
    if (crc8Check !== 0xdf) {
        throw new Error(
            'CRC-8/AUTOSAR universal check failed: got 0x' +
                crc8Check.toString(16).padStart(2, '0') +
                ', expected 0xDF'
        );
    }

    const crc16Check = crc16CcittFalse(UNIVERSAL_INPUT);
    if (crc16Check !== 0x29b1) {
        throw new Error(
            'CRC-16/CCITT-FALSE universal check failed: got 0x' +
                crc16Check.toString(16).padStart(4, '0') +
                ', expected 0x29B1'
        );
    }

    return {
        crc8Autosar,
        crc16CcittFalse,
        CRC8_AUTOSAR_POLY,
        CRC8_AUTOSAR_INIT,
        CRC8_AUTOSAR_XOROUT,
        CRC16_CCITT_FALSE_POLY,
        CRC16_CCITT_FALSE_INIT,
        CRC16_CCITT_FALSE_XOROUT
    };
})();

// Export for Node.js (CommonJS) — used by tests/generate-roundtrip-patterns.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = G6CRC;
}

// Export for browser (global) — used by <script src=> callers and by
// pat-encoder.js / pat-parser.js which read window.G6CRC. Browser ES-module
// callers can `import G6CRC from './crc.js'` (Node CJS interop returns the
// module.exports object; in browsers, dynamic import resolves the same way).
if (typeof window !== 'undefined') {
    window.G6CRC = G6CRC;
}
