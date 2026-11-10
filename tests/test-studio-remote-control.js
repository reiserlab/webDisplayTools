#!/usr/bin/env node
/**
 * test-studio-remote-control.js — Arena Studio remote-control mode (LAB-357), the DOM-free
 * part (js/studio-remote-control.js): request validation, the entry preconditions, the run
 * state machine, the runner-summary → terminal-state mapping, status messages and progress
 * throttling — plus a static check that the page carries the same copy and wiring.
 *
 * Run: node tests/test-studio-remote-control.js   (wired into `pixi run test`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RC = require('../js/studio-remote-control.js');

let totalChecks = 0;
let failures = 0;
function check(name, got, expected) {
    totalChecks++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
            (ok ? '' : `: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
    );
    if (!ok) failures++;
}
function checkBool(name, ok, info) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

const YAML = 'version: 3\nexperiment_info:\n  name: t\n';
const run = (over) =>
    Object.assign(
        { type: 'run_request', id: 'r1', action: 'run', name: 'a.yaml', protocol: YAML },
        over || {}
    );

console.log('=== validateRequest ===');
{
    let v = RC.validateRequest(run());
    check('a minimal run is valid', v.ok, true);
    check('intent defaults to "test"', v.request.intent, 'test');
    check('metadata defaults to none', v.request.metadata, {});
    v = RC.validateRequest(run({ intent: 'experiment' }));
    check('intent experiment kept', v.request.intent, 'experiment');
    v = RC.validateRequest(run({ intent: 'soak' }));
    checkBool('unknown intent refused', !v.ok && /intent/.test(v.error), JSON.stringify(v));
    check('… and the id is kept for the reply', v.id, 'r1');
    v = RC.validateRequest(run({ id: '' }));
    checkBool('an empty id is refused, with no id to answer', !v.ok && v.id === null);
    v = RC.validateRequest(run({ id: 'x'.repeat(200) }));
    checkBool('an over-long id is refused', !v.ok && /longer/.test(v.error));
    v = RC.validateRequest(run({ action: 'pause' }));
    checkBool('unknown action refused', !v.ok && /unknown action/.test(v.error));
    v = RC.validateRequest(run({ protocol: '   ' }));
    checkBool('a run without YAML text is refused', !v.ok && /protocol/.test(v.error));
    v = RC.validateRequest(run({ protocol: 42 }));
    checkBool('a non-string protocol is refused', !v.ok);
    v = RC.validateRequest(run({ metadata: 'CS' }));
    checkBool('non-object metadata refused', !v.ok && /metadata/.test(v.error));
    v = RC.validateRequest(run({ name: '../../etc/passwd' }));
    check('the name is a file name, never a path', v.request.name, 'passwd.yaml');
    v = RC.validateRequest(run({ name: 'C:\\protocols\\stage1.yml' }));
    check('a Windows path is reduced to its file name', v.request.name, 'stage1.yml');
    v = RC.validateRequest(run({ name: undefined }));
    check('a missing name gets a default', v.request.name, 'remote.yaml');
    v = RC.validateRequest(
        run({ metadata: { experimenter: ' reiserm ', fly_number: 3, notes: null, rig: 'ww18' } })
    );
    check(
        'metadata: known keys as trimmed strings, null clears, absent stays absent',
        v.request.metadata,
        { experimenter: 'reiserm', fly_number: '3', notes: '' }
    );
    checkBool(
        'an unknown metadata key is reported, not applied',
        v.warnings.length === 1 && /rig/.test(v.warnings[0])
    );
    v = RC.validateRequest({ type: 'run_request', id: 's1', action: 'stop', run: 'r1' });
    check('stop is valid and carries the run id', v.request, {
        id: 's1',
        action: 'stop',
        run: 'r1'
    });
    v = RC.validateRequest({ id: 'q', action: 'status', protocol: 5 });
    checkBool('status needs nothing else', v.ok && v.request.action === 'status');
    checkBool('a non-object is refused without throwing', RC.validateRequest(null).ok === false);
    checkBool(
        'another message type is refused',
        RC.validateRequest({ type: 'log', id: 'a', action: 'run' }).ok === false
    );
}

console.log('\n=== validateRequest: the optional client name ===');
{
    let v = RC.validateRequest(run({ client: '  robot-sequencer  ' }));
    check('client is kept, trimmed', v.request.client, 'robot-sequencer');
    v = RC.validateRequest(run({ client: 'x'.repeat(200) }));
    check('client is capped at 64 characters', v.request.client.length, 64);
    v = RC.validateRequest(run({ client: 42 }));
    checkBool('a non-string client is dropped', v.ok && !('client' in v.request));
    v = RC.validateRequest(run());
    checkBool('no client → no field', !('client' in v.request));
}

console.log("\n=== experimentGate: a remote experiment obeys the Run button's rule ===");
{
    const pageOk = { ok: true, reason: '' };
    check(
        'intent test is unrestricted (no metadata, no page verdict)',
        RC.experimentGate({ intent: 'test', experimenter: '', genotype: '', gate: null }),
        { ok: true, missing: [], detail: null }
    );
    check(
        'experiment with both fields and a passing page gate → ok',
        RC.experimentGate({
            intent: 'experiment',
            experimenter: 'reiserm',
            genotype: 'CS',
            gate: pageOk
        }),
        { ok: true, missing: [], detail: null }
    );
    let g = RC.experimentGate({
        intent: 'experiment',
        experimenter: '',
        genotype: 'CS',
        gate: pageOk
    });
    check('Experimenter empty → refused, named', [g.ok, g.missing], [false, ['experimenter']]);
    checkBool(
        '… the detail names the field and the metadata key',
        /needs Experimenter —/.test(g.detail) && /missing metadata: experimenter /.test(g.detail),
        g.detail
    );
    g = RC.experimentGate({
        intent: 'experiment',
        experimenter: 'reiserm',
        genotype: '   ',
        gate: pageOk
    });
    check('Genotype blank → refused, named', [g.ok, g.missing], [false, ['genotype']]);
    checkBool('… as "Fly genotype"', /needs Fly genotype —/.test(g.detail), g.detail);
    g = RC.experimentGate({
        intent: 'experiment',
        experimenter: null,
        genotype: undefined,
        gate: pageOk
    });
    check('both empty → both named at once', g.missing, ['experimenter', 'genotype']);
    checkBool(
        '… in one detail',
        /needs Experimenter and Fly genotype/.test(g.detail) &&
            /missing metadata: experimenter, genotype/.test(g.detail),
        g.detail
    );
    g = RC.experimentGate({
        intent: 'experiment',
        experimenter: '',
        genotype: '',
        gate: { ok: false, reason: 'Experimenter is required' }
    });
    checkBool(
        'the missing fields are reported before the page reason',
        g.missing.length === 2 && !/rule refused/.test(g.detail)
    );
    // every OTHER condition of the button's rule arrives as the page's own reason
    [
        'Connect to run',
        'Save the protocol to run as an experiment',
        'Bridge not connected — recorded runs are logged through it (pixi run bridge)',
        'Pattern "grating_sq" not on SD — upload it via Console → SD upload, then reconnect',
        'Pattern name "x" matches multiple SD files — delete or rename the extra copy (Console → Patterns)',
        'controller preflight: panel mode',
        'rig (strict): AO default failed'
    ].forEach((reason) => {
        const r = RC.experimentGate({
            intent: 'experiment',
            experimenter: 'reiserm',
            genotype: 'CS',
            gate: { ok: false, reason }
        });
        check(
            'page gate refuses → rejected with its reason: ' + reason.slice(0, 40),
            [r.ok, r.detail],
            [false, 'the Run experiment rule refused: ' + reason]
        );
    });
    g = RC.experimentGate({ intent: 'experiment', experimenter: 'a', genotype: 'b', gate: null });
    checkBool(
        'no verdict from the page is not a yes (fail closed)',
        g.ok === false && /no verdict/.test(g.detail)
    );
    g = RC.experimentGate({
        intent: 'experiment',
        experimenter: 'a',
        genotype: 'b',
        gate: { ok: 'yes' }
    });
    checkBool('a malformed verdict is not a yes', g.ok === false);
    checkBool('only intent "experiment" is gated', RC.experimentGate().ok === true);
}

console.log('\n=== canEnter: the preconditions, first failure wins, exact reason ===');
{
    const ready = {
        controllerConnected: true,
        bridgeConnected: true,
        bridgeRemote: true,
        running: false
    };
    check('all preconditions met', RC.canEnter(ready), { ok: true, reason: '' });
    const why = (over) => RC.canEnter(Object.assign({}, ready, over));
    checkBool(
        'controller not connected',
        /controller is not connected/.test(why({ controllerConnected: false }).reason)
    );
    checkBool(
        'bridge not connected',
        /bridge is not connected/.test(why({ bridgeConnected: false }).reason)
    );
    checkBool(
        'bridge 3.4 (hello_ack without remote) is refused, naming the gateway',
        why({ bridgeRemote: false }).ok === false &&
            /does not support remote control/.test(why({ bridgeRemote: false }).reason) &&
            /pixi run rig/.test(why({ bridgeRemote: false }).reason)
    );
    checkBool(
        'no hello_ack yet is refused (unknown is not yes)',
        why({ bridgeRemote: null }).ok === false &&
            /has not answered/.test(why({ bridgeRemote: null }).reason)
    );
    checkBool('a run is active', /run is active/.test(why({ running: true }).reason));
    checkBool(
        'soak excludes remote control',
        why({ soak: true }).ok === false && /soak/i.test(why({ soak: true }).reason)
    );
    checkBool(
        'a replay (output interlock) excludes it',
        /Arena Studio replay/.test(why({ outputInhibited: 'Arena Studio replay' }).reason)
    );
    checkBool('unsaved edits block it', /unsaved edits/.test(why({ unsavedEdits: true }).reason));
    checkBool('an import blocks it', /import/.test(why({ importMode: true }).reason));
    checkBool('the Alt layout has none', /Alt layout/.test(why({ alt: true }).reason));
    checkBool(
        'a run active is reported before a missing controller',
        /run is active/.test(why({ running: true, controllerConnected: false }).reason)
    );
    checkBool('no context → refused', RC.canEnter().ok === false);
}

console.log('\n=== classifySummary: runner summary → terminal state ===');
{
    const done = { completed: true, aborted: false, steps: 4, errors: 0, skipped: 0, fault: null };
    check('completed, no fault → done', RC.classifySummary(done, { started: true }), {
        state: 'done',
        detail: null
    });
    check(
        'completed with step errors is still done, and says so',
        RC.classifySummary(Object.assign({}, done, { errors: 2, skipped: 1 }), { started: true }),
        { state: 'done', detail: 'completed with 2 step errors, 1 skipped command' }
    );
    const aborted = { completed: false, aborted: true, steps: 4, errors: 0, fault: null };
    check(
        'STOP at the Studio → aborted, the operator',
        RC.classifySummary(aborted, { started: true, stopSource: 'operator' }),
        { state: 'aborted', detail: 'stopped by the operator at the Studio' }
    );
    check(
        'remote stop → aborted, the controller',
        RC.classifySummary(aborted, { started: true, stopSource: 'remote' }),
        { state: 'aborted', detail: 'stopped by the remote controller' }
    );
    check(
        'aborted with no stop request → failed',
        RC.classifySummary(aborted, { started: true }).state,
        'failed'
    );
    check(
        'controller fault → failed (even after a STOP)',
        RC.classifySummary(Object.assign({}, aborted, { fault: 'controller_unresponsive' }), {
            started: true,
            stopSource: 'operator'
        }),
        { state: 'failed', detail: 'controller fault: controller_unresponsive' }
    );
    check(
        'link drop (the Studio marks it a fault) → failed',
        RC.classifySummary(Object.assign({}, aborted, { fault: 'link_dropped' }), {
            started: true
        }).state,
        'failed'
    );
    check(
        'bridge lost → failed',
        RC.classifySummary(Object.assign({}, aborted, { bridgeLost: { code: 1006 } }), {
            started: true
        }).state,
        'failed'
    );
    check(
        'stopped because the bridge went away → failed',
        RC.classifySummary(aborted, { started: true, stopSource: 'bridge' }).state,
        'failed'
    );
    check(
        'no summary (the run threw) → failed with the error',
        RC.classifySummary(null, { started: true, error: 'run error: boom' }),
        { state: 'failed', detail: 'run error: boom' }
    );
    check(
        'never started → rejected with the reason',
        RC.classifySummary(null, { started: false, reason: 'the run could not start: X' }),
        { state: 'rejected', detail: 'the run could not start: X' }
    );
    check(
        'neither completed nor aborted → failed',
        RC.classifySummary({ completed: false, aborted: false }, { started: true }).state,
        'failed'
    );
}

console.log('\n=== buildStatus / summaryForStatus ===');
{
    check('minimal status', RC.buildStatus('r1', 'accepted'), {
        type: 'run_status',
        id: 'r1',
        state: 'accepted'
    });
    let threw = false;
    try {
        RC.buildStatus('r1', 'paused');
    } catch (_) {
        threw = true;
    }
    checkBool('an unknown state throws (a programming error, never sent)', threw);
    const cyc = { completed: true, errors: 0 };
    cyc.self = cyc;
    cyc.err = new Error('late reply');
    cyc.fn = () => 1;
    const safe = RC.summaryForStatus(cyc);
    checkBool(
        'the summary is JSON-safe (Error → message, cycle → string, functions dropped)',
        safe.completed === true &&
            safe.err === 'late reply' &&
            typeof safe.self === 'string' &&
            !('fn' in safe) &&
            typeof JSON.stringify(safe) === 'string'
    );
    check('no summary → null', RC.summaryForStatus(null), null);
    checkBool(
        'isTerminal',
        ['done', 'aborted', 'failed', 'rejected'].every(RC.isTerminal) &&
            !RC.isTerminal('running') &&
            !RC.isTerminal('accepted')
    );
}

console.log('\n=== the state machine: idle → starting → accepted → running → terminal ===');
{
    const m = RC.createMachine();
    check('starts idle', [m.state, m.busy], ['idle', false]);
    check('the state line while idle', m.stateLine(), 'Waiting for a run');
    checkBool('nothing to accept while idle', m.accept() === null);
    checkBool('nothing to finish while idle', m.finish({ completed: true }) === null);
    checkBool(
        'progress while idle sends nothing',
        m.progress({ index: 0, total: 3, conditionName: 'a' }) === null
    );
    checkBool('a stop while idle is not a stop', m.requestStop('remote') === false);

    checkBool('begin claims the machine', m.begin({ id: 'r1', name: 'a.yaml', intent: 'test' }));
    check('starting: busy, nothing sent yet', [m.state, m.busy], ['starting', true]);
    checkBool('a second begin is refused', m.begin({ id: 'r2', name: 'b.yaml' }) === false);
    checkBool('started() before accept sends nothing', m.started(3) === null);
    check('accept → accepted', m.accept(), { type: 'run_status', id: 'r1', state: 'accepted' });
    check('the state line while starting', m.stateLine(), 'Starting a.yaml …');
    checkBool('accept twice sends nothing', m.accept() === null);
    check('started → the first running (no step)', m.started(3), {
        type: 'run_status',
        id: 'r1',
        state: 'running'
    });

    // progress: per step, never per frame
    const s1 = m.progress({ index: 0, total: 3, conditionName: 'cw' });
    check('step 1 → running with step {i,n,condition} (1-based)', s1, {
        type: 'run_status',
        id: 'r1',
        state: 'running',
        step: { i: 1, n: 3, condition: 'cw' }
    });
    let repeats = 0;
    for (let k = 0; k < 500; k++)
        if (m.progress({ index: 0, total: 3, conditionName: 'cw' })) repeats++;
    check('500 more events inside the same step send nothing', repeats, 0);
    const s2 = m.progress({ index: 1, total: 3, step: { conditionName: 'ccw' } });
    check('the next step sends once (runner event shape)', s2.step, {
        i: 2,
        n: 3,
        condition: 'ccw'
    });
    checkBool('an event without an index sends nothing', m.progress({ phase: 'command' }) === null);
    check('the state line while running', m.stateLine(), 'Running a.yaml — step 2 of 3 (ccw)');

    const fin = m.finish(
        { completed: true, aborted: false, steps: 3, errors: 0, skipped: 0, fault: null },
        { started: true }
    );
    check(
        'finish → done with the summary and the last step',
        [fin.state, fin.summary.steps, fin.step, 'detail' in fin],
        ['done', 3, { i: 2, n: 3, condition: 'ccw' }, false]
    );
    check('back to idle', [m.state, m.busy, m.id], ['idle', false, null]);
    check('the last result is kept', m.last.state, 'done');
    check(
        'the state line shows the last result',
        m.stateLine(),
        'Waiting for a run · last result: a.yaml — done'
    );
    checkBool(
        'a late event from the finished run sends nothing',
        m.progress({ index: 2, total: 3, conditionName: 'x' }) === null && m.started(3) === null
    );
}

console.log('\n=== the state machine: stops ===');
{
    const m = RC.createMachine();
    m.begin({ id: 'r1', name: 'a.yaml' });
    m.accept();
    m.started(2);
    m.progress({ index: 0, total: 2, conditionName: 'cw' });
    checkBool('operator stop recorded', m.requestStop('operator') === true);
    checkBool(
        'a later remote stop does not change the source (first wins)',
        m.requestStop('remote') && m.stopSource === 'operator'
    );
    checkBool('the state line says it is stopping', /stopping/.test(m.stateLine()));
    const fin = m.finish({ completed: false, aborted: true, steps: 2 }, { started: true });
    check(
        'operator STOP → aborted with the exact detail',
        [fin.state, fin.detail],
        ['aborted', 'stopped by the operator at the Studio']
    );

    m.begin({ id: 'r2', name: 'b.yaml' });
    m.accept();
    m.started(2);
    check('the stop source does not leak into the next run', m.stopSource, null);
    m.requestStop('remote');
    const fin2 = m.finish({ completed: false, aborted: true, steps: 2 }, { started: true });
    check(
        'remote stop → aborted with the exact detail',
        [fin2.state, fin2.detail],
        ['aborted', 'stopped by the remote controller']
    );

    m.begin({ id: 'r3', name: 'c.yaml' });
    m.accept();
    m.started(1);
    m.requestStop('remote');
    const fin3 = m.finish({ completed: true, aborted: false, steps: 1 }, { started: true });
    check('a stop that arrives after the last step: the run is done', fin3.state, 'done');
}

console.log('\n=== the state machine: it could not start ===');
{
    const m = RC.createMachine();
    m.begin({ id: 'r1', name: 'bad.yaml' });
    const rej = m.reject('the protocol did not load: Could not load "bad.yaml": no version');
    check(
        'reject before accept → rejected with the reason',
        [rej.state, rej.detail],
        ['rejected', 'the protocol did not load: Could not load "bad.yaml": no version']
    );
    check('idle again', m.state, 'idle');
    checkBool('reject while idle sends nothing', m.reject('x') === null);

    m.begin({ id: 'r2', name: 'gate.yaml' });
    m.accept();
    const rej2 = m.reject(
        'the run could not start: Run refused — controller preflight: panel mode'
    );
    check('accepted → rejected (the preflight refused)', rej2.state, 'rejected');
    checkBool('a rejection carries no summary and no step', !rej2.summary && !rej2.step);

    m.begin({ id: 'r3', name: 'x.yaml' });
    m.accept();
    const fin = m.finish(null, { started: false, reason: 'the run could not start: nothing' });
    check('finish with started:false is a rejection too', fin.state, 'rejected');

    m.begin({ id: 'r4', name: 'y.yaml' });
    m.accept();
    m.started(1);
    const fin2 = m.finish(null, { error: 'run error: boom' });
    check('a run that threw → failed', [fin2.state, fin2.detail], ['failed', 'run error: boom']);
}

console.log('\n=== decide: what an inbound run_request does ===');
{
    const ready = { remoteOn: true, busy: false, runActive: false, controllerConnected: true };
    let d = RC.decide(run(), ready);
    check(
        'remote on + idle + connected → run',
        [d.do, d.request.id, !!d.reply],
        ['run', 'r1', false]
    );
    d = RC.decide(run(), Object.assign({}, ready, { remoteOn: false }));
    check(
        'remote mode OFF: never starts anything — rejected',
        [d.do, d.reply.state, d.reply.detail],
        ['none', 'rejected', 'the Studio is not in remote-control mode']
    );
    d = RC.decide(
        { type: 'run_request', id: 's', action: 'stop' },
        Object.assign({}, ready, { remoteOn: false, runActive: true })
    );
    check(
        'remote mode OFF: a stop does nothing either',
        [d.do, d.reply.state],
        ['none', 'rejected']
    );
    d = RC.decide(run(), Object.assign({}, ready, { busy: true }));
    check(
        'a run while busy → rejected busy',
        [d.do, d.reply.detail],
        ['none', 'busy: a run is active']
    );
    d = RC.decide(run(), Object.assign({}, ready, { controllerConnected: false }));
    check(
        'controller not connected → rejected',
        [d.do, d.reply.detail],
        ['none', 'the controller is not connected']
    );
    d = RC.decide(run({ protocol: '' }), ready);
    checkBool(
        'an invalid request → rejected with the validation error',
        d.do === 'none' && /protocol/.test(d.reply.detail)
    );
    d = RC.decide({ type: 'run_request', action: 'run', protocol: YAML }, ready);
    check('no id → nothing to do and nobody to answer', d, { do: 'none' });
    d = RC.decide(
        { type: 'run_request', id: 's1', action: 'stop' },
        Object.assign({}, ready, { runActive: true, busy: true })
    );
    check('stop while a run is active → stop', d.do, 'stop');
    d = RC.decide({ type: 'run_request', id: 's1', action: 'stop' }, ready);
    check(
        'stop with no run → rejected, tagged as the stop',
        [d.do, d.reply.state, d.reply.action, d.reply.detail],
        ['none', 'rejected', 'stop', 'no run is active']
    );
    d = RC.decide({ type: 'run_request', id: 'q', action: 'status' }, ready);
    check("status is the gateway's to answer", d, { do: 'none' });
}

console.log('\n=== the page carries the same copy and wiring (static) ===');
{
    const root = path.join(__dirname, '..');
    const studio = fs.readFileSync(path.join(root, 'arena_studio.html'), 'utf8');
    check(
        'banner copy',
        RC.BANNER_TEXT,
        'REMOTE CONTROL — runs are started by an external program. This page is display only.'
    );
    check(
        'STOP dialog copy',
        [RC.STOP_CONFIRM_TEXT, RC.STOP_CONFIRM_YES, RC.STOP_CONFIRM_NO],
        [
            "Are you sure you want to stop? We're in remote control mode.",
            'Stop the run',
            'Keep running'
        ]
    );
    checkBool('the page markup has the banner text', studio.includes('>' + RC.BANNER_TEXT + '<'));
    checkBool(
        'the page markup has the dialog text',
        studio.includes('>' + RC.STOP_CONFIRM_TEXT + '<')
    );
    checkBool(
        'the dialog buttons read "Stop the run" / "Keep running"',
        /id="remoteStopYes"[^>]*>Stop the run<\/button>/.test(studio) &&
            /id="remoteStopNo"[^>]*>Keep running<\/button>/.test(studio)
    );
    checkBool(
        'the module is loaded as a classic script, before the glue',
        studio.indexOf('<script src="js/studio-remote-control.js') > -1 &&
            studio.indexOf('<script src="js/studio-remote-control.js') <
                studio.indexOf('(function RemoteControl() {')
    );
    const glue = studio.slice(
        studio.indexOf('(function RemoteControl() {'),
        studio.indexOf('(3) MODULE BLOCK')
    );
    checkBool('glue found', glue.length > 1000);
    checkBool(
        'the STOP confirmation is in-page: the glue never calls confirm / alert / prompt',
        !/\b(confirm|alert|prompt)\s*\(/.test(glue)
    );
    checkBool(
        "both stops take the page's own STOP path (Studio.doStop), which the shell exports",
        glue.includes('Studio.doStop()') && studio.includes('Studio.doStop = doStop;')
    );
    checkBool(
        'the run path is loadProtocol (unattended, lands in Run) + runOnce by intent',
        glue.includes("{ landIn: 'run', unattended: true }") &&
            glue.includes("Studio.runOnce(req.intent === 'experiment')")
    );
    checkBool(
        'the log is closed before the terminal status is sent',
        glue.indexOf('bridge.setLogging(false)') > -1 &&
            glue.indexOf('bridge.setLogging(false)') <
                glue.indexOf('send(machine.finish(summary, { started: true, error: error }))')
    );
    checkBool(
        'the banner and its dialog stay live; the rest of the page goes inert',
        glue.includes("const LIVE_IDS = ['remoteBanner', 'remoteStopModal', 'rlUploadOverlay'];") &&
            glue.includes("el.setAttribute('inert', '')")
    );
    checkBool(
        "every key is cut off from the page's shortcuts while the mode is on",
        glue.includes(
            "['keydown', 'keypress', 'keyup'].forEach((t) => window.addEventListener(t, onKey, true));"
        ) && glue.includes('e.stopImmediatePropagation();')
    );
    checkBool(
        'every new control has a tooltip',
        ['remoteStopBtn', 'remoteExitBtn', 'remoteStopYes', 'remoteStopNo', 'remoteEnterBtn'].every(
            (id) => new RegExp('id="' + id + '"[^>]*title="[^"]{10,}"').test(studio)
        )
    );
    checkBool(
        'the URL write side mirrors remote mode; ?remote=1 requests it at load',
        studio.includes(
            'remote: !!(Studio.remote && (Studio.remote.on || Studio.remote.requested))'
        ) && studio.includes('if (state.remote === true && Studio.remote) {')
    );
    checkBool(
        'soak refuses while remote control is on or requested',
        studio.includes('Soak is not available in remote-control mode')
    );
    checkBool(
        'the Run button and the remote experiment gate share ONE predicate (Studio.runExperimentGate)',
        studio.includes('Studio.runExperimentGate = () => runExperimentGate().gate;') &&
            studio.includes('const verdict = runExperimentGate();') &&
            studio.split('Meta.canRunExperiment(').length === 2
    );
    const gateAt = glue.indexOf('RC.experimentGate({');
    checkBool(
        'the gate runs after the metadata and the protocol are in place, before accepted and runOnce',
        gateAt > glue.indexOf('applyMetadata(req.metadata);') &&
            gateAt > glue.indexOf('await Studio.loadProtocol(') &&
            gateAt < glue.indexOf('send(machine.accept());') &&
            gateAt < glue.indexOf('await Studio.runOnce(') &&
            glue.includes('gate: Studio.runExperimentGate ? Studio.runExperimentGate() : null') &&
            glue.includes("if (req.intent === 'experiment') {")
    );
    checkBool(
        'an unattended load never opens the blocking unsaved-edits dialog',
        studio.includes('if (opts && opts.unattended) {')
    );
}

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
