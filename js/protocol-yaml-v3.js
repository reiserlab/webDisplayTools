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
        'gain',
        'gs_val',
        'posX'
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
        // Identity preference: the anchor name on pair.value (the v3-canonical
        // form `name_key: &anchor_name value`). Falls back to the map key when
        // there's no anchor — rare in real fixtures, but tolerated. Phase 5's
        // Variables editor surfaces the anchor name as the rename target and
        // expects this to be the identity used throughout the JS mirror.
        const anchorName = pair.value && pair.value.anchor ? pair.value.anchor : null;
        const mapKey = pair.key && pair.key.value !== undefined ? pair.key.value : String(pair.key);
        const name = anchorName || mapKey;
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
    if (typeof t !== 'string' || !t.trim()) {
        throw new V3ParseError(
            'Command is missing a string `type` field',
            'INVALID_SCHEMA'
        );
    }
    const known = KNOWN_COMMAND_KEYS_BY_TYPE[t];
    if (!known) {
        // Forward-compat passthrough: round-trip unknown command types so
        // future MATLAB additions (branch, loop, etc.) don't break import.
        // The renderer shows these as read-only "raw" cards; export uses
        // _doc.toString() which preserves the original YAML node verbatim.
        const raw = { type: t, _rawUnknownType: true, _unknownKeys: {} };
        for (const k of Object.keys(cmd)) {
            if (k === 'type') continue;
            raw[k] =
                cmd[k] !== null && typeof cmd[k] === 'object'
                    ? JSON.parse(JSON.stringify(cmd[k]))
                    : cmd[k];
        }
        return raw;
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
        // repetitions: optional, but if present must be a positive integer.
        // Catches `0`, negatives, decimals (1.5) that would otherwise silently
        // drop a block or loop a non-integer number of times.
        let repetitions = 1;
        if (entry.repetitions !== undefined) {
            if (
                typeof entry.repetitions !== 'number' ||
                !Number.isInteger(entry.repetitions) ||
                entry.repetitions < 1
            ) {
                throw new V3ParseError(
                    'Block "' +
                        (entry.name || '?') +
                        '" has invalid `repetitions`: ' +
                        JSON.stringify(entry.repetitions) +
                        ' (must be a positive integer)',
                    'INVALID_SCHEMA'
                );
            }
            repetitions = entry.repetitions;
        }
        return {
            kind: 'block',
            name: typeof entry.name === 'string' ? entry.name : null,
            trials: entry.trials.map(String),
            repetitions: repetitions,
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

/**
 * Collect non-fatal export-time warnings. Soft-warn gate: the editor surfaces
 * these in a yellow banner above the Export button, but never blocks export.
 *
 * Categories:
 *   - unused-condition: condition declared in `conditions:` but not referenced
 *     from anywhere in `experiment:` (sequence)
 *   - unused-anchor: anchor declared in `variables:` but no `*alias` references
 *     it anywhere in the document (uses YAML.visit on the doc tree)
 *   - undeclared-plugin: `plugin_name:` on a command does not match any entry
 *     in `plugins:` and isn't the built-in 'log'
 *   - raw-command: command preserved as forward-compat unknown type
 *     (informational only — designer can't edit it semantically)
 *
 * Returns { warnings: [{kind, message, ...meta}], totalCount }. Never throws.
 */
function collectExportWarnings(experiment) {
    const warnings = [];
    if (!experiment || !Array.isArray(experiment.conditions)) {
        return { warnings, totalCount: 0 };
    }

    // 1. Unused conditions
    const usedCondNames = new Set();
    for (const entry of experiment.sequence || []) {
        if (entry.kind === 'ref') {
            usedCondNames.add(entry.condition_name);
        } else if (entry.kind === 'block') {
            for (const t of entry.trials) usedCondNames.add(t);
            if (entry.intertrial) usedCondNames.add(entry.intertrial);
        }
    }
    for (const c of experiment.conditions) {
        if (!usedCondNames.has(c.name)) {
            warnings.push({
                kind: 'unused-condition',
                name: c.name,
                message: 'Condition "' + c.name + '" is declared but never referenced.'
            });
        }
    }

    // 2. Unused anchors — extract actual anchor names from the variables:
    // value nodes (NOT the map keys; keys and anchors can diverge, e.g.
    // `name_key: &different_anchor 5`). Compare against the set of all alias
    // references in the document via YAML.visit.
    if (experiment._doc) {
        const declaredAnchors = [];
        const varsNode = experiment._doc.get('variables', true);
        if (varsNode && Array.isArray(varsNode.items)) {
            for (const pair of varsNode.items) {
                if (pair.value && pair.value.anchor) {
                    declaredAnchors.push(pair.value.anchor);
                }
            }
        }
        if (declaredAnchors.length > 0) {
            const usedAnchors = new Set();
            if (typeof YAML.visit === 'function') {
                YAML.visit(experiment._doc, {
                    Alias(_, node) {
                        if (node && node.source) usedAnchors.add(node.source);
                    }
                });
            }
            for (const name of declaredAnchors) {
                if (!usedAnchors.has(name)) {
                    warnings.push({
                        kind: 'unused-anchor',
                        name: name,
                        message: 'Anchor "&' + name + '" is declared in variables: but never referenced.'
                    });
                }
            }
        }
    }

    // 3. Plugin names used in commands but not declared in plugins: (excl 'log')
    const declaredPluginNames = new Set(
        (experiment.plugins || []).map((p) => p && p.name).filter(Boolean)
    );
    declaredPluginNames.add('log');
    const undeclaredPluginsSeen = new Set();
    for (const c of experiment.conditions) {
        for (const cmd of c.commands || []) {
            if (cmd.type === 'plugin' && cmd.plugin_name) {
                if (!declaredPluginNames.has(cmd.plugin_name) && !undeclaredPluginsSeen.has(cmd.plugin_name)) {
                    undeclaredPluginsSeen.add(cmd.plugin_name);
                    warnings.push({
                        kind: 'undeclared-plugin',
                        name: cmd.plugin_name,
                        condition: c.name,
                        message: 'Plugin "' + cmd.plugin_name + '" is referenced by commands but not declared in plugins:.'
                    });
                }
            }
        }
    }

    // 4. Raw / forward-compat command-type cards (informational)
    for (const c of experiment.conditions) {
        for (const cmd of c.commands || []) {
            if (cmd._rawUnknownType) {
                warnings.push({
                    kind: 'raw-command',
                    name: cmd.type,
                    condition: c.name,
                    message: 'Condition "' + c.name + '" contains an unknown command type "' + cmd.type + '" (preserved on export, but designer cannot edit it).'
                });
            }
        }
    }

    return { warnings, totalCount: warnings.length };
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
// Editing — write a value back to both the YAML.Document and the JS model
// ════════════════════════════════════════════════════

/**
 * docSet(experiment, path, value)
 *
 * Mutates the YAML.Document attached as `experiment._doc` at `path`, and
 * mirrors the change in the JS data model so the UI stays in sync.
 *
 * `path` is an array of YAML-side keys/indices. Top-level keys in the
 * YAML differ from our JS model in two places:
 *   - 'experiment' (YAML) → 'sequence' (JS)
 *   - 'rig'        (YAML) → 'rig_path' (JS)
 * Use the YAML-side names in `path` — the JS-model mirror is translated below.
 *
 * Setting a primitive value through a scalar node that previously held a
 * `*alias` reference replaces the alias with the literal. Comments attached
 * to the node and its surroundings are preserved by yaml@2.
 */
function docSet(experiment, path, value) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docSet: experiment has no _doc handle', 'NO_DOC');
    }
    if (!Array.isArray(path) || path.length === 0) {
        throw new V3ParseError('docSet: path must be a non-empty array', 'BAD_PATH');
    }
    experiment._doc.setIn(path, value);
    mirrorIntoModel(experiment, path, value);
}

/**
 * Returns true if the YAML node at `path` is an Alias reference (i.e., the
 * scalar in the source YAML is `*name`, not a literal). Used by the editor
 * to render anchor-bound fields as read-only badges instead of input boxes.
 */
function nodeIsAliasAt(experiment, path) {
    if (!experiment || !experiment._doc) return false;
    const node = experiment._doc.getIn(path, true);
    if (!node) return false;
    return YAML.isAlias ? YAML.isAlias(node) : node.type === 'ALIAS' || node.constructor?.name === 'Alias';
}

/**
 * If the YAML node at `path` is an Alias, return its anchor name; else null.
 * Lets the UI render `→ &dur_long` chips next to anchor-bound fields.
 */
function aliasNameAt(experiment, path) {
    if (!experiment || !experiment._doc) return null;
    const node = experiment._doc.getIn(path, true);
    if (!node) return null;
    if (YAML.isAlias && YAML.isAlias(node)) {
        return node.source || null;
    }
    if (node.type === 'ALIAS' || node.constructor?.name === 'Alias') {
        return node.source || null;
    }
    return null;
}

/**
 * Translate a YAML-side path into the JS-side equivalent and write `value`
 * along the chain. Returns silently if the path doesn't exist in the JS
 * model (e.g., a passthrough-only key at an unsupported nesting level).
 */
function mirrorIntoModel(experiment, path, value) {
    const jsPath = [...path];
    if (jsPath[0] === 'experiment') jsPath[0] = 'sequence';
    else if (jsPath[0] === 'rig') jsPath[0] = 'rig_path';

    let cursor = experiment;
    for (let i = 0; i < jsPath.length - 1; i++) {
        if (cursor == null) return;
        cursor = cursor[jsPath[i]];
    }
    if (cursor != null && jsPath.length > 0) {
        cursor[jsPath[jsPath.length - 1]] = value;
    }
}

/**
 * docInsertCommand(experiment, condIdx, atIdx, command)
 *
 * Insert `command` (a plain JS object: {type, command_name, ...}) into the
 * commands list at conditions[condIdx].commands[atIdx]. atIdx is clamped to
 * [0, commands.length]; pass commands.length to append.
 *
 * Mirrors the change into the JS data model.
 */
function docInsertCommand(experiment, condIdx, atIdx, command) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docInsertCommand: experiment has no _doc handle', 'NO_DOC');
    }
    const cond = experiment.conditions[condIdx];
    if (!cond) {
        throw new V3ParseError('docInsertCommand: bad condition index ' + condIdx, 'BAD_PATH');
    }
    const clampedIdx = Math.max(0, Math.min(atIdx, cond.commands.length));

    const cmdsNode = experiment._doc.getIn(['conditions', condIdx, 'commands'], true);
    if (!cmdsNode || !Array.isArray(cmdsNode.items)) {
        throw new V3ParseError(
            'docInsertCommand: commands sequence node not found at conditions[' + condIdx + ']',
            'BAD_PATH'
        );
    }
    const newNode = experiment._doc.createNode(command);
    cmdsNode.items.splice(clampedIdx, 0, newNode);

    cond.commands.splice(clampedIdx, 0, command);
}

/**
 * docMoveCommand(experiment, condIdx, fromIdx, toIdx)
 *
 * Move a command within conditions[condIdx].commands. Bounds-checked; a
 * no-op if fromIdx === toIdx. Mirrors both YAML.Document and JS model.
 */
function docMoveCommand(experiment, condIdx, fromIdx, toIdx) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docMoveCommand: experiment has no _doc handle', 'NO_DOC');
    }
    const cond = experiment.conditions[condIdx];
    if (!cond) {
        throw new V3ParseError('docMoveCommand: bad condition index ' + condIdx, 'BAD_PATH');
    }
    const n = cond.commands.length;
    if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n || fromIdx === toIdx) return;

    const cmdsNode = experiment._doc.getIn(['conditions', condIdx, 'commands'], true);
    if (!cmdsNode || !Array.isArray(cmdsNode.items)) {
        // Doc/model divergence: the JS model claims a commands array at this
        // condition but the YAML.Document has no matching seq node. Silent
        // return would update the JS model while leaving the doc stale, then
        // export incorrect YAML. Throw so the bug surfaces immediately.
        throw new V3ParseError(
            'docMoveCommand: doc/model divergence — no commands seq node at conditions[' +
                condIdx +
                ']',
            'DOC_MODEL_DIVERGENCE'
        );
    }

    const movedNode = cmdsNode.items.splice(fromIdx, 1)[0];
    cmdsNode.items.splice(toIdx, 0, movedNode);

    const movedJs = cond.commands.splice(fromIdx, 1)[0];
    cond.commands.splice(toIdx, 0, movedJs);
}

/**
 * docSetPluginCommandHead(experiment, condIdx, cmdIdx, newHead)
 *
 * Atomically replace a plugin command's head (plugin_name, command_name) and
 * params. The caller is responsible for reconciling params against the new
 * command's schema before invoking this (see docs at top of file). The helper
 * itself stays plugin-registry-agnostic: it takes the final shape and writes
 * it through to both _doc and JS model.
 *
 * newHead = { plugin_name, command_name, params } — `params` may be an object,
 * `{}`, or undefined; an empty/absent params object omits the `params:` map
 * from the emitted YAML.
 *
 * Comments attached to individual fields of the replaced command are lost —
 * this is a semantic replacement, not a field-level edit. Comments above and
 * below the command in the parent seq are preserved by yaml@2.
 */
function docSetPluginCommandHead(experiment, condIdx, cmdIdx, newHead) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docSetPluginCommandHead: experiment has no _doc handle', 'NO_DOC');
    }
    const cond = experiment.conditions[condIdx];
    if (!cond) {
        throw new V3ParseError(
            'docSetPluginCommandHead: bad condition index ' + condIdx,
            'BAD_PATH'
        );
    }
    const cmd = cond.commands[cmdIdx];
    if (!cmd || cmd.type !== 'plugin') {
        throw new V3ParseError(
            'docSetPluginCommandHead: command at [' + condIdx + ',' + cmdIdx + '] is not a plugin command',
            'INVALID_INPUT'
        );
    }
    if (!newHead || typeof newHead.plugin_name !== 'string' || typeof newHead.command_name !== 'string') {
        throw new V3ParseError(
            'docSetPluginCommandHead: newHead.plugin_name and newHead.command_name must be strings',
            'INVALID_INPUT'
        );
    }

    const cmdsNode = experiment._doc.getIn(['conditions', condIdx, 'commands'], true);
    if (!cmdsNode || !Array.isArray(cmdsNode.items)) {
        throw new V3ParseError(
            'docSetPluginCommandHead: commands seq missing at conditions[' + condIdx + ']',
            'DOC_MODEL_DIVERGENCE'
        );
    }

    const newCmd = {
        type: 'plugin',
        plugin_name: newHead.plugin_name,
        command_name: newHead.command_name
    };
    if (newHead.params && typeof newHead.params === 'object' && Object.keys(newHead.params).length > 0) {
        newCmd.params = JSON.parse(JSON.stringify(newHead.params));
    }
    const newNode = experiment._doc.createNode(newCmd);
    cmdsNode.items[cmdIdx] = newNode;

    const jsCmd = {
        type: 'plugin',
        plugin_name: newHead.plugin_name,
        command_name: newHead.command_name,
        _unknownKeys: {}
    };
    if (newCmd.params) jsCmd.params = JSON.parse(JSON.stringify(newCmd.params));
    cond.commands[cmdIdx] = jsCmd;
}

/**
 * docAddPluginParam(experiment, condIdx, cmdIdx, paramKey, paramValue)
 *
 * Set a single param on a plugin command. Creates the `params:` map if it
 * doesn't already exist (mirrorIntoModel returns early on missing
 * intermediates, so a nested docSet would silently fail to mirror).
 *
 * Throws when the target command isn't a plugin command, or when the doc and
 * JS model have diverged.
 */
function docAddPluginParam(experiment, condIdx, cmdIdx, paramKey, paramValue) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docAddPluginParam: experiment has no _doc handle', 'NO_DOC');
    }
    const cond = experiment.conditions[condIdx];
    if (!cond) {
        throw new V3ParseError('docAddPluginParam: bad condition index ' + condIdx, 'BAD_PATH');
    }
    const cmd = cond.commands[cmdIdx];
    if (!cmd || cmd.type !== 'plugin') {
        throw new V3ParseError(
            'docAddPluginParam: command at [' + condIdx + ',' + cmdIdx + '] is not a plugin command',
            'INVALID_INPUT'
        );
    }
    if (typeof paramKey !== 'string' || !paramKey) {
        throw new V3ParseError('docAddPluginParam: paramKey must be a non-empty string', 'INVALID_INPUT');
    }

    const paramsPath = ['conditions', condIdx, 'commands', cmdIdx, 'params'];
    const paramsNode = experiment._doc.getIn(paramsPath, true);
    if (!paramsNode || !Array.isArray(paramsNode.items)) {
        // Create the whole params map atomically with this first param.
        experiment._doc.setIn(paramsPath, { [paramKey]: paramValue });
        cmd.params = { [paramKey]: paramValue };
        return;
    }
    experiment._doc.setIn([...paramsPath, paramKey], paramValue);
    cmd.params = cmd.params || {};
    cmd.params[paramKey] = paramValue;
}

/**
 * docDeletePluginParam(experiment, condIdx, cmdIdx, paramKey)
 *
 * Delete a single param from a plugin command. When the resulting params map
 * is empty, also delete the `params:` map itself (an empty `params: {}` is
 * valid YAML but semantically noisy and the parser would drop it anyway).
 *
 * No-op if the param doesn't exist.
 */
function docDeletePluginParam(experiment, condIdx, cmdIdx, paramKey) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docDeletePluginParam: experiment has no _doc handle', 'NO_DOC');
    }
    const cond = experiment.conditions[condIdx];
    if (!cond) {
        throw new V3ParseError('docDeletePluginParam: bad condition index ' + condIdx, 'BAD_PATH');
    }
    const cmd = cond.commands[cmdIdx];
    if (!cmd || cmd.type !== 'plugin') {
        throw new V3ParseError(
            'docDeletePluginParam: command at [' + condIdx + ',' + cmdIdx + '] is not a plugin command',
            'INVALID_INPUT'
        );
    }

    const paramsPath = ['conditions', condIdx, 'commands', cmdIdx, 'params'];
    const paramsNode = experiment._doc.getIn(paramsPath, true);
    if (!paramsNode || !Array.isArray(paramsNode.items)) {
        return; // No params to delete
    }

    experiment._doc.deleteIn([...paramsPath, paramKey]);
    if (cmd.params) delete cmd.params[paramKey];

    // If the map is now empty, remove the `params:` key entirely
    const remaining = experiment._doc.getIn(paramsPath, true);
    if (!remaining || !Array.isArray(remaining.items) || remaining.items.length === 0) {
        experiment._doc.deleteIn(paramsPath);
        if (cmd.params && Object.keys(cmd.params).length === 0) {
            delete cmd.params;
        }
    }
}

/**
 * docInsertCondition(experiment, name, commands)
 *
 * Append a new condition to `conditions:`. `name` must be a non-empty string
 * and unique across existing conditions. `commands` must be a non-empty array
 * (the spec requires at least one command per condition).
 *
 * Creates a fresh YAMLMap via _doc.createNode and pushes it to the conditions
 * seq, mirroring into the JS model. Use docAppendSequenceEntry separately if
 * the caller also wants a bare ref into the sequence.
 */
function docInsertCondition(experiment, name, commands) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docInsertCondition: experiment has no _doc handle', 'NO_DOC');
    }
    if (typeof name !== 'string' || !name.trim()) {
        throw new V3ParseError('docInsertCondition: name must be a non-empty string', 'INVALID_INPUT');
    }
    if (experiment.conditions.find((c) => c.name === name)) {
        throw new V3ParseError(
            'docInsertCondition: condition "' + name + '" already exists',
            'DUPLICATE_NAME'
        );
    }
    if (!Array.isArray(commands) || commands.length === 0) {
        throw new V3ParseError(
            'docInsertCondition: commands must be a non-empty array (spec requires at least one)',
            'INVALID_INPUT'
        );
    }

    const condsNode = experiment._doc.getIn(['conditions'], true);
    if (!condsNode || !Array.isArray(condsNode.items)) {
        throw new V3ParseError(
            'docInsertCondition: conditions seq node not found',
            'DOC_MODEL_DIVERGENCE'
        );
    }

    const newCondNode = experiment._doc.createNode({ name, commands });
    condsNode.items.push(newCondNode);

    experiment.conditions.push({
        name,
        commands: JSON.parse(JSON.stringify(commands))
    });
}

/**
 * docCloneCondition(experiment, srcIdx, newName)
 *
 * Duplicate the condition at srcIdx under a new name, preserving anchors and
 * comments from the source condition. Must clone the YAML node (not the JS
 * object) — doc.toJS() resolves aliases at parse time, so JS-model deep-copy
 * would lose anchor bindings like `command_name: *color_command`. The clone
 * keeps the alias references intact in the duplicate.
 */
function docCloneCondition(experiment, srcIdx, newName) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docCloneCondition: experiment has no _doc handle', 'NO_DOC');
    }
    if (typeof newName !== 'string' || !newName.trim()) {
        throw new V3ParseError('docCloneCondition: newName must be a non-empty string', 'INVALID_INPUT');
    }
    const src = experiment.conditions[srcIdx];
    if (!src) {
        throw new V3ParseError('docCloneCondition: bad srcIdx ' + srcIdx, 'BAD_PATH');
    }
    if (experiment.conditions.find((c) => c.name === newName)) {
        throw new V3ParseError(
            'docCloneCondition: condition "' + newName + '" already exists',
            'DUPLICATE_NAME'
        );
    }

    const condsNode = experiment._doc.getIn(['conditions'], true);
    const srcNode = experiment._doc.getIn(['conditions', srcIdx], true);
    if (!condsNode || !Array.isArray(condsNode.items) || !srcNode) {
        throw new V3ParseError(
            'docCloneCondition: conditions seq or source node not found',
            'DOC_MODEL_DIVERGENCE'
        );
    }

    // Deep clone the source YAML node so alias references are preserved.
    // yaml@2's node.clone() does a structural clone that retains Alias nodes
    // pointing at the same anchor names.
    const clonedNode = srcNode.clone(experiment._doc.schema);
    // Rewrite the `name:` field in the clone before splicing in
    if (typeof clonedNode.set === 'function') {
        clonedNode.set('name', newName);
    } else {
        for (const pair of clonedNode.items) {
            if (pair.key && (pair.key.value === 'name' || pair.key === 'name')) {
                pair.value = experiment._doc.createNode(newName);
                break;
            }
        }
    }
    condsNode.items.push(clonedNode);

    // Re-derive the JS model from the cloned node so the data shape matches
    // what parseV3Protocol would have produced (alias references resolve to
    // their values in toJS, but the YAML node retains the *alias for export).
    const newCondJs = {
        name: newName,
        commands: JSON.parse(JSON.stringify(src.commands))
    };
    experiment.conditions.push(newCondJs);
}

/**
 * Internal helper: build a YAMLSeq item and JS-mirror entry from a JS-side
 * sequence entry shape. Used by both docAppendSequenceEntry and
 * docInsertSequenceEntry so they construct identical structures.
 *
 * Returns { node, jsEntry } or throws V3ParseError on bad input.
 */
function _buildSequenceEntry(doc, entry) {
    if (!entry || typeof entry !== 'object') {
        throw new V3ParseError('sequence entry must be an object', 'INVALID_INPUT');
    }
    if (entry.kind === 'ref') {
        if (typeof entry.condition_name !== 'string' || !entry.condition_name) {
            throw new V3ParseError('ref entry needs a condition_name', 'INVALID_INPUT');
        }
        return {
            node: doc.createNode(entry.condition_name),
            jsEntry: { kind: 'ref', condition_name: entry.condition_name }
        };
    }
    if (entry.kind === 'block') {
        if (!Array.isArray(entry.trials) || entry.trials.length === 0) {
            throw new V3ParseError('block entry needs a non-empty trials list', 'INVALID_INPUT');
        }
        const blockShape = { trials: entry.trials.slice() };
        if (typeof entry.name === 'string' && entry.name) blockShape.name = entry.name;
        if (entry.repetitions !== undefined) {
            // Mirror the parser's validation: positive integer only. The
            // parser at lines ~335-349 already rejects 0/negatives/decimals;
            // without this guard, programmatic build paths (D4, paste-import)
            // would emit invalid YAML and the doc/JS-mirror could diverge
            // (entry.repetitions = 0 → YAML `0` but mirror = 1 via `|| 1`).
            if (typeof entry.repetitions !== 'number' || !Number.isInteger(entry.repetitions) || entry.repetitions < 1) {
                throw new V3ParseError(
                    '_buildSequenceEntry: invalid repetitions (must be positive integer): ' + JSON.stringify(entry.repetitions),
                    'INVALID_SCHEMA'
                );
            }
            blockShape.repetitions = entry.repetitions;
        }
        if (entry.randomize === true) blockShape.randomize = true;
        if (typeof entry.intertrial === 'string' && entry.intertrial) blockShape.intertrial = entry.intertrial;
        return {
            node: doc.createNode(blockShape),
            jsEntry: {
                kind: 'block',
                name: blockShape.name || null,
                trials: blockShape.trials,
                repetitions: blockShape.repetitions || 1,
                randomize: blockShape.randomize === true,
                intertrial: blockShape.intertrial || null,
                _unknownKeys: {}
            }
        };
    }
    throw new V3ParseError('entry.kind must be "ref" or "block"', 'INVALID_INPUT');
}

/**
 * docInsertSequenceEntry(experiment, atIdx, entry)
 *
 * Insert a sequence entry at position `atIdx`. atIdx is clamped to
 * [0, sequence.length] so passing sequence.length is equivalent to
 * docAppendSequenceEntry.
 *
 * Used by the +Add UI in the sequence pane and (in Phase 4b) by
 * library-to-sequence drag/drop with a target index.
 */
function docInsertSequenceEntry(experiment, atIdx, entry) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docInsertSequenceEntry: experiment has no _doc handle', 'NO_DOC');
    }
    const seqNode = experiment._doc.getIn(['experiment'], true);
    if (!seqNode || !Array.isArray(seqNode.items)) {
        throw new V3ParseError(
            'docInsertSequenceEntry: experiment seq node not found',
            'DOC_MODEL_DIVERGENCE'
        );
    }
    const built = _buildSequenceEntry(experiment._doc, entry);
    const clamped = Math.max(0, Math.min(atIdx, experiment.sequence.length));
    seqNode.items.splice(clamped, 0, built.node);
    experiment.sequence.splice(clamped, 0, built.jsEntry);
}

/**
 * docMoveSequenceEntry(experiment, fromIdx, toIdx)
 *
 * Reorder a top-level sequence entry from fromIdx to toIdx. Both indices are
 * bounds-checked; no-op if out of range or fromIdx === toIdx. Throws on
 * doc/model divergence (matching docMoveCommand's contract).
 */
function docMoveSequenceEntry(experiment, fromIdx, toIdx) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docMoveSequenceEntry: experiment has no _doc handle', 'NO_DOC');
    }
    const n = experiment.sequence.length;
    if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n || fromIdx === toIdx) return;

    const seqNode = experiment._doc.getIn(['experiment'], true);
    if (!seqNode || !Array.isArray(seqNode.items)) {
        throw new V3ParseError(
            'docMoveSequenceEntry: doc/model divergence — no experiment seq node',
            'DOC_MODEL_DIVERGENCE'
        );
    }

    const movedNode = seqNode.items.splice(fromIdx, 1)[0];
    seqNode.items.splice(toIdx, 0, movedNode);

    const movedJs = experiment.sequence.splice(fromIdx, 1)[0];
    experiment.sequence.splice(toIdx, 0, movedJs);
}

/**
 * docRemoveSequenceEntry(experiment, idx)
 *
 * Remove the sequence entry at `idx` from both _doc and the JS mirror.
 * Throws on out-of-bounds rather than silently no-op'ing — accidental
 * deletes should surface immediately.
 */
function docRemoveSequenceEntry(experiment, idx) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docRemoveSequenceEntry: experiment has no _doc handle', 'NO_DOC');
    }
    const n = experiment.sequence.length;
    if (idx < 0 || idx >= n) {
        throw new V3ParseError(
            'docRemoveSequenceEntry: idx ' + idx + ' out of bounds [0, ' + n + ')',
            'BAD_PATH'
        );
    }
    const seqNode = experiment._doc.getIn(['experiment'], true);
    if (!seqNode || !Array.isArray(seqNode.items)) {
        throw new V3ParseError(
            'docRemoveSequenceEntry: doc/model divergence — no experiment seq node',
            'DOC_MODEL_DIVERGENCE'
        );
    }
    seqNode.items.splice(idx, 1);
    experiment.sequence.splice(idx, 1);
}

/**
 * docReplaceSequenceEntry(experiment, idx, newEntry)
 *
 * Replace the sequence entry at `idx` with a fresh ref or block built from
 * `newEntry`. Used by the ref↔block convert affordance. Validates the new
 * entry via _buildSequenceEntry (same kinds/shape as insert/append).
 *
 * Throws on out-of-bounds and on doc/model divergence.
 */
function docReplaceSequenceEntry(experiment, idx, newEntry) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docReplaceSequenceEntry: experiment has no _doc handle', 'NO_DOC');
    }
    const n = experiment.sequence.length;
    if (idx < 0 || idx >= n) {
        throw new V3ParseError(
            'docReplaceSequenceEntry: idx ' + idx + ' out of bounds [0, ' + n + ')',
            'BAD_PATH'
        );
    }
    const seqNode = experiment._doc.getIn(['experiment'], true);
    if (!seqNode || !Array.isArray(seqNode.items)) {
        throw new V3ParseError(
            'docReplaceSequenceEntry: doc/model divergence — no experiment seq node',
            'DOC_MODEL_DIVERGENCE'
        );
    }
    const built = _buildSequenceEntry(experiment._doc, newEntry);
    seqNode.items[idx] = built.node;
    experiment.sequence[idx] = built.jsEntry;
}

/**
 * docInsertTrialInBlock(experiment, blockIdx, atIdx, condName)
 *
 * Insert a trial reference (a condition name string) into the block at
 * `blockIdx`'s `trials:` seq. atIdx is clamped to [0, trials.length] so
 * passing trials.length appends.
 */
function docInsertTrialInBlock(experiment, blockIdx, atIdx, condName) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docInsertTrialInBlock: experiment has no _doc handle', 'NO_DOC');
    }
    const block = experiment.sequence[blockIdx];
    if (!block || block.kind !== 'block') {
        throw new V3ParseError(
            'docInsertTrialInBlock: sequence[' + blockIdx + '] is not a block',
            'INVALID_INPUT'
        );
    }
    if (typeof condName !== 'string' || !condName) {
        throw new V3ParseError(
            'docInsertTrialInBlock: condName must be a non-empty string',
            'INVALID_INPUT'
        );
    }
    const trialsNode = experiment._doc.getIn(['experiment', blockIdx, 'trials'], true);
    if (!trialsNode || !Array.isArray(trialsNode.items)) {
        throw new V3ParseError(
            'docInsertTrialInBlock: trials seq node missing at experiment[' + blockIdx + ']',
            'DOC_MODEL_DIVERGENCE'
        );
    }
    const clamped = Math.max(0, Math.min(atIdx, block.trials.length));
    trialsNode.items.splice(clamped, 0, experiment._doc.createNode(condName));
    block.trials.splice(clamped, 0, condName);
}

/**
 * docMoveTrialInBlock(experiment, blockIdx, fromIdx, toIdx)
 *
 * Reorder a trial within a block's `trials:` seq. Bounds-checked; no-op on
 * same-idx or out-of-range. Throws on doc/model divergence.
 */
function docMoveTrialInBlock(experiment, blockIdx, fromIdx, toIdx) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docMoveTrialInBlock: experiment has no _doc handle', 'NO_DOC');
    }
    const block = experiment.sequence[blockIdx];
    if (!block || block.kind !== 'block') {
        throw new V3ParseError(
            'docMoveTrialInBlock: sequence[' + blockIdx + '] is not a block',
            'INVALID_INPUT'
        );
    }
    const n = block.trials.length;
    if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n || fromIdx === toIdx) return;

    const trialsNode = experiment._doc.getIn(['experiment', blockIdx, 'trials'], true);
    if (!trialsNode || !Array.isArray(trialsNode.items)) {
        throw new V3ParseError(
            'docMoveTrialInBlock: doc/model divergence — no trials seq at experiment[' + blockIdx + ']',
            'DOC_MODEL_DIVERGENCE'
        );
    }
    const moved = trialsNode.items.splice(fromIdx, 1)[0];
    trialsNode.items.splice(toIdx, 0, moved);
    const movedJs = block.trials.splice(fromIdx, 1)[0];
    block.trials.splice(toIdx, 0, movedJs);
}

/**
 * docRemoveTrialFromBlock(experiment, blockIdx, trialIdx)
 *
 * Delete the trial at trialIdx from the block at blockIdx. Throws on
 * out-of-bounds. v3 spec requires a non-empty trials list, so removing the
 * last trial would produce an invalid block — guard against that here.
 */
function docRemoveTrialFromBlock(experiment, blockIdx, trialIdx) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docRemoveTrialFromBlock: experiment has no _doc handle', 'NO_DOC');
    }
    const block = experiment.sequence[blockIdx];
    if (!block || block.kind !== 'block') {
        throw new V3ParseError(
            'docRemoveTrialFromBlock: sequence[' + blockIdx + '] is not a block',
            'INVALID_INPUT'
        );
    }
    const n = block.trials.length;
    if (trialIdx < 0 || trialIdx >= n) {
        throw new V3ParseError(
            'docRemoveTrialFromBlock: trialIdx ' + trialIdx + ' out of bounds [0, ' + n + ')',
            'BAD_PATH'
        );
    }
    if (n === 1) {
        throw new V3ParseError(
            'docRemoveTrialFromBlock: cannot remove the last trial — v3 spec requires non-empty trials. Remove the whole block instead.',
            'INVALID_INPUT'
        );
    }
    const trialsNode = experiment._doc.getIn(['experiment', blockIdx, 'trials'], true);
    if (!trialsNode || !Array.isArray(trialsNode.items)) {
        throw new V3ParseError(
            'docRemoveTrialFromBlock: doc/model divergence — no trials seq at experiment[' + blockIdx + ']',
            'DOC_MODEL_DIVERGENCE'
        );
    }
    trialsNode.items.splice(trialIdx, 1);
    block.trials.splice(trialIdx, 1);
}

/**
 * docAppendSequenceEntry(experiment, entry)
 *
 * Append an entry to `experiment:` (the sequence). `entry` can be a ref —
 * { kind: 'ref', condition_name: '<name>' } — or a block —
 * { kind: 'block', name?, trials, repetitions?, randomize?, intertrial? }.
 *
 * Used by the library + Add and Duplicate flows to auto-wire the new
 * condition into the experiment sequence.
 */
function docAppendSequenceEntry(experiment, entry) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docAppendSequenceEntry: experiment has no _doc handle', 'NO_DOC');
    }
    const seqNode = experiment._doc.getIn(['experiment'], true);
    if (!seqNode || !Array.isArray(seqNode.items)) {
        throw new V3ParseError(
            'docAppendSequenceEntry: experiment seq node not found',
            'DOC_MODEL_DIVERGENCE'
        );
    }
    const built = _buildSequenceEntry(experiment._doc, entry);
    seqNode.items.push(built.node);
    experiment.sequence.push(built.jsEntry);
}


/**
 * docDelete(experiment, path)
 *
 * Removes the key at `path` from both the YAML.Document and the JS data
 * model. Used for clearing optional fields (e.g., block `intertrial` →
 * "none", block `name` cleared). For our JS model, optional string fields
 * that were `null` when absent get set back to `null` after delete; map
 * keys that don't normalize to a model field are deleted outright.
 */
function docDelete(experiment, path) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docDelete: experiment has no _doc handle', 'NO_DOC');
    }
    if (!Array.isArray(path) || path.length === 0) {
        throw new V3ParseError('docDelete: path must be a non-empty array', 'BAD_PATH');
    }
    experiment._doc.deleteIn(path);

    const jsPath = [...path];
    if (jsPath[0] === 'experiment') jsPath[0] = 'sequence';
    else if (jsPath[0] === 'rig') jsPath[0] = 'rig_path';

    let cursor = experiment;
    for (let i = 0; i < jsPath.length - 1; i++) {
        if (cursor == null) return;
        cursor = cursor[jsPath[i]];
    }
    if (cursor != null && jsPath.length > 0) {
        const lastKey = jsPath[jsPath.length - 1];
        // Block-level optional fields parse to `null` when missing; mirror that.
        const optionalNullableBlockFields = ['name', 'intertrial'];
        if (
            jsPath[0] === 'sequence' &&
            jsPath.length === 3 &&
            optionalNullableBlockFields.includes(lastKey)
        ) {
            cursor[lastKey] = null;
        } else if (Array.isArray(cursor)) {
            cursor.splice(lastKey, 1);
        } else {
            delete cursor[lastKey];
        }
    }
}

// ════════════════════════════════════════════════════
// Phase 5 — Variables (anchor) lifecycle helpers
//
// Anchors are first-class YAML CST nodes on `_doc`. The JS mirror
// (`experiment.variables[]`) always holds the *resolved* values; the
// `_doc` is the only place that knows about aliasing. These helpers
// preserve that invariant.
//
// Helper inventory:
//   docCreateVariable(exp, name, value)
//   docDeleteVariable(exp, name, opts?)
//   docRenameVariable(exp, oldName, newName)
//   docSetVariableValue(exp, name, newValue)
//   docBindToAnchor(exp, path, anchorName)
//   docUnbindAnchor(exp, path)
//   findAliasesTo(exp, anchorName)
//   variableIsComplex(exp, name)
//   isValidAnchorName(name)
//   anchorExists(exp, name)
// ════════════════════════════════════════════════════

const _ANCHOR_NAME_RE = /^[A-Za-z0-9_-]+$/;

function isValidAnchorName(name) {
    return typeof name === 'string' && _ANCHOR_NAME_RE.test(name);
}

// Internal: locate the defining Pair of `name` in the variables: map.
// Prefers anchor identity (pair.value.anchor), falls back to map key.
function _findVariablePair(experiment, name) {
    if (!experiment || !experiment._doc) return null;
    const varsNode = experiment._doc.get('variables', true);
    if (!varsNode || !Array.isArray(varsNode.items)) return null;
    for (let i = 0; i < varsNode.items.length; i++) {
        const pair = varsNode.items[i];
        const anchorName = pair.value && pair.value.anchor ? pair.value.anchor : null;
        const mapKey =
            pair.key && pair.key.value !== undefined ? pair.key.value : String(pair.key);
        const identity = anchorName || mapKey;
        if (identity === name) return { pair, index: i, varsNode };
    }
    return null;
}

// True if `name` is in use as an anchor anywhere in the document.
// Walks every Scalar/Map/Seq node; needs to be doc-wide because anchors
// can legally sit on non-variables values (rare but legal).
function anchorExists(experiment, name) {
    if (!experiment || !experiment._doc) return false;
    if (!isValidAnchorName(name)) return false;
    let found = false;
    if (typeof YAML.visit !== 'function') return false;
    YAML.visit(experiment._doc, {
        Node(_, node) {
            if (node && node.anchor === name) {
                found = true;
                return YAML.visit.BREAK;
            }
        }
    });
    return found;
}

// True if the anchor's defining value node is a Map or Seq (not a Scalar).
// The Variables UI renders complex anchors as read-only badges.
function variableIsComplex(experiment, name) {
    const found = _findVariablePair(experiment, name);
    if (!found) return false;
    const v = found.pair.value;
    return !!(v && (YAML.isMap?.(v) || YAML.isSeq?.(v)));
}

// Walk the doc collecting every Alias whose `.source` matches anchorName.
// Returns [{ path, humanLabel }] in document order. Recursive walk because
// YAML.visit's ancestors chain mixes Pair/Map/Seq/Scalar in ways that are
// fiddly to translate into a flat path; doing the walk ourselves with an
// explicit accumulator is simpler and easier to reason about.
function findAliasesTo(experiment, anchorName) {
    const out = [];
    if (!experiment || !experiment._doc) return out;
    const root = experiment._doc.contents;
    if (!root) return out;
    _walkForAliases(root, [], anchorName, out);
    return out;
}

function _walkForAliases(node, path, anchorName, out) {
    if (!node) return;
    if (YAML.isAlias?.(node)) {
        if (node.source === anchorName) {
            out.push({ path: path.slice(), humanLabel: _humanLabelForPath(path) });
        }
        return;
    }
    if (YAML.isMap?.(node)) {
        for (const pair of node.items) {
            const key =
                pair.key && pair.key.value !== undefined ? pair.key.value : String(pair.key);
            _walkForAliases(pair.value, [...path, key], anchorName, out);
        }
        return;
    }
    if (YAML.isSeq?.(node)) {
        for (let i = 0; i < node.items.length; i++) {
            _walkForAliases(node.items[i], [...path, i], anchorName, out);
        }
        return;
    }
    // Scalars / unknown: no recursion.
}

// Best-effort human label for an alias path — e.g. "conditions[2].commands[1].duration".
function _humanLabelForPath(path) {
    if (!path || path.length === 0) return '<root>';
    const parts = [];
    for (let i = 0; i < path.length; i++) {
        const p = path[i];
        if (typeof p === 'number') {
            parts[parts.length - 1] = (parts[parts.length - 1] || '') + '[' + p + ']';
        } else {
            parts.push(String(p));
        }
    }
    return parts.join('.');
}

/**
 * docCreateVariable(experiment, name, value)
 *
 * Append `&name: value` to the variables: map. If no variables: section
 * exists, create one at the top-level. Mirror into experiment.variables.
 *
 * Throws V3ParseError(INVALID_INPUT) on:
 *   - invalid anchor name (regex)
 *   - duplicate anchor (anywhere in the doc, not just variables)
 *   - non-scalar value (caller should construct via setIn for maps/seqs)
 */
function docCreateVariable(experiment, name, value) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docCreateVariable: experiment has no _doc handle', 'NO_DOC');
    }
    if (!isValidAnchorName(name)) {
        throw new V3ParseError(
            'docCreateVariable: invalid anchor name ' + JSON.stringify(name) +
                ' (must match /^[A-Za-z0-9_-]+$/)',
            'INVALID_INPUT'
        );
    }
    if (anchorExists(experiment, name)) {
        throw new V3ParseError(
            'docCreateVariable: anchor name "' + name + '" is already in use',
            'INVALID_INPUT'
        );
    }

    // Find or create the variables: map. yaml@2's setIn replaces nodes
    // wholesale, so we create a fresh YAMLMap only if absent.
    let varsNode = experiment._doc.get('variables', true);
    if (!varsNode || !Array.isArray(varsNode.items)) {
        const newMap = experiment._doc.createNode({});
        experiment._doc.set('variables', newMap);
        varsNode = experiment._doc.get('variables', true);
    }

    // Build the scalar with the anchor attached, then assemble the pair.
    const valueNode = experiment._doc.createNode(value);
    valueNode.anchor = name;
    const keyNode = experiment._doc.createNode(name);
    varsNode.items.push(new YAML.Pair(keyNode, valueNode));

    // Mirror
    if (!Array.isArray(experiment.variables)) experiment.variables = [];
    experiment.variables.push({ name: name, value: value });
}

/**
 * docDeleteVariable(experiment, name, opts = { cascadeUnbind: false })
 *
 * Remove the anchor's defining pair from the variables: map. If aliases
 * reference this anchor:
 *   - opts.cascadeUnbind === false (default) → throws ANCHOR_HAS_REFS
 *   - opts.cascadeUnbind === true → unbinds each reference first (each
 *     becomes a literal with the resolved value)
 *
 * Mirrors the JS-side variable list. Aliased path mirrors are unchanged
 * (the JS mirror always holds resolved values).
 */
function docDeleteVariable(experiment, name, opts) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docDeleteVariable: experiment has no _doc handle', 'NO_DOC');
    }
    const cascade = !!(opts && opts.cascadeUnbind);
    const found = _findVariablePair(experiment, name);
    if (!found) {
        throw new V3ParseError(
            'docDeleteVariable: no anchor named "' + name + '"',
            'BAD_PATH'
        );
    }
    const refs = findAliasesTo(experiment, name);
    if (refs.length > 0 && !cascade) {
        const err = new V3ParseError(
            'docDeleteVariable: anchor "' + name + '" still has ' + refs.length +
                ' reference(s); pass {cascadeUnbind: true} to unbind them first',
            'ANCHOR_HAS_REFS'
        );
        err.refCount = refs.length;
        err.refs = refs;
        throw err;
    }
    // Cascade-unbind: convert every alias to its literal value before
    // removing the anchor. Walk the refs list AFTER capturing it (the doc
    // walks are stable across mutations of unrelated nodes).
    if (cascade) {
        for (const ref of refs) {
            docUnbindAnchor(experiment, ref.path);
        }
    }
    found.varsNode.items.splice(found.index, 1);

    // Mirror
    if (Array.isArray(experiment.variables)) {
        const mirrorIdx = experiment.variables.findIndex((v) => v.name === name);
        if (mirrorIdx >= 0) experiment.variables.splice(mirrorIdx, 1);
    }
}

/**
 * docRenameVariable(experiment, oldName, newName)
 *
 * Atomic rename in a single synchronous pass:
 *   1. Rewrite the anchor at the defining Scalar (`pair.value.anchor`).
 *   2. Walk every Alias and rewrite `.source` where it matches oldName.
 *   3. Update the JS mirror entry.
 *
 * Throws V3ParseError(INVALID_INPUT) on invalid newName or collision.
 * BAD_PATH if oldName is not declared.
 */
function docRenameVariable(experiment, oldName, newName) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docRenameVariable: experiment has no _doc handle', 'NO_DOC');
    }
    if (oldName === newName) return;
    if (!isValidAnchorName(newName)) {
        throw new V3ParseError(
            'docRenameVariable: invalid new anchor name ' + JSON.stringify(newName),
            'INVALID_INPUT'
        );
    }
    if (anchorExists(experiment, newName)) {
        throw new V3ParseError(
            'docRenameVariable: anchor name "' + newName + '" is already in use',
            'INVALID_INPUT'
        );
    }
    const found = _findVariablePair(experiment, oldName);
    if (!found) {
        throw new V3ParseError(
            'docRenameVariable: no anchor named "' + oldName + '"',
            'BAD_PATH'
        );
    }
    // 1. Rename at the definition site.
    if (found.pair.value) found.pair.value.anchor = newName;

    // 2. Cascade to every alias. Single YAML.visit pass.
    if (typeof YAML.visit === 'function') {
        YAML.visit(experiment._doc, {
            Alias(_, node) {
                if (node && node.source === oldName) {
                    node.source = newName;
                }
            }
        });
    }

    // 3. Mirror.
    if (Array.isArray(experiment.variables)) {
        const mirrorIdx = experiment.variables.findIndex((v) => v.name === oldName);
        if (mirrorIdx >= 0) experiment.variables[mirrorIdx].name = newName;
    }
}

/**
 * docSetVariableValue(experiment, name, newValue)
 *
 * Change the scalar value AT the anchor's definition site. Does NOT
 * touch aliases (they resolve dynamically). Critically, this MUST mutate
 * the existing Scalar's `.value` in place rather than swap the value
 * node — otherwise the anchor is lost.
 *
 * Updates the JS mirror (both the variable entry and every aliased
 * path's resolved value).
 */
function docSetVariableValue(experiment, name, newValue) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docSetVariableValue: experiment has no _doc handle', 'NO_DOC');
    }
    const found = _findVariablePair(experiment, name);
    if (!found) {
        throw new V3ParseError(
            'docSetVariableValue: no anchor named "' + name + '"',
            'BAD_PATH'
        );
    }
    if (variableIsComplex(experiment, name)) {
        throw new V3ParseError(
            'docSetVariableValue: anchor "' + name + '" is complex (Map/Seq); ' +
                'use scalar values only or edit YAML directly',
            'INVALID_INPUT'
        );
    }
    // Mutate the Scalar in place so the anchor stays attached.
    if (found.pair.value) found.pair.value.value = newValue;

    // Mirror the variable entry.
    if (Array.isArray(experiment.variables)) {
        const v = experiment.variables.find((v) => v.name === name);
        if (v) v.value = newValue;
    }

    // Mirror every aliased path's resolved value (JS mirror holds resolved).
    const refs = findAliasesTo(experiment, name);
    for (const ref of refs) {
        mirrorIntoModel(experiment, ref.path, newValue);
    }
}

/**
 * docBindToAnchor(experiment, path, anchorName)
 *
 * Replace the literal scalar at `path` with an Alias pointing to
 * `anchorName`. The anchor must already exist (use docCreateVariable
 * first to make a fresh one). Updates the JS mirror to the resolved
 * value (the mirror never sees aliases).
 */
function docBindToAnchor(experiment, path, anchorName) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docBindToAnchor: experiment has no _doc handle', 'NO_DOC');
    }
    if (!Array.isArray(path) || path.length === 0) {
        throw new V3ParseError('docBindToAnchor: path must be a non-empty array', 'BAD_PATH');
    }
    if (!isValidAnchorName(anchorName)) {
        throw new V3ParseError(
            'docBindToAnchor: invalid anchor name ' + JSON.stringify(anchorName),
            'INVALID_INPUT'
        );
    }
    const varPair = _findVariablePair(experiment, anchorName);
    if (!varPair) {
        throw new V3ParseError(
            'docBindToAnchor: anchor "' + anchorName + '" is not declared in variables',
            'BAD_PATH'
        );
    }
    // Build the Alias node and stash it at path.
    const alias = new YAML.Alias(anchorName);
    experiment._doc.setIn(path, alias);

    // Mirror: resolved value from the anchor's scalar.
    let resolved;
    const v = varPair.pair.value;
    if (v && v.value !== undefined) resolved = v.value;
    else if (v && typeof v.toJSON === 'function') resolved = v.toJSON();
    else resolved = v;
    mirrorIntoModel(experiment, path, resolved);
}

/**
 * docUnbindAnchor(experiment, path)
 *
 * If the node at `path` is an Alias, replace it with its resolved
 * literal value. Throws NOT_ALIAS if the path doesn't currently hold
 * an Alias — caller should check `nodeIsAliasAt` first.
 */
function docUnbindAnchor(experiment, path) {
    if (!experiment || !experiment._doc) {
        throw new V3ParseError('docUnbindAnchor: experiment has no _doc handle', 'NO_DOC');
    }
    if (!Array.isArray(path) || path.length === 0) {
        throw new V3ParseError('docUnbindAnchor: path must be a non-empty array', 'BAD_PATH');
    }
    const node = experiment._doc.getIn(path, true);
    const isAlias = node && (YAML.isAlias?.(node) || node.constructor?.name === 'Alias');
    if (!node || !isAlias) {
        throw new V3ParseError(
            'docUnbindAnchor: path does not point to an Alias',
            'NOT_ALIAS'
        );
    }
    const anchorName = node.source;
    const varPair = _findVariablePair(experiment, anchorName);
    let resolved;
    if (varPair) {
        const v = varPair.pair.value;
        if (v && v.value !== undefined) resolved = v.value;
        else if (v && typeof v.toJSON === 'function') resolved = v.toJSON();
        else resolved = v;
    } else {
        // Dangling alias (shouldn't happen post-parse). Fall back to the
        // path's current resolved JS-mirror value, if any.
        resolved = experiment._doc.getIn(path);
    }
    experiment._doc.setIn(path, resolved);
    // JS mirror was already holding the resolved value — no-op.
}

// ════════════════════════════════════════════════════
// Exports
// ════════════════════════════════════════════════════

const ProtocolV3 = {
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
    docInsertSequenceEntry,
    docMoveSequenceEntry,
    docRemoveSequenceEntry,
    docReplaceSequenceEntry,
    docInsertTrialInBlock,
    docMoveTrialInBlock,
    docRemoveTrialFromBlock,
    docSetPluginCommandHead,
    docAddPluginParam,
    docDeletePluginParam,
    nodeIsAliasAt,
    aliasNameAt,
    // Phase 5
    docCreateVariable,
    docDeleteVariable,
    docRenameVariable,
    docSetVariableValue,
    docBindToAnchor,
    docUnbindAnchor,
    findAliasesTo,
    variableIsComplex,
    isValidAnchorName,
    anchorExists
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
export {
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
    docInsertSequenceEntry,
    docMoveSequenceEntry,
    docRemoveSequenceEntry,
    docReplaceSequenceEntry,
    docInsertTrialInBlock,
    docMoveTrialInBlock,
    docRemoveTrialFromBlock,
    docSetPluginCommandHead,
    docAddPluginParam,
    docDeletePluginParam,
    nodeIsAliasAt,
    aliasNameAt,
    // Phase 5
    docCreateVariable,
    docDeleteVariable,
    docRenameVariable,
    docSetVariableValue,
    docBindToAnchor,
    docUnbindAnchor,
    findAliasesTo,
    variableIsComplex,
    isValidAnchorName,
    anchorExists
};
export default ProtocolV3;
