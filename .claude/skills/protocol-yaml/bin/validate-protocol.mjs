#!/usr/bin/env node
/**
 * v3 protocol validator + waits-rule linter.
 *
 * Run from the webDisplayTools repo root (needs the vendored-yaml loader hook):
 *   ~/.pixi/bin/pixi run node --import ./tests/vendor-yaml.register.mjs \
 *       .claude/skills/protocol-yaml/bin/validate-protocol.mjs <protocol.yaml>
 *
 * Checks, in order:
 *   1. parse (schema)                    → exit 1 on failure
 *   2. collectBlockingErrors (refs etc.) → exit 1 when any
 *   3. collectExportWarnings             → printed, non-fatal
 *   4. THE WAITS RULE lint per condition → printed, non-fatal:
 *      - a trialParams with duration > 0 must be covered by wait(s) before the
 *        next trialParams / end of condition (trialParams is fire-and-forget;
 *        only waits advance the clock)
 *      - mode/field sanity: mode 2 wants gain 0; modes 3/4 want frame_rate 0
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (!file) {
    console.error('usage: validate-protocol.mjs <protocol.yaml>');
    process.exit(2);
}
if (!existsSync('js/protocol-yaml-v3.js')) {
    console.error('run me from the webDisplayTools repo root (js/protocol-yaml-v3.js not found in cwd)');
    process.exit(2);
}

const v3 = await import(pathToFileURL(resolve('js/protocol-yaml-v3.js')).href);
const text = readFileSync(file, 'utf8');

let exp;
try {
    exp = v3.parseV3Protocol(text);
} catch (e) {
    console.error('✗ PARSE ERROR: ' + (e && e.message ? e.message : e));
    process.exit(1);
}

const conds = exp.conditions || [];
const plugins = exp.plugins || [];
console.log('✓ parsed: ' + conds.length + ' condition(s), ' +
    (exp.sequence ? exp.sequence.length : 0) + ' sequence entr(ies), ' +
    (exp.variables ? exp.variables.length : 0) + ' variable(s), ' +
    plugins.length + ' plugin(s)' +
    (plugins.length
        ? ' [' + plugins.map((p) => p.name + (p.name === 'fictrac' || p.name === 'log'
            ? ' (web-executed)' : ' (web-skipped)')).join(', ') + ']'
        : ''));

// collectBlockingErrors → { ok, errors[] }; collectExportWarnings → { warnings[], totalCount }
let blocking = [];
try { blocking = (v3.collectBlockingErrors(exp) || {}).errors || []; }
catch (e) { blocking = [String(e.message || e)]; }
for (const b of blocking) console.error('✗ BLOCKING: ' + (b && b.message ? b.message : b));

let warnings = [];
try { warnings = (v3.collectExportWarnings(exp) || {}).warnings || []; } catch (_) { /* soft */ }
for (const w of warnings) console.warn('⚠ ' + (w && w.message ? w.message : w));

// ── requires: + runtime_controls: ───────────────────────────────────────────
// `requires:` tokens the web runner lacks make the Studio REFUSE to run (editing is fine).
// `runtime_controls:` are validated by the same module the Studio uses, so an operator
// finds out here — not at the rig — that a control is out of scope or mis-declared.
if (Array.isArray(exp.requires) && exp.requires.length) {
    const missing = v3.unsupportedRequires ? v3.unsupportedRequires(exp) : exp.requires;
    console.log('ℹ requires: [' + exp.requires.join(', ') + ']' +
        (missing.length ? ' — the WEB runner refuses to run this (missing: ' + missing.join(', ') + ')' : ''));
}
// ── controller: block (sticky controller settings asserted before the run) ──────
// docs/development/controller-settings-strategy.md. Malformed values are already in
// `blocking` (collectBlockingErrors); here: what it declares, the capability token, and a
// cross-check against the rig file when it is readable from the repo root.
const cb = exp.controller;
if (cb && cb.declared) {
    const parts = [];
    if (cb.panel_mode != null) parts.push('panel_mode ' + cb.panel_mode + ' (' + ['oneshot', 'persistent', 'triggered', 'gated'][cb.panel_mode] + ')');
    if (cb.refresh_hz != null) parts.push('refresh_hz ' + cb.refresh_hz);
    if (cb.refresh_policy) parts.push('refresh_policy ' + cb.refresh_policy);
    if (cb.panel_firmware) parts.push('panel_firmware "' + cb.panel_firmware + '"');
    console.log('ℹ controller: ' + (parts.join(', ') || '(empty block)') + ' — asserted by the Studio before every run, recorded in the run header');
    const rigPath = String(exp.rig_path || '');
    const rigFile = rigPath.startsWith('./') || rigPath.startsWith('configs/') ? resolve(rigPath) : null;
    if (rigFile && existsSync(rigFile)) {
        try {
            const { createRequire } = await import('node:module');
            const Registry = createRequire(import.meta.url)(resolve('js/plugin-registry.js'));
            const rig = Registry.parseRigIo(v3.parseRigYAMLText(readFileSync(rigFile, 'utf8')));
            const notes = [];
            if (rig.defaults.panel_mode != null && cb.panel_mode != null && rig.defaults.panel_mode !== cb.panel_mode) {
                notes.push('protocol panel_mode ' + cb.panel_mode + ' overrides the rig default ' + rig.defaults.panel_mode + ' (allowed; the run asserts the protocol\'s value)');
            }
            if (cb.refresh_hz != null && rig.limits.max_refresh_hz != null && cb.refresh_hz > rig.limits.max_refresh_hz) {
                console.error('✗ BLOCKING: controller.refresh_hz ' + cb.refresh_hz + ' exceeds the rig limit max_refresh_hz ' + rig.limits.max_refresh_hz + ' (' + rigPath + ')');
                process.exitCode = 1;
            }
            if (cb.refresh_policy === 'line_sync_safe' && rig.limits.max_refresh_hz == null) {
                console.warn('⚠ controller: refresh_policy line_sync_safe but the rig ' + rigPath + ' declares no limits.max_refresh_hz — nothing to cap at');
            }
            if (rig.requires.panel_firmware && cb.panel_firmware && rig.requires.panel_firmware !== cb.panel_firmware) {
                notes.push('protocol requires panel firmware "' + cb.panel_firmware + '", rig requires "' + rig.requires.panel_firmware + '" — both are checked');
            }
            for (const w of rig.warnings || []) console.warn('⚠ rig ' + rigPath + ': ' + w);
            for (const n of notes) console.log('ℹ ' + n);
            console.log('ℹ rig ' + rigPath + ': defaults.panel_mode ' + rig.defaults.panel_mode + ', limits.max_refresh_hz ' + rig.limits.max_refresh_hz +
                ', requires.panel_firmware ' + JSON.stringify(rig.requires.panel_firmware) + ', strict ' + rig.strict);
        } catch (e) { console.warn('⚠ rig ' + rigPath + ' could not be cross-checked: ' + (e && e.message ? e.message : e)); }
    }
}
const rcNames = Object.keys(exp.runtime_controls || {});
if (rcNames.length) {
    const { createRequire } = await import('node:module');
    const RuntimeControls = createRequire(import.meta.url)(resolve('js/runtime-controls.js'));
    const report = RuntimeControls.validateRuntimeControls(exp);
    for (const e of report.errors) console.error('✗ runtime_controls: ' + e.message);
    for (const w of report.warnings) console.warn('⚠ runtime_controls: ' + w.message);
    if (report.ok) {
        console.log('✓ runtime_controls: ' + rcNames.map((n) => {
            const d = report.controls[n];
            const bound = report.bindings.filter((b) => b.variable === n).length;
            const range = d.type === 'enum' ? (d.values || []).join('|') : d.type === 'boolean' ? 'true|false' : d.minimum + '..' + d.maximum;
            return n + ' (' + d.type + ' ' + range + (d.units ? ' ' + d.units : '') + ', default ' + JSON.stringify(d.default_value) + ', ' + bound + ' binding' + (bound === 1 ? '' : 's') + ')';
        }).join('; '));
    }
    if (report.errors.length) process.exitCode = 1;
}

// ── THE WAITS RULE ──────────────────────────────────────────────────────────
// conditionDuration = max(trialParams.duration, Σ waits): a trialParams is
// fire-and-forget, so waits are the only protocol clock. Lint each condition.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
let lintCount = 0;
const lint = (msg) => { lintCount++; console.warn('⚠ waits: ' + msg); };
const lintBias = (msg) => { lintCount++; console.warn('⚠ bias: ' + msg); };
const lintLed = (msg) => { lintCount++; console.warn('⚠ led_activation: ' + msg); };

for (const cond of conds) {
    const cmds = cond.commands || [];
    // Split into segments: each trialParams owns the waits that follow it
    // (until the next trialParams). Waits before any trialParams are fine.
    const segs = [];
    let cur = null;
    for (const c of cmds) {
        if (c.type === 'controller' && c.command_name === 'trialParams') {
            cur = { tp: c, waitSum: 0 };
            segs.push(cur);
        } else if (c.type === 'wait' && cur) {
            cur.waitSum += num(c.duration);
        }
    }
    for (let i = 0; i < segs.length; i++) {
        const { tp, waitSum } = segs[i];
        const dur = num(tp.duration);
        const label = '"' + cond.name + '"' + (segs.length > 1 ? ' (trialParams #' + (i + 1) + ')' : '');
        if (dur > 0 && waitSum === 0) {
            lint(label + ' has trialParams duration ' + dur + 's but NO wait after it — ' +
                'the condition ends instantly while the display keeps playing. Add `wait: ' + dur + '`.');
        } else if (dur > 0 && waitSum < dur) {
            lint(label + ' waits only ' + waitSum + 's of a ' + dur + 's trialParams — ' +
                'the next command/condition cuts the display short. Bind both to one anchor.');
        } else if (waitSum > dur && dur > 0) {
            console.log('ℹ ' + label + ' holds ' + (waitSum - dur) + 's past the ' + dur +
                's display (intentional blank/ITI?).');
        }
        // mode/field sanity
        const mode = num(tp.mode);
        if (mode === 2 && num(tp.gain) !== 0) {
            lint(label + ' is mode 2 with gain ' + tp.gain + ' — mode 2 wants gain 0.');
        }
        if ((mode === 3 || mode === 4) && num(tp.frame_rate) !== 0) {
            lint(label + ' is mode ' + mode + ' with frame_rate ' + tp.frame_rate +
                ' — modes 3/4 want frame_rate 0.');
        }
        // led_activation (Studio v0.86: graded zones). hysteresis is accepted but IGNORED;
        // a zone needs both ramps; a zone's level falls back to the top-level `level`.
        const la = tp.led_activation;
        if (la && typeof la === 'object') {
            if (la.hysteresis !== undefined && la.hysteresis !== null && la.hysteresis !== '') {
                lintLed(label + ' `hysteresis` is IGNORED since Studio v0.86 — delete it; ' +
                    'use `zones:` with `ramp_in: [a, b]` / `ramp_out: [c, d]` spanning a few frames for chatter-free edges.');
            }
            if (mode !== 3) {
                lintLed(label + ' has led_activation but is mode ' + tp.mode + ' — it only runs in Mode 3 (FicTrac closed loop).');
            }
            if (Array.isArray(la.zones)) {
                la.zones.forEach((z, zi) => {
                    if (!z || typeof z !== 'object') { lintLed(label + ' zones[' + zi + '] is not a mapping.'); return; }
                    if (z.ramp_in === undefined || z.ramp_out === undefined) {
                        lintLed(label + ' zones[' + zi + '] needs both ramp_in and ramp_out ([a, b] / [c, d], or one index for a hard edge).');
                    }
                    if (z.level === undefined && la.level === undefined) {
                        lintLed(label + ' zones[' + zi + '] has no level and there is no top-level level to inherit.');
                    }
                });
            } else if (la.zones !== undefined) {
                lintLed(label + ' zones must be a list.');
            }
            if (la.zones === undefined && la.on_ranges === undefined) {
                console.log('ℹ ' + label + ' led_activation has neither zones nor on_ranges — the LED just sits at baseline ' + (la.baseline ?? 0) + ' %.');
            }
        }
    }
}

// ── RETIRED closed-loop `gain` (Studio v0.85 / bridge 3.3) ─────────────────
// `gain` was the display pitch in deg/frame masquerading as a coupling; any value but ±1.8
// jumped the display once per ball revolution. The pitch now comes from the rig and the
// strength is `coupling` (1 = 1:1). The Studio REFUSES to run a protocol still carrying it.
for (const p of plugins) {
    if (p && p.matlab && p.matlab.class === 'FicTracPlugin' && p.config && p.config.gain !== undefined) {
        const g = Number(p.config.gain); const soft = Number.isFinite(g) && Math.abs(Math.abs(g) - 1.8) < 1e-9;
        lintBias('plugin "' + p.name + '" config has `gain: ' + p.config.gain + '` — RETIRED. ' + (soft ? 'The Studio runs it as coupling ' + (g > 0 ? 1 : -1) + ' with a warning; delete it (the display pitch comes from the rig).' : 'The Studio REFUSES to run this protocol; delete it and use `coupling` (this gain ≈ coupling ' + (g ? Math.round(180 / g) / 100 : '?') + ').'));
    }
}
for (const cond of conds) {
    for (const c of cond.commands || []) {
        if (c.type === 'plugin' && c.command_name === 'startClosedLoop' && c.params && c.params.gain !== undefined) {
            const g = Number(c.params.gain); const soft = Number.isFinite(g) && Math.abs(Math.abs(g) - 1.8) < 1e-9;
            lintBias('"' + cond.name + '" startClosedLoop has `gain: ' + c.params.gain + '` — RETIRED. ' + (soft ? 'Runs as coupling ' + (g > 0 ? 1 : -1) + ' with a warning; replace it with `coupling: ' + (g > 0 ? 1 : -1) + '`.' : 'The Studio refuses this step; use `coupling` (1 = 1:1, -1 = reversed, 0.75 / 1.25 = under / over; this gain ≈ coupling ' + (g ? Math.round(180 / g) / 100 : '?') + ').'));
        }
        if (c.type === 'plugin' && c.command_name === 'startClosedLoop' && c.params && c.params.coupling !== undefined && !Number.isFinite(Number(c.params.coupling))) {
            lintBias('"' + cond.name + '" startClosedLoop coupling ' + JSON.stringify(c.params.coupling) + ' is not a number.');
        }
    }
}

// ── BIAS SANITY (LAB-185) ───────────────────────────────────────────────────
// The bias params live on the fictrac plugin's startClosedLoop, not on trialParams,
// so this needs its own pass over plugin commands. Mirrors the runner's rules
// (js/arena-runner-g6.js normalizeBias) so an author hears about it here rather than
// at run time, where a bad spec skips the trial — possibly with a fly already mounted.
const BIAS_TYPES = ['none', 'constant', 'sine', 'square'];
for (const cond of conds) {
    for (const c of cond.commands || []) {
        if (c.type !== 'plugin' || c.command_name !== 'startClosedLoop') continue;
        const p = c.params || {};
        if (p.bias_type === undefined || p.bias_type === null || p.bias_type === '') continue;
        const t = String(p.bias_type).trim().toLowerCase();
        const label = '"' + cond.name + '" startClosedLoop';
        if (!BIAS_TYPES.includes(t)) {
            lintBias(label + ' has bias_type ' + JSON.stringify(p.bias_type) +
                ' — must be one of ' + BIAS_TYPES.join('/') + '. The runner will skip this step.');
            continue;
        }
        if (t === 'sine' || t === 'square') {
            const f = num(p.bias_frequency);
            if (p.bias_frequency === undefined || f === 0) {
                lintBias(label + ' is bias_type ' + t + ' with bias_frequency ' +
                    (p.bias_frequency === undefined ? 'unset' : f) +
                    ' — 0 Hz has no period, so the runner will SKIP this step. ' +
                    'Set a non-zero frequency (or use bias_type constant for a steady drift).');
            } else if (f < 0) {
                lintBias(label + ' has a negative bias_frequency (' + f + ') — that is a no-op, ' +
                    'the waveform is even in frequency. Negate bias_amplitude to reverse direction.');
            }
            if (num(p.bias_amplitude) === 0) {
                console.log('ℹ ' + label + ' is bias_type ' + t +
                    ' with bias_amplitude 0 — no disturbance will be applied.');
            }
        }
    }
}

if (!blocking.length && !warnings.length && !lintCount) {
    console.log('✓ clean — no blocking errors, no warnings, waits rule satisfied.');
} else if (!blocking.length) {
    console.log('✓ no blocking errors (' + (warnings.length + lintCount) + ' warning(s) above).');
}
process.exit(blocking.length ? 1 : 0);
