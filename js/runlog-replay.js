/**
 * runlog-replay.js — turn a recorded arena run-log (NDJSON) into a replayable
 * timeline: behavior_v1 SAMPLES (for the scope / offline analysis dashboard),
 * run-status EVENTS reshaped into the LIVE shape the scope's overlay code expects,
 * and the frame-position commands needed by the replay arena viewer.
 *
 * WHY THIS EXISTS
 *   The live scope is fed by two streams that don't exist for a recorded run:
 *     - the FicTrac bridge's behavior_v1 samples (Scope.pushSample), and
 *     - the runner's run-status events (Scope.onRunStatus) that draw the trial
 *       boundaries / visual spans / LED band.
 *   A run-log has BOTH, but in on-disk form: full-log frames carry the raw 25-col
 *   FicTrac record, and runner events are SANITIZED (js/arena-session.js
 *   _sanitizeRunStatus) — e.g. `step.conditionName` is flattened to `condition`.
 *   This module reverses both so a log can be streamed back through the exact same
 *   scope code, and so the offline dashboard derives channels the same way as live.
 *
 * SHARED CONTRACT (keep in sync with fictrac-bridge/bridge.py + js/kinematics.js)
 *   - behavior_v1 sample = {ms, ft, x, y, hd, idx, fc}. `ft` is MILLISECONDS.
 *   - FicTrac col-22 is the camera hardware clock in NANOSECONDS on our rigs, so
 *     full-log frames divide col-22 by FT_TS_NS_PER_MS to get `ft` in ms (exactly
 *     what the bridge does live). behavior_v1 log rows already carry ms.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES
 * `export`) — same pattern as kinematics.js, so it loads under Node for tests and
 * in the browser for the scope replay / dashboard.
 */
(function (global) {
    'use strict';

    // Keep in sync with fictrac-bridge/bridge.py FT_TS_NS_PER_MS.
    const FT_TS_NS_PER_MS = 1e6;
    // FicTrac 0-based column indices used by behavior_v1.
    const COL_FC = 0; // col 1  frame counter
    const COL_X = 14; // col 15 integrated x (rad)
    const COL_Y = 15; // col 16 integrated y (rad)
    const COL_HD = 16; // col 17 integrated heading (rad)
    const COL_TS = 21; // col 22 timestamp (camera hardware clock; ns on our rigs)

    /**
     * Reshape ONE sanitized run-log runner event into the live run-status object
     * the scope's onRunStatus consumes ({phase, index?, op?, value?, step?}).
     * Returns null for events with no phase.
     *
     * Two log vintages are normalized to the CURRENT runner shape:
     *  - `condition` (flattened by _sanitizeRunStatus) → `step.conditionName`,
     *    while retaining the flattened field for replay inspectors.
     *  - v0.5's `phase:"trial-running"` (+ durationSec) → the current
     *    `phase:"command", op:"trialParams", value:durationSec`, so the scope draws
     *    the visual (green) span identically for old and new logs. Modern fields
     *    (`params`, `durationSec`, `ledActivation`) still ride on that status.
     */
    function adaptRunnerEvent(ev) {
        if (!ev || typeof ev !== 'object' || !ev.phase) return null;
        const cond =
            ev.condition != null
                ? ev.condition
                : ev.conditionName != null
                  ? ev.conditionName
                  : ev.step && ev.step.conditionName != null
                    ? ev.step.conditionName
                    : null;
        const s = {
            phase: ev.phase === 'trial-running' ? 'command' : ev.phase
        };

        // These are the JSON-safe fields emitted by ArenaSession._sanitizeRunStatus,
        // plus summary (canonical runlog.json). Copying them here is deliberate:
        // replay must be a lossless view of the current runner, not only enough data
        // for the legacy oscilloscope overlay.
        const fields = [
            'index',
            'total',
            'op',
            'value',
            'reason',
            'message',
            'level',
            'durationSec',
            'conditionName',
            'on',
            'ledPercent',
            'ledActivation',
            'params',
            'status',
            'ok',
            'error',
            'summary',
            'runtimeControlApply',
            'runtimeRecord'
        ];
        for (const k of fields) if (ev[k] !== undefined) s[k] = ev[k];

        if (ev.phase === 'trial-running') {
            s.op = 'trialParams';
            if (ev.durationSec != null) s.value = ev.durationSec;
        }
        if (cond != null) {
            s.condition = cond;
            s.step = Object.assign({}, ev.step || {}, { conditionName: cond });
        } else if (ev.step && typeof ev.step === 'object') {
            s.step = Object.assign({}, ev.step);
        }
        return s;
    }

    // Bridge wall-clock ms for a line: frames carry `t`, runner events `rx_ms`,
    // session lines `ms`. All are the bridge's now_ms() on one clock.
    function _wallMs(o) {
        if (typeof o.t === 'number') return o.t;
        if (typeof o.rx_ms === 'number') return o.rx_ms;
        if (typeof o.ms === 'number') return o.ms;
        return null;
    }

    // Explicit replay-relative timestamps win over wall-clock rebasing. Canonical
    // runlog.json uses t_offset_s; a few development fixtures use the *_ms aliases.
    function _explicitReplayMs(o) {
        if (!o || typeof o !== 'object') return null;
        for (const k of ['replay_ms', 't_offset_ms', 'offset_ms', 'elapsed_ms']) {
            if (typeof o[k] === 'number' && Number.isFinite(o[k])) return o[k];
        }
        if (typeof o.t_offset_s === 'number' && Number.isFinite(o.t_offset_s)) {
            return o.t_offset_s * 1000;
        }
        return null;
    }

    function _recordReplayMs(o, wallStartMs, isoStartMs, fallbackMs) {
        const explicit = _explicitReplayMs(o);
        if (explicit !== null) return explicit;
        const wall = _wallMs(o);
        if (wall !== null) {
            // `ms` is sometimes an explicit relative clock in self-authored fixtures.
            // Treat it as relative when the origin is clearly epoch-like and it is not.
            if (o.t == null && o.rx_ms == null && wallStartMs > 1e10 && wall < 1e10) return wall;
            return wallStartMs !== null ? wall - wallStartMs : wall;
        }
        if (o.t_iso && isoStartMs !== null) {
            const parsed = Date.parse(o.t_iso);
            if (Number.isFinite(parsed)) return parsed - isoStartMs;
        }
        return fallbackMs == null ? 0 : fallbackMs;
    }

    function _isMetadataRecord(o) {
        return !!(
            o &&
            typeof o === 'object' &&
            (o.type === 'run_metadata' || o.event === 'run_metadata')
        );
    }

    function _cleanMetadata(o) {
        const out = {};
        if (!o || typeof o !== 'object') return out;
        for (const k of Object.keys(o)) {
            if (k === 'type' || k === 'event' || k === 'dir' || k === 'rx_ms') continue;
            out[k] = o[k];
        }
        return out;
    }

    function _protocolSha(metadata) {
        if (!metadata || typeof metadata !== 'object') return null;
        return (
            metadata.protocol_sha256 ||
            metadata.protocol_sha ||
            metadata.sha256 ||
            metadata.yaml_sha256 ||
            null
        );
    }

    // arena_command.head is the first bytes of the request, e.g. "03 70 0a 00"
    // for SET_FRAME_POSITION(10). Return null for failed/non-frame commands.
    function decodeFramePosition(o) {
        if (!o || typeof o !== 'object' || o.event !== 'arena_command') return null;
        if (o.error || o.ok === false) return null;
        for (const k of ['frame_position', 'framePosition', 'frame_index']) {
            if (Number.isInteger(o[k]) && o[k] >= 0) return o[k];
        }
        if (typeof o.head !== 'string') return null;
        const bytes = o.head
            .trim()
            .split(/\s+/)
            .filter((token) => /^[0-9a-f]{2}$/i.test(token))
            .map((token) => parseInt(token, 16));
        let opAt = -1;
        if (bytes.length >= 4 && bytes[1] === 0x70)
            opAt = 1; // normal [len,op,lo,hi]
        else if (bytes.length >= 3 && bytes[0] === 0x70) opAt = 0; // unframed fixture
        if (opAt < 0 || bytes.length <= opAt + 2) return null;
        return bytes[opAt + 1] | (bytes[opAt + 2] << 8);
    }

    function _readInput(text) {
        const src = String(text == null ? '' : text).trim();
        if (!src) return { records: [], canonical: null };

        // A canonical Arena Studio runlog is one JSON object, often pretty-printed.
        // Try it whole before falling back to JSONL line parsing.
        try {
            const value = JSON.parse(src);
            if (value && !Array.isArray(value) && Array.isArray(value.events)) {
                return { records: value.events.slice(), canonical: value };
            }
            if (Array.isArray(value)) {
                // A single behavior_v1 positional row is also a valid JSON array.
                if (!value.length || typeof value[0] === 'number') {
                    return { records: [value], canonical: null };
                }
                return { records: value.slice(), canonical: null };
            }
            return { records: [value], canonical: null };
        } catch (_) {
            // Expected for NDJSON: parse each independent record below.
        }

        const records = [];
        for (const line of src.split('\n')) {
            const ln = line.trim();
            if (!ln) continue;
            try {
                records.push(JSON.parse(ln));
            } catch (_) {
                // Tolerate a torn final line / stray text.
            }
        }
        return { records: records, canonical: null };
    }

    function _wallOrigin(records, metadata, canonical) {
        // The bridge's logging_started marker is aligned with behavior_v1 ms=0.
        for (const o of records) {
            if (
                o &&
                !Array.isArray(o) &&
                o.type === 'session' &&
                o.event === 'logging_started' &&
                typeof o.ms === 'number'
            ) {
                return o.ms;
            }
        }
        if (metadata && typeof metadata.t0_ms === 'number') return metadata.t0_ms;
        const iso =
            metadata && metadata.timestamp_start ? Date.parse(metadata.timestamp_start) : NaN;
        if (Number.isFinite(iso) && canonical) return iso;
        for (const o of records) {
            if (!o || Array.isArray(o)) continue;
            const wall = _wallMs(o);
            if (wall !== null) return wall;
        }
        return null;
    }

    /**
     * Parse a whole run-log into replay data.
     *   samples: [{ms, ft, x, y, hd, idx, fc}]  (ms = display axis; ft = ms, velocity base)
     *   events:  [{ms, status}]                  (status = live run-status shape)
     *   arenaFrames: [{ms,index,source}]         (decoded SET_FRAME_POSITION commands)
     *   metadata / protocolSha256                (run provenance from run_metadata)
     * `ms` on both is bridge-relative (subtracting the first wall-clock seen), so
     * all replay streams share one explicit, seekable axis. Canonical runlog.json
     * objects are accepted too (they contain events/metadata but no frame samples).
     * @param {string} text  NDJSON run-log
     * @param {object} [opts] {tsNsPerMs} override the col-22 unit (default ns)
     */
    function parseRunLog(text, opts) {
        opts = opts || {};
        const nsPerMs = opts.tsNsPerMs > 0 ? opts.tsNsPerMs : FT_TS_NS_PER_MS;
        const input = _readInput(text);
        const records = input.records;
        const canonical = input.canonical;
        const samples = [];
        const events = [];
        const arenaFrames = [];
        let metadata = Object.assign({}, (canonical && canonical.meta) || {});
        for (const o of records) {
            if (_isMetadataRecord(o)) metadata = Object.assign(metadata, _cleanMetadata(o));
        }
        const wallStartMs = _wallOrigin(records, metadata, canonical);
        const isoStartParsed = metadata.timestamp_start
            ? Date.parse(metadata.timestamp_start)
            : NaN;
        const isoStartMs = Number.isFinite(isoStartParsed) ? isoStartParsed : wallStartMs;
        let ft0 = null; // first col-22 value (native units)
        let sawBehaviorV1 = false;
        let frameCols = null;
        let frameLevel = null;
        let fallbackMs = 0;

        for (const o of records) {
            // behavior_v1 positional row: [ms, fc, idx, ft, x, y, hd] (ft already ms)
            if (Array.isArray(o)) {
                sawBehaviorV1 = true;
                const col = (name, fallback) => {
                    const at = frameCols ? frameCols.indexOf(name) : fallback;
                    return at >= 0 ? o[at] : undefined;
                };
                const sample = {
                    ms: col('ms', 0),
                    ft: col('ft', 3),
                    x: col('x', 4),
                    y: col('y', 5),
                    hd: col('hd', 6),
                    idx: col('idx', 2),
                    fc: col('fc', 1)
                };
                if (typeof sample.ms !== 'number') sample.ms = fallbackMs;
                fallbackMs = Math.max(fallbackMs, sample.ms);
                samples.push(sample);
                continue;
            }
            if (!o || typeof o !== 'object') continue;
            if (o.type === 'frame_schema') {
                sawBehaviorV1 = true;
                frameCols = Array.isArray(o.cols) ? o.cols.slice() : null;
                frameLevel = o.level || 'behavior_v1';
                continue;
            }

            // full-log frame: raw 25-col FicTrac record under `fictrac`.
            if (o.type === 'fictrac_frame' && Array.isArray(o.fictrac)) {
                const f = o.fictrac;
                const col22 = f[COL_TS];
                if (ft0 === null && typeof col22 === 'number') ft0 = col22;
                const frameFallbackMs = samples.length
                    ? samples[samples.length - 1].ms + 8
                    : fallbackMs;
                const replayMs = _recordReplayMs(o, wallStartMs, isoStartMs, frameFallbackMs);
                samples.push({
                    ms: replayMs,
                    ft: typeof col22 === 'number' && ft0 !== null ? (col22 - ft0) / nsPerMs : null,
                    x: f[COL_X],
                    y: f[COL_Y],
                    hd: f[COL_HD],
                    idx: o.index,
                    fc: typeof f[COL_FC] === 'number' ? Math.round(f[COL_FC]) : o.seq
                });
                fallbackMs = Math.max(fallbackMs, replayMs);
                continue;
            }

            // runner run-status event.
            if (o.event === 'runner' || o.type === 'runner' || (canonical && o.phase)) {
                const status = adaptRunnerEvent(o);
                if (status) {
                    const replayMs = _recordReplayMs(o, wallStartMs, isoStartMs, fallbackMs);
                    events.push({
                        ms: replayMs,
                        status: status
                    });
                    fallbackMs = Math.max(fallbackMs, replayMs);
                }
                continue;
            }

            // Raw command records complement behavior samples for open-loop logs and
            // make the 3-D viewer faithful even when kinematic frame rows are absent.
            if (o.event === 'arena_command') {
                const index = decodeFramePosition(o);
                if (index !== null) {
                    const replayMs = _recordReplayMs(o, wallStartMs, isoStartMs, fallbackMs);
                    arenaFrames.push({ ms: replayMs, index: index, source: 'arena_command' });
                    fallbackMs = Math.max(fallbackMs, replayMs);
                }
            }
        }

        // Do not spread/apply the timestamps into Math.min/Math.max. A normal
        // full course run can contain >250,000 frame rows, which exceeds the
        // browser's function-argument limit and throws "Maximum call stack size
        // exceeded". Scan once with constant stack and without allocating a
        // second full-size timestamp array.
        let startMs = Infinity;
        let endMs = -Infinity;
        const includeReplayTime = (value) => {
            if (!Number.isFinite(value)) return;
            if (value < startMs) startMs = value;
            if (value > endMs) endMs = value;
        };
        for (const s of samples) includeReplayTime(s.ms);
        for (const e of events) includeReplayTime(e.ms);
        for (const f of arenaFrames) includeReplayTime(f.ms);
        if (startMs === Infinity) {
            startMs = 0;
            endMs = 0;
        }
        const protocolSha256 = _protocolSha(metadata);
        const format = canonical ? 'runlog' : sawBehaviorV1 ? frameLevel || 'behavior_v1' : 'full';
        return {
            samples: samples,
            events: events,
            arenaFrames: arenaFrames,
            framePositions: arenaFrames,
            metadata: metadata,
            meta: metadata,
            protocolSha256: protocolSha256,
            protocolSha: protocolSha256,
            summary: canonical ? canonical.summary || null : null,
            format: format,
            wallStartMs: wallStartMs,
            startMs: startMs,
            endMs: endMs,
            durationMs: Math.max(0, endMs - startMs)
        };
    }

    /**
     * Merge samples + events into ONE time-ordered replay timeline:
     *   [{ms, kind:'sample', sample} | {ms, kind:'status', status} |
     *    {ms, kind:'frame', index, frame}]
     * A driver walks this in order, calling Scope.pushSample / Scope.onRunStatus,
     * so an overlay event is stamped right after the sample at its own `ms`.
     * Events sort before samples at an equal ms (a boundary belongs at the frame).
     */
    function buildTimeline(parsed, opts) {
        opts = opts || {};
        const items = [];
        let order = 0;
        (parsed.samples || []).forEach((s) =>
            items.push({ ms: s.ms, kind: 'sample', sample: s, _order: order++ })
        );
        (parsed.events || []).forEach((e) =>
            items.push({ ms: e.ms, kind: 'status', status: e.status, _order: order++ })
        );
        if (opts.includeFrames !== false) {
            (parsed.arenaFrames || parsed.framePositions || []).forEach((f) =>
                items.push({ ms: f.ms, kind: 'frame', index: f.index, frame: f, _order: order++ })
            );
        }
        const priority = { status: 0, frame: 1, sample: 2 };
        items.sort(
            (a, b) =>
                a.ms - b.ms ||
                (priority[a.kind] == null ? 9 : priority[a.kind]) -
                    (priority[b.kind] == null ? 9 : priority[b.kind]) ||
                a._order - b._order
        );
        for (const item of items) delete item._order;

        // Named array properties are intentionally non-structural: existing callers
        // can keep treating the return value as an Array, while a replay controller
        // gets slider bounds without rescanning it.
        const startMs = items.length ? items[0].ms : 0;
        const endMs = items.length ? items[items.length - 1].ms : 0;
        Object.defineProperties(items, {
            startMs: { value: startMs, enumerable: false },
            endMs: { value: endMs, enumerable: false },
            durationMs: { value: Math.max(0, endMs - startMs), enumerable: false }
        });
        return items;
    }

    /** Return the first timeline index whose timestamp is >= targetMs. */
    function seekIndex(timeline, targetMs) {
        const t = Number.isFinite(Number(targetMs)) ? Number(targetMs) : 0;
        let lo = 0;
        let hi = timeline ? timeline.length : 0;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (timeline[mid].ms < t) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    const RunlogReplay = {
        FT_TS_NS_PER_MS,
        adaptRunnerEvent,
        decodeFramePosition,
        parseRunLog,
        buildTimeline,
        seekIndex
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = RunlogReplay;
    }
    if (typeof global !== 'undefined') {
        global.RunlogReplay = RunlogReplay;
    }
})(typeof window !== 'undefined' ? window : this);
