#!/usr/bin/env node
/**
 * Build the one-color, top-row-only rotating gratings for
 * protocols/g6_color_optomotor_test.yaml into the colocated folder
 * protocols/g6_color_optomotor_test_patterns/ (G6 2x10, GS2, 20 frames each).
 *
 * Four-color G6 panels (LAB-228) carry four LED colors in each 2×2 pixel cell:
 *     bank(row, col) = 2 * ((row + 1) % 2) + (col % 2)   (host coords, row 0 = bottom)
 *     bank 0 violet 405 nm · 1 blue 470 nm · 2 green 525 nm · 3 yellow-orange 590 nm
 * (js/panel-color.js, layout "four-color", bench-verified 2026-09-29). A pattern that
 * lights only the pixels of ONE bank drives one LED color; the other three banks stay dark.
 *
 * Each pattern: square-wave grating, period 20 px (36° on the 200-px arena, 10 px on /
 * 10 px off), shifted one pixel toward increasing column index per frame — 20 frames =
 * one period, playback wraps. Only the TOP panel row (pixel rows 20..39) is drawn; the
 * bottom row stays dark. Within the lit half-period only the chosen bank's pixels are on,
 * so each frame lights exactly 500 of the 8000 pixels. GS2 (binary): brightness comes from
 * the trial's `duty` override, which is what the protocol sweeps.
 *
 *   node scripts/make-color-optomotor-patterns.js          # GS2 set for g6_color_optomotor_test
 *   node scripts/make-color-optomotor-patterns.js --gs16 --out <dir>   # GS16 set for g6_2p_color_led_sweep (private 2P repo)
 *
 * --gs16 writes the SAME four gratings as Gray_16 files (lit pixels = 15) into
 * protocols/g6_2p_color_led_sweep_patterns/, names suffixed `_gs16`. The 2P imaging runs
 * use GS16 because the controller re-streams GS16 at 300 Hz by default (GS2 at 1000 Hz),
 * matching the 22 Sept 2026 duty-sweep runs — same stimulus, no refresh-rate confound.
 */
const fs = require('fs');
const path = require('path');
const _pp = require('../js/pat-parser.js');
const PatParser = _pp.default || _pp;
const PatEncoder = require('../js/pat-encoder.js');
const PanelColor = require('../js/panel-color.js');

const ROWS = 2,
    COLS = 10,
    PIXEL_ROWS = 40,
    PIXEL_COLS = 200,
    N = PIXEL_ROWS * PIXEL_COLS;
const PERIOD_PX = 20,
    ON_PX = 10,
    FRAMES = PERIOD_PX;
const TOP_ROW_START = 20; // pixel rows 20..39 = the top panel row (row 0 = bottom)
const ARENA_ID = 1;
const GS16 = process.argv.includes('--gs16');
const ON_VALUE = GS16 ? 15 : 1;
// --out <dir> overrides the destination. The GS2 set is the public
// protocols/g6_color_optomotor_test_patterns/. The GS16 set belongs to the 2P
// protocol, which moved to the private rig repo on 2026-10-29 (LAB-227:
// reiserlab/scanimage-2026-bergamo, protocols/g6_2p_color_led_sweep_patterns/),
// so --gs16 needs an explicit --out pointing into a checkout of that repo.
const outIdx = process.argv.indexOf('--out');
const OUT_ARG = outIdx >= 0 ? process.argv[outIdx + 1] : null;
if (GS16 && !OUT_ARG) {
    console.error(
        '--gs16 needs --out <dir>: the 2P sweep patterns live in the private ' +
            'reiserlab/scanimage-2026-bergamo (protocols/g6_2p_color_led_sweep_patterns/), not here.'
    );
    process.exit(2);
}
const OUT = OUT_ARG
    ? path.resolve(OUT_ARG)
    : path.join(__dirname, '..', 'protocols', 'g6_color_optomotor_test_patterns');
const layout = PanelColor.getLayout('four-color');
const BANKS = layout.banks; // ['violet', 'blue', 'green', 'yellow']

function grating(bank) {
    const frames = [];
    for (let f = 0; f < FRAMES; f++) {
        const fr = new Uint8Array(N);
        for (let r = TOP_ROW_START; r < PIXEL_ROWS; r++) {
            for (let c = 0; c < PIXEL_COLS; c++) {
                if (PanelColor.bankAt(r, c) !== bank) continue;
                if ((((c - f) % PERIOD_PX) + PERIOD_PX) % PERIOD_PX < ON_PX)
                    fr[r * PIXEL_COLS + c] = ON_VALUE;
            }
        }
        frames.push(fr);
    }
    return frames;
}

fs.mkdirSync(OUT, { recursive: true });
const readme = GS16
    ? [
          'Patterns for protocols/g6_2p_color_led_sweep.yaml (G6 2x10 four-color panels, GS16 — lit pixels 15, 20 frames each;',
          'built by scripts/make-color-optomotor-patterns.js --gs16 — regenerate rather than edit). GS16 so the controller',
          're-streams at 300 Hz (its GS16 default), as in the 22 Sept 2026 2P duty-sweep runs; the GS2 set would default to 1000 Hz.'
      ]
    : [
          'Patterns for protocols/g6_color_optomotor_test.yaml (G6 2x10 four-color panels, GS2, 20 frames each;',
          'built by scripts/make-color-optomotor-patterns.js — regenerate rather than edit).'
      ];
readme.push(
    'Upload the whole folder from Arena Studio (Console → Patterns → Add ▾ → this folder); the Studio resolves',
    'patterns by NAME, so the pattern_IDs in the YAML only matter as the fallback when the SD listing is unavailable.',
    '',
    'Each file: square-wave grating, period 20 px = 36°, 10 px on / 10 px off, one pixel of shift toward increasing',
    'column index per frame (20 frames = one period; playback wraps), TOP panel row only (pixel rows 20..39), and only',
    'the pixels of ONE LED color bank lit (2×2-cell bank map of js/panel-color.js, layout "four-color").',
    'Frame_rate +80 in mode 2 = 4 Hz temporal frequency (80 px/s ÷ 20 px); negative reverses.',
    ''
);
let ok = true;
BANKS.forEach((color, bank) => {
    const name = `G6_2x10_toprow_grat20_${color}${GS16 ? '_gs16' : ''}`;
    const frames = grating(bank);
    const bytes = PatEncoder.encode({
        generation: 'G6',
        gs_val: GS16 ? 16 : 2,
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
    // Verify by decoding: 500 lit pixels per frame, all in the top row, all in this bank.
    const parsed = PatParser.parsePatFile(new Uint8Array(fs.readFileSync(file)).buffer);
    let bad = 0,
        lit = [];
    parsed.frames.forEach((fr) => {
        let n = 0;
        for (let i = 0; i < fr.length; i++) {
            if (!fr[i]) continue;
            if (fr[i] !== ON_VALUE) bad++;
            n++;
            const r = Math.floor(i / PIXEL_COLS),
                c = i % PIXEL_COLS;
            if (r < TOP_ROW_START || PanelColor.bankAt(r, c) !== bank) bad++;
        }
        lit.push(n);
    });
    const good = parsed.frames.length === FRAMES && bad === 0 && lit.every((n) => n === 500);
    ok = ok && good;
    const ch = layout.bankChannel[bank];
    const line = `${name}.pat — bank ${bank} = ${ch.label}; frames ${parsed.frames.length}, lit px/frame ${lit[0]}, stray px ${bad}, ${bytes.byteLength} bytes  ${good ? 'OK' : 'FAIL'}`;
    readme.push(line);
    console.log(line);
});
fs.writeFileSync(path.join(OUT, 'README.txt'), readme.join('\n') + '\n');
process.exit(ok ? 0 : 1);
