/**
 * runtime-controls.js — constrained, auditable protocol-v3 runtime overrides.
 *
 * This module implements the deliberately small mechanism described in
 * docs/development/flow-control-counter-proposal.md:
 *
 *   - only variables explicitly declared in `runtime_controls:` may change;
 *   - Apply stages a request, but does not change the active trial;
 *   - all pending requests become effective atomically at `beginTrial()`;
 *   - source YAML / the parsed YAML.Document are never mutated; and
 *   - every trial returns resolved commands plus the provenance needed for JSONL.
 *
 * LOADING: classic <script src> (window global + CommonJS dual export). The
 * protocol must be the object returned by `parseV3Protocol()`, including its
 * read-only `_doc` handle; no YAML library is imported here.
 */
(function (global) {
    'use strict';

    const SUPPORTED_TYPES = new Set(['number', 'integer', 'boolean', 'enum']);
    const STRUCTURAL_COMMAND_FIELDS = new Set([
        'type',
        'command_name',
        'plugin_name',
        // Pattern switching/caching is explicitly deferred by the proposal.
        'pattern',
        'pattern_ID'
    ]);

    class RuntimeControlError extends Error {
        constructor(message, code, details) {
            super(message);
            this.name = 'RuntimeControlError';
            this.code = code || 'RUNTIME_CONTROL_ERROR';
            this.details = details === undefined ? null : clone(details);
        }
    }

    function clone(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    function isPlainObject(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    }

    function sameValue(a, b) {
        return Object.is(a, b);
    }

    function valueLabel(value) {
        try {
            return JSON.stringify(value);
        } catch (_) {
            return String(value);
        }
    }

    function issue(code, message, variable, path) {
        const out = { code: code, message: message };
        if (variable !== undefined && variable !== null) out.variable = String(variable);
        if (path) out.path = clone(path);
        return out;
    }

    function normalizeTime(value, fieldName) {
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) {
            throw new RuntimeControlError(
                fieldName + ' must be a valid Date, timestamp, or ISO string',
                'INVALID_TIME',
                { field: fieldName, value: value }
            );
        }
        return d.toISOString();
    }

    function nonEmptyString(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    /**
     * Validate one value against a normalized (or declaration-shaped) control.
     * Returns a report rather than throwing so forms can show errors inline.
     */
    function validateRuntimeControlValue(definition, value) {
        const type = definition && definition.type;
        let message = null;

        if (type === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                message = 'must be a finite number';
            }
        } else if (type === 'integer') {
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                message = 'must be an integer';
            }
        } else if (type === 'boolean') {
            if (typeof value !== 'boolean') message = 'must be a Boolean';
        } else if (type === 'enum') {
            const values = definition.values;
            if (
                !Array.isArray(values) ||
                !values.some((candidate) => sameValue(candidate, value))
            ) {
                message = 'must be one of ' + valueLabel(values || []);
            }
        } else {
            message = 'uses unsupported type ' + valueLabel(type);
        }

        if (
            message === null &&
            (type === 'number' || type === 'integer') &&
            typeof definition.minimum === 'number' &&
            value < definition.minimum
        ) {
            message = 'must be greater than or equal to ' + definition.minimum;
        }
        if (
            message === null &&
            (type === 'number' || type === 'integer') &&
            typeof definition.maximum === 'number' &&
            value > definition.maximum
        ) {
            message = 'must be less than or equal to ' + definition.maximum;
        }

        return message === null
            ? { ok: true, error: null }
            : {
                  ok: false,
                  error: issue(
                      'INVALID_CONTROL_VALUE',
                      'Runtime control value ' + valueLabel(value) + ' ' + message
                  )
              };
    }

    function nodeKind(node) {
        return node && node.constructor && node.constructor.name
            ? node.constructor.name
            : node && node.type
              ? String(node.type)
              : '';
    }

    function isAliasNode(node) {
        const kind = nodeKind(node);
        return kind === 'Alias' || kind === 'ALIAS';
    }

    function isPairNode(node) {
        const kind = nodeKind(node);
        return kind === 'Pair' || (!!node && 'key' in node && 'value' in node);
    }

    function mapKey(node) {
        if (node && Object.prototype.hasOwnProperty.call(node, 'value')) return node.value;
        if (node && typeof node.toJSON === 'function') return node.toJSON();
        return String(node);
    }

    // YAML-node walker implemented by duck typing so this classic module does
    // not import the ESM-only yaml package. Paths use normal JS map keys/indices.
    function walkAliases(node, path, visit) {
        if (!node) return;
        if (isAliasNode(node)) {
            visit(node, path);
            return;
        }

        if (node.contents) {
            walkAliases(node.contents, path, visit);
            return;
        }

        if (!Array.isArray(node.items)) return;
        const kind = nodeKind(node);
        const isMap = kind === 'YAMLMap' || node.items.some((item) => isPairNode(item));
        if (isMap) {
            for (const pair of node.items) {
                if (!isPairNode(pair)) continue;
                walkAliases(pair.value, path.concat([mapKey(pair.key)]), visit);
            }
            return;
        }
        for (let i = 0; i < node.items.length; i++) {
            walkAliases(node.items[i], path.concat([i]), visit);
        }
    }

    function commandBindingFromPath(protocol, variable, path) {
        const allowed =
            path.length >= 5 &&
            path[0] === 'conditions' &&
            Number.isInteger(path[1]) &&
            path[2] === 'commands' &&
            Number.isInteger(path[3]);
        if (!allowed) return null;

        const conditionIndex = path[1];
        const commandIndex = path[3];
        const parameterPath = path.slice(4);
        const condition = protocol.conditions && protocol.conditions[conditionIndex];
        if (!condition || !nonEmptyString(condition.name)) return null;
        if (
            parameterPath.length === 0 ||
            STRUCTURAL_COMMAND_FIELDS.has(String(parameterPath[0])) ||
            (parameterPath.length === 1 && parameterPath[0] === 'params')
        ) {
            return {
                invalid: true,
                condition_name: condition.name,
                condition_index: conditionIndex,
                command_index: commandIndex,
                parameter_path: parameterPath,
                variable: variable
            };
        }
        return {
            variable: variable,
            condition_name: condition.name,
            condition_index: conditionIndex,
            command_index: commandIndex,
            parameter_path: parameterPath
        };
    }

    /**
     * Validate declarations, defaults, and every alias use of a declared control.
     *
     * @returns {{ok:boolean, errors:object[], warnings:object[], controls:object,
     *            bindings:object[]}}
     */
    function validateRuntimeControls(protocol) {
        const errors = [];
        const warnings = [];
        const controls = {};
        const bindings = [];

        if (!protocol || typeof protocol !== 'object') {
            return {
                ok: false,
                errors: [issue('INVALID_PROTOCOL', 'A parsed v3 protocol object is required')],
                warnings: warnings,
                controls: controls,
                bindings: bindings
            };
        }

        const declarations =
            protocol.runtime_controls === undefined ? {} : protocol.runtime_controls;
        if (!isPlainObject(declarations)) {
            return {
                ok: false,
                errors: [
                    issue(
                        'INVALID_RUNTIME_CONTROLS',
                        '`runtime_controls:` must be a mapping keyed by variable name'
                    )
                ],
                warnings: warnings,
                controls: controls,
                bindings: bindings
            };
        }

        const variables = new Map();
        for (const entry of Array.isArray(protocol.variables) ? protocol.variables : []) {
            if (!entry || !nonEmptyString(entry.name)) continue;
            if (variables.has(entry.name)) {
                errors.push(
                    issue(
                        'DUPLICATE_VARIABLE',
                        'Variable "' + entry.name + '" is defined more than once',
                        entry.name
                    )
                );
            } else {
                variables.set(entry.name, entry.value);
            }
        }

        for (const name of Object.keys(declarations)) {
            const raw = declarations[name];
            if (!nonEmptyString(name)) {
                errors.push(
                    issue('INVALID_CONTROL_NAME', 'Runtime control names may not be empty')
                );
                continue;
            }
            if (!variables.has(name)) {
                errors.push(
                    issue(
                        'UNDECLARED_VARIABLE',
                        'Runtime control "' + name + '" does not match an existing variable',
                        name
                    )
                );
            }
            if (!isPlainObject(raw)) {
                errors.push(
                    issue(
                        'INVALID_CONTROL_DECLARATION',
                        'Runtime control "' + name + '" must be a mapping',
                        name
                    )
                );
                continue;
            }

            const type = raw.type;
            if (!SUPPORTED_TYPES.has(type)) {
                errors.push(
                    issue(
                        'UNSUPPORTED_CONTROL_TYPE',
                        'Runtime control "' + name + '" must use number, integer, boolean, or enum',
                        name
                    )
                );
                continue;
            }

            const normalized = {
                name: name,
                type: type,
                default_value: clone(variables.get(name))
            };
            if (raw.units !== undefined) {
                if (!nonEmptyString(raw.units)) {
                    errors.push(
                        issue(
                            'INVALID_UNITS',
                            'Runtime control "' + name + '" units must be a non-empty string',
                            name
                        )
                    );
                } else {
                    normalized.units = raw.units;
                }
            }
            if (nonEmptyString(raw.label)) normalized.label = raw.label;
            if (nonEmptyString(raw.description)) normalized.description = raw.description;

            let schemaValid = true;
            if (type === 'number' || type === 'integer') {
                const boundsValid =
                    typeof raw.minimum === 'number' &&
                    Number.isFinite(raw.minimum) &&
                    typeof raw.maximum === 'number' &&
                    Number.isFinite(raw.maximum) &&
                    raw.minimum <= raw.maximum &&
                    (type !== 'integer' ||
                        (Number.isInteger(raw.minimum) && Number.isInteger(raw.maximum)));
                if (!boundsValid) {
                    schemaValid = false;
                    errors.push(
                        issue(
                            'INVALID_NUMERIC_RANGE',
                            'Runtime control "' +
                                name +
                                '" must declare a valid minimum and maximum' +
                                (type === 'integer' ? ' using integers' : ''),
                            name
                        )
                    );
                } else {
                    normalized.minimum = raw.minimum;
                    normalized.maximum = raw.maximum;
                }
            } else if (type === 'enum') {
                const values = raw.values;
                const valuesValid =
                    Array.isArray(values) &&
                    values.length > 0 &&
                    values.every(
                        (value) =>
                            (typeof value === 'string' ||
                                typeof value === 'number' ||
                                typeof value === 'boolean') &&
                            (typeof value !== 'number' || Number.isFinite(value))
                    ) &&
                    new Set(values.map((value) => typeof value + ':' + String(value))).size ===
                        values.length;
                if (!valuesValid) {
                    schemaValid = false;
                    errors.push(
                        issue(
                            'INVALID_ENUM_VALUES',
                            'Runtime control "' +
                                name +
                                '" must declare a non-empty, duplicate-free `values` list of scalars',
                            name
                        )
                    );
                } else {
                    normalized.values = clone(values);
                }
            }

            controls[name] = normalized;
            if (variables.has(name) && schemaValid) {
                const defaultReport = validateRuntimeControlValue(normalized, variables.get(name));
                if (!defaultReport.ok) {
                    errors.push(
                        issue(
                            'INVALID_DEFAULT_VALUE',
                            'Default for runtime control "' +
                                name +
                                '" ' +
                                defaultReport.error.message.replace(
                                    /^Runtime control value\s+[^ ]+\s+/,
                                    ''
                                ),
                            name
                        )
                    );
                }
            }
        }

        const controlNames = new Set(Object.keys(declarations));
        if (controlNames.size > 0 && (!protocol._doc || !protocol._doc.contents)) {
            errors.push(
                issue(
                    'MISSING_YAML_DOCUMENT',
                    'Parsed protocol is missing its YAML.Document; alias-safe runtime controls cannot be resolved'
                )
            );
        } else if (controlNames.size > 0) {
            walkAliases(protocol._doc.contents, [], (alias, path) => {
                if (!controlNames.has(alias.source)) return;
                const binding = commandBindingFromPath(protocol, alias.source, path);
                if (!binding) {
                    errors.push(
                        issue(
                            'OUT_OF_SCOPE_RUNTIME_ALIAS',
                            'Runtime control "' +
                                alias.source +
                                '" is referenced outside a command parameter',
                            alias.source,
                            path
                        )
                    );
                } else if (binding.invalid) {
                    errors.push(
                        issue(
                            'STRUCTURAL_RUNTIME_ALIAS',
                            'Runtime control "' +
                                alias.source +
                                '" cannot change command identity or pattern selection',
                            alias.source,
                            path
                        )
                    );
                } else {
                    bindings.push(binding);
                }
            });
        }

        for (const name of controlNames) {
            if (!bindings.some((binding) => binding.variable === name)) {
                warnings.push(
                    issue(
                        'UNUSED_RUNTIME_CONTROL',
                        'Runtime control "' + name + '" is not bound to any command parameter',
                        name
                    )
                );
            }
        }

        bindings.sort(
            (a, b) =>
                a.condition_index - b.condition_index ||
                a.command_index - b.command_index ||
                a.parameter_path.join('.').localeCompare(b.parameter_path.join('.'))
        );

        return {
            ok: errors.length === 0,
            errors: errors,
            warnings: warnings,
            controls: controls,
            bindings: bindings
        };
    }

    function setPath(target, path, value) {
        if (!path.length) {
            throw new RuntimeControlError(
                'A runtime control may not replace an entire command',
                'STRUCTURAL_RUNTIME_ALIAS'
            );
        }
        let cursor = target;
        for (let i = 0; i < path.length - 1; i++) {
            cursor = cursor[path[i]];
            if (cursor === null || typeof cursor !== 'object') {
                throw new RuntimeControlError(
                    'Runtime-control binding no longer matches the parsed command',
                    'BINDING_DIVERGENCE',
                    { path: path }
                );
            }
        }
        cursor[path[path.length - 1]] = clone(value);
    }

    class RuntimeControlSession {
        /**
         * @param {object} options
         * @param {object} options.protocol  parseV3Protocol() result
         * @param {string} options.sessionId
         * @param {string} options.yamlId    immutable YAML identity/path
         * @param {string} options.yamlHash  content hash recorded for the run
         * @param {Function} [options.now]   injectable clock; returns Date/ms/ISO
         * @param {Function} [options.idFactory] (counter, sessionId) => request id
         */
        constructor(options) {
            const opts = options || {};
            const required = [
                ['sessionId', opts.sessionId],
                ['yamlId', opts.yamlId],
                ['yamlHash', opts.yamlHash]
            ];
            for (const [field, value] of required) {
                if (!nonEmptyString(value)) {
                    throw new RuntimeControlError(
                        field + ' is required for runtime-control provenance',
                        'MISSING_PROVENANCE',
                        { field: field }
                    );
                }
            }
            if (!opts.protocol || !opts.protocol._doc) {
                throw new RuntimeControlError(
                    'protocol must be a parseV3Protocol() result with its _doc handle',
                    'INVALID_PROTOCOL'
                );
            }

            const validation = validateRuntimeControls(opts.protocol);
            if (!validation.ok) {
                throw new RuntimeControlError(
                    'Runtime-control declarations are invalid',
                    'INVALID_DECLARATIONS',
                    validation
                );
            }

            this._protocol = opts.protocol;
            this._sessionId = opts.sessionId;
            this._yamlId = opts.yamlId;
            this._yamlHash = opts.yamlHash;
            this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
            this._idFactory =
                typeof opts.idFactory === 'function'
                    ? opts.idFactory
                    : (counter, sessionId) => sessionId + ':runtime-apply-' + String(counter);
            this._validation = clone(validation);
            this._definitions = clone(validation.controls);
            this._bindings = clone(validation.bindings);

            this._baseVariables = {};
            for (const variable of opts.protocol.variables || []) {
                this._baseVariables[variable.name] = clone(variable.value);
            }
            this._activeValues = {};
            this._plannedValues = {};
            this._provenance = {};
            for (const name of Object.keys(this._definitions)) {
                const value = clone(this._definitions[name].default_value);
                this._activeValues[name] = value;
                this._plannedValues[name] = clone(value);
                this._provenance[name] = {
                    variable: name,
                    value: clone(value),
                    source: 'yaml_default',
                    yaml_id: this._yamlId,
                    yaml_hash: this._yamlHash,
                    apply_event_id: null,
                    request_time: null,
                    effective_time: null,
                    first_affected_trial: null,
                    first_affected_trial_id: null
                };
            }

            this._requestCounter = 0;
            this._requestIds = new Set();
            this._requestEvents = [];
            this._pendingRequests = [];
            this._applyEvents = [];
            this._trialRecords = [];
            this._lastTrialIndex = -1;
        }

        getControlDefinitions() {
            return clone(this._definitions);
        }

        getValidationReport() {
            return clone(this._validation);
        }

        getActiveValues() {
            return clone(this._activeValues);
        }

        getPlannedValues() {
            return clone(this._plannedValues);
        }

        getProvenance() {
            return clone(this._provenance);
        }

        getRequestEvents() {
            return clone(this._requestEvents);
        }

        getPendingRequests() {
            return clone(this._pendingRequests);
        }

        getApplyEvents() {
            return clone(this._applyEvents);
        }

        getTrialRecords() {
            return clone(this._trialRecords);
        }

        hasPending() {
            return this._pendingRequests.length > 0;
        }

        /**
         * Stage one explicit UI Apply action. All values are validated first; an
         * invalid multi-control request stages nothing. Active values do not change.
         *
         * @param {object} changes  {variableName: newValue, ...}
         * @param {object} metadata {operator, reason?, requestedAt?, requestId?}
         * @returns {object} JSONL-ready `runtime_control_apply_requested` event
         */
        stageApply(changes, metadata) {
            const meta = metadata || {};
            const errors = [];
            if (!isPlainObject(changes) || Object.keys(changes).length === 0) {
                throw new RuntimeControlError(
                    'Apply requires a non-empty changes mapping',
                    'NO_CHANGES'
                );
            }
            if (!nonEmptyString(meta.operator)) {
                errors.push(
                    issue('MISSING_OPERATOR', 'Apply requires a non-empty operator for provenance')
                );
            }
            if (
                meta.reason !== undefined &&
                meta.reason !== null &&
                typeof meta.reason !== 'string'
            ) {
                errors.push(issue('INVALID_REASON', 'Apply reason must be a string when provided'));
            }

            const accepted = [];
            for (const name of Object.keys(changes)) {
                const definition = this._definitions[name];
                if (!definition) {
                    errors.push(
                        issue(
                            'UNDECLARED_CONTROL',
                            'Variable "' + name + '" is not an exposed runtime control',
                            name
                        )
                    );
                    continue;
                }
                const valueReport = validateRuntimeControlValue(definition, changes[name]);
                if (!valueReport.ok) {
                    errors.push(
                        issue(
                            valueReport.error.code,
                            'Runtime control "' + name + '" ' + valueReport.error.message,
                            name
                        )
                    );
                    continue;
                }
                if (!sameValue(this._plannedValues[name], changes[name])) {
                    accepted.push({
                        variable: name,
                        old_value: clone(this._plannedValues[name]),
                        new_value: clone(changes[name])
                    });
                }
            }
            if (errors.length > 0) {
                throw new RuntimeControlError('Apply request is invalid', 'INVALID_APPLY', {
                    errors: errors
                });
            }
            if (accepted.length === 0) {
                throw new RuntimeControlError(
                    'Apply does not change any pending or active value',
                    'NO_CHANGES'
                );
            }

            const requestedAt = normalizeTime(
                meta.requestedAt === undefined ? this._now() : meta.requestedAt,
                'requestedAt'
            );
            const requestId = nonEmptyString(meta.requestId)
                ? meta.requestId
                : this._idFactory(this._requestCounter + 1, this._sessionId);
            if (!nonEmptyString(requestId) || this._requestIds.has(requestId)) {
                throw new RuntimeControlError(
                    'Apply requestId must be non-empty and unique within the session',
                    'DUPLICATE_REQUEST_ID',
                    { request_id: requestId }
                );
            }

            this._requestCounter++;
            this._requestIds.add(requestId);
            const event = {
                event: 'runtime_control_apply_requested',
                request_id: requestId,
                session_id: this._sessionId,
                yaml_id: this._yamlId,
                yaml_hash: this._yamlHash,
                operator: meta.operator.trim(),
                reason: meta.reason && meta.reason.trim() ? meta.reason.trim() : null,
                request_time: requestedAt,
                changes: accepted
            };
            this._requestEvents.push(clone(event));
            this._pendingRequests.push(clone(event));
            for (const change of accepted) {
                this._plannedValues[change.variable] = clone(change.new_value);
            }
            return clone(event);
        }

        _resolveCommands(conditionName, activeValues) {
            const conditionIndex = this._protocol.conditions.findIndex(
                (condition) => condition.name === conditionName
            );
            if (conditionIndex < 0) {
                throw new RuntimeControlError(
                    'Unknown trial condition "' + conditionName + '"',
                    'UNKNOWN_CONDITION',
                    { condition_name: conditionName }
                );
            }
            const commandsNode = this._protocol._doc.getIn(
                ['conditions', conditionIndex, 'commands'],
                true
            );
            if (!commandsNode || !Array.isArray(commandsNode.items)) {
                throw new RuntimeControlError(
                    'Condition command nodes do not match the parsed protocol',
                    'BINDING_DIVERGENCE',
                    { condition_name: conditionName }
                );
            }

            const resolved = commandsNode.items.map((node) =>
                clone(node.toJS(this._protocol._doc))
            );
            const usedBindings = this._bindings.filter(
                (binding) => binding.condition_index === conditionIndex
            );
            for (const binding of usedBindings) {
                const command = resolved[binding.command_index];
                if (!command) {
                    throw new RuntimeControlError(
                        'Runtime-control command index no longer matches the parsed protocol',
                        'BINDING_DIVERGENCE',
                        binding
                    );
                }
                setPath(command, binding.parameter_path, activeValues[binding.variable]);
            }
            return { commands: resolved, bindings: usedBindings };
        }

        /**
         * Mark the next trial boundary, atomically activate all pending Apply
         * requests, and return the authoritative resolved trial-parameter record.
         *
         * @param {object} trial {trialIndex, conditionName, trialId?, effectiveAt?}
         */
        beginTrial(trial) {
            const input = trial || {};
            if (!Number.isInteger(input.trialIndex) || input.trialIndex < 0) {
                throw new RuntimeControlError(
                    'trialIndex must be a non-negative integer',
                    'INVALID_TRIAL_INDEX'
                );
            }
            if (input.trialIndex <= this._lastTrialIndex) {
                throw new RuntimeControlError(
                    'trialIndex must increase at each trial boundary',
                    'NON_MONOTONIC_TRIAL',
                    { previous: this._lastTrialIndex, received: input.trialIndex }
                );
            }
            if (!nonEmptyString(input.conditionName)) {
                throw new RuntimeControlError(
                    'conditionName is required at a trial boundary',
                    'UNKNOWN_CONDITION'
                );
            }
            if (
                input.trialId !== undefined &&
                input.trialId !== null &&
                !nonEmptyString(String(input.trialId))
            ) {
                throw new RuntimeControlError(
                    'trialId must be non-empty when provided',
                    'INVALID_TRIAL_ID'
                );
            }

            const effectiveAt = normalizeTime(
                input.effectiveAt === undefined ? this._now() : input.effectiveAt,
                'effectiveAt'
            );
            const trialId = input.trialId === undefined ? null : String(input.trialId);
            const nextValues = clone(this._activeValues);
            const nextProvenance = clone(this._provenance);
            const applied = [];

            for (const request of this._pendingRequests) {
                for (const change of request.changes) {
                    const applyEventId = request.request_id + ':' + change.variable;
                    const oldValue = clone(nextValues[change.variable]);
                    const event = {
                        event: 'runtime_control_apply',
                        apply_event_id: applyEventId,
                        request_id: request.request_id,
                        session_id: this._sessionId,
                        yaml_id: this._yamlId,
                        yaml_hash: this._yamlHash,
                        variable: change.variable,
                        old_value: oldValue,
                        new_value: clone(change.new_value),
                        operator: request.operator,
                        reason: request.reason,
                        request_time: request.request_time,
                        effective_time: effectiveAt,
                        first_affected_trial: input.trialIndex,
                        first_affected_trial_id: trialId
                    };
                    nextValues[change.variable] = clone(change.new_value);
                    nextProvenance[change.variable] = {
                        variable: change.variable,
                        value: clone(change.new_value),
                        source: 'runtime_control',
                        yaml_id: this._yamlId,
                        yaml_hash: this._yamlHash,
                        apply_event_id: applyEventId,
                        request_time: request.request_time,
                        effective_time: effectiveAt,
                        first_affected_trial: input.trialIndex,
                        first_affected_trial_id: trialId
                    };
                    applied.push(event);
                }
            }

            // Resolve before committing state so an unexpected document/model
            // divergence cannot consume pending Apply requests.
            const resolution = this._resolveCommands(input.conditionName, nextValues);
            const resolvedVariables = clone(this._baseVariables);
            for (const name of Object.keys(nextValues)) {
                resolvedVariables[name] = clone(nextValues[name]);
            }
            const parameterBindings = resolution.bindings.map((binding) => ({
                variable: binding.variable,
                command_index: binding.command_index,
                parameter_path: clone(binding.parameter_path),
                value: clone(nextValues[binding.variable]),
                provenance: clone(nextProvenance[binding.variable])
            }));
            const record = {
                event: 'runtime_control_trial_parameters',
                session_id: this._sessionId,
                yaml_id: this._yamlId,
                yaml_hash: this._yamlHash,
                trial_index: input.trialIndex,
                trial_id: trialId,
                condition_name: input.conditionName,
                boundary_time: effectiveAt,
                resolved_variables: resolvedVariables,
                resolved_commands: resolution.commands,
                parameter_bindings: parameterBindings,
                runtime_control_provenance: nextProvenance,
                apply_events: applied
            };

            this._activeValues = nextValues;
            this._plannedValues = clone(nextValues);
            this._provenance = nextProvenance;
            this._pendingRequests = [];
            this._applyEvents.push(...clone(applied));
            this._trialRecords.push(clone(record));
            this._lastTrialIndex = input.trialIndex;
            return clone(record);
        }
    }

    function createRuntimeControlSession(options) {
        return new RuntimeControlSession(options);
    }

    const RuntimeControls = {
        SUPPORTED_TYPES: Array.from(SUPPORTED_TYPES),
        RuntimeControlError: RuntimeControlError,
        validateRuntimeControlValue: validateRuntimeControlValue,
        validateRuntimeControls: validateRuntimeControls,
        RuntimeControlSession: RuntimeControlSession,
        createRuntimeControlSession: createRuntimeControlSession
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = RuntimeControls;
    }
    if (typeof global !== 'undefined') {
        global.RuntimeControls = RuntimeControls;
    }
})(typeof window !== 'undefined' ? window : this);
