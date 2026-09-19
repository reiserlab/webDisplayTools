#!/usr/bin/env node
/**
 * make-stress-patterns.js — generate the LARGE G6 2×10 patterns the SD-stall soak campaign needs
 * (docs/development/sd-stall-causal-test-plan-2026-09-13.md §7). Pure Node (pixi run node), uses
 * js/pat-encoder.js, verifies each file by re-parsing it with js/pat-parser.js.
 *
 *   pixi run node scripts/make-stress-patterns.js [--out DIR] [--frames N] [--only sine|bar]
 *
 * Writes (default DIR = ./soak-patterns, git-ignored):
 *   sine_<N>f_gs16.pat   N frames (default 2000 → ≈ 8 MB), GS16, 40-px sine grating rolling +1 px/frame
 *                        (a 200-px roll period: 2000 frames = 10 full turns; every frame is a distinct read).
 *   bar_<N>f_gs2.pat     N frames (default 200 → ≈ 213 KB), GS2, one 8-px bright bar rolling +1 px/frame
 *                        (1 KB frames: the small-read control; only made when N ≤ 200 or --only bar).
 *
 * Upload through the Studio Console (SD upload) so the file is written in one pass (contiguous — the
 * firmware's sd_layout record must say bit0 = 1 for the trial to be comparable). The Studio registers the
 * uploaded bytes for the preview, which is where the closed-loop resolver reads the frame count.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PatEncoder = require('../js/pat-encoder.js');
const PatParserMod = require('../js/pat-parser.js');
const PatParser = PatParserMod.default || PatParserMod; // ES default export under Node's require(esm)

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const outDir = opt('--out', './soak-patterns');
const frames = parseInt(opt('--frames', ''), 10);
const only = opt('--only', '');

const ARENA = { rowCount: 2, colCount: 10, pixelRows: 40, pixelCols: 200, arena_id: 1 }; // G6_2x10 (registry id 1)

function makePattern({ name, numFrames, gs, pixelFn }) {
    const { pixelRows, pixelCols } = ARENA;
    const out = [];
    for (let f = 0; f < numFrames; f++) {
        const frame = new Uint8Array(pixelRows * pixelCols);
        for (let r = 0; r < pixelRows; r++)
            for (let c = 0; c < pixelCols; c++) frame[r * pixelCols + c] = pixelFn(f, r, c);
        out.push(frame);
    }
    const patternData = {
        generation: 'G6',
        gs_val: gs,
        numFrames,
        rowCount: ARENA.rowCount,
        colCount: ARENA.colCount,
        pixelRows,
        pixelCols,
        frames: out,
        stretchValues: [],
        arena_id: ARENA.arena_id,
        observer_id: 0
    };
    const buf = Buffer.from(PatEncoder.encode(patternData));
    const parsed = PatParser.parsePatFile(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    );
    if (parsed.numFrames !== numFrames || parsed.generation !== 'G6')
        throw new Error(
            `${name}: re-parse mismatch (${parsed.numFrames} frames, ${parsed.generation})`
        );
    const file = path.join(outDir, `${name}.pat`);
    fs.writeFileSync(file, buf);
    const perFrame = (buf.length - 18) / numFrames;
    console.log(
        `${file}: ${numFrames} frames, GS${gs}, ${(buf.length / 1024).toFixed(0)} KB (${perFrame.toFixed(0)} B/frame), re-parse OK`
    );
    return file;
}

fs.mkdirSync(outDir, { recursive: true });
const wl = 40; // px
if (!only || only === 'sine') {
    const n = Number.isFinite(frames) && frames > 0 ? frames : 2000;
    makePattern({
        name: `sine_${n}f_gs16`,
        numFrames: n,
        gs: 16,
        pixelFn: (f, r, c) => Math.round(7.5 + 7.5 * Math.sin((2 * Math.PI * (c + f)) / wl))
    });
}
if (!only || only === 'bar') {
    const n = Number.isFinite(frames) && frames > 0 ? Math.min(frames, 200) : 200;
    makePattern({
        name: `bar_${n}f_gs2`,
        numFrames: n,
        gs: 2,
        pixelFn: (f, r, c) => ((((c - f) % 200) + 200) % 200 < 8 ? 1 : 0)
    });
}
