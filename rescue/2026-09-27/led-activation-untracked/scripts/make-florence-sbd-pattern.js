#!/usr/bin/env node
/**
 * make-florence-sbd-pattern.js — the "SBD" panorama of T.J. Florence's Ch. 2 place-learning
 * task (stripes | bars | diagonals, three 120° sectors) rebuilt for the G6 2×10 arena as a
 * 200-frame closed-loop pattern: frame f = the panorama rolled by f pixels, so frame index =
 * heading / 1.8° (gain 1.8, world-stable — the course convention).
 *
 *   pixi run node scripts/make-florence-sbd-pattern.js [--out DIR] [--level 0-15] [--roll +1|-1] [--front180]
 *
 * Source bitmap: the reconstruction in Matlab_work/TJ_review/fig2/single_fly_std.m L50–56 (the
 * original makePatternStructSBD.m is missing), a 32-row × 96-column logical image at 3.75°/px:
 *   stripes = [ones(8,32); zeros(8,32); ones(8,32); zeros(8,32)]            horizontal stripes
 *   bars    = fliplr(repmat([zeros(32,8) ones(32,8)], [1 2]))              vertical bars
 *   diag    = stripes with column ii circshifted down by ii-1 rows         45° diagonals
 *   sbd     = circshift([stripes bars diag], [0 -16])
 * Re-indexed so the column increases with the closed-loop heading th (notes §3):
 *   sbd_th(:, k) = sbd(:, mod(48 - k, 96) + 1), k = 0..95  → th 0–120° bars, 120–240° stripes,
 *   240–360° diagonals; the bars/diagonal seam (Position A cool-zone centre) is at th = 0 = frame 0.
 * Resampled 96×32 → 200×40 by nearest neighbour in ANGLE space (3.75° → 1.8° both axes), MATLAB row 1
 * (image top) → arena top row. Lit pixels = --level (default 5 = the course P3 bar brightness), GS16.
 * See protocols/drafts/florence_ch2_az_PL_protocol_summary.md §3 for the provenance of every choice.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const PatEncoder = require('../js/pat-encoder.js');
const PatParserMod = require('../js/pat-parser.js');
const PatParser = PatParserMod.default || PatParserMod;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const outDir = opt('--out', './protocols/drafts/florence_ch2_fig2-1_2-2_patterns');
const level = Math.max(1, Math.min(15, parseInt(opt('--level', '5'), 10)));
const roll = parseInt(opt('--roll', '1'), 10) >= 0 ? 1 : -1;
const front180 = args.includes('--front180');

const ARENA = { rowCount: 2, colCount: 10, pixelRows: 40, pixelCols: 200, arena_id: 1 };
const SRC_ROWS = 32;
const SRC_COLS = 96;

// ---- source bitmap (0-based, row 0 = MATLAB row 1 = image top) ------------------------------
const stripesAt = (m) => (Math.floor(m / 8) % 2 === 0 ? 1 : 0); // rows 1-8 on, 9-16 off, ...
const sbd = Array.from({ length: SRC_ROWS }, () => new Array(SRC_COLS).fill(0));
for (let m = 0; m < SRC_ROWS; m++) {
    for (let j = 0; j < 32; j++) {
        sbd[m][j] = stripesAt(m); // sector 1: horizontal stripes
        sbd[m][32 + j] = Math.floor(j / 8) % 2 === 0 ? 1 : 0; // sector 2: bars (fliplr → cols 1-8 lit)
        sbd[m][64 + j] = stripesAt((((m - j) % SRC_ROWS) + SRC_ROWS) % SRC_ROWS); // sector 3: diagonals
    }
}
// circshift(sbd, [0 -16]) then re-index to th: sbd_th[k] = sbd2[(48 - k) mod 96]
const sbd2 = sbd.map((row) => row.map((_, j) => row[(j + 16) % SRC_COLS]));
const sbdTh = sbd2.map((row) =>
    row.map((_, k) => row[(((48 - k) % SRC_COLS) + SRC_COLS) % SRC_COLS])
);

// ---- resample to 200 × 40 (nearest neighbour in angle space) --------------------------------
const base = [];
for (let r = 0; r < ARENA.pixelRows; r++) {
    // pattern row 0 is the arena BOTTOM; MATLAB row 0 is the image top
    const srcRow = SRC_ROWS - 1 - Math.floor((r * SRC_ROWS) / ARENA.pixelRows);
    const row = new Uint8Array(ARENA.pixelCols);
    for (let c = 0; c < ARENA.pixelCols; c++) {
        const srcCol = Math.floor((c * SRC_COLS) / ARENA.pixelCols);
        row[c] = sbdTh[srcRow][srcCol] ? level : 0;
    }
    base.push(row);
}

// ---- frames: frame f = panorama rolled by roll*f columns -------------------------------------
const numFrames = ARENA.pixelCols;
const frames = [];
for (let f = 0; f < numFrames; f++) {
    const frame = new Uint8Array(ARENA.pixelRows * ARENA.pixelCols);
    for (let r = 0; r < ARENA.pixelRows; r++) {
        for (let c = 0; c < ARENA.pixelCols; c++) {
            let v =
                base[r][(((c - roll * f) % ARENA.pixelCols) + ARENA.pixelCols) % ARENA.pixelCols];
            // --front180: only the 180° in front of the fly is lit (columns 50..149 are the rear
            // half if column 100 is directly behind the fly — a placeholder geometry, see Q4)
            if (front180 && c >= 50 && c < 150) v = 0;
            frame[r * ARENA.pixelCols + c] = v;
        }
    }
    frames.push(frame);
}

const name = front180 ? 'G6_2x10_florence_sbd_front180_v1' : 'G6_2x10_florence_sbd_v1';
const patternData = {
    generation: 'G6',
    gs_val: 16,
    numFrames,
    rowCount: ARENA.rowCount,
    colCount: ARENA.colCount,
    pixelRows: ARENA.pixelRows,
    pixelCols: ARENA.pixelCols,
    frames,
    stretchValues: [],
    arena_id: ARENA.arena_id,
    observer_id: 0
};
const buf = Buffer.from(PatEncoder.encode(patternData));
const parsed = PatParser.parsePatFile(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
);
if (parsed.numFrames !== numFrames || parsed.generation !== 'G6')
    throw new Error(`re-parse mismatch (${parsed.numFrames} frames, ${parsed.generation})`);
// frame-roll self-check: frame 1 must equal frame 0 rolled by `roll`
for (let r = 0; r < ARENA.pixelRows; r++)
    for (let c = 0; c < ARENA.pixelCols; c++) {
        const a = parsed.frames[1][r * ARENA.pixelCols + c];
        const b = parsed.frames[0][r * ARENA.pixelCols + ((((c - roll) % 200) + 200) % 200)];
        if (a !== b) throw new Error('roll self-check failed at r=' + r + ' c=' + c);
    }
fs.mkdirSync(outDir, { recursive: true });
const patFile = path.join(outDir, `${name}.pat`);
fs.writeFileSync(patFile, buf);

// ---- PNG preview of frame 0 (×4, arena top at the image top) ---------------------------------
function crc32(b) {
    let c,
        crc = 0xffffffff;
    for (let n = 0; n < b.length; n++) {
        c = (crc ^ b[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function writePng(file, frame, scale) {
    const W = ARENA.pixelCols * scale;
    const H = ARENA.pixelRows * scale;
    const raw = Buffer.alloc((W + 1) * H);
    for (let y = 0; y < H; y++) {
        raw[y * (W + 1)] = 0;
        const r = ARENA.pixelRows - 1 - Math.floor(y / scale); // row 0 (bottom) drawn last
        for (let x = 0; x < W; x++) {
            const v = frame[r * ARENA.pixelCols + Math.floor(x / scale)];
            raw[y * (W + 1) + 1 + x] = Math.round((v / 15) * 255);
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 0; // grayscale
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]);
    fs.writeFileSync(file, png);
}
const pngFile = path.join(outDir, `${name}_frame0.png`);
writePng(pngFile, parsed.frames[0], 4);

console.log(
    `${patFile}: ${numFrames} frames, GS16, lit=${level}, roll=${roll > 0 ? '+1' : '-1'} px/frame, ${(buf.length / 1024).toFixed(0)} KB, re-parse + roll check OK`
);
console.log(`${pngFile}: frame 0 preview (x4)`);
// sector report: which texture sits at th = 0 / 120 / 240 (columns 0 / 67 / 134)
const tex = (c) => {
    const col = base.map((row) => row[c]);
    const lit = col.filter((v) => v).length;
    return lit === ARENA.pixelRows ? 'bar-lit' : lit === 0 ? 'bar-dark/gap' : 'striped';
};
console.log(
    `frame 0: col 0 ${tex(0)}, col 33 ${tex(33)}, col 67 ${tex(67)}, col 100 ${tex(100)}, col 134 ${tex(134)}, col 167 ${tex(167)}`
);
