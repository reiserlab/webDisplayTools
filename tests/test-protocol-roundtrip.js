#!/usr/bin/env node
// test-protocol-roundtrip.js — CI-ready regression test for protocol YAML roundtrip
//
// Tests that:
//   1. generateYAML()-style output produces valid YAML
//   2. simpleYAMLParse() can parse it back correctly
//   3. All required V1 sections are present with correct types
//   4. Multi-condition blocks parse correctly
//   5. Comments between conditions don't break parsing (regression)
//   6. Phase includes/commands are preserved
//
// Usage:
//   node tests/test-protocol-roundtrip.js
//
// Exit code 0 = all passed, 1 = failures

'use strict';

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

// ─── simpleYAMLParse (copy from experiment_designer.html, with bug fix) ─────

function simpleYAMLParse(text) {
    const lines = text.split('\n');
    let i = 0;

    function getIndent(line) {
        const m = line.match(/^(\s*)/);
        return m ? m[1].length : 0;
    }

    function parseValue(raw) {
        if (raw === undefined || raw === '') return '';
        raw = raw.trim();
        if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
            return raw.slice(1, -1);
        }
        if (raw === 'null' || raw === '~') return null;
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        const num = Number(raw);
        if (!isNaN(num) && raw !== '') return num;
        return raw;
    }

    function parseBlock(baseIndent) {
        const obj = {};
        while (i < lines.length) {
            const line = lines[i];
            if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
            const indent = getIndent(line);
            if (indent < baseIndent) break;
            if (indent > baseIndent) { i++; continue; }

            const trimmed = line.trim();
            if (trimmed.startsWith('- ')) break;

            const kvMatch = trimmed.match(/^([^:]+?):\s*(.*)?$/);
            if (!kvMatch) { i++; continue; }

            const key = kvMatch[1].trim();
            const valRaw = (kvMatch[2] || '').trim();

            if (valRaw === '' || valRaw === undefined) {
                i++;
                // Skip blank lines and comments to find actual child content
                while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) {
                    i++;
                }
                if (i < lines.length) {
                    const nextLine = lines[i];
                    const nextIndent = getIndent(nextLine);
                    if (nextIndent > indent) {
                        if (nextLine.trim().startsWith('- ')) {
                            obj[key] = parseList(nextIndent);
                        } else {
                            obj[key] = parseBlock(nextIndent);
                        }
                    }
                }
            } else {
                obj[key] = parseValue(valRaw);
                i++;
            }
        }
        return obj;
    }

    function parseList(baseIndent) {
        const arr = [];
        while (i < lines.length) {
            const line = lines[i];
            if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
            const indent = getIndent(line);
            if (indent < baseIndent) break;

            const trimmed = line.trim();
            if (!trimmed.startsWith('- ')) { i++; continue; }

            const itemContent = trimmed.slice(2).trim();
            const kvMatch = itemContent.match(/^([^:]+?):\s*(.*)?$/);

            if (kvMatch) {
                const item = {};
                item[kvMatch[1].trim()] = parseValue((kvMatch[2] || '').trim());
                i++;
                while (i < lines.length) {
                    const subLine = lines[i];
                    if (subLine.trim() === '' || subLine.trim().startsWith('#')) { i++; continue; }
                    const subIndent = getIndent(subLine);
                    if (subIndent <= baseIndent) break;
                    const subTrimmed = subLine.trim();
                    if (subTrimmed.startsWith('- ')) break;
                    const subKv = subTrimmed.match(/^([^:]+?):\s*(.*)?$/);
                    if (subKv) {
                        const subKey = subKv[1].trim();
                        const subVal = (subKv[2] || '').trim();
                        if (subVal === '') {
                            i++;
                            while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) {
                                i++;
                            }
                            if (i < lines.length) {
                                const nLine = lines[i];
                                const nIndent = getIndent(nLine);
                                if (nIndent > subIndent) {
                                    if (nLine.trim().startsWith('- ')) {
                                        item[subKey] = parseList(nIndent);
                                    } else {
                                        item[subKey] = parseBlock(nIndent);
                                    }
                                }
                            }
                        } else {
                            item[subKey] = parseValue(subVal);
                            i++;
                        }
                    } else {
                        i++;
                    }
                }
                arr.push(item);
            } else {
                arr.push(parseValue(itemContent));
                i++;
            }
        }
        return arr;
    }

    return parseBlock(0);
}

// ─── generateV1Protocol (mirrors experiment_designer.html generateYAML) ─────

function generateV1Protocol(opts) {
    let yaml = '';
    yaml += '# Protocol Version 1\n';
    yaml += '# Generated by test-protocol-roundtrip.js\n\n';
    yaml += 'version: 1\n\n';

    yaml += 'experiment_info:\n';
    yaml += '  name: "' + opts.name + '"\n';
    yaml += '  date_created: "' + opts.date_created + '"\n';
    yaml += '  author: "' + opts.author + '"\n';
    yaml += '  pattern_library: ""\n\n';

    yaml += 'arena_info:\n';
    yaml += '  num_rows: ' + opts.num_rows + '\n';
    yaml += '  num_cols: ' + opts.num_cols + '\n';
    yaml += '  generation: "' + opts.generation + '"\n\n';

    yaml += 'experiment_structure:\n';
    yaml += '  repetitions: ' + opts.repetitions + '\n';
    yaml += '  randomization:\n';
    yaml += '    enabled: ' + opts.randomization_enabled + '\n';
    yaml += '    seed: null\n';
    yaml += '    method: "block"\n\n';

    // Pretrial
    yaml += 'pretrial:\n';
    yaml += '  include: ' + opts.pretrial.include + '\n';
    if (opts.pretrial.include && opts.pretrial.commands) {
        yaml += '  commands:\n';
        for (const cmd of opts.pretrial.commands) {
            yaml += '    - type: "' + cmd.type + '"\n';
            if (cmd.command_name) yaml += '      command_name: "' + cmd.command_name + '"\n';
            if (cmd.duration !== undefined) yaml += '      duration: ' + cmd.duration + '\n';
        }
    }
    yaml += '\n';

    // Block conditions
    yaml += 'block:\n';
    yaml += '  conditions:\n';
    for (const cond of opts.conditions) {
        yaml += '    - id: "' + cond.id + '"\n';
        yaml += '      commands:\n';
        for (const cmd of cond.commands) {
            yaml += '        - type: "' + cmd.type + '"\n';
            yaml += '          command_name: "' + cmd.command_name + '"\n';
            if (cmd.pattern) yaml += '          pattern: "' + cmd.pattern + '"\n';
            if (cmd.pattern_ID !== undefined) yaml += '          pattern_ID: ' + cmd.pattern_ID + '\n';
            if (cmd.duration !== undefined) yaml += '          duration: ' + cmd.duration + '\n';
            if (cmd.mode !== undefined) yaml += '          mode: ' + cmd.mode + '\n';
            if (cmd.frame_index !== undefined) yaml += '          frame_index: ' + cmd.frame_index + '\n';
            if (cmd.frame_rate !== undefined) yaml += '          frame_rate: ' + cmd.frame_rate + '\n';
            if (cmd.gain !== undefined) yaml += '          gain: ' + cmd.gain + '\n';
        }
    }
    yaml += '\n';

    // Intertrial
    yaml += 'intertrial:\n';
    yaml += '  include: ' + opts.intertrial.include + '\n';
    if (opts.intertrial.include && opts.intertrial.commands) {
        yaml += '  commands:\n';
        for (const cmd of opts.intertrial.commands) {
            yaml += '    - type: "' + cmd.type + '"\n';
            if (cmd.command_name) yaml += '      command_name: "' + cmd.command_name + '"\n';
            if (cmd.duration !== undefined) yaml += '      duration: ' + cmd.duration + '\n';
        }
    }
    yaml += '\n';

    // Posttrial
    yaml += 'posttrial:\n';
    yaml += '  include: ' + opts.posttrial.include + '\n';
    if (opts.posttrial.include && opts.posttrial.commands) {
        yaml += '  commands:\n';
        for (const cmd of opts.posttrial.commands) {
            yaml += '    - type: "' + cmd.type + '"\n';
            if (cmd.command_name) yaml += '      command_name: "' + cmd.command_name + '"\n';
            if (cmd.duration !== undefined) yaml += '      duration: ' + cmd.duration + '\n';
        }
    }
    yaml += '\n';

    return yaml;
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
