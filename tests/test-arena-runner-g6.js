#!/usr/bin/env node
/**
 * Tests for js/arena-runner-g6.js — the condition→wire mapping helpers and the
 * ArenaRunner run-state machine, exercised with a FAKED link (no hardware, no
 * Web Serial). These pin the behaviours the Codex plan-review flagged:
 *   - numeric coercion of string YAML scalars (mode "2" must work)
 *   - findTrialParams must skip allOn/allOff and match command_name
 *   - bad mode throws a clear error; negative frame_rate passes through
 *     SIGNED (Mode-2 reverse playback, fw ee74c33+ / fw issue #4)
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

// check() compares with === , so it cannot compare objects/arrays. Use this for
// those (JSON-shape equality, so key ORDER matters — which is what we want when
// pinning a wire/IR shape).
function checkDeep(name, got, expected) {
    totalChecks++;
    const g = JSON.stringify(got);
    const e = JSON.stringify(expected);
    const ok = g === e;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${g}, expected ${e}`);
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
    // COMPAT: the wire duration is pinned to 0 (no controller auto-stop) while
    // host-side timing stays authoritative — cmd.duration (5) must NOT reach
    // the wire, but it MUST still drive durationSec (asserted in the
    // translateCommand suite below).
    check('wire duration pinned to 0 (compat)', p.duration, 0);
    // duty is ALWAYS present (0 = pattern's stored duty when the protocol
    // omits it) so every trial declares its own duty — 14-byte 0x0D frames.
    check('duty defaults to 0 (pattern default)', p.duty, 0);
    // The encoded frame must match the wire golden vector (duration bytes 00 00
    // per the compat pin, always-appended duty byte 00 at the end).
    checkBytes(
        'encodeTrialParams(mapped)',
        Wire.encodeTrialParams(p),
        '0d 08 02 01 00 0a 00 01 00 00 00 00 00 00'
    );

    // THE coercion test: string scalars (as a YAML parser might yield) must work.
    const strCmd = { mode: '2', frame_rate: '10', gain: '0', frame_index: '1', duty: '64' };
    const ps = Runner.buildTrialParams(strCmd, { patternId: '1' });
    check('string duty coerces', ps.duty, 64);
    checkBytes(
        'string-typed fields coerce to the same frame',
        Wire.encodeTrialParams(ps),
        '0d 08 02 01 00 0a 00 01 00 00 00 00 00 40'
    );

    // duty passthrough + blank-field semantics ('' = unset, not 0-by-accident).
    const pDuty = Runner.buildTrialParams({ mode: 2, duty: 200 }, { patternId: 1 });
    check('duty 200 passes through', pDuty.duty, 200);
    check(
        "blank duty ('') treated as unset -> 0",
        Runner.buildTrialParams({ mode: 2, duty: '' }, { patternId: 1 }).duty,
        0
    );

    // NEGATIVE frame_rate = Mode-2 reverse playback (fw ee74c33+, fw #4) —
    // the runner passes the sign through; the encoder emits int16 LE.
    const pRev = Runner.buildTrialParams({ mode: 2, frame_rate: -5 }, { patternId: 1 });
    check('negative frame_rate passes through signed', pRev.frameRate, -5);
    checkBytes(
        'reverse rate -5 encodes as int16 LE FB FF',
        Wire.encodeTrialParams(pRev),
        '0d 08 02 01 00 fb ff 00 00 00 00 00 00 00'
    );

    console.log('\n=== buildTrialParams: clear throws ===');
    checkThrows('mode 5 throws', () => Runner.buildTrialParams({ mode: 5 }, { patternId: 1 }));
    checkThrows('mode "closed_loop" (non-numeric) throws', () =>
        Runner.buildTrialParams({ mode: 'closed_loop' }, { patternId: 1 })
    );
    checkThrows('patternId 0 throws', () => Runner.buildTrialParams({ mode: 2 }, { patternId: 0 }));
    checkThrows('missing patternId throws', () => Runner.buildTrialParams({ mode: 2 }, {}));
    // duty is validated in the BUILDER (not the encoder) so translateCommand
    // turns a bad value into a skip-this-trial {op:'error'} instead of the
    // encoder's RangeError aborting the whole sequence from inside _runIR.
    checkThrows('duty 256 throws', () =>
        Runner.buildTrialParams({ mode: 2, duty: 256 }, { patternId: 1 })
    );
    checkThrows('duty -1 throws', () =>
        Runner.buildTrialParams({ mode: 2, duty: -1 }, { patternId: 1 })
    );
    checkThrows('duty 12.5 (non-integer) throws', () =>
        Runner.buildTrialParams({ mode: 2, duty: 12.5 }, { patternId: 1 })
    );

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
            '0d 08 02 01 00 0a 00 01 00 00 00 00 00 00'
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

    // ════════════════════════════════════════════════════════════════════
    // LAB-97: full-sequence runner — pure helpers + executor
    // ════════════════════════════════════════════════════════════════════

    console.log('\n=== conditionDuration (max(trialParams.duration, sum waits)) ===');
    check(
        'trialParams 5s dominates a 3s wait',
        Runner.conditionDuration({
            commands: [trialCmd, { type: 'wait', duration: 3 }]
        }),
        5
    );
    check(
        'summed waits (3+4) exceed a 2s trialParams',
        Runner.conditionDuration({
            commands: [
                { type: 'controller', command_name: 'trialParams', duration: 2 },
                { type: 'wait', duration: 3 },
                { type: 'wait', duration: 4 }
            ]
        }),
        7
    );
    check('waits-only condition', Runner.conditionDuration(intertrialCond), 2);
    check('null condition -> 0', Runner.conditionDuration(null), 0);
    check(
        'summed float waits round clean (no 2.21999… artifact)',
        Runner.conditionDuration({
            commands: [
                { type: 'wait', duration: 0.74 },
                { type: 'wait', duration: 0.74 },
                { type: 'wait', duration: 0.74 }
            ]
        }),
        2.22
    );
    check(
        'string durations coerce',
        Runner.conditionDuration({
            commands: [{ type: 'controller', command_name: 'trialParams', duration: '5' }]
        }),
        5
    );

    console.log('\n=== conditionCommandCount (wire-sending, non-wait commands) ===');
    check('single command -> 1', Runner.conditionCommandCount({ commands: [trialCmd] }), 1);
    check('null -> 0', Runner.conditionCommandCount(null), 0);
    check(
        'waits-only -> 0',
        Runner.conditionCommandCount({ commands: [{ type: 'wait', duration: 2 }] }),
        0
    );
    check(
        'two non-wait commands -> 2',
        Runner.conditionCommandCount({
            commands: [trialCmd, { type: 'controller', command_name: 'allOff' }]
        }),
        2
    );
    check(
        'waits are excluded from the count',
        Runner.conditionCommandCount({
            commands: [trialCmd, { type: 'wait', duration: 3 }, { type: 'wait', duration: 4 }]
        }),
        1
    );

    console.log('\n=== flattenStructure (reps × trials, ITI between-not-after) ===');
    const flattenFixture = {
        conditions: [
            { name: 'a', commands: [trialCmd, { type: 'wait', duration: 3 }] }, // dur 5
            { name: 'b', commands: [{ type: 'wait', duration: 2 }] }, // dur 2
            { name: 'iti', commands: [{ type: 'wait', duration: 1 }] } // dur 1
        ],
        sequence: [
            { kind: 'ref', condition_name: 'a' },
            {
                kind: 'block',
                name: 'blk',
                trials: ['a', 'b'],
                repetitions: 2,
                randomize: false,
                intertrial: 'iti'
            }
        ]
    };
    const flat = Runner.flattenStructure(flattenFixture);
    // ref a + [a, iti, b, iti, a, iti, b] = 8 steps (4 trials + 3 itis)
    check('total step count', flat.steps.length, 8);
    check('step0 is the ref', flat.steps[0].kind, 'ref');
    check('step0 dur = max(trialParams 5, wait 3)', flat.steps[0].dur, 5);
    check('step1 is a block-trial', flat.steps[1].kind, 'block-trial');
    check('step1 conditionName', flat.steps[1].conditionName, 'a');
    check('step1 rep index', flat.steps[1].rep, 0);
    check('step1 repsTotal', flat.steps[1].repsTotal, 2);
    check('step2 is an ITI', flat.steps[2].kind, 'iti');
    check('step2 ITI conditionName', flat.steps[2].conditionName, 'iti');
    check('step2 ITI dur', flat.steps[2].dur, 1);
    check('last step is the final trial (no trailing ITI)', flat.steps[7].kind, 'block-trial');
    check('last step conditionName', flat.steps[7].conditionName, 'b');
    check('last step rep index', flat.steps[7].rep, 1);
    checkBool('hasRandom false for a non-randomized block', flat.hasRandom === false);
    check('empty/no experiment -> 0 steps', Runner.flattenStructure(null).steps.length, 0);

    console.log('\n=== flattenStructure: randomize honors an injected shuffle (pure) ===');
    const randFixture = {
        conditions: [
            { name: 'x', commands: [] },
            { name: 'y', commands: [] }
        ],
        sequence: [
            { kind: 'block', name: 'b', trials: ['x', 'y'], repetitions: 1, randomize: true }
        ]
    };
    const nominal = Runner.flattenStructure(randFixture);
    check('no shuffle -> nominal order [x, y] (0)', nominal.steps[0].conditionName, 'x');
    check('no shuffle -> nominal order [x, y] (1)', nominal.steps[1].conditionName, 'y');
    checkBool('hasRandom flagged even without a shuffle', nominal.hasRandom === true);
    const reversed = Runner.flattenStructure(randFixture, { shuffle: (arr) => arr.reverse() });
    check('injected reverse shuffle reorders (0)', reversed.steps[0].conditionName, 'y');
    check('injected reverse shuffle reorders (1)', reversed.steps[1].conditionName, 'x');
    check(
        'source trials array NOT mutated by the shuffle',
        randFixture.sequence[0].trials.join(','),
        'x,y'
    );

    console.log('\n=== translateCommand (command → wire-neutral IR) ===');
    const trTrial = Runner.translateCommand(trialCmd, { patternId: 1 });
    check('trialParams -> op trialParams', trTrial.op, 'trialParams');
    check('trialParams -> durationSec carried', trTrial.durationSec, 5);
    check('trialParams -> params.patternId', trTrial.params.patternId, 1);
    check('trialParams -> params.mode', trTrial.params.mode, 2);
    check(
        'trialParams with null patternId -> error',
        Runner.translateCommand(trialCmd, { patternId: null }).op,
        'error'
    );
    check(
        'trialParams with bad mode -> error',
        Runner.translateCommand(
            { type: 'controller', command_name: 'trialParams', mode: 5 },
            {
                patternId: 1
            }
        ).op,
        'error'
    );
    // Bad duty must become a skip-this-trial error op (builder throw), NOT an
    // encoder RangeError that would abort the whole sequence from _runIR.
    check(
        'trialParams with duty 999 -> error (skip, not abort)',
        Runner.translateCommand(
            { type: 'controller', command_name: 'trialParams', mode: 2, duty: 999 },
            { patternId: 1 }
        ).op,
        'error'
    );
    check(
        'trialParams duty carried in params',
        Runner.translateCommand(
            { type: 'controller', command_name: 'trialParams', mode: 2, duty: 64 },
            { patternId: 1 }
        ).params.duty,
        64
    );
    // led_activation rides the trialParams IR as a normalized spec (or null).
    {
        const irLa = Runner.translateCommand(
            {
                type: 'controller',
                command_name: 'trialParams',
                mode: 3,
                led_activation: { level: 20, hysteresis: 3, on_ranges: [[50, 100]] }
            },
            { patternId: 1 }
        );
        checkBool('trialParams led_activation carried in IR', !!irLa.ledActivation);
        check('led_activation.level normalized', irLa.ledActivation.level, 20);
        check(
            'led_activation.on_ranges normalized',
            JSON.stringify(irLa.ledActivation.on_ranges),
            '[[50,100]]'
        );
        // v0.86: hysteresis is tolerated + IGNORED — the IR carries a warning the
        // runner surfaces as {phase:'warn'} (same path as startClosedLoop's).
        checkBool(
            'hysteresis → IR warning (accepted, ignored)',
            /hysteresis \(3\) is ignored/.test(irLa.warning || '')
        );
        check(
            'on_ranges sugar unrolled into one hard-edged zone',
            JSON.stringify(irLa.ledActivation.zones),
            '[{"level":20,"ramp_in":[50,50],"ramp_out":[101,101]}]'
        );
        check(
            'no warning without hysteresis',
            Runner.translateCommand(
                {
                    type: 'controller',
                    command_name: 'trialParams',
                    mode: 3,
                    led_activation: { level: 20, on_ranges: [[50, 100]] }
                },
                { patternId: 1 }
            ).warning,
            undefined
        );
        check(
            'no led_activation -> null on IR',
            Runner.translateCommand(
                { type: 'controller', command_name: 'trialParams', mode: 3 },
                { patternId: 1 }
            ).ledActivation,
            null
        );
        // A malformed spec must SKIP the trial (error op), not throw at apply time.
        check(
            'bad led_activation -> error op (skip, not abort)',
            Runner.translateCommand(
                {
                    type: 'controller',
                    command_name: 'trialParams',
                    mode: 3,
                    led_activation: { level: 20, on_ranges: [[10]] } // bad pair
                },
                { patternId: 1 }
            ).op,
            'error'
        );
    }
    check(
        'allOn -> op allOn',
        Runner.translateCommand({ type: 'controller', command_name: 'allOn' }).op,
        'allOn'
    );
    check(
        'allOff -> op allOff',
        Runner.translateCommand({ type: 'controller', command_name: 'allOff' }).op,
        'allOff'
    );
    check(
        'stopDisplay -> op stopDisplay',
        Runner.translateCommand({ type: 'controller', command_name: 'stopDisplay' }).op,
        'stopDisplay'
    );
    const trPos = Runner.translateCommand({
        type: 'controller',
        command_name: 'setPositionX',
        posX: 3
    });
    check('setPositionX -> op setFramePosition', trPos.op, 'setFramePosition');
    check('setPositionX -> 0-based index passthrough', trPos.index, 3);
    check(
        'setPositionX missing posX -> index 0',
        Runner.translateCommand({ type: 'controller', command_name: 'setPositionX' }).index,
        0
    );
    const trColor = Runner.translateCommand({
        type: 'controller',
        command_name: 'setColorDepth',
        gs_val: 16
    });
    check('setColorDepth -> op error (dropped on G6)', trColor.op, 'error');
    checkBool(
        'setColorDepth error mentions SWITCH_GRAYSCALE',
        /SWITCH_GRAYSCALE/.test(trColor.reason)
    );
    check(
        'unknown controller command -> op error',
        Runner.translateCommand({ type: 'controller', command_name: 'frobnicate' }).op,
        'error'
    );
    // G6-only I/O commands
    const trAO = Runner.translateCommand({
        type: 'controller',
        command_name: 'setAnalogOut',
        mv: 2500
    });
    check('setAnalogOut -> op setAnalogOut', trAO.op, 'setAnalogOut');
    check('setAnalogOut -> mv passthrough', trAO.mv, 2500);
    check(
        'setAnalogOut out-of-range mv -> error',
        Runner.translateCommand({ type: 'controller', command_name: 'setAnalogOut', mv: 6000 }).op,
        'error'
    );
    check(
        'setAnalogOut non-integer mv -> error',
        Runner.translateCommand({ type: 'controller', command_name: 'setAnalogOut', mv: 12.5 }).op,
        'error'
    );
    // ledDrive is the inverted BuckPuck path: 0% brightness emits LED_OFF_MV (dark),
    // brighter = LOWER mV. The scope's LED overlay keys off LED_OFF_MV (exported) to
    // tell on from off, so both must agree — assert the export and the 0% level.
    check('LED_OFF_MV is exported', Runner.LED_OFF_MV, 5000);
    // ledPercentToMv is exported for the Console LED bar (% → AO mV, same curve).
    check('ledPercentToMv exported', typeof Runner.ledPercentToMv, 'function');
    check('ledPercentToMv(0) -> LED_OFF_MV', Runner.ledPercentToMv(0), Runner.LED_OFF_MV);
    checkBool(
        'ledPercentToMv(100) < LED_OFF_MV (bright)',
        Runner.ledPercentToMv(100) < Runner.LED_OFF_MV
    );
    // Bench recalibration (2026-07-08): the dead zone is gone — input 1% now lands on
    // the just-on level (was raw 5%), so 1% must read ON and dimmer than 50%.
    checkBool(
        'ledPercentToMv(1) turns the LED on (< off)',
        Runner.ledPercentToMv(1) < Runner.LED_OFF_MV
    );
    checkBool(
        'ledPercentToMv(1) dimmer than 50% (higher mV)',
        Runner.ledPercentToMv(1) > Runner.ledPercentToMv(50)
    );
    check('ledPercentToMv(1) == raw-5% just-on level (4075 mV)', Runner.ledPercentToMv(1), 4075);
    check(
        'ledDrive 0% -> LED_OFF_MV (dark, reads off in the scope)',
        Runner.translateCommand({ type: 'controller', command_name: 'ledDrive', percent: 0 }).mv,
        Runner.LED_OFF_MV
    );
    checkBool(
        'ledDrive 100% -> below LED_OFF_MV (reads on in the scope)',
        Runner.translateCommand({ type: 'controller', command_name: 'ledDrive', percent: 100 }).mv <
            Runner.LED_OFF_MV
    );
    // ledDrive carries the commanded % so the scope can label the LED box.
    check(
        'ledDrive 50% -> ledPercent passthrough',
        Runner.translateCommand({ type: 'controller', command_name: 'ledDrive', percent: 50 })
            .ledPercent,
        50
    );
    const trDO = Runner.translateCommand({
        type: 'controller',
        command_name: 'setDigitalOut',
        channel: 2,
        state: 1
    });
    check('setDigitalOut -> op setDigitalOut', trDO.op, 'setDigitalOut');
    check('setDigitalOut -> channel passthrough', trDO.channel, 2);
    check('setDigitalOut -> state passthrough', trDO.state, 1);
    check(
        'setDigitalOut bad channel -> error',
        Runner.translateCommand({
            type: 'controller',
            command_name: 'setDigitalOut',
            channel: 3,
            state: 0
        }).op,
        'error'
    );
    check(
        'setDigitalOut bad state -> error',
        Runner.translateCommand({
            type: 'controller',
            command_name: 'setDigitalOut',
            channel: 1,
            state: 2
        }).op,
        'error'
    );
    console.log('\n=== conditional LED activation (normalize: zones + on_ranges sugar) ===');
    // normalizeLedActivation: validation + coercion, or null when absent.
    check('normalize null -> null', Runner.normalizeLedActivation(null), null);
    check('normalize undefined -> null', Runner.normalizeLedActivation(undefined), null);
    {
        const n = Runner.normalizeLedActivation({
            level: '20',
            hysteresis: '3',
            on_ranges: [
                ['50', '100'],
                [180, 150]
            ]
        });
        check('level coerced', n.level, 20);
        check('baseline defaults to 0', n.baseline, 0);
        // reversed pair [180,150] is tolerated (swapped); strings coerced.
        check(
            'on_ranges normalized + sorted-pair',
            JSON.stringify(n.on_ranges),
            '[[50,100],[150,180]]'
        );
        check(
            'on_ranges → hard-edged zones (end+1 is the first baseline frame)',
            JSON.stringify(n.zones),
            '[{"level":20,"ramp_in":[50,50],"ramp_out":[101,101]},{"level":20,"ramp_in":[150,150],"ramp_out":[181,181]}]'
        );
        checkBool(
            'hysteresis → warning string',
            /ignored since Arena Studio v0\.86/.test(n.warning)
        );
        check('hysteresis is NOT carried as a field', n.hysteresis, undefined);
    }
    {
        // explicit zones: per-zone level, ramps as pairs or bare ints, strings coerced
        const n = Runner.normalizeLedActivation({
            baseline: '2',
            zones: [
                { level: 10, ramp_in: ['40', '50'], ramp_out: [100, 110] },
                { level: 5, ramp_in: 190, ramp_out: [5] } // bare int / one-element → hard edges
            ]
        });
        check('baseline coerced', n.baseline, 2);
        check(
            'zones normalized',
            JSON.stringify(n.zones),
            '[{"level":10,"ramp_in":[40,50],"ramp_out":[100,110]},{"level":5,"ramp_in":[190,190],"ramp_out":[5,5]}]'
        );
        check('no sugar keys when none authored', n.on_ranges, undefined);
        check('no warning without hysteresis', n.warning, undefined);
        // zones inherit the top-level `level` when they omit their own
        const m = Runner.normalizeLedActivation({
            level: 7.5,
            zones: [{ ramp_in: [0, 0], ramp_out: [10, 10] }]
        });
        check('zone level falls back to top-level level (fractional ok)', m.zones[0].level, 7.5);
        // both forms together: sugar zones first, then explicit ones
        const both = Runner.normalizeLedActivation({
            level: 20,
            on_ranges: [[0, 9]],
            zones: [{ level: 5, ramp_in: [100, 110], ramp_out: [120, 130] }]
        });
        check('sugar + explicit zones coexist', both.zones.length, 2);
    }
    checkThrows('level > 100 throws', () => Runner.normalizeLedActivation({ level: 120 }));
    checkThrows('baseline > 100 throws', () => Runner.normalizeLedActivation({ baseline: 101 }));
    checkThrows('negative baseline throws', () => Runner.normalizeLedActivation({ baseline: -1 }));
    checkThrows('bad on_ranges pair throws', () =>
        Runner.normalizeLedActivation({ on_ranges: [[10]] })
    );
    checkThrows('non-array on_ranges throws', () =>
        Runner.normalizeLedActivation({ on_ranges: 5 })
    );
    checkThrows('non-array zones throws', () => Runner.normalizeLedActivation({ zones: {} }));
    checkThrows('zone without level (and no top-level level) throws', () =>
        Runner.normalizeLedActivation({ zones: [{ ramp_in: [0, 0], ramp_out: [1, 1] }] })
    );
    checkThrows('zone missing ramp_out throws', () =>
        Runner.normalizeLedActivation({ zones: [{ level: 5, ramp_in: [0, 0] }] })
    );
    checkThrows('zone level > 100 throws', () =>
        Runner.normalizeLedActivation({ zones: [{ level: 150, ramp_in: 0, ramp_out: 1 }] })
    );
    checkThrows('non-integer ramp index throws', () =>
        Runner.normalizeLedActivation({ zones: [{ level: 5, ramp_in: [0, 2.5], ramp_out: 9 }] })
    );
    checkThrows('negative ramp index throws', () =>
        Runner.normalizeLedActivation({ zones: [{ level: 5, ramp_in: [-1, 2], ramp_out: 9 }] })
    );
    checkThrows('3-element ramp throws', () =>
        Runner.normalizeLedActivation({ zones: [{ level: 5, ramp_in: [0, 1, 2], ramp_out: 9 }] })
    );

    console.log('\n=== conditional LED activation (level vector: ramps, wrap, overlap, snap) ===');
    // snapLedLevel: dark stays dark, dim-but-lit snaps up to the BuckPuck floor.
    check('snap 0 → 0', Runner.snapLedLevel(0), 0);
    check('snap 0.3 → LED_MIN_LEVEL_PCT', Runner.snapLedLevel(0.3), Runner.LED_MIN_LEVEL_PCT);
    check('snap 1 → 1', Runner.snapLedLevel(1), 1);
    check('snap 7.999999 → 8 (0.01 % resolution)', Runner.snapLedLevel(7.999999), 8);
    check('snap 250 → 100', Runner.snapLedLevel(250), 100);
    check('snap NaN → 0', Runner.snapLedLevel(NaN), 0);
    {
        // Sugar band [50,99] on a 200-frame pattern: exactly frames 50..99 lit.
        const spec = Runner.normalizeLedActivation({ level: 20, on_ranges: [[50, 99]] });
        const v = Runner.buildLedLevelVector(spec, 200);
        check('vector length = modulus', v.length, 200);
        check('49 dark', v[49], 0);
        check('50 lit', v[50], 20);
        check('99 lit (inclusive end)', v[99], 20);
        check('100 dark', v[100], 0);
        check('lit frame count = 50', v.filter((x) => x > 0).length, 50);
        // Explicit hard-edged zone form is IDENTICAL to the sugar
        const z = Runner.normalizeLedActivation({
            zones: [{ level: 20, ramp_in: [50, 50], ramp_out: [100, 100] }]
        });
        check(
            'sugar ≡ explicit hard-edged zone',
            JSON.stringify(Runner.buildLedLevelVector(z, 200)),
            JSON.stringify(v)
        );
    }
    {
        // Linear ramps: baseline at a → level at b; level at c → baseline at d.
        const spec = Runner.normalizeLedActivation({
            zones: [{ level: 20, ramp_in: [40, 50], ramp_out: [100, 110] }]
        });
        const v = Runner.buildLedLevelVector(spec, 200);
        check('ramp_in start frame (a) is baseline', v[40], 0);
        check('ramp_in midpoint = half level', v[45], 10);
        check('ramp_in end frame (b) = level', v[50], 20);
        check('plateau', v[75], 20);
        check('ramp_out start frame (c) = level', v[100], 20);
        check('ramp_out midpoint = half level', v[105], 10);
        check('ramp_out end frame (d) is baseline', v[110], 0);
        check('after d is baseline', v[111], 0);
        // 1 % floor: the first ramp step 2 % of 20 = 0.4 % … wait: (41-40)/10 * 20 = 2 %
        check('first ramp step = 2 %', v[41], 2);
        // ramp toward a level small enough that early steps fall below 1 %:
        const dim = Runner.buildLedLevelVector(
            Runner.normalizeLedActivation({
                zones: [{ level: 4, ramp_in: [0, 10], ramp_out: [20, 20] }]
            }),
            50
        );
        check('sub-1 % ramp steps snap UP to 1 % (0.4 → 1)', dim[1], 1);
        check('… but frame 0 (exactly baseline) stays dark', dim[0], 0);
        check('… 2 → 0.8 → 1', dim[2], 1);
        check('… 3 → 1.2 stays 1.2', dim[3], 1.2);
        checkBool(
            'ramp is monotone non-decreasing',
            dim.slice(0, 11).every((x, i, a) => i === 0 || x >= a[i - 1])
        );
    }
    {
        // Baseline + probe (Shubham): 2 % everywhere, a 10 % zone with 5-frame ramps.
        const spec = Runner.normalizeLedActivation({
            baseline: 2,
            zones: [{ level: 10, ramp_in: [100, 105], ramp_out: [150, 155] }]
        });
        const v = Runner.buildLedLevelVector(spec, 200);
        check('outside zones = baseline', v[0], 2);
        check('ramp starts AT baseline (not 0)', v[100], 2);
        check('ramp midpoint between baseline and level', v[102.5 | 0], 2 + (10 - 2) * (2 / 5));
        check('plateau = zone level', v[120], 10);
        check('back to baseline at d', v[155], 2);
        // A DIP zone (level below baseline) lowers the level — zones override baseline.
        const dip = Runner.buildLedLevelVector(
            Runner.normalizeLedActivation({
                baseline: 10,
                zones: [{ level: 0, ramp_in: [50, 50], ramp_out: [60, 60] }]
            }),
            100
        );
        check('dip zone: dark inside', dip[55], 0);
        check('dip zone: baseline outside', dip[49], 10);
        check(
            'baseline 0.5 snaps to 1 %',
            Runner.buildLedLevelVector(Runner.normalizeLedActivation({ baseline: 0.5 }), 10)[3],
            1
        );
    }
    {
        // Wrap through frame 0: a > d unrolls modulo n.
        const spec = Runner.normalizeLedActivation({
            zones: [{ level: 20, ramp_in: [190, 195], ramp_out: [5, 10] }]
        });
        const v = Runner.buildLedLevelVector(spec, 200);
        check('wrap: 189 dark', v[189], 0);
        check('wrap: 190 baseline (ramp start)', v[190], 0);
        check('wrap: 195 lit', v[195], 20);
        check('wrap: 199 lit', v[199], 20);
        check('wrap: 0 lit (crossed the seam)', v[0], 20);
        check('wrap: 5 lit (ramp_out start)', v[5], 20);
        check('wrap: 8 mid-ramp', v[8], 20 * (2 / 5));
        check('wrap: 10 dark', v[10], 0);
        check('wrap: 100 dark', v[100], 0);
        // A whole ramp wrapping (b < a): [198, 2]
        const w2 = Runner.buildLedLevelVector(
            Runner.normalizeLedActivation({
                zones: [{ level: 20, ramp_in: [198, 2], ramp_out: [10, 10] }]
            }),
            200
        );
        check('wrapping ramp_in: 198 baseline', w2[198], 0);
        check('wrapping ramp_in: 0 = 2/4 of level', w2[0], 10);
        check('wrapping ramp_in: 2 = level', w2[2], 20);
        // sugar on_ranges ending at the last frame: end+1 == n is fine
        const tail = Runner.buildLedLevelVector(
            Runner.normalizeLedActivation({ level: 20, on_ranges: [[150, 199]] }),
            200
        );
        check('band to the last frame: 199 lit', tail[199], 20);
        check('band to the last frame: 0 dark', tail[0], 0);
        // A zone spanning more than a full turn is capped at one turn (all lit).
        const full = Runner.buildLedLevelVector(
            Runner.normalizeLedActivation({
                zones: [{ level: 20, ramp_in: [0, 0], ramp_out: [0, 0] }]
            }),
            8
        );
        check(
            'a==b==c==d zone is EMPTY (d is the first baseline frame)',
            full.filter((x) => x > 0).length,
            0
        );
        const allOn = Runner.buildLedLevelVector(
            Runner.normalizeLedActivation({ level: 20, on_ranges: [[0, 7]] }),
            8
        );
        check('band covering every frame lights all', allOn.filter((x) => x > 0).length, 8);
    }
    {
        // Overlap → brighter wins; both ramped.
        const spec = Runner.normalizeLedActivation({
            zones: [
                { level: 10, ramp_in: [0, 0], ramp_out: [100, 100] },
                { level: 30, ramp_in: [50, 60], ramp_out: [70, 80] }
            ]
        });
        const v = Runner.buildLedLevelVector(spec, 200);
        check('overlap: below the brighter ramp, dimmer zone shows', v[52], 10);
        // at 55 the bright ramp is 15 > 10
        check('overlap: bright ramp overtakes dimmer plateau', v[55], 15);
        check('overlap: bright plateau', v[65], 30);
        check('overlap: bright ramp_out back under 10 shows 10', v[79], 10);
        check('overlap: dimmer zone alone', v[90], 10);
    }
    {
        // Unknown modulus (null): sized to the highest index + 1, nothing wraps.
        const spec = Runner.normalizeLedActivation({ level: 20, on_ranges: [[50, 99]] });
        const v = Runner.buildLedLevelVector(spec, null);
        check('unknown modulus: vector sized to highest index + 1', v.length, 101);
        check('unknown modulus: band intact', v[99], 20);
        check(
            'empty spec, unknown modulus: length 1 baseline',
            Runner.buildLedLevelVector({ baseline: 0, zones: [] }, null).length,
            1
        );
    }

    console.log('\n=== conditional LED activation (activator: ΔmV threshold, setModulus) ===');
    {
        const act = Runner.makeLedActivator(
            Runner.normalizeLedActivation({ level: 20, on_ranges: [[50, 100]] }),
            200
        );
        check('activator modulus', act.modulus, 200);
        // Nothing primed yet → the first step is a change (whatever the level).
        const r0 = act.step(10);
        check('first step: dark level', r0.level, 0);
        check('first step: OFF mV', r0.mv, Runner.LED_OFF_MV);
        check('first step reports changed (nothing on the wire yet)', r0.changed, true);
        check('on=false when dark', r0.on, false);
        check('same plateau: no change', act.step(20).changed, false);
        const r1 = act.step(50);
        check('enter band: level 20', r1.level, 20);
        check('enter band: changed', r1.changed, true);
        check('enter band: on', r1.on, true);
        check('enter band: mV = ledPercentToMv(20)', r1.mv, Runner.ledPercentToMv(20));
        check('inside band: no change', act.step(80).changed, false);
        const r2 = act.step(101);
        check('leave band: dark + changed', JSON.stringify([r2.level, r2.changed]), '[0,true]');
        // wrap: index 250 ≡ 50 on a 200 modulus
        check('index wraps on the modulus (250 ≡ 50)', act.step(250).level, 20);
        check('negative index wraps too (-150 ≡ 50)', act.levelAt(-150), 20);
        check('non-finite index → baseline', act.levelAt(NaN), 0);
        // prime(): tells the activator what is already on the wire
        const p = Runner.makeLedActivator(
            Runner.normalizeLedActivation({ level: 20, on_ranges: [[50, 100]] }),
            200
        );
        p.prime(Runner.LED_OFF_MV);
        check('primed OFF: first dark frame is NOT a change', p.step(10).changed, false);
        check('primed OFF: entering the band IS', p.step(60).changed, true);
        check('on getter follows the last change', p.on, true);
    }
    {
        // ΔmV threshold on a long shallow ramp: sends only when ≥ LED_MIN_STEP_MV apart.
        const act = Runner.makeLedActivator(
            Runner.normalizeLedActivation({
                zones: [{ level: 20, ramp_in: [0, 100], ramp_out: [150, 150] }]
            }),
            200
        );
        act.prime(Runner.LED_OFF_MV);
        let sends = 0;
        let lastMv = Runner.LED_OFF_MV;
        let minGap = Infinity;
        for (let i = 0; i <= 100; i++) {
            const r = act.step(i);
            if (r.changed) {
                sends++;
                if (lastMv !== Runner.LED_OFF_MV)
                    minGap = Math.min(minGap, Math.abs(r.mv - lastMv));
                lastMv = r.mv;
            }
        }
        checkBool('shallow ramp: fewer sends than frames', sends < 101, sends + ' sends');
        checkBool(
            'shallow ramp: every send moved ≥ LED_MIN_STEP_MV',
            minGap >= Runner.LED_MIN_STEP_MV,
            'min gap ' + minGap
        );
        check('shallow ramp: final level reached', act.step(100).level, 20);
        // OFF ↔ lit always counts as a change, however small the mV difference
        // (there is none in practice: 0 % is 5000 mV, 1 % is 4075 mV).
        const flick = Runner.makeLedActivator(
            Runner.normalizeLedActivation({ level: 1, on_ranges: [[5, 5]] }),
            10
        );
        flick.prime(Runner.LED_OFF_MV);
        check('dark → 1 % is a change', flick.step(5).changed, true);
        check('1 % → dark is a change', flick.step(6).changed, true);
    }
    {
        // setModulus re-unrolls a wrapping zone on the controller-resolved count.
        const act = Runner.makeLedActivator(
            Runner.normalizeLedActivation({
                zones: [{ level: 20, ramp_in: [190, 190], ramp_out: [10, 10] }]
            }),
            null
        );
        check('pre-loop placeholder modulus = highest index + 1', act.modulus, 191);
        act.setModulus(200);
        check('setModulus resizes', act.modulus, 200);
        check('wrapped zone lit at 0 after setModulus', act.levelAt(0), 20);
        check('wrapped zone lit at 195', act.levelAt(195), 20);
        check('wrapped zone dark at 100', act.levelAt(100), 0);
        act.setModulus(200);
        check('same modulus is a no-op', act.modulus, 200);
        act.setModulus(0);
        check('invalid modulus ignored', act.modulus, 200);
        // raw (un-normalized) spec is accepted too
        const raw = Runner.makeLedActivator({ level: 20, on_ranges: [[1, 2]] }, 4);
        check('raw spec normalized on the way in', JSON.stringify(raw.levels), '[0,20,20,0]');
    }

    console.log(
        '\n=== conditional LED activation (runner wiring: coalesced sends, hasPending yield) ==='
    );
    // Runner wiring: _installLedActivator subscribes to the bridge 'applied'
    // event, sends SET_AO_VOLTAGE per level change (single-flight, latest wins),
    // yields while the bridge client has a frame pending, and emits a
    // 'led-activation' status per send (run-log provenance).
    {
        const AO = 0xa0;
        const tick = () => new Promise((r) => setTimeout(r, 0));
        const mkHarness = () => {
            const sent = [];
            const link = {
                connected: true,
                async send(b) {
                    sent.push(Array.from(b));
                    return new Uint8Array([0x02, 0x00, b[1]]);
                }
            };
            const handlers = {};
            const bridge = {
                hasPending: false,
                on(ev, fn) {
                    (handlers[ev] = handlers[ev] || new Set()).add(fn);
                    return () => handlers[ev].delete(fn);
                },
                off(ev, fn) {
                    if (handlers[ev]) handlers[ev].delete(fn);
                },
                emit(ev, x) {
                    (handlers[ev] || []).forEach((f) => f(x));
                }
            };
            const runner = new Runner.ArenaRunner(link, Wire, bridge);
            const events = [];
            runner._emit = (s) => events.push(s); // stand in for a run's status sink
            const ao = () => sent.filter((f) => f[1] === AO);
            return { sent, link, bridge, runner, events, ao };
        };
        {
            const h = mkHarness();
            h.runner._installLedActivator(
                Runner.normalizeLedActivation({ level: 20, on_ranges: [[50, 100]] }),
                200
            );
            check('install sends 1 baseline AO frame (dark)', h.ao().length, 1);
            checkBytes(
                'baseline frame is SET_AO_VOLTAGE 5000 mV',
                h.sent[0],
                Array.from(Wire.encodeSetAoVoltage(5000))
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join(' ')
            );
            for (const i of [10, 50, 80, 101, 103, 60]) {
                h.bridge.emit('applied', i);
                await tick();
            }
            const transitions = h.events.filter((e) => e.phase === 'led-activation');
            // 3 sends: ON@50, OFF@101, ON@60 (10 = primed baseline, 80 inside, 103 still dark).
            check('AO sent only on level changes (1 baseline + 3)', h.ao().length, 4);
            check('3 led-activation events emitted', transitions.length, 3);
            check('first: on', transitions[0].on, true);
            check('first: frame', transitions[0].index, 50);
            check('first: ledPercent', transitions[0].ledPercent, 20);
            check('first: mv = ledPercentToMv(20)', transitions[0].mv, Runner.ledPercentToMv(20));
            check(
                'second: off @101',
                JSON.stringify([transitions[1].on, transitions[1].index]),
                '[false,101]'
            );
            check('second: ledPercent 0', transitions[1].ledPercent, 0);
            // Teardown forces the LED off and stops gating.
            h.runner._clearLedActivator();
            const afterClear = h.ao().length;
            check('teardown sends a final OFF', afterClear, 5);
            // The LED was ON (@60) when torn down → teardown emits the OFF edge, so the
            // scope's LED box closes at trial end instead of bleeding into the next trial.
            const tearEv = h.events.filter((e) => e.phase === 'led-activation');
            check('teardown of a lit LED emits one OFF event', tearEv.length, 4);
            check(
                'teardown event: off, teardown flag, no frame',
                JSON.stringify([tearEv[3].on, tearEv[3].teardown, tearEv[3].index]),
                '[false,true,null]'
            );
            h.bridge.emit('applied', 60); // superseded — must NOT send or emit
            await tick();
            check('no AO after teardown', h.ao().length, afterClear);
            check(
                'no events after teardown',
                h.events.filter((e) => e.phase === 'led-activation').length,
                4
            );
        }
        {
            // THE rig03 2026-09-23 bug: a zone covering EVERY frame (course "uniform
            // heat" baseline/probe: level 3, on_ranges [[0,199]]) lights the LED at
            // install, nothing ever "changes", and no event was emitted — the scope
            // showed no LED box and the run log had no ON edge for the whole trial.
            const h = mkHarness();
            h.runner._installLedActivator(
                Runner.normalizeLedActivation({ level: 3, on_ranges: [[0, 199]] }),
                200
            );
            checkBytes(
                'all-frames zone: install sends 3 % (lit baseline)',
                h.sent[0],
                Array.from(Wire.encodeSetAoVoltage(Runner.ledPercentToMv(3)))
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join(' ')
            );
            let ev = h.events.filter((e) => e.phase === 'led-activation');
            check('all-frames zone: install emits ONE on-event', ev.length, 1);
            check(
                'install event: on, baseline flag, 3 %, no frame',
                JSON.stringify([ev[0].on, ev[0].baseline, ev[0].ledPercent, ev[0].index]),
                '[true,true,3,null]'
            );
            for (const i of [0, 57, 108, 199]) {
                h.bridge.emit('applied', i);
                await tick();
            }
            check('frames inside the zone: no extra sends', h.ao().length, 1);
            check(
                'frames inside the zone: no extra events',
                h.events.filter((e) => e.phase === 'led-activation').length,
                1
            );
            h.runner._clearLedActivator();
            ev = h.events.filter((e) => e.phase === 'led-activation');
            check('teardown emits the OFF edge', ev.length, 2);
            check('teardown event is off', ev[1].on, false);
        }
        {
            // Dark baseline + teardown while dark: no spurious events either way.
            const h = mkHarness();
            h.runner._installLedActivator(
                Runner.normalizeLedActivation({ level: 20, on_ranges: [[50, 100]] }),
                200
            );
            h.bridge.emit('applied', 10); // dark
            await tick();
            h.runner._clearLedActivator();
            check(
                'dark install + dark teardown: zero events',
                h.events.filter((e) => e.phase === 'led-activation').length,
                0
            );
        }
        {
            // Ramp: one send per frame while the level moves ≥ 4 mV, none on the plateau.
            const h = mkHarness();
            h.runner._installLedActivator(
                Runner.normalizeLedActivation({
                    zones: [{ level: 20, ramp_in: [0, 10], ramp_out: [50, 60] }]
                }),
                100
            );
            for (let i = 0; i <= 30; i++) {
                h.bridge.emit('applied', i);
                await tick();
            }
            const ev = h.events.filter((e) => e.phase === 'led-activation');
            check('ramp 0→10 then plateau: 10 sends (frames 1..10)', ev.length, 10);
            checkBool(
                'levels increase monotonically',
                ev.every((e, i, a) => i === 0 || e.ledPercent > a[i - 1].ledPercent)
            );
            check('first ramp step is 2 %', ev[0].ledPercent, 2);
            check('last ramp step is 20 %', ev[ev.length - 1].ledPercent, 20);
            checkBool(
                'mV decreases as level rises (BuckPuck: lower V = brighter)',
                ev.every((e, i, a) => i === 0 || e.mv < a[i - 1].mv)
            );
            check('no sends on the plateau (11..30)', h.ao().length, 1 + 10);
        }
        {
            // Latest-wins coalescing: frames arriving while a send is in flight
            // collapse to the newest level.
            const h = mkHarness();
            let release = null;
            h.link.send = (b) => {
                h.sent.push(Array.from(b));
                return new Promise((res) => {
                    release = () => res(new Uint8Array([0x02, 0x00, b[1]]));
                });
            };
            h.runner._installLedActivator(
                Runner.normalizeLedActivation({
                    zones: [{ level: 20, ramp_in: [0, 10], ramp_out: [50, 60] }]
                }),
                100
            );
            release(); // baseline send completes
            await tick();
            h.bridge.emit('applied', 1); // 2 % → send in flight
            await tick();
            h.bridge.emit('applied', 2); // 4 %  (pending)
            h.bridge.emit('applied', 3); // 6 %  (supersedes)
            h.bridge.emit('applied', 5); // 10 % (supersedes)
            await tick();
            check('only the in-flight send so far (1 baseline + 1)', h.ao().length, 2);
            release(); // in-flight completes → drain picks up the NEWEST pending (10 %)
            await tick();
            check('coalesced: one more send (newest wins)', h.ao().length, 3);
            release();
            await tick();
            const ev = h.events.filter((e) => e.phase === 'led-activation');
            check(
                'events: 2 % then 10 % (4 %, 6 % dropped)',
                JSON.stringify(ev.map((e) => e.ledPercent)),
                '[2,10]'
            );
            check('event index is the frame the level came from', ev[1].index, 5);
        }
        {
            // hasPending yield: while the bridge client holds a frame, no AO write.
            const h = mkHarness();
            h.runner._installLedActivator(
                Runner.normalizeLedActivation({ level: 20, on_ranges: [[50, 100]] }),
                200
            );
            await tick();
            h.bridge.hasPending = true;
            h.bridge.emit('applied', 50); // enter band, but a 0x70 is queued
            await tick();
            check('yield: no AO while a frame is pending', h.ao().length, 1);
            check(
                'yield: nothing emitted yet',
                h.events.filter((e) => e.phase === 'led-activation').length,
                0
            );
            h.bridge.emit('applied', 51); // still pending
            await tick();
            check('yield: still nothing', h.ao().length, 1);
            h.bridge.hasPending = false;
            h.bridge.emit('applied', 52); // link free → the waiting level goes out
            await tick();
            check('resumed: the pending level is sent once', h.ao().length, 2);
            const ev = h.events.filter((e) => e.phase === 'led-activation');
            check(
                'resumed: one event, level 20',
                JSON.stringify([ev.length, ev[0].ledPercent]),
                '[1,20]'
            );
            // A level change while yielding is superseded, not queued twice.
            h.bridge.hasPending = true;
            h.bridge.emit('applied', 101); // dark (pending)
            h.bridge.emit('applied', 60); // lit again (supersedes the dark)
            await tick();
            h.bridge.hasPending = false;
            h.bridge.emit('applied', 61);
            await tick();
            check('superseded while yielding: no extra send', h.ao().length, 2);
            check(
                'superseded while yielding: no extra event',
                h.events.filter((e) => e.phase === 'led-activation').length,
                1
            );
        }
        {
            // Baseline > 0: install sends the BASELINE level, teardown sends OFF.
            const h = mkHarness();
            h.runner._installLedActivator(
                Runner.normalizeLedActivation({
                    baseline: 2,
                    zones: [{ level: 10, ramp_in: [50, 50], ramp_out: [60, 60] }]
                }),
                100
            );
            checkBytes(
                'install sends the baseline (2 %)',
                h.sent[0],
                Array.from(Wire.encodeSetAoVoltage(Runner.ledPercentToMv(2)))
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join(' ')
            );
            h.bridge.emit('applied', 10); // on the baseline → primed, no send
            await tick();
            check('baseline frame: no send', h.ao().length, 1);
            check(
                'lit baseline: install emitted on @ 2 %',
                JSON.stringify(
                    h.events
                        .filter((e) => e.phase === 'led-activation')
                        .map((e) => [e.on, e.ledPercent, e.baseline === true])
                ),
                '[[true,2,true]]'
            );
            h.runner._clearLedActivator();
            check(
                'lit baseline: teardown emitted off',
                h.events.filter((e) => e.phase === 'led-activation').pop().on,
                false
            );
            checkBytes(
                'teardown sends OFF (not baseline)',
                h.sent[h.sent.length - 1],
                Array.from(Wire.encodeSetAoVoltage(5000))
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join(' ')
            );
        }
        {
            // Link gone: no throw, nothing sent, events still recorded.
            const h = mkHarness();
            h.link.connected = false;
            h.runner._installLedActivator(
                Runner.normalizeLedActivation({ level: 20, on_ranges: [[50, 100]] }),
                200
            );
            h.bridge.emit('applied', 50);
            await tick();
            check('link down: nothing sent', h.ao().length, 0);
            check(
                'link down: event still logged',
                h.events.filter((e) => e.phase === 'led-activation').length,
                1
            );
        }
    }

    const trWait = Runner.translateCommand({ type: 'wait', duration: 3 });
    check('wait -> op wait', trWait.op, 'wait');
    check('wait -> durationSec', trWait.durationSec, 3);
    const trPlugin = Runner.translateCommand({
        type: 'plugin',
        plugin_name: 'camera',
        command_name: 'getTimestamp'
    });
    check('plugin -> op skip', trPlugin.op, 'skip');
    check('plugin skip carries plugin_name', trPlugin.plugin_name, 'camera');

    console.log('\n=== runSequence: happy path (fake link, instant sleep) ===');
    {
        const link = makeFakeLink();
        const runner = new Runner.ArenaRunner(link, Wire);
        const steps = [
            { kind: 'ref', conditionName: 'check', label: 'check', seqIdx: 0, dur: 1 },
            { kind: 'ref', conditionName: 'show', label: 'show', seqIdx: 1, dur: 5 }
        ];
        const conditionsByName = new Map([
            [
                'check',
                {
                    name: 'check',
                    commands: [
                        { type: 'controller', command_name: 'allOn' },
                        { type: 'wait', duration: 1 }
                    ]
                }
            ],
            ['show', { name: 'show', commands: [trialCmd, { type: 'wait', duration: 2 }] }]
        ]);
        const phases = [];
        const summary = await runner.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            sleep: () => Promise.resolve(),
            onProgress: (s) => phases.push(s.phase)
        });
        check('sent exactly 3 frames (allOn, trialParams, final STOP)', link.sent.length, 3);
        checkBytes('1st send: allOn', link.sent[0], '01 ff');
        checkBytes(
            '2nd send: trialParams',
            link.sent[1],
            '0d 08 02 01 00 0a 00 01 00 00 00 00 00 00'
        );
        checkBytes('3rd send: final STOP', link.sent[2], '01 30');
        checkBool('summary.completed true', summary.completed === true);
        checkBool('summary.aborted false', summary.aborted === false);
        check('summary.errors 0', summary.errors, 0);
        check('summary.skipped 0', summary.skipped, 0);
        checkBool('emitted sequence-start', phases.includes('sequence-start'));
        checkBool('emitted trial-running', phases.includes('trial-running'));
        checkBool('emitted sequence-complete', phases.includes('sequence-complete'));
        checkBool('runner inactive after a completed run', runner.active === false);
    }

    console.log('\n=== runSequence: G6-only I/O commands emit the right wire frames ===');
    {
        const link = makeFakeLink();
        const runner = new Runner.ArenaRunner(link, Wire);
        const steps = [{ kind: 'ref', conditionName: 'io', label: 'io', seqIdx: 0, dur: 0 }];
        const conditionsByName = new Map([
            [
                'io',
                {
                    name: 'io',
                    commands: [
                        { type: 'controller', command_name: 'setDigitalOut', channel: 2, state: 1 },
                        { type: 'controller', command_name: 'setAnalogOut', mv: 2500 }
                    ]
                }
            ]
        ]);
        const summary = await runner.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            sleep: () => Promise.resolve()
        });
        // setDigitalOut(2,1) -> 03 aa 02 01 ; setAnalogOut(2500=0x09C4) -> 03 a0 c4 09 ;
        // then the final STOP.
        checkBytes('1st send: setDigitalOut(2,HIGH)', link.sent[0], '03 aa 02 01');
        checkBytes('2nd send: setAnalogOut(2500 mV)', link.sent[1], '03 a0 c4 09');
        checkBytes('final STOP sent', link.sent[link.sent.length - 1], '01 30');
        check('no errors for valid I/O commands', summary.errors, 0);
        check('no skips for valid I/O commands', summary.skipped, 0);
    }

    console.log('\n=== runSequence: optional trial-boundary condition resolution ===');
    {
        const link = makeFakeLink();
        const runner = new Runner.ArenaRunner(link, Wire);
        const steps = [
            {
                kind: 'ref',
                conditionName: 'runtime_led',
                label: 'runtime_led',
                seqIdx: 0,
                dur: 0
            }
        ];
        const sourceCondition = {
            name: 'runtime_led',
            commands: [{ type: 'controller', command_name: 'setAnalogOut', mv: 5000 }]
        };
        const conditionsByName = new Map([['runtime_led', sourceCondition]]);
        const record = {
            event: 'runtime_control_trial_parameters',
            trial_index: 0,
            condition_name: 'runtime_led',
            resolved_variables: { led_mv: 2500 },
            resolved_commands: [{ type: 'controller', command_name: 'setAnalogOut', mv: 2500 }],
            parameter_bindings: [
                { variable: 'led_mv', command_index: 0, parameter_path: ['mv'], value: 2500 }
            ],
            runtime_control_provenance: { led_mv: { source: 'runtime_control' } },
            apply_events: [
                {
                    event: 'runtime_control_apply',
                    variable: 'led_mv',
                    old_value: 5000,
                    new_value: 2500,
                    request_id: 'r1'
                }
            ]
        };
        const phases = [];
        const emitted = [];
        let hookContext = null;
        const summary = await runner.runSequence({
            steps,
            conditionsByName,
            sleep: () => Promise.resolve(),
            resolveCondition: async (conditionName, context) => {
                hookContext = { conditionName, context };
                return { runtimeRecord: record };
            },
            onProgress: (s) => {
                phases.push(s.phase);
                emitted.push(s);
            }
        });
        check('resolver receives condition name', hookContext.conditionName, 'runtime_led');
        check('resolver receives zero-based boundary index', hookContext.context.index, 0);
        checkBool(
            'resolver receives original condition',
            hookContext.context.condition === sourceCondition
        );
        checkBytes('resolved command is sent', link.sent[0], '03 a0 c4 09');
        check('source condition remains unchanged', sourceCondition.commands[0].mv, 5000);
        checkBool('runtime-control-applied emitted', phases.includes('runtime-control-applied'));
        checkBool('trial-resolved emitted', phases.includes('trial-resolved'));
        checkBool(
            'boundary events precede the resolved command',
            phases.indexOf('runtime-control-applied') < phases.indexOf('command') &&
                phases.indexOf('trial-resolved') < phases.indexOf('command')
        );
        const applyStatus = emitted.find((s) => s.phase === 'runtime-control-applied');
        const resolvedStatus = emitted.find((s) => s.phase === 'trial-resolved');
        check(
            'apply status keeps complete event',
            applyStatus.runtimeControlApply,
            record.apply_events[0]
        );
        checkBool(
            'trial status keeps authoritative record',
            resolvedStatus.runtimeRecord === record
        );
        checkBool('resolved run completes', summary.completed === true);
    }
    {
        // Returning a condition directly is the lightweight, non-runtime use of
        // the hook; it should not create provenance phases.
        const link = makeFakeLink();
        const runner = new Runner.ArenaRunner(link, Wire);
        const phases = [];
        await runner.runSequence({
            steps: [{ conditionName: 'switch' }],
            conditionsByName: new Map([
                [
                    'switch',
                    {
                        name: 'switch',
                        commands: [{ type: 'controller', command_name: 'allOn' }]
                    }
                ]
            ]),
            resolveCondition: () => ({
                name: 'switch',
                commands: [{ type: 'controller', command_name: 'allOff' }]
            }),
            sleep: () => Promise.resolve(),
            onProgress: (s) => phases.push(s.phase)
        });
        checkBytes('direct replacement condition executes', link.sent[0], '01 00');
        checkBool('direct replacement emits no runtime phase', !phases.includes('trial-resolved'));
    }
    {
        const link = makeFakeLink();
        const runner = new Runner.ArenaRunner(link, Wire);
        const statuses = [];
        const summary = await runner.runSequence({
            steps: [{ conditionName: 'bad-boundary' }],
            conditionsByName: new Map([
                ['bad-boundary', { commands: [{ type: 'controller', command_name: 'allOn' }] }]
            ]),
            resolveCondition: () => {
                throw new Error('audit record unavailable');
            },
            sleep: () => Promise.resolve(),
            onProgress: (s) => statuses.push(s)
        });
        checkBool(
            'resolver failure is surfaced with context',
            statuses.some(
                (s) => s.phase === 'error' && /condition resolution failed/.test(s.reason || '')
            )
        );
        checkBool(
            'resolver failure does not send source command',
            !link.sent.some((frame) => frame[1] === 0xff)
        );
        check('resolver failure increments errors', summary.errors, 1);
    }

    console.log(
        '\n=== runSequence: plugin skipped + unsupported errored, arena cmds still run ==='
    );
    {
        const link = makeFakeLink();
        const runner = new Runner.ArenaRunner(link, Wire);
        const steps = [{ kind: 'ref', conditionName: 'mixed', label: 'mixed', seqIdx: 0, dur: 0 }];
        const conditionsByName = new Map([
            [
                'mixed',
                {
                    name: 'mixed',
                    commands: [
                        { type: 'plugin', plugin_name: 'camera', command_name: 'getTimestamp' },
                        { type: 'controller', command_name: 'setColorDepth', gs_val: 16 },
                        { type: 'controller', command_name: 'allOff' }
                    ]
                }
            ]
        ]);
        const phases = [];
        const summary = await runner.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            sleep: () => Promise.resolve(),
            onProgress: (s) => phases.push(s.phase)
        });
        check('plugin counted as skipped', summary.skipped, 1);
        check('setColorDepth counted as error', summary.errors, 1);
        // allOff (01 00) sent, then the final STOP (01 30). The plugin + setColorDepth
        // emit NO wire frame.
        checkBytes('arena allOff still sent', link.sent[0], '01 00');
        checkBytes('final STOP sent', link.sent[link.sent.length - 1], '01 30');
        checkBool('emitted a skip phase', phases.includes('skip'));
        checkBool('emitted an error phase', phases.includes('error'));
        checkBool('run still completed (proceed-and-skip)', summary.completed === true);
    }

    console.log('\n=== runSequence: STOP mid-run aborts (no later steps sent) ===');
    {
        // A fake link that calls runner.stop() on the first allOn send, so the abort
        // flag is set before the loop reaches step 1 (cond b's allOff).
        let triggered = false;
        let runnerRef = null;
        const link = {
            connected: true,
            sent: [],
            async send(bytes) {
                this.sent.push(Array.from(bytes));
                if (!triggered && bytes[1] === 0xff) {
                    triggered = true;
                    runnerRef.stop(); // fire-and-forget; sets _abort synchronously
                }
                return new Uint8Array([0x02, 0x00, bytes[1]]);
            }
        };
        runnerRef = new Runner.ArenaRunner(link, Wire);
        const steps = [
            { kind: 'ref', conditionName: 'a', label: 'a', seqIdx: 0, dur: 0 },
            { kind: 'ref', conditionName: 'b', label: 'b', seqIdx: 1, dur: 0 }
        ];
        const conditionsByName = new Map([
            ['a', { name: 'a', commands: [{ type: 'controller', command_name: 'allOn' }] }],
            ['b', { name: 'b', commands: [{ type: 'controller', command_name: 'allOff' }] }]
        ]);
        const summary = await runnerRef.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            sleep: () => Promise.resolve()
        });
        checkBool('cond b allOff (01 00) never sent', !link.sent.some((f) => f[1] === 0x00));
        checkBool('summary.aborted true', summary.aborted === true);
        checkBool('summary.completed false', summary.completed === false);
        checkBool('runner inactive after abort', runnerRef.active === false);
    }

    console.log('\n=== runSequence: host-side timing — trial OVERLAPS waits (no double-count) ===');
    {
        // Inject a sleep that SUMS requested ms instead of waiting, so we can assert
        // the total host time per condition == max(trialDuration, sum(waits)).
        const totalSleptSec = async (commands) => {
            const link = makeFakeLink();
            const runner = new Runner.ArenaRunner(link, Wire);
            let ms = 0;
            await runner.runSequence({
                steps: [{ kind: 'ref', conditionName: 'c', label: 'c', seqIdx: 0, dur: 0 }],
                conditionsByName: new Map([['c', { name: 'c', commands }]]),
                resolvePatternId: () => 1,
                sleep: (n) => {
                    ms += n;
                    return Promise.resolve();
                }
            });
            return ms / 1000;
        };
        const tp = (d) => ({
            type: 'controller',
            command_name: 'trialParams',
            mode: 2,
            frame_rate: 10,
            gain: 0,
            frame_index: 0,
            duration: d
        });
        const w = (d) => ({ type: 'wait', duration: d });
        const allOn = { type: 'controller', command_name: 'allOn' };
        check(
            'trialParams(5)+wait(5) = 5s (overlap, NOT 10)',
            await totalSleptSec([tp(5), w(5)]),
            5
        );
        check(
            'trialParams(10)+wait(3) = 10s (waits + 7s top-up)',
            await totalSleptSec([tp(10), w(3)]),
            10
        );
        check('standalone trialParams(5) = 5s (full top-up)', await totalSleptSec([tp(5)]), 5);
        check('no trialParams: allOn+wait(2) = 2s', await totalSleptSec([allOn, w(2)]), 2);
        check(
            'two waits sum: trialParams(2)+wait(3)+wait(4) = 7s',
            await totalSleptSec([tp(2), w(3), w(4)]),
            7
        );
    }

    console.log('\n=== FicTrac + log plugin: translateCommand ===');
    {
        const fic = new Set(['fictrac']);
        const t = (name, params) =>
            Runner.translateCommand(
                { type: 'plugin', plugin_name: 'fictrac', command_name: name, params },
                { fictracPluginNames: fic }
            );
        check('connect -> fictracConnect', t('connect').op, 'fictracConnect');
        check('disconnect -> fictracDisconnect', t('disconnect').op, 'fictracDisconnect');
        const scl = t('startClosedLoop', { coupling: 0.75 });
        check('startClosedLoop -> fictracApply', scl.op, 'fictracApply');
        checkBool('startClosedLoop on=true', scl.on === true);
        check('startClosedLoop carries the coupling', scl.coupling, 0.75);
        check('no deg_per_frame → null (rig pitch)', scl.degPerFrame, null);
        check('no start_frame → startFrame null (epoch opens at frame 0)', scl.startFrame, null);
        check(
            'start_frame carried as an integer (per-trial start position)',
            t('startClosedLoop', { start_frame: 57 }).startFrame,
            57
        );
        check(
            'start_frame "108" (string from YAML) is accepted',
            t('startClosedLoop', { start_frame: '108' }).startFrame,
            108
        );
        check(
            'non-integer start_frame → error (not silently dropped)',
            t('startClosedLoop', { start_frame: 57.5 }).op,
            'error'
        );
        check(
            'negative start_frame → error',
            t('startClosedLoop', { start_frame: -1 }).op,
            'error'
        );
        check('coupling defaults to 1', t('startClosedLoop', {}).coupling, 1);
        check(
            'deg_per_frame override carried',
            t('startClosedLoop', { deg_per_frame: 3.6 }).degPerFrame,
            3.6
        );
        check(
            'coupling 0 is legal (bias-only replay)',
            t('startClosedLoop', { coupling: 0 }).coupling,
            0
        );
        // The pre-v0.85 `gain` (deg/frame) is RETIRED. ±1.8 (= coupling ±1, the only
        // unambiguous legacy values) run with a deprecation warning; anything else (a
        // fractional coupling that used to jump once per revolution) is refused.
        const legacyPos = t('startClosedLoop', { gain: 1.8 });
        checkDeep(
            'legacy gain 1.8 → coupling 1 (soft-accept)',
            [legacyPos.op, legacyPos.coupling],
            ['fictracApply', 1]
        );
        checkBool(
            '...with a deprecation warning',
            /retired/.test(legacyPos.warning) && /coupling: 1/.test(legacyPos.warning),
            legacyPos.warning
        );
        check('legacy gain -1.8 → coupling -1', t('startClosedLoop', { gain: -1.8 }).coupling, -1);
        check(
            'explicit coupling wins over a legacy gain',
            t('startClosedLoop', { gain: 1.8, coupling: 0.5 }).coupling,
            0.5
        );
        check(
            'defaultCoupling (from a legacy plugin-config gain) applies when the step names none',
            Runner.translateCommand(
                { type: 'plugin', plugin_name: 'fictrac', command_name: 'startClosedLoop' },
                { fictracPluginNames: new Set(['fictrac']), defaultCoupling: -1 }
            ).coupling,
            -1
        );
        const retired = t('startClosedLoop', { gain: 1.2 });
        check('retired gain 1.2 (a fractional coupling) → error step', retired.op, 'error');
        checkBool(
            '...hinting the equivalent coupling 1.5',
            /coupling 1\.5/.test(retired.reason),
            retired.reason
        );
        checkBool(
            '...naming coupling as the replacement',
            /coupling/.test(retired.reason) && /retired/.test(retired.reason),
            retired.reason
        );
        check('bad coupling → error', t('startClosedLoop', { coupling: 'x' }).op, 'error');
        check(
            'non-positive deg_per_frame → error',
            t('startClosedLoop', { deg_per_frame: 0 }).op,
            'error'
        );
        // Every closed-loop epoch is SELF-DESCRIBING: with no bias authored the IR still
        // carries {type:'none'} so the bridge can't keep driving this trial with a
        // waveform left over from an earlier condition or an aborted run.
        checkDeep('no bias authored -> explicit {type:none}', scl.bias, { type: 'none' });
        check('stopClosedLoop -> on=false', t('stopClosedLoop').on, false);
        // stopClosedLoop MUST clear the bias: the bridge integrates from its own phase
        // clock, so a waveform left installed keeps skewing the frame index through
        // every following trial.
        checkDeep('stopClosedLoop clears the bias', t('stopClosedLoop').bias, { type: 'none' });
        // recording was removed from the fictrac plugin: it now falls through to
        // the unknown-command skip (driving the arena is the only real command).
        check('removed startRecording -> skip', t('startRecording').op, 'skip');
        check('unknown fictrac cmd -> skip', t('frobnicate').op, 'skip');
        // built-in log plugin executes regardless of fictrac names
        const lg = Runner.translateCommand(
            {
                type: 'plugin',
                plugin_name: 'log',
                command_name: 'log',
                params: { message: 'hi', level: 'WARNING' }
            },
            {}
        );
        check('log plugin -> logMessage', lg.op, 'logMessage');
        check('logMessage carries message', lg.message, 'hi');
        check('logMessage carries level', lg.level, 'WARNING');
        // a fictrac command WITHOUT the names set falls back to skip
        check(
            'fictrac cmd w/o names -> skip',
            Runner.translateCommand(
                { type: 'plugin', plugin_name: 'fictrac', command_name: 'connect' },
                {}
            ).op,
            'skip'
        );
        // any OTHER plugin still skips
        check(
            'camera plugin -> skip',
            Runner.translateCommand(
                { type: 'plugin', plugin_name: 'camera', command_name: 'x' },
                { fictracPluginNames: fic }
            ).op,
            'skip'
        );
    }

    console.log('\n=== closed-loop bias: normalizeBias + translateCommand (LAB-185) ===');
    {
        const fic = new Set(['fictrac']);
        const scl = (params) =>
            Runner.translateCommand(
                {
                    type: 'plugin',
                    plugin_name: 'fictrac',
                    command_name: 'startClosedLoop',
                    params
                },
                { fictracPluginNames: fic }
            );

        // --- happy paths: the spec reaches the IR normalized -------------------
        check(
            'bias_type omitted -> null (IR shape unchanged)',
            Runner.normalizeBias({}).bias,
            null
        );
        check('bias_type none -> null', Runner.normalizeBias({ bias_type: 'none' }).bias, null);
        check(
            'bias_type "" -> null (blank designer field)',
            Runner.normalizeBias({ bias_type: '' }).bias,
            null
        );
        checkDeep(
            'constant normalizes',
            Runner.normalizeBias({ bias_type: 'constant', bias_amplitude: 90 }).bias,
            {
                type: 'constant',
                amplitude: 90,
                frequency: 0
            }
        );
        checkDeep(
            'sine normalizes',
            Runner.normalizeBias({ bias_type: 'sine', bias_amplitude: 90, bias_frequency: 0.5 })
                .bias,
            { type: 'sine', amplitude: 90, frequency: 0.5 }
        );
        // YAML parsers can hand back string scalars — coerce like the rest of the runner.
        checkDeep(
            'string scalars coerced',
            Runner.normalizeBias({ bias_type: 'square', bias_amplitude: '45', bias_frequency: '2' })
                .bias,
            { type: 'square', amplitude: 45, frequency: 2 }
        );
        check(
            'bias_type is case/space tolerant',
            Runner.normalizeBias({ bias_type: '  Sine ', bias_amplitude: 1, bias_frequency: 1 })
                .bias.type,
            'sine'
        );
        check(
            'negative amplitude kept (that is how you reverse direction)',
            Runner.normalizeBias({ bias_type: 'constant', bias_amplitude: -90 }).bias.amplitude,
            -90
        );

        const biased = scl({
            bias_type: 'sine',
            bias_amplitude: 90,
            bias_frequency: 0.5
        });
        checkDeep('startClosedLoop carries the bias into the IR', biased.bias, {
            type: 'sine',
            amplitude: 90,
            frequency: 0.5
        });
        check('coupling defaults to 1 alongside a bias', biased.coupling, 1);
        check('no warning on a clean spec', biased.warning, null);

        // --- FAIL the step (not the run) on a malformed spec -------------------
        // Mirrors the `duty` precedent: {op:'error'} skips this step with a message
        // instead of aborting the sequence or silently no-op'ing at the bridge.
        const bad = scl({ bias_type: 'triangle' });
        check('unknown bias_type -> error', bad.op, 'error');
        checkBool(
            'unknown bias_type names the legal values',
            /none\/constant\/sine\/square/.test(bad.reason),
            bad.reason
        );
        // 0 Hz is the divide-by-ω case. The bridge would defensively return a 0 bias,
        // which reads as "the disturbance didn't work" — so fail loudly here instead.
        const zeroHz = scl({ bias_type: 'sine', bias_amplitude: 90, bias_frequency: 0 });
        check('sine at 0 Hz -> error', zeroHz.op, 'error');
        checkBool('0 Hz error suggests constant', /constant/.test(zeroHz.reason), zeroHz.reason);
        check(
            'square at 0 Hz -> error',
            scl({ bias_type: 'square', bias_amplitude: 90, bias_frequency: 0 }).op,
            'error'
        );
        check(
            'sine with bias_frequency omitted -> error (defaults to 0)',
            scl({ bias_type: 'sine', bias_amplitude: 90 }).op,
            'error'
        );
        check(
            'non-numeric amplitude -> error',
            scl({ bias_type: 'constant', bias_amplitude: 'lots' }).op,
            'error'
        );
        check(
            'non-numeric frequency -> error',
            scl({ bias_type: 'sine', bias_amplitude: 90, bias_frequency: 'fast' }).op,
            'error'
        );

        // --- 0 Hz is FINE for constant (there is no period to divide by) -------
        const const0 = scl({ bias_type: 'constant', bias_amplitude: 90, bias_frequency: 0 });
        check('constant ignores bias_frequency 0', const0.op, 'fictracApply');
        check('constant needs no frequency', const0.bias.type, 'constant');

        // --- WARN but still run on a negative frequency ------------------------
        // It is well-defined yet a no-op (both velocities are cosines, even in ω), so
        // the author probably meant to negate the amplitude. Run it, and say so.
        const negF = scl({ bias_type: 'sine', bias_amplitude: 90, bias_frequency: -0.5 });
        check('negative frequency still runs', negF.op, 'fictracApply');
        check('negative frequency preserved verbatim in the IR', negF.bias.frequency, -0.5);
        checkBool('negative frequency warns', typeof negF.warning === 'string', negF.warning);
        checkBool(
            'the warning points at bias_amplitude',
            /bias_amplitude/.test(negF.warning),
            negF.warning
        );
    }

    console.log('\n=== FicTrac closed-loop: runSequence drives the bridge ===');
    {
        const makeFakeBridge = () => ({
            logging: true,
            configs: [],
            logs: [],
            applyStates: [],
            connectCalls: 0,
            disconnectCalls: 0,
            connect() {
                this.connectCalls++;
            },
            disconnect() {
                this.disconnectCalls++;
            },
            setApply(on) {
                this.applyStates.push(!!on);
            },
            setConfig(cfg) {
                this.configs.push(cfg);
            },
            log(obj) {
                this.logs.push(obj);
            }
        });
        const link = makeFakeLink();
        const bridge = makeFakeBridge();
        const runner = new Runner.ArenaRunner(link, Wire, bridge);
        const steps = [{ kind: 'ref', conditionName: 'cl', label: 'cl', seqIdx: 0, dur: 2 }];
        const conditionsByName = new Map([
            [
                'cl',
                {
                    name: 'cl',
                    commands: [
                        {
                            type: 'controller',
                            command_name: 'trialParams',
                            mode: 3,
                            frame_rate: 0,
                            gain: 0,
                            frame_index: 0,
                            duration: 2,
                            pattern: 'p'
                        },
                        { type: 'plugin', plugin_name: 'fictrac', command_name: 'connect' },
                        {
                            type: 'plugin',
                            plugin_name: 'fictrac',
                            command_name: 'startClosedLoop',
                            params: { coupling: 0.75, start_frame: 57 }
                        },
                        { type: 'wait', duration: 2 },
                        { type: 'plugin', plugin_name: 'fictrac', command_name: 'stopClosedLoop' },
                        {
                            type: 'plugin',
                            plugin_name: 'log',
                            command_name: 'log',
                            params: { message: 'done' }
                        }
                    ]
                }
            ]
        ]);
        let slept = 0;
        const clEvents = [];
        const summary = await runner.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            resolvePatternFrames: (cmd) => (cmd.command_name === 'trialParams' ? 60 : null),
            fictracPluginNames: new Set(['fictrac']),
            onProgress: (e) => clEvents.push(e),
            sleep: (ms) => {
                slept += ms;
                return Promise.resolve();
            }
        });
        checkBool(
            'explicit start_frame 57 ≠ frame_index 0 → warns (display jumps)',
            clEvents.some(
                (e) =>
                    e.phase === 'warn' &&
                    /start_frame 57 differs from the trialParams frame_index 0/.test(e.reason)
            ),
            JSON.stringify(clEvents.filter((e) => e.phase === 'warn'))
        );
        check('bridge.connect called once', bridge.connectCalls, 1);
        // Runner disarms at sequence start and again at sequence end, so the
        // protocol's own true/false sits between two safety falses.
        checkBool(
            'apply disarmed at start, toggled true then false, disarmed at end',
            JSON.stringify(bridge.applyStates) === JSON.stringify([false, true, false, false]),
            bridge.applyStates.join(',')
        );
        checkBool(
            'pushed frames=60 modulus on startClosedLoop',
            bridge.configs.some((c) => c.frames === 60)
        );
        checkBool(
            'pushed coupling 0.75',
            bridge.configs.some((c) => c.coupling === 0.75)
        );
        checkBool(
            'pushed start_frame 57 in the SAME config as epoch (opens the tared epoch on 57)',
            bridge.configs.some((c) => c.start_frame === 57 && c.epoch === true),
            JSON.stringify(bridge.configs)
        );
        checkBool(
            'stopClosedLoop config carries no start_frame',
            !bridge.configs.some((c) => c.start_frame !== undefined && c.epoch !== true)
        );
        checkBool(
            'pushed epoch:true with the start (bridge re-tares the heading)',
            bridge.configs.some((c) => c.epoch === true && c.coupling === 0.75)
        );
        checkBool('no retired gain key pushed', !bridge.configs.some((c) => c.gain !== undefined));
        checkBool(
            'log message routed to bridge',
            bridge.logs.some((l) => l.event === 'log' && l.message === 'done')
        );
        check('no skips (fictrac + log executed)', summary.skipped, 0);
        check('no errors', summary.errors, 0);
        check('closed-loop timing = 2s (fictrac ops add no time)', slept, 2000);
    }

    console.log('\n=== closed loop opens at the trialParams frame_index (v0.90) ===');
    {
        // rig7 P3 conditioning (course repo): trials authored `frame_index: 25` / `75`
        // ("starts alternate frame 25 / 75") opened on frame 0 once bridge 3.3 tared every
        // epoch. The runner now sends the trialParams frame_index as the bridge start frame.
        const runCl = async (conds, bridgeOpts = {}) => {
            const configs = [];
            const bridge = Object.assign(
                {
                    logging: true,
                    logs: [],
                    connect() {},
                    disconnect() {},
                    setApply() {},
                    setConfig(cfg) {
                        configs.push(cfg);
                    },
                    log(obj) {
                        this.logs.push(obj);
                    }
                },
                bridgeOpts
            );
            const runner = new Runner.ArenaRunner(makeFakeLink(), Wire, bridge);
            const conditionsByName = new Map();
            const steps = conds.map((c, i) => {
                conditionsByName.set('c' + i, {
                    name: 'c' + i,
                    commands: [
                        Object.assign(
                            {
                                type: 'controller',
                                command_name: 'trialParams',
                                mode: 3,
                                frame_rate: 0,
                                gain: 0,
                                duration: 1,
                                pattern: 'p'
                            },
                            c.frame_index === undefined ? {} : { frame_index: c.frame_index }
                        ),
                        {
                            type: 'plugin',
                            plugin_name: 'fictrac',
                            command_name: 'startClosedLoop',
                            params: Object.assign(
                                { coupling: -1 },
                                c.start_frame === undefined ? {} : { start_frame: c.start_frame }
                            )
                        },
                        { type: 'wait', duration: 1 },
                        { type: 'plugin', plugin_name: 'fictrac', command_name: 'stopClosedLoop' }
                    ]
                });
                return { kind: 'ref', conditionName: 'c' + i, label: 'c' + i, seqIdx: i, dur: 1 };
            });
            const events = [];
            const summary = await runner.runSequence({
                steps,
                conditionsByName,
                resolvePatternId: () => 1,
                resolvePatternFrames: () => 100,
                fictracPluginNames: new Set(['fictrac']),
                onProgress: (e) => events.push(e),
                sleep: () => Promise.resolve()
            });
            const starts = configs.filter((c) => c.epoch === true).map((c) => c.start_frame);
            const warns = events.filter((e) => e.phase === 'warn').map((e) => e.reason);
            return { starts, warns, summary, configs };
        };

        let r = await runCl([{ frame_index: 25 }, { frame_index: 75 }]);
        checkDeep(
            'epochs open at frame_index 25 / 75 (no start_frame authored)',
            r.starts,
            [25, 75]
        );
        checkDeep('…with no warnings', r.warns, []);
        check('…and no errors', r.summary.errors, 0);
        checkBool(
            'start_frame rides in the SAME config as epoch',
            r.configs.every((c) => c.epoch !== true || c.start_frame !== undefined)
        );

        r = await runCl([{}, { frame_index: 0 }]);
        checkDeep('no / zero frame_index → opens on frame 0 (unchanged)', r.starts, [0, 0]);

        r = await runCl([{ frame_index: 130 }]);
        checkDeep(
            'frame_index past the pattern wraps modulo the frame count (130 % 100)',
            r.starts,
            [30]
        );

        r = await runCl([{ frame_index: 57, start_frame: 57 }]);
        checkDeep('v0.89 protocol (start_frame = frame_index) still opens on 57', r.starts, [57]);
        checkDeep('…silently (the values agree)', r.warns, []);

        r = await runCl([{ frame_index: 10, start_frame: 40 }]);
        checkDeep('explicit start_frame still wins when it disagrees', r.starts, [40]);
        checkBool(
            '…with a warning naming both values',
            r.warns.length === 1 &&
                /start_frame 40 differs from the trialParams frame_index 10/.test(r.warns[0]),
            JSON.stringify(r.warns)
        );

        const oldBridge = {
            supportsStartFrame: () => false,
            bridgeInfo: { version: '3.3 · behavior_v2' }
        };
        r = await runCl([{ frame_index: 25 }, { frame_index: 75 }, { frame_index: 25 }], oldBridge);
        checkBool(
            'bridge < 3.4 → ONE warning per run that trials open on frame 0',
            r.warns.length === 1 &&
                /bridge 3\.3 .* ignores the closed-loop start frame/.test(r.warns[0]),
            JSON.stringify(r.warns)
        );
        r = await runCl([{}, { frame_index: 0 }], oldBridge);
        checkDeep('bridge < 3.4 but every trial opens on 0 → no warning', r.warns, []);
        r = await runCl([{ frame_index: 25 }], { supportsStartFrame: () => null });
        checkDeep('bridge version unknown → no warning (cannot tell)', r.warns, []);
    }

    console.log('\n=== closed-loop bias: runSequence pushes it to the bridge ===');
    {
        const makeFakeBridge = () => ({
            logging: true,
            configs: [],
            logs: [],
            applyStates: [],
            connect() {},
            disconnect() {},
            setApply(on) {
                this.applyStates.push(!!on);
            },
            setConfig(cfg) {
                this.configs.push(cfg);
            },
            log(obj) {
                this.logs.push(obj);
            }
        });
        const clCondition = (params) => ({
            name: 'cl',
            commands: [
                {
                    type: 'controller',
                    command_name: 'trialParams',
                    mode: 3,
                    frame_rate: 0,
                    gain: 0,
                    frame_index: 0,
                    duration: 2,
                    pattern: 'p'
                },
                {
                    type: 'plugin',
                    plugin_name: 'fictrac',
                    command_name: 'startClosedLoop',
                    params
                },
                { type: 'wait', duration: 2 },
                { type: 'plugin', plugin_name: 'fictrac', command_name: 'stopClosedLoop' }
            ]
        });
        const runCl = async (params) => {
            const bridge = makeFakeBridge();
            const runner = new Runner.ArenaRunner(makeFakeLink(), Wire, bridge);
            const events = [];
            let slept = 0;
            const summary = await runner.runSequence({
                steps: [{ kind: 'ref', conditionName: 'cl', label: 'cl', seqIdx: 0, dur: 2 }],
                conditionsByName: new Map([['cl', clCondition(params)]]),
                resolvePatternId: () => 1,
                resolvePatternFrames: (cmd) => (cmd.command_name === 'trialParams' ? 200 : null),
                fictracPluginNames: new Set(['fictrac']),
                onProgress: (s) => events.push(s),
                sleep: (ms) => {
                    slept += ms;
                    return Promise.resolve();
                }
            });
            return { bridge, summary, events, slept };
        };

        {
            const { bridge, summary, slept } = await runCl({
                bias_type: 'sine',
                bias_amplitude: 90,
                bias_frequency: 0.5
            });
            // ONE setConfig must carry frames + gain + bias together: the bridge re-zeros
            // its bias phase clock on any config containing `bias`, so bundling them is
            // what makes each epoch start at phase 0.
            const start = bridge.configs.find((c) => c.bias && c.bias.type === 'sine');
            checkBool('startClosedLoop pushed the bias', !!start, JSON.stringify(bridge.configs));
            check('bias rides with frames', start.frames, 200);
            check('bias rides with coupling 1 (the default)', start.coupling, 1);
            check('bias rides with epoch:true (the bridge re-tares)', start.epoch, true);
            checkDeep('bias spec pushed intact', start.bias, {
                type: 'sine',
                amplitude: 90,
                frequency: 0.5
            });
            // ...and stopClosedLoop must clear it, or it leaks into later trials.
            const stop = bridge.configs.find((c) => c.bias && c.bias.type === 'none');
            checkBool('stopClosedLoop pushed bias none', !!stop, JSON.stringify(bridge.configs));
            checkBool(
                'the clear comes after the start',
                bridge.configs.indexOf(stop) > bridge.configs.indexOf(start)
            );
            check('no errors', summary.errors, 0);
            check('no skips', summary.skipped, 0);
            check('bias adds no time to the trial', slept, 2000);
        }

        {
            // A malformed bias must skip its STEP, not abort the run, and must never
            // reach the bridge as a silently-degraded no-op.
            const { bridge, summary } = await runCl({ bias_type: 'triangle' });
            check('bad bias -> one error', summary.errors, 1);
            checkBool(
                'bad bias never pushed a bias config',
                !bridge.configs.some((c) => c.bias && c.bias.type !== 'none'),
                JSON.stringify(bridge.configs)
            );
            checkBool('run still completed the rest of the sequence', summary.completed !== false);
        }

        {
            // A negative frequency runs, but emits a 'warn' event (its own phase — NOT
            // 'skip', which would inflate summary.skipped) and a bridge log line.
            const { bridge, summary, events } = await runCl({
                bias_type: 'sine',
                bias_amplitude: 90,
                bias_frequency: -0.5
            });
            check('negative frequency is not an error', summary.errors, 0);
            check('negative frequency is not counted as a skip', summary.skipped, 0);
            checkBool(
                "emitted a 'warn' phase event",
                events.some((e) => e.phase === 'warn' && /bias_amplitude/.test(e.reason || '')),
                JSON.stringify(events.filter((e) => e.phase === 'warn'))
            );
            checkBool(
                'warning also written to the bridge log',
                bridge.logs.some((l) => l.event === 'warn'),
                JSON.stringify(bridge.logs)
            );
            checkBool(
                'the waveform still reached the bridge',
                bridge.configs.some((c) => c.bias && c.bias.type === 'sine')
            );
        }
    }

    console.log('\n=== closed-loop teardown: STOP mid-run must not leak the bias ===');
    {
        // THE BUG (found on the bench): pressing STOP during a closed-loop trial skips
        // stopClosedLoop entirely, so the runner used to leave the bridge streaming
        // frames AND integrating the bias — whose phase clock kept running. The next
        // run then inherited a stale, already-drifted disturbance until some condition
        // happened to push a new one.
        const makeFakeBridge = () => ({
            logging: true,
            configs: [],
            logs: [],
            applyStates: [],
            _bias: null,
            connect() {},
            disconnect() {},
            setApply(on) {
                this.applyStates.push(!!on);
            },
            setConfig(cfg) {
                this.configs.push(cfg);
                if (cfg.bias) this._bias = cfg.bias; // mirror the real client's state
            },
            get bias() {
                return this._bias;
            },
            log(obj) {
                this.logs.push(obj);
            }
        });
        const clCondition = {
            name: 'cl',
            commands: [
                {
                    type: 'controller',
                    command_name: 'trialParams',
                    mode: 3,
                    frame_rate: 0,
                    gain: 0,
                    frame_index: 0,
                    duration: 5,
                    pattern: 'p'
                },
                {
                    type: 'plugin',
                    plugin_name: 'fictrac',
                    command_name: 'startClosedLoop',
                    params: { bias_type: 'constant', bias_amplitude: 90 }
                },
                { type: 'wait', duration: 5 },
                { type: 'plugin', plugin_name: 'fictrac', command_name: 'stopClosedLoop' }
            ]
        };
        const runArgs = (bridge, runner, sleep) => ({
            steps: [{ kind: 'ref', conditionName: 'cl', label: 'cl', seqIdx: 0, dur: 5 }],
            conditionsByName: new Map([['cl', clCondition]]),
            resolvePatternId: () => 1,
            resolvePatternFrames: (cmd) => (cmd.command_name === 'trialParams' ? 200 : null),
            fictracPluginNames: new Set(['fictrac']),
            sleep
        });

        // --- stop() mid-wait (the STOP button) ---------------------------------
        {
            const bridge = makeFakeBridge();
            const runner = new Runner.ArenaRunner(makeFakeLink(), Wire, bridge);
            // Abort from inside the trial's wait, exactly like pressing STOP.
            const sleep = () => {
                runner.stop();
                return Promise.resolve();
            };
            const summary = await runner.runSequence(runArgs(bridge, runner, sleep));
            checkBool('run reports aborted', summary.aborted === true, JSON.stringify(summary));
            // The bias must be cleared even though stopClosedLoop never ran.
            checkBool(
                'bias cleared on abort (never reached stopClosedLoop)',
                bridge.bias && bridge.bias.type === 'none',
                JSON.stringify(bridge.bias)
            );
            // ...and the bridge must stop driving the arena.
            check(
                'apply ends disabled on abort',
                bridge.applyStates[bridge.applyStates.length - 1],
                false
            );

            // Now the reported symptom: the NEXT run must not inherit the old waveform.
            // Re-run with a condition that authors NO bias at all.
            const noBias = JSON.parse(JSON.stringify(clCondition));
            noBias.commands[1].params = {}; // no bias_* keys
            bridge.configs.length = 0;
            await runner.runSequence({
                ...runArgs(bridge, runner, () => Promise.resolve()),
                conditionsByName: new Map([['cl', noBias]])
            });
            const started = bridge.configs.find((c) => c.frames === 200);
            checkBool(
                'a bias-free condition pushes an EXPLICIT none (self-describing)',
                started && started.bias && started.bias.type === 'none',
                JSON.stringify(started)
            );
            checkBool(
                'no stale waveform survived into the second run',
                !bridge.configs.some((c) => c.bias && c.bias.type !== 'none'),
                JSON.stringify(bridge.configs)
            );
        }

        // --- abort()/_clear() (involuntary disconnect) -------------------------
        // The serial link is gone, but the BRIDGE socket is independent — so the
        // closed loop can and must still be torn down.
        {
            const bridge = makeFakeBridge();
            bridge.setConfig({ bias: { type: 'sine', amplitude: 90, frequency: 0.5 } });
            const runner = new Runner.ArenaRunner(makeFakeLink(), Wire, bridge);
            runner.abort();
            checkBool(
                'abort() clears the bias with no link',
                bridge.bias && bridge.bias.type === 'none',
                JSON.stringify(bridge.bias)
            );
            check('abort() disables apply', bridge.applyStates.pop(), false);
        }

        // --- a bridge-CLI bias (--bias-type) is NOT stomped --------------------
        // Teardown clears what the CLIENT installed; a deliberate operator default
        // set on the bridge process has no client-side bias, so nothing is pushed.
        {
            const bridge = makeFakeBridge(); // _bias stays null = client knows of none
            const runner = new Runner.ArenaRunner(makeFakeLink(), Wire, bridge);
            runner.abort();
            check('no bias config pushed when the client has none', bridge.configs.length, 0);
            check('apply still disabled', bridge.applyStates.pop(), false);
        }

        // --- no bridge at all: teardown must not throw -------------------------
        {
            const runner = new Runner.ArenaRunner(makeFakeLink(), Wire, null);
            runner.abort();
            checkBool('teardown is a no-op without a bridge', true);
        }
    }

    // ── the closed-loop frame MODULUS (bench regression, 2026-08-12) ───────────
    // The bridge wraps every streamed index with `% n_frames`. If the runner never
    // pushes the loaded pattern's true frame count, the bridge keeps its own default
    // (200) and streams SET_FRAME_POSITION indices the pattern does not have — a
    // flickering panel map with the real pattern flashing through, and a display
    // engine wedged until a power cycle. It went unnoticed because the Studio's host
    // resolver only knows a frame count for patterns whose Console THUMBNAIL was
    // rendered, and the validation pattern happened to be exactly 200 frames.
    console.log('\n=== closed-loop frame modulus: resolved, or the step fails ===');
    {
        const makeFakeBridge = () => ({
            logging: true,
            configs: [],
            applyStates: [],
            connect() {},
            disconnect() {},
            setApply(on) {
                this.applyStates.push(!!on);
            },
            setConfig(cfg) {
                this.configs.push(cfg);
            },
            log() {}
        });
        // A link that answers GET_PATTERN_INFO (0x88) with the 12-byte payload the
        // firmware sends: frame_count u16 · gs · rows · cols · arena · observer ·
        // file_size u32 · stretch. Everything else gets the plain OK ack.
        const makeInfoLink = (frameCount) =>
            makeFakeLink({
                reply: (bytes) => {
                    if (bytes[1] === Wire.OPCODES.GET_PATTERN_INFO) {
                        const payload = [
                            frameCount & 0xff,
                            (frameCount >> 8) & 0xff,
                            1,
                            2,
                            10,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            1
                        ];
                        // frame = [length, status, echo_cmd, ...payload];
                        // length counts status + echo_cmd + payload.
                        return new Uint8Array([
                            2 + payload.length,
                            0x00,
                            Wire.OPCODES.GET_PATTERN_INFO,
                            ...payload
                        ]);
                    }
                    return new Uint8Array([0x02, 0x00, bytes[1]]);
                }
            });
        const clCondition = {
            name: 'cl',
            commands: [
                {
                    type: 'controller',
                    command_name: 'trialParams',
                    mode: 3,
                    frame_rate: 0,
                    gain: 0,
                    frame_index: 0,
                    duration: 1,
                    pattern: 'grating',
                    pattern_ID: 5
                },
                {
                    type: 'plugin',
                    plugin_name: 'fictrac',
                    command_name: 'startClosedLoop',
                    params: { bias_type: 'constant', bias_amplitude: 90 }
                },
                { type: 'wait', duration: 1 },
                { type: 'plugin', plugin_name: 'fictrac', command_name: 'stopClosedLoop' }
            ]
        };
        function runCl(link, bridge, resolveFrames) {
            const runner = new Runner.ArenaRunner(link, Wire, bridge);
            const events = [];
            return runner
                .runSequence({
                    steps: [{ kind: 'ref', conditionName: 'cl', label: 'cl', seqIdx: 0, dur: 1 }],
                    conditionsByName: new Map([['cl', clCondition]]),
                    resolvePatternId: () => 5,
                    resolvePatternFrames: resolveFrames || (() => null),
                    fictracPluginNames: new Set(['fictrac']),
                    sleep: () => Promise.resolve(),
                    onProgress: (s) => events.push(s)
                })
                .then((summary) => ({ summary, events }));
        }

        // 1. Host resolver knows the count → that wins, no 0x88 round-trip needed.
        {
            const link = makeInfoLink(20);
            const bridge = makeFakeBridge();
            const { summary } = await runCl(link, bridge, (cmd) =>
                cmd.command_name === 'trialParams' ? 40 : null
            );
            checkBool(
                'host-resolved frame count is pushed as the modulus',
                bridge.configs.some((c) => c.frames === 40),
                JSON.stringify(bridge.configs)
            );
            checkBool(
                'no 0x88 query when the host already knows',
                !link.sent.some((b) => b[1] === Wire.OPCODES.GET_PATTERN_INFO)
            );
            check('no errors', summary.errors, 0);
        }

        // 2. THE BENCH CASE: the host resolver returns null (an SD pattern with no
        //    rendered thumbnail). The count must come from the controller — NOT from
        //    the bridge's 200 default.
        {
            const link = makeInfoLink(20);
            const bridge = makeFakeBridge();
            const { summary } = await runCl(link, bridge, null);
            checkBool(
                'unresolved host count falls back to GET_PATTERN_INFO (0x88)',
                link.sent.some((b) => b[1] === Wire.OPCODES.GET_PATTERN_INFO)
            );
            checkBool(
                'controller-reported 20 frames is pushed as the modulus',
                bridge.configs.some((c) => c.frames === 20),
                JSON.stringify(bridge.configs)
            );
            checkBool(
                'the closed loop DID start',
                bridge.applyStates.some((v) => v === true),
                bridge.applyStates.join(',')
            );
            check('no errors', summary.errors, 0);
        }

        // 3. Neither source can answer → the step FAILS and the loop never starts.
        //    Better a visibly dead trial than 30 s of out-of-range frames at the arena.
        {
            const link = makeFakeLink(); // default ack: 0x88 payload too short to decode
            const bridge = makeFakeBridge();
            const { summary, events } = await runCl(link, bridge, null);
            check('unknown modulus fails the step', summary.errors, 1);
            checkBool(
                'apply(true) was NEVER sent on an unknown modulus',
                !bridge.applyStates.some((v) => v === true),
                bridge.applyStates.join(',')
            );
            checkBool(
                'no frames key pushed when the count is unknown',
                !bridge.configs.some((c) => 'frames' in c),
                JSON.stringify(bridge.configs)
            );
            checkBool(
                'the error names the frame count as the cause',
                events.some(
                    (e) => e.phase === 'error' && /unknown frame count/.test(e.reason || '')
                ),
                JSON.stringify(events.filter((e) => e.phase === 'error').map((e) => e.reason))
            );
        }

        // 4. The 0x88 result is cached: a condition repeated across blocks must not
        //    pay a serial round-trip (and a timeout) every repetition.
        {
            const link = makeInfoLink(20);
            const bridge = makeFakeBridge();
            const runner = new Runner.ArenaRunner(link, Wire, bridge);
            await runner.runSequence({
                steps: [
                    { kind: 'ref', conditionName: 'cl', label: 'cl', seqIdx: 0, dur: 1 },
                    { kind: 'ref', conditionName: 'cl', label: 'cl', seqIdx: 1, dur: 1 }
                ],
                conditionsByName: new Map([['cl', clCondition]]),
                resolvePatternId: () => 5,
                resolvePatternFrames: () => null,
                fictracPluginNames: new Set(['fictrac']),
                sleep: () => Promise.resolve()
            });
            check(
                'the 0x88 frame-count query is cached per pattern',
                link.sent.filter((b) => b[1] === Wire.OPCODES.GET_PATTERN_INFO).length,
                1
            );
            checkBool(
                'both repetitions still got the modulus',
                bridge.configs.filter((c) => c.frames === 20).length >= 2,
                JSON.stringify(bridge.configs)
            );
        }
    }

    console.log('\n=== FicTrac closed-loop: stale apply is disarmed before the first step ===');
    {
        // Regression for rig03-sr 2026-09-04: apply left ON from earlier Console use
        // pushed 0x70 frames into the opening Mode-2 step (304 firmware rejects).
        const order = [];
        const link = makeFakeLink();
        const origSend = link.send.bind(link);
        link.send = (bytes) => {
            order.push('send:0x' + bytes[1].toString(16));
            return origSend(bytes);
        };
        const bridge = {
            apply: true, // stale state from before the run
            connect() {},
            disconnect() {},
            setApply(on) {
                this.apply = !!on;
                order.push('apply:' + this.apply);
            },
            setConfig() {},
            log() {}
        };
        const runner = new Runner.ArenaRunner(link, Wire, bridge);
        const steps = [{ kind: 'ref', conditionName: 'bg', label: 'bg', seqIdx: 0, dur: 1 }];
        const conditionsByName = new Map([
            [
                'bg',
                {
                    name: 'bg',
                    commands: [
                        {
                            type: 'controller',
                            command_name: 'trialParams',
                            mode: 2,
                            frame_rate: 10,
                            gain: 0,
                            frame_index: 0,
                            duration: 1,
                            pattern: 'p'
                        },
                        { type: 'wait', duration: 1 }
                    ]
                }
            ]
        ]);
        const summary = await runner.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            sleep: () => Promise.resolve()
        });
        check('run completed', summary.completed, true);
        check('first bridge/link action is apply:false', order[0], 'apply:false');
        checkBool(
            'apply:false precedes the first controller send',
            order.indexOf('apply:false') < order.findIndex((o) => o.startsWith('send:')),
            order.slice(0, 3).join(' → ')
        );
        check('apply is OFF after the run', bridge.apply, false);
    }

    console.log('\n=== FicTrac closed-loop: abort mid-trial leaves apply OFF ===');
    {
        const link = makeFakeLink();
        const bridge = {
            apply: false,
            states: [],
            connect() {},
            disconnect() {},
            setApply(on) {
                this.apply = !!on;
                this.states.push(!!on);
            },
            setConfig() {},
            log() {}
        };
        const runner = new Runner.ArenaRunner(link, Wire, bridge);
        const steps = [{ kind: 'ref', conditionName: 'cl', label: 'cl', seqIdx: 0, dur: 20 }];
        const conditionsByName = new Map([
            [
                'cl',
                {
                    name: 'cl',
                    commands: [
                        {
                            type: 'controller',
                            command_name: 'trialParams',
                            mode: 3,
                            frame_rate: 0,
                            gain: 0,
                            frame_index: 0,
                            duration: 20,
                            pattern: 'p'
                        },
                        { type: 'plugin', plugin_name: 'fictrac', command_name: 'startClosedLoop' },
                        { type: 'wait', duration: 20 },
                        { type: 'plugin', plugin_name: 'fictrac', command_name: 'stopClosedLoop' }
                    ]
                }
            ]
        ]);
        let applyDuringWait = null;
        const summary = await runner.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            // The loop refuses to start on an unknown frame modulus (LAB-185 bench
            // rule), so the fixture must supply one for apply to ever go ON.
            resolvePatternFrames: () => 200,
            fictracPluginNames: new Set(['fictrac']),
            sleep: () => {
                // Mid-closed-loop the apply must be ON; then the link drops.
                applyDuringWait = bridge.apply;
                runner.abort();
                return Promise.resolve();
            }
        });
        check('apply was ON during the closed-loop wait', applyDuringWait, true);
        check('run reported aborted', summary.aborted, true);
        check('apply is OFF after the abort', bridge.apply, false);
        check('last apply state recorded is false', bridge.states[bridge.states.length - 1], false);
    }

    console.log('\n=== fault() mid-run (fw #50): unwinds the wait, labels the summary ===');
    {
        const link = makeFakeLink();
        const runner = new Runner.ArenaRunner(link, Wire);
        const phases = [];
        const steps = [
            { kind: 'ref', conditionName: 'arena check', label: 'a', seqIdx: 0, dur: 5 }
        ];
        const conditionsByName = new Map([['arena check', arenaCheckCond]]);
        // Default abort-aware sleep (5 s trial) — fault() must cut it short.
        const t0 = Date.now();
        const p = runner.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            onProgress: (s) => phases.push(s)
        });
        await delay(30);
        checkBool('run is active before the fault', runner.active === true);
        runner.fault('controller_unresponsive', { failures: 3, window: 10 });
        const summary = await p;
        checkBool('fault() ended the run promptly', Date.now() - t0 < 2000);
        check('summary.aborted', summary.aborted, true);
        check('summary.fault', summary.fault, 'controller_unresponsive');
        check(
            'summary.faultDetail passthrough',
            JSON.stringify(summary.faultDetail),
            JSON.stringify({ failures: 3, window: 10 })
        );
        check('summary.stopAcked (fake link acks STOP)', summary.stopAcked, true);
        checkBool(
            "a 'fault' status event preceded the terminal 'aborted'",
            phases.findIndex((s) => s.phase === 'fault') >= 0 &&
                phases.findIndex((s) => s.phase === 'fault') <
                    phases.findIndex((s) => s.phase === 'aborted')
        );
        const term = phases[phases.length - 1];
        check(
            'terminal event carries the fault',
            term.phase === 'aborted' && term.summary.fault,
            'controller_unresponsive'
        );
        checkBytes('final STOP still attempted', link.sent[link.sent.length - 1], '01 30');
        check('faultReason getter', runner.faultReason, 'controller_unresponsive');
    }

    console.log(
        '\n=== a timed-out protocol command is a controller fault, a rejected one is not ==='
    );
    {
        // trialParams send times out (the 0x08-after-the-0x70s signature).
        const link = makeFakeLink();
        link.send = async function (bytes) {
            this.sent.push(Array.from(bytes));
            if (bytes[1] === 0x08) throw new Error('response timeout after 500 ms (cmd 0x8)');
            return new Uint8Array([0x02, 0x00, bytes[1]]);
        };
        const runner = new Runner.ArenaRunner(link, Wire);
        const trialCond = { name: 'trial', commands: [trialCmd, { type: 'wait', duration: 1 }] };
        const steps = [{ kind: 'ref', conditionName: 'trial', label: 't', seqIdx: 0, dur: 5 }];
        const conditionsByName = new Map([['trial', trialCond]]);
        const summary = await runner.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            sleep: () => Promise.resolve()
        });
        check('timeout → aborted', summary.aborted, true);
        check('timeout → fault labelled', summary.fault, 'controller_unresponsive');
        check(
            'timeout → faultDetail names the op',
            summary.faultDetail && summary.faultDetail.op,
            'trialParams'
        );

        // A plain send failure (not a timeout) still aborts but is NOT a fault.
        const link2 = makeFakeLink({ failSend: true });
        const runner2 = new Runner.ArenaRunner(link2, Wire);
        const s2 = await runner2.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            sleep: () => Promise.resolve()
        });
        check('non-timeout failure → aborted', s2.aborted, true);
        check('non-timeout failure → fault null', s2.fault, null);
        // A controller REJECT (status 1) is neither an abort nor a fault.
        const link3 = makeFakeLink({ reply: new Uint8Array([0x02, 0x01, 0x08]) });
        const runner3 = new Runner.ArenaRunner(link3, Wire);
        const s3 = await runner3.runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            sleep: () => Promise.resolve()
        });
        check('reject → fault null', s3.fault, null);
        // The fake link answers every command (incl. STOP) with status 1 here.
        check('stopAcked reflects the STOP reply', s3.stopAcked, false);
        const link4 = makeFakeLink();
        const s4 = await new Runner.ArenaRunner(link4, Wire).runSequence({
            steps,
            conditionsByName,
            resolvePatternId: () => 1,
            sleep: () => Promise.resolve()
        });
        check('clean run → fault null', s4.fault, null);
        check('clean run → stopAcked true', s4.stopAcked, true);
    }

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
