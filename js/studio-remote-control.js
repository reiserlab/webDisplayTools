/**
 * studio-remote-control.js — Arena Studio "remote-control mode" (LAB-357), the DOM-free part.
 *
 * In remote-control mode the Studio page is a DISPLAY: an external program (Python, or MATLAB
 * through the Python client `rig/nodes/studio_remote.py`) starts runs through the rig gateway
 * (`rig/nodes/bridge_node.py`, ws://localhost:8765). The Studio STILL executes the steps; nothing
 * about step execution or timing changes. This module holds everything that can be tested
 * without a page: request validation, the run state machine, the mapping from the runner
 * summary to a terminal state, status-message construction and progress throttling. The glue
 * (banner, inert page, STOP modal, the calls into Studio.loadProtocol / Studio.runOnce) lives in
 * arena_studio.html, classic script "(2d) REMOTE CONTROL".
 *
 * MESSAGES (docs/development/studio-remote-control.md is the reference):
 *   gateway → Studio   {"type":"run_request","id","action":"run"|"stop"|"status",
 *                       "name","protocol","intent":"experiment"|"test","metadata":{…}}
 *   Studio → gateway   {"type":"run_status","id","state":"accepted"|"running"|"done"|"aborted"|
 *                       "failed"|"rejected","detail"?,"step"?:{"i","n","condition"},"summary"?}
 *
 * A run_request reaches the gateway on the ROS topic /arena/run_request (the default) or on
 * a WebSocket; the Studio sees the same object either way, with an optional `client` name.
 *
 * STATES of one run:  idle → starting → accepted → running → (done | aborted | failed) → idle
 *                     starting | accepted → rejected → idle     (it could not start)
 * `starting` is internal (the request is being validated and the protocol loaded; nothing has
 * been sent yet). `step.i` is 1-based ("step i of n").
 *
 * LOADING: classic <script src> only — window-global + CommonJS dual-export, NO ES `export`
 * (same rule as arena-session.js; see CLAUDE.md "Shared Modules").
 */
(function (global) {
    'use strict';

    const ACTIONS = ['run', 'stop', 'status'];
    const INTENTS = ['experiment', 'test'];
    const STATES = ['accepted', 'running', 'done', 'aborted', 'failed', 'rejected'];
    const TERMINAL_STATES = ['done', 'aborted', 'failed', 'rejected'];
    const METADATA_KEYS = ['experimenter', 'genotype', 'age', 'sex', 'fly_number', 'notes'];
    const MAX_ID_LENGTH = 128;

    // User-facing copy. The page markup carries the same strings; tests pin them equal.
    const BANNER_TEXT =
        'REMOTE CONTROL — runs are started by an external program. This page is display only.';
    const STOP_CONFIRM_TEXT = "Are you sure you want to stop? We're in remote control mode.";
    const STOP_CONFIRM_YES = 'Stop the run';
    const STOP_CONFIRM_NO = 'Keep running';

    const DETAIL = {
        operatorStop: 'stopped by the operator at the Studio',
        remoteStop: 'stopped by the remote controller',
        bridgeStop: 'the bridge connection was lost — the run was stopped',
        notRemote: 'the Studio is not in remote-control mode',
        busy: 'busy: a run is active',
        noController: 'the controller is not connected',
        noRun: 'no run is active',
        couldNotStart: 'the run could not start',
        experimentRule: 'the Run experiment rule refused',
        runError: 'run error — see the Studio log',
        unrequestedAbort: 'the run was aborted without a stop request (controller disconnected?)',
        incomplete: 'the run ended incomplete'
    };

    function isObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    function isTerminal(state) {
        return TERMINAL_STATES.indexOf(state) !== -1;
    }

    /**
     * Keep only the six metadata fields, as strings. A key that is absent stays absent (the
     * page leaves that field as it is); a present key with null becomes '' (clears the field).
     * Unknown keys and non-scalar values are reported, never applied.
     * @returns {{metadata: object, ignored: string[]}}
     */
    function normalizeMetadata(md) {
        const out = {};
        const ignored = [];
        if (!isObject(md)) return { metadata: out, ignored };
        for (const k of Object.keys(md)) {
            const v = md[k];
            if (METADATA_KEYS.indexOf(k) === -1) {
                ignored.push(k);
                continue;
            }
            if (v === null || v === undefined) out[k] = '';
            else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
                out[k] = String(v).trim();
            else ignored.push(k);
        }
        return { metadata: out, ignored };
    }

    /**
     * Validate one run_request. Never throws.
     * @returns {{ok:true, request:object, warnings:string[]} | {ok:false, id:string|null, error:string}}
     */
    function validateRequest(msg) {
        const id =
            isObject(msg) && typeof msg.id === 'string' && msg.id.trim() ? msg.id.trim() : null;
        const bad = (error) => ({ ok: false, id, error });
        if (!isObject(msg)) return bad('the request is not an object');
        if (msg.type !== undefined && msg.type !== 'run_request')
            return bad('not a run_request (type "' + msg.type + '")');
        if (!id) return bad('the request has no id (a non-empty string)');
        if (id.length > MAX_ID_LENGTH)
            return bad('the id is longer than ' + MAX_ID_LENGTH + ' characters');
        const action = msg.action;
        if (ACTIONS.indexOf(action) === -1)
            return bad(
                'unknown action ' + JSON.stringify(action) + ' (one of ' + ACTIONS.join(', ') + ')'
            );
        if (action !== 'run') {
            const req = { id, action };
            if (typeof msg.run === 'string' && msg.run.trim()) req.run = msg.run.trim();
            return { ok: true, request: req, warnings: [] };
        }
        if (typeof msg.protocol !== 'string' || !msg.protocol.trim())
            return bad('a run request needs "protocol": the YAML text');
        let name = typeof msg.name === 'string' ? msg.name.trim() : '';
        // A file NAME, never a path: the Studio only labels the document with it.
        name = name.split(/[\\/]/).pop();
        if (!name) name = 'remote.yaml';
        if (!/\.ya?ml$/i.test(name)) name += '.yaml';
        const intent = msg.intent === undefined || msg.intent === null ? 'test' : msg.intent;
        if (INTENTS.indexOf(intent) === -1)
            return bad(
                'unknown intent ' + JSON.stringify(intent) + ' (one of ' + INTENTS.join(', ') + ')'
            );
        if (msg.metadata !== undefined && msg.metadata !== null && !isObject(msg.metadata))
            return bad('"metadata" must be an object');
        const md = normalizeMetadata(msg.metadata);
        const warnings = md.ignored.length
            ? ['ignored metadata field(s): ' + md.ignored.join(', ')]
            : [];
        const request = { id, action, name, protocol: msg.protocol, intent, metadata: md.metadata };
        // Free text naming the asker (a ROS node, a script): shown in the Studio log only.
        if (typeof msg.client === 'string' && msg.client.trim())
            request.client = msg.client.trim().slice(0, 64);
        return { ok: true, request, warnings };
    }

    /**
     * A remote run with intent "experiment" obeys the page's "Run experiment" button rule,
     * judged AFTER the request's metadata is in the Run details panel and its protocol is
     * loaded. The two fields a controller can fix from its side are named first, both at
     * once; every other condition is the page's own gate (`Studio.runExperimentGate()` — a
     * connected arena, a saved protocol, the bridge, every pattern on the SD, the controller
     * preflight), passed in as `gate` and never re-implemented here. "test" is unrestricted.
     * @param {object} ctx {intent, experimenter, genotype, gate:{ok, reason}|null}
     * @returns {{ok:boolean, missing:string[], detail:string|null}}
     */
    function experimentGate(ctx) {
        const c = ctx || {};
        if (c.intent !== 'experiment') return { ok: true, missing: [], detail: null };
        const missing = [];
        if (!String(c.experimenter == null ? '' : c.experimenter).trim())
            missing.push('experimenter');
        if (!String(c.genotype == null ? '' : c.genotype).trim()) missing.push('genotype');
        if (missing.length) {
            const names = missing.map((k) => (k === 'genotype' ? 'Fly genotype' : 'Experimenter'));
            return {
                ok: false,
                missing,
                detail:
                    'a recorded run (intent "experiment") needs ' +
                    names.join(' and ') +
                    ' — missing metadata: ' +
                    missing.join(', ') +
                    ' (send them in "metadata", or fill in Run details before entering remote control)'
            };
        }
        // Fail closed: no verdict from the page is not a yes.
        if (!isObject(c.gate) || typeof c.gate.ok !== 'boolean')
            return {
                ok: false,
                missing,
                detail: DETAIL.experimentRule + ': the page gave no verdict'
            };
        if (!c.gate.ok)
            return {
                ok: false,
                missing,
                detail: DETAIL.experimentRule + ': ' + (c.gate.reason || 'no reason given')
            };
        return { ok: true, missing, detail: null };
    }

    /**
     * May the page enter remote-control mode now? The first failing precondition wins, and
     * its reason is the exact text the page shows.
     * @param {object} ctx {controllerConnected, bridgeConnected, bridgeRemote (true|false|null),
     *                      running, soak, outputInhibited (string|boolean), importMode,
     *                      unsavedEdits, alt}
     * @returns {{ok:boolean, reason:string}}
     */
    function canEnter(ctx) {
        const c = ctx || {};
        const no = (reason) => ({ ok: false, reason });
        if (c.alt) return no('Remote control is not available in the Alt layout.');
        if (c.running) return no('A run is active — wait for it to finish (or STOP it) first.');
        if (c.soak) return no('A soak is running — remote control and soak exclude each other.');
        if (c.outputInhibited)
            return no(
                'Arena output is locked' +
                    (typeof c.outputInhibited === 'string' ? ' (' + c.outputInhibited + ')' : '') +
                    ' — end the replay first.'
            );
        if (c.importMode) return no('An import is in progress — Commit or Cancel it first.');
        if (c.unsavedEdits)
            return no(
                'The open protocol has unsaved edits — save or discard them first (a remote run replaces the open protocol).'
            );
        if (!c.controllerConnected)
            return no('The controller is not connected — click Connect first.');
        if (!c.bridgeConnected)
            return no(
                'The bridge is not connected — start the rig gateway (cd rig && pixi run rig) and connect the bridge.'
            );
        if (c.bridgeRemote !== true)
            return no(
                c.bridgeRemote === false
                    ? 'This bridge does not support remote control — run the rig gateway (cd rig && pixi run rig), not bridge 3.4.'
                    : 'The bridge has not answered yet (no hello_ack) — try again in a moment.'
            );
        return { ok: true, reason: '' };
    }

    /** A JSON-safe copy of the runner summary (it may carry Error objects or cycles). */
    function summaryForStatus(summary) {
        if (!isObject(summary)) return null;
        const out = {};
        for (const k of Object.keys(summary)) {
            const v = summary[k];
            if (typeof v === 'function' || v === undefined) continue;
            if (v instanceof Error) {
                out[k] = v.message || String(v);
                continue;
            }
            try {
                out[k] = JSON.parse(JSON.stringify(v));
            } catch (_) {
                out[k] = String(v);
            }
        }
        return out;
    }

    /**
     * Runner summary → terminal state.
     *   it never started                                   → rejected (+ the reason)
     *   no summary (the run threw)                         → failed
     *   controller fault / bridge lost                     → failed
     *   aborted after a STOP at the Studio                 → aborted "stopped by the operator at the Studio"
     *   aborted after a remote stop                        → aborted "stopped by the remote controller"
     *   aborted with no stop request                       → failed
     *   completed, no fault / bridgeLost / aborted         → done
     * @param {object|null} summary  ArenaRunner.runSequence's summary (Studio.runOnce's result)
     * @param {object} [ctx] {started:boolean, stopSource:'operator'|'remote'|'bridge'|null,
     *                        reason?:string, error?:string}
     * @returns {{state:string, detail:string|null}}
     */
    function classifySummary(summary, ctx) {
        const c = ctx || {};
        if (c.started === false)
            return { state: 'rejected', detail: c.reason || DETAIL.couldNotStart };
        if (!isObject(summary)) return { state: 'failed', detail: c.error || DETAIL.runError };
        if (summary.fault)
            return { state: 'failed', detail: 'controller fault: ' + String(summary.fault) };
        if (summary.bridgeLost || c.stopSource === 'bridge')
            return { state: 'failed', detail: DETAIL.bridgeStop };
        if (summary.aborted) {
            if (c.stopSource === 'operator')
                return { state: 'aborted', detail: DETAIL.operatorStop };
            if (c.stopSource === 'remote') return { state: 'aborted', detail: DETAIL.remoteStop };
            return { state: 'failed', detail: DETAIL.unrequestedAbort };
        }
        if (summary.completed) {
            const errors = Number(summary.errors) || 0;
            const skipped = Number(summary.skipped) || 0;
            const notes = [];
            if (errors) notes.push(errors + ' step error' + (errors === 1 ? '' : 's'));
            if (skipped) notes.push(skipped + ' skipped command' + (skipped === 1 ? '' : 's'));
            return {
                state: 'done',
                detail: notes.length ? 'completed with ' + notes.join(', ') : null
            };
        }
        return { state: 'failed', detail: DETAIL.incomplete };
    }

    /** One run_status message. `extra`: {detail, step, summary, action, run}. */
    function buildStatus(id, state, extra) {
        if (STATES.indexOf(state) === -1) throw new Error('unknown run state "' + state + '"');
        const e = extra || {};
        const msg = { type: 'run_status', id: id, state: state };
        if (e.action) msg.action = e.action;
        if (e.run) msg.run = e.run;
        if (e.detail) msg.detail = String(e.detail);
        if (e.step) msg.step = e.step;
        if (e.summary) msg.summary = e.summary;
        return msg;
    }

    function stepOf(s) {
        if (!isObject(s) || !Number.isFinite(Number(s.index))) return null;
        const total = Number.isFinite(Number(s.total)) ? Number(s.total) : null;
        const cond =
            s.conditionName != null
                ? s.conditionName
                : isObject(s.step) && s.step.conditionName != null
                  ? s.step.conditionName
                  : null;
        return { i: Number(s.index) + 1, n: total, condition: cond == null ? null : String(cond) };
    }

    /**
     * The run state machine. One run at a time. Every method that produces a message
     * returns it (or null); the caller sends it. Never throws on a call made in the wrong
     * state — it returns null, so a late event can never start or end anything.
     */
    function createMachine() {
        let state = 'idle'; // idle | starting | accepted | running
        let id = null;
        let name = null;
        let intent = null;
        let step = null;
        let total = null;
        let stopSource = null;
        let last = null; // the most recent terminal status
        let lastName = null;

        function reset() {
            state = 'idle';
            id = null;
            name = null;
            intent = null;
            step = null;
            total = null;
            stopSource = null;
        }
        function end(msg) {
            last = msg;
            lastName = name;
            reset();
            return msg;
        }

        return {
            get state() {
                return state;
            },
            get busy() {
                return state !== 'idle';
            },
            get id() {
                return id;
            },
            get name() {
                return name;
            },
            get step() {
                return step ? Object.assign({}, step) : null;
            },
            get stopSource() {
                return stopSource;
            },
            get last() {
                return last;
            },
            /** Claim the machine for a request (nothing is sent yet). false when busy. */
            begin(req) {
                if (state !== 'idle' || !isObject(req) || !req.id) return false;
                state = 'starting';
                id = req.id;
                name = req.name || null;
                intent = req.intent || null;
                return true;
            },
            /** The protocol loaded: the run is about to start. → `accepted`. */
            accept() {
                if (state !== 'starting') return null;
                state = 'accepted';
                return buildStatus(id, 'accepted', {});
            },
            /** The runner started the sequence. → the first `running` (no step yet). */
            started(n) {
                if (state !== 'accepted') return null;
                state = 'running';
                total = Number.isFinite(Number(n)) ? Number(n) : null;
                return buildStatus(id, 'running', {});
            },
            /**
             * A runner status event. Returns a `running` message when the STEP changed since
             * the last one sent, else null — progress goes out per step, never per frame.
             * @param {object} s {index, total, conditionName} or a runner 'step-start' event
             */
            progress(s) {
                if (state !== 'running') return null;
                const next = stepOf(s);
                if (!next) return null;
                if (next.n == null) next.n = total;
                if (
                    step &&
                    step.i === next.i &&
                    step.n === next.n &&
                    step.condition === next.condition
                )
                    return null;
                step = next;
                return buildStatus(id, 'running', { step: Object.assign({}, step) });
            },
            /**
             * Record who asked to stop (the first request wins). true when a run is in
             * progress — the caller then takes the page's ordinary STOP path.
             */
            requestStop(source) {
                if (state === 'idle') return false;
                if (!stopSource) stopSource = source || 'operator';
                return true;
            },
            /** It could not start. → terminal `rejected`. */
            reject(detail) {
                if (state !== 'starting' && state !== 'accepted') return null;
                return end(buildStatus(id, 'rejected', { detail: detail || DETAIL.couldNotStart }));
            },
            /**
             * The run is over. → the terminal status, with the runner summary.
             * @param {object|null} summary  Studio.runOnce's result
             * @param {object} [ctx] {started, reason, error}
             */
            finish(summary, ctx) {
                if (state === 'idle') return null;
                const c = Object.assign({ stopSource: stopSource }, ctx || {});
                if (c.started === undefined) c.started = state === 'running';
                const verdict = classifySummary(summary, c);
                const extra = { detail: verdict.detail };
                const safe = summaryForStatus(summary);
                if (safe) extra.summary = safe;
                if (step && verdict.state !== 'rejected') extra.step = Object.assign({}, step);
                return end(buildStatus(id, verdict.state, extra));
            },
            /** The one state line under the banner. */
            stateLine() {
                if (state === 'starting' || state === 'accepted')
                    return 'Starting ' + (name || 'a run') + ' …';
                if (state === 'running') {
                    let t = 'Running ' + (name || 'a run');
                    if (step) {
                        t += ' — step ' + step.i + (step.n ? ' of ' + step.n : '');
                        if (step.condition) t += ' (' + step.condition + ')';
                    }
                    return t + (stopSource ? ' — stopping …' : '');
                }
                if (last)
                    return (
                        'Waiting for a run · last result: ' +
                        (lastName || 'run') +
                        ' — ' +
                        last.state +
                        (last.detail ? ' (' + last.detail + ')' : '')
                    );
                return 'Waiting for a run';
            },
            /** Diagnostic snapshot (also what tests read). */
            snapshot() {
                return {
                    state: state,
                    id: id,
                    name: name,
                    intent: intent,
                    step: step ? Object.assign({}, step) : null,
                    stopSource: stopSource,
                    last: last
                };
            }
        };
    }

    /**
     * What to do with an inbound run_request. Pure: the glue performs `do` and sends `reply`.
     * A request that arrives while remote-control mode is off NEVER starts anything.
     * @param {object} msg   the run_request
     * @param {object} ctx   {remoteOn, busy (machine busy or a run active), controllerConnected,
     *                        runActive (a run the page could stop)}
     * @returns {{do:'run'|'stop'|'none', request?:object, reply?:object, warnings?:string[]}}
     */
    function decide(msg, ctx) {
        const c = ctx || {};
        const v = validateRequest(msg);
        if (!v.ok) {
            // No usable id → nobody to answer; the gateway rejects such a request itself.
            return v.id
                ? { do: 'none', reply: buildStatus(v.id, 'rejected', { detail: v.error }) }
                : { do: 'none' };
        }
        const req = v.request;
        const tag = req.action === 'run' ? {} : { action: req.action };
        const reject = (detail) => ({
            do: 'none',
            reply: buildStatus(req.id, 'rejected', Object.assign({ detail }, tag))
        });
        if (req.action === 'status') return { do: 'none' }; // answered by the gateway
        if (!c.remoteOn) return reject(DETAIL.notRemote);
        if (req.action === 'stop') {
            if (!c.runActive) return reject(DETAIL.noRun);
            return { do: 'stop', request: req };
        }
        if (c.busy) return reject(DETAIL.busy);
        if (!c.controllerConnected) return reject(DETAIL.noController);
        return { do: 'run', request: req, warnings: v.warnings };
    }

    const StudioRemoteControl = {
        ACTIONS,
        INTENTS,
        STATES,
        TERMINAL_STATES,
        METADATA_KEYS,
        BANNER_TEXT,
        STOP_CONFIRM_TEXT,
        STOP_CONFIRM_YES,
        STOP_CONFIRM_NO,
        DETAIL,
        isTerminal,
        normalizeMetadata,
        validateRequest,
        experimentGate,
        canEnter,
        summaryForStatus,
        classifySummary,
        buildStatus,
        createMachine,
        decide
    };

    // Dual-export: CommonJS (Node tests) + window global (classic <script src>).
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioRemoteControl;
    }
    if (typeof global !== 'undefined') {
        global.StudioRemoteControl = StudioRemoteControl;
    }
})(typeof window !== 'undefined' ? window : this);
