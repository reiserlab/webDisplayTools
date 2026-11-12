#!/usr/bin/env node
/**
 * Build the patterns of protocols/g6_optomotor_osc_walking.yaml and
 * protocols/g6_optomotor_osc_flight.yaml (Reiser / Lehenbauer arena + robot demo, 2026-11-13).
 *
 * The files are large (about 20 MB at the defaults) and are NOT committed: run this script
 * and upload the output folder from Arena Studio (Console → Patterns → Add ▾ → local folder).
 *
 *   pixi run node scripts/make-optomotor-osc-patterns.js            # → protocols/g6_optomotor_osc_patterns/
 *   options: --arena G6_2x10   --front-col 49.5   --wavelength-deg 45   --osc-hz 0.2
 *            --fps 150   --peaks 2.5,5,10   --stripe-px 16   --out <dir>
 *
 * WHAT IT MAKES (all GS16, every pixel row):
 *   <ARENA>_sine45_yaw_osc_tf<P>    open loop: sine grating, rotation about the vertical axis
 *   <ARENA>_sine45_roll_osc_tf<P>   open loop: sine grating, rotation about the fly's
 *                                   front-back axis (a true roll stimulus)
 *   <ARENA>_sine45_yaw_200f         closed loop: the yaw grating, 1 px per frame
 *   <ARENA>_stripe16_dark_200f      closed loop: dark stripe on a bright background,
 *                                   frame 0 = centered straight ahead of the fly
 *
 * Both gratings come from the Pattern Designer's spherical generator
 * (js/pattern-editor/tools/generator.js, 'spherical-sine', motion 'rotation'); only the pole
 * differs: straight up for yaw, straight ahead of the fly for roll.
 *
 * OPEN LOOP (mode 2) plays the frames of a file in order at a constant frame rate, so the
 * oscillation is the frame sequence. Velocity is v(t) = v_peak · sin(2π f t): every cycle
 * starts and ends at zero speed, so trials can follow each other without a gap. Position
 * (in grating wavelengths) is  x(t) = TF_peak / (2π f) · (1 − cos(2π f t)),  where TF_peak
 * is the peak temporal frequency (--peaks, Hz) and v_peak = TF_peak × wavelength. One file
 * holds one cycle: fps / f frames. Frame k shows the grating at x(k / fps), rounded to
 * 1/10 px. Play it at frame_rate = +fps.
 * The default 150 frames/s is two refreshes per frame at the controller's 300 Hz GS16
 * refresh, so every frame is shown for the same time (200 frames/s alternates 3.3 / 6.7 ms;
 * measured on ww18, 2026-11-12).
 *
 * DIRECTIONS. Positive yaw = toward increasing column index (clockwise seen from above on
 * the lab's 2x10 arenas). Positive roll = clockwise as the fly sees it looking forward: down
 * on the side of increasing column index (the fly's right), up on the other side. The first
 * half of each cycle is positive. Closed-loop files shift toward increasing column index
 * with the frame index, as the built-in frame2_h_ccw_200f does.
 *
 * --front-col is the pixel column straight ahead of the fly (fractional; 49.5 = the center
 * of panel column 3 of 10, the lab convention for the 2x10 arenas with panel column 8,
 * directly behind, left out).
 *
 * Every file is decoded again and checked against geometry computed here, independent of
 * the generator: the position of every frame, the oscillation frequency, the peak speed.
 */
const fs = require('fs');
const path = require('path');
const _pp = require('../js/pat-parser.js');
const PatParser = _pp.default || _pp;
const PatEncoder = require('../js/pat-encoder.js');
const arenaCfg = require('../js/arena-configs.js');
const _pg = require('../js/pattern-editor/tools/generator.js');
const PatternGenerator = _pg.default || _pg.PatternGenerator || _pg;

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function fail(msg) {
    console.error(msg);
    process.exit(2);
}
const mod = (a, n) => ((a % n) + n) % n;
const tag = (x) => String(x).replace('.', 'p');

const ARENA = arg('--arena', 'G6_2x10');
const WAVELENGTH_DEG = Number(arg('--wavelength-deg', 45));
const OSC_HZ = Number(arg('--osc-hz', 0.2));
const FPS = Number(arg('--fps', 150));
const PEAKS = String(arg('--peaks', '2.5,5,10')).split(',').map(Number);
const STRIPE_PX = Number(arg('--stripe-px', 16));
const OUT = path.resolve(
    arg('--out', path.join(__dirname, '..', 'protocols', 'g6_optomotor_osc_patterns'))
);
const QUIET = process.argv.includes('--quiet');

const cfg = arenaCfg.getConfig(ARENA);
if (!cfg || cfg.arena.generation !== 'G6') fail(`--arena ${ARENA}: not a G6 arena config`);
if (cfg.arena.columns_installed) {
    fail(`--arena ${ARENA}: partial arenas are not supported by js/pat-encoder.js`);
}
const PANEL = arenaCfg.PANEL_SPECS.G6.pixels_per_panel;
const ROWS = cfg.arena.num_rows;
const COLS = cfg.arena.num_cols;
const PX_ROWS = ROWS * PANEL;
const PX_COLS = COLS * PANEL;
const NPX = PX_ROWS * PX_COLS;
const ARENA_ID = arenaCfg.getArenaId('G6', ARENA);
const P_RAD = (2 * Math.PI) / PX_COLS; // one pixel, radians
const DEG_PER_PX = 360 / PX_COLS;
const FRONT_COL = Number(arg('--front-col', PANEL * 2.5 - 0.5));
const CYCLES = 360 / WAVELENGTH_DEG; // grating cycles around the rotation axis
const WAVELENGTH_PX = WAVELENGTH_DEG / DEG_PER_PX;
const PHASE_STEPS = Math.round(WAVELENGTH_PX * 10); // grating positions per wavelength (1/10 px)
const N_OSC = FPS / OSC_HZ;

if (!Number.isInteger(CYCLES)) fail('--wavelength-deg must divide 360');
if (!Number.isInteger(WAVELENGTH_PX)) fail('--wavelength-deg must be a whole number of pixels');
if (!Number.isInteger(N_OSC) || N_OSC < 16) fail('--fps / --osc-hz: a whole number of frames');
if (!PEAKS.length || PEAKS.some((p) => !(p > 0))) fail('--peaks: positive numbers, Hz');
if (!(FRONT_COL >= -0.5 && FRONT_COL <= PX_COLS - 0.5)) fail('--front-col: a pixel column');
if (!Number.isInteger(STRIPE_PX) || STRIPE_PX < 2 || STRIPE_PX % 2) fail('--stripe-px: even');

// ── geometry computed HERE (the check does not reuse the generator's rotation code) ──
// Unit cylinder, the arena-geometry.js 'smooth' model: azimuth of column c is
// P_RAD·(c − (cols−1)/2), height of row r is P_RAD·(r − (rows−1)/2), row 0 = bottom.
const azOf = (c) => P_RAD * (c - (PX_COLS - 1) / 2);
const FRONT_AZ = azOf(FRONT_COL);
// u(r, c): the coordinate (radians) each grating moves along, increasing in its POSITIVE
// direction. Yaw: azimuth. Roll: the angle about the front axis, measured so that it grows
// clockwise in the fly's view (from "up" toward the side of increasing column index).
const U = {
    yaw: new Float64Array(NPX),
    roll: new Float64Array(NPX)
};
for (let r = 0; r < PX_ROWS; r++) {
    const z = P_RAD * (r - (PX_ROWS - 1) / 2);
    for (let c = 0; c < PX_COLS; c++) {
        const a = azOf(c) - FRONT_AZ; // azimuth from straight ahead, toward increasing column
        U.yaw[r * PX_COLS + c] = azOf(c);
        U.roll[r * PX_COLS + c] = Math.atan2(Math.sin(a), z); // 0 = up, +90° = "right"
    }
}
// Position of a grating frame along u, in wavelengths (mod 1), and how well the frame
// matches a sine grating in u (1 = perfectly): projection onto exp(−i·CYCLES·u).
function project(frame, u) {
    let re = 0,
        im = 0,
        mean = 0;
    for (let i = 0; i < NPX; i++) mean += frame[i];
    mean /= NPX;
    for (let i = 0; i < NPX; i++) {
        const v = frame[i] - mean;
        re += v * Math.cos(CYCLES * u[i]);
        im -= v * Math.sin(CYCLES * u[i]);
    }
    // v ≈ A·sin(CYCLES·(u − u0)) → Σ v·e^{−i·CYCLES·u} = (N·A/2)·(−i)·e^{−i·CYCLES·u0}
    const pos = mod((-Math.atan2(im, re) - Math.PI / 2) / (2 * Math.PI), 1);
    return { pos, amp: (2 * Math.hypot(re, im)) / NPX };
}

// ── the gratings: one bank of PHASE_STEPS frames per axis, from the Pattern Designer ──
function bank(axis) {
    const pat = PatternGenerator.generate(
        'spherical-sine',
        {
            spatFreq: (WAVELENGTH_DEG * Math.PI) / 180,
            motionType: 'rotation',
            waveform: 'sine',
            high: 15,
            low: 0,
            // pole [azimuth, polar angle]: [·, 90°] = straight up (yaw); [front, 0] = on the
            // horizon, straight ahead of the fly (roll). Verified below by projection.
            poleCoord: axis === 'yaw' ? [0, Math.PI / 2] : [FRONT_AZ, 0],
            numFrames: PHASE_STEPS,
            stepSize: WAVELENGTH_PX / PHASE_STEPS,
            aaSamples: 15,
            arenaModel: 'smooth',
            gsMode: 16
        },
        cfg.arena
    );
    const frames = pat.frames.map((f) => Uint8Array.from(f));
    // Order the bank by measured position along u, so index j = position j / PHASE_STEPS
    // wavelengths in the positive direction (the generator's own direction is not assumed).
    // The direction is read from a one-pixel step; the whole bank is then checked for
    // linearity (a single 1/10 px step is below what 16 gray levels resolve).
    const pos = frames.map((f) => project(f, U[axis]));
    const onePx = Math.round(PHASE_STEPS / WAVELENGTH_PX);
    const forward = mod(pos[onePx].pos - pos[0].pos + 0.5, 1) - 0.5 > 0;
    const at = (j) => (forward ? j : mod(-j, PHASE_STEPS));
    let maxErr = 0;
    for (let j = 0; j < PHASE_STEPS; j++) {
        const d = mod(pos[at(j)].pos - pos[0].pos - j / PHASE_STEPS + 0.5, 1) - 0.5;
        maxErr = Math.max(maxErr, Math.abs(d));
    }
    return {
        frames: Array.from({ length: PHASE_STEPS }, (_, j) => frames[at(j)]),
        pos0: pos[0].pos,
        match: pos[0].amp,
        maxErrPx: maxErr * WAVELENGTH_PX
    };
}

function encode(name, frames) {
    const bytes = PatEncoder.encode({
        generation: 'G6',
        gs_val: 16,
        numFrames: frames.length,
        rowCount: ROWS,
        colCount: COLS,
        pixelRows: PX_ROWS,
        pixelCols: PX_COLS,
        frames,
        stretchValues: [],
        arena_id: ARENA_ID,
        observer_id: 0
    });
    const file = path.join(OUT, name + '.pat');
    fs.writeFileSync(file, Buffer.from(bytes));
    return { file, bytes: bytes.byteLength };
}
function decode(file) {
    const log = console.log;
    console.log = () => {}; // PatParser prints a summary per file
    try {
        return PatParser.parsePatFile(new Uint8Array(fs.readFileSync(file)).buffer);
    } finally {
        console.log = log;
    }
}
// Positions (wavelengths, unwrapped from frame 0) of a decoded grating file.
function trajectory(frames, axis, pos0) {
    const out = [];
    let prev = 0;
    let minAmp = Infinity;
    frames.forEach((fr, k) => {
        const p = project(fr, U[axis]);
        minAmp = Math.min(minAmp, p.amp);
        const rel = mod(p.pos - pos0, 1);
        if (k === 0) prev = rel > 0.5 ? rel - 1 : rel;
        else prev += mod(rel - mod(prev, 1) + 0.5, 1) - 0.5;
        out.push(prev);
    });
    return { pos: out, minAmp };
}

fs.mkdirSync(OUT, { recursive: true });
let ok = true;
const report = [];
const say = (line, good) => {
    if (good === false) ok = false;
    report.push(line + (good === undefined ? '' : good ? '  OK' : '  FAIL'));
};

const banks = { yaw: bank('yaw'), roll: bank('roll') };
for (const axis of ['yaw', 'roll']) {
    const b = banks[axis];
    // match: amplitude of the sine grating found along this script's own coordinate, in gray
    // levels (a full-contrast 0..15 sine is 7.5). Roll loses a little where the bars get
    // finer than a pixel next to the two poles.
    say(
        `${axis} grating: ${CYCLES} cycles of ${WAVELENGTH_DEG}° about the ${axis === 'yaw' ? 'vertical axis' : 'front-back axis (front = pixel column ' + FRONT_COL + ')'}; ` +
            `sine amplitude along that axis ${b.match.toFixed(2)} of 7.5 gray levels; ${PHASE_STEPS} positions per wavelength, largest position error ${b.maxErrPx.toFixed(2)} px`,
        b.match > (axis === 'yaw' ? 7.0 : 6.0) && b.maxErrPx < 0.25
    );
}

// ── open loop: one oscillation cycle per file ────────────────────────────────
const AMP_WL = (tf) => tf / (2 * Math.PI * OSC_HZ); // x(t) = AMP·(1 − cos); travel = 2·AMP
const xAt = (tf, k) => AMP_WL(tf) * (1 - Math.cos((2 * Math.PI * k) / N_OSC));
const names = { ol: [], cl: [] };
for (const axis of ['yaw', 'roll']) {
    for (const tf of PEAKS) {
        const name = `${ARENA}_sine${WAVELENGTH_DEG}_${axis}_osc_tf${tag(tf)}`;
        const idx = Array.from({ length: N_OSC }, (_, k) =>
            mod(Math.round(xAt(tf, k) * PHASE_STEPS), PHASE_STEPS)
        );
        const w = encode(
            name,
            idx.map((j) => banks[axis].frames[j])
        );
        const dec = decode(w.file);
        const tr = trajectory(dec.frames, axis, banks[axis].pos0);
        // Error against the intended x(t), and the oscillation read back from the decoded
        // positions: frequency from the Fourier component at one cycle per file, peak speed
        // from the largest step.
        let maxErr = 0,
            c1 = 0,
            maxStep = 0;
        tr.pos.forEach((p, k) => {
            maxErr = Math.max(maxErr, Math.abs(p - xAt(tf, k)));
            c1 += p * Math.cos((2 * Math.PI * k) / N_OSC);
            maxStep = Math.max(maxStep, Math.abs(tr.pos[(k + 1) % N_OSC] - p));
        });
        const fitAmp = (-2 * c1) / N_OSC; // x = AMP − AMP·cos → cosine component −AMP
        const fitPeakTf = fitAmp * 2 * Math.PI * OSC_HZ;
        const good =
            dec.frames.length === N_OSC &&
            maxErr < 0.03 &&
            Math.abs(fitPeakTf - tf) < 0.01 * tf &&
            tr.pos[0] === tr.pos[0] &&
            Math.abs(tr.pos[0]) < 0.01 &&
            tr.pos[1] >= 0;
        names.ol.push(name);
        say(
            `${name}.pat — ${N_OSC} frames = one ${1 / OSC_HZ} s cycle at frame_rate ${FPS}; peak ${tf} Hz = ` +
                `${(tf * WAVELENGTH_DEG).toFixed(1)}°/s; travel ${(2 * AMP_WL(tf) * WAVELENGTH_DEG).toFixed(0)}° between turnarounds; ` +
                `largest step ${(maxStep * WAVELENGTH_PX).toFixed(2)} px/frame; decoded: peak ${fitPeakTf.toFixed(3)} Hz, ` +
                `largest position error ${(maxErr * WAVELENGTH_PX).toFixed(2)} px; ${(w.bytes / 1e6).toFixed(2)} MB`,
            good
        );
    }
}

// ── closed loop: 1 px per frame, one frame per pixel column ──────────────────
{
    const name = `${ARENA}_sine${WAVELENGTH_DEG}_yaw_${PX_COLS}f`;
    const perPx = PHASE_STEPS / WAVELENGTH_PX;
    const w = encode(
        name,
        Array.from({ length: PX_COLS }, (_, k) => banks.yaw.frames[mod(k * perPx, PHASE_STEPS)])
    );
    const dec = decode(w.file);
    const tr = trajectory(dec.frames, 'yaw', banks.yaw.pos0);
    const good =
        dec.frames.length === PX_COLS &&
        tr.pos.every((p, k) => Math.abs(p * WAVELENGTH_PX - k) < 0.3);
    names.cl.push(name);
    say(
        `${name}.pat — ${PX_COLS} frames, frame k = the yaw grating shifted k px (${DEG_PER_PX}°) toward increasing column index; ` +
            `${(w.bytes / 1e6).toFixed(2)} MB`,
        good
    );
}
{
    const name = `${ARENA}_stripe${STRIPE_PX}_dark_${PX_COLS}f`;
    const frames = Array.from({ length: PX_COLS }, (_, k) => {
        const fr = new Uint8Array(NPX).fill(15);
        for (let c = 0; c < PX_COLS; c++) {
            const d = Math.abs(mod(c - (FRONT_COL + k) + PX_COLS / 2, PX_COLS) - PX_COLS / 2);
            if (d < STRIPE_PX / 2) for (let r = 0; r < PX_ROWS; r++) fr[r * PX_COLS + c] = 0;
        }
        return fr;
    });
    const w = encode(name, frames);
    const dec = decode(w.file);
    // Decoded: STRIPE_PX dark columns per frame, their center at FRONT_COL + k.
    let good = dec.frames.length === PX_COLS;
    dec.frames.forEach((fr, k) => {
        let n = 0,
            sx = 0,
            sy = 0;
        for (let c = 0; c < PX_COLS; c++) {
            let dark = 0;
            for (let r = 0; r < PX_ROWS; r++) dark += fr[r * PX_COLS + c] === 0 ? 1 : 0;
            if (dark === PX_ROWS) {
                n++;
                sx += Math.cos(azOf(c));
                sy += Math.sin(azOf(c));
            } else if (dark !== 0) good = false;
        }
        const center = mod(Math.atan2(sy, sx) / P_RAD + (PX_COLS - 1) / 2, PX_COLS);
        const want = mod(FRONT_COL + k, PX_COLS);
        if (n !== STRIPE_PX || Math.abs(mod(center - want + 100, PX_COLS) - 100) > 1e-6) {
            good = false;
        }
    });
    names.cl.push(name);
    say(
        `${name}.pat — ${PX_COLS} frames, dark stripe ${STRIPE_PX} px = ${(STRIPE_PX * DEG_PER_PX).toFixed(1)}° wide on a bright (15) background; ` +
            `frame 0 centered on pixel column ${FRONT_COL} (straight ahead), frame k shifted k px toward increasing column index; ` +
            `${(w.bytes / 1e6).toFixed(2)} MB`,
        good
    );
}

const readme = [
    'Patterns for protocols/g6_optomotor_osc_walking.yaml and protocols/g6_optomotor_osc_flight.yaml',
    '(GS16; built by scripts/make-optomotor-osc-patterns.js; not committed: regenerate).',
    'Upload the whole folder from Arena Studio (Console → Patterns → Add ▾ → local folder). The Studio resolves',
    'patterns by NAME; the pattern_IDs in the YAML are only the fallback when the SD listing is unavailable.',
    '',
    `Arena ${ARENA}: ${ROWS}×${COLS} panels, ${PX_COLS}×${PX_ROWS} px, ${DEG_PER_PX}° per pixel. Straight ahead of the fly = pixel column ${FRONT_COL}.`,
    `Sine gratings, wavelength ${WAVELENGTH_DEG}° (${WAVELENGTH_PX} px for yaw), gray levels 0..15.`,
    `Open loop: velocity = peak · sin(2π · ${OSC_HZ} Hz · t); one file = one cycle; play at frame_rate +${FPS} (mode 2).`,
    'Positive (the first half cycle): yaw toward increasing column index; roll clockwise as the fly sees it.',
    '',
    ...report,
    ''
];
fs.writeFileSync(path.join(OUT, 'README.txt'), readme.join('\n'));
fs.writeFileSync(
    path.join(OUT, 'patterns.json'),
    JSON.stringify(
        {
            arena: ARENA,
            front_col: FRONT_COL,
            wavelength_deg: WAVELENGTH_DEG,
            osc_hz: OSC_HZ,
            fps: FPS,
            frames_per_cycle: N_OSC,
            peaks_hz: PEAKS,
            stripe_px: STRIPE_PX,
            open_loop: names.ol,
            closed_loop: names.cl,
            ok
        },
        null,
        1
    ) + '\n'
);
if (!QUIET) report.forEach((l) => console.log(l));
process.exit(ok ? 0 : 1);
