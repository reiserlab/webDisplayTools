/**
 * test-bin-classifier.js — Node checks for js/bin-classifier.js.
 *
 * The classifier is pure (bytes in → stream-frame bodies out), so it runs in
 * Node with no browser. Mirrors the size map in Arena-Firmware/scripts/web-serial.
 *
 *   node tests/test-bin-classifier.js
 */
'use strict';

const Bin = require('../js/bin-classifier.js');

let pass = 0;
let fail = 0;
function check(name, cond) {
    if (cond) {
        pass++;
    } else {
        fail++;
        console.log('  FAIL: ' + name);
    }
}

const { NUM_PANELS, GS2_BLOCK, GS16_BLOCK, FRAME_PREFIX } = Bin;
const GS2_FRAME = FRAME_PREFIX + GS2_BLOCK * NUM_PANELS; // 1064
const GS16_FRAME = FRAME_PREFIX + GS16_BLOCK * NUM_PANELS; // 4064

// ── constants ────────────────────────────────────────────────────────────
check('NUM_PANELS = 20', NUM_PANELS === 20);
check('GS2 frame = 1064', GS2_FRAME === 1064);
check('GS16 frame = 4064', GS16_FRAME === 4064);

// ── classifyBin: every accepted raw size → a 1064/4064 body ───────────────
const cases = [
    [50, false, 1064],
    [200, true, 4064],
    [1000, false, 1064],
    [4000, true, 4064],
    [53, false, 1064],
    [203, true, 4064],
    [1060, false, 1064],
    [4060, true, 4064],
    [1064, false, 1064],
    [4064, true, 4064]
];
for (const [size, gs16, frameLen] of cases) {
    const res = Bin.classifyBin(new Uint8Array(size), 128);
    check(`classifyBin(${size}) returns a result`, res != null);
    if (res) {
        check(`classifyBin(${size}).gs16 = ${gs16}`, res.gs16 === gs16);
        check(`classifyBin(${size}).body length = ${frameLen}`, res.body.length === frameLen);
    }
}
check('classifyBin(unknown size) = null', Bin.classifyBin(new Uint8Array(123), 128) === null);

// ── duty byte lands in the last byte of each panel block ──────────────────
{
    const res = Bin.classifyBin(new Uint8Array(50), 0x7f); // single GS2 panel, replicated
    // block 0 starts after the 4-byte FR prefix; its last byte is the duty_cycle.
    check('duty byte written to block tail', res.body[FRAME_PREFIX + GS2_BLOCK - 1] === 0x7f);
    // header byte parity makes the low 7 bits = version 1.
    check('block header version bits = 1', (res.body[FRAME_PREFIX] & 0x7f) === 0x01);
}

// ── isPat ─────────────────────────────────────────────────────────────────
const patHeader = (rows, cols, gsVal, numFrames) => {
    const h = new Uint8Array(18);
    h[0] = 0x47;
    h[1] = 0x36;
    h[2] = 0x50;
    h[3] = 0x54; // "G6PT"
    h[6] = numFrames & 0xff;
    h[7] = (numFrames >> 8) & 0xff; // frames LE16
    h[8] = rows;
    h[9] = cols;
    h[10] = gsVal; // rows, cols, gs_val
    return h;
};
check('isPat true for G6PT', Bin.isPat(patHeader(2, 10, 2, 1)));
check('isPat false for raw bin', Bin.isPat(new Uint8Array(1064)) === false);
check('isPat false when too short', Bin.isPat(new Uint8Array([0x47, 0x36])) === false);

// ── patFrameBodies: 20-panel GS16, 3 frames → 3 bodies of 4064 B ──────────
{
    const rows = 2;
    const cols = 10;
    const numFrames = 3;
    const blockLen = GS16_BLOCK;
    const bodyLen = FRAME_PREFIX + rows * cols * blockLen; // 4064
    const stride = bodyLen + 2; // + CRC-16
    const buf = new Uint8Array(18 + numFrames * stride);
    buf.set(patHeader(rows, cols, 2, numFrames), 0);
    // stamp each frame's FR prefix so we can confirm the slice offsets
    for (let f = 0; f < numFrames; f++) {
        const off = 18 + f * stride;
        buf[off] = 0x46;
        buf[off + 1] = 0x52; // "FR"
        buf[off + 2] = f; // index lo — used as a slice-offset marker
    }
    const { gs16, numPanels, bodies } = Bin.patFrameBodies(buf);
    check('patFrameBodies gs16 = true', gs16 === true);
    check('patFrameBodies numPanels = 20', numPanels === 20);
    check('patFrameBodies frame count = 3', bodies.length === 3);
    check(
        'each body is 4064 B',
        bodies.every((b) => b.length === bodyLen)
    );
    check(
        'bodies sliced at the right offsets',
        bodies.every((b, f) => b[2] === f)
    );
    check('CRC-16 trailer excluded from bodies', bodies[0].length === stride - 2);
}

// ── patFrameBodies: GS2, single frame ─────────────────────────────────────
{
    const bodyLen = FRAME_PREFIX + 20 * GS2_BLOCK; // 1064
    const buf = new Uint8Array(18 + bodyLen + 2);
    buf.set(patHeader(2, 10, 1, 1), 0); // gs_val 1 = GS2
    const { gs16, numPanels, bodies } = Bin.patFrameBodies(buf);
    check('GS2 .pat gs16 = false', gs16 === false);
    check('GS2 .pat one 1064-byte body', bodies.length === 1 && bodies[0].length === 1064);
    check('GS2 .pat numPanels = 20', numPanels === 20);
}

console.log(`\nbin-classifier: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
