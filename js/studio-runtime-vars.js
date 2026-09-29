/**
 * studio-runtime-vars.js — the Run view's "Runtime variables" panel (Arena Studio v0.84).
 *
 * The mechanism is js/runtime-controls.js (the counter-proposal's Extension 1: only
 * variables declared under `runtime_controls:` may change; one explicit Apply; the
 * change takes effect atomically at the NEXT trial boundary; the YAML is never
 * rewritten; every apply is logged with provenance). This module is the Classic
 * Studio's presentation of it — pure helpers (testable in Node) plus a small DOM
 * panel builder that the Studio glue script wires to `Studio.prepareRuntimeControls`
 * / `Studio.resolveRuntimeCondition` / run-status events.
 *
 * LOADING: classic <script src> (window global + CommonJS dual export). Loaded after
 * js/runtime-controls.js; the Studio glue passes `window.RuntimeControls` in.
 */
(function (global) {
    'use strict';

    const FRONTAL_STATES = {
        none: 'none',
        default: 'default',
        pending: 'pending',
        applied: 'applied',
        unapplied: 'unapplied',
        invalid: 'invalid'
    };

    function formatValue(def, value) {
        if (value === undefined || value === null) return '—';
        if (def && def.type === 'boolean') return value ? 'true' : 'false';
        if (typeof value === 'number') {
            return Number.isInteger(value)
                ? String(value)
                : String(Math.round(value * 1000) / 1000);
        }
        return String(value);
    }

    /** One-line description of what values a control accepts ("0–100 percent", "steady | pulse"). */
    function describeControl(def) {
        if (!def) return '';
        if (def.type === 'number' || def.type === 'integer') {
            const range = formatValue(def, def.minimum) + '–' + formatValue(def, def.maximum);
            return (
                range +
                (def.units ? ' ' + def.units : '') +
                (def.type === 'integer' ? ' (integer)' : '')
            );
        }
        if (def.type === 'boolean') return 'true | false';
        if (def.type === 'enum') return (def.values || []).map((v) => String(v)).join(' | ');
        return String(def.type || '');
    }

    /**
     * Parse what the operator typed/selected into a typed value, or an error message.
     * number/integer: a decimal string; boolean: 'true'/'false'; enum: the JSON-encoded
     * option value (what the <select> carries) — a raw string is also accepted.
     */
    function parseInputValue(def, raw) {
        if (!def) return { ok: false, error: 'unknown control' };
        const label = def.label || def.name || 'value';
        if (def.type === 'boolean') {
            if (raw === true || raw === 'true') return { ok: true, value: true };
            if (raw === false || raw === 'false') return { ok: true, value: false };
            return { ok: false, error: label + ' must be true or false' };
        }
        if (def.type === 'enum') {
            let value = raw;
            if (typeof raw === 'string') {
                try {
                    value = JSON.parse(raw);
                } catch (_) {
                    value = raw;
                }
            }
            const hit = (def.values || []).find(
                (v) => Object.is(v, value) || String(v) === String(value)
            );
            if (hit === undefined) {
                return { ok: false, error: label + ' must be one of ' + describeControl(def) };
            }
            return { ok: true, value: hit };
        }
        const text = String(raw === undefined || raw === null ? '' : raw).trim();
        if (!text) return { ok: false, error: label + ' needs a value' };
        const num = Number(text);
        if (!Number.isFinite(num)) return { ok: false, error: label + ' must be a number' };
        if (def.type === 'integer' && !Number.isInteger(num)) {
            return { ok: false, error: label + ' must be a whole number' };
        }
        if (typeof def.minimum === 'number' && num < def.minimum) {
            return {
                ok: false,
                error: label + ' must be ≥ ' + def.minimum + (def.units ? ' ' + def.units : '')
            };
        }
        if (typeof def.maximum === 'number' && num > def.maximum) {
            return {
                ok: false,
                error: label + ' must be ≤ ' + def.maximum + (def.units ? ' ' + def.units : '')
            };
        }
        return { ok: true, value: num };
    }

    /**
     * Turn the panel inputs into an Apply request: only controls whose typed value
     * differs from the PLANNED value are included. Any parse error blocks the whole
     * request (the module's stageApply is all-or-nothing too).
     */
    function buildChanges(defs, planned, rawValues) {
        const changes = {};
        const errors = [];
        for (const name of Object.keys(defs || {})) {
            if (!rawValues || !(name in rawValues)) continue;
            const parsed = parseInputValue(defs[name], rawValues[name]);
            if (!parsed.ok) {
                errors.push({ variable: name, message: parsed.error });
                continue;
            }
            if (!Object.is(parsed.value, planned ? planned[name] : undefined))
                changes[name] = parsed.value;
        }
        return { changes, errors, count: Object.keys(changes).length };
    }

    /**
     * The per-variable state chip. `ctx` = { session, endedPending (array of pending
     * request events or null) }. `session` is a RuntimeControlSession or null.
     */
    function chipFor(name, ctx) {
        const c = ctx || {};
        const session = c.session || null;
        if (
            c.endedPending &&
            c.endedPending.some((r) => (r.changes || []).some((ch) => ch.variable === name))
        ) {
            return { state: FRONTAL_STATES.unapplied, text: 'not applied · run ended first' };
        }
        if (!session) return { state: FRONTAL_STATES.default, text: 'default' };
        const pending = session
            .getPendingRequests()
            .some((r) => (r.changes || []).some((ch) => ch.variable === name));
        if (pending)
            return { state: FRONTAL_STATES.pending, text: 'pending · applies at next trial' };
        const prov = session.getProvenance()[name];
        if (prov && prov.source === 'runtime_control') {
            const n = prov.first_affected_trial;
            return {
                state: FRONTAL_STATES.applied,
                text: 'applied' + (Number.isInteger(n) ? ' · from trial ' + (n + 1) : '')
            };
        }
        return { state: FRONTAL_STATES.default, text: 'default' };
    }

    /** Human line for the run log / status strip after an Apply was staged. */
    function describeRequest(requested) {
        if (!requested || !Array.isArray(requested.changes)) return '';
        return requested.changes
            .map(
                (ch) =>
                    ch.variable +
                    ' ' +
                    formatValue(null, ch.old_value) +
                    ' → ' +
                    formatValue(null, ch.new_value)
            )
            .join(', ');
    }

    /**
     * Build the panel. `opts`:
     *   host, statusEl            — DOM nodes (body + one status line)
     *   cardEl                    — optional: the whole panel card; HIDDEN while there is
     *                               nothing to show (no protocol / none declared) so it
     *                               does not take Run-view height from the sequence. Stays
     *                               visible for real controls and for declaration errors.
     *   document                  — the Document to create elements in (default: global.document)
     *   RuntimeControls           — the js/runtime-controls.js global
     *   getProtocol()             — parseV3Protocol() result (Studio.currentDoc.experiment) or null
     *   getSession()              — the active RuntimeControlSession or null
     *   isRunning()               — boolean
     *   getEndedPending()         — pending requests the run ended with, or null
     *   onApply(changes, reason)  — stage the request; returns the requested event or throws
     * Returns { render(force), update(), inputs (Map), lastKey }.
     */
    function createPanel(opts) {
        const o = opts || {};
        const doc = o.document || (global && global.document);
        const RC = o.RuntimeControls;
        const ui = {
            inputs: new Map(),
            defs: {},
            key: null,
            dirty: false,
            reason: null,
            apply: null,
            chips: new Map(),
            active: new Map()
        };

        function el(tag, cls, text) {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        }

        function docKey(protocol) {
            if (!protocol) return 'none';
            const names = Object.keys(protocol.runtime_controls || {});
            return names.join(',') + '|' + JSON.stringify(protocol.runtime_controls || {});
        }

        function setCardVisible(visible) {
            if (o.cardEl) o.cardEl.hidden = !visible;
        }

        function setStatus(text, cls) {
            if (!o.statusEl) return;
            o.statusEl.textContent = text || '';
            o.statusEl.className = 'run-vars-status' + (cls ? ' ' + cls : '');
        }

        function render(force) {
            if (!o.host) return;
            const protocol = o.getProtocol ? o.getProtocol() : null;
            const key = docKey(protocol);
            if (!force && key === ui.key) {
                update();
                return;
            }
            ui.key = key;
            ui.inputs.clear();
            ui.chips.clear();
            ui.active.clear();
            ui.defs = {};
            ui.dirty = false;
            ui.reason = null;
            ui.apply = null;
            o.host.textContent = '';
            if (!protocol) {
                o.host.appendChild(
                    el(
                        'div',
                        'run-vars-empty dim',
                        'None — open a protocol to see its runtime variables.'
                    )
                );
                setStatus('');
                setCardVisible(false);
                return;
            }
            if (!RC) {
                o.host.appendChild(
                    el(
                        'div',
                        'run-vars-empty dim',
                        'Runtime variables unavailable (module failed to load).'
                    )
                );
                setStatus('');
                setCardVisible(true);
                return;
            }
            const report = RC.validateRuntimeControls(protocol);
            const names = Object.keys(report.controls || {});
            if (!report.ok) {
                const box = el('div', 'run-vars-empty bad');
                box.textContent =
                    'Runtime variables need attention: ' +
                    report.errors.map((e) => e.message).join(' · ');
                o.host.appendChild(box);
                setStatus('The run will use the YAML values as written.', 'bad');
                setCardVisible(true);
                return;
            }
            if (!names.length) {
                o.host.appendChild(
                    el('div', 'run-vars-empty dim', 'None declared in this protocol.')
                );
                setStatus('Declare `runtime_controls:` in the YAML to expose a variable here.');
                setCardVisible(false);
                return;
            }
            setCardVisible(true);
            ui.defs = report.controls;
            const session = o.getSession ? o.getSession() : null;
            const planned = session
                ? session.getPlannedValues()
                : Object.fromEntries(names.map((n) => [n, report.controls[n].default_value]));

            const table = el('div', 'run-vars-rows');
            names.forEach((name) => {
                const def = report.controls[name];
                const row = el('div', 'run-vars-row');
                row.dataset.var = name;
                const nameEl = el('div', 'run-vars-name');
                nameEl.textContent = def.label || name;
                nameEl.title =
                    (def.description ? def.description + ' · ' : '') +
                    'allowed: ' +
                    describeControl(def);
                const allowed = el('div', 'run-vars-allowed dim', describeControl(def));
                const active = el('div', 'run-vars-active');
                active.title = 'Value in force for the current / next trial';
                let input;
                if (def.type === 'boolean') {
                    input = doc.createElement('select');
                    input.innerHTML =
                        '<option value="true">true</option><option value="false">false</option>';
                    input.value = String(Boolean(planned[name]));
                } else if (def.type === 'enum') {
                    input = doc.createElement('select');
                    (def.values || []).forEach((value) => {
                        const option = doc.createElement('option');
                        option.value = JSON.stringify(value);
                        option.textContent = String(value);
                        input.appendChild(option);
                    });
                    input.value = JSON.stringify(planned[name]);
                } else {
                    input = doc.createElement('input');
                    input.type = 'number';
                    input.min = String(def.minimum);
                    input.max = String(def.maximum);
                    input.step = def.type === 'integer' ? '1' : 'any';
                    input.value = String(planned[name]);
                }
                input.className = 'run-vars-input';
                input.dataset.var = name;
                input.title =
                    'New value for ' +
                    (def.label || name) +
                    ' — allowed: ' +
                    describeControl(def) +
                    '. Takes effect at the next trial after Apply.';
                input.addEventListener('input', () => {
                    ui.dirty = true;
                    update();
                });
                const chip = el('span', 'run-vars-chip', '');
                row.append(nameEl, allowed, active, input, chip);
                ui.inputs.set(name, input);
                ui.chips.set(name, chip);
                ui.active.set(name, active);
                table.appendChild(row);
            });
            o.host.appendChild(table);

            const actions = el('div', 'run-vars-actions');
            const reason = doc.createElement('input');
            reason.type = 'text';
            reason.className = 'run-vars-reason';
            reason.id = 'runVarsReason';
            reason.placeholder = 'reason (optional)';
            reason.maxLength = 240;
            reason.title = 'Optional note recorded with this change in the run log';
            const apply = el('button', 'pill run-vars-apply', 'Apply');
            apply.type = 'button';
            apply.id = 'runVarsApply';
            apply.title =
                'Validate and stage the changed values; they take effect at the next trial boundary and are logged with your name and the reason';
            apply.addEventListener('click', applyNow);
            actions.append(reason, apply);
            o.host.appendChild(actions);
            ui.reason = reason;
            ui.apply = apply;
            update();
        }

        function update() {
            if (!Object.keys(ui.defs).length) return;
            const session = o.getSession ? o.getSession() : null;
            const running = !!(o.isRunning && o.isRunning());
            const endedPending = o.getEndedPending ? o.getEndedPending() : null;
            const activeValues = session ? session.getActiveValues() : null;
            for (const name of Object.keys(ui.defs)) {
                const def = ui.defs[name];
                const chip = chipFor(name, { session, endedPending });
                const chipEl = ui.chips.get(name);
                if (chipEl) {
                    chipEl.textContent = chip.text;
                    chipEl.className = 'run-vars-chip ' + chip.state;
                }
                const activeEl = ui.active.get(name);
                if (activeEl) {
                    const v = activeValues ? activeValues[name] : def.default_value;
                    activeEl.textContent =
                        formatValue(def, v) +
                        (def.units && def.type !== 'boolean' && def.type !== 'enum'
                            ? ' ' + def.units
                            : '');
                }
            }
            if (ui.apply) ui.apply.disabled = !(session && running && ui.dirty);
            if (endedPending) {
                setStatus('Not applied — the run ended before another trial boundary.', 'warn');
            } else if (!session) {
                setStatus(
                    running
                        ? 'This run has no runtime session.'
                        : 'Defaults shown · Apply becomes available during a run; changes take effect at the next trial.'
                );
            } else if (session.hasPending()) {
                setStatus('Pending · applies atomically at the next trial boundary.', 'pending');
            } else if (running) {
                setStatus('Active · values persist until Apply is used again.', 'ok');
            } else {
                setStatus('Run ended · the resolved parameters of every trial are in the run log.');
            }
        }

        function applyNow() {
            const session = o.getSession ? o.getSession() : null;
            if (!session || !(o.isRunning && o.isRunning())) return;
            const raw = {};
            for (const [name, input] of ui.inputs) raw[name] = input.value;
            const built = buildChanges(ui.defs, session.getPlannedValues(), raw);
            if (built.errors.length) {
                setStatus(built.errors.map((e) => e.message).join(' · '), 'bad');
                built.errors.forEach((e) => {
                    const input = ui.inputs.get(e.variable);
                    if (input) input.classList.add('bad');
                });
                return;
            }
            for (const input of ui.inputs.values()) input.classList.remove('bad');
            if (!built.count) {
                setStatus('Nothing to apply — every value already matches the planned value.');
                ui.dirty = false;
                update();
                return;
            }
            try {
                o.onApply(built.changes, ui.reason ? ui.reason.value : '');
                ui.dirty = false;
                if (ui.reason) ui.reason.value = '';
                update();
            } catch (error) {
                const details =
                    error && error.details && Array.isArray(error.details.errors)
                        ? ' — ' + error.details.errors.map((e) => e.message).join(' · ')
                        : '';
                setStatus(
                    (error && error.message ? error.message : String(error)) + details,
                    'bad'
                );
            }
        }

        /** After a trial boundary applied pending values, snap the inputs to the new plan. */
        function syncInputsToPlanned() {
            const session = o.getSession ? o.getSession() : null;
            if (!session) return;
            const planned = session.getPlannedValues();
            for (const [name, input] of ui.inputs) {
                const def = ui.defs[name];
                if (!def) continue;
                input.value =
                    def.type === 'enum' ? JSON.stringify(planned[name]) : String(planned[name]);
            }
            ui.dirty = false;
            update();
        }

        return {
            render,
            update,
            syncInputsToPlanned,
            get inputs() {
                return ui.inputs;
            },
            get lastKey() {
                return ui.key;
            }
        };
    }

    const StudioRuntimeVars = {
        STATES: FRONTAL_STATES,
        formatValue,
        describeControl,
        parseInputValue,
        buildChanges,
        chipFor,
        describeRequest,
        createPanel
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioRuntimeVars;
    }
    if (typeof global !== 'undefined') {
        global.StudioRuntimeVars = StudioRuntimeVars;
    }
})(typeof window !== 'undefined' ? window : this);
