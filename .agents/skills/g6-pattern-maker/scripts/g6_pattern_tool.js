#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TOOL_VERSION = '0.1.0';

function fail(message) {
    throw new Error(message);
}

function loadTools() {
    const roots = [];
    const addAncestors = (start) => {
        if (!start) return;
        let current = path.resolve(start);
        while (true) {
            roots.push(current);
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    };

    // Prefer an explicit override, then discover the checkout from the installed
    // skill location and the caller's working directory. This keeps the skill
    // portable across clones, worktrees, Codex, and Claude Code.
    if (process.env.WEBDISPLAYTOOLS_DIR) roots.push(path.resolve(process.env.WEBDISPLAYTOOLS_DIR));
    addAncestors(__dirname);
    addAncestors(process.cwd());

    const seen = new Set();
    for (const root of roots) {
        if (seen.has(root)) continue;
        seen.add(root);
        const encoderPath = path.join(root, 'js', 'pat-encoder.js');
        const parserPath = path.join(root, 'js', 'pat-parser.js');
        if (!fs.existsSync(encoderPath) || !fs.existsSync(parserPath)) continue;
        try {
            const encoder = require(encoderPath);
            const parserModule = require(parserPath);
            const parser = parserModule.default || parserModule;
            if (encoder.encode && parser.parsePatFile) return { root, encoder, parser };
        } catch (_) {
            // Try the next compatible checkout.
        }
    }
    fail(
        'Cannot locate js/pat-encoder.js and js/pat-parser.js in this webDisplayTools checkout; set WEBDISPLAYTOOLS_DIR only when running the skill outside the repository.'
    );
}

const tools = loadTools();

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, stable(value[key])])
        );
    }
    return value;
}

function jsonText(value) {
    return JSON.stringify(stable(value), null, 2) + '\n';
}

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256Object(value) {
    return sha256Bytes(Buffer.from(jsonText(value)));
}

function merge(base, override) {
    if (!base || typeof base !== 'object' || Array.isArray(base)) return override;
    if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        out[key] = key in base ? merge(base[key], value) : value;
    }
    return out;
}

function integer(value, label, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
        fail(`${label} must be an integer in [${min}, ${max}], got ${value}`);
    }
    return value;
}

function number(value, label) {
    if (!Number.isFinite(value)) fail(`${label} must be finite, got ${value}`);
    return value;
}

function normalizeSpec(raw) {
    const spec = JSON.parse(JSON.stringify(raw));
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(spec.name || '')) {
        fail('name is required and may contain only letters, digits, dot, underscore, and hyphen');
    }
    spec.arena = merge(
        {
            generation: 'G6',
            panel_rows: 2,
            panel_columns: 10,
            front_column_px: null,
            arena_id: 0,
            observer_id: 0
        },
        spec.arena || {}
    );
    if (spec.arena.generation !== 'G6') fail('This skill supports generation G6 only');
    integer(spec.arena.panel_rows, 'arena.panel_rows', 1, 48);
    integer(spec.arena.panel_columns, 'arena.panel_columns', 1, 48);
    if (spec.arena.panel_rows * spec.arena.panel_columns > 48) {
        fail('Dense G6 arenas may contain at most 48 panels');
    }
    spec.pixel_height = spec.arena.panel_rows * 20;
    spec.pixel_width = spec.arena.panel_columns * 20;
    if (spec.arena.front_column_px === null)
        spec.arena.front_column_px = spec.pixel_width / 2 - 0.5;
    number(spec.arena.front_column_px, 'arena.front_column_px');
    integer(spec.arena.arena_id, 'arena.arena_id', 0, 63);
    integer(spec.arena.observer_id, 'arena.observer_id', 0, 63);

    spec.encoding = merge({ gs_levels: 16, duty_cycle: 128 }, spec.encoding || {});
    if (![2, 16].includes(spec.encoding.gs_levels)) fail('encoding.gs_levels must be 2 or 16');
    integer(spec.encoding.duty_cycle, 'encoding.duty_cycle', 0, 255);
    spec.canvas = merge({ background: spec.encoding.gs_levels === 16 ? 0 : 0 }, spec.canvas || {});
    const maxValue = spec.encoding.gs_levels - 1;
    integer(spec.canvas.background, 'canvas.background', 0, maxValue);
    integer(spec.frame_count, 'frame_count', 1, 65535);
    spec.motion = merge(
        { type: 'static', pixels_per_frame: 0, start_offset_px: 0 },
        spec.motion || {}
    );
    if (!['static', 'horizontal_translation'].includes(spec.motion.type))
        fail(`Unknown motion.type: ${spec.motion.type}`);
    number(spec.motion.pixels_per_frame, 'motion.pixels_per_frame');
    number(spec.motion.start_offset_px, 'motion.start_offset_px');
    spec.rasterization = merge({ pixel_center_offset: 0.5 }, spec.rasterization || {});
    number(spec.rasterization.pixel_center_offset, 'rasterization.pixel_center_offset');
    if (!Array.isArray(spec.layers)) fail('layers must be an array');
    return spec;
}

function circularDelta(value, center, period) {
    let d = ((((value - center + period / 2) % period) + period) % period) - period / 2;
    if (d < -period / 2) d += period;
    return d;
}

function seededShuffle(values, seed) {
    let state = seed >>> 0;
    const out = values.slice();
    const next = () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function metric(layer, stem, spec, fallback = undefined) {
    if (layer[`${stem}_px`] !== undefined)
        return number(layer[`${stem}_px`], `${layer.type}.${stem}_px`);
    if (layer[`${stem}_deg`] !== undefined) {
        return (number(layer[`${stem}_deg`], `${layer.type}.${stem}_deg`) * spec.pixel_width) / 360;
    }
    if (fallback !== undefined) return fallback;
    fail(`${layer.type} requires ${stem}_px or ${stem}_deg`);
}

function center(layer, spec, frameIndex) {
    const translation =
        spec.motion.type === 'horizontal_translation'
            ? spec.motion.start_offset_px + frameIndex * spec.motion.pixels_per_frame
            : spec.motion.start_offset_px;
    const x =
        layer.x_px !== undefined
            ? number(layer.x_px, `${layer.type}.x_px`)
            : spec.arena.front_column_px + metric(layer, 'x', spec, 0);
    const y =
        (spec.pixel_height - 1) / 2 +
        spec.rasterization.pixel_center_offset +
        metric(layer, 'y', spec, 0);
    return { x: x + translation, y };
}

function blend(frame, idx, target, coverage, maxValue) {
    const cov = Math.max(0, Math.min(1, coverage));
    const value = Math.round(frame[idx] + (target - frame[idx]) * cov);
    frame[idx] = Math.max(0, Math.min(maxValue, value));
}

function layerCopies(layer) {
    if (!layer.copies) return [layer];
    if (!Array.isArray(layer.copies) || layer.copies.length === 0)
        fail(`${layer.type}.copies must be a nonempty array`);
    const base = { ...layer };
    delete base.copies;
    return [base, ...layer.copies.map((copy) => merge(base, copy))];
}

function cotDeg(deg) {
    return 1 / Math.tan((deg * Math.PI) / 180);
}

function loomDiameter(layer, frameIndex) {
    const motionFrames = integer(layer.motion_frames, `${layer.type}.motion_frames`, 2, 65535);
    const holdFrames = integer(layer.hold_frames || 0, `${layer.type}.hold_frames`, 0, 65535);
    if (frameIndex >= motionFrames + holdFrames) return null;
    const i = Math.min(frameIndex, motionFrames - 1);
    const t = i / (motionFrames - 1);
    const start = cotDeg(
        number(layer.initial_diameter_deg, `${layer.type}.initial_diameter_deg`) / 2
    );
    const end = cotDeg(number(layer.final_diameter_deg, `${layer.type}.final_diameter_deg`) / 2);
    return (2 * Math.atan(1 / (start + (end - start) * t)) * 180) / Math.PI;
}

function drawShape(frame, layer, spec, frameIndex) {
    const width = spec.pixel_width;
    const height = spec.pixel_height;
    const maxValue = spec.encoding.gs_levels - 1;
    const value = integer(layer.value, `${layer.type}.value`, 0, maxValue);
    const c = center(layer, spec, frameIndex);
    const aa = integer(layer.antialias_samples || 1, `${layer.type}.antialias_samples`, 1, 16);

    let loomPx = null;
    if (layer.type.startsWith('loom_')) {
        const diameter = loomDiameter(layer, frameIndex);
        if (diameter === null) return;
        loomPx = (diameter * width) / 360;
    }

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            let covered = 0;
            for (let sy = 0; sy < aa; sy++) {
                for (let sx = 0; sx < aa; sx++) {
                    const px = col + spec.rasterization.pixel_center_offset - 0.5 + (sx + 0.5) / aa;
                    const py = row + spec.rasterization.pixel_center_offset - 0.5 + (sy + 0.5) / aa;
                    const dx = circularDelta(px, c.x, width);
                    const dy = py - c.y;
                    let inside = false;
                    if (layer.type === 'rect') {
                        inside =
                            Math.abs(dx) <= metric(layer, 'width', spec) / 2 &&
                            Math.abs(dy) <= metric(layer, 'height', spec) / 2;
                    } else if (layer.type === 'oblique') {
                        const root2 = Math.sqrt(2);
                        const forward = layer.orientation === 'forward';
                        if (!forward && layer.orientation !== 'backward')
                            fail('oblique.orientation must be forward or backward');
                        const along = forward ? (dx - dy) / root2 : (dx + dy) / root2;
                        const across = forward ? (dx + dy) / root2 : (dy - dx) / root2;
                        inside =
                            Math.abs(along) <= metric(layer, 'length', spec) / 2 &&
                            Math.abs(across) <= metric(layer, 'thickness', spec) / 2;
                    } else if (
                        layer.type === 'disc' ||
                        layer.type === 'loom_disc' ||
                        layer.type === 'loom_dots'
                    ) {
                        const diameter = loomPx === null ? metric(layer, 'diameter', spec) : loomPx;
                        inside = Math.hypot(dx, dy) <= diameter / 2;
                    } else if (layer.type === 'annulus' || layer.type === 'loom_annulus') {
                        const outer =
                            loomPx === null ? metric(layer, 'outer_diameter', spec) : loomPx;
                        const thickness =
                            layer.type === 'loom_annulus'
                                ? metric(layer, 'annulus_thickness', spec)
                                : metric(layer, 'thickness', spec);
                        const r = Math.hypot(dx, dy);
                        inside = r <= outer / 2 && r >= Math.max(0, outer / 2 - thickness);
                    }
                    if (inside) covered++;
                }
            }
            if (covered) blend(frame, row * width + col, value, covered / (aa * aa), maxValue);
        }
    }

    if (layer.type === 'loom_dots') {
        const candidates = [];
        for (let i = 0; i < frame.length; i++)
            if (frame[i] !== spec.canvas.background) candidates.push(i);
        const salt = integer(layer.seed_salt || 0, 'loom_dots.seed_salt', 0, 0xffffffff);
        const shuffled = seededShuffle(candidates, salt);
        let darkness = 0;
        for (const i of candidates) darkness += Math.abs(spec.canvas.background - frame[i]);
        frame.fill(spec.canvas.background);
        for (const i of shuffled) {
            if (darkness <= 0) break;
            const amount = Math.min(Math.abs(spec.canvas.background - value), darkness);
            frame[i] =
                value < spec.canvas.background
                    ? spec.canvas.background - amount
                    : spec.canvas.background + amount;
            darkness -= amount;
        }
    }
}

function drawLayer(frame, layer, spec, frameIndex) {
    const width = spec.pixel_width;
    const height = spec.pixel_height;
    const maxValue = spec.encoding.gs_levels - 1;
    if (layer.type === 'square_grating') {
        const period = metric(layer, 'period', spec);
        const phaseReference = layer.phase_reference || 'column_zero';
        if (!['column_zero', 'front'].includes(phaseReference))
            fail('square_grating.phase_reference must be column_zero or front');
        const referenceOffset = phaseReference === 'front' ? spec.arena.front_column_px : 0;
        const phase =
            referenceOffset +
            metric(layer, 'phase', spec, 0) +
            spec.motion.start_offset_px +
            frameIndex * spec.motion.pixels_per_frame;
        const duty =
            layer.duty_fraction === undefined
                ? 0.5
                : number(layer.duty_fraction, 'square_grating.duty_fraction');
        if (!(duty > 0 && duty < 1)) fail('square_grating.duty_fraction must be between 0 and 1');
        const on = integer(layer.on_value, 'square_grating.on_value', 0, maxValue);
        const off = integer(layer.off_value, 'square_grating.off_value', 0, maxValue);
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const wrapped = (((col + 0.5 - phase) % period) + period) % period;
                frame[row * width + col] = wrapped < period * duty ? on : off;
            }
        }
        return;
    }

    if (layer.type === 'checker_grid') {
        const rows = integer(layer.rows, 'checker_grid.rows', 1, 1000);
        const columns = integer(layer.columns, 'checker_grid.columns', 1, 1000);
        const cell = metric(layer, 'cell_size', spec);
        const gap = metric(layer, 'gap', spec, 0);
        const values = layer.values || [0, maxValue];
        values.forEach((v, i) => integer(v, `checker_grid.values[${i}]`, 0, maxValue));
        let assignments;
        if (layer.balanced) {
            if ((rows * columns) % values.length !== 0)
                fail('balanced checker_grid requires cell count divisible by values.length');
            const perValue = (rows * columns) / values.length;
            assignments = values.flatMap((value) => Array(perValue).fill(value));
            assignments = seededShuffle(
                assignments,
                integer(layer.seed, 'checker_grid.seed', 0, 0xffffffff)
            );
        } else {
            let state = integer(layer.seed, 'checker_grid.seed', 0, 0xffffffff) >>> 0;
            assignments = Array.from({ length: rows * columns }, () => {
                state = (Math.imul(1664525, state) + 1013904223) >>> 0;
                return values[Math.floor((state / 0x100000000) * values.length)];
            });
        }
        const totalW = columns * cell + (columns - 1) * gap;
        const totalH = rows * cell + (rows - 1) * gap;
        const anchor = layer.anchor || 'center';
        if (!['center', 'lower_left'].includes(anchor))
            fail('checker_grid.anchor must be center or lower_left');
        let left, bottom;
        if (anchor === 'lower_left') {
            if (layer.x_px === undefined || layer.y_px === undefined)
                fail('checker_grid lower_left anchor requires x_px and y_px');
            const translation =
                spec.motion.type === 'horizontal_translation'
                    ? spec.motion.start_offset_px + frameIndex * spec.motion.pixels_per_frame
                    : spec.motion.start_offset_px;
            left = number(layer.x_px, 'checker_grid.x_px') + translation;
            bottom = number(layer.y_px, 'checker_grid.y_px');
        } else {
            const c = center(layer, spec, frameIndex);
            left = c.x - totalW / 2;
            bottom = c.y - totalH / 2;
        }
        for (let r = 0; r < rows; r++) {
            for (let q = 0; q < columns; q++) {
                const x = left + cell / 2 + q * (cell + gap);
                const y = bottom + cell / 2 + r * (cell + gap);
                const staticSpec = {
                    ...spec,
                    motion: { type: 'static', pixels_per_frame: 0, start_offset_px: 0 }
                };
                const verticalCenter = (height - 1) / 2 + spec.rasterization.pixel_center_offset;
                drawShape(
                    frame,
                    {
                        type: 'rect',
                        x_px: x,
                        y_px: y - verticalCenter,
                        width_px: cell,
                        height_px: cell,
                        value: assignments[r * columns + q]
                    },
                    staticSpec,
                    0
                );
            }
        }
        return;
    }

    if (layer.type === 'barberpole') {
        const c = center(layer, spec, frameIndex);
        const rectW = metric(layer, 'width', spec);
        const rectH = metric(layer, 'height', spec);
        const period = number(layer.stripe_period_px, 'barberpole.stripe_period_px');
        const slope = number(layer.slope, 'barberpole.slope');
        const a = integer(layer.value_a, 'barberpole.value_a', 0, maxValue);
        const b = integer(layer.value_b, 'barberpole.value_b', 0, maxValue);
        for (let row = 0; row < height; row++)
            for (let col = 0; col < width; col++) {
                const dx = circularDelta(col + 0.5, c.x, width);
                const dy = row + 0.5 - c.y;
                if (Math.abs(dx) <= rectW / 2 && Math.abs(dy) <= rectH / 2) {
                    const stripe = ((Math.floor((dy + dx * slope) / period) % 2) + 2) % 2;
                    frame[row * width + col] = stripe ? a : b;
                }
            }
        return;
    }

    if (layer.type === 'horizontal_profile') {
        const c = center(layer, spec, frameIndex);
        const profileW = metric(layer, 'width', spec);
        const bg = integer(layer.background, 'horizontal_profile.background', 0, maxValue);
        const dark = integer(layer.dark, 'horizontal_profile.dark', 0, maxValue);
        const bright = integer(
            layer.bright === undefined ? maxValue : layer.bright,
            'horizontal_profile.bright',
            0,
            maxValue
        );
        for (let row = 0; row < height; row++)
            for (let col = 0; col < width; col++) {
                const dx = circularDelta(col + 0.5, c.x, width);
                if (Math.abs(dx) >= profileW / 2) continue;
                const strength = 1 - Math.abs(dx) / (profileW / 2);
                let v;
                if (layer.profile === 'peak') v = bg + (dark - bg) * strength;
                else if (layer.profile === 'edge')
                    v = dx < 0 ? bg + (dark - bg) * strength : bg + (bright - bg) * strength;
                else fail('horizontal_profile.profile must be edge or peak');
                frame[row * width + col] = Math.round(v);
            }
        return;
    }

    if (
        !['rect', 'oblique', 'disc', 'annulus', 'loom_disc', 'loom_annulus', 'loom_dots'].includes(
            layer.type
        )
    ) {
        fail(`Unknown layer type: ${layer.type}`);
    }
    drawShape(frame, layer, spec, frameIndex);
}

function render(spec) {
    const frames = [];
    for (let f = 0; f < spec.frame_count; f++) {
        const frame = new Uint8Array(spec.pixel_width * spec.pixel_height);
        frame.fill(spec.canvas.background);
        for (const original of spec.layers) {
            for (const layer of layerCopies(original)) drawLayer(frame, layer, spec, f);
        }
        frames.push(frame);
    }
    const duty =
        spec.encoding.duty_cycle_by_frame || Array(spec.frame_count).fill(spec.encoding.duty_cycle);
    if (!Array.isArray(duty) || duty.length !== spec.frame_count)
        fail('duty_cycle_by_frame must match frame_count');
    duty.forEach((v, i) => integer(v, `duty_cycle_by_frame[${i}]`, 0, 255));
    return { frames, duty };
}

function arrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function parseStrict(filePath) {
    const bytes = fs.readFileSync(filePath);
    return tools.parser.parsePatFile(arrayBuffer(bytes), { strict: true });
}

function parseStrictQuiet(bytes) {
    const originalLog = console.log;
    console.log = () => {};
    try {
        return tools.parser.parsePatFile(arrayBuffer(bytes), { strict: true });
    } finally {
        console.log = originalLog;
    }
}

function validateAssertions(spec, frames) {
    const checks = [];
    const add = (name, pass, detail) => {
        checks.push({ name, pass, detail });
        if (!pass) fail(`${name}: ${detail}`);
    };
    const a = spec.assertions || {};
    if (a.expected_frame_count !== undefined)
        add('expected_frame_count', frames.length === a.expected_frame_count, `${frames.length}`);
    if (a.allowed_values) {
        const allowed = new Set(a.allowed_values);
        const bad = frames.some((frame) => Array.from(frame).some((v) => !allowed.has(v)));
        add(
            'allowed_values',
            !bad,
            bad ? 'found a value outside allowed_values' : 'all pixels allowed'
        );
    }
    if (a.repeat_after_frames !== undefined) {
        const n = integer(
            a.repeat_after_frames,
            'assertions.repeat_after_frames',
            1,
            frames.length - 1
        );
        let pass = true;
        for (let i = 0; i + n < frames.length && pass; i++) {
            pass = Buffer.compare(Buffer.from(frames[i]), Buffer.from(frames[i + n])) === 0;
        }
        add('repeat_after_frames', pass, `offset ${n}`);
    }
    const fractions = frames.map(
        (frame) =>
            Array.from(frame).filter((v) => v !== spec.canvas.background).length / frame.length
    );
    if (a.min_non_background_fraction !== undefined)
        add(
            'min_non_background_fraction',
            Math.min(...fractions) >= a.min_non_background_fraction,
            `${Math.min(...fractions)}`
        );
    if (a.max_non_background_fraction !== undefined)
        add(
            'max_non_background_fraction',
            Math.max(...fractions) <= a.max_non_background_fraction,
            `${Math.max(...fractions)}`
        );
    return checks;
}

function generateOne(rawSpec, outDir) {
    const spec = normalizeSpec(rawSpec);
    const { frames, duty } = render(spec);
    const patternData = {
        generation: 'G6',
        gs_val: spec.encoding.gs_levels,
        numFrames: spec.frame_count,
        rowCount: spec.arena.panel_rows,
        colCount: spec.arena.panel_columns,
        pixelRows: spec.pixel_height,
        pixelCols: spec.pixel_width,
        frames,
        stretchValues: duty,
        arena_id: spec.arena.arena_id,
        observer_id: spec.arena.observer_id
    };
    const encoded = Buffer.from(new Uint8Array(tools.encoder.encode(patternData)));
    const sourceAssertionChecks = validateAssertions(spec, frames);
    const patPath = path.join(outDir, `${spec.name}.pat`);
    const specPath = path.join(outDir, `${spec.name}.spec.json`);
    const provenancePath = path.join(outDir, `${spec.name}.provenance.json`);
    const parsed = tools.parser.parsePatFile(arrayBuffer(encoded), { strict: true });
    const metadataPass =
        parsed.generation === 'G6' &&
        parsed.gs_val === spec.encoding.gs_levels &&
        parsed.numFrames === spec.frame_count &&
        parsed.pixelRows === spec.pixel_height &&
        parsed.pixelCols === spec.pixel_width;
    if (!metadataPass) fail(`${spec.name}: parsed metadata does not match source`);
    for (let i = 0; i < frames.length; i++) {
        if (Buffer.compare(Buffer.from(frames[i]), Buffer.from(parsed.frames[i])) !== 0)
            fail(`${spec.name}: round-trip pixel mismatch in frame ${i}`);
    }
    const assertionChecks = validateAssertions(spec, parsed.frames);
    const provenance = {
        tool: 'g6-pattern-maker',
        tool_version: TOOL_VERSION,
        generated_at: new Date().toISOString(),
        webdisplaytools_root: tools.root,
        source_spec_sha256: sha256Object(spec),
        pat_sha256: sha256Bytes(encoded),
        parsed: {
            generation: parsed.generation,
            header_version: parsed.headerVersion,
            gs_levels: parsed.gs_val,
            panel_rows: parsed.rowCount,
            panel_columns: parsed.colCount,
            pixel_height: parsed.pixelRows,
            pixel_width: parsed.pixelCols,
            frame_count: parsed.numFrames,
            duty_cycle_min: Math.min(...parsed.stretchValues),
            duty_cycle_max: Math.max(...parsed.stretchValues)
        },
        validation: {
            strict_parse: true,
            metadata_match: true,
            decoded_pixels_match: true,
            source_assertions: sourceAssertionChecks,
            assertions: assertionChecks
        },
        notes: spec.notes || []
    };
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(patPath, encoded);
    fs.writeFileSync(specPath, jsonText(spec));
    fs.writeFileSync(provenancePath, jsonText(provenance));
    return { name: spec.name, patPath, specPath, provenancePath, provenance };
}

function generate(specPath, outDir) {
    const root = readJson(specPath);
    let specs;
    if (Array.isArray(root.patterns))
        specs = root.patterns.map((item) => merge(root.defaults || {}, item));
    else specs = [root];
    const results = specs.map((spec) => generateOne(spec, outDir));
    console.log(
        JSON.stringify(
            results.map((r) => ({ name: r.name, pat: r.patPath, sha256: r.provenance.pat_sha256 })),
            null,
            2
        )
    );
}

function inspect(filePath) {
    const parsed = parseStrict(filePath);
    const bytes = fs.readFileSync(filePath);
    const counts = new Map();
    for (const frame of parsed.frames)
        for (const v of frame) counts.set(v, (counts.get(v) || 0) + 1);
    console.log(
        JSON.stringify(
            {
                file: path.resolve(filePath),
                sha256: sha256Bytes(bytes),
                generation: parsed.generation,
                header_version: parsed.headerVersion,
                gs_levels: parsed.gs_val,
                panel_rows: parsed.rowCount,
                panel_columns: parsed.colCount,
                pixel_height: parsed.pixelRows,
                pixel_width: parsed.pixelCols,
                frame_count: parsed.numFrames,
                duty_cycle_min: Math.min(...parsed.stretchValues),
                duty_cycle_max: Math.max(...parsed.stretchValues),
                pixel_histogram: Object.fromEntries(
                    [...counts.entries()].sort((a, b) => a[0] - b[0])
                )
            },
            null,
            2
        )
    );
}

function compare(aPath, bPath) {
    const a = parseStrict(aPath);
    const b = parseStrict(bPath);
    const metadataMatch =
        a.gs_val === b.gs_val &&
        a.numFrames === b.numFrames &&
        a.pixelRows === b.pixelRows &&
        a.pixelCols === b.pixelCols;
    let equal = metadataMatch;
    let differences = 0;
    let absError = 0;
    let total = 0;
    if (metadataMatch) {
        for (let f = 0; f < a.numFrames; f++)
            for (let i = 0; i < a.frames[f].length; i++) {
                const d = Math.abs(a.frames[f][i] - b.frames[f][i]);
                if (d) {
                    equal = false;
                    differences++;
                }
                absError += d;
                total++;
            }
    }
    console.log(
        JSON.stringify(
            {
                metadata_match: metadataMatch,
                decoded_equal: equal,
                differing_pixels: differences,
                pixel_agreement: total ? 1 - differences / total : null,
                mean_absolute_error: total ? absError / total : null
            },
            null,
            2
        )
    );
    if (!equal) process.exitCode = 2;
}

function findPatFiles(directory, recursive = true) {
    const files = [];
    const visit = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory() && recursive) visit(fullPath);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pat'))
                files.push(fullPath);
        }
    };
    visit(directory);
    return files.sort((a, b) => a.localeCompare(b));
}

function logicalPatName(filePath) {
    return path.basename(filePath, path.extname(filePath)).replace(/^\d+_/, '');
}

function decodedMetrics(candidate, reference) {
    const metadataMatch =
        candidate.gs_val === reference.gs_val &&
        candidate.numFrames === reference.numFrames &&
        candidate.pixelRows === reference.pixelRows &&
        candidate.pixelCols === reference.pixelCols;
    if (!metadataMatch) {
        return {
            metadata_match: false,
            decoded_equal: false,
            differing_pixels: null,
            pixel_agreement: null
        };
    }
    let differences = 0;
    let total = 0;
    for (let frame = 0; frame < candidate.numFrames; frame++) {
        for (let pixel = 0; pixel < candidate.frames[frame].length; pixel++) {
            if (candidate.frames[frame][pixel] !== reference.frames[frame][pixel]) differences++;
            total++;
        }
    }
    return {
        metadata_match: true,
        decoded_equal: differences === 0,
        differing_pixels: differences,
        pixel_agreement: total ? 1 - differences / total : 1
    };
}

function scoreLibrary(candidateDirectory, referenceDirectory, reportPath) {
    const candidateRoot = path.resolve(candidateDirectory);
    const referenceRoot = path.resolve(referenceDirectory);
    const byName = (root) => {
        const map = new Map();
        for (const filePath of findPatFiles(root, false)) {
            const name = logicalPatName(filePath);
            if (map.has(name)) fail(`Duplicate logical name in flat library: ${name}`);
            map.set(name, filePath);
        }
        return map;
    };
    const candidates = byName(candidateRoot);
    const references = byName(referenceRoot);
    const results = [];
    for (const [name, referencePath] of references) {
        const candidatePath = candidates.get(name);
        if (!candidatePath) continue;
        const candidateBytes = fs.readFileSync(candidatePath);
        const referenceBytes = fs.readFileSync(referencePath);
        const metrics = decodedMetrics(
            parseStrictQuiet(candidateBytes),
            parseStrictQuiet(referenceBytes)
        );
        results.push({
            name,
            candidate: path.relative(candidateRoot, candidatePath),
            reference: path.relative(referenceRoot, referencePath),
            bytes_equal: Buffer.compare(candidateBytes, referenceBytes) === 0,
            ...metrics
        });
    }
    const missing = [...references.keys()].filter((name) => !candidates.has(name));
    const extra = [...candidates.keys()].filter((name) => !references.has(name));
    const agreements = results
        .map((result) => result.pixel_agreement)
        .filter((value) => value !== null);
    const report = {
        candidate_root: candidateRoot,
        reference_root: referenceRoot,
        reference_count: references.size,
        candidate_count: candidates.size,
        matched_count: results.length,
        exact_bytes_count: results.filter((result) => result.bytes_equal).length,
        decoded_equal_count: results.filter((result) => result.decoded_equal).length,
        mean_pixel_agreement: agreements.length
            ? agreements.reduce((sum, value) => sum + value, 0) / agreements.length
            : null,
        missing,
        extra,
        results
    };
    const output = jsonText(report);
    if (reportPath) fs.writeFileSync(reportPath, output);
    process.stdout.write(output);
}

function auditLibrary(directory, manifestPath) {
    const root = path.resolve(directory);
    if (!fs.statSync(root).isDirectory()) fail(`Not a directory: ${root}`);
    const files = findPatFiles(root).map((filePath) => {
        const bytes = fs.readFileSync(filePath);
        const parsed = parseStrictQuiet(bytes);
        return {
            path: path.relative(root, filePath),
            sha256: sha256Bytes(bytes),
            generation: parsed.generation,
            gs_levels: parsed.gs_val,
            panel_rows: parsed.rowCount,
            panel_columns: parsed.colCount,
            pixel_height: parsed.pixelRows,
            pixel_width: parsed.pixelCols,
            frame_count: parsed.numFrames,
            duty_cycle_min: Math.min(...parsed.stretchValues),
            duty_cycle_max: Math.max(...parsed.stretchValues)
        };
    });
    const hashes = new Map();
    for (const file of files) {
        if (!hashes.has(file.sha256)) hashes.set(file.sha256, []);
        hashes.get(file.sha256).push(file.path);
    }
    const duplicateGroups = [...hashes.values()].filter((paths) => paths.length > 1);
    const manifest = {
        root,
        file_count: files.length,
        unique_sha256_count: hashes.size,
        duplicate_groups: duplicateGroups,
        files
    };
    const output = jsonText(manifest);
    if (manifestPath) fs.writeFileSync(manifestPath, output);
    process.stdout.write(output);
}

function encodeParsed(parsed, frames) {
    return Buffer.from(
        new Uint8Array(
            tools.encoder.encode({
                generation: 'G6',
                gs_val: parsed.gs_val,
                numFrames: frames.length,
                rowCount: parsed.rowCount,
                colCount: parsed.colCount,
                pixelRows: parsed.pixelRows,
                pixelCols: parsed.pixelCols,
                frames,
                stretchValues: parsed.stretchValues,
                arena_id: parsed.arena_id || 0,
                observer_id: parsed.observer_id || 0
            })
        )
    );
}

function phaseShift(sourcePath, outPath, shiftText) {
    const parsed = parseStrict(sourcePath);
    const shift = integer(Number(shiftText), 'shift_frames', 0, parsed.numFrames - 1);
    const frames = Array.from(
        { length: parsed.numFrames },
        (_, i) => parsed.frames[(i + shift) % parsed.numFrames]
    );
    const shiftedDuty = Array.from(
        { length: parsed.numFrames },
        (_, i) => parsed.stretchValues[(i + shift) % parsed.numFrames]
    );
    const encoded = Buffer.from(
        new Uint8Array(
            tools.encoder.encode({
                generation: 'G6',
                gs_val: parsed.gs_val,
                numFrames: frames.length,
                rowCount: parsed.rowCount,
                colCount: parsed.colCount,
                pixelRows: parsed.pixelRows,
                pixelCols: parsed.pixelCols,
                frames,
                stretchValues: shiftedDuty,
                arena_id: parsed.arena_id || 0,
                observer_id: parsed.observer_id || 0
            })
        )
    );
    fs.writeFileSync(outPath, encoded);
    parseStrict(outPath);
    console.log(
        JSON.stringify(
            {
                source: path.resolve(sourcePath),
                output: path.resolve(outPath),
                shift_frames: shift
            },
            null,
            2
        )
    );
}

function preview(patPath, gifPath) {
    const parsed = parseStrict(patPath);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g6-pattern-preview-'));
    try {
        const max = parsed.gs_val - 1;
        for (let i = 0; i < parsed.frames.length; i++) {
            const header = Buffer.from(`P5\n${parsed.pixelCols} ${parsed.pixelRows}\n255\n`);
            const pixels = Buffer.alloc(parsed.frames[i].length);
            for (let j = 0; j < pixels.length; j++)
                pixels[j] = Math.round((parsed.frames[i][j] / max) * 255);
            fs.writeFileSync(
                path.join(tmp, `frame-${String(i).padStart(5, '0')}.pgm`),
                Buffer.concat([header, pixels])
            );
        }
        const input = path.join(tmp, 'frame-%05d.pgm');
        execFileSync('ffmpeg', [
            '-y',
            '-loglevel',
            'error',
            '-framerate',
            '20',
            '-i',
            input,
            '-vf',
            'vflip,scale=1000:-1:flags=neighbor',
            '-loop',
            '0',
            gifPath
        ]);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(
        JSON.stringify(
            {
                source: path.resolve(patPath),
                preview: path.resolve(gifPath),
                derived_from_pat: true
            },
            null,
            2
        )
    );
}

function usage() {
    console.error(
        'Usage: g6_pattern_tool.js generate SPEC.json OUT_DIR | inspect FILE.pat | compare A.pat B.pat | audit-library DIR [MANIFEST.json] | score-library CANDIDATES REFERENCES [REPORT.json] | phase-shift SOURCE.pat OUT.pat N | preview FILE.pat OUT.gif'
    );
    process.exit(1);
}

function main() {
    const [, , command, ...args] = process.argv;
    if (command === 'generate' && args.length === 2) return generate(args[0], args[1]);
    if (command === 'inspect' && args.length === 1) return inspect(args[0]);
    if (command === 'compare' && args.length === 2) return compare(args[0], args[1]);
    if (command === 'audit-library' && (args.length === 1 || args.length === 2))
        return auditLibrary(args[0], args[1]);
    if (command === 'score-library' && (args.length === 2 || args.length === 3))
        return scoreLibrary(args[0], args[1], args[2]);
    if (command === 'phase-shift' && args.length === 3)
        return phaseShift(args[0], args[1], args[2]);
    if (command === 'preview' && args.length === 2) return preview(args[0], args[1]);
    usage();
}

main();
