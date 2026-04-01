#!/usr/bin/env node
/**
 * Generate Reference Protocol YAML for Web → MATLAB Roundtrip Testing
 *
 * Replicates the generateYAML() logic from experiment_designer.html to
 * produce V1 protocol YAML files, then self-verifies by parsing them back
 * with simpleYAMLParse(). Writes YAML + JSON manifest to output dir.
 *
 * Usage:
 *   node tests/generate-roundtrip-protocol.js --outdir ../../maDisplayTools/tests/web_generated_patterns
 *
 * The generated YAML references existing web-generated .pat files so that
 * MATLAB can run a full dry-run validation including pattern file checks.
 */

const fs = require('fs');
const path = require('path');

// ─── Import shared modules ──────────────────────────────────────────────────

const { simpleYAMLParse, generateV1Protocol, yamlStr, appendCommand } = require('../js/protocol-yaml.js');

// ─── Parse command-line args ────────────────────────────────────────────────

const args = process.argv.slice(2);
let outDir = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--outdir' && args[i + 1]) {
        outDir = path.resolve(args[i + 1]);
    }
}
if (!outDir) {
    console.error('Usage: node generate-roundtrip-protocol.js --outdir <path>');
    process.exit(1);
}

// Ensure output directory exists
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

// ─── Protocol generation wrapper ────────────────────────────────────────────

const { generateV2Protocol } = require('../js/protocol-yaml.js');

/**
 * Generate a protocol YAML string.
 * Delegates to shared module functions.
 */
function generateProtocol(version, options) {
    if (version === 2) {
        return generateV2Protocol(options);
    }
    return generateV1Protocol(options);
}

// ─── Test protocol definitions ──────────────────────────────────────────────

// Use existing web-generated .pat files for realistic protocol
const webPatterns = [
    'web_G41_2x12_gs16_sine_grating_G4.pat',
    'web_G4_4x12_gs16_square_grating_G4.pat',
    'web_G4_4x12_gs2_square_grating_G4.pat',
];

const testProtocol = {
    name: 'Web Roundtrip Test Protocol',
    date_created: '2026-02-28',
    author: 'Roundtrip Test Generator',
    pattern_library: '',
    num_rows: 2,
    num_cols: 12,
    generation: 'G4.1',
    repetitions: 1,
    randomization_enabled: false,
    randomization_seed: null,
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
            id: 'sine_grating_gs16',
            commands: [{
                type: 'controller',
                command_name: 'startG41Trial',
                pattern: webPatterns[0],
                pattern_ID: 1,
                duration: 5,
                mode: 2,
                frame_index: 1,
                frame_rate: 60,
                gain: 0
            }]
        },
        {
            id: 'square_grating_gs16',
            commands: [{
                type: 'controller',
                command_name: 'startG41Trial',
                pattern: webPatterns[1],
                pattern_ID: 2,
                duration: 5,
                mode: 2,
                frame_index: 1,
                frame_rate: 10,
                gain: 0
            }]
        },
        {
            id: 'square_grating_gs2',
            commands: [{
                type: 'controller',
                command_name: 'startG41Trial',
                pattern: webPatterns[2],
                pattern_ID: 3,
                duration: 3,
                mode: 2,
                frame_index: 1,
                frame_rate: 30,
                gain: 0
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

// ─── Generate and self-verify ───────────────────────────────────────────────

console.log('=== Protocol YAML Roundtrip Generator ===\n');

// Generate V1 YAML
const yamlContent = generateProtocol(1, testProtocol);
const yamlFile = path.join(outDir, 'test_protocol_v1.yaml');
fs.writeFileSync(yamlFile, yamlContent);
console.log('Generated: ' + yamlFile);

// Self-verify: parse the YAML back
console.log('\nSelf-verification (simpleYAMLParse):');
const parsed = simpleYAMLParse(yamlContent);

let errors = 0;

function check(label, actual, expected) {
    if (actual !== expected) {
        console.log('  FAIL: ' + label + ' = ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
        errors++;
    } else {
        console.log('  OK: ' + label + ' = ' + JSON.stringify(actual));
    }
}

check('version', parsed.version, 1);
check('experiment_info.name', parsed.experiment_info.name, testProtocol.name);
check('arena_info.num_rows', parsed.arena_info.num_rows, testProtocol.num_rows);
check('arena_info.num_cols', parsed.arena_info.num_cols, testProtocol.num_cols);
check('arena_info.generation', parsed.arena_info.generation, testProtocol.generation);
check('experiment_structure.repetitions', parsed.experiment_structure.repetitions, testProtocol.repetitions);
check('randomization.enabled', parsed.experiment_structure.randomization.enabled, testProtocol.randomization_enabled);

// Verify conditions
const conditions = parsed.block && parsed.block.conditions;
if (!Array.isArray(conditions)) {
    console.log('  FAIL: block.conditions is not an array: ' + typeof conditions);
    errors++;
} else {
    check('block.conditions.length', conditions.length, testProtocol.conditions.length);
    for (let i = 0; i < testProtocol.conditions.length; i++) {
        const expected = testProtocol.conditions[i];
        const actual = conditions[i];
        if (!actual) {
            console.log('  FAIL: condition ' + i + ' is missing');
            errors++;
            continue;
        }
        check('condition[' + i + '].id', actual.id, expected.id);
        if (actual.commands && actual.commands[0]) {
            check('condition[' + i + '].commands[0].pattern', actual.commands[0].pattern, expected.commands[0].pattern);
            check('condition[' + i + '].commands[0].duration', actual.commands[0].duration, expected.commands[0].duration);
            check('condition[' + i + '].commands[0].frame_rate', actual.commands[0].frame_rate, expected.commands[0].frame_rate);
        } else {
            console.log('  FAIL: condition ' + i + ' has no commands');
            errors++;
        }
    }
}

// Verify phases
check('pretrial.include', parsed.pretrial.include, true);
check('intertrial.include', parsed.intertrial.include, true);
check('posttrial.include', parsed.posttrial.include, true);

if (parsed.pretrial.commands) {
    check('pretrial.commands.length', parsed.pretrial.commands.length, 4);
} else {
    console.log('  FAIL: pretrial.commands is missing');
    errors++;
}

// Write manifest for MATLAB validation
const manifest = {
    generator: 'generate-roundtrip-protocol.js',
    generated_at: new Date().toISOString(),
    version: 1,
    protocol_file: 'test_protocol_v1.yaml',
    expected: {
        name: testProtocol.name,
        author: testProtocol.author,
        generation: testProtocol.generation,
        num_rows: testProtocol.num_rows,
        num_cols: testProtocol.num_cols,
        repetitions: testProtocol.repetitions,
        randomization_enabled: testProtocol.randomization_enabled,
        num_conditions: testProtocol.conditions.length,
        conditions: testProtocol.conditions.map(c => ({
            id: c.id,
            pattern: c.commands[0].pattern,
            pattern_ID: c.commands[0].pattern_ID,
            duration: c.commands[0].duration,
            mode: c.commands[0].mode,
            frame_index: c.commands[0].frame_index,
            frame_rate: c.commands[0].frame_rate,
            gain: c.commands[0].gain,
        })),
        pretrial_include: true,
        pretrial_num_commands: 4,
        intertrial_include: true,
        intertrial_num_commands: 2,
        posttrial_include: true,
        posttrial_num_commands: 2,
    }
};

const manifestFile = path.join(outDir, 'test_protocol_manifest.json');
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
console.log('\nManifest: ' + manifestFile);

// ─── Generate V2 Protocol ──────────────────────────────────────────────────

console.log('\n=== V2 Protocol Generation ===\n');

// V2 test protocol with plugins and multi-command conditions
// Rig path is relative to the output directory (maDisplayTools/tests/web_generated_patterns/)
const v2Protocol = {
    experiment_info: {
        name: 'Web Roundtrip Test Protocol V2',
        date_created: '2026-04-01',
        author: 'Roundtrip Test Generator',
        pattern_library: ''
    },
    rig_path: '../../configs/rigs/test_rig_1.yaml',
    plugins: [
        {
            name: 'backlight',
            type: 'class',
            matlab: { class: 'LEDControllerPlugin' }
        },
        {
            name: 'camera',
            type: 'class',
            matlab: { class: 'BiasPlugin' }
        }
    ],
    experiment_structure: {
        repetitions: 1,
        randomization: { enabled: false, seed: null }
    },
    pretrial: {
        include: true,
        commands: [
            { type: 'controller', command_name: 'allOn' },
            { type: 'wait', duration: 1 },
            { type: 'controller', command_name: 'allOff' },
            { type: 'plugin', plugin_name: 'backlight', command_name: 'setIRLEDPower', params: { power: 50 } },
            { type: 'plugin', plugin_name: 'backlight', command_name: 'turnOnLED' },
            { type: 'wait', duration: 0.5 },
            { type: 'plugin', plugin_name: 'camera', command_name: 'startRecording', params: { filename: 'roundtrip_test' } }
        ]
    },
    conditions: [
        {
            id: 'grating_with_backlight',
            commands: [
                { type: 'plugin', plugin_name: 'camera', command_name: 'getTimestamp' },
                {
                    type: 'controller', command_name: 'trialParams',
                    pattern: webPatterns[0], pattern_ID: 1,
                    duration: 10, mode: 2, frame_index: 1, frame_rate: 10, gain: 0
                },
                { type: 'wait', duration: 3 },
                { type: 'plugin', plugin_name: 'backlight', command_name: 'setRedLEDPower', params: { power: 5, panel_num: 0, pattern: '1010' } },
                { type: 'wait', duration: 4 },
                { type: 'plugin', plugin_name: 'backlight', command_name: 'setVisibleBacklightsOff' },
                { type: 'wait', duration: 3 }
            ]
        },
        {
            id: 'grating_no_backlight',
            commands: [
                { type: 'plugin', plugin_name: 'camera', command_name: 'getTimestamp' },
                {
                    type: 'controller', command_name: 'trialParams',
                    pattern: webPatterns[1], pattern_ID: 2,
                    duration: 5, mode: 2, frame_index: 1, frame_rate: 60, gain: 0
                },
                { type: 'wait', duration: 5 }
            ]
        },
        {
            id: 'closed_loop_test',
            commands: [
                { type: 'plugin', plugin_name: 'camera', command_name: 'getTimestamp' },
                {
                    type: 'controller', command_name: 'trialParams',
                    pattern: webPatterns[2], pattern_ID: 3,
                    duration: 8, mode: 4, frame_index: 1, frame_rate: 0, gain: -90
                },
                { type: 'wait', duration: 8 }
            ]
        }
    ],
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
            { type: 'plugin', plugin_name: 'backlight', command_name: 'turnOffLED' },
            { type: 'plugin', plugin_name: 'camera', command_name: 'stopRecording' },
            { type: 'wait', duration: 1 }
        ]
    }
};

const v2YamlContent = generateProtocol(2, v2Protocol);
const v2YamlFile = path.join(outDir, 'test_protocol_v2.yaml');
fs.writeFileSync(v2YamlFile, v2YamlContent);
console.log('Generated: ' + v2YamlFile);

// Self-verify V2
console.log('\nSelf-verification (simpleYAMLParse):');
const parsedV2 = simpleYAMLParse(v2YamlContent);

check('v2: version', parsedV2.version, 2);
check('v2: rig', parsedV2.rig, v2Protocol.rig_path);
check('v2: experiment_info.name', parsedV2.experiment_info.name, v2Protocol.experiment_info.name);
check('v2: plugins.length', parsedV2.plugins.length, 2);
check('v2: plugins[0].name', parsedV2.plugins[0].name, 'backlight');
check('v2: plugins[0].matlab.class', parsedV2.plugins[0].matlab.class, 'LEDControllerPlugin');
check('v2: plugins[1].name', parsedV2.plugins[1].name, 'camera');
check('v2: plugins[1].matlab.class', parsedV2.plugins[1].matlab.class, 'BiasPlugin');
check('v2: num_conditions', parsedV2.block.conditions.length, 3);

// Verify condition 1 multi-command structure
const v2c0 = parsedV2.block.conditions[0];
check('v2: cond[0].id', v2c0.id, 'grating_with_backlight');
check('v2: cond[0].commands.length', v2c0.commands.length, 7);
check('v2: cond[0].cmd[0].type', v2c0.commands[0].type, 'plugin');
check('v2: cond[0].cmd[0].plugin_name', v2c0.commands[0].plugin_name, 'camera');
check('v2: cond[0].cmd[1].command_name', v2c0.commands[1].command_name, 'trialParams');
check('v2: cond[0].cmd[1].duration', v2c0.commands[1].duration, 10);
check('v2: cond[0].cmd[1].pattern', v2c0.commands[1].pattern, webPatterns[0]);
// Check plugin params roundtrip
const redCmd = v2c0.commands.find(c => c.command_name === 'setRedLEDPower');
check('v2: redCmd.params.power', redCmd.params.power, 5);
check('v2: redCmd.params.panel_num', redCmd.params.panel_num, 0);
check('v2: redCmd.params.pattern', redCmd.params.pattern, '1010');

// Condition 3: closed-loop mode
const v2c2 = parsedV2.block.conditions[2];
check('v2: cond[2].id', v2c2.id, 'closed_loop_test');
check('v2: cond[2].cmd[1].mode', v2c2.commands[1].mode, 4);
check('v2: cond[2].cmd[1].gain', v2c2.commands[1].gain, -90);

// Phases
check('v2: pretrial.include', parsedV2.pretrial.include, true);
check('v2: pretrial.commands.length', parsedV2.pretrial.commands.length, 7);
check('v2: intertrial.include', parsedV2.intertrial.include, true);
check('v2: posttrial.include', parsedV2.posttrial.include, true);
check('v2: posttrial.commands.length', parsedV2.posttrial.commands.length, 4);

// Write V2 manifest
const v2Manifest = {
    generator: 'generate-roundtrip-protocol.js',
    generated_at: new Date().toISOString(),
    version: 2,
    protocol_file: 'test_protocol_v2.yaml',
    expected: {
        name: v2Protocol.experiment_info.name,
        author: v2Protocol.experiment_info.author,
        rig_path: v2Protocol.rig_path,
        num_plugins: 2,
        plugin_names: ['backlight', 'camera'],
        plugin_classes: ['LEDControllerPlugin', 'BiasPlugin'],
        repetitions: 1,
        randomization_enabled: false,
        num_conditions: 3,
        conditions: v2Protocol.conditions.map(c => ({
            id: c.id,
            num_commands: c.commands.length,
            has_trial_params: c.commands.some(cmd => cmd.command_name === 'trialParams'),
            trial_params: (() => {
                const tp = c.commands.find(cmd => cmd.command_name === 'trialParams');
                return tp ? {
                    pattern: tp.pattern,
                    pattern_ID: tp.pattern_ID,
                    duration: tp.duration,
                    mode: tp.mode,
                    frame_index: tp.frame_index,
                    frame_rate: tp.frame_rate,
                    gain: tp.gain
                } : null;
            })()
        })),
        pretrial_include: true,
        pretrial_num_commands: 7,
        intertrial_include: true,
        intertrial_num_commands: 2,
        posttrial_include: true,
        posttrial_num_commands: 4
    }
};

const v2ManifestFile = path.join(outDir, 'test_protocol_v2_manifest.json');
fs.writeFileSync(v2ManifestFile, JSON.stringify(v2Manifest, null, 2));
console.log('\nV2 Manifest: ' + v2ManifestFile);

// Also test parsing the hand-written YAML with comments (import bug regression test)
console.log('\n--- Comment-handling regression test ---');
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

const commentParsed = simpleYAMLParse(commentYaml);
const commentConditions = commentParsed.block && commentParsed.block.conditions;
if (!Array.isArray(commentConditions)) {
    console.log('  FAIL: conditions not parsed (comment bug still present!)');
    errors++;
} else {
    check('comment_test: num_conditions', commentConditions.length, 3);
    if (commentConditions.length >= 3) {
        check('comment_test: cond[0].id', commentConditions[0].id, 'cond_a1');
        check('comment_test: cond[1].id', commentConditions[1].id, 'cond_b1');
        check('comment_test: cond[2].id', commentConditions[2].id, 'cond_b2');
    }
}

// Summary
console.log('\n' + (errors === 0 ? '✓ All checks passed' : '✗ ' + errors + ' check(s) failed'));
process.exit(errors > 0 ? 1 : 0);
