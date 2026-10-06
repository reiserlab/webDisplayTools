#!/usr/bin/env node
'use strict';

/**
 * Pattern icon orientation: the cylindrical thumbnail (js/icon-generator.js) must be the same
 * top-down picture as the 3D viewer's "Top Down" view and MATLAB design_arena: south (behind
 * the fly) at the bottom, front at the top, columns running clockwise from c0.
 *
 * The canvas y axis points down, so math angles drawn directly mirrored the icon top-to-bottom
 * (gap at the top, columns counter-clockwise). This test stubs a 2D canvas, records every arc,
 * and checks where the lit pattern blocks land for every standard config, against the 3D
 * viewer's column placement (three-viewer.js _buildArena).
 */
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const { STANDARD_CONFIGS, PANEL_SPECS } = require('../js/arena-configs.js');
globalThis.PANEL_SPECS = PANEL_SPECS;

let checks = 0;
let failures = 0;

function check(name, condition, detail) {
    checks++;
    if (condition) {
        console.log(`  PASS  ${name}`);
        return;
    }
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A canvas stub whose 2D context records each filled path's style and first arc. */
function recordingCanvas() {
    const paths = [];
    let current = null;
    const ctx = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        scale() {},
        fillRect() {},
        beginPath() {
            current = { arcs: [] };
        },
        arc(x, y, r, a0, a1) {
            if (current) current.arcs.push({ r, a0, a1 });
        },
        closePath() {},
        fill() {
            if (current) paths.push({ style: ctx.fillStyle, arcs: current.arcs });
        },
        moveTo() {},
        lineTo() {},
        stroke() {}
    };
    return {
        paths,
        canvas: { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:' }
    };
}

const deg = (r) => (r * 180) / Math.PI;
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Fly-centric azimuth of a canvas angle: 0 = up (front), + = right (the fly's right). */
function azimuthOfCanvasAngle(theta) {
    return wrap(deg(Math.atan2(Math.cos(theta), -Math.sin(theta))));
}

/** Circular mean of the arc midpoints of the paths drawn in `style`. */
function meanAzimuth(paths, style) {
    let sx = 0;
    let sy = 0;
    for (const p of paths) {
        if (p.style !== style || p.arcs.length === 0) continue;
        const mid = (p.arcs[0].a0 + p.arcs[0].a1) / 2;
        sx += Math.cos(mid);
        sy += Math.sin(mid);
    }
    return azimuthOfCanvasAngle(Math.atan2(sy, sx));
}

/** The 3D viewer's column-centre azimuth (three-viewer.js _buildArena; north = front). */
function viewerAzimuth(arena, col) {
    const alpha = 360 / arena.num_cols;
    const off = arena.angle_offset_deg || 0;
    const angle =
        arena.column_order === 'ccw'
            ? -90 + alpha / 2 + col * alpha + off
            : -90 - alpha / 2 - col * alpha + off;
    return wrap(90 - angle);
}

(async () => {
    const icons = await import(pathToFileURL(path.join(ROOT, 'js', 'icon-generator.js')).href);

    console.log('\n=== icon column placement matches the 3D top-down view ===');
    for (const [name, cfg] of Object.entries(STANDARD_CONFIGS)) {
        const arena = cfg.arena;
        const ppp = PANEL_SPECS[arena.generation].pixels_per_panel;
        const installed = arena.columns_installed || [...Array(arena.num_cols).keys()];
        const W = installed.length * ppp;
        const H = arena.num_rows * ppp;
        const frame = new Uint8Array(W * H);
        // block 0 at full brightness, block 1 at half, the rest dark
        for (let r = 0; r < H; r++) {
            for (let c = 0; c < ppp; c++) frame[r * W + c] = 15;
            for (let c = ppp; c < 2 * ppp; c++) frame[r * W + c] = 7;
        }
        const rec = recordingCanvas();
        globalThis.document = { createElement: () => rec.canvas };
        icons.generatePatternIcon(
            { frames: [frame], pixelRows: H, pixelCols: W, gs_val: 16 },
            arena,
            {
                width: 200,
                height: 200,
                supersample: 1
            }
        );
        const styles = [...new Set(rec.paths.map((p) => p.style))];
        // block 0 / block 1 are the two lit fill styles, brightest first (green channel)
        const green = (s) => Number((/rgb\(\s*\d+,\s*(\d+)/.exec(s) || [])[1] || 0);
        const lit = styles.filter((s) => green(s) > 0).sort((a, b) => green(b) - green(a));
        const az0 = lit[0] ? meanAzimuth(rec.paths, lit[0]) : NaN;
        const az1 = lit[1] ? meanAzimuth(rec.paths, lit[1]) : NaN;
        const want0 = viewerAzimuth(arena, installed[0]);
        const want1 = viewerAzimuth(arena, installed[1]);
        check(
            `${name}: column 1 at ${want0.toFixed(0)}° (3D viewer)`,
            Math.abs(wrap(az0 - want0)) < 1,
            `icon puts it at ${az0.toFixed(1)}°`
        );
        check(
            `${name}: column 2 follows clockwise, at ${want1.toFixed(0)}°`,
            Math.abs(wrap(az1 - want1)) < 1,
            `icon puts it at ${az1.toFixed(1)}°`
        );
    }

    console.log('\n=== partial arenas: the gap is behind the fly (bottom of the icon) ===');
    for (const name of ['G6_2x8of10', 'G6_3x12of18', 'G4_3x12of18']) {
        const arena = STANDARD_CONFIGS[name].arena;
        const installed = arena.columns_installed;
        const first = viewerAzimuth(arena, installed[0]);
        const last = viewerAzimuth(arena, installed[installed.length - 1]);
        check(
            `${name}: installed span is symmetric about the front (${first.toFixed(0)}° … ${last.toFixed(0)}°)`,
            Math.abs(first + last) < 1e-9 && first < 0
        );
    }

    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
        console.log(`${failures} FAILED`);
        process.exit(1);
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
