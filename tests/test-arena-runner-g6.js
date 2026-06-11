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
        'string durations coerce',
        Runner.conditionDuration({
            commands: [{ type: 'controller', command_name: 'trialParams', duration: '5' }]
        }),
        5
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
        checkBytes('2nd send: trialParams', link.sent[1], '0c 08 02 01 00 0a 00 00 01 00 00 00 00');
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

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
