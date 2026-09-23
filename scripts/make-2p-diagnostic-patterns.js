#!/usr/bin/env node
/**
 * Build the full-field brightness patterns for the 2P line-sync diagnostics
 * (protocols/g6_2x10_2p_diagnostics.yaml) into the colocated folder
 * protocols/g6_2x10_2p_diagnostics_patterns/. G6 2x10, GS16, duty byte 0x80.
 *
 * Why these patterns: on the Bergamo the display leaves a uniform offset in the
 * SiPM channels that is expected to follow the TOTAL light the display emits.
 * A full-field pattern whose grey level steps through 0..15 measures offset vs
 * emitted light in one trial at fixed duty; the pseudo-random order separates it
 * from drift; the 0/15 flash shows the stimulus-locked step and its kinetics;
 * the sparse pattern asks whether 10 % of LEDs at full is the same as all LEDs
 * at 10 % (per-LED vs total-current effect).
 *
 *   node scripts/make-2p-diagnostic-patterns.js
 */
const fs = require('fs');
const path = require('path');
const _pp = require('../js/pat-parser.js');
const PatParser = _pp.default || _pp;
const PatEncoder = require('../js/pat-encoder.js');
const arenaCfg = require('../js/arena-configs.js');

const ARENA = 'G6_2x10';
const ROWS = 2, COLS = 10, PIXEL_ROWS = 40, PIXEL_COLS = 200, N = PIXEL_ROWS * PIXEL_COLS;
const ARENA_ID = 1;
const OUT = path.join(__dirname, '..', 'protocols', 'g6_2x10_2p_diagnostics_patterns');

const uniform = (v) => new Uint8Array(N).fill(v);

// Fixed pseudo-random order of the 16 grey levels (a 4-bit LFSR / m-sequence
// walk, x^4 + x^3 + 1, seed 1, with 0 inserted in the middle): every level once,
// large and small steps mixed, so a slow drift cannot masquerade as a slope.
const PR16 = [8, 12, 14, 15, 7, 3, 1, 0, 9, 4, 2, 10, 5, 11, 13, 6];

// Deterministic sparse mask: 10 % of pixels at full, seeded LCG so the file is reproducible.
function sparse(frac, seed) {
    const f = new Uint8Array(N);
    let s = seed >>> 0;
    const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
    let lit = 0;
    for (let i = 0; i < N; i++) if (rnd() < frac) { f[i] = 15; lit++; }
    return { frame: f, lit };
}

const SEEDS = [
    {
        name: 'G6_2x10_ff_ramp16',
        frames: Array.from({ length: 16 }, (_, k) => uniform(k)),
        note: 'full field, grey level = frame index 0..15 (ascending ramp). mode 2, frame_rate 2 → 8 s per pass'
    },
    {
        name: 'G6_2x10_ff_steps_pr16',
        frames: PR16.map((v) => uniform(v)),
        note: 'full field, the 16 grey levels in pseudo-random order ' + PR16.join(',') + '. mode 2, frame_rate 2 → 8 s per pass'
    },
    {
        name: 'G6_2x10_ff_flash_0_15',
        frames: [uniform(0), uniform(15)],
        note: 'full field off/on square wave. mode 2, frame_rate 2 → 1 Hz flash (0.5 s dark, 0.5 s full)'
    },
    {
        name: 'G6_2x10_sparse10',
        frames: [sparse(0.10, 20260923).frame],
        note: '10 % of pixels at level 15, rest dark, static (frame_rate 0). Compare with ff_ramp16 held at level 1–2'
    }
];

fs.mkdirSync(OUT, { recursive: true });
const readme = ['Patterns for protocols/g6_2x10_2p_diagnostics.yaml (G6 2x10, GS16, built by scripts/make-2p-diagnostic-patterns.js).',
    'Upload the whole folder from Arena Studio (Console → Patterns → Add ▾ → this protocol\'s folder); the Studio resolves patterns by NAME.', ''];
let ok = true;
for (const s of SEEDS) {
    const bytes = PatEncoder.encode({
        generation: 'G6', gs_val: 16, numFrames: s.frames.length,
        rowCount: ROWS, colCount: COLS, pixelRows: PIXEL_ROWS, pixelCols: PIXEL_COLS,
        frames: s.frames, stretchValues: [], arena_id: ARENA_ID, observer_id: 0
    });
    const file = path.join(OUT, s.name + '.pat');
    fs.writeFileSync(file, Buffer.from(bytes));
    // self-verify: parse back, check geometry, duty byte, and mean level per frame
    const buf = fs.readFileSync(file);
    const p = PatParser.parsePatFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const cfg = arenaCfg.getConfig(ARENA);
    const geomOk = p.pixelRows === PIXEL_ROWS && p.pixelCols === PIXEL_COLS && p.gs_val === 16 && p.frames.length === s.frames.length;
    const dutyOk = p.stretchValues.every((d) => d === 0x80);
    const means = p.frames.map((fr) => (fr.reduce((a, b) => a + b, 0) / fr.length / 15));
    const lit = p.frames.map((fr) => fr.filter((v) => v > 0).length / fr.length);
    const line = `${s.name}.pat  frames ${p.frames.length}  mean/full per frame [${means.map((m) => m.toFixed(2)).join(' ')}]  lit fraction [${[...new Set(lit.map((l) => l.toFixed(2)))].join(' ')}]  ${geomOk && dutyOk ? 'OK' : 'FAIL'}`;
    console.log(line);
    readme.push(`${s.name}.pat — ${s.note}`);
    readme.push(`    ${line}`);
    if (!geomOk || !dutyOk) ok = false;
}
fs.writeFileSync(path.join(OUT, 'README.txt'), readme.join('\n') + '\n');
console.log(ok ? '\nSelf-verify OK → ' + path.relative(process.cwd(), OUT) : '\nSelf-verify FAILED');
process.exit(ok ? 0 : 1);
