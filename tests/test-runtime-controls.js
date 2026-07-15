#!/usr/bin/env node
/**
 * Focused tests for js/runtime-controls.js.
 *
 * Run:
 *   node --import ./tests/vendor-yaml.register.mjs tests/test-runtime-controls.js
 */
'use strict';

const { parseV3Protocol, generateV3Protocol } = require('../js/protocol-yaml-v3.js');
const RuntimeControls = require('../js/runtime-controls.js');

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

function checkBool(name, value, detail) {
    total++;
    const ok = !!value;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + (detail || '')}`);
    if (!ok) failures++;
}

function checkThrows(name, fn, code) {
    total++;
    try {
        fn();
        console.log(`  FAIL  ${name} — did not throw`);
        failures++;
    } catch (error) {
        const ok = error && error.code === code;
        console.log(
            `  ${ok ? 'PASS' : 'FAIL'}  ${name}${
                ok ? '' : ` — got ${error && error.code}, expected ${code}`
            }`
        );
        if (!ok) failures++;
    }
}

function hasIssue(report, code, variable) {
    return report.errors.some(
        (entry) => entry.code === code && (variable === undefined || entry.variable === variable)
    );
}

const YAML_TEXT = `version: 3
experiment_info:
  name: Runtime controls test
  date_created: 2026-07-12
  author: Reiser Lab
  pattern_library: patterns
rig: configs/rig.yaml

variables:
  led_percent: &led_percent 25
  pulse_count: &pulse_count 3
  led_enabled: &led_enabled true
  led_mode: &led_mode steady
  fixed_duration: &fixed_duration 25

# This comment and the source document must survive unchanged.
runtime_controls:
  led_percent:
    type: number
    units: percent
    minimum: 0
    maximum: 100
  pulse_count:
    type: integer
    minimum: 1
    maximum: 10
  led_enabled:
    type: boolean
  led_mode:
    type: enum
    values: [steady, pulse]

plugins:
  - name: led_plugin
    type: class
    matlab:
      class: LEDPlugin

experiment:
  - led_trial

conditions:
  - name: led_trial
    commands:
      - type: controller
        command_name: ledDrive
        channel: 0
        percent: *led_percent
      - type: plugin
        plugin_name: led_plugin
        command_name: configure
        params:
          count: *pulse_count
          enabled: *led_enabled
          mode: *led_mode
          literal_copy_of_default: 25
      - type: wait
        duration: *fixed_duration
`;

console.log('=== parser exposure + lossless round trip ===');
const protocol = parseV3Protocol(YAML_TEXT);
check('parser exposes four declarations', Object.keys(protocol.runtime_controls), [
    'led_percent',
    'pulse_count',
    'led_enabled',
    'led_mode'
]);
check('numeric declaration exposed', protocol.runtime_controls.led_percent, {
    type: 'number',
    units: 'percent',
    minimum: 0,
    maximum: 100
});
checkBool(
    'runtime_controls is a known top-level field',
    !Object.prototype.hasOwnProperty.call(protocol._unknownTopLevel, 'runtime_controls')
);
const roundTripped = generateV3Protocol(protocol);
checkBool(
    'runtime-controls comment preserved',
    roundTripped.includes('source document must survive')
);
check('runtime_controls survives reparse', parseV3Protocol(roundTripped).runtime_controls, {
    led_percent: { type: 'number', units: 'percent', minimum: 0, maximum: 100 },
    pulse_count: { type: 'integer', minimum: 1, maximum: 10 },
    led_enabled: { type: 'boolean' },
    led_mode: { type: 'enum', values: ['steady', 'pulse'] }
});

console.log('=== declaration + binding validation ===');
const validation = RuntimeControls.validateRuntimeControls(protocol);
check('valid declaration report', validation.ok, true);
check('four alias-specific command bindings', validation.bindings.length, 4);
check('no warnings for used controls', validation.warnings, []);
check('number default comes from variables', validation.controls.led_percent.default_value, 25);
check('enum values normalized', validation.controls.led_mode.values, ['steady', 'pulse']);
check(
    'nested plugin binding path retained',
    validation.bindings.find((binding) => binding.variable === 'led_enabled').parameter_path,
    ['params', 'enabled']
);
check('public supported types', RuntimeControls.SUPPORTED_TYPES, [
    'number',
    'integer',
    'boolean',
    'enum'
]);

const beforeDoc = protocol._doc.toString();
const beforeModel = JSON.stringify({
    variables: protocol.variables,
    conditions: protocol.conditions
});
const session = RuntimeControls.createRuntimeControlSession({
    protocol: protocol,
    sessionId: 'session-007',
    yamlId: 'protocols/led.yaml',
    yamlHash: 'sha256:abc123',
    now: () => '2026-07-12T14:00:00.000Z'
});

console.log('=== explicit Apply stages only ===');
const requested = session.stageApply(
    { led_percent: 80, pulse_count: 5, led_enabled: false, led_mode: 'pulse' },
    {
        operator: 'Michael',
        reason: 'raise LED for the next trial',
        requestedAt: '2026-07-12T14:01:00.000Z'
    }
);
check('request event kind', requested.event, 'runtime_control_apply_requested');
check(
    'request retains session/YAML provenance',
    [requested.session_id, requested.yaml_id, requested.yaml_hash],
    ['session-007', 'protocols/led.yaml', 'sha256:abc123']
);
check('one request stages four changes', requested.changes.length, 4);
check('request records old/new', requested.changes[0], {
    variable: 'led_percent',
    old_value: 25,
    new_value: 80
});
check('active LED unchanged before boundary', session.getActiveValues().led_percent, 25);
check('planned LED shows pending Apply', session.getPlannedValues().led_percent, 80);
check('pending flag set', session.hasPending(), true);

console.log('=== next trial boundary activation + resolution ===');
const trial0 = session.beginTrial({
    trialIndex: 0,
    trialId: 'trial-0001',
    conditionName: 'led_trial',
    effectiveAt: '2026-07-12T14:02:00.000Z'
});
check('trial parameter record kind', trial0.event, 'runtime_control_trial_parameters');
check('four per-variable apply events', trial0.apply_events.length, 4);
const ledApplied = trial0.apply_events.find((entry) => entry.variable === 'led_percent');
check(
    'applied LED event carries required provenance',
    {
        session_id: ledApplied.session_id,
        yaml_id: ledApplied.yaml_id,
        yaml_hash: ledApplied.yaml_hash,
        variable: ledApplied.variable,
        old_value: ledApplied.old_value,
        new_value: ledApplied.new_value,
        operator: ledApplied.operator,
        request_time: ledApplied.request_time,
        effective_time: ledApplied.effective_time,
        first_affected_trial: ledApplied.first_affected_trial
    },
    {
        session_id: 'session-007',
        yaml_id: 'protocols/led.yaml',
        yaml_hash: 'sha256:abc123',
        variable: 'led_percent',
        old_value: 25,
        new_value: 80,
        operator: 'Michael',
        request_time: '2026-07-12T14:01:00.000Z',
        effective_time: '2026-07-12T14:02:00.000Z',
        first_affected_trial: 0
    }
);
check('controller percent resolved from runtime control', trial0.resolved_commands[0].percent, 80);
check('integer plugin param resolved', trial0.resolved_commands[1].params.count, 5);
check('Boolean plugin param resolved', trial0.resolved_commands[1].params.enabled, false);
check('enum plugin param resolved', trial0.resolved_commands[1].params.mode, 'pulse');
check(
    'equal-valued literal is not accidentally replaced',
    trial0.resolved_commands[1].params.literal_copy_of_default,
    25
);
check('undeclared anchored variable resolves normally', trial0.resolved_commands[2].duration, 25);
check(
    'complete resolved variables include fixed variable',
    trial0.resolved_variables.fixed_duration,
    25
);
check(
    'parameter binding carries apply provenance',
    trial0.parameter_bindings[0].provenance.apply_event_id,
    ledApplied.apply_event_id
);
check('pending queue consumed at boundary', session.hasPending(), false);
check('active LED changes at boundary', session.getActiveValues().led_percent, 80);
check('apply getter exposes four final events', session.getApplyEvents().length, 4);

console.log('=== persistence + later Apply ===');
const trial1 = session.beginTrial({
    trialIndex: 1,
    trialId: 'trial-0002',
    conditionName: 'led_trial',
    effectiveAt: '2026-07-12T14:03:00.000Z'
});
check('no new apply events on unchanged trial', trial1.apply_events, []);
check('runtime value persists', trial1.resolved_commands[0].percent, 80);
check(
    'provenance continues to point to first affected trial',
    trial1.runtime_control_provenance.led_percent.first_affected_trial,
    0
);

session.stageApply(
    { led_percent: 50 },
    {
        operator: 'Michael',
        requestedAt: '2026-07-12T14:04:00.000Z',
        requestId: 'manual-request-2'
    }
);
checkThrows(
    'unknown condition does not create a boundary',
    () =>
        session.beginTrial({
            trialIndex: 2,
            conditionName: 'missing',
            effectiveAt: '2026-07-12T14:05:00.000Z'
        }),
    'UNKNOWN_CONDITION'
);
check('pending Apply survives failed resolution', session.hasPending(), true);
const trial2 = session.beginTrial({
    trialIndex: 2,
    conditionName: 'led_trial',
    effectiveAt: '2026-07-12T14:05:00.000Z'
});
check(
    'later Apply old/new',
    [trial2.apply_events[0].old_value, trial2.apply_events[0].new_value],
    [80, 50]
);
check('later Apply resolves on next valid trial', trial2.resolved_commands[0].percent, 50);

console.log('=== validation and transaction safety ===');
const pendingBeforeInvalid = session.getPendingRequests();
checkThrows(
    'out-of-range multi-change Apply is rejected atomically',
    () => session.stageApply({ led_percent: 101, pulse_count: 6 }, { operator: 'Michael' }),
    'INVALID_APPLY'
);
check('invalid Apply stages nothing', session.getPendingRequests(), pendingBeforeInvalid);
check(
    'valid sibling in invalid Apply did not alter planned value',
    session.getPlannedValues().pulse_count,
    5
);
checkThrows(
    'undeclared variable rejected',
    () => session.stageApply({ fixed_duration: 9 }, { operator: 'Michael' }),
    'INVALID_APPLY'
);
checkThrows(
    'integer rejects decimal',
    () => session.stageApply({ pulse_count: 2.5 }, { operator: 'Michael' }),
    'INVALID_APPLY'
);
checkThrows(
    'Boolean rejects numeric stand-in',
    () => session.stageApply({ led_enabled: 1 }, { operator: 'Michael' }),
    'INVALID_APPLY'
);
checkThrows(
    'enum rejects unknown value',
    () => session.stageApply({ led_mode: 'flash' }, { operator: 'Michael' }),
    'INVALID_APPLY'
);
checkThrows(
    'operator is required',
    () => session.stageApply({ led_percent: 60 }, {}),
    'INVALID_APPLY'
);
checkThrows(
    'no-op Apply rejected',
    () => session.stageApply({ led_percent: 50 }, { operator: 'Michael' }),
    'NO_CHANGES'
);
checkThrows(
    'trial indices must increase',
    () =>
        session.beginTrial({
            trialIndex: 2,
            conditionName: 'led_trial',
            effectiveAt: '2026-07-12T14:06:00.000Z'
        }),
    'NON_MONOTONIC_TRIAL'
);

console.log('=== audit identity failures are side-effect free ===');
const auditSession = RuntimeControls.createRuntimeControlSession({
    protocol: protocol,
    sessionId: 'session-audit',
    yamlId: 'protocols/led.yaml',
    yamlHash: 'sha256:audit',
    now: () => '2026-07-12T15:00:00.000Z'
});
auditSession.stageApply(
    { led_percent: 30 },
    {
        operator: 'Michael',
        requestId: 'operator-apply-1',
        requestedAt: '2026-07-12T15:01:00.000Z'
    }
);
const auditPending = auditSession.getPendingRequests();
const auditPlanned = auditSession.getPlannedValues();
checkThrows(
    'duplicate request id is rejected',
    () =>
        auditSession.stageApply(
            { led_percent: 40 },
            {
                operator: 'Michael',
                requestId: 'operator-apply-1',
                requestedAt: '2026-07-12T15:02:00.000Z'
            }
        ),
    'DUPLICATE_REQUEST_ID'
);
check(
    'duplicate id does not alter pending audit records',
    auditSession.getPendingRequests(),
    auditPending
);
check('duplicate id does not alter planned values', auditSession.getPlannedValues(), auditPlanned);
checkThrows(
    'invalid request timestamp is rejected',
    () =>
        auditSession.stageApply(
            { pulse_count: 4 },
            { operator: 'Michael', requestedAt: 'not-a-timestamp' }
        ),
    'INVALID_TIME'
);
check('invalid timestamp stages no request', auditSession.getPendingRequests(), auditPending);
checkThrows(
    'session provenance identity is mandatory',
    () =>
        RuntimeControls.createRuntimeControlSession({
            protocol: protocol,
            sessionId: '',
            yamlId: 'protocols/led.yaml',
            yamlHash: 'sha256:audit'
        }),
    'MISSING_PROVENANCE'
);

console.log('=== multiple explicit Apply requests before one boundary ===');
session.stageApply(
    { led_percent: 60 },
    { operator: 'Michael', requestedAt: '2026-07-12T14:06:00.000Z' }
);
session.stageApply(
    { led_percent: 70 },
    { operator: 'Michael', requestedAt: '2026-07-12T14:06:30.000Z' }
);
const trial3 = session.beginTrial({
    trialIndex: 3,
    conditionName: 'led_trial',
    effectiveAt: '2026-07-12T14:07:00.000Z'
});
check('both explicit Apply events retained', trial3.apply_events.length, 2);
check(
    'same-boundary changes have deterministic old/new chain',
    trial3.apply_events.map((entry) => [entry.old_value, entry.new_value]),
    [
        [50, 60],
        [60, 70]
    ]
);
check('last staged value is authoritative', trial3.resolved_commands[0].percent, 70);

console.log('=== defensive copies + immutable source YAML ===');
const copy = session.getActiveValues();
copy.led_percent = 1;
check('getter cannot mutate session state', session.getActiveValues().led_percent, 70);
trial3.resolved_commands[0].percent = 2;
check(
    'returned trial cannot mutate stored record',
    session.getTrialRecords()[3].resolved_commands[0].percent,
    70
);
check('YAML.Document text never mutated', protocol._doc.toString(), beforeDoc);
check(
    'parsed variables/conditions never mutated',
    JSON.stringify({
        variables: protocol.variables,
        conditions: protocol.conditions
    }),
    beforeModel
);

console.log('=== invalid declaration coverage ===');
const badDefault = parseV3Protocol(YAML_TEXT.replace('&led_percent 25', '&led_percent 125'));
checkBool(
    'default outside range rejected',
    hasIssue(
        RuntimeControls.validateRuntimeControls(badDefault),
        'INVALID_DEFAULT_VALUE',
        'led_percent'
    )
);
const missingRange = parseV3Protocol(
    YAML_TEXT.replace('    minimum: 0\n    maximum: 100', '    minimum: 0')
);
checkBool(
    'number requires complete range',
    hasIssue(
        RuntimeControls.validateRuntimeControls(missingRange),
        'INVALID_NUMERIC_RANGE',
        'led_percent'
    )
);
const missingVariable = parseV3Protocol(
    YAML_TEXT.replace('  led_percent:\n    type: number', '  ghost_percent:\n    type: number')
);
checkBool(
    'control must match existing variable',
    hasIssue(
        RuntimeControls.validateRuntimeControls(missingVariable),
        'UNDECLARED_VARIABLE',
        'ghost_percent'
    )
);

const PATTERN_ALIAS_YAML = `version: 3
experiment_info: {name: Structural alias, date_created: 2026-07-12, author: Lab}
rig: configs/rig.yaml
variables:
  pattern_name: &pattern_name a.pat
runtime_controls:
  pattern_name:
    type: enum
    values: [a.pat, b.pat]
experiment: [trial]
conditions:
  - name: trial
    commands:
      - type: controller
        command_name: trialParams
        pattern: *pattern_name
        pattern_ID: 1
        duration: 1
        mode: 0
        frame_index: 1
        frame_rate: 0
        gain: 0
`;
checkBool(
    'pattern switching is rejected for first implementation',
    hasIssue(
        RuntimeControls.validateRuntimeControls(parseV3Protocol(PATTERN_ALIAS_YAML)),
        'STRUCTURAL_RUNTIME_ALIAS',
        'pattern_name'
    )
);

const SEQUENCE_ALIAS_YAML = `version: 3
experiment_info: {name: Sequence alias, date_created: 2026-07-12, author: Lab}
rig: configs/rig.yaml
variables:
  repeat_count: &repeat_count 2
runtime_controls:
  repeat_count: {type: integer, minimum: 1, maximum: 5}
experiment:
  - name: block
    trials: [trial]
    repetitions: *repeat_count
conditions:
  - name: trial
    commands:
      - {type: wait, duration: 1}
`;
checkBool(
    'sequence structure alias is out of scope',
    hasIssue(
        RuntimeControls.validateRuntimeControls(parseV3Protocol(SEQUENCE_ALIAS_YAML)),
        'OUT_OF_SCOPE_RUNTIME_ALIAS',
        'repeat_count'
    )
);

console.log('\n=== Summary ===');
console.log(`${total - failures} / ${total} checks passed`);
process.exit(failures ? 1 : 0);
