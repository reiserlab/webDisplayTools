#!/usr/bin/env node
/**
 * Tests for js/studio-runtime-vars.js (the Run view "Runtime variables" panel logic), the
 * `requires:` capability gate in js/protocol-yaml-v3.js, the panel's wiring in
 * arena_studio.html, and the opto test protocol end to end through js/runtime-controls.js
 * (parse → validate → session → Apply → next trial resolves ledDrive.percent + wait.duration).
 *
 * Run: node --import ./tests/vendor-yaml.register.mjs tests/test-studio-runtime-vars.js
 *      (wired into `pixi run test`; the --import hook resolves the vendored yaml package)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RV = require('../js/studio-runtime-vars.js');
const RuntimeControls = require('../js/runtime-controls.js');
const v3 = require('../js/protocol-yaml-v3.js');
const ROOT = path.join(__dirname, '..');
const studioHtml = fs.readFileSync(path.join(ROOT, 'arena_studio.html'), 'utf8');
const optoYaml = fs.readFileSync(
    path.join(ROOT, 'protocols', 'opto_intensity_runtime_test.yaml'),
    'utf8'
);

let total = 0;
let failures = 0;
function check(name, got, expected) {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`}`
    );
    if (!ok) failures++;
}
function checkBool(name, ok, info) {
    total++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + (info || '')}`);
    if (!ok) failures++;
}

const pct = {
    name: 'opto_pct',
    type: 'number',
    minimum: 0,
    maximum: 100,
    units: 'percent',
    default_value: 10,
    label: 'Opto LED intensity'
};
const cnt = {
    name: 'pulse_s',
    type: 'integer',
    minimum: 1,
    maximum: 20,
    units: 's',
    default_value: 5
};
const flag = { name: 'led_on', type: 'boolean', default_value: true };
const mode = { name: 'mode', type: 'enum', values: ['steady', 'pulse'], default_value: 'steady' };

console.log('=== describeControl / formatValue ===');
check('number range with units', RV.describeControl(pct), '0–100 percent');
check('integer range', RV.describeControl(cnt), '1–20 s (integer)');
check('boolean', RV.describeControl(flag), 'true | false');
check('enum', RV.describeControl(mode), 'steady | pulse');
check('formatValue float trimmed', RV.formatValue(pct, 12.3456), '12.346');
check('formatValue boolean', RV.formatValue(flag, false), 'false');
check('formatValue null', RV.formatValue(pct, null), '—');

console.log('\n=== parseInputValue ===');
check('number in range', RV.parseInputValue(pct, ' 12.5 '), { ok: true, value: 12.5 });
check('number above max', RV.parseInputValue(pct, '150').ok, false);
checkBool(
    'above-max message names the bound',
    /≤ 100 percent/.test(RV.parseInputValue(pct, '150').error)
);
check('number below min', RV.parseInputValue(pct, '-1').ok, false);
check('empty', RV.parseInputValue(pct, '').ok, false);
check('not a number', RV.parseInputValue(pct, 'ten').ok, false);
check('integer rejects fraction', RV.parseInputValue(cnt, '2.5').ok, false);
check('integer accepts whole', RV.parseInputValue(cnt, '7'), { ok: true, value: 7 });
check('boolean true', RV.parseInputValue(flag, 'true'), { ok: true, value: true });
check('boolean junk', RV.parseInputValue(flag, 'yes').ok, false);
check('enum JSON option', RV.parseInputValue(mode, '"pulse"'), { ok: true, value: 'pulse' });
check('enum raw string', RV.parseInputValue(mode, 'steady'), { ok: true, value: 'steady' });
check('enum unknown', RV.parseInputValue(mode, '"blink"').ok, false);

console.log('\n=== buildChanges ===');
const defs = { opto_pct: pct, pulse_s: cnt };
const planned = { opto_pct: 10, pulse_s: 5 };
check('unchanged → no changes', RV.buildChanges(defs, planned, { opto_pct: '10', pulse_s: '5' }), {
    changes: {},
    errors: [],
    count: 0
});
check('one changed', RV.buildChanges(defs, planned, { opto_pct: '25', pulse_s: '5' }).changes, {
    opto_pct: 25
});
const bad = RV.buildChanges(defs, planned, { opto_pct: '250', pulse_s: '3' });
check(
    'one invalid blocks with an error (and still reports the valid change)',
    [bad.errors.length, bad.errors[0].variable, bad.count],
    [1, 'opto_pct', 1]
);

console.log('\n=== requires: capability gate (protocol-yaml-v3) ===');
const reqYaml = optoYaml.replace(
    '\nruntime_controls:\n',
    '\nrequires: [flow_control]\nruntime_controls:\n'
);
const reqExp = v3.parseV3Protocol(reqYaml);
check('requires parsed as a list', reqExp.requires, ['flow_control']);
checkBool(
    'requires is a known top-level key',
    !Object.prototype.hasOwnProperty.call(reqExp._unknownTopLevel, 'requires')
);
check('unsupportedRequires names the missing token', v3.unsupportedRequires(reqExp), [
    'flow_control'
]);
check('no requires → nothing missing', v3.unsupportedRequires(v3.parseV3Protocol(optoYaml)), []);
check(
    'bare string accepted',
    v3.parseV3Protocol(
        optoYaml.replace('\nruntime_controls:\n', '\nrequires: flow_control\nruntime_controls:\n')
    ).requires,
    ['flow_control']
);
const warn = v3
    .collectExportWarnings(reqExp)
    .warnings.find((w) => w.kind === 'unsupported-requires');
checkBool(
    'collectExportWarnings flags it (soft: editing stays possible)',
    !!warn && /refuse to run/.test(warn.message)
);
check('WEB_RUNNER_CAPABILITIES is exported (empty today)', v3.WEB_RUNNER_CAPABILITIES, []);
checkBool('requires survives regeneration', /requires:/.test(v3.generateV3Protocol(reqExp)));

console.log('\n=== opto protocol end to end through runtime-controls.js ===');
const exp = v3.parseV3Protocol(optoYaml);
const report = RuntimeControls.validateRuntimeControls(exp);
check('declarations valid', [report.ok, report.errors], [true, []]);
check('two controls', Object.keys(report.controls), ['opto_pct', 'pulse_s']);
check(
    'opto_pct binds to ledDrive.percent',
    report.bindings
        .filter((b) => b.variable === 'opto_pct')
        .map((b) => [b.condition_name, b.parameter_path]),
    [['opto_pulse', ['percent']]]
);
check(
    'pulse_s binds to the wait duration',
    report.bindings
        .filter((b) => b.variable === 'pulse_s')
        .map((b) => [b.condition_name, b.command_index, b.parameter_path]),
    [['opto_pulse', 3, ['duration']]]
);
check('no unused-control warning', report.warnings, []);
check('blocking errors none', v3.collectBlockingErrors(exp).errors.length, 0);

const session = RuntimeControls.createRuntimeControlSession({
    protocol: exp,
    sessionId: 'run-1',
    yamlId: 'opto_intensity_runtime_test.yaml',
    yamlHash: 'abc',
    now: () => '2026-09-21T15:00:00.000Z'
});
check('chip before any run = default', RV.chipFor('opto_pct', { session: null }), {
    state: 'default',
    text: 'default'
});
check('chip with a fresh session = default', RV.chipFor('opto_pct', { session }).state, 'default');
const t0 = session.beginTrial({
    trialIndex: 0,
    conditionName: 'opto_pulse',
    trialId: 'trial-0001'
});
check('trial 1 resolves the default ledDrive percent', t0.resolved_commands[2].percent, 10);
check('trial 1 wait duration default', t0.resolved_commands[3].duration, 5);
const built = RV.buildChanges(report.controls, session.getPlannedValues(), {
    opto_pct: '30',
    pulse_s: '8'
});
check('operator asks 30 % / 8 s', built.changes, { opto_pct: 30, pulse_s: 8 });
const requested = session.stageApply(built.changes, {
    operator: 'Michael',
    reason: 'brighter probe'
});
check(
    'request event shape',
    [requested.event, requested.changes.length, requested.operator, requested.reason],
    ['runtime_control_apply_requested', 2, 'Michael', 'brighter probe']
);
check('describeRequest is human', RV.describeRequest(requested), 'opto_pct 10 → 30, pulse_s 5 → 8');
check('chip while pending', RV.chipFor('opto_pct', { session }), {
    state: 'pending',
    text: 'pending · applies at next trial'
});
check('active value unchanged until the boundary', session.getActiveValues().opto_pct, 10);
const t1 = session.beginTrial({
    trialIndex: 1,
    conditionName: 'opto_pulse',
    trialId: 'trial-0002'
});
check('trial 2 resolves the applied ledDrive percent', t1.resolved_commands[2].percent, 30);
check('trial 2 resolves the applied wait', t1.resolved_commands[3].duration, 8);
check('the fixed wait is untouched', t1.resolved_commands[1].duration, 2);
check(
    'apply events recorded on the trial record',
    t1.apply_events.map((e) => [e.variable, e.old_value, e.new_value, e.first_affected_trial]),
    [
        ['opto_pct', 10, 30, 1],
        ['pulse_s', 5, 8, 1]
    ]
);
check('chip after apply', RV.chipFor('opto_pct', { session }), {
    state: 'applied',
    text: 'applied · from trial 2'
});
check(
    'run ended with a pending request → unapplied chip',
    RV.chipFor('opto_pct', { session, endedPending: [{ changes: [{ variable: 'opto_pct' }] }] })
        .state,
    'unapplied'
);
checkBool(
    'the YAML text was never rewritten',
    exp._doc.toString().includes('opto_pct: &opto_pct 10')
);
let threw = null;
try {
    session.stageApply({ opto_pct: 500 }, { operator: 'x' });
} catch (e) {
    threw = e.code;
}
check('out-of-range apply is rejected by the module too', threw, 'INVALID_APPLY');
try {
    session.stageApply({ trial_dur: 3 }, { operator: 'x' });
} catch (e) {
    threw = e.code;
}
check('an undeclared variable cannot be changed', threw, 'INVALID_APPLY');

console.log('\n=== panel builder (minimal DOM double) ===');
function fakeDoc() {
    function node(tag) {
        const n = {
            tag,
            className: '',
            _text: '',
            children: [],
            dataset: {},
            style: {},
            attrs: {},
            _listeners: {},
            // like the DOM: assigning textContent replaces every child
            get textContent() {
                return this._text;
            },
            set textContent(v) {
                this._text = v;
                this.children = [];
            },
            value: '',
            disabled: false,
            classList: {
                add(c) {
                    if (!n.className.split(' ').includes(c))
                        n.className = (n.className + ' ' + c).trim();
                },
                remove(c) {
                    n.className = n.className
                        .split(' ')
                        .filter((x) => x !== c)
                        .join(' ');
                }
            },
            appendChild(c) {
                n.children.push(c);
                return c;
            },
            append(...cs) {
                cs.forEach((c) => n.children.push(c));
            },
            addEventListener(ev, fn) {
                n._listeners[ev] = fn;
            },
            set innerHTML(html) {
                n._html = html;
            },
            get innerHTML() {
                return n._html || '';
            }
        };
        return n;
    }
    return { createElement: node };
}
function findAll(n, pred, out = []) {
    if (pred(n)) out.push(n);
    (n.children || []).forEach((c) => findAll(c, pred, out));
    return out;
}
const host = fakeDoc().createElement('div');
const statusEl = fakeDoc().createElement('div');
let running = false;
let sess = null;
const applied = [];
const panel = RV.createPanel({
    host,
    statusEl,
    document: fakeDoc(),
    RuntimeControls,
    getProtocol: () => exp,
    getSession: () => sess,
    isRunning: () => running,
    getEndedPending: () => null,
    onApply: (changes, reason) => {
        applied.push({ changes, reason });
        return sess.stageApply(changes, { operator: 'op', reason });
    }
});
panel.render(true);
check('two input rows rendered', panel.inputs.size, 2);
const rows = findAll(host, (n) => n.className === 'run-vars-row');
check('row shows allowed range', rows[0].children[1].textContent, '0–100 percent');
check('row shows the default as the active value', rows[0].children[2].textContent, '10 percent');
checkBool(
    'status explains Apply is a during-run action',
    /during a run/.test(statusEl.textContent)
);
const applyBtn = findAll(host, (n) => n.tag === 'button')[0];
check('Apply disabled with no session', applyBtn.disabled, true);
// start a "run"
sess = RuntimeControls.createRuntimeControlSession({
    protocol: exp,
    sessionId: 'run-2',
    yamlId: 'y',
    yamlHash: 'h'
});
running = true;
panel.render(true);
const inputs = panel.inputs;
inputs.get('opto_pct').value = '250';
inputs.get('opto_pct')._listeners.input();
const applyBtn2 = findAll(host, (n) => n.tag === 'button')[0];
check('Apply enabled once dirty during a run', applyBtn2.disabled, false);
applyBtn2._listeners.click();
checkBool(
    'invalid value is reported in the status, nothing staged',
    /≤ 100/.test(statusEl.textContent) && applied.length === 0 && !sess.hasPending()
);
inputs.get('opto_pct').value = '40';
inputs.get('opto_pct')._listeners.input();
applyBtn2._listeners.click();
check(
    'valid value staged through onApply',
    applied.map((a) => a.changes),
    [{ opto_pct: 40 }]
);
checkBool('status says pending', /Pending/.test(statusEl.textContent));
const chips = findAll(host, (n) => /run-vars-chip/.test(n.className));
check('chip pending', chips[0].className, 'run-vars-chip pending');
sess.beginTrial({ trialIndex: 0, conditionName: 'opto_pulse' });
panel.syncInputsToPlanned();
check('chip applied after the boundary', chips[0].className, 'run-vars-chip applied');
check(
    'active value updated',
    rows.length
        ? findAll(host, (n) => n.className === 'run-vars-row')[0].children[2].textContent
        : null,
    '40 percent'
);
// a protocol with no controls
const plain = v3.parseV3Protocol(
    optoYaml.replace(/\nruntime_controls:\n[\s\S]*?\nexperiment:/, '\nexperiment:')
);
const host2 = fakeDoc().createElement('div');
const status2 = fakeDoc().createElement('div');
RV.createPanel({
    host: host2,
    statusEl: status2,
    document: fakeDoc(),
    RuntimeControls,
    getProtocol: () => plain,
    getSession: () => null,
    isRunning: () => false,
    onApply: () => {}
}).render(true);
check(
    'no controls → "None declared"',
    host2.children[0].textContent,
    'None declared in this protocol.'
);

console.log('\n=== arena_studio.html wiring ===');
checkBool(
    'module loaded after runtime-controls.js',
    studioHtml.indexOf('src="js/studio-runtime-vars.js"') >
        studioHtml.indexOf('src="js/runtime-controls.js"')
);
for (const id of ['runVarsCard', 'runVarsBody', 'runVarsStatus'])
    checkBool('element #' + id, studioHtml.includes('id="' + id + '"'));
checkBool(
    'panel sits in the Run view before the sequence card',
    studioHtml.indexOf('id="runVarsCard"') > studioHtml.indexOf('id="runBridge"') &&
        studioHtml.indexOf('id="runVarsCard"') < studioHtml.indexOf('class="card seqlist"')
);
checkBool(
    'Classic installs prepareRuntimeControls',
    /Studio\.prepareRuntimeControls = function/.test(studioHtml)
);
checkBool(
    'Classic installs resolveRuntimeCondition',
    /Studio\.resolveRuntimeCondition = async function/.test(studioHtml)
);
checkBool('panel re-renders on doc sync', studioHtml.includes('Studio.runtimeVars.render()'));
checkBool('run-status feeds the panel', studioHtml.includes('Studio.runtimeVars.onRunStatus(s)'));
checkBool('Apply is logged to the bridge JSONL', studioHtml.includes('bridgeLog(requested)'));
checkBool(
    'run ended with a pending Apply is logged',
    studioHtml.includes('runtime_control_apply_unapplied') &&
        studioHtml.includes('run-ended-before-next-trial')
);
checkBool(
    'run_metadata carries the control definitions',
    studioHtml.includes('meta.runtime_controls = session.getControlDefinitions()')
);
checkBool(
    'requires gate on runOnce and runCondition',
    (studioHtml.match(/refuseUnsupportedRequires\(/g) || []).length >= 3
);
// v0.85: the retired closed-loop `gain` is refused through the same run gate, and the
// rig-derived display pitch reaches the runner + bridge (Console coupling box, no gain box).
checkBool(
    'retired gain gate rides the run gate',
    /refuseRetiredGain\(exp\)/.test(studioHtml) && /function refuseRetiredGain/.test(studioHtml)
);
checkBool(
    'rig pitch helper exists and feeds runSequence',
    /Studio\.rigDegPerFrame = function/.test(studioHtml) &&
        /degPerFrame: Studio\.rigDegPerFrame\(\)/.test(studioHtml)
);
checkBool(
    'run-start plugin config no longer pushes gain',
    !/cfg\.gain = Number\(pcfg\.gain\)/.test(studioHtml)
);
checkBool(
    'Console has the coupling box and no gain box',
    studioHtml.includes('id="cFtCoupling"') && !studioHtml.includes('id="cFtGain"')
);
checkBool(
    'unsupportedRequires imported in the module block',
    /unsupportedRequires\n\} from '\.\/js\/protocol-yaml-v3\.js'/.test(studioHtml)
);
checkBool(
    'not safe-blocked (Apply is a bounded, logged operator action)',
    !/SAFE_BLOCKED_CMDS[\s\S]{0,600}runVarsApply/.test(studioHtml)
);
checkBool(
    'help text for the card',
    studioHtml.includes("'#runVarsCard':") && studioHtml.includes("'#runVarsApply':")
);
checkBool(
    'footer at v0.84 or later',
    /Arena Studio v0\.(8[4-9]|9\d) \| \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET/.test(studioHtml)
);
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'protocols', 'index.json'), 'utf8'));
checkBool(
    'opto protocol is in the library index',
    idx.protocols.some(
        (p) =>
            p.key === 'opto_intensity_runtime_test' &&
            p.path.endsWith('opto_intensity_runtime_test.yaml')
    )
);

console.log(`\n${total - failures} / ${total} checks passed`);
process.exit(failures ? 1 : 0);
