#!/usr/bin/env node
/**
 * Tests for js/run-log.js — the structured experiment run-log builder.
 * Pure, DOM-free, with an injected clock for deterministic timestamps/offsets.
 *
 * Run: node tests/test-run-log.js   (wired into `npm test`)
 * Exits 0 on PASS, 1 on any FAIL.
 */

'use strict';

const RunLog = require('../js/run-log.js');

let totalChecks = 0;
let failures = 0;

function check(name, got, expected) {
    totalChecks++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`
    );
    if (!ok) failures++;
}
function checkBool(name, ok, info) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

// Deterministic clock: starts fixed, advances 1s per call.
function fixedClock() {
    let t = Date.parse('2026-06-17T14:32:05.000Z');
    return () => {
        const v = t;
        t += 1000;
        return v;
    };
}
const META = {
    run_id: 'a1b2',
    experimenter: 'M Reiser',
    genotype: 'w;UAS-CsChrimson',
    notes: 'fly 3',
    protocol_filename: 'looming_v3.yaml',
    protocol_sha256: 'a1b2c3d4',
    arena_config: 'G6_2x10',
    rig: 'test_rig_1',
    firmware: 'v1',
    tool_version: 'Arena Studio v0'
};

// ── helpers ────────────────────────────────────────────────────────────────
console.log('=== helpers ===');
check('slug normalizes + lowercases', RunLog.slug('M Reiser'), 'm-reiser');
check('slug empty → anon', RunLog.slug(''), 'anon');
check('baseName strips .yaml', RunLog.baseName('looming_v3.yaml'), 'looming_v3');
check('baseName strips .yml', RunLog.baseName('x.yml'), 'x');
check('deriveOutcome aborted', RunLog.deriveOutcome({ aborted: true }), 'ABORTED_BY_USER');
check('deriveOutcome errors', RunLog.deriveOutcome({ errors: 2 }), 'ERRORED');
check('deriveOutcome completed', RunLog.deriveOutcome({ completed: true }), 'COMPLETED');
check(
    'deriveOutcome override',
    RunLog.deriveOutcome({ completed: true }, 'DISCONNECTED'),
    'DISCONNECTED'
);

// ── stamping + accumulation ──────────────────────────────────────────────────
console.log('=== stamping ===');
{
    const log = RunLog.createRunLog({ meta: META, now: fixedClock() });
    check('timestamp_start stamped', log.meta.timestamp_start, '2026-06-17T14:32:05.000Z');
    check('intent defaults to experiment', log.intent, 'experiment');
    const e1 = log.event('sequence-start', { total: 15 });
    const e2 = log.event('step-start', {
        index: 0,
        total: 15,
        step: { conditionName: 'baseline_off', kind: 'ref' }
    });
    check('event count', log.events.length, 2);
    check('first offset = 1s (clock advanced once for start)', e1.t_offset_s, 1);
    check('second offset = 2s', e2.t_offset_s, 2);
    check('event carries phase + payload', [e1.phase, e1.total], ['sequence-start', 15]);
    check('event iso stamped', e1.t_iso, '2026-06-17T14:32:06.000Z');
}

// ── intent=test nulls the protocol hash ──────────────────────────────────────
console.log('=== intent=test ===');
{
    const log = RunLog.createRunLog({ meta: META, intent: 'test', now: fixedClock() });
    check('test intent', log.intent, 'test');
    check('test run nulls protocol_sha256', log.meta.protocol_sha256, null);
}

// ── finish / summary / outcome ───────────────────────────────────────────────
console.log('=== finish ===');
{
    const log = RunLog.createRunLog({ meta: META, now: fixedClock() });
    log.event('sequence-start', { total: 15 }); // clock now used twice (start + this)
    const s = log.finish({ completed: true, aborted: false, steps: 15, errors: 0, skipped: 0 });
    check('summary outcome', s.outcome, 'COMPLETED');
    checkBool('summary has timestamp_end', !!s.timestamp_end);
    check('duration_s = 2 (start@1 call, finish@3rd call)', s.duration_s, 2);
    check('summary carried into toJSON', log.toJSON().summary.steps, 15);
    const sAbort = RunLog.createRunLog({ meta: META, now: fixedClock() }).finish(
        { aborted: true, steps: 4 },
        'ABORTED_BY_USER'
    );
    check('aborted outcome', sAbort.outcome, 'ABORTED_BY_USER');
}

// ── toJSON shape ─────────────────────────────────────────────────────────────
console.log('=== toJSON ===');
{
    const log = RunLog.createRunLog({ meta: META, now: fixedClock() });
    log.event('command', { index: 1, op: 'allOff' });
    log.finish({ completed: true, steps: 1, errors: 0, skipped: 0 });
    const j = log.toJSON();
    check('schema tag', j.schema, RunLog.SCHEMA);
    check('top-level keys', Object.keys(j).sort(), [
        'events',
        'intent',
        'meta',
        'schema',
        'summary'
    ]);
    check('meta round-trips run_id', j.meta.run_id, 'a1b2');
    check('events present', j.events.length, 1);
}

// ── toText ───────────────────────────────────────────────────────────────────
console.log('=== toText ===');
{
    const log = RunLog.createRunLog({ meta: META, now: fixedClock() });
    log.event('sequence-start', { total: 2 });
    log.event('step-start', {
        index: 0,
        total: 2,
        step: { conditionName: 'grating_15px_cw', kind: 'block-trial' }
    });
    log.event('skip', {
        index: 1,
        plugin_name: 'camera',
        command_name: 'getTimestamp',
        reason: 'plugins not driven'
    });
    log.finish({ completed: true, steps: 2, errors: 0, skipped: 1 });
    const txt = log.toText();
    checkBool('header has experimenter', /experimenter: M Reiser/.test(txt));
    checkBool('header has protocol hash', /protocol_sha256: a1b2c3d4/.test(txt));
    checkBool('renders a step line by condition name', /grating_15px_cw/.test(txt));
    checkBool('renders SKIP line', /SKIP camera\.getTimestamp/.test(txt));
    checkBool('summary line shows outcome', /— COMPLETED —/.test(txt));
    checkBool('flags host-side timing caveat', /host-side estimates/.test(txt));
}

// ── filename convention ──────────────────────────────────────────────────────
console.log('=== filename ===');
{
    const log = RunLog.createRunLog({ meta: META, now: fixedClock() });
    check(
        'json filename',
        log.filename('json'),
        'looming_v3__m-reiser__2026-06-17T14-32-05__a1b2.runlog.json'
    );
    check(
        'txt filename',
        log.filename('txt'),
        'looming_v3__m-reiser__2026-06-17T14-32-05__a1b2.runlog.txt'
    );
    checkBool('filename has no colons (fs-safe)', log.filename('json').indexOf(':') === -1);
}

// ── download is a no-op under Node ───────────────────────────────────────────
console.log('=== download (Node) ===');
{
    const log = RunLog.createRunLog({ meta: META, now: fixedClock() });
    check('download returns false without document', RunLog.download(log), false);
}

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
