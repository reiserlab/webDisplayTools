(function (global) {
    'use strict';

    const K =
        global.Kinematics ||
        (typeof require === 'function' ? require('./vendor/kinematics.js') : null);
    const DEFAULT_BALL_DIAMETER_MM = 9;
    const DEFAULT_SMOOTH_WINDOW_S = 0.5;
    const ANALOG_OFF_FLOOR_MV = 4900;

    function safeText(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function finite(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : NaN;
    }

    function mean(values) {
        let sum = 0;
        let count = 0;
        for (const value of values) {
            if (!Number.isFinite(value)) continue;
            sum += value;
            count += 1;
        }
        return count ? sum / count : NaN;
    }

    function sem(values) {
        const valid = values.filter(Number.isFinite);
        if (valid.length < 2) return 0;
        const avg = mean(valid);
        const variance =
            valid.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (valid.length - 1);
        return Math.sqrt(variance / valid.length);
    }

    function median(values) {
        const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
        if (!valid.length) return NaN;
        const mid = Math.floor(valid.length / 2);
        return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
    }

    function mod(value, divisor) {
        return ((value % divisor) + divisor) % divisor;
    }

    function wrapDeg(value) {
        return K ? K.wrapToDeg180(value) : mod(value + 180, 360) - 180;
    }

    function normalizeKey(key) {
        if (key === 'idx') return 'index';
        if (key === 'ts') return 'ft';
        return key;
    }

    function valueFromArray(row, schema, names, fallbackIndex) {
        for (const name of names) {
            const direct = schema.indexOf(name);
            if (direct >= 0) return row[direct];
            const normalized = schema.findIndex((key) => normalizeKey(key) === normalizeKey(name));
            if (normalized >= 0) return row[normalized];
        }
        return fallbackIndex >= 0 && fallbackIndex < row.length ? row[fallbackIndex] : NaN;
    }

    function inferSchema(row) {
        if (row.length === 7) return ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd'];
        if (row.length === 8) return ['ms', 'fc', 'index', 'ft', 'x', 'y', 'hd', 'dir'];
        if (row.length >= 25)
            return [
                'fc',
                'dr',
                'dhd',
                'dx',
                'dy',
                'x',
                'y',
                'hd',
                'dir',
                'speed',
                'intx',
                'inty',
                'timestamp',
                'sequence',
                'x',
                'y',
                'hd',
                'dir',
                'speed',
                'forward',
                'side',
                'ft',
                'sequence2',
                'dt',
                'cam'
            ];
        return [];
    }

    function parseFrameArray(row, schema, lineNumber) {
        const activeSchema = schema.length ? schema : inferSchema(row);
        if (!activeSchema.length) return null;
        const longRow = row.length >= 25;
        if (longRow && !schema.length) {
            return {
                ms: finite(row[12]),
                fc: finite(row[0]),
                index: NaN,
                ft: finite(row[21]),
                x: finite(row[14]),
                y: finite(row[15]),
                hd: finite(row[16]),
                dir: finite(row[17]),
                lineNumber
            };
        }
        const frame = {
            ms: finite(valueFromArray(row, activeSchema, ['ms', 't', 'rx_ms'], longRow ? 12 : 0)),
            fc: finite(valueFromArray(row, activeSchema, ['fc'], 1)),
            index: finite(valueFromArray(row, activeSchema, ['index', 'idx'], 2)),
            ft: finite(valueFromArray(row, activeSchema, ['ft', 'ts'], longRow ? 21 : 3)),
            x: finite(valueFromArray(row, activeSchema, ['x'], longRow ? 14 : 4)),
            y: finite(valueFromArray(row, activeSchema, ['y'], longRow ? 15 : 5)),
            hd: finite(valueFromArray(row, activeSchema, ['hd'], longRow ? 16 : 6)),
            dir: finite(valueFromArray(row, activeSchema, ['dir'], row.length === 8 ? 7 : -1)),
            lineNumber
        };
        return Number.isFinite(frame.ms) ? frame : null;
    }

    function parseFicTracObject(rec, lineNumber) {
        const ft = Array.isArray(rec.fictrac) ? rec.fictrac : [];
        if (ft.length < 18) return null;
        return {
            ms: finite(rec.t ?? rec.rx_ms ?? rec.ms),
            fc: finite(ft[0]),
            index: finite(rec.index ?? rec.idx),
            ft: finite(ft[21]),
            x: finite(ft[14]),
            y: finite(ft[15]),
            hd: finite(ft[16]),
            dir: finite(ft[17]),
            lineNumber
        };
    }

    function relativeEventMs(rec, sessionStartMs) {
        const raw = finite(rec.rx_ms ?? rec.ms ?? rec.t);
        if (!Number.isFinite(raw)) return NaN;
        return Number.isFinite(sessionStartMs) && raw > 1e9 ? raw - sessionStartMs : raw;
    }

    function parseMetadataPrefix(text, sourceName, sourcePath) {
        const lines = safeText(text).split(/\r?\n/);
        let metadata = {};
        for (const line of lines) {
            if (!line.includes('run_metadata')) continue;
            try {
                const rec = JSON.parse(line);
                if (rec && !Array.isArray(rec) && rec.event === 'run_metadata') {
                    metadata = rec;
                    break;
                }
            } catch (_) {
                // A partial final line is expected when reading only a file prefix.
            }
        }
        return descriptorFromMetadata(metadata, sourceName, sourcePath);
    }

    function parseFilename(sourceName) {
        const fileName = safeText(sourceName).split('/').pop() || 'runlog.jsonl';
        const stem = fileName.replace(/\.jsonl$/i, '');
        const fields = stem.split('__');
        return {
            fileName,
            protocolStem: fields[0] || stem,
            experimenter: fields[1] || '',
            timestamp: fields[2] || '',
            runId: fields[3] || ''
        };
    }

    function protocolInfo(metadata, conditions) {
        const filename = safeText(metadata && metadata.protocol_filename)
            .toLowerCase()
            .replaceAll('-', '_');
        const names = conditions || [];
        if (
            filename.includes('p0') ||
            names.some((name) => /^(grating|bar)_(cw|ccw)_/.test(name))
        ) {
            return { family: 'p0', label: 'p0 optogenetic intensity' };
        }
        if (filename.includes('p1') || names.some((name) => /^(om_|loom_)/.test(name))) {
            return { family: 'p1', label: 'p1 optomotor + looming' };
        }
        const p3Patterns = {
            heisenberg_ts: 'T figures',
            heisenberg_high_low: 'high/low bars',
            heisenberg_slashes: 'left/right slashes',
            heisenberg_relational: 'relational slashes',
            dill_random_checkers: 'Dill random checkers'
        };
        const namedP3 = filename.match(
            /(?:^|\/)p3_(heisenberg_ts|heisenberg_high_low|heisenberg_slashes|heisenberg_relational|dill_random_checkers)_(short|full)(?:\.yaml)?$/
        );
        const hasP3Phases = names.some((name) =>
            /^(baseline|training|probe)_phase(?:0|90)$/.test(name)
        );
        const hasLegacyP3Phases =
            names.some((name) => /^baseline_[ab]$/.test(name)) &&
            names.some((name) => /^training_[ab]$/.test(name)) &&
            names.some((name) => /^probe_[ab]$/.test(name));
        if (namedP3) {
            const pattern = namedP3[1];
            const timing = namedP3[2];
            return {
                family: `p3-${pattern.replaceAll('_', '-')}`,
                label: `p3 ${p3Patterns[pattern]}`,
                p3Pattern: pattern,
                p3Timing: timing,
                p3Legacy: false
            };
        }
        if (filename.includes('p3_conditioning_closedloop_v2_short') || hasP3Phases) {
            return {
                family: 'p3-heisenberg-ts',
                label: 'p3 T figures',
                p3Pattern: 'heisenberg_ts',
                p3Timing: filename.includes('_full') ? 'full' : 'short',
                p3Legacy: false
            };
        }
        if (filename.includes('p3') || hasLegacyP3Phases) {
            return {
                family: 'p3-legacy-diagnostic',
                label: 'p3 legacy diagnostic',
                p3Pattern: 'heisenberg_ts',
                p3Timing: 'legacy',
                p3Legacy: true
            };
        }
        if (
            filename.includes('p2') ||
            names.some((name) => /^(burst_)?(ab_|sw_|cl_bar|base_bar)/.test(name))
        ) {
            const burst =
                filename.includes('burst') || names.some((name) => name.startsWith('burst_'));
            return burst
                ? { family: 'p2-burst', label: 'p2 object choice, burst' }
                : { family: 'p2-tonic', label: 'p2 object choice, tonic' };
        }
        return { family: 'generic', label: 'generic protocol' };
    }

    function descriptorFromMetadata(metadata, sourceName, sourcePath) {
        const parsed = parseFilename(sourceName || sourcePath);
        const info = protocolInfo(metadata || {}, []);
        const runId = safeText(metadata && metadata.run_id) || parsed.runId || parsed.fileName;
        const path = safeText(sourcePath || sourceName);
        return {
            key: path || runId,
            path,
            sourceName: parsed.fileName,
            runId,
            protocol: safeText(metadata && metadata.protocol_filename) || parsed.protocolStem,
            protocolFamily: info.family,
            protocolLabel: info.label,
            protocolSha: safeText(metadata && metadata.protocol_sha256),
            genotype: safeText(metadata && metadata.genotype) || 'unknown',
            sex: safeText(metadata && metadata.sex) || 'unknown',
            age: safeText(metadata && metadata.age),
            flyNumber: safeText(metadata && metadata.fly_number),
            experimenter: safeText(metadata && metadata.experimenter) || parsed.experimenter,
            bench: safeText(metadata && (metadata.rig_id || metadata.bench)),
            timestamp: safeText(metadata && metadata.timestamp_start) || parsed.timestamp,
            notes: safeText(metadata && metadata.notes),
            metadata: metadata || {}
        };
    }

    function extractSteps(events, sessionStartMs) {
        const byIndex = new Map();
        for (const rec of events) {
            if (rec.event !== 'runner') continue;
            const index = finite(rec.index);
            if (!Number.isFinite(index)) continue;
            const ms = relativeEventMs(rec, sessionStartMs);
            const step = byIndex.get(index) || {
                index,
                condition: safeText(rec.condition),
                startMs: NaN,
                endMs: NaN,
                intervals: [],
                commands: [],
                events: [],
                epochs: []
            };
            step.events.push(rec);
            if (rec.phase === 'step-start') {
                step.startMs = ms;
                step.condition = safeText(rec.condition);
            } else if (rec.phase === 'step-done') {
                step.endMs = ms;
            } else if (rec.phase === 'trial-running') {
                step.intervals.push({
                    startMs: ms,
                    endMs: ms + finite(rec.durationSec || 0) * 1000,
                    durationSec: finite(rec.durationSec || 0),
                    params: rec.params || {},
                    ledActivation: rec.ledActivation || null
                });
            } else if (rec.phase === 'command') {
                step.commands.push({
                    ms,
                    op: safeText(rec.op || rec.command_name),
                    value: rec.value,
                    params: rec.params || {}
                });
            }
            byIndex.set(index, step);
        }

        const steps = [...byIndex.values()].sort((a, b) => a.index - b.index);
        for (const step of steps) {
            const intervalEnds = step.intervals
                .map((interval) => interval.endMs)
                .filter(Number.isFinite);
            if (!Number.isFinite(step.startMs) && step.intervals.length) {
                step.startMs = Math.min(...step.intervals.map((interval) => interval.startMs));
            }
            if (!Number.isFinite(step.endMs) && intervalEnds.length)
                step.endMs = Math.max(...intervalEnds);
            step.durationSec =
                Number.isFinite(step.endMs) && Number.isFinite(step.startMs)
                    ? Math.max(0, (step.endMs - step.startMs) / 1000)
                    : NaN;
        }
        return steps.filter((step) => Number.isFinite(step.startMs));
    }

    function inferFtScaleToMs(frames) {
        const diffs = [];
        for (let i = 1; i < frames.length && diffs.length < 500; i += 1) {
            const diff = frames[i].ft - frames[i - 1].ft;
            if (Number.isFinite(diff) && diff > 0) diffs.push(diff);
        }
        const typical = median(diffs);
        return Number.isFinite(typical) && typical > 0 && typical < 1 ? 1000 : 1;
    }

    function centeredMean(times, values, windowSec) {
        const out = new Array(values.length).fill(NaN);
        if (!values.length) return out;
        const half = windowSec / 2;
        let lo = 0;
        let hi = 0;
        let sum = 0;
        let count = 0;
        for (let i = 0; i < values.length; i += 1) {
            const center = times[i];
            while (hi < times.length && times[hi] <= center + half) {
                if (Number.isFinite(values[hi])) {
                    sum += values[hi];
                    count += 1;
                }
                hi += 1;
            }
            while (lo < times.length && times[lo] < center - half) {
                if (Number.isFinite(values[lo])) {
                    sum -= values[lo];
                    count -= 1;
                }
                lo += 1;
            }
            out[i] = count ? sum / count : NaN;
        }
        return out;
    }

    function deriveSignals(run, options) {
        const opts = options || {};
        const frames = run.frames;
        if (!frames.length || !K) return;
        const ftScale = inferFtScaleToMs(frames);
        const ballRadiusMm = K.ballRadiusMm(
            finite(opts.ballDiameterMm) || DEFAULT_BALL_DIAMETER_MM
        );
        const smoothWindowS = finite(opts.smoothWindowS) || DEFAULT_SMOOTH_WINDOW_S;
        const unwrappedHeading = K.unwrap(frames.map((frame) => frame.hd));
        const samples = frames.map((frame, index) => ({
            ms: frame.ms,
            ft: Number.isFinite(frame.ft) ? frame.ft * ftScale : frame.ms,
            x: frame.x,
            y: frame.y,
            hd: frame.hd,
            idx: frame.index,
            fc: frame.fc,
            index
        }));

        for (let i = 0; i < frames.length; i += 1) {
            const frame = frames[i];
            const derived = K.centralDiff(samples, i, { ballRadiusMm });
            frame.ftMs = samples[i].ft;
            frame.timeS = frame.ms / 1000;
            frame.headingDeg = K.wrapToDeg180(frame.hd * K.RAD2DEG);
            frame.headingUnwrappedDeg = unwrappedHeading[i] * K.RAD2DEG;
            frame.forwardMmS = derived ? derived.forward_mm_s : NaN;
            frame.speedMmS = derived ? derived.speed_mm_s : NaN;
            frame.turningDegS = derived ? derived.turning_deg_s : NaN;
            frame.frameGap =
                i > 0 && Number.isFinite(frame.fc) && Number.isFinite(frames[i - 1].fc)
                    ? frame.fc - frames[i - 1].fc
                    : 0;
        }

        const times = frames.map((frame) => frame.timeS);
        const smoothForward = centeredMean(
            times,
            frames.map((frame) => frame.forwardMmS),
            smoothWindowS
        );
        const smoothTurning = centeredMean(
            times,
            frames.map((frame) => frame.turningDegS),
            smoothWindowS
        );
        for (let i = 0; i < frames.length; i += 1) {
            frames[i].forwardMmSSmoothed = smoothForward[i];
            frames[i].turningDegSSmoothed = smoothTurning[i];
        }
        run.analysisSettings = { ballDiameterMm: ballRadiusMm * 2, smoothWindowS };
    }

    function assignFramesToSteps(run) {
        const framesByStep = new Map();
        if (!run.steps.length) {
            run.framesByStep = framesByStep;
            return;
        }
        let cursor = 0;
        for (const frame of run.frames) {
            while (cursor + 1 < run.steps.length && frame.ms >= run.steps[cursor + 1].startMs)
                cursor += 1;
            const step = run.steps[cursor];
            if (
                !step ||
                frame.ms < step.startMs ||
                (Number.isFinite(step.endMs) && frame.ms > step.endMs + 25)
            )
                continue;
            frame.stepIndex = step.index;
            frame.condition = step.condition;
            if (!framesByStep.has(step.index)) framesByStep.set(step.index, []);
            framesByStep.get(step.index).push(frame);
        }
        run.framesByStep = framesByStep;
    }

    function buildAnalogChanges(run) {
        run.analogChanges = run.events
            .filter(
                (rec) =>
                    rec.event === 'runner' &&
                    rec.phase === 'command' &&
                    (rec.op === 'setAnalogOut' || rec.command_name === 'setAnalogOut')
            )
            .map((rec) => ({
                ms: relativeEventMs(rec, run.sessionStartMs),
                value: finite(rec.value),
                condition: safeText(rec.condition)
            }))
            .filter((change) => Number.isFinite(change.ms) && Number.isFinite(change.value))
            .sort((a, b) => a.ms - b.ms);
    }

    function analogIsOn(value) {
        return Number.isFinite(value) && value < ANALOG_OFF_FLOOR_MV;
    }

    function buildStepEpochs(run) {
        const info = protocolInfo(
            run.metadata,
            run.steps.map((step) => step.condition)
        );
        run.protocolInfo = info;
        for (const step of run.steps) {
            step.epochs = [];
            for (const interval of step.intervals) {
                const rate = finite(interval.params.frameRate);
                step.epochs.push({
                    type: 'visual',
                    label: Math.abs(rate) > 0 ? 'moving visual' : 'visual',
                    startMs: interval.startMs,
                    endMs: interval.endMs,
                    params: interval.params
                });
            }

            let currentValue = NaN;
            for (const change of run.analogChanges) {
                if (change.ms > step.startMs) break;
                currentValue = change.value;
            }
            const changes = run.analogChanges.filter(
                (change) => change.ms > step.startMs && change.ms <= step.endMs
            );
            let cursor = step.startMs;
            for (const change of changes) {
                if (analogIsOn(currentValue) && change.ms > cursor) {
                    step.epochs.push({
                        type: 'opto',
                        label: `${currentValue} mV`,
                        startMs: cursor,
                        endMs: change.ms,
                        value: currentValue
                    });
                }
                cursor = change.ms;
                currentValue = change.value;
            }
            if (analogIsOn(currentValue) && step.endMs > cursor) {
                step.epochs.push({
                    type: 'opto',
                    label: `${currentValue} mV`,
                    startMs: cursor,
                    endMs: step.endMs,
                    value: currentValue
                });
            }

            const stepAnalog = step.commands.filter((command) => command.op === 'setAnalogOut');
            if (info.family === 'p0' && stepAnalog.length >= 3) {
                const startMs = stepAnalog[1].ms;
                const endMs = stepAnalog[2].ms;
                const value = finite(stepAnalog[1].value);
                step.epochs.push({
                    type: analogIsOn(value) ? 'opto' : 'sham',
                    label: analogIsOn(value) ? `${value} mV` : 'sham',
                    startMs,
                    endMs,
                    value
                });
            }

            const moving = step.intervals.find(
                (interval) => Math.abs(finite(interval.params.frameRate)) > 0
            );
            const p0Epoch = step.epochs.find(
                (epoch) => epoch.type === 'opto' || epoch.type === 'sham'
            );
            step.alignMs =
                info.family === 'p0' && p0Epoch
                    ? p0Epoch.startMs
                    : moving
                      ? moving.startMs
                      : step.startMs;
            step.relStartSec = (step.startMs - step.alignMs) / 1000;
            step.relEndSec = (step.endMs - step.alignMs) / 1000;
        }
    }

    function summarizeSteps(run) {
        for (const step of run.steps) {
            const frames = run.framesByStep.get(step.index) || [];
            step.frameCount = frames.length;
            step.meanForward = mean(frames.map((frame) => frame.forwardMmSSmoothed));
            step.meanTurning = mean(frames.map((frame) => frame.turningDegSSmoothed));
            step.missingFrames = frames.reduce(
                (sum, frame) => sum + (frame.frameGap > 1 ? frame.frameGap - 1 : 0),
                0
            );
        }
    }

    function refreshSignals(run, options) {
        deriveSignals(run, options);
        summarizeSteps(run);
        run.totalMissingFrames = run.frames.reduce(
            (sum, frame) => sum + (frame.frameGap > 1 ? frame.frameGap - 1 : 0),
            0
        );
        return run;
    }

    function parseJsonl(text, sourceName, sourcePath, options) {
        const lines = safeText(text).split(/\r?\n/);
        const frames = [];
        const events = [];
        const parseErrors = [];
        let schema = [];
        let metadata = {};
        let sessionStartMs = NaN;

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index].trim();
            if (!line) continue;
            let rec;
            try {
                rec = JSON.parse(line);
            } catch (error) {
                parseErrors.push({ lineNumber: index + 1, message: error.message });
                continue;
            }
            if (Array.isArray(rec)) {
                const frame = parseFrameArray(rec, schema, index + 1);
                if (frame) frames.push(frame);
                continue;
            }
            if (!rec || typeof rec !== 'object') continue;
            events.push({ ...rec, lineNumber: index + 1 });
            if (rec.type === 'session' && rec.event === 'logging_started')
                sessionStartMs = finite(rec.ms);
            else if (rec.type === 'frame_schema' && Array.isArray(rec.cols))
                schema = rec.cols.map(String);
            else if (rec.event === 'run_metadata') metadata = { ...rec };
            else if (rec.type === 'fictrac_frame') {
                const frame = parseFicTracObject(rec, index + 1);
                if (frame) frames.push(frame);
            }
        }

        frames.sort((a, b) => a.ms - b.ms);
        const steps = extractSteps(events, sessionStartMs);
        const run = {
            id:
                safeText(metadata.run_id) ||
                parseFilename(sourceName).runId ||
                safeText(sourceName),
            sourceName: safeText(sourceName),
            sourcePath: safeText(sourcePath || sourceName),
            metadata,
            schema,
            frames,
            events,
            steps,
            parseErrors,
            sessionStartMs
        };
        deriveSignals(run, options);
        assignFramesToSteps(run);
        buildAnalogChanges(run);
        buildStepEpochs(run);
        summarizeSteps(run);
        run.descriptor = descriptorFromMetadata(metadata, sourceName, sourcePath);
        run.descriptor.protocolFamily = run.protocolInfo.family;
        run.descriptor.protocolLabel = run.protocolInfo.label;
        run.totalMissingFrames = frames.reduce(
            (sum, frame) => sum + (frame.frameGap > 1 ? frame.frameGap - 1 : 0),
            0
        );
        return run;
    }

    function nearestHeadingBaseline(frames, alignMs) {
        let best = NaN;
        let distance = Infinity;
        for (const frame of frames) {
            const current = Math.abs(frame.ms - alignMs);
            if (current < distance && Number.isFinite(frame.headingUnwrappedDeg)) {
                best = frame.headingUnwrappedDeg;
                distance = current;
            }
        }
        return best;
    }

    function metricValue(frame, metric, headingBaseline) {
        if (metric === 'turning') return frame.turningDegSSmoothed;
        if (metric === 'forward') return frame.forwardMmSSmoothed;
        if (metric === 'heading') return frame.headingUnwrappedDeg - headingBaseline;
        if (metric === 'displayIndex') return frame.index;
        return NaN;
    }

    function trialSeries(run, step, metric, options) {
        const opts = options || {};
        const frames = run.framesByStep.get(step.index) || [];
        const hz = finite(opts.hz) > 0 ? finite(opts.hz) : 10;
        const binWidth = 1 / hz;
        const headingBaseline = nearestHeadingBaseline(frames, step.alignMs);
        const bins = new Map();
        for (const frame of frames) {
            const x = (frame.ms - step.alignMs) / 1000;
            if (Number.isFinite(opts.startSec) && x < opts.startSec) continue;
            if (Number.isFinite(opts.endSec) && x > opts.endSec) continue;
            const y = metricValue(frame, metric, headingBaseline);
            if (!Number.isFinite(y)) continue;
            const key = Math.round(x / binWidth);
            const item = bins.get(key) || { xSum: 0, ySum: 0, count: 0 };
            item.xSum += x;
            item.ySum += y;
            item.count += 1;
            bins.set(key, item);
        }
        const rows = [...bins.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([key, item]) => ({
                x: key * binWidth,
                y: item.ySum / item.count
            }));
        return {
            runId: run.id,
            condition: step.condition,
            stepIndex: step.index,
            x: rows.map((row) => row.x),
            y: rows.map((row) => row.y),
            epochs: step.epochs.map((epoch) => ({
                ...epoch,
                startSec: (epoch.startMs - step.alignMs) / 1000,
                endSec: (epoch.endMs - step.alignMs) / 1000
            }))
        };
    }

    function averageCurves(curves) {
        const byX = new Map();
        for (const curve of curves) {
            for (let i = 0; i < curve.x.length; i += 1) {
                const key = Math.round(curve.x[i] * 1000) / 1000;
                if (!byX.has(key)) byX.set(key, []);
                byX.get(key).push(curve.y[i]);
            }
        }
        const x = [...byX.keys()].sort((a, b) => a - b);
        return {
            x,
            y: x.map((key) => mean(byX.get(key))),
            sem: x.map((key) => sem(byX.get(key))),
            n: x.map((key) => byX.get(key).filter(Number.isFinite).length)
        };
    }

    function stepMean(run, step, metric, startSec, endSec) {
        const series = trialSeries(run, step, metric, { hz: 20, startSec, endSec });
        return mean(series.y);
    }

    function choiceInfo(condition) {
        const match = safeText(condition).match(/^(?:burst_)?ab_([^_]+)_(l|r)$/);
        return match ? { object: match[1], side: match[2] } : null;
    }

    function p3Phase(condition) {
        const match = safeText(condition).match(
            /^(baseline|training|probe)_(?:phase(?:0|90)|[ab])$/
        );
        return match ? match[1] : '';
    }

    function p3TrialVariant(condition) {
        const match = safeText(condition).match(
            /^(?:baseline|training|probe)_(phase(?:0|90)|[ab])$/
        );
        return match ? match[1] : '';
    }

    function p3UsesCueNormalization(run) {
        return !!(run && run.protocolInfo && run.protocolInfo.p3Legacy === false);
    }

    function p3CueIndex(run, condition, index) {
        const raw = mod(Math.round(finite(index)), 200);
        if (!p3UsesCueNormalization(run)) return raw;
        return p3TrialVariant(condition) === 'phase90' ? mod(raw + 50, 200) : raw;
    }

    function p3LoggedLedActivation(run, requestedStep) {
        const steps = requestedStep ? [requestedStep] : run.steps || [];
        for (const step of steps) {
            if (p3Phase(step.condition) !== 'training') continue;
            for (const interval of step.intervals || []) {
                const activation = interval.ledActivation;
                const ranges = activation && activation.on_ranges;
                if (!Array.isArray(ranges) || !ranges.length) continue;
                return {
                    level: finite(activation.level),
                    hysteresis: finite(activation.hysteresis),
                    ranges: ranges
                        .filter(
                            (range) =>
                                Array.isArray(range) &&
                                range.length >= 2 &&
                                Number.isFinite(finite(range[0])) &&
                                Number.isFinite(finite(range[1]))
                        )
                        .map((range) => [finite(range[0]), finite(range[1])]),
                    condition: step.condition,
                    variant: p3TrialVariant(step.condition)
                };
            }
        }
        return {
            level: NaN,
            hysteresis: NaN,
            ranges: [],
            condition: requestedStep ? requestedStep.condition : '',
            variant: requestedStep ? p3TrialVariant(requestedStep.condition) : ''
        };
    }

    function p3LoggedLedActivations(run) {
        const unique = new Map();
        for (const step of run.steps || []) {
            const activation = p3LoggedLedActivation(run, step);
            if (!activation.ranges.length) continue;
            const key = JSON.stringify([
                activation.variant,
                activation.level,
                activation.hysteresis,
                activation.ranges
            ]);
            if (!unique.has(key)) unique.set(key, activation);
        }
        return [...unique.values()];
    }

    function p3Reinforcement(run, step) {
        const logged = p3LoggedLedActivation(run, step);
        if (logged.ranges.length) return logged;
        const anyLogged = p3LoggedLedActivation(run);
        if (anyLogged.ranges.length) return anyLogged;
        return {
            level: NaN,
            hysteresis: NaN,
            ranges: [[0, 49], [100, 149]],
            condition: '',
            variant: ''
        };
    }

    function p3AnalysisRanges(run) {
        return p3UsesCueNormalization(run)
            ? [[0, 49], [100, 149]]
            : p3Reinforcement(run).ranges;
    }

    function p3LedEpochs(run) {
        const trainingSteps = (run.steps || []).filter(
            (step) => p3Phase(step.condition) === 'training'
        );
        const trainingStart = Math.min(
            ...trainingSteps.map((step) => step.startMs).filter(Number.isFinite)
        );
        const trainingEnd = Math.max(
            ...trainingSteps.map((step) => step.endMs).filter(Number.isFinite)
        );
        const changes = (run.events || [])
            .flatMap((rec) => {
                if (rec.event !== 'runner') return [];
                const ms = relativeEventMs(rec, run.sessionStartMs);
                if (!Number.isFinite(ms)) return [];
                if (rec.phase === 'led-activation') {
                    return [
                        {
                            ms,
                            on: rec.on === true,
                            level: rec.on === true ? finite(rec.ledPercent) : 0
                        }
                    ];
                }
                if (
                    rec.phase === 'command' &&
                    (rec.op === 'setAnalogOut' || rec.command_name === 'setAnalogOut') &&
                    finite(rec.ledPercent) === 0
                ) {
                    return [{ ms, on: false, level: 0 }];
                }
                return [];
            })
            .sort((a, b) => a.ms - b.ms);
        const epochs = [];
        let active = null;
        for (const change of changes) {
            if (change.on && !active) {
                active = { startMs: change.ms, level: change.level };
            } else if (!change.on && active) {
                if (change.ms > active.startMs)
                    epochs.push({ ...active, endMs: change.ms });
                active = null;
            }
        }
        if (active) {
            if (trainingEnd > active.startMs) epochs.push({ ...active, endMs: trainingEnd });
        }
        return epochs
            .map((epoch) => ({
                ...epoch,
                startMs: Math.max(trainingStart, epoch.startMs),
                endMs: Math.min(trainingEnd, epoch.endMs)
            }))
            .filter((epoch) => epoch.endMs > epoch.startMs);
    }

    function p3TrialFrames(run, step, dropSec) {
        const phase = p3Phase(step && step.condition);
        if (!phase) return [];
        const startMs = step.startMs + Math.max(0, finite(dropSec) || 0) * 1000;
        return (run.framesByStep.get(step.index) || [])
            .filter((frame) => frame.ms >= startMs && Number.isFinite(frame.index));
    }

    function p3TrialIndices(run, step, dropSec) {
        return p3TrialFrames(run, step, dropSec).map((frame) =>
            p3CueIndex(run, step.condition, frame.index)
        );
    }

    function p3IndexIsReinforced(index, ranges) {
        return ranges.some(([start, end]) => index >= start && index <= end);
    }

    function p3TrialAngles(run, step, dropSec) {
        return p3TrialIndices(run, step, dropSec).map((index) =>
            wrapDeg(((index - 25) * 360) / 200)
        );
    }

    function p3PreferenceIndex(run, step, dropSec) {
        const indices = p3TrialIndices(run, step, dropSec);
        const analysisRanges = p3AnalysisRanges(run);
        const loggedActivation = p3LoggedLedActivation(run, step);
        if (!indices.length) {
            return {
                phase: p3Phase(step && step.condition),
                preference: NaN,
                safeFraction: NaN,
                reinforcedFraction: NaN,
                samples: 0,
                analysisRanges,
                loggedActivation
            };
        }
        const reinforced = indices.filter((index) =>
            p3IndexIsReinforced(index, analysisRanges)
        ).length;
        const safe = indices.length - reinforced;
        return {
            phase: p3Phase(step.condition),
            preference: (safe - reinforced) / indices.length,
            safeFraction: safe / indices.length,
            reinforcedFraction: reinforced / indices.length,
            samples: indices.length,
            analysisRanges,
            loggedActivation
        };
    }

    function p3TrialDoseMetrics(run, step) {
        const indices = p3TrialIndices(run, step, 0);
        const analysisRanges = p3AnalysisRanges(run);
        const loggedActivation = p3LoggedLedActivation(run, step);
        let sectorEntries = 0;
        let previousReinforced = null;
        for (const index of indices) {
            const reinforced = p3IndexIsReinforced(index, analysisRanges);
            if (previousReinforced === false && reinforced) sectorEntries += 1;
            previousReinforced = reinforced;
        }
        const durationMs = Math.max(0, step.endMs - step.startMs);
        const ledOnMs = p3LedEpochs(run).reduce(
            (sum, epoch) =>
                sum +
                Math.max(
                    0,
                    Math.min(step.endMs, epoch.endMs) - Math.max(step.startMs, epoch.startMs)
                ),
            0
        );
        return {
            phase: p3Phase(step.condition),
            ledOnFraction: durationMs ? ledOnMs / durationMs : NaN,
            ledOnSec: ledOnMs / 1000,
            sectorEntries,
            samples: indices.length,
            analysisRanges,
            loggedActivation
        };
    }

    function p3DwellBouts(run, step) {
        const frames = p3TrialFrames(run, step, 0);
        if (!frames.length) return [];
        const analysisRanges = p3AnalysisRanges(run);
        const bouts = [];
        let startMs = frames[0].ms;
        let reinforced = p3IndexIsReinforced(
            p3CueIndex(run, step.condition, frames[0].index),
            analysisRanges
        );
        for (let index = 1; index < frames.length; index += 1) {
            const nextReinforced = p3IndexIsReinforced(
                p3CueIndex(run, step.condition, frames[index].index),
                analysisRanges
            );
            if (nextReinforced === reinforced) continue;
            bouts.push({
                sector: reinforced ? 'reinforced' : 'safe',
                startMs,
                endMs: frames[index].ms,
                durationSec: Math.max(0, (frames[index].ms - startMs) / 1000)
            });
            startMs = frames[index].ms;
            reinforced = nextReinforced;
        }
        const endMs = Math.max(startMs, Math.min(step.endMs, frames[frames.length - 1].ms));
        bouts.push({
            sector: reinforced ? 'reinforced' : 'safe',
            startMs,
            endMs,
            durationSec: Math.max(0, (endMs - startMs) / 1000)
        });
        return bouts.filter((bout) => bout.durationSec > 0);
    }

    function p3TrialQualityMetrics(run, step, movementThresholdMmS) {
        const frames = p3TrialFrames(run, step, 0);
        const threshold = Number.isFinite(finite(movementThresholdMmS))
            ? Math.max(0, finite(movementThresholdMmS))
            : 1;
        const angles = p3TrialAngles(run, step, 0);
        const doubledRadians = angles.map((angle) => (angle * Math.PI) / 90);
        const meanCos = mean(doubledRadians.map(Math.cos));
        const meanSin = mean(doubledRadians.map(Math.sin));
        const speeds = frames.map((frame) => frame.speedMmS).filter(Number.isFinite);
        const turning = frames.map((frame) => frame.turningDegS).filter(Number.isFinite);
        const skippedFrames = frames.reduce(
            (sum, frame) => sum + (frame.frameGap > 1 ? frame.frameGap - 1 : 0),
            0
        );
        return {
            phase: p3Phase(step && step.condition),
            variant: p3TrialVariant(step && step.condition),
            cueStabilizationStrength:
                Number.isFinite(meanCos) && Number.isFinite(meanSin)
                    ? Math.sqrt(meanCos ** 2 + meanSin ** 2)
                    : NaN,
            movementThresholdMmS: threshold,
            movementFraction: speeds.length
                ? speeds.filter((speed) => speed > threshold).length / speeds.length
                : NaN,
            meanSpeedMmS: mean(speeds),
            meanAbsTurningDegS: mean(turning.map(Math.abs)),
            skippedFrames,
            skippedFrameFraction: frames.length
                ? skippedFrames / (frames.length + skippedFrames)
                : NaN,
            samples: frames.length
        };
    }

    function choiceAngles(run, step, dropSec) {
        const info = choiceInfo(step.condition);
        if (!info) return [];
        const front = info.side === 'l' ? 75 : 25;
        const startMs = step.startMs + (Number.isFinite(dropSec) ? dropSec : 2) * 1000;
        return (run.framesByStep.get(step.index) || [])
            .filter((frame) => frame.ms >= startMs && Number.isFinite(frame.index))
            .map((frame) => wrapDeg(((mod(frame.index, 200) - front) * 360) / 200));
    }

    function occupancyHistogram(angles, binCount) {
        const count = binCount || 100;
        const bins = new Array(count).fill(0);
        for (const angle of angles) {
            const bin = Math.max(
                0,
                Math.min(count - 1, Math.floor((mod(angle + 180, 360) / 360) * count))
            );
            bins[bin] += 1;
        }
        const total = bins.reduce((sum, value) => sum + value, 0);
        return {
            angle: bins.map((_, index) => -180 + ((index + 0.5) * 360) / count),
            percent: bins.map((value) => (total ? (value / total) * 100 : 0)),
            samples: total
        };
    }

    function circularBoxcar(values, windowBins) {
        const width = Math.max(1, Math.round(finite(windowBins)) || 1);
        if (!values.length || width === 1) return values.slice();
        const left = Math.floor((width - 1) / 2);
        const right = width - left - 1;
        return values.map((_, index) => {
            const samples = [];
            for (let offset = -left; offset <= right; offset += 1)
                samples.push(values[mod(index + offset, values.length)]);
            return mean(samples);
        });
    }

    function preferenceMetrics(angles) {
        if (!angles.length) return { harmonic: NaN, quadrant: NaN };
        const harmonic = mean(angles.map((angle) => Math.cos((2 * angle * Math.PI) / 180)));
        const front = angles.filter((angle) => Math.abs(angle) < 45).length / angles.length;
        const outside = angles.filter((angle) => Math.abs(angle) > 45).length / angles.length;
        return { harmonic, quadrant: front - outside };
    }

    function metricLabel(metric) {
        if (metric === 'turning') return 'Turning velocity (deg/s)';
        if (metric === 'forward') return 'Forward velocity (mm/s)';
        if (metric === 'heading') return 'Relative heading (deg)';
        if (metric === 'displayIndex') return 'Arena frame index';
        return metric;
    }

    const DashboardAnalysis = {
        DEFAULT_BALL_DIAMETER_MM,
        DEFAULT_SMOOTH_WINDOW_S,
        safeText,
        finite,
        mean,
        sem,
        median,
        mod,
        wrapDeg,
        parseFilename,
        parseMetadataPrefix,
        descriptorFromMetadata,
        protocolInfo,
        parseJsonl,
        deriveSignals,
        refreshSignals,
        trialSeries,
        averageCurves,
        stepMean,
        choiceInfo,
        p3Phase,
        p3TrialVariant,
        p3UsesCueNormalization,
        p3CueIndex,
        p3LoggedLedActivation,
        p3LoggedLedActivations,
        p3Reinforcement,
        p3AnalysisRanges,
        p3LedEpochs,
        p3TrialIndices,
        p3TrialAngles,
        p3PreferenceIndex,
        p3TrialDoseMetrics,
        p3DwellBouts,
        p3TrialQualityMetrics,
        choiceAngles,
        occupancyHistogram,
        circularBoxcar,
        preferenceMetrics,
        metricLabel
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = DashboardAnalysis;
    global.DashboardAnalysis = DashboardAnalysis;
})(typeof window !== 'undefined' ? window : globalThis);
