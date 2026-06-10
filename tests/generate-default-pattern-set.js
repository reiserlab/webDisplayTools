#!/usr/bin/env node
/**
 * Generate the in-repo default pattern library for the G6_2x10 arena (LAB-92).
 *
 * Writes patterns/g6_2x10/ in the MATLAB SD convention (via js/pattern-set.js):
 *   patterns/g6_2x10/
 *     MANIFEST.bin   MANIFEST.txt   manifest.json   README.txt
 *     patterns/pat0001.pat pat0002.pat …
 *
 * This folder is BOTH a ready copy-to-SD bundle AND the "Built-in library" source
 * the Experiment Designer's Pattern Set builder fetches (relative ./patterns/g6_2x10/).
 * All patterns are encoded through PatEncoder (G6 duty defaults to 0x80), so they
 * render on hardware — no patch_duty.js. To grow the set, add a seed below (or drop
 * a .pat and re-run) and commit the regenerated folder.
 *
 * Usage:  node tests/generate-default-pattern-set.js
 */

const fs = require('fs');
const path = require('path');

const _pp = require('../js/pat-parser.js');
const PatParser = _pp.default || _pp;
const PatEncoder = require('../js/pat-encoder.js');
const arenaCfg = require('../js/arena-configs.js');
const PS = require('../js/pattern-set.js');

const ARENA = 'G6_2x10';
const ROWS = 2;
const COLS = 10;
const PANEL = 20;
const PIXEL_ROWS = ROWS * PANEL; // 40
const PIXEL_COLS = COLS * PANEL; // 200
const ARENA_ID = arenaCfg.getArenaId('G6', ARENA);

const OUT_DIR = path.join(__dirname, '..', 'patterns', 'g6_2x10');
const PAT_DIR = path.join(OUT_DIR, 'patterns');

// ── frame generators (mirror tests/generate-roundtrip-patterns.js) ─────────────
function allOn(pixelRows, pixelCols, maxVal) {
    return new Uint8Array(pixelRows * pixelCols).fill(maxVal);
}
function squareGrating(pixelRows, pixelCols, period, shift, maxVal) {
    const frame = new Uint8Array(pixelRows * pixelCols);
    for (let r = 0; r < pixelRows; r++) {
        for (let c = 0; c < pixelCols; c++) {
            const phase = (((c + shift) % period) + period) % period;
            frame[r * pixelCols + c] = phase < period / 2 ? maxVal : 0;
        }
    }
    return frame;
}
function sineGrating(pixelRows, pixelCols, period, shift, maxVal) {
    const frame = new Uint8Array(pixelRows * pixelCols);
    for (let r = 0; r < pixelRows; r++) {
        for (let c = 0; c < pixelCols; c++) {
            const v = Math.round(
                maxVal * (0.5 + 0.5 * Math.sin((2 * Math.PI * (c + shift)) / period))
            );
            frame[r * pixelCols + c] = Math.min(maxVal, Math.max(0, v));
        }
    }
    return frame;
}

// ── seed catalog (ordered → SD index order) ────────────────────────────────────
const SEEDS = [
    {
        name: 'all_on',
        gs_val: 2,
        maxVal: 1,
        numFrames: 1,
        build: () => [allOn(PIXEL_ROWS, PIXEL_COLS, 1)],
        description: 'All LEDs on (GS2, 1 frame) — connectivity / brightness check'
    },
    {
        name: 'grating_sq',
        gs_val: 2,
        maxVal: 1,
        numFrames: 20,
        build: () => {
            const frames = [];
            for (let f = 0; f < 20; f++)
                frames.push(squareGrating(PIXEL_ROWS, PIXEL_COLS, 20, f, 1));
            return frames;
        },
        description: 'Moving square-wave vertical grating (GS2, 20px period, 1px/frame)'
    },
    {
        name: 'grating_sine',
        gs_val: 16,
        maxVal: 15,
        numFrames: 20,
        build: () => {
            const frames = [];
            for (let f = 0; f < 20; f++)
                frames.push(sineGrating(PIXEL_ROWS, PIXEL_COLS, 40, f * 2, 15));
            return frames;
        },
        description: 'Moving sinusoidal vertical grating (GS16, 40px period, 2px/frame)'
    }
];

// ── encode each seed → bytes, ingest into a PatternSet ──────────────────────────
const deps = {
    parsePatFile: PatParser.parsePatFile,
    encode: PatEncoder.encode,
    getConfig: arenaCfg.getConfig
};

console.log('=== Default pattern library generator (' + ARENA + ') ===\n');

const set = PS.createPatternSet({ arenaConfig: ARENA });

for (const seed of SEEDS) {
    const frames = seed.build();
    const bytes = PatEncoder.encode({
        generation: 'G6',
        gs_val: seed.gs_val,
        numFrames: seed.numFrames,
        rowCount: ROWS,
        colCount: COLS,
        pixelRows: PIXEL_ROWS,
        pixelCols: PIXEL_COLS,
        frames: frames,
        stretchValues: [], // → encoder applies the 0x80 duty default
        arena_id: ARENA_ID,
        observer_id: 0
    });
    const item = PS.ingest(set, bytes, seed.name + '.pat', 'builtin', deps);
    if (!item.valid) {
        console.error('  FAIL: ' + seed.name + ' invalid: ' + item.reason);
        process.exit(1);
    }
    console.log('  staged ' + seed.name + '  (' + seed.description + ')');
}

// ── external authored .pat sources ──────────────────────────────────────────────
// Drop real .pat files (e.g. exported from the pattern editor) into
// patterns/<arena>/_sources/ and re-run: each is ingested in filename order (after
// the synthetic seeds), geometry-checked against the arena, and re-encoded so its
// duty becomes 0x80 — so a dim editor export (duty=1) ships at full brightness.
const SRC_DIR = path.join(OUT_DIR, '_sources');
if (fs.existsSync(SRC_DIR)) {
    const files = fs
        .readdirSync(SRC_DIR)
        .filter((f) => /\.pat$/i.test(f) && f[0] !== '.')
        .sort();
    for (const f of files) {
        const buf = fs.readFileSync(path.join(SRC_DIR, f));
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const item = PS.ingest(set, ab, f, 'builtin', deps);
        if (!item.valid) {
            console.error('  FAIL: external ' + f + ' invalid: ' + item.reason);
            process.exit(1);
        }
        console.log('  staged ' + item.name + '  (external: ' + f + ')');
    }
}

// ── build the bundle + write the SD-mirror folder ───────────────────────────────
const bundle = PS.buildBundle(set, { sdDrive: '(copy to the SD card root)' });

fs.mkdirSync(PAT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'MANIFEST.bin'), Buffer.from(bundle.manifestBin));
fs.writeFileSync(path.join(OUT_DIR, 'MANIFEST.txt'), bundle.manifestTxt);
fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(bundle.manifestJson, null, 2) + '\n'
);
fs.writeFileSync(path.join(OUT_DIR, 'README.txt'), bundle.readme);
for (const p of bundle.patterns) {
    fs.writeFileSync(path.join(PAT_DIR, p.name), Buffer.from(p.bytes));
}

console.log('\nWrote ' + path.relative(path.join(__dirname, '..'), OUT_DIR) + '/');
console.log('  set_id ' + bundle.set_id + '  (' + bundle.patterns.length + ' patterns)');

// ── self-verify: parse each written .pat → duty 128 + geometry == G6_2x10 ───────
let ok = true;
for (const p of bundle.patterns) {
    const buf = fs.readFileSync(path.join(PAT_DIR, p.name));
    const parsed = PatParser.parsePatFile(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    );
    const v = PS.validateGeometry(parsed, ARENA, arenaCfg.getConfig);
    const dutyOk = parsed.stretchValues.every((s) => s === 0x80);
    if (!v.ok || !dutyOk) {
        console.error('  FAIL ' + p.name + ': geometry=' + v.ok + ' dutyOk=' + dutyOk);
        ok = false;
    }
}
console.log(
    ok ? '\nSelf-verify OK (duty 0x80 + geometry == ' + ARENA + ').' : '\nSelf-verify FAILED.'
);
process.exit(ok ? 0 : 1);
