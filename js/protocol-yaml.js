/**
 * protocol-yaml.js — Shared YAML parser/generator for experiment protocols
 *
 * Provides:
 *   - simpleYAMLParse(text) — parse YAML protocol files (v1 and v2)
 *   - generateV1Protocol(opts) — generate v1 protocol YAML
 *   - generateV2Protocol(experiment) — generate v2 protocol YAML
 *   - yamlStr(str) — escape/quote a YAML string value
 *   - appendCommand(lines, cmd, indentLevel) — append a command to YAML lines
 *
 * Dual-export pattern (same as pat-parser.js):
 *   - Browser <script> tag: window.ProtocolYAML
 *   - ES6 module import: import { simpleYAMLParse, ... } from './protocol-yaml.js'
 */

'use strict';

// ════════════════════════════════════════════════════
// YAML Helpers
// ════════════════════════════════════════════════════

/**
 * Strip inline YAML comments outside of quoted strings.
 * e.g. "'path/to/file'  # comment" → "'path/to/file'"
 *      "someValue # note"          → "someValue"
 *      '"has # inside"'            → '"has # inside"'
 */
function stripInlineComment(str) {
    if (!str) return str;
    var inSingle = false;
    var inDouble = false;
    for (var j = 0; j < str.length; j++) {
        var ch = str[j];
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
        } else if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (ch === '#' && !inSingle && !inDouble) {
            // YAML spec: # must be preceded by whitespace to start a comment
            if (j === 0 || /\s/.test(str[j - 1])) {
                return str.substring(0, j).trimEnd();
            }
        }
    }
    return str;
}

/**
 * Escape and quote a string for YAML output.
 * Always double-quotes the value for consistency.
 */
function yamlStr(str) {
    if (str === null || str === undefined || str === '') return '""';
    str = String(str);
    if (/[:#\{\}\[\],&\*\?|>!'"%@`\n]/.test(str) || str.trim() !== str) {
        return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    return '"' + str + '"';
}

/**
 * Repeat a string n times.
 */
function repeat(str, n) {
    var result = '';
    for (var i = 0; i < n; i++) result += str;
    return result;
}

// ════════════════════════════════════════════════════
// YAML Parser
// ════════════════════════════════════════════════════

/**
 * Minimal recursive-descent YAML parser for protocol files (v1 and v2).
 *
 * Handles:
 *   - Key-value pairs, nested objects, lists of objects
 *   - Quoted strings (single and double), numbers, booleans, null
 *   - Comments (full-line and inline)
 *   - Deeply nested structures (plugins → matlab → class, params, etc.)
 *
 * Does NOT handle:
 *   - Flow mappings/sequences ({}, [])
 *   - Multi-line strings (|, >)
 *   - Anchors/aliases (&, *)
 *   - Tags (!!)
 *
 * @param {string} text - YAML content
 * @returns {object} Parsed object
 */
function simpleYAMLParse(text) {
    var lines = text.split('\n');
    var i = 0;

    function getIndent(line) {
        var m = line.match(/^(\s*)/);
        return m ? m[1].length : 0;
    }

    function parseValue(raw) {
        if (raw === undefined || raw === '') return '';
        raw = raw.trim();
        if (
            (raw.startsWith('"') && raw.endsWith('"')) ||
            (raw.startsWith("'") && raw.endsWith("'"))
        ) {
            return raw.slice(1, -1);
        }
        if (raw === 'null' || raw === '~') return null;
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        var num = Number(raw);
        if (!isNaN(num) && raw !== '') return num;
        return raw;
    }

    function parseBlock(baseIndent) {
        var obj = {};
        while (i < lines.length) {
            var line = lines[i];
            if (line.trim() === '' || line.trim().startsWith('#')) {
                i++;
                continue;
            }
            var indent = getIndent(line);
            if (indent < baseIndent) break;
            if (indent > baseIndent) {
                i++;
                continue;
            }

            var trimmed = line.trim();
            if (trimmed.startsWith('- ')) break;

            var kvMatch = trimmed.match(/^([^:]+?):\s*(.*)?$/);
            if (!kvMatch) {
                i++;
                continue;
            }

            var key = kvMatch[1].trim();
            var valRaw = stripInlineComment((kvMatch[2] || '').trim());

            if (valRaw === '' || valRaw === undefined) {
                i++;
                // Skip blank lines and comments to find actual child content
                while (
                    i < lines.length &&
                    (lines[i].trim() === '' || lines[i].trim().startsWith('#'))
                ) {
                    i++;
                }
                if (i < lines.length) {
                    var nextLine = lines[i];
                    var nextIndent = getIndent(nextLine);
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
        var arr = [];
        while (i < lines.length) {
            var line = lines[i];
            if (line.trim() === '' || line.trim().startsWith('#')) {
                i++;
                continue;
            }
            var indent = getIndent(line);
            if (indent < baseIndent) break;

            var trimmed = line.trim();
            if (!trimmed.startsWith('- ')) {
                i++;
                continue;
            }

            var itemContent = trimmed.slice(2).trim();
            var kvMatch = itemContent.match(/^([^:]+?):\s*(.*)?$/);

            if (kvMatch) {
                var item = {};
                var firstVal = stripInlineComment((kvMatch[2] || '').trim());
                item[kvMatch[1].trim()] = parseValue(firstVal);
                i++;
                while (i < lines.length) {
                    var subLine = lines[i];
                    if (subLine.trim() === '' || subLine.trim().startsWith('#')) {
                        i++;
                        continue;
                    }
                    var subIndent = getIndent(subLine);
                    if (subIndent <= baseIndent) break;
                    var subTrimmed = subLine.trim();
                    if (subTrimmed.startsWith('- ')) break;
                    var subKv = subTrimmed.match(/^([^:]+?):\s*(.*)?$/);
                    if (subKv) {
                        var subKey = subKv[1].trim();
                        var subVal = stripInlineComment((subKv[2] || '').trim());
                        if (subVal === '') {
                            i++;
                            // Skip blank lines and comments
                            while (
                                i < lines.length &&
                                (lines[i].trim() === '' || lines[i].trim().startsWith('#'))
                            ) {
                                i++;
                            }
                            if (i < lines.length) {
                                var nLine = lines[i];
                                var nIndent = getIndent(nLine);
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
                arr.push(parseValue(stripInlineComment(itemContent)));
                i++;
            }
        }
        return arr;
    }

    return parseBlock(0);
}

// ════════════════════════════════════════════════════
// V1 Protocol Generator
// ════════════════════════════════════════════════════

/**
 * Append a single command to YAML output lines.
 * Handles controller, wait, and plugin command types.
 *
 * @param {string[]} lines - output lines array (mutated)
 * @param {object} cmd - command object
 * @param {number} indentLevel - number of 2-space indents
 */
function appendCommand(lines, cmd, indentLevel) {
    var ind = repeat('  ', indentLevel);
    lines.push(ind + '- type: ' + yamlStr(cmd.type));

    if (cmd.command_name) {
        lines.push(ind + '  command_name: ' + yamlStr(cmd.command_name));
    }
    if (cmd.plugin_name) {
        lines.push(ind + '  plugin_name: ' + yamlStr(cmd.plugin_name));
    }
    if (cmd.pattern) {
        lines.push(ind + '  pattern: ' + yamlStr(cmd.pattern));
    }
    if (cmd.pattern_ID !== undefined) {
        lines.push(ind + '  pattern_ID: ' + cmd.pattern_ID);
    }
    if (cmd.duration !== undefined) {
        lines.push(ind + '  duration: ' + cmd.duration);
    }
    if (cmd.mode !== undefined) {
        lines.push(ind + '  mode: ' + cmd.mode);
    }
    if (cmd.frame_index !== undefined) {
        lines.push(ind + '  frame_index: ' + cmd.frame_index);
    }
    if (cmd.frame_rate !== undefined) {
        lines.push(ind + '  frame_rate: ' + cmd.frame_rate);
    }
    if (cmd.gain !== undefined) {
        lines.push(ind + '  gain: ' + cmd.gain);
    }
    // Plugin params (nested key-value)
    if (cmd.params && typeof cmd.params === 'object') {
        lines.push(ind + '  params:');
        var paramInd = ind + '    ';
        var keys = Object.keys(cmd.params);
        for (var k = 0; k < keys.length; k++) {
            var pKey = keys[k];
            var pVal = cmd.params[pKey];
            if (typeof pVal === 'string') {
                lines.push(paramInd + pKey + ': ' + yamlStr(pVal));
            } else {
                lines.push(paramInd + pKey + ': ' + pVal);
            }
        }
    }
}

/**
 * Generate a V1 protocol YAML string.
 *
 * @param {object} opts - protocol options with flat condition fields
 * @returns {string} YAML content
 */
function generateV1Protocol(opts) {
    var lines = [];

    lines.push('# Protocol Version 1');
    lines.push('# Generated by Experiment Designer — ' + new Date().toISOString());
    lines.push('');
    lines.push('version: 1');
    lines.push('');

    // Experiment info
    lines.push('experiment_info:');
    lines.push('  name: ' + yamlStr(opts.name));
    lines.push('  date_created: ' + yamlStr(opts.date_created));
    lines.push('  author: ' + yamlStr(opts.author));
    lines.push('  pattern_library: ' + yamlStr(opts.pattern_library || ''));
    lines.push('');

    // Arena info
    lines.push('arena_info:');
    lines.push('  num_rows: ' + opts.num_rows);
    lines.push('  num_cols: ' + opts.num_cols);
    lines.push('  generation: ' + yamlStr(opts.generation));
    lines.push('');

    // Experiment structure
    lines.push('experiment_structure:');
    lines.push('  repetitions: ' + opts.repetitions);
    lines.push('  randomization:');
    lines.push('    enabled: ' + opts.randomization_enabled);
    lines.push(
        '    seed: ' +
            (opts.randomization_seed === null || opts.randomization_seed === undefined
                ? 'null'
                : opts.randomization_seed)
    );
    lines.push('    method: "block"');
    lines.push('');

    // Pretrial
    lines.push('pretrial:');
    lines.push('  include: ' + opts.pretrial.include);
    if (opts.pretrial.include && opts.pretrial.commands) {
        lines.push('  commands:');
        for (var pi = 0; pi < opts.pretrial.commands.length; pi++) {
            appendCommand(lines, opts.pretrial.commands[pi], 2);
        }
    }
    lines.push('');

    // Block conditions
    lines.push('block:');
    lines.push('  conditions:');
    for (var ci = 0; ci < opts.conditions.length; ci++) {
        var cond = opts.conditions[ci];
        lines.push('    - id: ' + yamlStr(cond.id));
        lines.push('      commands:');
        for (var ki = 0; ki < cond.commands.length; ki++) {
            appendCommand(lines, cond.commands[ki], 4);
        }
    }
    lines.push('');

    // Intertrial
    lines.push('intertrial:');
    lines.push('  include: ' + opts.intertrial.include);
    if (opts.intertrial.include && opts.intertrial.commands) {
        lines.push('  commands:');
        for (var ii = 0; ii < opts.intertrial.commands.length; ii++) {
            appendCommand(lines, opts.intertrial.commands[ii], 2);
        }
    }
    lines.push('');

    // Posttrial
    lines.push('posttrial:');
    lines.push('  include: ' + opts.posttrial.include);
    if (opts.posttrial.include && opts.posttrial.commands) {
        lines.push('  commands:');
        for (var pti = 0; pti < opts.posttrial.commands.length; pti++) {
            appendCommand(lines, opts.posttrial.commands[pti], 2);
        }
    }

    return lines.join('\n') + '\n';
}

// ════════════════════════════════════════════════════
// V2 Protocol Generator
// ════════════════════════════════════════════════════

/**
 * Generate a V2 protocol YAML string from the experiment data model.
 *
 * V2 differences from V1:
 *   - version: 2
 *   - rig: path (replaces arena_info)
 *   - plugins: [] section
 *   - Conditions use command arrays (not flat fields)
 *
 * @param {object} experiment - full experiment data model
 * @returns {string} YAML content
 */
function generateV2Protocol(experiment) {
    var lines = [];

    lines.push('# Protocol Version 2');
    lines.push('# Generated by Experiment Designer — ' + new Date().toISOString());
    lines.push('');
    lines.push('version: 2');
    lines.push('');

    // Experiment info
    lines.push('experiment_info:');
    lines.push('  name: ' + yamlStr(experiment.experiment_info.name || 'Untitled Experiment'));
    lines.push('  date_created: ' + yamlStr(experiment.experiment_info.date_created));
    lines.push('  author: ' + yamlStr(experiment.experiment_info.author));
    lines.push('  pattern_library: ' + yamlStr(experiment.experiment_info.pattern_library));
    lines.push('');

    // Rig reference (v2 replaces arena_info)
    lines.push('rig: ' + yamlStr(experiment.rig_path || ''));
    lines.push('');

    // Plugins
    if (experiment.plugins && experiment.plugins.length > 0) {
        lines.push('plugins:');
        for (var pi = 0; pi < experiment.plugins.length; pi++) {
            var plugin = experiment.plugins[pi];
            lines.push('  - name: ' + yamlStr(plugin.name));
            lines.push('    type: ' + yamlStr(plugin.type));
            // Class plugin
            if (plugin.matlab) {
                lines.push('    matlab:');
                lines.push('      class: ' + yamlStr(plugin.matlab.class));
            }
            // Serial device
            if (plugin.port) {
                lines.push('    port: ' + yamlStr(plugin.port));
            }
            if (plugin.baudrate !== undefined) {
                lines.push('    baudrate: ' + plugin.baudrate);
            }
            // Script
            if (plugin.script_path) {
                lines.push('    script_path: ' + yamlStr(plugin.script_path));
            }
            // Config (optional overrides)
            if (plugin.config && Object.keys(plugin.config).length > 0) {
                lines.push('    config:');
                var configKeys = Object.keys(plugin.config);
                for (var ck = 0; ck < configKeys.length; ck++) {
                    var cKey = configKeys[ck];
                    var cVal = plugin.config[cKey];
                    if (typeof cVal === 'string') {
                        lines.push('      ' + cKey + ': ' + yamlStr(cVal));
                    } else {
                        lines.push('      ' + cKey + ': ' + cVal);
                    }
                }
            }
        }
        lines.push('');
    }

    // Experiment structure
    lines.push('experiment_structure:');
    lines.push('  repetitions: ' + experiment.experiment_structure.repetitions);
    lines.push('  randomization:');
    lines.push('    enabled: ' + experiment.experiment_structure.randomization.enabled);
    lines.push(
        '    seed: ' +
            (experiment.experiment_structure.randomization.seed === null
                ? 'null'
                : experiment.experiment_structure.randomization.seed)
    );
    lines.push('    method: "block"');
    lines.push('');

    // Helper: write a phase (pretrial, intertrial, posttrial)
    function writePhase(phaseName, phase) {
        lines.push(phaseName + ':');
        lines.push('  include: ' + phase.include);
        if (phase.include && phase.commands && phase.commands.length > 0) {
            lines.push('  commands:');
            for (var ci = 0; ci < phase.commands.length; ci++) {
                appendCommand(lines, phase.commands[ci], 2);
            }
        }
        lines.push('');
    }

    // Pretrial
    writePhase('pretrial', experiment.pretrial);

    // Block conditions
    lines.push('block:');
    lines.push('  conditions:');
    for (var ci = 0; ci < experiment.conditions.length; ci++) {
        var cond = experiment.conditions[ci];
        lines.push('    - id: ' + yamlStr(cond.id));
        lines.push('      commands:');
        for (var ki = 0; ki < cond.commands.length; ki++) {
            appendCommand(lines, cond.commands[ki], 4);
        }
    }
    lines.push('');

    // Intertrial and Posttrial
    writePhase('intertrial', experiment.intertrial);
    writePhase('posttrial', experiment.posttrial);

    return lines.join('\n') + '\n';
}

// ════════════════════════════════════════════════════
// V1 ↔ V2 Conversion Helpers
// ════════════════════════════════════════════════════

/**
 * Convert a v1 flat condition object to a v2 command array.
 *
 * v1: { id, pattern, duration, mode, frame_rate, frame_index, gain }
 * v2: { id, commands: [ { type: "controller", command_name: "trialParams", ... } ] }
 *
 * @param {object} cond - v1 condition
 * @returns {object} v2 condition with commands array
 */
function v1ConditionToCommands(cond) {
    var commands = [];
    if (cond.pattern) {
        commands.push({
            type: 'controller',
            command_name: 'trialParams',
            pattern: cond.pattern,
            pattern_ID: 1,
            duration: cond.duration || 5,
            mode: cond.mode || 2,
            frame_index: cond.frame_index || 1,
            frame_rate: cond.frame_rate || 60,
            gain: cond.gain || 0
        });
    } else {
        commands.push({
            type: 'controller',
            command_name: 'allOff'
        });
    }
    return {
        id: cond.id,
        commands: commands
    };
}

/**
 * Convert a v1 phase (pretrial/intertrial/posttrial) to v2 format.
 *
 * v1: { include, pattern, duration, mode, ..., wait }
 * v2: { include, commands: [ ... ] }
 *
 * @param {object} phase - v1 phase
 * @returns {object} v2 phase with commands array
 */
function v1PhaseToCommands(phase) {
    var result = { include: phase.include, commands: [] };
    if (!phase.include) return result;

    if (phase.pattern) {
        result.commands.push({
            type: 'controller',
            command_name: 'trialParams',
            pattern: phase.pattern,
            pattern_ID: 1,
            duration: phase.duration || 2,
            mode: phase.mode || 2,
            frame_index: phase.frame_index || 1,
            frame_rate: phase.frame_rate || 60,
            gain: phase.gain || 0
        });
    } else {
        result.commands.push({
            type: 'controller',
            command_name: 'allOff'
        });
    }
    if (phase.wait > 0) {
        result.commands.push({
            type: 'wait',
            duration: phase.wait
        });
    }
    return result;
}

// ════════════════════════════════════════════════════
// Exports
// ════════════════════════════════════════════════════

var ProtocolYAML = {
    simpleYAMLParse: simpleYAMLParse,
    generateV1Protocol: generateV1Protocol,
    generateV2Protocol: generateV2Protocol,
    appendCommand: appendCommand,
    yamlStr: yamlStr,
    repeat: repeat,
    stripInlineComment: stripInlineComment,
    v1ConditionToCommands: v1ConditionToCommands,
    v1PhaseToCommands: v1PhaseToCommands
};

// Browser global (for <script> tags)
if (typeof window !== 'undefined') {
    window.ProtocolYAML = ProtocolYAML;
}

// Node.js / CommonJS
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ProtocolYAML;
}

// ES module export
export {
    simpleYAMLParse,
    generateV1Protocol,
    generateV2Protocol,
    appendCommand,
    yamlStr,
    repeat,
    stripInlineComment,
    v1ConditionToCommands,
    v1PhaseToCommands
};
export default ProtocolYAML;
