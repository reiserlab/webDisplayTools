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

// ── THE WAITS RULE ──────────────────────────────────────────────────────────
// conditionDuration = max(trialParams.duration, Σ waits): a trialParams is
// fire-and-forget, so waits are the only protocol clock. Lint each condition.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
let lintCount = 0;
const lint = (msg) => { lintCount++; console.warn('⚠ waits: ' + msg); };

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
    }
}

if (!blocking.length && !warnings.length && !lintCount) {
    console.log('✓ clean — no blocking errors, no warnings, waits rule satisfied.');
} else if (!blocking.length) {
    console.log('✓ no blocking errors (' + (warnings.length + lintCount) + ' warning(s) above).');
}
process.exit(blocking.length ? 1 : 0);
