#!/usr/bin/env node
/**
 * Tests for js/studio-runlog-adapter.js — routes ArenaSession 'runstatus' phases
 * into a run-log.js accumulator, closing it on terminal phases. Verifies the
 * phase strings need no translation and that COMPLETED / ABORTED_BY_USER /
 * DISCONNECTED outcomes derive correctly.
 *
 * Run: node tests/test-studio-runlog-adapter.js   (wired into `pixi run test`)
 */
'use strict';

const RunLog = require('../js/run-log.js');
const A = require('../js/studio-runlog-adapter.js');

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
function fixedClock() {
    let t = Date.parse('2026-07-01T21:00:00.000Z');
    return () => {
        const v = t;
        t += 1000;
        return v;
    };
}

// A realistic runner phase stream for a 1-step sequence.
const STREAM = [
    { phase: 'sequence-start', total: 1 },
    {
        phase: 'step-start',
        index: 0,
        total: 1,
        step: { conditionName: 'grating_15px', kind: 'ref' }
    },
    {
        phase: 'runtime-control-applied',
        index: 0,
        runtimeControlApply: {
            event: 'runtime_control_apply',
            variable: 'led_percent',
            old_value: 20,
            new_value: 40
        }
    },
    {
        phase: 'trial-resolved',
        index: 0,
        runtimeRecord: {
            event: 'runtime_control_trial_parameters',
            resolved_variables: { led_percent: 40 },
            resolved_commands: []
        }
    },
    { phase: 'trial-running', index: 0, step: { conditionName: 'grating_15px' }, durationSec: 5 },
    {
        phase: 'led-activation',
        index: 12,
        on: true,
        ledPercent: 20,
        step: { conditionName: 'grating_15px' }
    },
    { phase: 'command', index: 0, op: 'allOff' },
    {
        phase: 'skip',
        index: 0,
        plugin_name: 'camera',
        command_name: 'startRecording',
        reason: 'plugin'
    },
    { phase: 'step-done', index: 0, total: 1, step: { conditionName: 'grating_15px' } }
];

// ── COMPLETED run ────────────────────────────────────────────────────────────
console.log('=== COMPLETED run ===');
let log = RunLog.createRunLog({
    intent: 'experiment',
    now: fixedClock(),
    meta: { run_id: 'r1', protocol_sha256: 'abc' }
});
let terminals = 0;
for (const s of STREAM) {
    const r = A.feedRunStatus(log, s);
    if (r.terminal) terminals++;
}
check('no terminal mid-stream', terminals, 0);
const finalR = A.feedRunStatus(log, {
    phase: 'sequence-complete',
    summary: { completed: true, steps: 1, errors: 0, skipped: 1 }
});
checkBool('terminal on sequence-complete', finalR.terminal, JSON.stringify(finalR.summary));
check('outcome COMPLETED', log.summary.outcome, 'COMPLETED');
const j = log.toJSON();
check(
    'all known phases logged',
    j.events.map((e) => e.phase),
    [
        'sequence-start',
        'step-start',
        'runtime-control-applied',
        'trial-resolved',
        'trial-running',
        'led-activation',
        'command',
        'skip',
        'step-done',
        'sequence-complete'
    ]
);
checkBool(
    'events are timestamped',
    j.events.every((e) => typeof e.t_iso === 'string'),
    'stamped'
);
const ledEvent = j.events.find((e) => e.phase === 'led-activation');
checkBool('led-activation logged', !!ledEvent, JSON.stringify(ledEvent));
check('led-activation on retained', ledEvent.on, true);
check('led-activation percent retained', ledEvent.ledPercent, 20);
const skipEvent = j.events.find((e) => e.phase === 'skip');
checkBool('skip payload preserved', skipEvent.plugin_name === 'camera', 'camera');

// ── ABORTED run ──────────────────────────────────────────────────────────────
console.log('=== ABORTED run ===');
log = RunLog.createRunLog({ intent: 'experiment', now: fixedClock(), meta: { run_id: 'r2' } });
A.feedRunStatus(log, { phase: 'sequence-start', total: 3 });
A.feedRunStatus(log, { phase: 'step-start', index: 0, total: 3, step: { conditionName: 'a' } });
const ab = A.feedRunStatus(log, {
    phase: 'aborted',
    summary: { aborted: true, steps: 1, errors: 0, skipped: 0 }
});
checkBool('aborted is terminal', ab.terminal, 'terminal');
check('outcome ABORTED_BY_USER', log.summary.outcome, 'ABORTED_BY_USER');

// ── DISCONNECTED (out-of-band) ───────────────────────────────────────────────
console.log('=== DISCONNECTED ===');
log = RunLog.createRunLog({ intent: 'experiment', now: fixedClock(), meta: { run_id: 'r3' } });
A.feedRunStatus(log, { phase: 'sequence-start', total: 2 });
const dc = A.finishDisconnected(log, { aborted: true, steps: 0, errors: 0, skipped: 0 });
check('outcome DISCONNECTED', dc.outcome, 'DISCONNECTED');

// ── intent:test nulls the hash ───────────────────────────────────────────────
console.log('=== intent:test ===');
log = RunLog.createRunLog({
    intent: 'test',
    now: fixedClock(),
    meta: { run_id: 'r4', protocol_sha256: 'abc' }
});
check('test intent nulls sha', log.meta.protocol_sha256, null);

// ── unknown / malformed phases ignored ───────────────────────────────────────
console.log('=== unknown phases ===');
log = RunLog.createRunLog({ intent: 'test', now: fixedClock(), meta: {} });
const u1 = A.feedRunStatus(log, { phase: 'sending' }); // single-trial-only phase
check('legacy single-trial phase ignored', u1.event, null);
const u2 = A.feedRunStatus(log, {}); // no phase
check('no-phase ignored', u2.event, null);
const u3 = A.feedRunStatus(null, { phase: 'command' }); // no log
check('null log safe', u3.event, null);
check('nothing logged', log.toJSON().events.length, 0);

// ── isTerminal ───────────────────────────────────────────────────────────────
console.log('=== isTerminal ===');
check('sequence-complete terminal', A.isTerminal('sequence-complete'), true);
check('aborted terminal', A.isTerminal('aborted'), true);
check('command not terminal', A.isTerminal('command'), false);
check('led-activation not terminal', A.isTerminal('led-activation'), false);

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures ? 1 : 0);
