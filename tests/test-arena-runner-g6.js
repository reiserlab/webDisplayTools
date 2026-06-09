#!/usr/bin/env node
/**
 * Tests for js/arena-runner-g6.js — the condition→wire mapping helpers and the
 * ArenaRunner run-state machine, exercised with a FAKED link (no hardware, no
 * Web Serial). These pin the behaviours the Codex plan-review flagged:
 *   - numeric coercion of string YAML scalars (mode "2" must work)
 *   - findTrialParams must skip allOn/allOff and match command_name
 *   - negative frame_rate / bad mode throw clear errors
 *   - single-flight start(), idempotent stop(), best-effort auto-stop timer
 *
 * Run: node tests/test-arena-runner-g6.js   (wired into `npm test`)
 * Exits 0 on PASS, 1 on any FAIL.
 */

'use strict';

const Runner = require('../js/arena-runner-g6.js');
const Wire = require('../js/arena-wire-g6.js');

let totalChecks = 0;
let failures = 0;

const hex = (bytes) =>
    Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');

function check(name, got, expected) {
    totalChecks++;
    const ok = got === expected;
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

function checkBytes(name, got, expectedHex) {
    totalChecks++;
    const gotHex = hex(got);
    const ok = gotHex === expectedHex;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got [${gotHex}], expected [${expectedHex}]`);
    if (!ok) failures++;
}

function checkThrows(name, fn) {
    totalChecks++;
    let threw = false;
    try {
        fn();
    } catch (_) {
        threw = true;
    }
    console.log(`  ${threw ? 'PASS' : 'FAIL'}  ${name}: ${threw ? 'threw' : 'did NOT throw'}`);
    if (!threw) failures++;
}

async function checkAsyncThrows(name, fn) {
    totalChecks++;
    let threw = false;
    try {
        await fn();
    } catch (_) {
        threw = true;
    }
    console.log(`  ${threw ? 'PASS' : 'FAIL'}  ${name}: ${threw ? 'threw' : 'did NOT throw'}`);
    if (!threw) failures++;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A faked ArenaLink: records sent frames, replies OK (echo = cmd byte) by
// default. `reply` overrides; `failSend` makes send() reject.
function makeFakeLink(opts) {
    opts = opts || {};
    return {
        connected: opts.connected === undefined ? true : opts.connected,
        sent: [],
        async send(bytes) {
            this.sent.push(Array.from(bytes));
            if (opts.failSend) throw new Error('fake send failure');
            if (typeof opts.reply === 'function') return opts.reply(bytes);
            if (opts.reply) return opts.reply;
            // default OK ack: [length=2, status=0, echo_cmd=bytes[1]]
            return new Uint8Array([0x02, 0x00, bytes[1]]);
        }
    };
}

// ---- fixtures -----------------------------------------------------------

const trialCmd = {
    type: 'controller',
    command_name: 'trialParams',
    pattern: 'pat08.pat',
    pattern_ID: 1,
    duration: 5,
    mode: 2,
    frame_index: 1,
    frame_rate: 10,
    gain: 0
};
const arenaCheckCond = {
    name: 'arena check',
    commands: [
        { type: 'controller', command_name: 'allOn' },
        { type: 'wait', duration: 1 },
        { type: 'controller', command_name: 'setVisibleBacklightsOff' }
    ]
};
const intertrialCond = {
    name: 'intertrial',
    commands: [
        { type: 'controller', command_name: 'allOff' },
        { type: 'wait', duration: 2 }
    ]
};
const realCond = {
    name: 'sine_grating',
    commands: [
        { type: 'plugin', plugin_name: 'camera', command_name: 'getTimestamp' },
        trialCmd,
        { type: 'wait', duration: 3 },
        { type: 'plugin', plugin_name: 'backlight', command_name: 'setGreenLEDPower' }
    ]
};

async function main() {
    console.log('=== findTrialParams (must match command_name, not just type) ===');
    checkBool(
        'finds trialParams among plugins/waits',
        Runner.findTrialParams(realCond) === trialCmd
    );
    checkBool(
        'skips a leading allOn controller command',
        Runner.findTrialParams(arenaCheckCond) === null
    );
    checkBool(
        'returns null for an allOff-only condition',
        Runner.findTrialParams(intertrialCond) === null
    );
    checkBool('null/garbage condition -> null', Runner.findTrialParams(null) === null);

    console.log('\n=== listSkippedPlugins ===');
    const skipped = Runner.listSkippedPlugins(realCond);
    check('counts plugin commands', skipped.length, 2);
    check(
        'first skipped plugin',
        skipped[0].plugin_name + '.' + skipped[0].command_name,
        'camera.getTimestamp'
    );
    check('no plugins -> empty', Runner.listSkippedPlugins(arenaCheckCond).length, 0);

    console.log('\n=== isDryRunEligible (has trialParams AND no plugin commands) ===');
    const eligibleCond = { name: 'pat_only', commands: [trialCmd, { type: 'wait', duration: 2 }] };
    const ctrlPlusTrial = {
        name: 'allon_then_trial',
        commands: [{ type: 'controller', command_name: 'allOn' }, trialCmd]
    };
    checkBool('trialParams + waits -> eligible', Runner.isDryRunEligible(eligibleCond) === true);
    checkBool(
        'trialParams + other controller cmds (no plugins) -> eligible',
        Runner.isDryRunEligible(ctrlPlusTrial) === true
    );
    checkBool('has plugin commands -> NOT eligible', Runner.isDryRunEligible(realCond) === false);
    checkBool(
        'no trialParams (allOn/allOff) -> NOT eligible',
        Runner.isDryRunEligible(arenaCheckCond) === false
    );
    checkBool('null condition -> NOT eligible', Runner.isDryRunEligible(null) === false);

    console.log('\n=== frameIndexToInitPos (named off-by-one helper) ===');
    check('1 -> 1 (pass-through)', Runner.frameIndexToInitPos(1), 1);
    check('undefined -> 0', Runner.frameIndexToInitPos(undefined), 0);
    check('"3" -> 3 (coerced)', Runner.frameIndexToInitPos('3'), 3);
    checkThrows('non-number frame_index throws', () => Runner.frameIndexToInitPos('abc'));

    console.log('\n=== buildTrialParams: mapping + coercion + the golden frame ===');
    const p = Runner.buildTrialParams(trialCmd, { patternId: 1 });
    check('mode', p.mode, 2);
    check('patternId', p.patternId, 1);
    check('frameRate', p.frameRate, 10);
    check('gain', p.gain, 0);
    check('initPos (from frame_index 1)', p.initPos, 1);
    // The encoded frame must match the wire golden vector.
    checkBytes(
        'encodeTrialParams(mapped)',
        Wire.encodeTrialParams(p),
        '0c 08 02 01 00 0a 00 00 01 00 00 00 00'
    );

    // THE coercion test: string scalars (as a YAML parser might yield) must work.
    const strCmd = { mode: '2', frame_rate: '10', gain: '0', frame_index: '1' };
    const ps = Runner.buildTrialParams(strCmd, { patternId: '1' });
    checkBytes(
        'string-typed fields coerce to the same frame',
        Wire.encodeTrialParams(ps),
        '0c 08 02 01 00 0a 00 00 01 00 00 00 00'
    );

    console.log('\n=== buildTrialParams: clear throws ===');
    checkThrows('mode 5 throws', () => Runner.buildTrialParams({ mode: 5 }, { patternId: 1 }));
    checkThrows('mode "closed_loop" (non-numeric) throws', () =>
        Runner.buildTrialParams({ mode: 'closed_loop' }, { patternId: 1 })
    );
    checkThrows('negative frame_rate throws', () =>
        Runner.buildTrialParams({ mode: 2, frame_rate: -5 }, { patternId: 1 })
    );
    checkThrows('patternId 0 throws', () => Runner.buildTrialParams({ mode: 2 }, { patternId: 0 }));
    checkThrows('missing patternId throws', () => Runner.buildTrialParams({ mode: 2 }, {}));

    console.log('\n=== ArenaRunner: send + run-state ===');
    {
        const link = makeFakeLink();
        const runner = new Runner.ArenaRunner(link, Wire);
        const params = Runner.buildTrialParams(trialCmd, { patternId: 1 });
        const resp = await runner.start({ params, durationSec: 0, conditionName: 'sine_grating' });
        checkBool('start() resolves with an ok response', resp && resp.ok === true);
        checkBool('runner is active after start (no auto-stop)', runner.active === true);
        checkBytes(
            'sent the trialParams frame',
            link.sent[0],
            '0c 08 02 01 00 0a 00 00 01 00 00 00 00'
        );
        check('conditionName tracked', runner.conditionName, 'sine_grating');

        await checkAsyncThrows('double start() while active throws (single-flight)', () =>
            runner.start({ params })
        );

        await runner.stop();
        checkBool('inactive after stop', runner.active === false);
        checkBytes('stop sent STOP (0x30)', link.sent[link.sent.length - 1], '01 30');
        const sentBefore = link.sent.length;
        await runner.stop(); // idempotent
        checkBool(
            'stop() is idempotent (no throw; sends STOP again)',
            link.sent.length === sentBefore + 1
        );
    }

    console.log('\n=== ArenaRunner: rejected + failed send do not arm a run ===');
    {
        const link = makeFakeLink({ reply: new Uint8Array([0x02, 0x01, 0x08]) }); // status=1
        const runner = new Runner.ArenaRunner(link, Wire);
        const resp = await runner.start({
            params: Runner.buildTrialParams(trialCmd, { patternId: 1 })
        });
        checkBool('rejected reply -> resp.ok false', resp && resp.ok === false);
        checkBool('not active after a rejected run', runner.active === false);
    }
    {
        const link = makeFakeLink({ failSend: true });
        const runner = new Runner.ArenaRunner(link, Wire);
        await checkAsyncThrows('send failure rethrows', () =>
            runner.start({ params: Runner.buildTrialParams(trialCmd, { patternId: 1 }) })
        );
        checkBool('not active after a failed send', runner.active === false);
    }

    console.log('\n=== ArenaRunner: best-effort auto-stop timer ===');
    {
        const link = makeFakeLink();
        const runner = new Runner.ArenaRunner(link, Wire);
        await runner.start({
            params: Runner.buildTrialParams(trialCmd, { patternId: 1 }),
            durationSec: 0.02
        });
        checkBool('active immediately after start with a timer', runner.active === true);
        await delay(80);
        checkBool('auto-stop fired -> inactive', runner.active === false);
        checkBytes('auto-stop sent STOP (0x30)', link.sent[link.sent.length - 1], '01 30');
    }

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
