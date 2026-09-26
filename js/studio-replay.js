/**
 * studio-replay.js — Arena Studio run-log REPLAY: play a recorded experiment back
 * through the live Run view (sequence highlight + Scope + optional 3D arena window).
 *
 * Ported from the Arena Studio Alt reference (js/arena-studio-alt.js, v0.67) into the
 * Classic Studio, with three changes the lab asked for (2026-09-24):
 *   1. ONE input. A run log is enough: its `run_metadata` names the protocol
 *      (protocol_filename + protocol_sha256 + rig_id), so the protocol is FOUND, not
 *      picked — the open doc if its sha matches, else the course repo
 *      (protocols/<rig_id>/, the log's own bench folder, shared/, every other bench),
 *      else this site's library (protocols/index.json), and when the file has been
 *      edited since the run, its git HISTORY is walked for the exact version whose
 *      sha matches. The sha is compared both over the raw text and over the Studio's
 *      own serialization (`parseV3Protocol(text)._doc.toString()`, what run_metadata
 *      records — `Studio.protocolDocSha`). A log whose protocol cannot be found still
 *      replays "log-only": the step list is rebuilt from the log's step-start events
 *      and patterns resolve by SD id (the NNN_ prefix of the repo's patterns/ files).
 *   2. A LINK. `?repo=owner/name&replay=runlogs/<bench>/<file>.jsonl.gz` (or
 *      `&replay=<run id>`) opens straight into playback (js/studio-url-state.js). The
 *      write side mirrors an active repo-backed replay into the URL, so the address
 *      bar IS the share link ("Copy link" copies it).
 *   3. "Recent runs" — the course repo's runlogs/<bench>/index.json files, merged
 *      newest-first with a filter, so replaying a run is one click.
 *
 * SAFETY (unchanged from Alt): entering replay latches the page-wide hardware-output
 * interlock (ArenaSession.setOutputInhibited) BEFORE any file is read, refuses while a
 * live run or FicTrac closed loop is active, and marks every live-control surface
 * `inert`. Stop releases the interlock; so does pagehide.
 *
 * STRUCTURE: the top half is DOM-free and Node-tested (tests/test-studio-replay.js):
 * path/sha/filename helpers, the run-index merge, and ONE projection
 * (`applyStatus`/`applyItem`) shared by live playback and seeking, so the two cannot
 * drift (Alt had two hand-kept copies). `install()` is the browser controller; it is
 * called from a classic glue script in arena_studio.html and reads the module-block
 * helpers (Studio.loadProtocol, Studio.protocolDocSha, Studio.webBytesForName, …)
 * lazily, at call time.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES `export`).
 */
(function (global) {
    'use strict';

    // ═════════════════════════════════════════════════════════════════════
    // Pure helpers
    // ═════════════════════════════════════════════════════════════════════

    const LED_OFF_MV_DEFAULT = 5000;
    const RUN_ID_RE = /^[a-z0-9]{6,16}$/;
    const LOG_EXT_RE = /\.(jsonl|ndjson)(\.gz)?$/i;
    const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;
    const RUNLOG_PATH_RE = /^runlogs\/[\w.-]+(?:\/[\w.-]+)*\.(jsonl|ndjson)(\.gz)?$/;
    const PROTOCOL_PATH_RE = /^protocols\/[\w.-]+(?:\/[\w.-]+)*\.ya?ml$/;
    const SPEEDS = [0.5, 1, 2, 4];

    // The 3D fly's walking model (js/fly-gait.js — a classic script loaded before this one;
    // required directly under Node). Optional: without it the fly stands still.
    function flyGait() {
        if (global && global.FlyGait) return global.FlyGait;
        if (typeof require === 'function') {
            try {
                return require('./fly-gait.js');
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    function formatClock(ms) {
        const sec = Math.max(0, Number(ms) || 0) / 1000;
        const min = Math.floor(sec / 60);
        return String(min).padStart(2, '0') + ':' + (sec - min * 60).toFixed(2).padStart(5, '0');
    }

    function positiveModulo(value, base) {
        const v = Math.floor(Number(value) || 0);
        if (!(base > 0) || !Number.isFinite(base)) return Math.max(0, v);
        return ((v % base) + base) % base;
    }

    function normalizeSha(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/^sha256:/, '');
    }

    function baseName(path) {
        return String(path || '')
            .split(/[\\/]/)
            .pop();
    }

    function isSafeSegment(s) {
        return typeof s === 'string' && SEGMENT_RE.test(s) && !s.includes('..');
    }

    function isSafeRunlogPath(p) {
        return typeof p === 'string' && !p.includes('..') && RUNLOG_PATH_RE.test(p);
    }

    function isSafeProtocolPath(p) {
        return typeof p === 'string' && !p.includes('..') && PROTOCOL_PATH_RE.test(p);
    }

    function isSafeRunId(id) {
        return typeof id === 'string' && RUN_ID_RE.test(id);
    }

    // 'runlogs/rig03-sr/x.jsonl.gz' → 'rig03-sr'
    function runlogFolder(path) {
        const m = /^runlogs\/([^/]+)\//.exec(String(path || ''));
        return m && isSafeSegment(m[1]) ? m[1] : null;
    }

    /**
     * Committed run-log names are `<protocol-slug>__<experimenter>__<stamp>__<runid>`
     * (studio `commitRunLog`). Returns the parts, or null for any other name.
     */
    function parseRunlogFilename(name) {
        const b = baseName(name).replace(LOG_EXT_RE, '');
        const parts = b.split('__');
        if (parts.length < 4) return null;
        const runId = parts[parts.length - 1];
        return {
            protocolSlug: parts.slice(0, parts.length - 3).join('__'),
            experimenter: parts[parts.length - 3],
            stamp: parts[parts.length - 2],
            runId: isSafeRunId(runId) ? runId : null
        };
    }

    /**
     * Protocol FILE names to look for: run_metadata.protocol_filename first, then the
     * slug from the log's file name (the slug lower-cases and maps `_`→`-`, so both
     * spellings are tried — fictrac-direction-test ⇐ fictrac_direction_test.yaml).
     */
    function protocolFilenames(meta, logName) {
        const out = [];
        const add = (n) => {
            if (n && /\.ya?ml$/i.test(n) && isSafeSegment(n) && !out.includes(n)) out.push(n);
        };
        const fn = meta && meta.protocol_filename;
        if (typeof fn === 'string' && fn.trim()) add(baseName(fn.trim()));
        const parsed = logName ? parseRunlogFilename(logName) : null;
        if (parsed && parsed.protocolSlug) {
            add(parsed.protocolSlug + '.yaml');
            add(parsed.protocolSlug.replace(/-/g, '_') + '.yaml');
        }
        return out;
    }

    /**
     * Ordered, de-duplicated repo-relative protocol paths to try for a run.
     * opts: {logName, logPath, benchId, hintPath, extraDirs[]}
     *   hintPath  — an explicit `p=` from a link (tried first)
     *   rig_id    — where Studio saves a bench's protocols (protocols/<bench-id>/)
     *   log folder— runlogs/<bench>/… normally equals rig_id; covers logs without it
     *   shared    — promoted protocols
     *   extraDirs — every other protocols/<dir> (the caller lists them lazily)
     */
    function protocolSearchPaths(meta, opts) {
        const o = opts || {};
        const names = protocolFilenames(meta, o.logName);
        const dirs = [];
        const addDir = (d) => {
            if (isSafeSegment(d) && !dirs.includes(d)) dirs.push(d);
        };
        addDir(meta && meta.rig_id);
        addDir(runlogFolder(o.logPath));
        addDir(o.benchId);
        addDir('shared');
        (o.extraDirs || []).forEach(addDir);
        const out = [];
        if (isSafeProtocolPath(o.hintPath)) out.push(o.hintPath);
        for (const d of dirs) {
            for (const n of names) {
                const p = 'protocols/' + d + '/' + n;
                if (!out.includes(p)) out.push(p);
            }
        }
        return out;
    }

    /**
     * Merge runlogs/<folder>/index.json documents (scripts/build-runlog-index.py) into
     * one newest-first list. entries: [{folder, data}] — a null/malformed data is
     * skipped. Each run gains {folder, path, sortMs}.
     */
    function mergeRunIndexes(entries) {
        const runs = [];
        (entries || []).forEach((entry) => {
            if (!entry || !isSafeSegment(entry.folder)) return;
            const list = entry.data && Array.isArray(entry.data.runs) ? entry.data.runs : [];
            list.forEach((r) => {
                if (!r || typeof r.file !== 'string' || !isSafeSegment(r.file)) return;
                if (!LOG_EXT_RE.test(r.file)) return;
                const started = Number(r.started_ms);
                const iso = Date.parse(r.timestamp_start);
                runs.push(
                    Object.assign({}, r, {
                        folder: entry.folder,
                        path: 'runlogs/' + entry.folder + '/' + r.file,
                        sortMs: Number.isFinite(started) ? started : Number.isFinite(iso) ? iso : 0
                    })
                );
            });
        });
        runs.sort((a, b) => b.sortMs - a.sortMs || String(b.file).localeCompare(String(a.file)));
        return runs;
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    /** 'YYYY-MM-DD HH:MM' in the viewer's local time (or '' when unknown). */
    function formatWhen(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return '';
        const d = new Date(ms);
        return (
            d.getFullYear() +
            '-' +
            pad2(d.getMonth() + 1) +
            '-' +
            pad2(d.getDate()) +
            ' ' +
            pad2(d.getHours()) +
            ':' +
            pad2(d.getMinutes())
        );
    }

    function formatDuration(sec) {
        const s = Math.round(Number(sec));
        if (!Number.isFinite(s) || s <= 0) return '';
        const m = Math.floor(s / 60);
        return m + ':' + pad2(s % 60);
    }

    /**
     * Display pieces for an index entry OR a run_metadata object:
     * {title, when, bits:[…]} — bits are the non-empty rig/experimenter/genotype/fly
     * facts in reading order.
     */
    function describeRun(r, logName) {
        const x = r || {};
        const fromName = parseRunlogFilename(logName || x.file || '');
        const title =
            String(x.protocol_filename || '').replace(/\.ya?ml$/i, '') ||
            (fromName && fromName.protocolSlug) ||
            baseName(logName || x.file || 'run log');
        const startMs = Number.isFinite(Number(x.started_ms))
            ? Number(x.started_ms)
            : Date.parse(x.timestamp_start);
        const bits = [];
        const add = (v) => {
            const s = v == null ? '' : String(v).trim();
            if (s && s !== 'none') bits.push(s);
        };
        add(x.rig_id || x.folder);
        add(x.experimenter || (fromName && fromName.experimenter));
        add(x.genotype);
        add(x.sex);
        add(x.age);
        if (x.fly_number != null && String(x.fly_number).trim()) add('fly ' + x.fly_number);
        add(formatDuration(x.duration_s));
        if (x.complete === false) add('incomplete');
        add(x.notes);
        return { title, when: formatWhen(startMs), bits };
    }

    function runMatchesFilter(run, query) {
        const q = String(query || '')
            .trim()
            .toLowerCase();
        if (!q) return true;
        const d = describeRun(run);
        const hay = [d.title, d.when, run.run_id, run.file, run.folder]
            .concat(d.bits)
            .join(' ')
            .toLowerCase();
        return q.split(/\s+/).every((tok) => hay.includes(tok));
    }

    function conditionOf(status) {
        if (!status) return null;
        return (
            (status.step && status.step.conditionName) ||
            status.condition ||
            status.conditionName ||
            null
        );
    }

    function isLedOnMv(mv, offMv) {
        const v = Number(mv);
        return Number.isFinite(v) && v > 0 && v < (offMv || LED_OFF_MV_DEFAULT);
    }

    function findTrialParams(condition) {
        return (
            (condition &&
                (condition.commands || []).find(
                    (c) => c && c.type === 'controller' && c.command_name === 'trialParams'
                )) ||
            null
        );
    }

    /** The nominal trial a protocol condition declares (the log's params override it). */
    function trialFromProtocol(experiment, name) {
        const cond = experiment && (experiment.conditions || []).find((c) => c && c.name === name);
        const tp = findTrialParams(cond);
        const pid = tp ? Number(tp.pattern_ID) : NaN;
        return {
            condition: name,
            patternName: tp && tp.pattern ? String(tp.pattern) : null,
            patternId: Number.isInteger(pid) && pid > 0 ? pid : null,
            mode: tp ? Number(tp.mode) || 2 : 0,
            frameRate: tp ? Number(tp.frame_rate) || 0 : 0,
            frameIndex: tp ? Number(tp.frame_index) || 0 : 0,
            startMs: 0
        };
    }

    // ── Ball rotation from FicTrac (the 3D window's ball turns with the data) ──────
    // FicTrac logs the integrated lab-frame path (x, y — radians of ball arc) and heading
    // (hd, rad). Conventions are js/kinematics.js's: forward = dx·cos h + dy·sin h, side
    // (right) = −dx·sin h + dy·cos h, turning + = increasing heading = clockwise seen from
    // above (a right turn). Scene frame of the replay viewer: +Y up, the tethered fly faces
    // −X (front, column 3), so its right is −Z. The ball moves OPPOSITE the fly's
    // intended motion:
    //   right turn   → ball yaws counter-clockwise from above → +Δh   about +Y
    //   walk forward → the top surface slides back (+X)       → −fwd  about +Z
    //   step right   → the top surface slides left (+Z)       → +side about +X
    // One sign knob per axis in case a rig's FicTrac config is mirrored.
    const BALL_SIGNS = { yaw: 1, pitch: 1, roll: 1 };
    const BALL_MAX_STEP_RAD = 0.35; // per sample; larger = a FicTrac reset/jump, not motion
    const BALL_MAX_GAP_MS = 250; // don't integrate across dropped stretches

    function quatMul(a, b) {
        return [
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
        ];
    }

    function quatAxisAngle(ax, ay, az, angle) {
        const s = Math.sin(angle / 2);
        return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
    }

    function quatNormalize(q) {
        const n = Math.hypot(q[0], q[1], q[2], q[3]);
        return n > 1e-12 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [0, 0, 0, 1];
    }

    function wrapPi(r) {
        let x = r % (2 * Math.PI);
        if (x <= -Math.PI) x += 2 * Math.PI;
        else if (x > Math.PI) x -= 2 * Math.PI;
        return x;
    }

    /** A FicTrac sample's time (ms): FicTrac's own timestamp when logged, else the bridge's. */
    function sampleTimeMs(s) {
        if (!s) return NaN;
        return Number.isFinite(Number(s.ft)) ? Number(s.ft) : Number(s.ms);
    }

    /**
     * The ball rotation (yaw/pitch/roll, radians) between two consecutive FicTrac samples,
     * or null when the step must not be integrated (gap, non-monotone time, reset jump).
     */
    function ballDelta(prev, cur) {
        if (!prev || !cur) return null;
        const vals = [prev.x, prev.y, prev.hd, cur.x, cur.y, cur.hd].map(Number);
        if (vals.some((v) => !Number.isFinite(v))) return null;
        const t0 = sampleTimeMs(prev);
        const t1 = sampleTimeMs(cur);
        if (Number.isFinite(t0) && Number.isFinite(t1)) {
            if (!(t1 > t0) || t1 - t0 > BALL_MAX_GAP_MS) return null;
        }
        const dx = vals[3] - vals[0];
        const dy = vals[4] - vals[1];
        const dh = wrapPi(vals[5] - vals[2]);
        if (Math.abs(dx) > BALL_MAX_STEP_RAD || Math.abs(dy) > BALL_MAX_STEP_RAD) return null;
        if (Math.abs(dh) > BALL_MAX_STEP_RAD * 3) return null;
        const h = vals[5];
        const fwd = dx * Math.cos(h) + dy * Math.sin(h);
        const side = -dx * Math.sin(h) + dy * Math.cos(h);
        return {
            yaw: BALL_SIGNS.yaw * dh,
            pitch: -BALL_SIGNS.pitch * fwd,
            roll: BALL_SIGNS.roll * side
        };
    }

    /** Apply one step to the orientation quaternion [x,y,z,w] (world-frame increment). */
    function ballStep(q, d) {
        if (!d) return q;
        let dq = quatAxisAngle(0, 1, 0, d.yaw);
        dq = quatMul(quatAxisAngle(0, 0, 1, d.pitch), dq);
        dq = quatMul(quatAxisAngle(1, 0, 0, d.roll), dq);
        return quatMul(dq, q);
    }

    function createProjection() {
        const Gait = flyGait();
        return {
            ball: [0, 0, 0, 1], // the 3D window's ball orientation (quaternion x,y,z,w)
            ballPrev: null,
            ballSteps: 0,
            gait: Gait ? Gait.createGait() : null, // the 3D fly's walking state (fly-gait.js)
            condition: '—',
            step: null,
            stepIndex: null,
            stepTotal: null,
            trial: null, // what the ARENA is showing (changes only on trialParams)
            pending: null, // the current step's declared trial, until its trialParams
            ledOn: false,
            ledPercent: null,
            displayMode: 'off',
            frame: 0
        };
    }

    /**
     * Fold ONE run-status (runlog-replay's live shape) into the projection. Used for
     * both playback and seek-priming — the single source of replay semantics.
     * ctx: {experiment, sequenceSteps, ledOffMv, patternFrames}
     * Returns {stepStarted, trialChanged} so the UI knows what to refresh.
     *
     * The DISPLAY changes only on a display command (trialParams / allOn / allOff /
     * stopDisplay). A step-start alone (e.g. an ITI that only waits) leaves the
     * previous pattern up, exactly as the controller does — the runner pins the wire
     * duration to 0, so a pattern keeps playing until the next display command.
     */
    function applyStatus(proj, status, ms, ctx) {
        const out = { stepStarted: false, trialChanged: false };
        if (!proj || !status || !status.phase) return out;
        const c = ctx || {};
        const name = conditionOf(status);
        const idx = Number(status.index);
        if (status.phase === 'step-start' && name) {
            proj.condition = name;
            if (Number.isInteger(idx) && idx >= 0) proj.stepIndex = idx;
            if (Number.isFinite(Number(status.total)) && status.total != null)
                proj.stepTotal = Number(status.total);
            const nominal =
                Number.isInteger(idx) && idx >= 0 && c.sequenceSteps ? c.sequenceSteps[idx] : null;
            proj.step = Object.assign({}, nominal || {}, status.step || {}, {
                conditionName: name
            });
            proj.pending = trialFromProtocol(c.experiment, name);
            out.stepStarted = true;
        } else if (status.phase === 'command') {
            const op = status.op;
            if (op === 'trialParams') {
                const cond = name || proj.condition;
                const base =
                    proj.pending && proj.pending.condition === cond
                        ? proj.pending
                        : trialFromProtocol(c.experiment, cond);
                proj.trial = Object.assign({}, base);
                proj.pending = null;
                const p = status.params || {};
                if (Number.isFinite(Number(p.mode)) && p.mode != null)
                    proj.trial.mode = Number(p.mode);
                if (Number.isFinite(Number(p.frameRate)) && p.frameRate != null)
                    proj.trial.frameRate = Number(p.frameRate);
                if (Number.isFinite(Number(p.initPos)) && p.initPos != null)
                    proj.trial.frameIndex = Number(p.initPos);
                const pid = Number(p.patternId);
                if (Number.isInteger(pid) && pid > 0) proj.trial.patternId = pid;
                proj.trial.startMs = ms;
                proj.frame = positiveModulo(proj.trial.frameIndex, c.patternFrames);
                proj.displayMode = 'pattern';
                out.trialChanged = true;
            } else if (op === 'setAnalogOut') {
                proj.ledOn = isLedOnMv(status.value, c.ledOffMv);
                proj.ledPercent = typeof status.ledPercent === 'number' ? status.ledPercent : null;
            } else if (op === 'setFramePosition') {
                proj.frame = positiveModulo(status.value, c.patternFrames);
            } else if (op === 'allOn') {
                proj.displayMode = 'all-on';
            } else if (op === 'allOff' || op === 'stopDisplay') {
                proj.displayMode = 'off';
            }
        } else if (status.phase === 'led-activation') {
            proj.ledOn = !!status.on;
            if (typeof status.ledPercent === 'number') proj.ledPercent = status.ledPercent;
        } else if (status.phase === 'sequence-complete' || status.phase === 'aborted') {
            proj.displayMode = 'off';
            proj.ledOn = false;
        }
        return out;
    }

    /**
     * Fold one timeline item. Frame positions come from the decoded 0x70 commands
     * ('frame' items). Only a log with NO such records (pre-arena_command logging)
     * falls back to the bridge's per-sample `idx` in closed-loop trials.
     */
    function applyItem(proj, item, ctx) {
        if (!item) return { stepStarted: false, trialChanged: false };
        const c = ctx || {};
        if (item.kind === 'status') return applyStatus(proj, item.status, item.ms, c);
        if (item.kind === 'sample' && item.sample) {
            // Every FicTrac sample turns the ball and steps the fly's gait (its 100 ms
            // speed/turn average + tripod phase); seek-priming integrates the same path.
            const delta = ballDelta(proj.ballPrev, item.sample);
            if (proj.ball) {
                proj.ball = ballStep(proj.ball, delta);
                if (++proj.ballSteps % 256 === 0) proj.ball = quatNormalize(proj.ball);
            }
            const Gait = proj.gait ? flyGait() : null;
            if (Gait) Gait.stepGait(proj.gait, sampleTimeMs(item.sample), delta);
            proj.ballPrev = item.sample;
        }
        if (item.kind === 'frame') {
            proj.frame = positiveModulo(item.index, c.patternFrames);
        } else if (
            item.kind === 'sample' &&
            !c.hasFrameItems &&
            proj.trial &&
            (proj.trial.mode === 3 || proj.trial.mode === 4) &&
            Number.isFinite(Number(item.sample && item.sample.idx))
        ) {
            proj.frame = positiveModulo(item.sample.idx, c.patternFrames);
        }
        return { stepStarted: false, trialChanged: false };
    }

    /** Mode 2 (open loop) — the controller advances frames on its own clock. */
    function openLoopFrame(proj, ms, patternFrames) {
        const t = proj && proj.trial;
        if (!t || t.mode !== 2 || !t.frameRate || !(patternFrames > 0))
            return proj ? proj.frame : 0;
        const n = Math.floor(((ms - t.startMs) / 1000) * t.frameRate);
        return positiveModulo(t.frameIndex + n, patternFrames);
    }

    /**
     * Log-only step list (no protocol): one entry per logged step, in run order,
     * with the mode/pattern id the trialParams that followed it reported.
     */
    function logOnlySteps(parsed) {
        const steps = [];
        let current = null;
        ((parsed && parsed.events) || []).forEach((e) => {
            const s = e.status || {};
            if (s.phase === 'step-start') {
                current = {
                    index: Number.isInteger(Number(s.index)) ? Number(s.index) : steps.length,
                    conditionName: conditionOf(s) || 'step ' + (steps.length + 1),
                    mode: null,
                    patternId: null,
                    durationSec: null
                };
                steps.push(current);
            } else if (current && s.phase === 'command' && s.op === 'trialParams') {
                const p = s.params || {};
                if (p.mode != null) current.mode = Number(p.mode);
                if (p.patternId != null) current.patternId = Number(p.patternId);
                if (typeof s.value === 'number') current.durationSec = s.value;
            }
        });
        return steps;
    }

    /**
     * Where to open the 3D window so it does not cover the replay controls. Screen
     * coordinates; `width`/`height` are the window's CONTENT size (window.open).
     * env: {screen:{availLeft,availTop,availWidth,availHeight},
     *       win:{screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight},
     *       panel:{left,top,width,height}|null}  — panel = the Run-details column's
     *       viewport rect (greyed out and unused during a replay).
     * Order: beside the Studio window if the screen has room → over the Run-details
     * column → bottom-right corner of the screen. Always clamped on-screen.
     */
    function viewerPlacement(env) {
        const e = env || {};
        const sc = e.screen || {};
        const w = e.win || {};
        const sx0 = Number(sc.availLeft) || 0;
        const sy0 = Number(sc.availTop) || 0;
        const sw = Number(sc.availWidth) || 1280;
        const sh = Number(sc.availHeight) || 800;
        const MIN_W = 420;
        const MAX_W = 720;
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const fit = (p) => {
            const width = Math.round(clamp(p.width, 320, sw));
            const height = Math.round(clamp(p.height, 240, sh));
            return {
                width,
                height,
                left: Math.round(clamp(p.left, sx0, sx0 + sw - width)),
                top: Math.round(clamp(p.top, sy0, sy0 + sh - height))
            };
        };
        const iw0 = Number(w.innerWidth) || 0;
        const ih0 = Number(w.innerHeight) || 0;
        // Some windows report nonsense outer metrics (outer < inner, or off-screen) —
        // never trust a window smaller than its own viewport, and keep it on-screen.
        const ow = Math.max(Number(w.outerWidth) || sw, iw0);
        const oh = Math.max(Number(w.outerHeight) || sh, ih0);
        const wx = clamp(Number(w.screenX) || 0, sx0, Math.max(sx0, sx0 + sw - ow));
        const wy = clamp(Number(w.screenY) || 0, sy0, Math.max(sy0, sy0 + sh - oh));
        const spaceRight = sx0 + sw - (wx + ow);
        const spaceLeft = wx - sx0;
        if (spaceRight >= MIN_W || spaceLeft >= MIN_W) {
            const right = spaceRight >= spaceLeft;
            const width = Math.min(MAX_W, (right ? spaceRight : spaceLeft) - 8);
            return fit({
                width,
                height: width * 0.75,
                left: right ? wx + ow + 4 : sx0 + 4,
                top: wy
            });
        }
        const p = e.panel;
        const iw = Number(w.innerWidth) || ow;
        const ih = Number(w.innerHeight) || oh;
        if (p && p.width >= 200 && p.height >= 160) {
            // Viewport origin on screen (browser chrome sits above the page).
            const vx = wx + Math.max(0, (ow - iw) / 2);
            const vy = wy + Math.max(0, oh - ih);
            const width = clamp(iw - p.left - 8, MIN_W, 640);
            const height = Math.min(width * 0.75, Math.max(240, p.height - 30));
            return fit({
                width,
                height,
                left: Math.min(vx + p.left, vx + iw - width - 4),
                top: vy + p.top
            });
        }
        return fit({ width: 520, height: 390, left: sx0 + sw - 524, top: sy0 + sh - 420 });
    }

    /** Binary search: first timeline index whose ms >= target. */
    function seekIndex(timeline, targetMs) {
        let lo = 0;
        let hi = timeline ? timeline.length : 0;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (timeline[mid].ms < targetMs) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /** Replay the timeline's state up to (not including) index `end`. */
    function primeProjection(timeline, end, ctx) {
        const proj = createProjection();
        const stop = Math.min(end, timeline ? timeline.length : 0);
        for (let i = 0; i < stop; i++) applyItem(proj, timeline[i], ctx);
        return proj;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Browser controller
    // ═════════════════════════════════════════════════════════════════════

    function install(opts) {
        const o = opts || {};
        const Studio = o.Studio || global.Studio;
        const Scope = o.Scope || global.Scope;
        if (typeof document === 'undefined' || !Studio || !Scope) return null;
        const $ = (id) => document.getElementById(id);
        if (!$('replayCard') || !$('replayOverlay')) return null;
        // Arena Studio Alt ships its own (reference) replay on the same page.
        if (document.documentElement.classList.contains('arena-alt')) return null;

        const ReplayLib = global.RunlogReplay;
        const Fmt = global.RunlogFormat;
        const GH = global.StudioGitHub;
        const ViewerProtocol = global.ArenaReplayViewerProtocol;
        const UrlState = global.StudioUrlState;
        const Runner = global.ArenaRunnerG6;
        const LED_OFF_MV = (Runner && Runner.LED_OFF_MV) || LED_OFF_MV_DEFAULT;
        const VIEWER_PREF = 'studio_replay_viewer';
        const SPEED_PREF = 'studio_replay_speed';

        const R = {
            active: false,
            loading: false,
            playing: false,
            paused: false,
            parsed: null,
            timeline: [],
            index: 0,
            startMs: 0,
            endMs: 0,
            currentMs: 0,
            speed: 1,
            raf: null,
            timer: null,
            seekRaf: null,
            lastWall: 0,
            loadToken: 0,
            proj: createProjection(),
            ctx: { experiment: null, sequenceSteps: [], ledOffMv: LED_OFF_MV, patternFrames: 0 },
            source: null, // {kind:'repo'|'local', repo?, path?, name}
            resolution: null,
            logOnly: false,
            logSteps: [],
            patternCache: new Map(),
            patternToken: 0,
            patternKey: null,
            overrideYaml: null,
            overridePats: new Map(),
            viewer: null,
            viewerReady: false,
            viewerSession: null,
            viewerOrigin: null,
            viewerBound: false,
            viewerPending: false,
            frozen: new Map(),
            pendingUrl: null,
            runs: null,
            runsRepo: null,
            runsRepoObj: null,
            runsLoading: null,
            textCache: new Map(),
            commitCache: new Map()
        };

        const ui = {
            overlay: $('replayOverlay'),
            repoLbl: $('rpdRepo'),
            folder: $('rpdFolder'),
            filter: $('rpdFilter'),
            refresh: $('rpdRefresh'),
            list: $('rpdList'),
            localBtn: $('rpdLocalBtn'),
            localInput: $('rpdLocalInput'),
            viewerChk: $('rpdViewer'),
            speedSel: $('rpdSpeed'),
            yamlBtn: $('rpdYamlBtn'),
            yamlInput: $('rpdYamlInput'),
            yamlName: $('rpdYamlName'),
            patBtn: $('rpdPatBtn'),
            patInput: $('rpdPatInput'),
            patName: $('rpdPatName'),
            dlgStatus: $('rpdStatus'),
            close: $('rpdClose'),
            card: $('replayCard'),
            title: $('rplTitle'),
            meta: $('rplMeta'),
            step: $('rplStep'),
            proto: $('rplProto'),
            play: $('rplPlay'),
            slider: $('rplSlider'),
            clock: $('rplClock'),
            speed: $('rplSpeed'),
            sound: $('rplSound'),
            soundCfg: $('rplSoundCfg'),
            viewerBtn: $('rplViewer'),
            link: $('rplLink'),
            another: $('rplAnother'),
            stop: $('rplStop')
        };

        // ---- small utilities --------------------------------------------------
        function errText(e) {
            return e && e.message ? e.message : String(e);
        }
        function ghToken() {
            return Studio.ghToken ? Studio.ghToken() : null;
        }
        function repoFromFull(full) {
            const m = /^([^/]+)\/(.+)$/.exec(String(full || ''));
            if (!m || !UrlState || !UrlState.isSafeRepo(full)) return null;
            return { owner: m[1], name: m[2], full: full };
        }
        function courseRepo() {
            const cs = Studio.courseSettings && Studio.courseSettings();
            return (cs && cs.repo) || repoFromFull(Studio.DEFAULT_COURSE_REPO);
        }
        function benchId() {
            const cs = Studio.courseSettings && Studio.courseSettings();
            return (cs && cs.benchId) || null;
        }
        async function sha256Hex(text) {
            if (!global.crypto || !crypto.subtle) return null;
            const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
            return Array.from(new Uint8Array(d), (n) => n.toString(16).padStart(2, '0')).join('');
        }
        async function shaMatch(text, want) {
            if (!want) return 'unverified';
            if ((await sha256Hex(text)) === want) return 'exact';
            if (typeof Studio.protocolDocSha === 'function') {
                try {
                    if (normalizeSha(await Studio.protocolDocSha(text)) === want) return 'exact';
                } catch (_) {
                    /* unparseable candidate — not a match */
                }
            }
            return 'mismatch';
        }
        function readMessage(path, status, token) {
            if ((status === 401 || status === 403 || status === 404) && !token) {
                return (
                    path + ' is unavailable (HTTP ' + status + '). Sign in if the repo is private.'
                );
            }
            if (status === 403 || status === 429) {
                return (
                    path +
                    ': GitHub rate limit reached (HTTP ' +
                    status +
                    ') — sign in, or retry later.'
                );
            }
            return path + ' returned HTTP ' + status + '.';
        }

        // Public repos read anonymously through raw.githubusercontent.com (CORS *,
        // no API quota — the anonymous API allows only 60 requests/hour). With a
        // token, the Contents API (raw media type) serves private repos too.
        // Returns Uint8Array, or null for "no such file".
        async function readRepoBytes(repo, path, ref) {
            if (!GH || !GH.isAllowedReadPath(path)) throw new Error('Refusing to read ' + path);
            const token = ghToken();
            if (!token && typeof GH.rawUrl === 'function') {
                try {
                    const res = await fetch(GH.rawUrl(repo.owner, repo.name, ref || 'HEAD', path));
                    if (res.ok) return new Uint8Array(await res.arrayBuffer());
                    if (res.status === 404) return null;
                } catch (_) {
                    /* network/CORS — fall through to the API */
                }
            }
            const r = await GH.runBytes(
                fetch,
                GH.reqGetContentsRaw(repo.owner, repo.name, path, ref || null, token)
            );
            if (r.ok) return r.bytes;
            if (r.status === 404) return null;
            throw new Error(readMessage(path, r.status, token));
        }
        async function readRepoText(repo, path, ref) {
            const key = repo.full + '|' + path + '|' + (ref || '');
            if (R.textCache.has(key)) return R.textCache.get(key);
            const bytes = await readRepoBytes(repo, path, ref);
            const text = bytes ? new TextDecoder().decode(bytes) : null;
            R.textCache.set(key, text);
            return text;
        }
        async function listRepoDir(repo, path) {
            const token = ghToken();
            const r = await GH.run(
                fetch,
                GH.reqGetContents(repo.owner, repo.name, path, null, token)
            );
            if (r.status === 404) return [];
            if (!r.ok || !Array.isArray(r.data))
                throw new Error(readMessage(path, r.status, token));
            return r.data;
        }
        async function listCommits(repo, path) {
            const key = repo.full + '|' + path;
            if (R.commitCache.has(key)) return R.commitCache.get(key);
            if (typeof GH.reqListCommits !== 'function') return [];
            const token = ghToken();
            const r = await GH.run(
                fetch,
                GH.reqListCommits(repo.owner, repo.name, path, token, 60)
            );
            const list = r.ok && Array.isArray(r.data) ? r.data : [];
            R.commitCache.set(key, list);
            return list;
        }

        // ---- protocol resolution ---------------------------------------------
        function setDlgStatus(msg, isErr) {
            if (!ui.dlgStatus) return;
            ui.dlgStatus.textContent = msg || '';
            ui.dlgStatus.classList.toggle('err', !!isErr);
        }
        function setProtoLine(msg, tone) {
            if (!ui.proto) return;
            ui.proto.textContent = msg || '';
            ui.proto.className = 'rpl-proto' + (tone ? ' ' + tone : '');
        }

        /**
         * → {text, name, via, match, repo?, path?, ref?, date?, key?, reuse?} or null.
         * `via` ∈ override | open | repo | site | history; `match` ∈ exact | unverified
         * | mismatch. Stops at the first exact (or, without a logged sha, first found).
         */
        async function resolveProtocol(parsed, source, onStep) {
            const meta = (parsed && parsed.metadata) || {};
            const want = normalizeSha(parsed && parsed.protocolSha256);
            const step = typeof onStep === 'function' ? onStep : () => {};
            if (R.overrideYaml) {
                const text = await R.overrideYaml.text();
                return {
                    text,
                    name: R.overrideYaml.name,
                    via: 'override',
                    match: await shaMatch(text, want)
                };
            }
            const cur = Studio.currentDoc;
            if (want && cur && cur.experiment && normalizeSha(cur.sha256) === want) {
                return { reuse: true, name: cur.filename, via: 'open', match: 'exact' };
            }
            const names = protocolFilenames(meta, source && source.name);
            if (!names.length) return null;
            const found = [];
            const repo = (source && source.repo) || courseRepo();
            const tried = new Set();
            async function tryRepoPath(path) {
                if (tried.has(path)) return null;
                tried.add(path);
                let text = null;
                try {
                    text = await readRepoText(repo, path);
                } catch (_) {
                    return null;
                }
                if (text == null) return null;
                const m = await shaMatch(text, want);
                const hit = { text, name: baseName(path), via: 'repo', match: m, repo, path };
                if (m !== 'mismatch') return hit;
                found.push(hit);
                return null;
            }
            if (repo && GH) {
                step('Looking for ' + names[0] + ' in ' + repo.full + '…');
                const paths = protocolSearchPaths(meta, {
                    logName: source && source.name,
                    logPath: source && source.path,
                    benchId: benchId(),
                    hintPath: source && source.hintPath
                });
                for (const p of paths) {
                    const hit = await tryRepoPath(p);
                    if (hit) return hit;
                }
                if (!found.length) {
                    // Not where Studio saves it — scan every other bench folder.
                    let dirs = [];
                    try {
                        dirs = (await listRepoDir(repo, 'protocols'))
                            .filter((e) => e && e.type === 'dir' && isSafeSegment(e.name))
                            .map((e) => e.name);
                    } catch (_) {
                        dirs = [];
                    }
                    const more = protocolSearchPaths(meta, {
                        logName: source && source.name,
                        extraDirs: dirs
                    });
                    for (const p of more) {
                        const hit = await tryRepoPath(p);
                        if (hit) return hit;
                    }
                }
            }
            // This site's own protocol library (the FicTrac bench tests live here).
            try {
                const res = await fetch('./protocols/index.json', { cache: 'no-store' });
                if (res.ok) {
                    const idx = (await res.json()).protocols || [];
                    for (const entry of idx) {
                        if (!entry || !names.includes(baseName(entry.path))) continue;
                        if (UrlState && !UrlState.isSafePath(entry.path)) continue;
                        const r = await fetch(entry.path, { cache: 'no-store' });
                        if (!r.ok) continue;
                        const text = await r.text();
                        const m = await shaMatch(text, want);
                        const hit = {
                            text,
                            name: baseName(entry.path),
                            via: 'site',
                            match: m,
                            key: entry.key
                        };
                        if (m !== 'mismatch') return hit;
                        found.push(hit);
                    }
                }
            } catch (_) {
                /* offline / no registry */
            }
            // Edited since the run → walk the file's history for the exact version.
            if (want) {
                for (const f of found.filter((x) => x.via === 'repo').slice(0, 2)) {
                    step(
                        'Protocol changed since this run — searching the history of ' + f.path + '…'
                    );
                    let commits = [];
                    try {
                        commits = await listCommits(f.repo, f.path);
                    } catch (_) {
                        commits = [];
                    }
                    for (const c of commits.slice(0, 40)) {
                        const sha = c && c.sha;
                        if (!sha) continue;
                        let text = null;
                        try {
                            text = await readRepoText(f.repo, f.path, sha);
                        } catch (_) {
                            text = null;
                        }
                        if (text == null) continue;
                        if ((await shaMatch(text, want)) === 'exact') {
                            return {
                                text,
                                name: f.name,
                                via: 'history',
                                match: 'exact',
                                repo: f.repo,
                                path: f.path,
                                ref: sha,
                                date: c.commit && c.commit.author && c.commit.author.date
                            };
                        }
                    }
                }
            }
            return found.length ? found[0] : null;
        }

        function describeResolution(res) {
            if (!res) {
                return {
                    text:
                        'Protocol not found — replaying from the log alone (steps from the log; ' +
                        'patterns matched by SD id). Advanced ▸ protocol override picks the YAML.',
                    tone: 'warn'
                };
            }
            const where =
                res.via === 'override'
                    ? 'your file ' + res.name
                    : res.via === 'open'
                      ? 'the open protocol ' + res.name
                      : res.via === 'site'
                        ? 'this site’s library · ' + res.name
                        : res.via === 'history'
                          ? res.repo.full +
                            ' · ' +
                            res.path +
                            ' @ ' +
                            String(res.ref).slice(0, 7) +
                            (res.date ? ' (' + String(res.date).slice(0, 10) + ')' : '')
                          : res.repo.full + ' · ' + res.path;
            if (res.match === 'exact')
                return { text: 'Protocol ✓ exact version · ' + where, tone: 'ok' };
            if (res.match === 'unverified')
                return {
                    text: 'Protocol · ' + where + ' (the log records no sha to check)',
                    tone: ''
                };
            return {
                text:
                    'Protocol ≠ logged version (sha differs) · ' +
                    where +
                    ' — the sequence may not match what ran',
                tone: 'warn'
            };
        }

        // ---- UI freeze + interlock -------------------------------------------
        const FREEZE_SELECTORS = [
            '.launch-card',
            '#runVarsCard',
            '#metaPanel',
            '#editView',
            '#consoleView',
            '#modeSeg',
            '#connectBtn',
            '#openProtoBtn',
            '#fileMenu',
            '#sessionRigLock',
            '.run-log-strip .acts'
        ];
        function setFrozen(on) {
            if (on) {
                FREEZE_SELECTORS.forEach((sel) => {
                    document.querySelectorAll(sel).forEach((node) => {
                        if (R.frozen.has(node)) return;
                        R.frozen.set(node, node.hasAttribute('inert'));
                        node.setAttribute('inert', '');
                    });
                });
            } else {
                for (const [node, wasInert] of R.frozen)
                    if (!wasInert) node.removeAttribute('inert');
                R.frozen.clear();
            }
        }

        let seqHeadingText = null;
        let seqHeadingLive = null;
        function setSeqHeading(replaying) {
            if (!seqHeadingText) {
                const h = document.querySelector('.seqlist h3');
                seqHeadingText = h && Array.from(h.childNodes).find((n) => n.nodeType === 3);
                seqHeadingLive = seqHeadingText ? seqHeadingText.nodeValue : null;
            }
            if (seqHeadingText) {
                seqHeadingText.nodeValue = replaying
                    ? 'Sequence · replay position '
                    : seqHeadingLive;
            }
        }

        /** Why replay cannot start right now, or null. */
        function refusal() {
            const s = Studio.session;
            if (s && s.running) return 'Stop the live experiment before replaying a run.';
            const b = s && s.bridge;
            if (b && b.apply)
                return 'Turn off FicTrac closed loop (Console → FicTrac) before replaying.';
            if (s && typeof s.setOutputInhibited !== 'function')
                return 'Replay safety interlock unavailable — hard-refresh this page (stale cache).';
            if (Studio.importMode) return 'Finish or cancel the condition import first.';
            return null;
        }

        function enterShell(label) {
            R.active = true;
            R.loading = true;
            Studio.replayActive = true;
            if (Studio.session && Studio.session.setOutputInhibited) {
                Studio.session.setOutputInhibited('Arena Studio replay');
            }
            if (Scope.closeSoundSettings) Scope.closeSoundSettings();
            if (Scope.setSoundEnabled) Scope.setSoundEnabled(false);
            if (Scope.setSoundSuspended) Scope.setSoundSuspended(false);
            setFrozen(true);
            document.body.classList.add('replay-active');
            ui.card.hidden = false;
            setSeqHeading(true);
            ui.title.textContent = label || 'Loading replay…';
            ui.meta.textContent = '';
            ui.step.textContent = '';
            setProtoLine('Reading the run log…');
            ui.slider.disabled = true;
            ui.slider.min = '0';
            ui.slider.max = '0';
            ui.slider.value = '0';
            ui.clock.textContent = formatClock(0) + ' / ' + formatClock(0);
            syncPlayUi();
            syncLinkUi();
            if (Studio.setMode && Studio.mode !== 'run') Studio.setMode('run', { push: false });
        }

        function stop(opts) {
            const keepUrl = opts && opts.keepUrl;
            R.loadToken++;
            R.playing = false;
            R.paused = false;
            R.loading = false;
            cancelLoop();
            if (R.seekRaf) cancelAnimationFrame(R.seekRaf);
            R.seekRaf = null;
            R.proj.displayMode = 'off';
            R.proj.ledOn = false;
            sendViewerState();
            closeViewer();
            const wasActive = R.active;
            R.active = false;
            Studio.replayActive = false;
            R.pendingUrl = null;
            document.body.classList.remove('replay-active');
            setFrozen(false);
            ui.card.hidden = true;
            setSeqHeading(false);
            if (Scope.closeSoundSettings) Scope.closeSoundSettings();
            if (Scope.setSoundEnabled) Scope.setSoundEnabled(false);
            if (Scope.setSoundSuspended) Scope.setSoundSuspended(false);
            if (Scope.setReplayMode) Scope.setReplayMode(false);
            if (Studio.clearSeqHighlight) Studio.clearSeqHighlight();
            if (R.logOnly && Studio.rerenderSequence) Studio.rerenderSequence();
            R.logOnly = false;
            R.logSteps = [];
            if (Studio.session && Studio.session.setOutputInhibited) {
                try {
                    Studio.session.setOutputInhibited(null);
                } catch (_) {
                    /* best-effort release */
                }
            }
            if (wasActive && !keepUrl && Studio.updateUrl) Studio.updateUrl({ push: false });
        }

        function fail(e) {
            const msg = errText(e);
            stop();
            if (Studio.showBanner) Studio.showBanner('Replay: ' + msg);
            setDlgStatus(msg, true);
        }

        // ---- entry points ----------------------------------------------------
        function viewerWanted() {
            return localStorage.getItem(VIEWER_PREF) !== '0';
        }

        /**
         * Replay a run log from a repo. opts: {gesture, autoplay, hintPath, entry}
         * `gesture` = called inside a click (the 3D popup may open synchronously).
         */
        async function startFromRepo(repo, path, opts) {
            const op = opts || {};
            if (!repo || !isSafeRunlogPath(path)) {
                fail(new Error('Not a run-log path: ' + path));
                return false;
            }
            const why = refusal();
            if (why) {
                fail(new Error(why));
                return false;
            }
            if (R.active) stop({ keepUrl: true });
            const token = ++R.loadToken;
            const name = baseName(path);
            if (op.gesture && viewerWanted()) openViewer(true);
            try {
                enterShell('Loading ' + name + '…');
            } catch (e) {
                fail(e);
                return false;
            }
            R.source = { kind: 'repo', repo, path, name, hintPath: op.hintPath || null };
            R.pendingUrl = { repo: repo.full, path };
            if (Studio.updateUrl) Studio.updateUrl({ push: false });
            try {
                setProtoLine('Downloading ' + name + ' from ' + repo.full + '…');
                const bytes = await readRepoBytes(repo, path);
                if (token !== R.loadToken) return false;
                if (!bytes) throw new Error(path + ' was not found in ' + repo.full + '.');
                const text = Fmt
                    ? await Fmt.readRunlogText(bytes)
                    : new TextDecoder().decode(bytes);
                if (token !== R.loadToken) return false;
                return await begin(text, token, op);
            } catch (e) {
                if (token === R.loadToken) fail(e);
                return false;
            }
        }

        async function startFromFile(file, opts) {
            const op = opts || {};
            if (!file) return false;
            const why = refusal();
            if (why) {
                fail(new Error(why));
                return false;
            }
            if (R.active) stop({ keepUrl: true });
            const token = ++R.loadToken;
            if (op.gesture && viewerWanted()) openViewer(true);
            try {
                enterShell('Loading ' + file.name + '…');
            } catch (e) {
                fail(e);
                return false;
            }
            R.source = { kind: 'local', name: file.name };
            R.pendingUrl = null;
            try {
                const text = Fmt ? await Fmt.readRunlogText(file) : await file.text();
                if (token !== R.loadToken) return false;
                return await begin(text, token, op);
            } catch (e) {
                if (token === R.loadToken) fail(e);
                return false;
            }
        }

        async function begin(text, token, op) {
            if (!ReplayLib)
                throw new Error('runlog-replay.js did not load — hard-refresh the page.');
            const parsed = ReplayLib.parseRunLog(text);
            const timeline = ReplayLib.buildTimeline(parsed);
            if (!timeline.length)
                throw new Error('The run log contains no replayable events or samples.');
            R.parsed = parsed;
            const meta = parsed.metadata || {};
            const d = describeRun(meta, R.source.name);
            ui.title.textContent = d.title;
            ui.title.title =
                R.source.kind === 'repo'
                    ? R.source.repo.full + ' · ' + R.source.path
                    : R.source.name;
            ui.meta.textContent = [d.when].concat(d.bits).filter(Boolean).join(' · ');

            // Protocol: found, not picked.
            setProtoLine('Finding the protocol…');
            const res = await resolveProtocol(parsed, R.source, setProtoLine);
            if (token !== R.loadToken) return false;
            let experiment = null;
            if (res && res.reuse) {
                experiment = Studio.currentDoc && Studio.currentDoc.experiment;
            } else if (res && Studio.loadProtocol) {
                const loadOpts = { landIn: 'run' };
                if (res.via === 'repo' && res.repo && res.path) {
                    loadOpts.repoRef = { repo: res.repo.full, path: res.path };
                } else if (res.via === 'site' && res.key) {
                    loadOpts.key = res.key;
                }
                const ok = await Studio.loadProtocol(
                    res.text,
                    res.name,
                    res.via === 'override' ? 'local' : 'committed',
                    loadOpts
                );
                if (token !== R.loadToken) return false;
                experiment = ok && Studio.currentDoc ? Studio.currentDoc.experiment : null;
            }
            R.resolution = experiment ? res : null;
            const line = describeResolution(R.resolution);
            if (res && !experiment) {
                line.text = 'Protocol could not be opened — replaying from the log alone.';
                line.tone = 'warn';
            }
            setProtoLine(line.text, line.tone);

            R.ctx = {
                experiment,
                sequenceSteps:
                    experiment && Runner && Runner.flattenStructure
                        ? Runner.flattenStructure(experiment).steps
                        : [],
                ledOffMv: LED_OFF_MV,
                patternFrames: 0,
                hasFrameItems: (parsed.arenaFrames || []).length > 0
            };
            R.logOnly = !experiment;
            R.logSteps = R.logOnly ? logOnlySteps(parsed) : [];
            if (R.logOnly) renderLogOnlySequence();

            await wirePatternSources(experiment ? R.resolution : null);
            if (token !== R.loadToken) return false;

            R.timeline = timeline;
            R.startMs = timeline.startMs;
            R.endMs = timeline.endMs;
            R.currentMs = R.startMs;
            R.patternCache.clear();
            R.patternKey = null;
            ui.slider.min = '0';
            ui.slider.max = String(Math.max(0, timeline.durationMs));
            ui.slider.value = '0';
            ui.slider.disabled = false;
            R.loading = false;
            if (Studio.setMode && Studio.mode !== 'run') Studio.setMode('run', { push: false });
            if (Studio.setDockView) Studio.setDockView('scope');
            // Open ON the first step (a few samples/echoes usually precede it) so the
            // step line + highlight are populated before ▶ Play.
            const first = timeline.find(
                (it) => it.kind === 'status' && it.status && it.status.phase === 'step-start'
            );
            seek(first && first.ms - R.startMs < 2000 ? first.ms : R.startMs);
            syncLinkUi();
            if (Studio.updateUrl) Studio.updateUrl({ push: false });
            if (op.autoplay) setPaused(false);
            else {
                R.paused = true;
                R.playing = false;
                syncPlayUi();
            }
            if (R.viewerReady) sendViewerInit();
            return true;
        }

        // Pattern bytes for the 3D window. Repo patterns/ + colocated _patterns/ are
        // registered as lazy byte sources through the Studio's shared preview map, so
        // Studio.webBytesForName(name) (and webBytesForId for log-only runs) find them.
        async function wirePatternSources(res) {
            const token = ghToken();
            const logRepo = R.source && R.source.repo;
            const cfg = courseRepo();
            const jobs = [];
            if (
                logRepo &&
                (!cfg || cfg.full !== logRepo.full) &&
                Studio.registerRepoSharedPatternPreviews
            ) {
                jobs.push(Studio.registerRepoSharedPatternPreviews(logRepo, token));
            }
            if (res && res.repo && res.path && Studio.registerRepoPatternPreviews) {
                jobs.push(Studio.registerRepoPatternPreviews(res.repo, res.path, token));
            }
            try {
                await Promise.all(jobs);
            } catch (_) {
                /* previews are best-effort */
            }
        }

        function renderLogOnlySequence() {
            const body = $('seqBody');
            if (!body) return;
            body.innerHTML = '';
            const note = document.createElement('div');
            note.className = 'dim rpl-seqnote';
            note.textContent = 'Steps as recorded in the log (no protocol file found).';
            body.appendChild(note);
            R.logSteps.forEach((st) => {
                const row = document.createElement('div');
                row.className = 'seqrow';
                row.dataset.cond = st.conditionName;
                row.dataset.replayIndex = String(st.index);
                const chips = [];
                if (st.mode != null) chips.push('mode ' + st.mode);
                if (st.patternId != null) chips.push('pattern #' + st.patternId);
                if (st.durationSec != null) chips.push(st.durationSec + ' s');
                row.innerHTML =
                    '<span class="idx">' +
                    (st.index + 1) +
                    '</span><span class="nm"></span><span class="kchips"></span>';
                row.querySelector('.nm').textContent = st.conditionName;
                row.querySelector('.kchips').innerHTML = chips
                    .map((c) => '<span class="kchip">' + c.replace(/[<>&]/g, '') + '</span>')
                    .join('');
                body.appendChild(row);
            });
        }

        function highlightStep(instant) {
            const p = R.proj;
            if (!p.step || !p.condition || p.condition === '—') {
                if (Studio.clearSeqHighlight) Studio.clearSeqHighlight();
                return;
            }
            if (R.logOnly) {
                document
                    .querySelectorAll('.seqrow.active')
                    .forEach((el) => el.classList.remove('active'));
                const row = document.querySelector(
                    '.seqrow[data-replay-index="' + p.stepIndex + '"]'
                );
                if (row) {
                    row.classList.add('active');
                    try {
                        row.scrollIntoView({
                            block: 'nearest',
                            behavior: instant ? 'auto' : 'smooth'
                        });
                    } catch (_) {
                        /* old browsers */
                    }
                }
            } else if (Studio.highlightSeq) {
                Studio.highlightSeq(p.step, { instant: !!instant });
            }
        }

        function updateStepUi(instant) {
            highlightStep(instant);
            updateStepLabel();
        }

        function updateStepLabel() {
            const p = R.proj;
            if (!p.step) {
                ui.step.textContent = '';
                return;
            }
            const ord = p.stepIndex == null ? null : p.stepIndex + 1;
            const bits = [
                ord != null && p.stepTotal ? 'Step ' + ord + ' / ' + p.stepTotal : 'Step',
                p.condition
            ];
            const t = p.trial;
            const label = patternLabel(t);
            if (t && t.condition === p.condition) {
                if (t.mode) bits.push('mode ' + t.mode);
                if (label) bits.push(label);
            } else if (label && p.displayMode === 'pattern') {
                bits.push('display holds ' + label);
            }
            ui.step.textContent = bits.join(' · ');
        }

        // ---- playback engine -------------------------------------------------
        function pushToScope(item) {
            if (item.kind === 'sample') {
                Scope.pushSample(Object.assign({}, item.sample, { __replay: true }));
            } else if (item.kind === 'status') {
                Scope.onRunStatus(Object.assign({}, item.status, { replayMs: item.ms }));
            }
        }

        function process(item) {
            const r = applyItem(R.proj, item, R.ctx);
            pushToScope(item);
            if (r.stepStarted) updateStepUi(false);
            else if (r.trialChanged) updateStepLabel();
            if (r.trialChanged) loadPattern();
        }

        function seek(targetMs) {
            if (!R.timeline.length) return;
            const target = Math.max(R.startMs, Math.min(R.endMs, Number(targetMs) || R.startMs));
            Scope.setReplayMode(true);
            Scope.start();
            const spanS = Number(($('scopeSpan') || {}).value) || 60;
            const cutoff = Math.max(R.startMs, target - spanS * 1000 - 1500);
            const cut = seekIndex(R.timeline, cutoff);
            R.proj = primeProjection(R.timeline, cut, R.ctx);
            if (R.proj.step && cut > 0) {
                // The Scope window starts mid-step: re-open that step's annotations.
                Scope.onRunStatus({
                    phase: 'step-start',
                    step: { conditionName: R.proj.condition },
                    replayMs: cutoff
                });
                if (R.proj.trial && R.proj.displayMode === 'pattern') {
                    Scope.onRunStatus({
                        phase: 'trial-running',
                        params: {
                            mode: R.proj.trial.mode,
                            frameRate: R.proj.trial.frameRate,
                            initPos: R.proj.trial.frameIndex
                        },
                        replayMs: cutoff
                    });
                }
                if (R.proj.ledOn)
                    Scope.onRunStatus({ phase: 'led-activation', on: true, replayMs: cutoff });
            }
            R.index = cut;
            while (R.index < R.timeline.length && R.timeline[R.index].ms <= target) {
                const item = R.timeline[R.index++];
                applyItem(R.proj, item, R.ctx);
                pushToScope(item);
            }
            R.currentMs = target;
            Scope.setReplayClock(target);
            R.proj.frame = openLoopFrame(R.proj, target, R.ctx.patternFrames);
            updateStepUi(true);
            updateTransport();
            syncPlayUi();
            loadPattern();
            sendViewerState();
        }

        function tick(now) {
            R.raf = null;
            if (!R.active || !R.playing) return;
            if (!R.lastWall) R.lastWall = now;
            // Hidden tabs tick ~1 Hz (browser timer throttling): allow the bigger step.
            const maxStep = document.hidden ? 1500 : 250;
            const delta = Math.min(maxStep, Math.max(0, now - R.lastWall));
            R.lastWall = now;
            const target = Math.min(R.endMs, R.currentMs + delta * R.speed);
            while (R.index < R.timeline.length && R.timeline[R.index].ms <= target) {
                process(R.timeline[R.index++]);
            }
            R.currentMs = target;
            Scope.setReplayClock(target);
            R.proj.frame = openLoopFrame(R.proj, target, R.ctx.patternFrames);
            updateTransport();
            sendViewerState();
            if (target >= R.endMs) {
                R.playing = false;
                R.paused = true;
                if (Scope.setSoundSuspended) Scope.setSoundSuspended(true);
                syncPlayUi();
            } else ensureLoop();
        }

        // rAF normally; a timer while the Studio tab is HIDDEN (e.g. minimized to watch
        // the 3D window full-screen) — rAF never fires in a hidden tab, which would
        // freeze the replay clock and the 3D view with it.
        function ensureLoop() {
            if (!R.active || R.raf || R.timer) return;
            if (document.hidden) {
                R.timer = setTimeout(() => {
                    R.timer = null;
                    tick(performance.now());
                }, 50);
            } else {
                R.raf = requestAnimationFrame(tick);
            }
        }

        function cancelLoop() {
            if (R.raf) cancelAnimationFrame(R.raf);
            if (R.timer) clearTimeout(R.timer);
            R.raf = null;
            R.timer = null;
        }

        function setPaused(on) {
            if (!R.active || R.loading) return;
            if (on) {
                R.paused = true;
                R.playing = false;
                R.lastWall = 0;
                cancelLoop();
                if (Scope.setSoundSuspended) Scope.setSoundSuspended(true);
            } else {
                if (R.currentMs >= R.endMs) seek(R.startMs);
                R.paused = false;
                R.playing = true;
                R.lastWall = performance.now();
                if (Scope.setSoundSuspended) Scope.setSoundSuspended(false);
                ensureLoop();
            }
            syncPlayUi();
            syncSoundUi();
        }

        function togglePause(fromGesture) {
            // The first Play of a link-opened replay is the user gesture the 3D popup needs.
            if (fromGesture && R.paused && viewerWanted() && !R.viewer && R.viewerPending) {
                R.viewerPending = false;
                openViewer(true);
            }
            setPaused(!R.paused);
        }

        function updateTransport() {
            const elapsed = Math.max(0, R.currentMs - R.startMs);
            const dur = Math.max(0, R.endMs - R.startMs);
            ui.slider.value = String(elapsed);
            ui.clock.textContent = formatClock(elapsed) + ' / ' + formatClock(dur);
        }

        function syncPlayUi() {
            const atEnd = R.endMs > R.startMs && R.currentMs >= R.endMs;
            const paused = R.paused || !R.playing;
            ui.play.textContent = R.loading
                ? '…'
                : paused
                  ? atEnd
                      ? '↻ Replay'
                      : '▶ Play'
                  : 'Ⅱ Pause';
            ui.play.setAttribute('aria-pressed', String(!paused));
            ui.play.disabled = !R.active || R.loading;
            ui.play.title = paused
                ? atEnd
                    ? 'Play again from the start (Space)'
                    : 'Play from the current time (Space)'
                : 'Pause — the replay stays open (Space)';
        }

        function syncSoundUi() {
            if (!ui.sound) return;
            const on = !!(Scope.getSoundEnabled && Scope.getSoundEnabled());
            ui.sound.setAttribute('aria-pressed', String(on));
            ui.sound.classList.toggle('on', on);
            ui.sound.textContent = on ? '♪ Sound: on' : '♪ Sound: off';
            ui.sound.title = on
                ? 'Replay sonification is on — click to mute' +
                  (R.paused ? ' (silent while paused)' : '')
                : 'Sonify the recorded fly: turning → pitch, speed → volume';
        }

        function replayLink() {
            if (!R.source || R.source.kind !== 'repo' || !UrlState) return null;
            const q = UrlState.encodeApp({
                mode: 'run',
                replayRepo: R.source.repo.full,
                replayPath: R.source.path
            });
            return location.origin + location.pathname + q;
        }

        function syncLinkUi() {
            if (!ui.link) return;
            const url = replayLink();
            ui.link.disabled = !url;
            ui.link.title = url
                ? 'Copy a link that opens straight into this replay: ' + url
                : 'Only runs read from a repo have a shareable link — a local file has none.';
        }

        // ---- 3D arena window -------------------------------------------------
        function bindViewerMessages() {
            if (R.viewerBound) return;
            R.viewerBound = true;
            window.addEventListener('message', (event) => {
                if (!R.viewer || !ViewerProtocol || !ViewerProtocol.validateFromViewer) return;
                const v = ViewerProtocol.validateFromViewer(event, {
                    viewerWindow: R.viewer,
                    expectedOrigin: R.viewerOrigin,
                    sessionId: R.viewerSession
                });
                if (!v.ok) return;
                if (v.message.type === 'ready') {
                    R.viewerReady = true;
                    sendViewerInit();
                } else if (v.message.type === 'close') {
                    // A viewer RELOAD also says "close" (pagehide) but keeps its window;
                    // only forget it once the window is really gone, so the reloaded page's
                    // "ready" re-links (same WindowProxy, same session id).
                    R.viewerReady = false;
                    const win = R.viewer;
                    setTimeout(() => {
                        if (R.viewer === win && (!win || win.closed)) R.viewer = null;
                    }, 1000);
                }
            });
        }

        function currentViewerPlacement() {
            try {
                const s = global.screen || {};
                const panel = $('metaPanel');
                const r =
                    panel && panel.offsetParent !== null ? panel.getBoundingClientRect() : null;
                return viewerPlacement({
                    screen: {
                        availLeft: s.availLeft,
                        availTop: s.availTop,
                        availWidth: s.availWidth,
                        availHeight: s.availHeight
                    },
                    win: {
                        screenX: window.screenX,
                        screenY: window.screenY,
                        outerWidth: window.outerWidth,
                        outerHeight: window.outerHeight,
                        innerWidth: window.innerWidth,
                        innerHeight: window.innerHeight
                    },
                    panel: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
                });
            } catch (_) {
                return null;
            }
        }

        function openViewer(userGesture) {
            if (!ViewerProtocol) return null;
            if (R.viewer && !R.viewer.closed) {
                R.viewer.focus();
                if (R.viewerReady) sendViewerInit();
                return R.viewer;
            }
            R.viewerSession =
                'studio-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
            R.viewerOrigin = location.origin === 'null' ? 'null' : location.origin;
            R.viewerReady = false;
            const url =
                'arena_replay_viewer.html?session=' +
                encodeURIComponent(R.viewerSession) +
                '&origin=' +
                encodeURIComponent(R.viewerOrigin);
            bindViewerMessages();
            // Small, and placed out of the way (beside the Studio, else over the greyed-out
            // Run-details column) so it never covers the replay bar, sequence or Scope.
            const place = currentViewerPlacement();
            R.viewer = window.open(
                url,
                'arena-studio-replay-viewer',
                'popup=yes,resizable=yes,' +
                    (place
                        ? 'width=' +
                          place.width +
                          ',height=' +
                          place.height +
                          ',left=' +
                          place.left +
                          ',top=' +
                          place.top
                        : 'width=560,height=420')
            );
            if (!R.viewer) {
                R.viewerPending = true;
                if (Studio.showBanner)
                    Studio.showBanner(
                        'The browser blocked the 3D window — click “3D view” on the replay bar.'
                    );
            } else if (userGesture) {
                R.viewerPending = false;
                R.viewer.focus();
            }
            return R.viewer;
        }

        function closeViewer() {
            if (R.viewer && !R.viewer.closed) {
                postViewer('close', { reason: 'replay-stopped' });
                try {
                    R.viewer.close();
                } catch (_) {
                    /* already gone */
                }
            }
            R.viewer = null;
            R.viewerReady = false;
        }

        function postViewer(type, payload) {
            if (!R.viewerReady || !R.viewer || R.viewer.closed || !ViewerProtocol) return false;
            try {
                R.viewer.postMessage(
                    ViewerProtocol.makeMessage(
                        ViewerProtocol.OPENER_SOURCE,
                        type,
                        R.viewerSession,
                        payload || {}
                    ),
                    R.viewerOrigin === 'null' ? '*' : R.viewerOrigin
                );
                return true;
            } catch (_) {
                return false;
            }
        }

        function arenaConfigName() {
            const meta = (R.parsed && R.parsed.metadata) || {};
            return (
                meta.arena_config ||
                (Studio.currentDoc && Studio.currentDoc.rig && Studio.currentDoc.rig.arenaConfig) ||
                (Studio.currentRig && Studio.currentRig.arenaConfig) ||
                'G6_2x10'
            );
        }

        function viewerState() {
            return {
                elapsedMs: R.currentMs - R.startMs,
                condition: R.proj.condition,
                frame: R.proj.frame,
                ledOn: R.proj.ledOn,
                displayMode: R.proj.displayMode,
                ball: R.proj.ball ? R.proj.ball.slice() : undefined,
                gait: R.proj.gait && flyGait() ? flyGait().gaitState(R.proj.gait) : undefined
            };
        }

        function sendViewerInit() {
            const cached = R.patternKey ? R.patternCache.get(R.patternKey) : null;
            const payload = {
                arenaConfigName: arenaConfigName(),
                patternName: patternLabel(R.proj.trial),
                state: viewerState()
            };
            if (cached && cached.bytes) payload.patternBytes = cached.bytes;
            else payload.pattern = null;
            postViewer('init', payload);
        }

        function sendViewerState() {
            postViewer('state', viewerState());
        }

        // ---- patterns ---------------------------------------------------------
        function patternLabel(t) {
            if (!t) return null;
            return t.patternName || (t.patternId ? 'pattern #' + t.patternId : null);
        }
        function patternKeyOf(t) {
            if (!t) return null;
            if (t.patternName) return 'n:' + String(t.patternName);
            if (t.patternId) return 'id:' + t.patternId;
            return null;
        }
        function logicalName(n) {
            return baseName(n)
                .replace(/\.pat$/i, '')
                .replace(/^\d+[_-]/, '')
                .toLowerCase();
        }
        function toArrayBuffer(v) {
            if (v instanceof ArrayBuffer) return v.slice(0);
            if (ArrayBuffer.isView(v))
                return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
            return null;
        }
        async function fetchDeclaredLibrary(name) {
            const exp = R.ctx.experiment;
            const lib = exp && exp.experiment_info && exp.experiment_info.pattern_library;
            if (typeof lib !== 'string' || !lib.trim()) return null;
            const safe = lib.trim().replace(/^\.\//, '').replace(/\/+$/, '');
            if (!safe || safe.includes('..') || /^[a-z]+:/i.test(safe) || safe.startsWith('/'))
                return null;
            const raw = baseName(name);
            for (const fn of /\.pat$/i.test(raw) ? [raw] : [raw + '.pat', raw]) {
                try {
                    const url = new URL(safe + '/' + fn, location.href);
                    if (url.origin !== location.origin) continue;
                    const r = await fetch(url.href);
                    if (r.ok) return r.arrayBuffer();
                } catch (_) {
                    /* try next */
                }
            }
            return null;
        }

        async function loadPattern() {
            const t = R.proj.trial;
            const key = patternKeyOf(t);
            if (key === R.patternKey) return;
            R.patternKey = key;
            const token = ++R.patternToken;
            R.ctx.patternFrames = 0;
            if (!key) {
                postViewer('pattern', {
                    pattern: null,
                    arenaConfigName: arenaConfigName(),
                    state: viewerState()
                });
                return;
            }
            let cached = R.patternCache.get(key);
            if (!cached) {
                const sources = [];
                if (t.patternName) {
                    const own = R.overridePats.get(logicalName(t.patternName));
                    if (own) sources.push(() => own.arrayBuffer());
                    const web = Studio.webBytesForName && Studio.webBytesForName(t.patternName);
                    if (web) sources.push(web);
                    sources.push(() => fetchDeclaredLibrary(t.patternName));
                }
                if (t.patternId) {
                    const byId = Studio.webBytesForId && Studio.webBytesForId(t.patternId);
                    if (byId) sources.push(byId);
                }
                const PP = global.PatParser;
                for (const src of sources) {
                    try {
                        const bytes = toArrayBuffer(await src());
                        const parsed = bytes && PP && PP.parsePatFile(bytes);
                        if (bytes && parsed) {
                            cached = { bytes, frames: parsed.numFrames };
                            break;
                        }
                    } catch (_) {
                        /* next source */
                    }
                }
                cached = cached || { bytes: null, frames: 0 };
                R.patternCache.set(key, cached);
            }
            if (token !== R.patternToken) return;
            R.ctx.patternFrames = cached.frames || 0;
            if (R.ctx.patternFrames)
                R.proj.frame = positiveModulo(R.proj.frame, R.ctx.patternFrames);
            const payload = {
                patternName: patternLabel(t),
                arenaConfigName: arenaConfigName(),
                state: viewerState()
            };
            if (cached.bytes) payload.patternBytes = cached.bytes;
            else payload.pattern = null;
            postViewer('pattern', payload);
        }

        // ---- recent-runs dialog ------------------------------------------------
        function dialogRepo() {
            return (R.source && R.source.repo) || R.runsRepoObj || courseRepo();
        }

        async function loadRuns(force, repoOverride) {
            const repo = repoOverride || dialogRepo();
            if (!repo || !GH) {
                ui.list.innerHTML =
                    '<div class="picker-note">No course repo configured (File ▾ → GitHub).</div>';
                return;
            }
            ui.repoLbl.textContent = repo.full + (ghToken() ? ' · signed in' : ' · public read');
            if (!force && R.runs && R.runsRepo === repo.full) {
                renderRuns();
                return;
            }
            if (R.runsLoading) return R.runsLoading;
            ui.list.innerHTML = '<div class="picker-note">Listing runs in ' + repo.full + '…</div>';
            R.runsLoading = (async () => {
                try {
                    const dirs = (await listRepoDir(repo, 'runlogs')).filter(
                        (e) => e && e.type === 'dir' && isSafeSegment(e.name)
                    );
                    const entries = await Promise.all(
                        dirs.map(async (d) => {
                            try {
                                const text = await readRepoText(
                                    repo,
                                    'runlogs/' + d.name + '/index.json'
                                );
                                return { folder: d.name, data: text ? JSON.parse(text) : null };
                            } catch (_) {
                                return { folder: d.name, data: null };
                            }
                        })
                    );
                    R.runs = mergeRunIndexes(entries);
                    R.runsRepo = repo.full;
                    R.runsRepoObj = repo;
                    const folders = dirs
                        .map((d) => d.name)
                        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                    const keep = ui.folder.value;
                    ui.folder.innerHTML = '<option value="">All benches</option>';
                    folders.forEach((f) => {
                        const opt = document.createElement('option');
                        opt.value = f;
                        opt.textContent = f;
                        ui.folder.appendChild(opt);
                    });
                    if (folders.includes(keep)) ui.folder.value = keep;
                    renderRuns();
                } catch (e) {
                    ui.list.innerHTML = '';
                    const n = document.createElement('div');
                    n.className = 'picker-note';
                    n.textContent = 'Could not list runs: ' + errText(e);
                    ui.list.appendChild(n);
                } finally {
                    R.runsLoading = null;
                }
            })();
            return R.runsLoading;
        }

        function renderRuns() {
            const runs = R.runs || [];
            const folder = ui.folder.value;
            const q = ui.filter.value;
            const shown = runs.filter(
                (r) => (!folder || r.folder === folder) && runMatchesFilter(r, q)
            );
            ui.list.innerHTML = '';
            if (!shown.length) {
                ui.list.innerHTML = '<div class="picker-note">No runs match.</div>';
                return;
            }
            const LIMIT = 150;
            const repo = dialogRepo();
            shown.slice(0, LIMIT).forEach((run) => {
                const d = describeRun(run);
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'rpd-run';
                b.title = 'Replay ' + run.path + (run.run_id ? ' (run ' + run.run_id + ')' : '');
                const top = document.createElement('span');
                top.className = 'rpd-run-top';
                const t = document.createElement('b');
                t.textContent = d.title;
                const w = document.createElement('span');
                w.className = 'rpd-when';
                w.textContent = d.when;
                top.append(t, w);
                const sub = document.createElement('span');
                sub.className = 'sub';
                sub.textContent = d.bits.join(' · ');
                b.append(top, sub);
                b.addEventListener('click', () => {
                    closeDialog();
                    startFromRepo(repo, run.path, { gesture: true, autoplay: true, entry: run });
                });
                ui.list.appendChild(b);
            });
            if (shown.length > LIMIT) {
                const n = document.createElement('div');
                n.className = 'picker-note';
                n.textContent = shown.length - LIMIT + ' older runs not shown — narrow the filter.';
                ui.list.appendChild(n);
            }
        }

        function openDialog() {
            ui.overlay.style.display = 'flex';
            ui.viewerChk.checked = viewerWanted();
            ui.speedSel.value = String(R.speed);
            setDlgStatus('');
            loadRuns(false);
            setTimeout(() => ui.filter.focus(), 0);
        }
        function closeDialog() {
            ui.overlay.style.display = 'none';
        }

        // ---- URL (read side lives in initFromUrl; this resolves the link) ------
        /**
         * Called by initFromUrl for ?replay=. Synchronous prefix records the pending
         * link so the canonical URL write that follows keeps it.
         * state: {repo, path?, runId?, hintPath?}
         */
        function openFromUrl(state) {
            const s = state || {};
            const repo = repoFromFull(s.repo) || courseRepo();
            if (!repo) return Promise.resolve(false);
            if (s.path) R.pendingUrl = { repo: repo.full, path: s.path };
            return (async () => {
                let path = s.path;
                if (!path && s.runId) {
                    await loadRuns(true, repo);
                    const hit = (R.runs || []).find((r) => r.run_id === s.runId);
                    if (!hit) {
                        if (Studio.showBanner)
                            Studio.showBanner(
                                'Replay: run ' + s.runId + ' was not found in ' + repo.full + '.'
                            );
                        return false;
                    }
                    path = hit.path;
                }
                // No user gesture here: load paused; the first ▶ Play opens the 3D window.
                R.viewerPending = true;
                const ok = await startFromRepo(repo, path, {
                    gesture: false,
                    autoplay: false,
                    hintPath: s.hintPath
                });
                if (ok && Studio.showBanner)
                    Studio.showBanner('Replay loaded — press ▶ Play (or Space) to start.');
                return ok;
            })();
        }

        function urlState() {
            if (R.active && R.source && R.source.kind === 'repo' && R.source.path) {
                return { repo: R.source.repo.full, path: R.source.path };
            }
            return R.pendingUrl;
        }

        // ---- wiring -----------------------------------------------------------
        const openBtn = $('replayOpenBtn');
        if (openBtn) openBtn.addEventListener('click', openDialog);
        const fm = $('fmReplay');
        if (fm)
            fm.addEventListener('click', () => {
                const menu = $('fileMenu');
                if (menu) menu.classList.remove('open');
                openDialog();
            });
        ui.close.addEventListener('click', closeDialog);
        ui.overlay.addEventListener('click', (e) => {
            if (e.target === ui.overlay) closeDialog();
        });
        ui.filter.addEventListener('input', renderRuns);
        ui.folder.addEventListener('change', renderRuns);
        ui.refresh.addEventListener('click', () => loadRuns(true));
        ui.localBtn.addEventListener('click', () => ui.localInput.click());
        ui.localInput.addEventListener('change', () => {
            const f = ui.localInput.files && ui.localInput.files[0];
            ui.localInput.value = '';
            if (!f) return;
            closeDialog();
            startFromFile(f, { gesture: true, autoplay: true });
        });
        ui.viewerChk.addEventListener('change', () => {
            localStorage.setItem(VIEWER_PREF, ui.viewerChk.checked ? '1' : '0');
        });
        function setSpeed(v) {
            const n = Number(v);
            R.speed = SPEEDS.includes(n) ? n : 1;
            ui.speedSel.value = String(R.speed);
            ui.speed.value = String(R.speed);
            localStorage.setItem(SPEED_PREF, String(R.speed));
            R.lastWall = performance.now();
        }
        setSpeed(localStorage.getItem(SPEED_PREF) || 1);
        ui.speedSel.addEventListener('change', () => setSpeed(ui.speedSel.value));
        ui.speed.addEventListener('change', () => setSpeed(ui.speed.value));
        ui.yamlBtn.addEventListener('click', () => ui.yamlInput.click());
        ui.yamlInput.addEventListener('change', () => {
            const f = ui.yamlInput.files && ui.yamlInput.files[0];
            ui.yamlInput.value = '';
            R.overrideYaml = f || null;
            ui.yamlName.textContent = f
                ? f.name + ' (used instead of the automatic lookup)'
                : 'automatic';
        });
        ui.patBtn.addEventListener('click', () => ui.patInput.click());
        ui.patInput.addEventListener('change', () => {
            R.overridePats.clear();
            Array.from(ui.patInput.files || []).forEach((f) =>
                R.overridePats.set(logicalName(f.name), f)
            );
            ui.patInput.value = '';
            R.patternCache.clear();
            R.patternKey = null;
            ui.patName.textContent = R.overridePats.size
                ? R.overridePats.size + ' file' + (R.overridePats.size === 1 ? '' : 's')
                : 'automatic';
        });

        ui.play.addEventListener('click', () => togglePause(true));
        ui.stop.addEventListener('click', () => stop());
        ui.another.addEventListener('click', openDialog);
        ui.viewerBtn.addEventListener('click', () => {
            R.viewerPending = false;
            openViewer(true);
        });
        ui.link.addEventListener('click', async () => {
            const url = replayLink();
            if (!url) return;
            try {
                await navigator.clipboard.writeText(url);
                ui.link.textContent = '✓ Link copied';
            } catch (_) {
                window.prompt('Copy this replay link:', url);
            }
            setTimeout(() => {
                ui.link.textContent = '🔗 Copy link';
            }, 1600);
        });
        ui.slider.addEventListener('input', () => {
            const target = R.startMs + Number(ui.slider.value || 0);
            const resume = R.playing && !R.paused;
            if (R.seekRaf) cancelAnimationFrame(R.seekRaf);
            R.seekRaf = requestAnimationFrame(() => {
                R.seekRaf = null;
                seek(target);
                R.lastWall = performance.now();
                R.playing = resume;
                if (resume) ensureLoop();
            });
        });
        if (ui.sound) {
            ui.sound.addEventListener('click', () => {
                if (Scope.setSoundEnabled)
                    Scope.setSoundEnabled(!(Scope.getSoundEnabled && Scope.getSoundEnabled()));
                if (R.paused && Scope.setSoundSuspended) Scope.setSoundSuspended(true);
                syncSoundUi();
            });
            ui.soundCfg.addEventListener('click', (e) => {
                e.stopPropagation();
                if (document.querySelector('.scope-sound-menu.open')) {
                    if (Scope.closeSoundSettings) Scope.closeSoundSettings();
                } else if (Scope.openSoundSettings) Scope.openSoundSettings(ui.soundCfg);
            });
            document.addEventListener('scope-sound-change', syncSoundUi);
            syncSoundUi();
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && ui.overlay.style.display === 'flex') {
                closeDialog();
                return;
            }
            if (!R.active || R.loading || e.ctrlKey || e.metaKey || e.altKey) return;
            if (ui.overlay.style.display === 'flex') return;
            const tag = (e.target && e.target.tagName) || '';
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return; // the slider seeks natively
            if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return; // native click
            if (e.key === ' ') {
                e.preventDefault();
                togglePause(true);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const resume = R.playing && !R.paused;
                seek(R.currentMs + (e.key === 'ArrowLeft' ? -5000 : 5000));
                R.lastWall = performance.now();
                R.playing = resume;
                if (resume) ensureLoop();
            }
        });
        // Switch rAF ⇄ timer when the tab is hidden/shown mid-playback (a pending rAF
        // in a hidden tab would otherwise never fire and stall the loop).
        document.addEventListener('visibilitychange', () => {
            if (!R.active || !R.playing) return;
            cancelLoop();
            ensureLoop();
        });
        window.addEventListener('pagehide', () => {
            if (!R.active) return;
            R.loadToken++;
            closeViewer();
            if (Studio.session && Studio.session.setOutputInhibited) {
                try {
                    Studio.session.setOutputInhibited(null);
                } catch (_) {
                    /* best-effort */
                }
            }
        });

        const api = {
            openDialog,
            closeDialog,
            startFromRepo,
            startFromFile,
            openFromUrl,
            urlState,
            stop,
            seek,
            setPaused,
            togglePause,
            openViewer,
            resolveProtocol,
            get active() {
                return R.active;
            },
            state: R
        };
        Studio.replay = api;
        return api;
    }

    const StudioReplay = {
        SPEEDS,
        formatClock,
        positiveModulo,
        normalizeSha,
        baseName,
        isSafeSegment,
        isSafeRunlogPath,
        isSafeProtocolPath,
        isSafeRunId,
        runlogFolder,
        parseRunlogFilename,
        protocolFilenames,
        protocolSearchPaths,
        mergeRunIndexes,
        formatWhen,
        formatDuration,
        describeRun,
        runMatchesFilter,
        conditionOf,
        isLedOnMv,
        trialFromProtocol,
        createProjection,
        applyStatus,
        applyItem,
        openLoopFrame,
        logOnlySteps,
        seekIndex,
        primeProjection,
        viewerPlacement,
        BALL_SIGNS,
        sampleTimeMs,
        ballDelta,
        ballStep,
        quatMul,
        quatAxisAngle,
        quatNormalize,
        install
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioReplay;
    }
    if (typeof global !== 'undefined') {
        global.StudioReplay = StudioReplay;
    }
})(typeof window !== 'undefined' ? window : this);
