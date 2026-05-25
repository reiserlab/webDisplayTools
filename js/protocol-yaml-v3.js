/**
 * protocol-yaml-v3.js — Parser/generator for Protocol v3 YAML files.
 *
 * Provides:
 *   - parseV3Protocol(yamlText) — parse a v3 YAML into the in-memory data model.
 *   - generateV3Protocol(experiment) — emit a v3 YAML from the data model.
 *   - V3ParseError — typed error thrown for schema / version mismatches.
 *
 * Design notes:
 *   - Backed by the `yaml` npm package (a.k.a. js-yaml v2.x) in Document mode,
 *     which preserves anchors, alias references, and comments through round-trip.
 *     This is the foundation for the "users hand-author YAML with anchors and
 *     comments — designer must not destroy them" requirement.
 *   - For v0.1 (viewer), `parseV3Protocol` extracts a JS data model AND
 *     preserves the original `YAML.Document` as `_doc`. `generateV3Protocol`
 *     just re-serializes `_doc` — round-trip is a no-op at the document level.
 *   - For v0.2 (editor), edits to the data model will be threaded back into
 *     `_doc` via setIn/delete calls, then serialized. v0.2 will also add a
 *     constructive emit path (`constructFreshDocument`) for new-from-scratch
 *     experiments.
 *
 * Dual-export pattern (same as js/protocol-yaml.js):
 *   - Browser <script type="module">: import YAML from CDN before this module,
 *     or load this module with yaml bundled. v0.1 viewer page (Phase 2) wires
 *     this up.
 *   - Node test runner: `require('./js/protocol-yaml-v3.js')` works because the
 *     `export` syntax is interop-handled.
 */

'use strict';

// Import as namespace so both Node (yaml@2 npm package with a default export)
// and browser (yaml@2/browser CDN build with named exports only) resolve.
// All uses below go through `YAML.<fn>`.
import * as YAML from 'yaml';

// ════════════════════════════════════════════════════
// Constants — known schema keys per level
// ════════════════════════════════════════════════════

const KNOWN_TOP_LEVEL_KEYS = [
    'version',
    'experiment_info',
    'rig',
    'variables',
    'plugins',
    'experiment',
    'conditions'
];

const KNOWN_EXPERIMENT_INFO_KEYS = ['name', 'date_created', 'author', 'pattern_library'];

const KNOWN_BLOCK_KEYS = ['name', 'trials', 'repetitions', 'randomize', 'intertrial'];

const KNOWN_CONDITION_KEYS = ['name', 'commands'];

const KNOWN_COMMAND_KEYS_BY_TYPE = {
    controller: [
        'type',
        'command_name',
        'pattern',
        'pattern_ID',
        'duration',
        'mode',
        'frame_index',
        'frame_rate',
        'gain'
    ],
    wait: ['type', 'duration'],
    plugin: ['type', 'plugin_name', 'command_name', 'params']
};

const KNOWN_PLUGIN_KEYS = [
    'name',
    'type',
    'matlab',
    'python',
    'config',
    'port',
    'baudrate',
    'script_path'
];

// ════════════════════════════════════════════════════
// Errors
// ════════════════════════════════════════════════════

class V3ParseError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'V3ParseError';
        this.code = code || 'PARSE_ERROR';
    }
}

// ════════════════════════════════════════════════════
// Helpers — unknown-key extraction
// ════════════════════════════════════════════════════

/**
 * Pull every key from `obj` that isn't in `knownKeys` into a flat map.
 * Used to preserve forward-compat fields (retry_on_fail, abort_if, etc.)
 * at every nesting level.
 */
function extractUnknownKeys(obj, knownKeys) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const k of Object.keys(obj)) {
        if (!knownKeys.includes(k)) out[k] = obj[k];
    }
    return out;
}

// ════════════════════════════════════════════════════
// Parser
// ════════════════════════════════════════════════════

/**
 * Parse a v3 protocol YAML string into the in-memory data model.
 *
 * @param {string} yamlText - raw YAML content
 * @returns {object} experiment data model (see top-of-file docs)
 * @throws V3ParseError
 */
function parseV3Protocol(yamlText) {
    if (typeof yamlText !== 'string') {
        throw new V3ParseError('Expected YAML text, got ' + typeof yamlText, 'INVALID_INPUT');
    }

    const doc = YAML.parseDocument(yamlText, { keepSourceTokens: true });

    if (doc.errors && doc.errors.length > 0) {
        throw new V3ParseError('YAML parse error: ' + doc.errors[0].message, 'YAML_ERROR');
    }

    const data = doc.toJS();

    if (!data || typeof data !== 'object') {
        throw new V3ParseError('YAML root must be a mapping', 'INVALID_SCHEMA');
    }

    // Version check — must come before anything else
    if (data.version === 1 || data.version === 2) {
        throw new V3ParseError(
            'This is a v' +
                data.version +
                ' protocol. The v3 designer reads v3 only — please open this file in the v2 Experiment Designer page.',
            'WRONG_VERSION'
        );
    }
    if (data.version !== 3) {
        throw new V3ParseError(
            'Expected `version: 3`, got `version: ' + JSON.stringify(data.version) + '`',
            'WRONG_VERSION'
        );
    }

    // Required top-level fields
    if (!data.experiment_info || typeof data.experiment_info !== 'object') {
        throw new V3ParseError(
            'Missing or invalid required field: experiment_info',
            'INVALID_SCHEMA'
        );
    }
    if (typeof data.rig !== 'string' || !data.rig.trim()) {
        throw new V3ParseError('Missing or invalid required field: rig', 'INVALID_SCHEMA');
    }
    if (!Array.isArray(data.experiment) || data.experiment.length === 0) {
        throw new V3ParseError(
            'Missing or empty required field: experiment (must be a non-empty list)',
            'INVALID_SCHEMA'
        );
    }
    if (!Array.isArray(data.conditions) || data.conditions.length === 0) {
        throw new V3ParseError(
            'Missing or empty required field: conditions (must be a non-empty list)',
            'INVALID_SCHEMA'
        );
    }

    // Build the in-memory model
    const experiment = {
        version: 3,
        experiment_info: extractExperimentInfo(data.experiment_info),
        rig_path: String(data.rig),
        variables: extractVariables(doc),
        plugins: Array.isArray(data.plugins) ? data.plugins.map(extractPlugin) : [],
        conditions: data.conditions.map(extractCondition),
        sequence: data.experiment.map(extractSequenceEntry),
        _unknownTopLevel: extractUnknownKeys(data, KNOWN_TOP_LEVEL_KEYS),
        _doc: doc
    };

    return experiment;
}

function extractExperimentInfo(info) {
    const out = {};
    for (const k of KNOWN_EXPERIMENT_INFO_KEYS) {
        out[k] = info[k] !== undefined ? info[k] : null;
    }
    out._unknownKeys = extractUnknownKeys(info, KNOWN_EXPERIMENT_INFO_KEYS);
    return out;
}

/**
 * Extract the optional `variables:` section as an ordered list. Preserves
 * insertion order (matters for stable round-trip).
 */
function extractVariables(doc) {
    const out = [];
    const varsNode = doc.get('variables', true);
    if (!varsNode || !varsNode.items) return out;
    for (const pair of varsNode.items) {
        const name = pair.key && pair.key.value !== undefined ? pair.key.value : String(pair.key);
        let value;
        if (pair.value && pair.value.value !== undefined) {
            value = pair.value.value;
        } else if (pair.value && typeof pair.value.toJSON === 'function') {
            value = pair.value.toJSON();
        } else {
            value = pair.value;
        }
        out.push({ name: String(name), value: value });
    }
    return out;
}

function extractPlugin(plugin) {
    if (!plugin || typeof plugin !== 'object') {
        throw new V3ParseError('Plugin entry must be a mapping', 'INVALID_SCHEMA');
    }
    const out = {
        name: plugin.name,
        type: plugin.type
    };
    if (plugin.matlab) out.matlab = plugin.matlab;
    if (plugin.python) out.python = plugin.python;
    if (plugin.config && typeof plugin.config === 'object') {
        // Plugin config is freeform — no fixed schema, but stash any known shape
        // we want to preserve unchanged. For v0.1, just copy the whole object.
        out.config = JSON.parse(JSON.stringify(plugin.config));
    }
    if (plugin.port !== undefined) out.port = plugin.port;
    if (plugin.baudrate !== undefined) out.baudrate = plugin.baudrate;
    if (plugin.script_path !== undefined) out.script_path = plugin.script_path;
    out._unknownKeys = extractUnknownKeys(plugin, KNOWN_PLUGIN_KEYS);
    return out;
}

function extractCondition(cond) {
    if (!cond || typeof cond !== 'object') {
        throw new V3ParseError('Condition entry must be a mapping', 'INVALID_SCHEMA');
    }
    if (typeof cond.name !== 'string' || !cond.name.trim()) {
        throw new V3ParseError('Condition is missing a required string `name`', 'INVALID_SCHEMA');
    }
    if (!Array.isArray(cond.commands)) {
        throw new V3ParseError(
            'Condition "' + cond.name + '" is missing a required `commands` list',
            'INVALID_SCHEMA'
        );
    }
    return {
        name: cond.name,
        commands: cond.commands.map(extractCommand),
        _unknownKeys: extractUnknownKeys(cond, KNOWN_CONDITION_KEYS)
    };
}

function extractCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') {
        throw new V3ParseError('Command entry must be a mapping', 'INVALID_SCHEMA');
    }
    const t = cmd.type;
    const known = KNOWN_COMMAND_KEYS_BY_TYPE[t];
    if (!known) {
        throw new V3ParseError(
            'Unknown command type: ' +
                JSON.stringify(t) +
                ' (expected one of: ' +
                Object.keys(KNOWN_COMMAND_KEYS_BY_TYPE).join(', ') +
                ')',
            'INVALID_SCHEMA'
        );
    }
    const out = {};
    for (const k of known) {
        if (cmd[k] !== undefined) {
            out[k] =
                t === 'plugin' && k === 'params' && cmd[k] && typeof cmd[k] === 'object'
                    ? JSON.parse(JSON.stringify(cmd[k]))
                    : cmd[k];
        }
    }
    // Params get their own unknown-keys map (forward-compat for new params)
    if (t === 'plugin' && cmd.params && typeof cmd.params === 'object') {
        out.params = out.params || {};
        // Params are freeform — every key is "known" in the sense that we
        // preserve them all. No _unknownKeys map at the param level for v0.1
        // (revisit in v0.2 if we want per-param schema validation).
    }
    out._unknownKeys = extractUnknownKeys(cmd, known);
    return out;
}

function extractSequenceEntry(entry) {
    if (typeof entry === 'string') {
        return { kind: 'ref', condition_name: entry };
    }
    if (entry && typeof entry === 'object') {
        // Block object
        if (!Array.isArray(entry.trials) || entry.trials.length === 0) {
            throw new V3ParseError(
                'Block entry "' + (entry.name || '?') + '" is missing a non-empty `trials` list',
                'INVALID_SCHEMA'
            );
        }
        return {
            kind: 'block',
            name: typeof entry.name === 'string' ? entry.name : null,
            trials: entry.trials.map(String),
            repetitions: typeof entry.repetitions === 'number' ? entry.repetitions : 1,
            randomize: entry.randomize === true,
            intertrial: typeof entry.intertrial === 'string' ? entry.intertrial : null,
            _unknownKeys: extractUnknownKeys(entry, KNOWN_BLOCK_KEYS)
        };
    }
    throw new V3ParseError(
        'Experiment sequence entry must be a string or mapping; got ' + typeof entry,
        'INVALID_SCHEMA'
    );
}

// ════════════════════════════════════════════════════
// Reference validation (cross-cuts the data model)
// ════════════════════════════════════════════════════

/**
 * Walk the parsed experiment and collect every reference error
 * (bare refs, block trial lists, block intertrials) into one report.
 * Used by the import-time atomic-validation step in PR2.
 *
 * Returns { ok: boolean, errors: string[] } — never throws.
 */
function validateReferences(experiment) {
    const errors = [];
    if (!experiment || !Array.isArray(experiment.conditions)) {
        return { ok: false, errors: ['experiment.conditions missing or not an array'] };
    }
    const condNames = new Set(experiment.conditions.map((c) => c.name));
    const seen = new Set();
    for (const c of experiment.conditions) {
        if (seen.has(c.name)) {
            errors.push('Duplicate condition name: "' + c.name + '"');
        }
        seen.add(c.name);
    }
    for (let i = 0; i < experiment.sequence.length; i++) {
        const entry = experiment.sequence[i];
        if (entry.kind === 'ref') {
            if (!condNames.has(entry.condition_name)) {
                errors.push(
                    'sequence[' +
                        i +
                        ']: bare reference "' +
                        entry.condition_name +
                        '" not in conditions library'
                );
            }
        } else if (entry.kind === 'block') {
            for (let j = 0; j < entry.trials.length; j++) {
                if (!condNames.has(entry.trials[j])) {
                    errors.push(
                        'sequence[' +
                            i +
                            '].trials[' +
                            j +
                            ']: "' +
                            entry.trials[j] +
                            '" not in conditions library'
                    );
                }
            }
            if (entry.intertrial && !condNames.has(entry.intertrial)) {
                errors.push(
                    'sequence[' +
                        i +
                        '].intertrial: "' +
                        entry.intertrial +
                        '" not in conditions library'
                );
            }
        }
    }
    return { ok: errors.length === 0, errors };
}

// ════════════════════════════════════════════════════
// Generator
// ════════════════════════════════════════════════════

/**
 * Emit a v3 YAML string from the data model.
 *
 * v0.1 strategy: if the experiment came from `parseV3Protocol`, it has a
 * `_doc` handle on the original YAML.Document. We just re-serialize that
 * document, which preserves anchors, comments, formatting, and field order
 * exactly as imported. (Edits in v0.2 will mutate `_doc` in place before
 * this serialization happens.)
 *
 * If `_doc` is absent (e.g., a fresh experiment built programmatically),
 * we throw — constructive emit is a v0.2 feature.
 */
function generateV3Protocol(experiment) {
    if (!experiment || typeof experiment !== 'object') {
        throw new V3ParseError('generateV3Protocol: experiment must be an object', 'INVALID_INPUT');
    }
    if (experiment._doc) {
        return experiment._doc.toString();
    }
    throw new V3ParseError(
        'generateV3Protocol: experiment has no `_doc` handle. Constructive emit (building YAML from a data model with no source document) is a v0.2 feature; v0.1 only supports round-tripping imported documents.',
        'NOT_IMPLEMENTED'
    );
}

// ════════════════════════════════════════════════════
// Exports
// ════════════════════════════════════════════════════

const ProtocolV3 = {
    parseV3Protocol,
    generateV3Protocol,
    validateReferences,
    V3ParseError
};

// Browser global
if (typeof window !== 'undefined') {
    window.ProtocolV3 = ProtocolV3;
}

// Node.js / CommonJS
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ProtocolV3;
}

// ES module export
export { parseV3Protocol, generateV3Protocol, validateReferences, V3ParseError };
export default ProtocolV3;
