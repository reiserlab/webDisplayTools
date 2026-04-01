#!/usr/bin/env node
// test-protocol-roundtrip.js — CI-ready regression test for protocol YAML roundtrip
//
// Tests that:
//   1. generateV1Protocol() output produces valid YAML
//   2. simpleYAMLParse() can parse it back correctly
//   3. All required V1 sections are present with correct types
//   4. Multi-condition blocks parse correctly
//   5. Comments between conditions don't break parsing (regression)
//   6. Phase includes/commands are preserved
//   7. V2 YAML files with plugins and nested params parse correctly
//
// Usage:
//   node tests/test-protocol-roundtrip.js
//
// Exit code 0 = all passed, 1 = failures

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Import shared modules ──────────────────────────────────────────────────

const { simpleYAMLParse, generateV1Protocol } = require('../js/protocol-yaml.js');

// ─── Counters ────────────────────────────────────────────────────────────────

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

function checkType(label, value, expectedType) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType === expectedType) {
        pass(label, actualType);
    } else {
        fail(label, 'got ' + actualType + ', expected ' + expectedType);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════════════

console.log('=== Protocol YAML Roundtrip Tests ===\n');

// ─── Test Suite 1: Basic V1 generate → parse roundtrip ──────────────────────

console.log('--- Suite 1: V1 Generate → Parse Roundtrip ---');

const testProtocol = {
    name: 'Roundtrip Test',
    date_created: '2026-01-01',
    author: 'Test Suite',
    num_rows: 2,
    num_cols: 12,
    generation: 'G4.1',
    repetitions: 1,
    randomization_enabled: false,
    pretrial: {
        include: true,
        commands: [
            { type: 'controller', command_name: 'allOn' },
            { type: 'wait', duration: 1 },
            { type: 'controller', command_name: 'allOff' },
            { type: 'wait', duration: 0.5 },
        ]
    },
    conditions: [
        {
            id: 'cond_1',
            commands: [{
                type: 'controller', command_name: 'startG41Trial',
                pattern: 'pat0001.pat', pattern_ID: 1,
                duration: 5, mode: 2, frame_index: 1, frame_rate: 60, gain: 0
            }]
        },
        {
            id: 'cond_2',
            commands: [{
                type: 'controller', command_name: 'startG41Trial',
                pattern: 'pat0002.pat', pattern_ID: 2,
                duration: 10, mode: 2, frame_index: 1, frame_rate: 10, gain: 0
            }]
        },
    ],
    intertrial: {
        include: true,
        commands: [
            { type: 'controller', command_name: 'allOff' },
            { type: 'wait', duration: 2 },
        ]
    },
    posttrial: {
        include: true,
        commands: [
            { type: 'controller', command_name: 'allOff' },
            { type: 'wait', duration: 1 },
        ]
    }
};

const yaml1 = generateV1Protocol(testProtocol);
const parsed1 = simpleYAMLParse(yaml1);

// Required top-level sections
check('version', parsed1.version, 1);
checkType('experiment_info is object', parsed1.experiment_info, 'object');
checkType('arena_info is object', parsed1.arena_info, 'object');
checkType('experiment_structure is object', parsed1.experiment_structure, 'object');
checkType('block is object', parsed1.block, 'object');
checkType('pretrial is object', parsed1.pretrial, 'object');
checkType('intertrial is object', parsed1.intertrial, 'object');
checkType('posttrial is object', parsed1.posttrial, 'object');

// Metadata roundtrip
check('experiment_info.name', parsed1.experiment_info.name, 'Roundtrip Test');
check('experiment_info.author', parsed1.experiment_info.author, 'Test Suite');
check('arena_info.num_rows', parsed1.arena_info.num_rows, 2);
check('arena_info.num_cols', parsed1.arena_info.num_cols, 12);
check('arena_info.generation', parsed1.arena_info.generation, 'G4.1');
check('experiment_structure.repetitions', parsed1.experiment_structure.repetitions, 1);
check('randomization.enabled', parsed1.experiment_structure.randomization.enabled, false);

// Conditions
const conds1 = parsed1.block.conditions;
checkType('block.conditions is array', conds1, 'array');
check('num_conditions', conds1.length, 2);
check('condition[0].id', conds1[0].id, 'cond_1');
check('condition[1].id', conds1[1].id, 'cond_2');

// Condition commands
checkType('condition[0].commands is array', conds1[0].commands, 'array');
check('condition[0].commands[0].pattern', conds1[0].commands[0].pattern, 'pat0001.pat');
check('condition[0].commands[0].duration', conds1[0].commands[0].duration, 5);
check('condition[0].commands[0].frame_rate', conds1[0].commands[0].frame_rate, 60);
check('condition[0].commands[0].mode', conds1[0].commands[0].mode, 2);
check('condition[0].commands[0].gain', conds1[0].commands[0].gain, 0);
check('condition[1].commands[0].duration', conds1[1].commands[0].duration, 10);
check('condition[1].commands[0].frame_rate', conds1[1].commands[0].frame_rate, 10);

// Phase includes
check('pretrial.include', parsed1.pretrial.include, true);
check('intertrial.include', parsed1.intertrial.include, true);
check('posttrial.include', parsed1.posttrial.include, true);

// Pretrial commands
checkType('pretrial.commands is array', parsed1.pretrial.commands, 'array');
check('pretrial.commands.length', parsed1.pretrial.commands.length, 4);
check('pretrial.commands[0].command_name', parsed1.pretrial.commands[0].command_name, 'allOn');

// ─── Test Suite 2: Comment-handling regression ──────────────────────────────

console.log('\n--- Suite 2: Comment-Handling Regression ---');

const commentYaml = `
version: 1

experiment_info:
  name: "Comment Test"

arena_info:
  num_rows: 2
  num_cols: 12
  generation: "G4.1"

experiment_structure:
  repetitions: 1
  randomization:
    enabled: false
    seed: null
    method: "block"

pretrial:
  include: false

block:
  conditions:
    # --- GROUP A ---

    - id: "cond_a1"
      commands:
        - type: "controller"
          command_name: "allOn"

    # --- GROUP B ---

    - id: "cond_b1"
      commands:
        - type: "controller"
          command_name: "allOff"

    - id: "cond_b2"
      commands:
        - type: "controller"
          command_name: "allOn"

intertrial:
  include: false

posttrial:
  include: false
`;

const parsed2 = simpleYAMLParse(commentYaml);
const conds2 = parsed2.block && parsed2.block.conditions;

checkType('block.conditions is array (with comments)', conds2, 'array');
if (Array.isArray(conds2)) {
    check('num_conditions (with comments)', conds2.length, 3);
    check('cond[0].id after # comment', conds2[0] && conds2[0].id, 'cond_a1');
    check('cond[1].id after # comment + blank', conds2[1] && conds2[1].id, 'cond_b1');
    check('cond[2].id (no comment before)', conds2[2] && conds2[2].id, 'cond_b2');
}

// ─── Test Suite 3: Excluded phases ──────────────────────────────────────────

console.log('\n--- Suite 3: Excluded Phases ---');

check('excluded pretrial.include', parsed2.pretrial.include, false);
check('excluded intertrial.include', parsed2.intertrial.include, false);
check('excluded posttrial.include', parsed2.posttrial.include, false);

// ─── Test Suite 4: Numeric type preservation ────────────────────────────────

console.log('\n--- Suite 4: Numeric Type Preservation ---');

const numericYaml = `
version: 1
experiment_info:
  name: "Numeric Test"
arena_info:
  num_rows: 4
  num_cols: 12
  generation: "G4.1"
experiment_structure:
  repetitions: 3
  randomization:
    enabled: true
    seed: 42
    method: "block"
block:
  conditions:
    - id: "test"
      commands:
        - type: "controller"
          command_name: "startG41Trial"
          pattern: "test.pat"
          pattern_ID: 1
          duration: 10.5
          mode: 2
          frame_index: 1
          frame_rate: 120
          gain: 0
pretrial:
  include: false
intertrial:
  include: false
posttrial:
  include: false
`;

const parsed3 = simpleYAMLParse(numericYaml);
check('integer: num_rows', parsed3.arena_info.num_rows, 4);
check('integer: repetitions', parsed3.experiment_structure.repetitions, 3);
check('boolean: randomization.enabled', parsed3.experiment_structure.randomization.enabled, true);
check('integer: seed', parsed3.experiment_structure.randomization.seed, 42);
check('float: duration', parsed3.block.conditions[0].commands[0].duration, 10.5);
check('integer: frame_rate', parsed3.block.conditions[0].commands[0].frame_rate, 120);

// ─── Test Suite 5: Real-world YAML with inline comments ─────────────────────

console.log('\n--- Suite 5: Inline Comments in YAML ---');

const inlineCommentYaml = `
version: 1
experiment_info:
  name: "Inline Comment Test"
arena_info:
  num_rows: 2
  num_cols: 12
  generation: "G4.1"
experiment_structure:
  repetitions: 1
  randomization:
    enabled: false
    seed: null
    method: "block"
block:
  conditions:
    - id: "cond_1"
      commands:
        - type: "controller"
          command_name: "startG41Trial"
          pattern: "pat0001.pat"
          pattern_ID: 1
          duration: 5
          mode: 2
          frame_index: 1
          frame_rate: 30
          gain: 0
pretrial:
  include: false
intertrial:
  include: false
posttrial:
  include: false
`;

const parsed4 = simpleYAMLParse(inlineCommentYaml);
check('single condition parses', parsed4.block.conditions.length, 1);
check('single condition id', parsed4.block.conditions[0].id, 'cond_1');

// ─── Test Suite 6: V2 simple backlight test ────────────────────────────────

console.log('\n--- Suite 6: V2 Simple Backlight ---');

const fixturesDir = path.join(__dirname, 'fixtures');
if (fs.existsSync(path.join(fixturesDir, 'v2_simple_backlight_test.yaml'))) {
    const blYaml = fs.readFileSync(path.join(fixturesDir, 'v2_simple_backlight_test.yaml'), 'utf8');
    const bl = simpleYAMLParse(blYaml);

    check('v2_bl: version', bl.version, 2);
    checkType('v2_bl: plugins is array', bl.plugins, 'array');
    check('v2_bl: plugins.length', bl.plugins.length, 1);
    check('v2_bl: plugin name', bl.plugins[0].name, 'backlight');
    check('v2_bl: plugin type', bl.plugins[0].type, 'class');
    checkType('v2_bl: plugin.matlab is object', bl.plugins[0].matlab, 'object');
    check('v2_bl: plugin.matlab.class', bl.plugins[0].matlab.class, 'LEDControllerPlugin');
    check('v2_bl: rig no inline comment', bl.rig.includes('#'), false);
    check('v2_bl: conditions count', bl.block.conditions.length, 5);
    // Check nested params
    const blCond0 = bl.block.conditions[0];
    check('v2_bl: cond[0].commands.length', blCond0.commands.length, 4);
    const irCmd = blCond0.commands.find(c => c.command_name === 'setIRLEDPower');
    checkType('v2_bl: IR cmd params', irCmd.params, 'object');
    check('v2_bl: IR cmd params.power', irCmd.params.power, 50);
} else {
    console.log('  (skipped — fixtures not found)');
}

// ─── Test Suite 7: V2 full experiment ──────────────────────────────────────

console.log('\n--- Suite 7: V2 Full Experiment ---');

if (fs.existsSync(path.join(fixturesDir, 'v2_full_experiment_test.yaml'))) {
    const fullYaml = fs.readFileSync(path.join(fixturesDir, 'v2_full_experiment_test.yaml'), 'utf8');
    const full = simpleYAMLParse(fullYaml);

    check('v2_full: version', full.version, 2);
    check('v2_full: plugins.length', full.plugins.length, 2);
    check('v2_full: plugin[0].name', full.plugins[0].name, 'camera');
    check('v2_full: plugin[1].name', full.plugins[1].name, 'backlight');
    check('v2_full: conditions count', full.block.conditions.length, 9);
    // First condition has 7 commands
    const c0 = full.block.conditions[0];
    check('v2_full: cond[0].commands.length', c0.commands.length, 7);
    check('v2_full: cond[0].cmd[0].type', c0.commands[0].type, 'plugin');
    check('v2_full: cond[0].cmd[0].plugin_name', c0.commands[0].plugin_name, 'camera');
    check('v2_full: cond[0].cmd[1].type', c0.commands[1].type, 'controller');
    check('v2_full: cond[0].cmd[1].duration', c0.commands[1].duration, 10);
    // Nested params check
    const redCmd = c0.commands.find(c => c.command_name === 'setRedLEDPower');
    checkType('v2_full: redCmd.params', redCmd.params, 'object');
    check('v2_full: redCmd.params.power', redCmd.params.power, 5);
    check('v2_full: redCmd.params.panel_num', redCmd.params.panel_num, 0);
    check('v2_full: redCmd.params.pattern', redCmd.params.pattern, '1010');
    // Pretrial commands
    check('v2_full: pretrial.include', full.pretrial.include, true);
    checkType('v2_full: pretrial.commands', full.pretrial.commands, 'array');
    check('v2_full: pretrial.commands.length', full.pretrial.commands.length, 8);
} else {
    console.log('  (skipped — fixtures not found)');
}

// ─── Test Suite 8: V2 all possible plugins ─────────────────────────────────

console.log('\n--- Suite 8: V2 All Possible Plugins ---');

if (fs.existsSync(path.join(fixturesDir, 'v2_all_possible_plugins.yaml'))) {
    const allYaml = fs.readFileSync(path.join(fixturesDir, 'v2_all_possible_plugins.yaml'), 'utf8');
    const all = simpleYAMLParse(allYaml);

    check('v2_all: version', all.version, 2);
    check('v2_all: plugins.length', all.plugins.length, 5);
    // Serial device plugin
    const serial = all.plugins.find(p => p.type === 'serial_device');
    check('v2_all: serial plugin exists', !!serial, true);
    check('v2_all: serial.name', serial.name, 'background_light');
    checkType('v2_all: serial.commands', serial.commands, 'object');
    check('v2_all: serial.commands.reset', serial.commands.reset, 'RESET');
    // Camera plugin with config
    const cam = all.plugins.find(p => p.name === 'camera');
    checkType('v2_all: camera.config', cam.config, 'object');
    check('v2_all: camera.config.frame_rate', cam.config.frame_rate, 150);
    check('v2_all: camera.config.video_format', cam.config.video_format, 'avi');
    // Script plugin
    const script = all.plugins.find(p => p.type === 'script');
    check('v2_all: script plugin exists', !!script, true);
    check('v2_all: script.name', script.name, 'preprocessing');
    // Conditions
    check('v2_all: conditions count', all.block.conditions.length, 5);
} else {
    console.log('  (skipped — fixtures not found)');
}

// ─── Test Suite 9: V2 Generate → Parse Roundtrip ───────────────────────────

console.log('\n--- Suite 9: V2 Generate → Parse Roundtrip ---');

const { generateV2Protocol } = require('../js/protocol-yaml.js');

const v2Experiment = {
    experiment_info: {
        name: 'V2 Roundtrip Test',
        date_created: '2026-04-01',
        author: 'Test Suite',
        pattern_library: './patterns'
    },
    rig_path: './configs/rigs/test_rig.yaml',
    plugins: [
        { name: 'backlight', type: 'class', matlab: { class: 'LEDControllerPlugin' } },
        { name: 'camera', type: 'class', matlab: { class: 'BiasPlugin' }, config: { frame_rate: 100 } }
    ],
    experiment_structure: {
        repetitions: 2,
        randomization: { enabled: true, seed: 42 }
    },
    pretrial: {
        include: true,
        commands: [
            { type: 'controller', command_name: 'allOn' },
            { type: 'wait', duration: 1 },
            { type: 'plugin', plugin_name: 'backlight', command_name: 'setIRLEDPower', params: { power: 50 } },
            { type: 'plugin', plugin_name: 'camera', command_name: 'startRecording', params: { filename: 'test' } }
        ]
    },
    intertrial: {
        include: true,
        commands: [
            { type: 'controller', command_name: 'allOff' },
            { type: 'wait', duration: 2 }
        ]
    },
    posttrial: {
        include: true,
        commands: [
            { type: 'controller', command_name: 'allOff' },
            { type: 'plugin', plugin_name: 'camera', command_name: 'stopRecording' },
            { type: 'wait', duration: 1 }
        ]
    },
    conditions: [
        {
            id: 'grating_with_backlight',
            commands: [
                { type: 'plugin', plugin_name: 'camera', command_name: 'getTimestamp' },
                { type: 'controller', command_name: 'trialParams', pattern: 'pat01.pat', pattern_ID: 1, duration: 10, mode: 2, frame_index: 1, frame_rate: 10, gain: 0 },
                { type: 'wait', duration: 3 },
                { type: 'plugin', plugin_name: 'backlight', command_name: 'setRedLEDPower', params: { power: 5, panel_num: 0, pattern: '1010' } },
                { type: 'wait', duration: 4 },
                { type: 'plugin', plugin_name: 'backlight', command_name: 'setVisibleBacklightsOff' },
                { type: 'wait', duration: 3 }
            ]
        },
        {
            id: 'closed_loop_test',
            commands: [
                { type: 'controller', command_name: 'trialParams', pattern: 'pat02.pat', pattern_ID: 2, duration: 5, mode: 4, frame_index: 1, frame_rate: 0, gain: -90 },
                { type: 'wait', duration: 5 }
            ]
        }
    ]
};

const v2Yaml = generateV2Protocol(v2Experiment);
const v2Parsed = simpleYAMLParse(v2Yaml);

// Version and top-level
check('v2rt: version', v2Parsed.version, 2);
check('v2rt: rig', v2Parsed.rig, './configs/rigs/test_rig.yaml');
check('v2rt: experiment_info.name', v2Parsed.experiment_info.name, 'V2 Roundtrip Test');
check('v2rt: experiment_info.author', v2Parsed.experiment_info.author, 'Test Suite');

// Plugins roundtrip
checkType('v2rt: plugins is array', v2Parsed.plugins, 'array');
check('v2rt: plugins.length', v2Parsed.plugins.length, 2);
check('v2rt: plugin[0].name', v2Parsed.plugins[0].name, 'backlight');
check('v2rt: plugin[0].matlab.class', v2Parsed.plugins[0].matlab.class, 'LEDControllerPlugin');
check('v2rt: plugin[1].name', v2Parsed.plugins[1].name, 'camera');
check('v2rt: plugin[1].config.frame_rate', v2Parsed.plugins[1].config.frame_rate, 100);

// Experiment structure
check('v2rt: repetitions', v2Parsed.experiment_structure.repetitions, 2);
check('v2rt: randomization.enabled', v2Parsed.experiment_structure.randomization.enabled, true);
check('v2rt: randomization.seed', v2Parsed.experiment_structure.randomization.seed, 42);

// Conditions
check('v2rt: num_conditions', v2Parsed.block.conditions.length, 2);
const rtC0 = v2Parsed.block.conditions[0];
check('v2rt: cond[0].id', rtC0.id, 'grating_with_backlight');
check('v2rt: cond[0].commands.length', rtC0.commands.length, 7);
check('v2rt: cond[0].cmd[0].type', rtC0.commands[0].type, 'plugin');
check('v2rt: cond[0].cmd[0].plugin_name', rtC0.commands[0].plugin_name, 'camera');
check('v2rt: cond[0].cmd[0].command_name', rtC0.commands[0].command_name, 'getTimestamp');
check('v2rt: cond[0].cmd[1].command_name', rtC0.commands[1].command_name, 'trialParams');
check('v2rt: cond[0].cmd[1].duration', rtC0.commands[1].duration, 10);
check('v2rt: cond[0].cmd[1].mode', rtC0.commands[1].mode, 2);
check('v2rt: cond[0].cmd[1].pattern', rtC0.commands[1].pattern, 'pat01.pat');
// Plugin params roundtrip
const rtRedCmd = rtC0.commands.find(c => c.command_name === 'setRedLEDPower');
checkType('v2rt: redCmd.params', rtRedCmd.params, 'object');
check('v2rt: redCmd.params.power', rtRedCmd.params.power, 5);
check('v2rt: redCmd.params.panel_num', rtRedCmd.params.panel_num, 0);
check('v2rt: redCmd.params.pattern', rtRedCmd.params.pattern, '1010');
// Closed-loop condition
const rtC1 = v2Parsed.block.conditions[1];
check('v2rt: cond[1].id', rtC1.id, 'closed_loop_test');
check('v2rt: cond[1].cmd[0].mode', rtC1.commands[0].mode, 4);
check('v2rt: cond[1].cmd[0].gain', rtC1.commands[0].gain, -90);

// Phases
check('v2rt: pretrial.include', v2Parsed.pretrial.include, true);
checkType('v2rt: pretrial.commands', v2Parsed.pretrial.commands, 'array');
check('v2rt: pretrial.commands.length', v2Parsed.pretrial.commands.length, 4);
check('v2rt: pretrial.cmd[2].plugin_name', v2Parsed.pretrial.commands[2].plugin_name, 'backlight');
check('v2rt: pretrial.cmd[2].params.power', v2Parsed.pretrial.commands[2].params.power, 50);
check('v2rt: pretrial.cmd[3].command_name', v2Parsed.pretrial.commands[3].command_name, 'startRecording');
check('v2rt: intertrial.include', v2Parsed.intertrial.include, true);
check('v2rt: intertrial.commands.length', v2Parsed.intertrial.commands.length, 2);
check('v2rt: posttrial.include', v2Parsed.posttrial.include, true);
check('v2rt: posttrial.commands.length', v2Parsed.posttrial.commands.length, 3);

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== Results: ' + passedTests + '/' + totalTests + ' passed ===');
if (failedTests.length > 0) {
    console.log('\x1b[31mFailed tests:\x1b[0m');
    for (const name of failedTests) {
        console.log('  - ' + name);
    }
}
process.exit(failedTests.length > 0 ? 1 : 0);
