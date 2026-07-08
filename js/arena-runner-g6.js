/**
 * arena-runner-g6.js — condition → wire execution helpers + a small run-state
 * machine, shared by the Arena Console (LAB-93), the v3 single-trial dry-run
 * (LAB-94), and the v3 full-sequence runner (LAB-97).
 *
 * This is the ONE home for "take a v3 condition (or whole experiment_structure)
 * and drive it on the arena". It sits between the pure wire protocol
 * (js/arena-wire-g6.js) and the I/O transport (js/arena-link.js) but contains
 * NO DOM — pages own their own UI. That keeps it Node-testable with a faked
 * link (see tests/test-arena-runner-g6.js).
 *
 * Two layers:
 *   - PURE (no I/O): findTrialParams, buildTrialParams, conditionDuration,
 *     flattenStructure (experiment_structure → ordered step list, respecting block
 *     reps + randomize + ITI), translateCommand (one command → a wire-neutral IR).
 *   - ASYNC executor: ArenaRunner.start (single trial) and ArenaRunner.runSequence
 *     (walk the flattened steps, replay each condition's commands, host-side trial
 *     timing). Plugin commands are skipped-with-warning; unsupported controller
 *     commands (e.g. setColorDepth) error then skip.
 */
'use strict';

var ArenaRunnerG6 = (function () {
    // ---- pure helpers (hardware-free, unit-tested) -----------------------

    /**
     * Find the controller `trialParams` command in a condition's command list.
     * IMPORTANT: a condition's controller commands are a family (allOn, allOff,
     * stopDisplay, setPositionX, trialParams) — only trialParams maps to
     * encodeTrialParams, so we must match on command_name, not just
     * type === 'controller'.
     * @returns {object|null} the trialParams command, or null if none.
     */
    function findTrialParams(condition) {
        if (!condition || !Array.isArray(condition.commands)) return null;
        return (
            condition.commands.find(
                (c) => c && c.type === 'controller' && c.command_name === 'trialParams'
            ) || null
        );
    }

    /**
     * List the plugin commands in a condition that a dry-run will SKIP, so the
     * UI can warn about them (DoD: "plugin commands skipped with a visible
     * warning").
     * @returns {Array<{plugin_name:string, command_name:string}>}
     */
    function listSkippedPlugins(condition) {
        if (!condition || !Array.isArray(condition.commands)) return [];
        return condition.commands
            .filter((c) => c && c.type === 'plugin')
            .map((c) => ({
                plugin_name: c.plugin_name || '(unnamed)',
                command_name: c.command_name || '(unnamed)'
            }));
    }

    /**
     * Is a condition eligible for the web dry-run? The web runner only sends
     * arena/controller commands, so a condition is runnable iff it has a
     * trialParams command AND no plugin commands (camera/backlight/etc. can't be
     * driven from the browser). Waits and other controller commands are allowed.
     * Gates the ▶ button so it only appears where the run is faithful (no
     * silently-skipped plugins).
     * @returns {boolean}
     */
    function isDryRunEligible(condition) {
        return !!findTrialParams(condition) && listSkippedPlugins(condition).length === 0;
    }

    /**
     * Map a v3 `frame_index` to the wire `init_pos`.
     *
     * OPEN QUESTION (hardware-confirm): the handoff asserts frame_index == the
     * wire init_pos, but arena-wire-g6 documents init_pos as 0-based while v3
     * fixtures author `frame_index: 1`. We pass through for now — if hardware
     * shows an off-by-one, this is the ONE line to change (e.g. `n - 1`).
     */
    function frameIndexToInitPos(frameIndex) {
        if (frameIndex === undefined || frameIndex === null || frameIndex === '') return 0;
        const n = Number(frameIndex);
        if (!Number.isFinite(n)) {
            throw new Error('frame_index is not a number: ' + JSON.stringify(frameIndex));
        }
        return n; // pass-through (see note above)
    }

    function toNumber(value, name) {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            throw new Error(name + ' is not a number: ' + JSON.stringify(value));
        }
        return n;
    }

    /**
     * Build the encodeTrialParams() argument object from a condition's
     * trialParams command + an externally-resolved 1-based SD pattern index.
     *
     * Coerces every numeric field with Number() (defends against YAML parsers
     * that yield string scalars) and throws a CLEAR Error on values the wire
     * can't represent, before the encoder's terser RangeError would fire:
     *   - mode ∉ {2,3,4}
     *   - non-integer / < 1 patternId
     * Gain is coerced; encodeTrialParams enforces the int16 range. frame_rate
     * is passed through SIGNED — negative plays Mode 2 in reverse (G4-style
     * count-down; fw ee74c33+, fw issue #4), sign ignored by firmware in
     * Modes 3/4; encodeTrialParams enforces the int16 range.
     *
     * COMPAT (2026-07-08): the wire `duration` is PINNED TO 0 — "no controller
     * auto-stop" — while host-side timing (hostSideTrialEnd) remains the
     * authoritative trial clock. Sending the real duration made fw #39
     * controllers blank the display at exactly `duration` seconds, where
     * protocols authored against host timing expect the pattern to keep
     * playing until the next command (often through the ITI). Host timing is
     * untouched: translateCommand's durationSec / conditionDuration read
     * cmd.duration directly. Re-enable (pass cmd.duration through) together
     * with the run-complete timing swap at the SWAP POINT below.
     *
     * duty (fw #33, the optional 12th TRIAL_PARAMS byte) is ALWAYS included —
     * 0 when the protocol omits it, which firmware reads as "the pattern's
     * stored duty_cycle flows through unchanged". Always declaring it keeps
     * every trial self-describing: the runner never emits ALL_OFF between
     * trials, so relying on the controller's cleared-on-ALL_OFF behavior
     * would leak one trial's override into the next. Validated here (not in
     * the encoder) so a bad value skips the trial via translateCommand's
     * {op:'error'} instead of aborting the whole sequence from _runIR.
     *
     * @param {object} cmd  the trialParams controller command
     * @param {{patternId:number}} opts  the resolved 1-based SD index
     * @returns {{mode:number, patternId:number, frameRate:number, gain:number, initPos:number, duration:number, duty:number}}
     */
    function buildTrialParams(cmd, opts) {
        cmd = cmd || {};
        opts = opts || {};

        const mode = cmd.mode === undefined ? 2 : toNumber(cmd.mode, 'mode');
        if (mode !== 2 && mode !== 3 && mode !== 4) {
            throw new Error(
                'Unsupported mode ' +
                    mode +
                    ' — dry-run handles mode 2 (open-loop), 3 (show-frame), or 4 (closed-loop).'
            );
        }

        const frameRate = cmd.frame_rate === undefined ? 0 : toNumber(cmd.frame_rate, 'frame_rate');

        const gain = cmd.gain === undefined ? 0 : toNumber(cmd.gain, 'gain');
        const initPos = frameIndexToInitPos(cmd.frame_index);
        const duration = 0; // COMPAT: no controller auto-stop — see the doc block above

        // '' is what a blank designer field would yield — treat as unset, not
        // Number('') === 0 by accident (they happen to agree, but be explicit).
        const duty = cmd.duty === undefined || cmd.duty === '' ? 0 : toNumber(cmd.duty, 'duty');
        if (!Number.isInteger(duty) || duty < 0 || duty > 255) {
            throw new Error(
                'duty must be an integer 0..255 (0 = pattern default), got ' +
                    JSON.stringify(cmd.duty)
            );
        }

        const patternId = toNumber(opts.patternId, 'patternId');
        if (!Number.isInteger(patternId) || patternId < 1) {
            throw new Error(
                'patternId must be an integer >= 1 (1-based SD index), got ' +
                    JSON.stringify(opts.patternId)
            );
        }

        return { mode, patternId, frameRate, gain, initPos, duration, duty };
    }

    // The controller commands the sequence runner can EMIT on G6, grounded in the
    // firmware command set (commands.h): trialParams (0x08), allOn (0xFF),
    // allOff (0x00), stopDisplay (0x30), setPositionX → SET_FRAME_POSITION (0x70),
    // setAnalogOut → SET_AO_VOLTAGE (0xA0), setDigitalOut → SET_DIGITAL_OUT (0xAA).
    // The last two are G6-only (native G6-controller BNC I/O); the runner is G6-only
    // so no extra guard is needed. This mirrors plugin-registry's
    // isKnownControllerCommand, duplicated on purpose because this module must stay
    // import-free (no sibling imports). Anything else (e.g. a legacy setColorDepth →
    // SWITCH_GRAYSCALE 0x06, dropped on G6) is an error, not a silent no-op.
    const RUNNABLE_CONTROLLER_COMMANDS = [
        'trialParams',
        'allOn',
        'allOff',
        'stopDisplay',
        'setPositionX',
        'setAnalogOut',
        'setDigitalOut',
        'ledDrive'
    ];

    // BuckPuck 3021/3023 LED driver: map brightness percent (% of MAX light
    // output) to the control voltage (mV) on the "Analog Out" BNC. Digitized from
    // the LEDdynamics datasheet Fig. 3 (normalized output-current vs control-
    // voltage transfer), so "percent" ≈ % of max current/light, not % of the
    // voltage range. Control pin: ≤~1.65 V = full, ≥~4.2 V = off. APPROXIMATE (read
    // off a small figure, ~few %); replace CURVE with measured (mv, frac) points
    // for a photometric calibration. 0% → 5000 mV sits safely past the 4.2 V ±5%
    // shutoff so the LED is reliably dark.
    const LED_OFF_MV = 5000;
    const BUCKPUCK_CURVE = [
        { mv: 1650, frac: 1.0 },
        { mv: 2000, frac: 0.9 },
        { mv: 2500, frac: 0.72 },
        { mv: 3000, frac: 0.5 },
        { mv: 3500, frac: 0.28 },
        { mv: 4000, frac: 0.08 },
        { mv: 4200, frac: 0.0 }
    ];
    // Bench calibration (2026-07-08): with the raw datasheet curve, input 1–4 % left
    // the LED fully dark, 5 % was flickery, 6 % solid — i.e. a ~5 % dead zone at the
    // bottom. LED_ON_FLOOR_PCT removes it: input % is remapped so 1 % lands on the
    // raw-5 % (just-on) level and 100 % stays full, giving a usable 0.1–100 % scale.
    // Documented in configs/calibration/buckpuck_g6.json; see issue #156 for driving
    // this from the rig config. ledDrive (protocol intensity) shares this function.
    const LED_ON_FLOOR_PCT = 5;
    function ledPercentToMv(percent) {
        const p = Number(percent);
        if (!Number.isFinite(p) || p <= 0) return LED_OFF_MV;
        // Remap 1..100 % → raw ON_FLOOR..100 % (linear), so the dead zone is gone.
        const inPct = Math.min(100, p);
        const rawPct = LED_ON_FLOOR_PCT + ((inPct - 1) * (100 - LED_ON_FLOOR_PCT)) / 99;
        const frac = Math.max(0, Math.min(1, rawPct / 100));
        const c = BUCKPUCK_CURVE;
        if (frac >= c[0].frac) return c[0].mv;
        for (let i = 0; i < c.length - 1; i++) {
            const a = c[i];
            const b = c[i + 1];
            if (frac <= a.frac && frac >= b.frac) {
                const t = (a.frac - frac) / (a.frac - b.frac);
                return Math.round(a.mv + t * (b.mv - a.mv));
            }
        }
        return c[c.length - 1].mv;
    }

    /**
     * The wall-clock duration of a condition, in seconds: max(trialParams.duration,
     * sum of wait durations). Mirrors the v3 designer's timeline math; pure so the
     * runner and the timeline preview share ONE definition. Number()-coerces to
     * defend against string YAML scalars. Rounded to ms precision so summed floats
     * don't surface IEEE artifacts (0.74×3 = 2.2199999999999998 → 2.22) in the Run
     * chips / estimate / timeline; the actual arena timing uses each command's own
     * duration (not this), so the rounding is display/estimate-only.
     */
    function conditionDuration(cond) {
        if (!cond || !Array.isArray(cond.commands)) return 0;
        let tp = 0;
        let wait = 0;
        for (const c of cond.commands) {
            if (c && c.type === 'controller' && c.command_name === 'trialParams') {
                tp = Math.max(tp, Number(c.duration) || 0);
            }
            if (c && c.type === 'wait') wait += Number(c.duration) || 0;
        }
        return Math.round(Math.max(tp, wait) * 1000) / 1000;
    }

    /**
     * Count the wire-sending commands in a condition (everything except `wait`,
     * which is a local timer, not a serial round-trip). conditionDuration counts
     * only nominal display/wait time; each of these commands also costs a real
     * `await link.send(...)` round-trip, and across a whole protocol those add up
     * to a drift the duration sum misses. The run estimate multiplies this count
     * by a per-command overhead that the app LEARNS from completed runs (a fixed
     * constant can't fit both command-light and command-heavy protocols). PURE, so
     * it sits alongside conditionDuration as the estimator's other primitive.
     */
    function conditionCommandCount(cond) {
        if (!cond || !Array.isArray(cond.commands)) return 0;
        let n = 0;
        for (const c of cond.commands) if (c && c.type !== 'wait') n++;
        return n;
    }

    /**
     * Flatten an experiment_structure into the ordered list of steps the runner
     * (and the timeline preview) execute: refs, block trials × repetitions, and
     * intertrial (ITI) conditions inserted BETWEEN consecutive trials but NOT after
     * the final trial of the final rep.
     *
     * PURE — takes the parsed `experiment` object, returns { steps, hasRandom }.
     * `opts.shuffle(arr)` (optional) is applied per-rep to a block's trial order
     * when the block has `randomize: true`; the timeline preview passes NO shuffle
     * (nominal order), the run path passes a real shuffle. `opts.conditionDuration`
     * overrides the duration function (defaults to the module's).
     *
     * Step shapes (kind):
     *   ref         { kind, label, conditionName, seqIdx, dur }
     *   block-trial { kind, label, conditionName, seqIdx, blockName, trialIdxInBlock,
     *                 dur, rep, repsTotal, randomize }
     *   iti         { kind, label, conditionName, seqIdx, blockName, dur }
     */
    function flattenStructure(experiment, opts) {
        opts = opts || {};
        const durOf =
            typeof opts.conditionDuration === 'function'
                ? opts.conditionDuration
                : conditionDuration;
        const shuffle = typeof opts.shuffle === 'function' ? opts.shuffle : null;
        const out = { steps: [], hasRandom: false };
        if (
            !experiment ||
            !Array.isArray(experiment.sequence) ||
            !Array.isArray(experiment.conditions)
        ) {
            return out;
        }
        const byName = new Map(experiment.conditions.map((c) => [c.name, c]));
        const steps = out.steps;
        for (let seqIdx = 0; seqIdx < experiment.sequence.length; seqIdx++) {
            const entry = experiment.sequence[seqIdx];
            if (!entry) continue;
            if (entry.kind === 'ref') {
                steps.push({
                    kind: 'ref',
                    label: entry.condition_name,
                    conditionName: entry.condition_name,
                    seqIdx,
                    dur: durOf(byName.get(entry.condition_name))
                });
            } else if (entry.kind === 'block') {
                if (entry.randomize) out.hasRandom = true;
                const reps = entry.repetitions || 1;
                const iti = entry.intertrial ? byName.get(entry.intertrial) : null;
                const baseTrials = Array.isArray(entry.trials) ? entry.trials : [];
                for (let r = 0; r < reps; r++) {
                    // Randomize per-rep only when a shuffle is supplied (the run
                    // path). slice() so the source array is never mutated.
                    const trials =
                        entry.randomize && shuffle ? shuffle(baseTrials.slice()) : baseTrials;
                    for (let t = 0; t < trials.length; t++) {
                        const condName = trials[t];
                        steps.push({
                            kind: 'block-trial',
                            label: condName,
                            conditionName: condName,
                            seqIdx,
                            blockName: entry.name,
                            trialIdxInBlock: t,
                            dur: durOf(byName.get(condName)),
                            rep: r,
                            repsTotal: reps,
                            randomize: !!entry.randomize
                        });
                        const isLastTrialOfFinalRep = r === reps - 1 && t === trials.length - 1;
                        if (entry.intertrial && !isLastTrialOfFinalRep) {
                            steps.push({
                                kind: 'iti',
                                label: 'iti: ' + entry.intertrial,
                                conditionName: entry.intertrial,
                                seqIdx,
                                blockName: entry.name,
                                dur: durOf(iti)
                            });
                        }
                    }
                }
            }
        }
        return out;
    }

    /**
     * Translate ONE v3 command into a wire-neutral instruction descriptor (the
     * "command IR"). PURE and wire-free so it is trivially unit-testable; the
     * executor (ArenaRunner.runSequence) maps each `op` to an ArenaWireG6 encoder.
     *
     * @param {object} cmd  a v3 command ({type:'controller'|'wait'|'plugin', …})
     * @param {object} [opts]
     * @param {number|null} [opts.patternId]  resolved 1-based SD index for a
     *        trialParams command (null/undefined ⇒ unresolvable ⇒ {op:'error'}).
     * @param {Set<string>} [opts.fictracPluginNames]  plugin names whose class is
     *        FicTracPlugin — such plugin commands become fictrac* ops (else skip).
     * @returns {object} one of:
     *   { op:'trialParams', params, durationSec }
     *   { op:'allOn' | 'allOff' | 'stopDisplay' }
     *   { op:'setFramePosition', index }            // 0-based frame index (Mode 3)
     *   { op:'setAnalogOut', mv }                    // G6-only, 0–5000 mV (0xA0)
     *   { op:'setDigitalOut', channel, state }       // G6-only, ch 1|2, state 0|1 (0xAA)
     *   { op:'wait', durationSec }
     *   { op:'logMessage', message, level }          // built-in log plugin → bridge log
     *   { op:'fictracConnect' | 'fictracDisconnect' }        // FicTrac bridge lifecycle
     *   { op:'fictracApply', on, gain }              // start/stop Mode-3 closed-loop
     *   { op:'skip', reason, plugin_name, command_name }   // other plugin → not driveable
     *   { op:'error', reason }                              // unsupported / malformed
     */
    function translateCommand(cmd, opts) {
        opts = opts || {};
        if (!cmd || !cmd.type) {
            return { op: 'error', reason: 'Malformed command (missing type).' };
        }
        if (cmd.type === 'wait') {
            return { op: 'wait', durationSec: Number(cmd.duration) || 0 };
        }
        if (cmd.type === 'plugin') {
            const pname = cmd.plugin_name || '(unnamed)';
            const cname = cmd.command_name || '(unnamed)';
            const params = cmd.params || {};
            // The built-in `log` plugin is EXECUTED (Decision 6): its message is
            // written to the unified bridge log. Always, independent of fictrac names.
            if (cmd.plugin_name === 'log') {
                return {
                    op: 'logMessage',
                    message: params.message != null ? String(params.message) : '',
                    level: params.level || 'INFO'
                };
            }
            // FicTrac is the first runner-driven device plugin. The caller passes the
            // set of plugin names whose class is FicTracPlugin (opts.fictracPluginNames).
            const fictracNames = opts.fictracPluginNames;
            const isFictrac =
                fictracNames &&
                typeof fictracNames.has === 'function' &&
                fictracNames.has(cmd.plugin_name);
            if (isFictrac) {
                switch (cname) {
                    case 'connect':
                        return { op: 'fictracConnect' };
                    case 'disconnect':
                        return { op: 'fictracDisconnect' };
                    case 'startClosedLoop':
                        return {
                            op: 'fictracApply',
                            on: true,
                            gain: Number.isFinite(Number(params.gain)) ? Number(params.gain) : null
                        };
                    case 'stopClosedLoop':
                        return { op: 'fictracApply', on: false };
                    default:
                        return {
                            op: 'skip',
                            reason: 'unknown fictrac command "' + cname + '"',
                            plugin_name: pname,
                            command_name: cname
                        };
                }
            }
            // Any other plugin: skipped-with-warning (unchanged — the browser can't
            // drive arbitrary MATLAB-side plugins).
            return {
                op: 'skip',
                reason: 'plugin command (the browser cannot drive plugins)',
                plugin_name: pname,
                command_name: cname
            };
        }
        if (cmd.type === 'controller') {
            const name = cmd.command_name;
            if (name === 'trialParams') {
                if (opts.patternId === undefined || opts.patternId === null) {
                    return {
                        op: 'error',
                        reason:
                            'No SD pattern index for trialParams pattern "' +
                            (cmd.pattern || '(empty)') +
                            '" — not in the active set and no usable pattern_ID.'
                    };
                }
                let params;
                try {
                    params = buildTrialParams(cmd, { patternId: opts.patternId });
                } catch (e) {
                    return { op: 'error', reason: e.message };
                }
                return {
                    op: 'trialParams',
                    params,
                    durationSec: Number(cmd.duration) > 0 ? Number(cmd.duration) : 0
                };
            }
            if (name === 'allOn') return { op: 'allOn' };
            if (name === 'allOff') return { op: 'allOff' };
            if (name === 'stopDisplay') return { op: 'stopDisplay' };
            if (name === 'setPositionX') {
                // Mode-3 frame jump: posX is a 0-based frame index → 0x70.
                const index = Number(cmd.posX);
                return { op: 'setFramePosition', index: Number.isFinite(index) ? index : 0 };
            }
            if (name === 'setAnalogOut') {
                // G6-only: drive BNC J27 DAC (SET_AO_VOLTAGE 0xA0), 0–5000 mV.
                const mv = Number(cmd.mv);
                if (!Number.isInteger(mv) || mv < 0 || mv > 5000) {
                    return {
                        op: 'error',
                        reason:
                            'setAnalogOut mv must be an integer 0–5000 (millivolts), got ' +
                            JSON.stringify(cmd.mv)
                    };
                }
                return { op: 'setAnalogOut', mv };
            }
            if (name === 'ledDrive') {
                // BuckPuck LED driver on the AO line: percent (0..100, % of full
                // brightness) → control voltage (mV) via the datasheet curve, then
                // reuse the setAnalogOut IR (SET_AO_VOLTAGE 0xA0). Instantaneous.
                const pct = Number(cmd.percent);
                if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
                    return {
                        op: 'error',
                        reason:
                            'ledDrive percent must be a number 0–100, got ' +
                            JSON.stringify(cmd.percent)
                    };
                }
                // ledPercent rides along so the scope can label the LED box with
                // the commanded % (the mv is the inverted BuckPuck control voltage).
                return { op: 'setAnalogOut', mv: ledPercentToMv(pct), ledPercent: pct };
            }
            if (name === 'setDigitalOut') {
                // G6-only: drive the "Digital IO 1/2 (5V)" BNCs (J3/J4) as TTL outputs
                // (SET_DIGITAL_OUT 0xAA; channel == board silkscreen number).
                const channel = Number(cmd.channel);
                const state = Number(cmd.state);
                if (channel !== 1 && channel !== 2) {
                    return {
                        op: 'error',
                        reason:
                            'setDigitalOut channel must be 1 (DO1/J3) or 2 (DO2/J4), got ' +
                            JSON.stringify(cmd.channel)
                    };
                }
                if (state !== 0 && state !== 1) {
                    return {
                        op: 'error',
                        reason:
                            'setDigitalOut state must be 0 (LOW) or 1 (HIGH), got ' +
                            JSON.stringify(cmd.state)
                    };
                }
                return { op: 'setDigitalOut', channel, state };
            }
            return {
                op: 'error',
                reason:
                    'Unsupported controller command "' +
                    (name || '(unnamed)') +
                    '" — not in the G6 runner palette ' +
                    '(trialParams/allOn/allOff/stopDisplay/setPositionX).' +
                    (name === 'setColorDepth'
                        ? ' setColorDepth maps to SWITCH_GRAYSCALE 0x06, which is dropped on G6 ' +
                          '(color depth is a .pat/SD-header property, not a runtime command).'
                        : '')
            };
        }
        return { op: 'error', reason: 'Unknown command type "' + cmd.type + '".' };
    }

    // ---- timing model (interim host-side) -------------------------------

    /**
     * TIMING MODEL — interim, host-side (firmware issue
     * reiserlab/LED-Display_G6_Firmware_Arena#4). The controller-run trial
     * `duration` is NOT in firmware yet, so the browser holds the trial's display
     * time. IMPORTANT: a trialParams display OVERLAPS the condition's `wait`
     * commands (the controller loops the pattern autonomously while the host waits),
     * so the trial duration is NOT added to the waits. runSequence sleeps the waits
     * as they occur, then calls this ONCE per condition to "top up" only the
     * remainder — `max(trialDuration, sum(waits)) - sum(waits)` — giving a
     * wall-clock of `max(trialDuration, sum(waits))`, matching conditionDuration /
     * the timeline. (Sleeping per trialParams AND per wait double-counted — the bug
     * this model fixes.)
     *
     * SWAP POINT: once #4 lands (trial_params carries a controller-run duration and
     * the controller signals completion), replace this with a function that AWAITS
     * the controller's run-complete event instead of sleeping — or inject
     * `opts.timing` into runSequence. Nothing else in the runner changes.
     * The wire-side duration exists in the encoder, but buildTrialParams PINS
     * it to 0 (compat — see its doc block): the two must flip together. When
     * this function is replaced with an await-run-complete implementation,
     * also pass cmd.duration through in buildTrialParams so the controller
     * actually times the trial.
     *
     * Best-effort: a slept/closed tab won't fire the timer, so STOP/abort is the
     * primary control.
     *
     * @param {number} remainderSec               trial time left after the waits (0 ⇒ none)
     * @param {function(number):Promise} sleep     abort-aware sleep(ms)
     */
    async function hostSideTrialEnd(remainderSec, sleep) {
        await sleep((Number(remainderSec) || 0) * 1000);
    }

    // ---- run-state machine ----------------------------------------------

    /**
     * Owns one active run at a time — either a single-trial dry-run (start) or a
     * whole flattened sequence (runSequence). A double-click can't queue two runs
     * because both reject while active.
     *
     * STOP is best-effort: a closed/slept tab won't fire the auto-stop timer or the
     * host-side trial timing, so manual stop() is the primary mechanism. stop() sets
     * an abort flag the sequence loop checks before every step and every command,
     * and resolves any in-progress host-side wait immediately so STOP halts promptly.
     */
    class ArenaRunner {
        /**
         * @param {object} link  an ArenaLink-like object with .send(bytes) and .connected
         * @param {object} [wire] the ArenaWireG6 module (defaults to window.ArenaWireG6)
         * @param {object} [bridge] a FicTracBridgeClient-like object (connect/disconnect/
         *        setApply/setConfig/log). Optional — only needed to execute fictrac
         *        plugin commands; without it those ops degrade to a logged note.
         */
        constructor(link, wire, bridge) {
            this._link = link;
            this._wire = wire || (typeof window !== 'undefined' ? window.ArenaWireG6 : null);
            if (!this._wire) {
                throw new Error('ArenaRunner: ArenaWireG6 is not available.');
            }
            this._bridge = bridge || null;
            this._active = false;
            this._timer = null; // single-trial auto-stop timer
            this._conditionName = null;
            this._lastResponse = null;
            this._abort = false; // sequence abort flag (set by stop()/_clear())
            this._sleepTimer = null; // in-progress host-side wait timer
            this._sleepResolve = null; // resolver for the in-progress wait
        }

        get active() {
            return this._active;
        }
        get conditionName() {
            return this._conditionName;
        }
        get lastResponse() {
            return this._lastResponse;
        }

        /**
         * Send trialParams and (optionally) arm an auto-stop after durationSec.
         * @param {object} a
         * @param {object} a.params         encodeTrialParams() argument object
         * @param {number} [a.durationSec]  auto-stop after this many seconds (>0)
         * @param {string} [a.conditionName]
         * @param {function} [a.onStatus]   status callback (phase events)
         * @returns {Promise<object|null>}  the decoded response (or null)
         */
        async start(a) {
            a = a || {};
            if (this._active) {
                throw new Error('A run is already active — stop it first.');
            }
            if (!a.params) {
                throw new Error('ArenaRunner.start requires { params }.');
            }
            const emit = (s) => {
                if (typeof a.onStatus === 'function') a.onStatus(s);
            };

            this._active = true;
            this._conditionName = a.conditionName || null;

            let frame;
            try {
                emit({ phase: 'sending', conditionName: this._conditionName, params: a.params });
                frame = await this._link.send(this._wire.encodeTrialParams(a.params));
            } catch (e) {
                // never armed — reset and rethrow for the caller to surface
                this._clear();
                emit({ phase: 'error', error: e });
                throw e;
            }

            const resp = this._wire.decodeResponse(frame);
            this._lastResponse = resp;

            if (!resp || !resp.ok) {
                // controller refused the command — nothing is running
                this._clear();
                emit({ phase: 'rejected', response: resp });
                return resp;
            }

            emit({ phase: 'running', response: resp, conditionName: this._conditionName });

            const ms = Number(a.durationSec) > 0 ? Number(a.durationSec) * 1000 : 0;
            if (ms > 0) {
                this._timer = setTimeout(() => {
                    this._timer = null;
                    this.stop()
                        .then(() => emit({ phase: 'auto-stopped' }))
                        .catch(() => {
                            /* best-effort */
                        });
                }, ms);
            }
            return resp;
        }

        /**
         * Stop the active run: raise the abort flag, resolve any in-progress
         * host-side wait, clear the auto-stop timer, mark inactive, and send STOP if
         * the link is connected. Idempotent and NOT import-mode-guarded by the
         * UI — a run must remain stoppable. The sequence loop, if running, observes
         * the abort flag and unwinds (its own finally also sends STOP — harmless).
         * @returns {Promise<object|null>} the STOP response (or null if offline)
         */
        async stop() {
            this._abort = true;
            this._resolveSleep();
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
            this._active = false;
            this._conditionName = null;
            if (this._link && this._link.connected) {
                return this._link.send(this._wire.encodeStop());
            }
            return null;
        }

        /** Public abort-without-STOP. Aborts a running sequence and unblocks its
         *  current host-side wait WITHOUT sending a STOP frame — for use when the
         *  link is already gone (involuntary disconnect / link error), where a
         *  STOP send would only error. Prefer this over poking the private
         *  `_clear()` (ArenaSession calls this on the link's onDisconnect). */
        abort() {
            this._clear();
        }

        /** Clear run-state without sending STOP (used on disconnect/error). Also
         *  aborts a running sequence and unblocks its current wait. */
        _clear() {
            this._abort = true;
            this._resolveSleep();
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
            this._active = false;
            this._conditionName = null;
        }

        /** Resolve + clear any in-progress host-side wait (makes STOP prompt). */
        _resolveSleep() {
            if (this._sleepTimer) {
                clearTimeout(this._sleepTimer);
                this._sleepTimer = null;
            }
            if (this._sleepResolve) {
                const r = this._sleepResolve;
                this._sleepResolve = null;
                r();
            }
        }

        /**
         * Abort-aware sleep: resolves after `ms`, OR immediately if already aborted
         * or stop() fires mid-wait. Only one wait is outstanding at a time (the
         * sequence loop awaits each in turn).
         */
        _sleep(ms) {
            return new Promise((resolve) => {
                if (this._abort || !(ms > 0)) {
                    resolve();
                    return;
                }
                this._sleepResolve = resolve;
                this._sleepTimer = setTimeout(() => {
                    this._sleepTimer = null;
                    this._sleepResolve = null;
                    resolve();
                }, ms);
            });
        }

        /**
         * Run a whole flattened sequence on the arena. Walks each step's condition
         * and replays its command list in order (trialParams / allOn / allOff /
         * stopDisplay / setPositionX + client-side waits). The built-in `log` plugin
         * and `fictrac` plugin commands are EXECUTED (log → bridge log; fictrac →
         * closed/open-loop via the bridge client); all OTHER plugin commands are
         * skipped-with-warning; unsupported controller commands (e.g. setColorDepth)
         * and unresolvable patterns are surfaced as errors then skipped (the
         * proceed-and-skip policy). Trial timing is host-side (see hostSideTrialEnd).
         * The abort flag is checked before every step AND every command, so STOP
         * halts promptly. On completion or abort the finally sends a best-effort STOP.
         *
         * @param {object} a
         * @param {Array}    a.steps             flattenStructure(...).steps
         * @param {Map}      a.conditionsByName  conditionName → condition object
         * @param {function} a.resolvePatternId  (trialParamsCmd) ⇒ 1-based SD index | null
         * @param {function} [a.resolvePatternFrames] (trialParamsCmd) ⇒ frame count | null
         *                                        (Mode-3 index modulus for closed-loop)
         * @param {Set|Array} [a.fictracPluginNames]  plugin names whose class is FicTracPlugin
         * @param {function} [a.onProgress]      progress/event callback (see phases below)
         * @param {function} [a.timing]          async (durationSec, sleep) ⇒ trial end
         *                                        (defaults to host-side; firmware #4 swap)
         * @param {function} [a.sleep]           async (ms) ⇒ void (defaults to the
         *                                        abort-aware _sleep; tests inject instant)
         * @returns {Promise<{completed:boolean, aborted:boolean, steps:number, errors:number, skipped:number}>}
         */
        async runSequence(a) {
            a = a || {};
            if (this._active) {
                throw new Error('A run is already active — stop it first.');
            }
            const steps = Array.isArray(a.steps) ? a.steps : [];
            const conditionsByName = a.conditionsByName || new Map();
            const resolvePatternId =
                typeof a.resolvePatternId === 'function' ? a.resolvePatternId : () => null;
            const resolvePatternFrames =
                typeof a.resolvePatternFrames === 'function' ? a.resolvePatternFrames : () => null;
            const fictracPluginNames =
                a.fictracPluginNames instanceof Set
                    ? a.fictracPluginNames
                    : Array.isArray(a.fictracPluginNames)
                      ? new Set(a.fictracPluginNames)
                      : null;
            const timing = typeof a.timing === 'function' ? a.timing : hostSideTrialEnd;
            const sleep = typeof a.sleep === 'function' ? a.sleep : (ms) => this._sleep(ms);
            const emit = (s) => {
                if (typeof a.onProgress === 'function') a.onProgress(s);
            };

            this._active = true;
            this._abort = false;
            const summary = {
                completed: false,
                aborted: false,
                steps: steps.length,
                errors: 0,
                skipped: 0
            };

            try {
                emit({ phase: 'sequence-start', total: steps.length });
                for (let i = 0; i < steps.length; i++) {
                    if (this._abort) break;
                    const step = steps[i];
                    const cond = conditionsByName.get(step.conditionName) || null;
                    this._conditionName = step.conditionName || null;
                    emit({
                        phase: 'step-start',
                        index: i,
                        total: steps.length,
                        step,
                        next: i + 1 < steps.length ? steps[i + 1] : null
                    });
                    if (!cond || !Array.isArray(cond.commands)) {
                        summary.errors++;
                        emit({
                            phase: 'error',
                            index: i,
                            step,
                            reason:
                                'Condition "' +
                                step.conditionName +
                                '" not found or has no commands — skipped.'
                        });
                        emit({ phase: 'step-done', index: i, total: steps.length, step });
                        continue;
                    }
                    // Per-condition timing accumulators: the max trialParams target
                    // duration and the total time actually slept on wait commands.
                    // fictracFrames tracks the current Mode-3 pattern's frame count
                    // (index modulus) so a following fictrac.startClosedLoop can push
                    // the right modulus to the bridge.
                    const acc = { trialTargetSec: 0, waitedSec: 0, fictracFrames: null };
                    for (const cmd of cond.commands) {
                        if (this._abort) break;
                        const ir = translateCommand(cmd, {
                            patternId: resolvePatternId(cmd),
                            fictracPluginNames
                        });
                        if (cmd.type === 'controller' && cmd.command_name === 'trialParams') {
                            const f = Number(resolvePatternFrames(cmd));
                            if (Number.isFinite(f) && f > 0) acc.fictracFrames = f;
                        }
                        try {
                            await this._runIR(ir, { step, index: i, emit, sleep, summary, acc });
                        } catch (e) {
                            // A wire/link failure mid-command: surface it and abort
                            // the run (the finally sends STOP). Don't blindly continue
                            // past a possible protocol desync.
                            summary.errors++;
                            this._abort = true;
                            emit({
                                phase: 'error',
                                index: i,
                                step,
                                error: e,
                                reason: 'send failed: ' + (e && (e.message || e))
                            });
                            break;
                        }
                    }
                    // Condition-level host-side trial timing: hold so the trial gets
                    // its full display duration OVERLAPPING the waits (not added to
                    // them), making wall-clock == max(trialDuration, sum(waits)) — the
                    // value conditionDuration / the timeline shows. When firmware #4
                    // lands (controller enforces duration + signals done), this top-up
                    // is what gets swapped for awaiting that signal.
                    if (!this._abort && acc.trialTargetSec > acc.waitedSec) {
                        await timing(acc.trialTargetSec - acc.waitedSec, sleep);
                    }
                    emit({ phase: 'step-done', index: i, total: steps.length, step });
                }
                summary.aborted = this._abort;
                summary.completed = !this._abort;
                emit({ phase: this._abort ? 'aborted' : 'sequence-complete', summary });
                return summary;
            } finally {
                // Best-effort STOP at the end / on abort, then reset run-state.
                this._active = false;
                this._conditionName = null;
                this._resolveSleep();
                try {
                    if (this._link && this._link.connected) {
                        await this._link.send(this._wire.encodeStop());
                    }
                } catch (_) {
                    /* best-effort */
                }
            }
        }

        /**
         * Execute one command IR over the link: send the matching wire frame and,
         * for trialParams, apply the host-side trial timing. Skips/errors are
         * surfaced via emit and do NOT abort the run. Mutates `ctx.summary`.
         * Throws only on a link/send failure (the caller aborts the run).
         */
        async _runIR(ir, ctx) {
            const { step, index, emit, sleep, summary, acc } = ctx;
            const W = this._wire;
            switch (ir.op) {
                case 'trialParams': {
                    const frame = await this._link.send(W.encodeTrialParams(ir.params));
                    const resp = W.decodeResponse(frame);
                    this._lastResponse = resp;
                    if (!resp || !resp.ok) {
                        summary.errors++;
                        emit({
                            phase: 'error',
                            index,
                            step,
                            response: resp,
                            reason: 'controller rejected trialParams'
                        });
                        return;
                    }
                    emit({
                        phase: 'trial-running',
                        index,
                        step,
                        response: resp,
                        params: ir.params,
                        durationSec: ir.durationSec
                    });
                    // Trial timing is host-side (interim — firmware #4) but does NOT
                    // block here: the controller displays the pattern autonomously
                    // while the condition's wait commands run CONCURRENTLY. We only
                    // record the trial's target duration; runSequence tops up at the
                    // end of the condition if the waits didn't cover it, so the
                    // condition's wall-clock == max(trialDuration, sum(waits)) — the
                    // same value the timeline estimates. (Sleeping here AND on every
                    // wait double-counted the time.)
                    acc.trialTargetSec = Math.max(acc.trialTargetSec, Number(ir.durationSec) || 0);
                    return;
                }
                case 'allOn':
                    await this._link.send(W.encodeAllOn());
                    emit({ phase: 'command', index, step, op: ir.op });
                    return;
                case 'allOff':
                    await this._link.send(W.encodeAllOff());
                    emit({ phase: 'command', index, step, op: ir.op });
                    return;
                case 'stopDisplay':
                    await this._link.send(W.encodeStop());
                    emit({ phase: 'command', index, step, op: ir.op });
                    return;
                case 'setFramePosition':
                    await this._link.send(W.encodeSetFramePosition(ir.index));
                    emit({ phase: 'command', index, step, op: ir.op, value: ir.index });
                    return;
                case 'setAnalogOut':
                    await this._link.send(W.encodeSetAoVoltage(ir.mv));
                    emit({
                        phase: 'command',
                        index,
                        step,
                        op: ir.op,
                        value: ir.mv,
                        ledPercent: ir.ledPercent
                    });
                    return;
                case 'setDigitalOut':
                    await this._link.send(W.encodeSetDigitalOut(ir.channel, ir.state));
                    emit({
                        phase: 'command',
                        index,
                        step,
                        op: ir.op,
                        value: { channel: ir.channel, state: ir.state }
                    });
                    return;
                case 'wait':
                    await sleep((Number(ir.durationSec) || 0) * 1000);
                    acc.waitedSec += Number(ir.durationSec) || 0;
                    emit({ phase: 'command', index, step, op: ir.op, value: ir.durationSec });
                    return;
                // ---- FicTrac (the first runner-driven device plugin) ----------
                // These ops are INSTANTANEOUS: they open/close the bridge or toggle
                // its apply flag / push config. Duration is held by the
                // surrounding wait/trialParams; the Mode-3 apply loop streams frames
                // in the background on the bridge client's WS events. They do NOT
                // touch the timing accumulators.
                case 'fictracConnect':
                    if (this._bridge) {
                        try {
                            this._bridge.connect();
                        } catch (_) {
                            /* best-effort; the designer also auto-connects at run start */
                        }
                    }
                    emit({ phase: 'command', index, step, op: ir.op });
                    return;
                case 'fictracDisconnect':
                    if (this._bridge) {
                        try {
                            this._bridge.disconnect();
                        } catch (_) {
                            /* best-effort */
                        }
                    }
                    emit({ phase: 'command', index, step, op: ir.op });
                    return;
                case 'fictracApply':
                    if (this._bridge) {
                        if (ir.on) {
                            const cfg = {};
                            if (Number.isFinite(acc.fictracFrames)) cfg.frames = acc.fictracFrames;
                            if (ir.gain != null) cfg.gain = ir.gain;
                            if (Object.keys(cfg).length) this._bridge.setConfig(cfg);
                            this._bridge.setApply(true);
                        } else {
                            this._bridge.setApply(false);
                        }
                    }
                    emit({ phase: 'command', index, step, op: ir.op, value: !!ir.on });
                    return;
                case 'logMessage':
                    if (this._bridge)
                        this._bridge.log({ event: 'log', message: ir.message, level: ir.level });
                    emit({ phase: 'log', index, step, message: ir.message, level: ir.level });
                    return;
                case 'skip':
                    summary.skipped++;
                    emit({
                        phase: 'skip',
                        index,
                        step,
                        reason: ir.reason,
                        plugin_name: ir.plugin_name,
                        command_name: ir.command_name
                    });
                    return;
                case 'error':
                default:
                    summary.errors++;
                    emit({ phase: 'error', index, step, reason: ir.reason || 'unknown command' });
                    return;
            }
        }
    }

    return {
        findTrialParams,
        listSkippedPlugins,
        isDryRunEligible,
        frameIndexToInitPos,
        buildTrialParams,
        conditionDuration,
        conditionCommandCount,
        flattenStructure,
        translateCommand,
        hostSideTrialEnd,
        RUNNABLE_CONTROLLER_COMMANDS,
        LED_OFF_MV, // BuckPuck "LED dark" analog level (mV) — the scope's on/off threshold
        ledPercentToMv, // BuckPuck brightness % → AO control voltage (mV); 0% → LED_OFF_MV
        ArenaRunner
    };
})();

// Export for Node.js (CommonJS) — used by tests/test-arena-runner-g6.js.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ArenaRunnerG6;
}

// Export for browser (global) — used by <script src=> callers (the Arena
// Console and the v3 Experiment Designer) which read window.ArenaRunnerG6.
if (typeof window !== 'undefined') {
    window.ArenaRunnerG6 = ArenaRunnerG6;
}
