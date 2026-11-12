#!/usr/bin/env node
/**
 * Build the two patterns of protocols/g6_optomotor_open_loop_oscillation.yaml into the
 * colocated folder protocols/g6_optomotor_open_loop_oscillation_patterns/.
 *
 * Open loop (mode 2) plays a pattern's frames in file order at a constant frame rate, so
 * a motion profile that is not a constant speed has to be IN the frame sequence:
 *
 *   <ARENA>_grat<P>.pat          vertical square-wave grating, period P px (half on, half
 *                                off), every pixel row. Frame k is the grating shifted k px
 *                                toward increasing column index; P frames = one period.
 *                                Constant rotation: frame_rate = ±(temporal Hz × P).
 *   <ARENA>_grat<P>_osc<F>hz.pat the same grating; frame k is shifted by
 *                                round(A · sin(2π k / N)) px, N = fps / F frames = one
 *                                cycle. Played at frame_rate = +fps it is a sinusoidal
 *                                position oscillation at F Hz, amplitude A px (default
 *                                A = P, one grating period to each side). It starts at
 *                                zero shift and moves toward increasing column index first.
 *
 * The arena is a parameter (the encoder writes full-grid G6 arenas only):
 *
 *   node scripts/make-optomotor-oscillation-patterns.js                    # G6_2x10
 *   node scripts/make-optomotor-oscillation-patterns.js --arena G6_3x10
 *   options: --period <px> (20)  --osc-hz <Hz> (1)  --osc-fps <frames/s> (200)
 *            --osc-amp <px> (= period)  --bank all|violet|blue|green|yellow (all)
 *            --out <dir>
 *
 * --bank lights one LED color of four-color panels (js/panel-color.js); `all` lights
 * every pixel, which is right for one-color panels and gives all four colors on
 * four-color panels.
 *
 * Every file is decoded again and checked: the grating shape, the shift of each frame, and
 * for the oscillation the frequency, amplitude and peak speed of the shift sequence.
 */
const fs = require('fs');
const path = require('path');
const _pp = require('../js/pat-parser.js');
const PatParser = _pp.default || _pp;
const PatEncoder = require('../js/pat-encoder.js');
const PanelColor = require('../js/panel-color.js');
const arenaCfg = require('../js/arena-configs.js');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function fail(msg) {
    console.error(msg);
    process.exit(2);
}

const ARENA = arg('--arena', 'G6_2x10');
const PERIOD = Number(arg('--period', 20));
const OSC_HZ = Number(arg('--osc-hz', 1));
const OSC_FPS = Number(arg('--osc-fps', 200));
const OSC_AMP = Number(arg('--osc-amp', PERIOD));
const BANK = arg('--bank', 'all');
const OUT = path.resolve(
    arg(
        '--out',
        path.join(__dirname, '..', 'protocols', 'g6_optomotor_open_loop_oscillation_patterns')
    )
);

const cfg = arenaCfg.getConfig(ARENA);
if (!cfg || cfg.arena.generation !== 'G6') fail(`--arena ${ARENA}: not a G6 arena config`);
if (cfg.arena.columns_installed) {
    fail(`--arena ${ARENA}: partial arenas are not supported by js/pat-encoder.js`);
}
const PANEL = arenaCfg.PANEL_SPECS.G6.pixels_per_panel || 20;
const ROWS = cfg.arena.num_rows;
const COLS = cfg.arena.num_cols;
const PIXEL_ROWS = ROWS * PANEL;
const PIXEL_COLS = COLS * PANEL;
const ARENA_ID = arenaCfg.getArenaId('G6', ARENA);
const DEG_PER_PX = 360 / PIXEL_COLS;

if (!Number.isInteger(PERIOD) || PERIOD < 2 || PERIOD % 2) fail('--period: an even integer');
if (PIXEL_COLS % PERIOD) fail(`--period ${PERIOD} does not divide ${PIXEL_COLS} columns`);
const OSC_FRAMES = OSC_FPS / OSC_HZ;
if (!Number.isInteger(OSC_FRAMES) || OSC_FRAMES < 8) {
    fail('--osc-fps / --osc-hz must be a whole number of frames per cycle (>= 8)');
}
if (!(OSC_AMP > 0)) fail('--osc-amp: a positive number of pixels');
const layout = PanelColor.getLayout('four-color');
const bankIdx = BANK === 'all' ? -1 : layout.banks.indexOf(BANK);
if (BANK !== 'all' && bankIdx < 0) fail(`--bank ${BANK}: all | ${layout.banks.join(' | ')}`);

const mod = (a, n) => ((a % n) + n) % n;
// The oscillation's shift table (px, toward increasing column index), one cycle.
const oscShift = (k) => Math.round(OSC_AMP * Math.sin((2 * Math.PI * k) / OSC_FRAMES));

function lit(r, c, shift) {
    if (mod(c - shift, PERIOD) >= PERIOD / 2) return false;
    return bankIdx < 0 || PanelColor.bankAt(r, c) === bankIdx;
}
function frameAt(shift) {
    const fr = new Uint8Array(PIXEL_ROWS * PIXEL_COLS);
    for (let r = 0; r < PIXEL_ROWS; r++) {
        for (let c = 0; c < PIXEL_COLS; c++) if (lit(r, c, shift)) fr[r * PIXEL_COLS + c] = 1;
    }
    return fr;
}

function write(name, shifts) {
    const frames = shifts.map(frameAt);
    const bytes = PatEncoder.encode({
        generation: 'G6',
        gs_val: 2,
        numFrames: frames.length,
        rowCount: ROWS,
        colCount: COLS,
        pixelRows: PIXEL_ROWS,
        pixelCols: PIXEL_COLS,
        frames,
        stretchValues: [],
        arena_id: ARENA_ID,
        observer_id: 0
    });
    const file = path.join(OUT, name + '.pat');
    fs.writeFileSync(file, Buffer.from(bytes));
    return { file, bytes: bytes.byteLength };
}

// Decode a written file and recover each frame's shift (px, 0..PERIOD-1) from the pixels:
// the one shift whose grating equals the frame exactly. Returns null if a frame is no grating.
function decodeShifts(file) {
    const parsed = PatParser.parsePatFile(new Uint8Array(fs.readFileSync(file)).buffer);
    const out = [];
    for (const fr of parsed.frames) {
        if (fr.length !== PIXEL_ROWS * PIXEL_COLS) return null;
        let found = -1;
        for (let s = 0; s < PERIOD && found < 0; s++) {
            let same = true;
            for (let i = 0; i < fr.length && same; i++) {
                const r = Math.floor(i / PIXEL_COLS);
                same = (fr[i] ? 1 : 0) === (lit(r, i % PIXEL_COLS, s) ? 1 : 0);
            }
            if (same) found = s;
        }
        if (found < 0) return null;
        out.push(found);
    }
    return out;
}

fs.mkdirSync(OUT, { recursive: true });
const gratName = `${ARENA}_grat${PERIOD}`;
const oscName = `${gratName}_osc${OSC_HZ}hz`;
let ok = true;
const report = [];

// ── constant-rotation grating ────────────────────────────────────────────────
{
    const w = write(
        gratName,
        Array.from({ length: PERIOD }, (_, k) => k)
    );
    const got = decodeShifts(w.file);
    const good = !!got && got.length === PERIOD && got.every((s, k) => s === k);
    ok = ok && good;
    report.push(
        `${gratName}.pat — ${PERIOD} frames, 1 px (${DEG_PER_PX}°) per frame toward increasing column index; ` +
            `${w.bytes} bytes  ${good ? 'OK' : 'FAIL'}`
    );
}

// ── sinusoidal oscillation ───────────────────────────────────────────────────
{
    const want = Array.from({ length: OSC_FRAMES }, (_, k) => oscShift(k));
    const w = write(oscName, want);
    const got = decodeShifts(w.file);
    let good = !!got && got.length === OSC_FRAMES;
    let fitAmp = NaN,
        fitPhase = NaN,
        rms = NaN,
        maxStep = NaN,
        harm = NaN;
    if (good) {
        // The decoded shift is known modulo PERIOD only; unwrap it frame to frame (each
        // step is far below PERIOD / 2), starting from 0.
        const pos = [];
        let prev = 0;
        got.forEach((s, k) => {
            if (k === 0) {
                good = good && s === 0;
            } else {
                let d = mod(s - mod(prev, PERIOD), PERIOD);
                if (d > PERIOD / 2) d -= PERIOD;
                prev += d;
            }
            pos.push(prev);
        });
        good = good && pos.every((p, k) => p === want[k]);
        // Fourier components of the decoded positions over the one cycle.
        const comp = (h) => {
            let s = 0,
                c = 0;
            pos.forEach((p, k) => {
                s += p * Math.sin((2 * Math.PI * h * k) / OSC_FRAMES);
                c += p * Math.cos((2 * Math.PI * h * k) / OSC_FRAMES);
            });
            return [(2 * s) / OSC_FRAMES, (2 * c) / OSC_FRAMES];
        };
        const [s1, c1] = comp(1);
        fitAmp = Math.hypot(s1, c1);
        fitPhase = (Math.atan2(c1, s1) * 180) / Math.PI;
        harm = 0;
        for (let h = 2; h <= 5; h++) harm = Math.max(harm, Math.hypot(...comp(h)));
        rms = Math.sqrt(
            pos.reduce(
                (a, p, k) => a + (p - OSC_AMP * Math.sin((2 * Math.PI * k) / OSC_FRAMES)) ** 2,
                0
            ) / OSC_FRAMES
        );
        maxStep = 0;
        pos.forEach((p, k) => {
            maxStep = Math.max(maxStep, Math.abs(pos[(k + 1) % OSC_FRAMES] - p));
        });
        const mean = pos.reduce((a, p) => a + p, 0) / OSC_FRAMES;
        // Pass: fundamental within 1 % of the amplitude and 1° of phase, no offset,
        // harmonics below 1 % of the amplitude, rounding error below 1/2 px RMS.
        good =
            good &&
            Math.abs(fitAmp - OSC_AMP) < 0.01 * OSC_AMP &&
            Math.abs(fitPhase) < 1 &&
            Math.abs(mean) < 0.05 &&
            harm < 0.01 * OSC_AMP &&
            rms < 0.5;
    }
    ok = ok && good;
    const peak = 2 * Math.PI * OSC_HZ * OSC_AMP;
    report.push(
        `${oscName}.pat — ${OSC_FRAMES} frames = one cycle at frame_rate ${OSC_FPS} (${OSC_HZ} Hz); ` +
            `amplitude ±${OSC_AMP} px (±${(OSC_AMP * DEG_PER_PX).toFixed(1)}°); ${w.bytes} bytes  ${good ? 'OK' : 'FAIL'}`,
        `    decoded shift sequence: fundamental ${fitAmp.toFixed(3)} px at ${fitPhase.toFixed(3)}° phase, ` +
            `largest harmonic (2..5) ${harm.toFixed(3)} px, RMS error to the ideal sinusoid ${rms.toFixed(3)} px, ` +
            `largest step ${maxStep} px/frame`,
        `    peak speed ${peak.toFixed(1)} px/s = ${(peak * DEG_PER_PX).toFixed(1)}°/s ` +
            `(peak temporal frequency ${(peak / PERIOD).toFixed(2)} Hz)`
    );
}

const readme = [
    'Patterns for protocols/g6_optomotor_open_loop_oscillation.yaml (GS2; built by',
    'scripts/make-optomotor-oscillation-patterns.js — regenerate rather than edit).',
    'Upload the whole folder from Arena Studio (Console → Patterns → Add ▾ → this folder). The Studio resolves',
    'patterns by NAME; the pattern_IDs in the YAML are only the fallback when the SD listing is unavailable.',
    '',
    `Arena ${ARENA}: ${ROWS}×${COLS} panels, ${PIXEL_COLS}×${PIXEL_ROWS} px, ${DEG_PER_PX}° per pixel. ` +
        `Vertical square-wave grating, period ${PERIOD} px = ${PERIOD * DEG_PER_PX}°, ` +
        `${PERIOD / 2} px on / ${PERIOD / 2} px off, every pixel row, ` +
        (bankIdx < 0
            ? 'every pixel of the on bars lit.'
            : `only the ${layout.bankChannel[bankIdx].label} pixels of the on bars lit.`),
    `Rotation: frame_rate ±F plays F px/s = F/${PERIOD} Hz temporal frequency = ${DEG_PER_PX}·F °/s.`,
    'Positive frame_rate and positive shift = toward increasing column index.',
    '',
    ...report,
    ''
];
fs.writeFileSync(path.join(OUT, 'README.txt'), readme.join('\n'));
report.forEach((l) => console.log(l));
process.exit(ok ? 0 : 1);
