#!/usr/bin/env node
/**
 * Protocol v3 Roundtrip Tests
 *
 * Phase 1 gate: round-trip the two canonical v3 YAMLs from origin/version3
 * @ 649d7ef, plus all coverage-gap fixtures, preserving anchors and comments.
 *
 * MATLAB-side cross-check (Phase 1 gate item 4) lives in a separate manual
 * script (docs/development/v3-matlab-validation.md and Phase 8 work);
 * see README at top of that doc.
 *
 * Run via:
 *   node tests/test-protocol-roundtrip-v3.js
 *   npm run test:protocol-v3
 *
 * Exit code 0 = all passed, 1 = failures.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
    parseV3Protocol,
    generateV3Protocol,
    validateReferences,
    collectExportWarnings,
    V3ParseError,
    docSet,
    docDelete,
    docInsertCommand,
    docMoveCommand,
    docInsertCondition,
    docCloneCondition,
    docAppendSequenceEntry,
    docSetPluginCommandHead,
    docAddPluginParam,
    docDeletePluginParam,
    nodeIsAliasAt,
    aliasNameAt
} = require('../js/protocol-yaml-v3.js');

const {
    findPluginDefByClass,
    getCommandsForClass,
    getV3PluginCommands,
    listV3PluginNames,
    getV3CommandParams,
    LOG_PLUGIN
} = require('../js/plugin-registry.js');

// ─── Counters & helpers ─────────────────────────────────────────────────────

let totalTests = 0;
let passedTests = 0;
let failedTests = [];

function pass(label, detail) {
    totalTests++;
    passedTests++;
    console.log('  \x1b[32m✓\x1b[0m ' + label + (detail ? ' — ' + detail : ''));
}

function fail(label, detail) {
    totalTests++;
    failedTests.push(label);
    console.log('  \x1b[31m✗\x1b[0m ' + label + (detail ? ' — ' + detail : ''));
}

function check(label, actual, expected) {
    if (actual === expected) {
        pass(label, JSON.stringify(actual));
    } else {
        fail(label, 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
    }
}

function checkTrue(label, condition, detail) {
    if (condition) pass(label, detail);
    else fail(label, detail || 'expected truthy');
}

function checkThrows(label, fn, expectedCode) {
    try {
        fn();
        fail(label, 'expected throw with code ' + expectedCode + ', but did not throw');
    } catch (e) {
        if (expectedCode && e.code !== expectedCode) {
            fail(label, 'threw with code ' + e.code + ', expected ' + expectedCode);
        } else {
            pass(label, e.code + ': ' + e.message.slice(0, 80));
        }
    }
}

function dropDoc(experiment) {
    // For deep-equal comparisons: strip the YAML.Document handle (which holds
    // CST nodes that aren't JSON-serializable in a stable way).
    const { _doc, ...rest } = experiment;
    return rest;
}

function readFixture(name) {
    return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

// ─── Test Suite 1: Canonical round-trip (Phase 1 gate, priority 1) ──────────
console.log('\n--- Suite 1: Canonical round-trip ---');

for (const fname of ['v3_canonical_a.yaml', 'v3_canonical_b.yaml']) {
    const text = readFixture(fname);
    const exp1 = parseV3Protocol(text);
    const regen = generateV3Protocol(exp1);
    const exp2 = parseV3Protocol(regen);

    check(fname + ': version', exp1.version, 3);
    check(fname + ': conditions count', exp1.conditions.length, 11);
    check(fname + ': sequence length', exp1.sequence.length, 4);
    check(fname + ': sequence[0].kind', exp1.sequence[0].kind, 'ref');
    check(fname + ': sequence[2].kind', exp1.sequence[2].kind, 'block');
    check(fname + ': variables count', exp1.variables.length, 4);

    const refs = validateReferences(exp1);
    checkTrue(
        fname + ': all references resolve',
        refs.ok,
        refs.ok ? 'all bare refs + trials + intertrials resolve' : refs.errors.join('; ')
    );

    // Data-model deep equality (modulo _doc)
    checkTrue(
        fname + ': parse → generate → parse data model stable',
        JSON.stringify(dropDoc(exp1)) === JSON.stringify(dropDoc(exp2))
    );

    // Anchor & alias survival in regenerated YAML text
    for (const anchorName of ['dur_long', 'dur_short', 'color_command', 'color_power']) {
        checkTrue(
            fname + ': anchor "' + anchorName + '" defined in regen',
            regen.includes('&' + anchorName)
        );
        checkTrue(
            fname + ': anchor "' + anchorName + '" referenced as alias in regen',
            regen.includes('*' + anchorName)
        );
    }

    // Comment survival
    const origComments = text.split('\n').filter((l) => l.trimStart().startsWith('#')).length;
    const regenComments = regen.split('\n').filter((l) => l.trimStart().startsWith('#')).length;
    checkTrue(
        fname + ': comment lines preserved',
        regenComments === origComments,
        'orig=' + origComments + ', regen=' + regenComments
    );
}

// ─── Test Suite 2: Coverage-gap fixtures ────────────────────────────────────
console.log('\n--- Suite 2: Coverage-gap fixtures ---');

const coverageFixtures = [
    'v3_multi_block.yaml',
    'v3_no_randomize.yaml',
    'v3_no_variables.yaml',
    'v3_no_intertrial.yaml',
    'v3_consecutive_refs.yaml',
    'v3_future_keys.yaml',
    'v3_plugin_config.yaml',
    'v3_full_experiment.yaml'
];

for (const fname of coverageFixtures) {
    const text = readFixture(fname);
    let exp1;
    try {
        exp1 = parseV3Protocol(text);
        pass(fname + ': parses cleanly');
    } catch (e) {
        fail(fname + ': parse failed', e.message);
        continue;
    }
    const regen = generateV3Protocol(exp1);
    const exp2 = parseV3Protocol(regen);
    checkTrue(
        fname + ': round-trip data model stable',
        JSON.stringify(dropDoc(exp1)) === JSON.stringify(dropDoc(exp2))
    );
    const refs = validateReferences(exp1);
    checkTrue(fname + ': references resolve', refs.ok, refs.ok ? '' : refs.errors.join('; '));
}

// ─── Test Suite 3: Multi-block fixture — structural details ─────────────────
console.log('\n--- Suite 3: Multi-block structural checks ---');

{
    const exp = parseV3Protocol(readFixture('v3_multi_block.yaml'));
    check('multi_block: sequence length', exp.sequence.length, 5);
    check('multi_block: seq[0] is bare ref', exp.sequence[0].kind, 'ref');
    check('multi_block: seq[1] is block', exp.sequence[1].kind, 'block');
    check('multi_block: block "pretest" reps', exp.sequence[1].repetitions, 1);
    check('multi_block: block "training" reps', exp.sequence[2].repetitions, 4);
    check('multi_block: block "training" randomize', exp.sequence[2].randomize, true);
    check('multi_block: block "training" intertrial', exp.sequence[2].intertrial, 'baseline');
    check(
        'multi_block: block "posttest" randomize defaults false',
        exp.sequence[3].randomize,
        false
    );
}

// ─── Test Suite 4: Future-keys passthrough ──────────────────────────────────
console.log('\n--- Suite 4: Forward-compat unknown-keys passthrough ---');

{
    const exp = parseV3Protocol(readFixture('v3_future_keys.yaml'));
    const block = exp.sequence[0];
    check('future_keys: block has known keys', block.kind, 'block');
    checkTrue(
        'future_keys: retry_on_fail preserved in _unknownKeys',
        block._unknownKeys && typeof block._unknownKeys.retry_on_fail === 'object'
    );
    checkTrue(
        'future_keys: abort_if preserved in _unknownKeys',
        block._unknownKeys && typeof block._unknownKeys.abort_if === 'string'
    );

    const regen = generateV3Protocol(exp);
    checkTrue('future_keys: retry_on_fail survives in regen YAML', regen.includes('retry_on_fail'));
    checkTrue('future_keys: abort_if survives in regen YAML', regen.includes('abort_if'));
    checkTrue(
        'future_keys: max_retries_per_trial nested value survives',
        regen.includes('max_retries_per_trial')
    );
}

// ─── Test Suite 5: Plugin config & params ──────────────────────────────────
console.log('\n--- Suite 5: Plugin config and command params ---');

{
    const exp = parseV3Protocol(readFixture('v3_plugin_config.yaml'));
    check('plugin_config: plugin count', exp.plugins.length, 2);
    check('plugin_config: camera plugin name', exp.plugins[0].name, 'camera');
    check('plugin_config: camera config.frame_rate', exp.plugins[0].config.frame_rate, 150);
    check('plugin_config: camera config.video_format', exp.plugins[0].config.video_format, 'avi');
    check('plugin_config: backlight config.port', exp.plugins[1].config.port, 'COM5');

    // Plugin command with params
    const setupCond = exp.conditions.find((c) => c.name === 'setup');
    checkTrue('plugin_config: setup condition found', !!setupCond);
    const irPower = setupCond.commands.find((c) => c.command_name === 'setIRLEDPower');
    checkTrue('plugin_config: setIRLEDPower command found', !!irPower);
    check('plugin_config: setIRLEDPower power param', irPower.params.power, 50);
}

// ─── Test Suite 6: Variables — types & order ────────────────────────────────
console.log('\n--- Suite 6: Variables (anchors) types and order ---');

{
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    check('variables: count', exp.variables.length, 4);
    check('variables: order[0].name', exp.variables[0].name, 'dur_long');
    check('variables: order[0].value (number)', exp.variables[0].value, 10);
    check('variables: order[2].name', exp.variables[2].name, 'color_command');
    check('variables: order[2].value (string)', exp.variables[2].value, 'setRedLEDPower');
}

// ─── Test Suite 7: Validation error cases ───────────────────────────────────
console.log('\n--- Suite 7: Validation error cases ---');

checkThrows('rejects version: 1', () => parseV3Protocol('version: 1\nfoo: bar\n'), 'WRONG_VERSION');

checkThrows('rejects version: 2', () => parseV3Protocol('version: 2\nfoo: bar\n'), 'WRONG_VERSION');

checkThrows(
    'rejects missing rig',
    () =>
        parseV3Protocol(
            'version: 3\nexperiment_info: {name: x}\nexperiment: [foo]\nconditions: [{name: foo, commands: []}]\n'
        ),
    'INVALID_SCHEMA'
);

checkThrows(
    'rejects empty experiment',
    () =>
        parseV3Protocol(
            'version: 3\nexperiment_info: {name: x}\nrig: "/tmp/r.yaml"\nexperiment: []\nconditions: [{name: foo, commands: []}]\n'
        ),
    'INVALID_SCHEMA'
);

// Unknown command types passthrough (forward-compat) — preserves type and all
// fields so future MATLAB additions (branch, loop, etc.) round-trip safely.
{
    const yaml = [
        'version: 3',
        'experiment_info: {name: x}',
        'rig: "/tmp/r.yaml"',
        'experiment: [foo]',
        'conditions:',
        '  - name: foo',
        '    commands:',
        '      - {type: "branch", condition: "x > 0", goto: "next"}',
        '      - {type: "wait", duration: 1}'
    ].join('\n') + '\n';
    const exp = parseV3Protocol(yaml);
    const cmds = exp.conditions[0].commands;
    check('passthrough: unknown type preserved', cmds[0].type, 'branch');
    checkTrue('passthrough: _rawUnknownType flag set', !!cmds[0]._rawUnknownType);
    check('passthrough: extra field condition preserved', cmds[0].condition, 'x > 0');
    check('passthrough: extra field goto preserved', cmds[0].goto, 'next');
    check('passthrough: subsequent known command still parses', cmds[1].type, 'wait');

    // Round-trip via _doc.toString preserves unknown fields verbatim
    const regen = generateV3Protocol(exp);
    checkTrue('passthrough: "branch" survives in regen YAML', regen.includes('branch'));
    checkTrue(
        'passthrough: extra fields survive in regen YAML',
        regen.includes('condition') && regen.includes('goto')
    );

    const reparsed = parseV3Protocol(regen);
    const branch2 = reparsed.conditions[0].commands[0];
    check('passthrough: reparse preserves type', branch2.type, 'branch');
    check('passthrough: reparse preserves condition', branch2.condition, 'x > 0');
    check('passthrough: reparse preserves goto', branch2.goto, 'next');
}

// Still reject malformed commands — missing type entirely
checkThrows(
    'rejects command with no type field',
    () =>
        parseV3Protocol(
            [
                'version: 3',
                'experiment_info: {name: x}',
                'rig: "/tmp/r.yaml"',
                'experiment: [foo]',
                'conditions:',
                '  - name: foo',
                '    commands:',
                '      - {duration: 1}'
            ].join('\n') + '\n'
        ),
    'INVALID_SCHEMA'
);

// Still reject malformed commands — non-string type (number, bool, null)
checkThrows(
    'rejects command with non-string type',
    () =>
        parseV3Protocol(
            [
                'version: 3',
                'experiment_info: {name: x}',
                'rig: "/tmp/r.yaml"',
                'experiment: [foo]',
                'conditions:',
                '  - name: foo',
                '    commands:',
                '      - {type: 42, duration: 1}'
            ].join('\n') + '\n'
        ),
    'INVALID_SCHEMA'
);

// Reference validation catches dangling refs (returns errors, doesn't throw)
{
    const exp = parseV3Protocol(
        [
            'version: 3',
            'experiment_info: {name: x}',
            'rig: "/tmp/r.yaml"',
            'experiment: ["nonexistent"]',
            'conditions:',
            '  - name: foo',
            '    commands:',
            '      - {type: "wait", duration: 1}'
        ].join('\n') + '\n'
    );
    const refs = validateReferences(exp);
    check('validateReferences: dangling ref detected (ok=false)', refs.ok, false);
    checkTrue(
        'validateReferences: error message mentions "nonexistent"',
        refs.errors.some((e) => e.includes('nonexistent'))
    );
}

// Duplicate condition names
{
    const exp = parseV3Protocol(
        [
            'version: 3',
            'experiment_info: {name: x}',
            'rig: "/tmp/r.yaml"',
            'experiment: ["foo"]',
            'conditions:',
            '  - name: foo',
            '    commands: [{type: "wait", duration: 1}]',
            '  - name: foo',
            '    commands: [{type: "wait", duration: 2}]'
        ].join('\n') + '\n'
    );
    const refs = validateReferences(exp);
    check('validateReferences: duplicate condition name detected', refs.ok, false);
    checkTrue(
        'validateReferences: error message mentions "Duplicate"',
        refs.errors.some((e) => e.includes('Duplicate'))
    );
}

// ─── Test Suite 8b: Full-experiment fixture (Lisa, 2026-05-26) ──────────────
console.log('\n--- Suite 8b: Lisa\'s full_experiment_test_v3 fixture ---');

{
    const text = readFixture('v3_full_experiment.yaml');
    const exp = parseV3Protocol(text);
    check('full_exp: version', exp.version, 3);
    check('full_exp: conditions count', exp.conditions.length, 15);
    check('full_exp: variables count', exp.variables.length, 6);
    check('full_exp: sequence length', exp.sequence.length, 6);
    check('full_exp: seq[0] bare ref', exp.sequence[0].kind, 'ref');
    check('full_exp: seq[4] is block', exp.sequence[4].kind, 'block');
    check('full_exp: main block trials', exp.sequence[4].trials.length, 9);
    check('full_exp: main block reps', exp.sequence[4].repetitions, 3);
    check('full_exp: main block randomize', exp.sequence[4].randomize, false);
    check('full_exp: main block intertrial', exp.sequence[4].intertrial, 'intertrial');
    check('full_exp: seq[5] bare ref "shutdown"', exp.sequence[5].condition_name, 'shutdown');

    const refs = validateReferences(exp);
    checkTrue(
        'full_exp: all references resolve',
        refs.ok,
        refs.ok ? '' : refs.errors.join('; ')
    );

    // Anchor survival (variable names from Lisa's fixture)
    const regen = generateV3Protocol(exp);
    for (const anchor of ['IR_power', 'trial_dur', 'fr_rate', 'led_power', 'baseline_wait', 'inter_wait']) {
        checkTrue('full_exp: anchor &' + anchor + ' in regen', regen.includes('&' + anchor));
        checkTrue('full_exp: alias *' + anchor + ' in regen', regen.includes('*' + anchor));
    }
}

// ─── Test Suite 8: Numeric type preservation ────────────────────────────────
console.log('\n--- Suite 8: Numeric type preservation ---');

{
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const block = exp.sequence[2];
    check('numeric: block.repetitions is number', typeof block.repetitions, 'number');
    check('numeric: block.repetitions value', block.repetitions, 3);

    const arenaCheck = exp.conditions.find((c) => c.name === 'arena check');
    const waitCmd = arenaCheck.commands.find((c) => c.type === 'wait');
    check('numeric: wait.duration is number', typeof waitCmd.duration, 'number');
    check('numeric: wait.duration value', waitCmd.duration, 3);

    // Variable value (number)
    check('numeric: variable dur_long is number', typeof exp.variables[0].value, 'number');
    check('numeric: variable color_power value', exp.variables[3].value, 5);
}

// ─── Test Suite 9: Editing — docSet, alias detection, comment survival ─────
console.log('\n--- Suite 9: docSet edits + alias detection ---');

{
    // 1. Edit a wait.duration in canonical_a and verify it round-trips.
    const orig = readFixture('v3_canonical_a.yaml');
    const exp = parseV3Protocol(orig);

    // Find condition "arena check" and its wait command
    const condIdx = exp.conditions.findIndex((c) => c.name === 'arena check');
    checkTrue('edit: arena check condition found', condIdx >= 0);
    const cmdIdx = exp.conditions[condIdx].commands.findIndex((c) => c.type === 'wait');
    checkTrue('edit: wait command found in arena check', cmdIdx >= 0);

    const oldDur = exp.conditions[condIdx].commands[cmdIdx].duration;
    check('edit: pre-edit wait.duration', oldDur, 3);

    // docSet to change the duration to 7
    docSet(exp, ['conditions', condIdx, 'commands', cmdIdx, 'duration'], 7);

    // JS model mirrored
    check('edit: JS model updated', exp.conditions[condIdx].commands[cmdIdx].duration, 7);

    // YAML emit contains the new value, not the old one (in the right place)
    const regen = generateV3Protocol(exp);
    const reparsed = parseV3Protocol(regen);
    check(
        'edit: reparsed wait.duration is 7',
        reparsed.conditions[condIdx].commands[cmdIdx].duration,
        7
    );

    // Comments survive the edit (count check)
    const origComments = orig.split('\n').filter((l) => l.trimStart().startsWith('#')).length;
    const regenComments = regen.split('\n').filter((l) => l.trimStart().startsWith('#')).length;
    checkTrue(
        'edit: comment count preserved through edit',
        origComments === regenComments,
        'orig=' + origComments + ', after-edit=' + regenComments
    );

    // Other anchors/aliases still intact in the regen
    checkTrue('edit: anchor &dur_long still in regen', regen.includes('&dur_long'));
    checkTrue('edit: alias *dur_long still in regen', regen.includes('*dur_long'));
}

{
    // 2. Alias detection — arena check's wait is *dur_short (alias);
    // start light and camera's wait is literal 0.5.
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));

    const arenaCheckIdx = exp.conditions.findIndex((c) => c.name === 'arena check');
    const arenaWaitIdx = exp.conditions[arenaCheckIdx].commands.findIndex(
        (c) => c.type === 'wait'
    );
    const aliasPath = [
        'conditions',
        arenaCheckIdx,
        'commands',
        arenaWaitIdx,
        'duration'
    ];

    checkTrue('alias: nodeIsAliasAt detects *dur_short binding', nodeIsAliasAt(exp, aliasPath));
    check('alias: aliasNameAt returns "dur_short"', aliasNameAt(exp, aliasPath), 'dur_short');

    const litCond = exp.conditions.find((c) => c.name === 'start light and camera');
    const litCondIdx = exp.conditions.indexOf(litCond);
    const litWaitIdx = litCond.commands.findIndex((c) => c.type === 'wait');
    const literalPath = ['conditions', litCondIdx, 'commands', litWaitIdx, 'duration'];

    check(
        'alias: literal scalar returns null aliasName',
        aliasNameAt(exp, literalPath),
        null
    );
    checkTrue(
        'alias: literal scalar is NOT detected as alias',
        !nodeIsAliasAt(exp, literalPath)
    );
}

{
    // 3. Edit a string field (controller.command_name) — string round-trip
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const condIdx = exp.conditions.findIndex((c) => c.name === 'arena check');
    const ctrlIdx = exp.conditions[condIdx].commands.findIndex(
        (c) => c.type === 'controller'
    );
    docSet(
        exp,
        ['conditions', condIdx, 'commands', ctrlIdx, 'command_name'],
        'allOff'
    );
    check(
        'edit: string field JS model',
        exp.conditions[condIdx].commands[ctrlIdx].command_name,
        'allOff'
    );
    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    check(
        'edit: string field reparsed',
        reparsed.conditions[condIdx].commands[ctrlIdx].command_name,
        'allOff'
    );
}

{
    // 4. Block property edits — repetitions, randomize, intertrial set + delete
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const blockIdx = exp.sequence.findIndex((e) => e.kind === 'block');
    checkTrue('block edit: block found in canonical_a sequence', blockIdx >= 0);

    docSet(exp, ['experiment', blockIdx, 'repetitions'], 5);
    docSet(exp, ['experiment', blockIdx, 'randomize'], false);
    check('block edit: JS reps mirrored', exp.sequence[blockIdx].repetitions, 5);
    check('block edit: JS randomize mirrored', exp.sequence[blockIdx].randomize, false);

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    check('block edit: reps round-trip', reparsed.sequence[blockIdx].repetitions, 5);
    check('block edit: randomize round-trip', reparsed.sequence[blockIdx].randomize, false);
}

{
    // 5. docDelete — clear block intertrial back to "none"
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const blockIdx = exp.sequence.findIndex((e) => e.kind === 'block');
    check('delete: pre-delete intertrial', exp.sequence[blockIdx].intertrial, 'intertrial');

    docDelete(exp, ['experiment', blockIdx, 'intertrial']);
    check('delete: JS intertrial cleared to null', exp.sequence[blockIdx].intertrial, null);

    const regen = generateV3Protocol(exp);
    checkTrue(
        'delete: intertrial line removed from YAML',
        !regen.includes('intertrial: "intertrial"')
    );
    const reparsed = parseV3Protocol(regen);
    check(
        'delete: reparsed intertrial is null',
        reparsed.sequence[blockIdx].intertrial,
        null
    );
    // Anchors/comments still intact through a delete
    checkTrue('delete: &dur_long preserved', regen.includes('&dur_long'));
    checkTrue('delete: comment block preserved', regen.includes('# EXPERIMENT METADATA'));
}

{
    // 6. Block name — set and clear
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const blockIdx = exp.sequence.findIndex((e) => e.kind === 'block');
    check('block name: pre-edit', exp.sequence[blockIdx].name, 'main block');

    docSet(exp, ['experiment', blockIdx, 'name'], 'renamed block');
    check('block name: set JS', exp.sequence[blockIdx].name, 'renamed block');
    let reparsed = parseV3Protocol(generateV3Protocol(exp));
    check('block name: set round-trip', reparsed.sequence[blockIdx].name, 'renamed block');

    docDelete(exp, ['experiment', blockIdx, 'name']);
    check('block name: clear JS', exp.sequence[blockIdx].name, null);
    reparsed = parseV3Protocol(generateV3Protocol(exp));
    check('block name: clear round-trip', reparsed.sequence[blockIdx].name, null);
}

// ─── Test Suite 10: v3 plugin-registry lookups ──────────────────────────────
console.log('\n--- Suite 10: v3 plugin registry (class-based lookup + log) ---');

{
    // findPluginDefByClass — finds DAQ, Bias; returns null for unknown
    check(
        'registry: findPluginDefByClass(DAQThermometerPlugin)',
        findPluginDefByClass('DAQThermometerPlugin')?.name,
        'thermometer'
    );
    check(
        'registry: findPluginDefByClass(BiasPlugin)',
        findPluginDefByClass('BiasPlugin')?.name,
        'camera'
    );
    check(
        'registry: findPluginDefByClass(LEDControllerPlugin)',
        findPluginDefByClass('LEDControllerPlugin')?.name,
        'backlight'
    );
    check('registry: findPluginDefByClass(Unknown) is null', findPluginDefByClass('Nope'), null);
    check('registry: findPluginDefByClass(undef) is null', findPluginDefByClass(undefined), null);
}

{
    // DAQ commands & log plugin shape
    const daqCmds = getCommandsForClass('DAQThermometerPlugin');
    check('registry: DAQ has 4 commands', Object.keys(daqCmds).length, 4);
    checkTrue('registry: DAQ.startContinuousLogging defined', !!daqCmds.startContinuousLogging);
    checkTrue('registry: DAQ.stopContinuousLogging defined', !!daqCmds.stopContinuousLogging);
    checkTrue('registry: DAQ.get_temperature defined', !!daqCmds.get_temperature);
    checkTrue('registry: DAQ.log_temperature defined', !!daqCmds.log_temperature);

    check('registry: LOG_PLUGIN.name', LOG_PLUGIN.name, 'log');
    check('registry: LOG_PLUGIN has 1 command', Object.keys(LOG_PLUGIN.commands).length, 1);
    check(
        'registry: LOG_PLUGIN.log.params.message.required',
        LOG_PLUGIN.commands.log.params.message.required,
        true
    );
    check(
        'registry: LOG_PLUGIN.log.params.level default',
        LOG_PLUGIN.commands.log.params.level.default,
        'INFO'
    );
}

{
    // Class-based resolution within a parsed experiment (canonical_a has camera + backlight)
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));

    // listV3PluginNames includes the user's declared names + "log" at the end
    const names = listV3PluginNames(exp);
    check('lookup: list ends with "log"', names[names.length - 1], 'log');
    checkTrue('lookup: list includes camera', names.includes('camera'));
    checkTrue('lookup: list includes backlight', names.includes('backlight'));

    // getV3PluginCommands resolves via matlab.class
    const camCmds = getV3PluginCommands(exp, 'camera');
    checkTrue('lookup: camera resolves to BiasPlugin commands', !!camCmds.startRecording);
    checkTrue('lookup: camera has getTimestamp', !!camCmds.getTimestamp);

    const blCmds = getV3PluginCommands(exp, 'backlight');
    checkTrue('lookup: backlight resolves to LEDControllerPlugin commands', !!blCmds.setIRLEDPower);
    checkTrue('lookup: backlight has setRedLEDPower', !!blCmds.setRedLEDPower);

    // "log" always available even without declaration
    const logCmds = getV3PluginCommands(exp, 'log');
    checkTrue('lookup: "log" returns LOG_PLUGIN.commands', !!logCmds.log);

    // Unknown plugin name returns empty (designer should disable the picker)
    const noCmds = getV3PluginCommands(exp, 'nonexistent');
    check('lookup: unknown plugin name returns empty map', Object.keys(noCmds).length, 0);
}

{
    // User can name a plugin anything — class-based lookup still resolves it
    const customYaml = [
        'version: 3',
        'experiment_info: {name: x}',
        'rig: "/tmp/r.yaml"',
        'plugins:',
        '  - name: my_cam',
        '    type: class',
        '    matlab: {class: BiasPlugin}',
        'experiment: [setup]',
        'conditions:',
        '  - name: setup',
        '    commands: [{type: wait, duration: 1}]'
    ].join('\n') + '\n';
    const exp = parseV3Protocol(customYaml);
    const cmds = getV3PluginCommands(exp, 'my_cam');
    checkTrue('custom name: my_cam resolves Bias commands via class', !!cmds.startRecording);
    check(
        'custom name: listV3PluginNames returns ["my_cam", "log"]',
        JSON.stringify(listV3PluginNames(exp)),
        '["my_cam","log"]'
    );
}

{
    // getV3CommandParams routes controller, plugin, log all correctly
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));

    const ctrlParams = getV3CommandParams(exp, 'controller', null, 'trialParams');
    checkTrue('params: controller.trialParams has pattern param', !!ctrlParams?.pattern);

    const startRec = getV3CommandParams(exp, 'plugin', 'camera', 'startRecording');
    checkTrue('params: plugin camera.startRecording has filename param', !!startRec?.filename);

    const logParams = getV3CommandParams(exp, 'plugin', 'log', 'log');
    checkTrue('params: plugin log.log has message + level', !!logParams?.message && !!logParams?.level);

    const nope = getV3CommandParams(exp, 'plugin', 'camera', 'bogusCommand');
    check('params: unknown plugin command returns null', nope, null);
}

// ─── Test Suite 10b: Block `repetitions` validation ────────────────────────
console.log("\n--- Suite 10b: repetitions validation ---");

function v3WithReps(repsLiteral) {
    return [
        'version: 3',
        'experiment_info: {name: x}',
        'rig: "/tmp/r.yaml"',
        'experiment:',
        '  - name: blk',
        '    trials: [c]',
        '    repetitions: ' + repsLiteral,
        'conditions:',
        '  - name: c',
        '    commands: [{type: wait, duration: 1}]'
    ].join('\n') + '\n';
}

checkThrows('reps validation: rejects 0', () => parseV3Protocol(v3WithReps('0')), 'INVALID_SCHEMA');
checkThrows('reps validation: rejects -1', () => parseV3Protocol(v3WithReps('-1')), 'INVALID_SCHEMA');
checkThrows('reps validation: rejects 1.5', () => parseV3Protocol(v3WithReps('1.5')), 'INVALID_SCHEMA');
checkThrows(
    'reps validation: rejects non-numeric string',
    () => parseV3Protocol(v3WithReps('"three"')),
    'INVALID_SCHEMA'
);

{
    // Positive integer accepted
    const exp = parseV3Protocol(v3WithReps('3'));
    check('reps validation: accepts positive integer 3', exp.sequence[0].repetitions, 3);
}
{
    // Omitted → default 1
    const yamlNoReps = [
        'version: 3',
        'experiment_info: {name: x}',
        'rig: "/tmp/r.yaml"',
        'experiment:',
        '  - name: blk',
        '    trials: [c]',
        'conditions:',
        '  - name: c',
        '    commands: [{type: wait, duration: 1}]'
    ].join('\n') + '\n';
    const exp = parseV3Protocol(yamlNoReps);
    check('reps validation: omitted defaults to 1', exp.sequence[0].repetitions, 1);
}

// ─── Test Suite 11: docInsertCommand / docMoveCommand / delete-command ────
console.log('\n--- Suite 11: command add / move / delete ---');

{
    // Insert a new wait command in the middle of "arena check"
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const condIdx = exp.conditions.findIndex((c) => c.name === 'arena check');
    const before = exp.conditions[condIdx].commands.length;

    docInsertCommand(exp, condIdx, 1, { type: 'wait', duration: 0.25 });
    check('insert: JS length grew by 1', exp.conditions[condIdx].commands.length, before + 1);
    check(
        'insert: at index 1 is the new wait',
        exp.conditions[condIdx].commands[1].type,
        'wait'
    );
    check(
        'insert: duration preserved',
        exp.conditions[condIdx].commands[1].duration,
        0.25
    );

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    check(
        'insert: round-trip length',
        reparsed.conditions[condIdx].commands.length,
        before + 1
    );
    check(
        'insert: round-trip new command type',
        reparsed.conditions[condIdx].commands[1].type,
        'wait'
    );
    check(
        'insert: round-trip new command duration',
        reparsed.conditions[condIdx].commands[1].duration,
        0.25
    );

    // Anchors/comments still alive after insert
    const regen = generateV3Protocol(exp);
    checkTrue('insert: anchors preserved', regen.includes('&dur_short') && regen.includes('*dur_short'));
    checkTrue('insert: comments preserved', regen.includes('# EXPERIMENT METADATA'));
}

{
    // Append a plugin command (uses createNode with nested params map)
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const condIdx = exp.conditions.findIndex((c) => c.name === 'arena check');
    const before = exp.conditions[condIdx].commands.length;
    docInsertCommand(exp, condIdx, before, {
        type: 'plugin',
        plugin_name: 'log',
        command_name: 'log',
        params: { message: 'arena check done', level: 'INFO' }
    });

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    const appended = reparsed.conditions[condIdx].commands[before];
    check('insert plugin: type', appended.type, 'plugin');
    check('insert plugin: plugin_name', appended.plugin_name, 'log');
    check('insert plugin: command_name', appended.command_name, 'log');
    check('insert plugin: params.message', appended.params.message, 'arena check done');
    check('insert plugin: params.level', appended.params.level, 'INFO');
}

{
    // Move first command to last (swap arena check's allOn → allOff order)
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const condIdx = exp.conditions.findIndex((c) => c.name === 'arena check');
    const cmds = exp.conditions[condIdx].commands;
    const origFirstName = cmds[0].command_name;
    const origLastName = cmds[cmds.length - 1].command_name;

    docMoveCommand(exp, condIdx, 0, cmds.length - 1);
    // After moving [0] (controller allOn) to the end, the new order is:
    // [wait, controller allOff, controller allOn]
    check('move: JS new first is the wait', cmds[0].type, 'wait');
    check('move: original first is now at end', cmds[cmds.length - 1].command_name, origFirstName);

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    const reparsedCmds = reparsed.conditions[condIdx].commands;
    check('move: round-trip last is original first', reparsedCmds[reparsedCmds.length - 1].command_name, origFirstName);
}

{
    // Delete a command via docDelete
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const condIdx = exp.conditions.findIndex((c) => c.name === 'arena check');
    const before = exp.conditions[condIdx].commands.length;
    docDelete(exp, ['conditions', condIdx, 'commands', 1]); // delete middle (the wait)

    check('delete cmd: JS length shrank', exp.conditions[condIdx].commands.length, before - 1);
    check('delete cmd: middle is now what was last', exp.conditions[condIdx].commands[1].command_name, 'allOff');

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    check('delete cmd: round-trip length', reparsed.conditions[condIdx].commands.length, before - 1);
    // The *dur_short anchor was previously used in the deleted wait; *dur_short
    // is still defined in `variables:` and used by no one (now orphaned).
    // Generation should still succeed.
    checkTrue('delete cmd: regen succeeds', generateV3Protocol(exp).length > 0);
}

{
    // Bounds-check: docMoveCommand with bad indices is a no-op
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const condIdx = exp.conditions.findIndex((c) => c.name === 'arena check');
    const before = JSON.stringify(exp.conditions[condIdx].commands.map((c) => c.type));
    docMoveCommand(exp, condIdx, 0, 0); // no-op
    docMoveCommand(exp, condIdx, 99, 0); // out of bounds
    docMoveCommand(exp, condIdx, -1, 0); // negative
    check(
        'move: no-op / bad indices preserve order',
        JSON.stringify(exp.conditions[condIdx].commands.map((c) => c.type)),
        before
    );
}

// ─── Test Suite 12: B1 select-typed schema fields preserve types ──────────
console.log('\n--- Suite 12: select-typed schema field type preservation ---');

{
    const yaml = [
        'version: 3',
        'experiment_info: {name: x}',
        'rig: "/tmp/r.yaml"',
        'experiment: [show]',
        'conditions:',
        '  - name: show',
        '    commands:',
        '      - type: controller',
        '        command_name: trialParams',
        '        pattern: "test.pat"',
        '        pattern_ID: 1',
        '        duration: 5',
        '        mode: 2',
        '        frame_index: 1',
        '        frame_rate: 60',
        '        gain: 0',
        '      - type: controller',
        '        command_name: setColorDepth',
        '        gs_val: 16',
        '      - type: plugin',
        '        plugin_name: log',
        '        command_name: log',
        '        params:',
        '          message: "starting"',
        '          level: "DEBUG"'
    ].join('\n') + '\n';
    const exp = parseV3Protocol(yaml);
    const cmds = exp.conditions[0].commands;

    // 1. Initial types preserved through parse
    check('select: trialParams.mode is number', typeof cmds[0].mode, 'number');
    check('select: trialParams.mode value', cmds[0].mode, 2);
    check('select: setColorDepth.gs_val is number', typeof cmds[1].gs_val, 'number');
    check('select: setColorDepth.gs_val value', cmds[1].gs_val, 16);
    check('select: log.level is string', typeof cmds[2].params.level, 'string');
    check('select: log.level value', cmds[2].params.level, 'DEBUG');

    // 2. Schema lookup returns the right type info
    const trialParamsSchema = getV3CommandParams(exp, 'controller', null, 'trialParams');
    check('select: trialParams.mode schema.type', trialParamsSchema.mode.type, 'select');
    check('select: trialParams.mode schema.options[0].value type',
        typeof trialParamsSchema.mode.options[0].value, 'number');

    const setColorDepthSchema = getV3CommandParams(exp, 'controller', null, 'setColorDepth');
    check('select: setColorDepth.gs_val schema.type', setColorDepthSchema.gs_val.type, 'select');
    check('select: setColorDepth.gs_val schema.options[0].value type',
        typeof setColorDepthSchema.gs_val.options[0].value, 'number');

    const logSchema = getV3CommandParams(exp, 'plugin', 'log', 'log');
    check('select: log.level schema.type', logSchema.level.type, 'select');
    check('select: log.level schema.options[0].value type',
        typeof logSchema.level.options[0].value, 'string');

    // 3. docSet with the right type preserves it through round-trip
    docSet(exp, ['conditions', 0, 'commands', 0, 'mode'], 4);
    docSet(exp, ['conditions', 0, 'commands', 1, 'gs_val'], 2);
    docSet(exp, ['conditions', 0, 'commands', 2, 'params', 'level'], 'WARNING');

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    const r = reparsed.conditions[0].commands;
    check('select: round-trip mode stays number', typeof r[0].mode, 'number');
    check('select: round-trip mode value', r[0].mode, 4);
    check('select: round-trip gs_val stays number', typeof r[1].gs_val, 'number');
    check('select: round-trip gs_val value', r[1].gs_val, 2);
    check('select: round-trip level stays string', typeof r[2].params.level, 'string');
    check('select: round-trip level value', r[2].params.level, 'WARNING');

    // 4. The exported YAML should NOT quote the numeric selects
    const regen = generateV3Protocol(exp);
    checkTrue(
        'select: regen YAML has unquoted numeric mode',
        /mode:\s*4\b/.test(regen)
    );
    checkTrue(
        'select: regen YAML has unquoted numeric gs_val',
        /gs_val:\s*2\b/.test(regen)
    );
}

// ─── Test Suite 13: docMoveCommand throws on doc/model divergence ──────────
console.log('\n--- Suite 13: docMoveCommand doc/model divergence is loud ---');

{
    // Synthesize divergence: parse normally, then nuke the commands node from
    // the YAML.Document while leaving the JS model intact. docMoveCommand
    // should surface this as a thrown error, not a silent no-op.
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const condIdx = exp.conditions.findIndex((c) => c.name === 'arena check');
    const condNode = exp._doc.getIn(['conditions', condIdx], true);
    // Delete the commands key from the YAML.Document only
    condNode.delete('commands');

    let threw = false;
    let code = null;
    try {
        docMoveCommand(exp, condIdx, 0, 1);
    } catch (e) {
        threw = true;
        code = e.code;
    }
    checkTrue('divergence: docMoveCommand throws', threw);
    check('divergence: error code is DOC_MODEL_DIVERGENCE', code, 'DOC_MODEL_DIVERGENCE');
}

// ─── Test Suite 14: docSetPluginCommandHead ────────────────────────────────
console.log('\n--- Suite 14: docSetPluginCommandHead (plugin/command rename) ---');

function makePluginExp() {
    return parseV3Protocol(
        [
            'version: 3',
            'experiment_info: {name: x}',
            'rig: "/tmp/r.yaml"',
            'plugins:',
            '  - name: backlight',
            '    type: class',
            '    matlab: {class: LEDControllerPlugin}',
            '  - name: camera',
            '    type: class',
            '    matlab: {class: BiasPlugin}',
            'experiment: [setup]',
            'conditions:',
            '  - name: setup',
            '    commands:',
            '      - type: plugin',
            '        plugin_name: backlight',
            '        command_name: setRedLEDPower',
            '        params:',
            '          power: 5',
            '          panel_num: 2',
            '          pattern: "1010"'
        ].join('\n') + '\n'
    );
}

{
    // Change command_name only — params preserved (same plugin, same params schema)
    const exp = makePluginExp();
    docSetPluginCommandHead(exp, 0, 0, {
        plugin_name: 'backlight',
        command_name: 'setBlueLEDPower',
        params: { power: 5, panel_num: 2, pattern: '1010' }
    });
    const cmd = exp.conditions[0].commands[0];
    check('head: command_name updated', cmd.command_name, 'setBlueLEDPower');
    check('head: plugin_name preserved', cmd.plugin_name, 'backlight');
    check('head: power kept', cmd.params.power, 5);
    check('head: panel_num kept', cmd.params.panel_num, 2);
    check('head: pattern kept', cmd.params.pattern, '1010');

    // Round-trip
    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    const r = reparsed.conditions[0].commands[0];
    check('head: round-trip command_name', r.command_name, 'setBlueLEDPower');
    check('head: round-trip params.power', r.params.power, 5);
}

{
    // Change command_name to one with a different param shape — caller-side
    // reconciliation drops stale params. (Helper trusts the caller's params.)
    const exp = makePluginExp();
    docSetPluginCommandHead(exp, 0, 0, {
        plugin_name: 'backlight',
        command_name: 'turnOffLED',
        params: {} // caller reconciled away the LED-power params
    });
    const cmd = exp.conditions[0].commands[0];
    check('head: command_name changed', cmd.command_name, 'turnOffLED');
    checkTrue('head: empty params dropped from JS model', !cmd.params);

    const regen = generateV3Protocol(exp);
    checkTrue('head: empty params not in regen YAML', !regen.includes('params:'));
}

{
    // Change plugin_name to a different plugin
    const exp = makePluginExp();
    docSetPluginCommandHead(exp, 0, 0, {
        plugin_name: 'camera',
        command_name: 'startRecording',
        params: { filename: 'trial_001.avi' }
    });
    const cmd = exp.conditions[0].commands[0];
    check('head: plugin switched', cmd.plugin_name, 'camera');
    check('head: command switched', cmd.command_name, 'startRecording');
    check('head: new params populated', cmd.params.filename, 'trial_001.avi');
}

{
    // Reject non-plugin command target
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    // Pick a condition whose first command is NOT a plugin
    const condIdx = exp.conditions.findIndex(c => c.commands[0] && c.commands[0].type !== 'plugin');
    checkTrue('head: found non-plugin command for reject test', condIdx >= 0);
    checkThrows(
        'head: rejects non-plugin target',
        () => docSetPluginCommandHead(exp, condIdx, 0, {
            plugin_name: 'backlight',
            command_name: 'setRedLEDPower'
        }),
        'INVALID_INPUT'
    );
}

// ─── Test Suite 15: docAddPluginParam ──────────────────────────────────────
console.log('\n--- Suite 15: docAddPluginParam (create params: if absent) ---');

{
    // Build a plugin command with NO params, then add one
    const exp = parseV3Protocol(
        [
            'version: 3',
            'experiment_info: {name: x}',
            'rig: "/tmp/r.yaml"',
            'plugins:',
            '  - name: backlight',
            '    type: class',
            '    matlab: {class: LEDControllerPlugin}',
            'experiment: [setup]',
            'conditions:',
            '  - name: setup',
            '    commands:',
            '      - {type: plugin, plugin_name: backlight, command_name: turnOffLED}'
        ].join('\n') + '\n'
    );
    const cmd0 = exp.conditions[0].commands[0];
    checkTrue('add: starts with no params', !cmd0.params);

    docAddPluginParam(exp, 0, 0, 'foo', 42);
    check('add: first param sets type number', cmd0.params.foo, 42);
    check('add: cmd.params exists', typeof cmd0.params, 'object');

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    check('add: round-trip foo', reparsed.conditions[0].commands[0].params.foo, 42);
}

{
    // Add to an existing params map
    const exp = makePluginExp();
    docAddPluginParam(exp, 0, 0, 'extra_field', 'hello');
    const cmd = exp.conditions[0].commands[0];
    check('add: existing params preserved', cmd.params.power, 5);
    check('add: new param added', cmd.params.extra_field, 'hello');

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    check('add: round-trip new param', reparsed.conditions[0].commands[0].params.extra_field, 'hello');
}

// ─── Test Suite 16: docDeletePluginParam ───────────────────────────────────
console.log('\n--- Suite 16: docDeletePluginParam (params: removed when empty) ---');

{
    // Delete one of many — params: stays
    const exp = makePluginExp();
    docDeletePluginParam(exp, 0, 0, 'panel_num');
    const cmd = exp.conditions[0].commands[0];
    checkTrue('del: panel_num gone', !('panel_num' in (cmd.params || {})));
    check('del: power still present', cmd.params.power, 5);
    check('del: pattern still present', cmd.params.pattern, '1010');

    const regen = generateV3Protocol(exp);
    checkTrue('del: panel_num removed from YAML', !regen.includes('panel_num'));
    checkTrue('del: params: still present', regen.includes('params:'));
}

{
    // Delete the LAST param → params: map removed entirely
    const exp = parseV3Protocol(
        [
            'version: 3',
            'experiment_info: {name: x}',
            'rig: "/tmp/r.yaml"',
            'plugins:',
            '  - name: backlight',
            '    type: class',
            '    matlab: {class: LEDControllerPlugin}',
            'experiment: [setup]',
            'conditions:',
            '  - name: setup',
            '    commands:',
            '      - type: plugin',
            '        plugin_name: backlight',
            '        command_name: setRedLEDPower',
            '        params:',
            '          power: 5'
        ].join('\n') + '\n'
    );
    docDeletePluginParam(exp, 0, 0, 'power');
    const cmd = exp.conditions[0].commands[0];
    checkTrue('del-last: cmd.params removed', !cmd.params);

    const regen = generateV3Protocol(exp);
    checkTrue('del-last: params: removed from regen YAML', !regen.includes('params:'));
    // Command itself still present
    checkTrue('del-last: command still present', regen.includes('setRedLEDPower'));

    const reparsed = parseV3Protocol(regen);
    checkTrue('del-last: reparse — no params', !reparsed.conditions[0].commands[0].params);
}

{
    // Reject non-plugin command
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const condIdx = exp.conditions.findIndex(c => c.commands[0] && c.commands[0].type !== 'plugin');
    checkThrows(
        'del: rejects non-plugin target',
        () => docDeletePluginParam(exp, condIdx, 0, 'foo'),
        'INVALID_INPUT'
    );
    checkThrows(
        'add: rejects non-plugin target',
        () => docAddPluginParam(exp, condIdx, 0, 'foo', 1),
        'INVALID_INPUT'
    );
}

// ─── Test Suite 17: collectExportWarnings ──────────────────────────────────
console.log('\n--- Suite 17: collectExportWarnings (soft-warn gate) ---');

{
    // Canonical_a has anchors and references — should produce no warnings.
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const { warnings, totalCount } = collectExportWarnings(exp);
    check('warn: clean fixture has 0 warnings', totalCount, 0);
    check('warn: warnings array empty', warnings.length, 0);
}

{
    // Add an unused condition by inserting one with no sequence reference.
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    docInsertCondition(exp, 'orphan', [{ type: 'wait', duration: 1 }]);
    const { warnings } = collectExportWarnings(exp);
    const orphanWarn = warnings.find(w => w.kind === 'unused-condition' && w.name === 'orphan');
    checkTrue('warn: unused-condition detected', !!orphanWarn);
    checkTrue('warn: orphan message mentions name', orphanWarn.message.includes('orphan'));
}

{
    // Build a YAML with an unreferenced anchor in variables:
    const yaml = [
        'version: 3',
        'experiment_info: {name: x}',
        'rig: "/tmp/r.yaml"',
        'variables:',
        '  used_anchor: &used 5',
        '  dangling_anchor: &dangling 99',
        'experiment: [foo]',
        'conditions:',
        '  - name: foo',
        '    commands:',
        '      - type: wait',
        '        duration: *used'
    ].join('\n') + '\n';
    const exp = parseV3Protocol(yaml);
    const { warnings } = collectExportWarnings(exp);
    const danglingWarn = warnings.find(w => w.kind === 'unused-anchor' && w.name === 'dangling');
    checkTrue('warn: unused-anchor detected', !!danglingWarn);
    const usedWarn = warnings.find(w => w.kind === 'unused-anchor' && w.name === 'used');
    checkTrue('warn: referenced anchor NOT flagged', !usedWarn);
}

{
    // Plugin used but not declared in plugins:
    const yaml = [
        'version: 3',
        'experiment_info: {name: x}',
        'rig: "/tmp/r.yaml"',
        'plugins: []',
        'experiment: [foo]',
        'conditions:',
        '  - name: foo',
        '    commands:',
        '      - {type: plugin, plugin_name: ghost, command_name: ping}'
    ].join('\n') + '\n';
    const exp = parseV3Protocol(yaml);
    const { warnings } = collectExportWarnings(exp);
    const ghost = warnings.find(w => w.kind === 'undeclared-plugin' && w.name === 'ghost');
    checkTrue('warn: undeclared-plugin detected', !!ghost);

    // log plugin is built-in and should NEVER warn even when undeclared
    const yaml2 = yaml.replace('ghost', 'log').replace('ping', 'log');
    const exp2 = parseV3Protocol(yaml2);
    const w2 = collectExportWarnings(exp2).warnings;
    checkTrue('warn: log plugin never flagged', !w2.find(w => w.kind === 'undeclared-plugin'));
}

{
    // Raw command card → informational warning
    const yaml = [
        'version: 3',
        'experiment_info: {name: x}',
        'rig: "/tmp/r.yaml"',
        'experiment: [foo]',
        'conditions:',
        '  - name: foo',
        '    commands:',
        '      - {type: "loop", count: 5}'
    ].join('\n') + '\n';
    const exp = parseV3Protocol(yaml);
    const { warnings } = collectExportWarnings(exp);
    const rawWarn = warnings.find(w => w.kind === 'raw-command' && w.name === 'loop');
    checkTrue('warn: raw-command detected', !!rawWarn);
}

// ─── Test Suite 18: docInsertCondition ─────────────────────────────────────
console.log('\n--- Suite 18: docInsertCondition (library add) ---');

{
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const before = exp.conditions.length;
    docInsertCondition(exp, 'new_cond', [{ type: 'wait', duration: 2 }]);
    check('insert-cond: JS conditions grew by 1', exp.conditions.length, before + 1);
    check('insert-cond: name set', exp.conditions[before].name, 'new_cond');
    check('insert-cond: commands set', exp.conditions[before].commands[0].duration, 2);

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    check('insert-cond: round-trip length', reparsed.conditions.length, before + 1);
    check('insert-cond: round-trip name', reparsed.conditions[before].name, 'new_cond');
}

checkThrows(
    'insert-cond: rejects duplicate name',
    () => {
        const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
        docInsertCondition(exp, exp.conditions[0].name, [{ type: 'wait', duration: 1 }]);
    },
    'DUPLICATE_NAME'
);

checkThrows(
    'insert-cond: rejects empty commands',
    () => {
        const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
        docInsertCondition(exp, 'x', []);
    },
    'INVALID_INPUT'
);

// ─── Test Suite 19: docCloneCondition (anchor preservation) ────────────────
console.log('\n--- Suite 19: docCloneCondition (preserves aliases) ---');

{
    // canonical_a has condition "arena check" with a wait using *dur_short.
    // After clone, the duplicate must still have the *dur_short alias node,
    // not the resolved literal — otherwise edits to dur_short won't propagate.
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const srcIdx = exp.conditions.findIndex(c => c.name === 'arena check');
    checkTrue('clone: arena check source found', srcIdx >= 0);

    docCloneCondition(exp, srcIdx, 'arena check copy');
    const dupIdx = exp.conditions.findIndex(c => c.name === 'arena check copy');
    checkTrue('clone: duplicate present in JS model', dupIdx >= 0);

    // Find the wait command in the duplicate
    const dupCmds = exp.conditions[dupIdx].commands;
    const dupWaitIdx = dupCmds.findIndex(c => c.type === 'wait');
    checkTrue('clone: wait command in duplicate', dupWaitIdx >= 0);

    // The YAML node for the cloned wait's duration must still be an Alias
    const aliasName = aliasNameAt(exp, ['conditions', dupIdx, 'commands', dupWaitIdx, 'duration']);
    check('clone: cloned wait.duration is still *dur_short alias', aliasName, 'dur_short');

    // Round-trip exports the cloned condition with the alias preserved
    const regen = generateV3Protocol(exp);
    checkTrue('clone: regen YAML contains arena check copy', regen.includes('arena check copy'));
    // The alias name should appear at least 2x (original + clone)
    const aliasOccurrences = (regen.match(/\*dur_short/g) || []).length;
    checkTrue(
        'clone: *dur_short alias appears in regen at least twice',
        aliasOccurrences >= 2,
        'occurrences=' + aliasOccurrences
    );
}

checkThrows(
    'clone: rejects duplicate name',
    () => {
        const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
        docCloneCondition(exp, 0, exp.conditions[0].name);
    },
    'DUPLICATE_NAME'
);

// ─── Test Suite 20: docAppendSequenceEntry ─────────────────────────────────
console.log('\n--- Suite 20: docAppendSequenceEntry (ref + block append) ---');

{
    // Append a bare ref — fixture has 4 entries, should grow to 5.
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const before = exp.sequence.length;
    docInsertCondition(exp, 'tail', [{ type: 'wait', duration: 1 }]);
    docAppendSequenceEntry(exp, { kind: 'ref', condition_name: 'tail' });
    check('seq-append: length grew by 1', exp.sequence.length, before + 1);
    check('seq-append: last is ref', exp.sequence[before].kind, 'ref');
    check('seq-append: last condition_name', exp.sequence[before].condition_name, 'tail');

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    check('seq-append: round-trip last is "tail"', reparsed.sequence[before].condition_name, 'tail');
}

{
    // Append a block entry
    const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
    const before = exp.sequence.length;
    docAppendSequenceEntry(exp, {
        kind: 'block',
        name: 'extras',
        trials: ['arena check'],
        repetitions: 2
    });
    check('seq-append-block: length grew', exp.sequence.length, before + 1);
    check('seq-append-block: kind block', exp.sequence[before].kind, 'block');
    check('seq-append-block: reps', exp.sequence[before].repetitions, 2);
    check('seq-append-block: name', exp.sequence[before].name, 'extras');
}

checkThrows(
    'seq-append: rejects bad kind',
    () => {
        const exp = parseV3Protocol(readFixture('v3_canonical_a.yaml'));
        docAppendSequenceEntry(exp, { kind: 'bogus' });
    },
    'INVALID_INPUT'
);

// ─── Test Suite 21: BLANK_TEMPLATE skeleton ────────────────────────────────
console.log('\n--- Suite 21: BLANK_TEMPLATE skeleton parses + round-trips ---');

{
    // This mirrors the BLANK_TEMPLATE const in experiment_designer_v3.html.
    // If the template changes there, update here so this test stays in sync.
    const BLANK = [
        'version: 3',
        'experiment_info:',
        '  name: "New Experiment"',
        '  author: ""',
        'rig: "./configs/rigs/your_rig.yaml"',
        'plugins: []',
        'experiment:',
        '  - "setup"',
        'conditions:',
        '  - name: "setup"',
        '    commands:',
        '      - type: "wait"',
        '        duration: 1',
        ''
    ].join('\n');

    const exp = parseV3Protocol(BLANK);
    check('blank: version', exp.version, 3);
    check('blank: experiment_info.name', exp.experiment_info.name, 'New Experiment');
    check('blank: rig_path', exp.rig_path, './configs/rigs/your_rig.yaml');
    check('blank: 0 plugins', exp.plugins.length, 0);
    check('blank: 1 condition', exp.conditions.length, 1);
    check('blank: 1 sequence entry', exp.sequence.length, 1);
    check('blank: sequence is bare ref', exp.sequence[0].kind, 'ref');
    check('blank: ref points to setup', exp.sequence[0].condition_name, 'setup');

    const refs = validateReferences(exp);
    checkTrue('blank: references resolve', refs.ok, refs.errors.join('; '));

    const reparsed = parseV3Protocol(generateV3Protocol(exp));
    check('blank: round-trip stable', reparsed.conditions.length, 1);
}

// ─── Results ────────────────────────────────────────────────────────────────
console.log('\n=== Results: ' + passedTests + '/' + totalTests + ' passed ===');
if (failedTests.length > 0) {
    console.log('\nFailed tests:');
    for (const t of failedTests) console.log('  - ' + t);
    process.exit(1);
}
process.exit(0);
