/**
 * runlog-format.js — ONE place that knows how a run-log FILE is encoded, shared by
 * every reader: the analysis dashboard (dashboard/data-browser, via an exact
 * vendored copy), the replay parser (js/runlog-replay.js) and the Alt Studio
 * replay picker (js/arena-studio-alt.js). Plan: docs/development/runlog-behavior-v2-plan.md.
 *
 * Two orthogonal encodings, both lossless:
 *   1. gzip — since Studio v0.72 run logs are committed as `<name>.jsonl.gz`.
 *      Detect by the magic bytes (1f 8b), never by name alone: `inflateIfGzip`,
 *      `readRunlogText` (any of string / bytes / ArrayBuffer / Blob|File → text),
 *      `readRunlogPrefixText` (a truncated prefix of a .gz still inflates to the
 *      run_metadata line near the top — the catalog reads 64 KB prefixes).
 *   2. line format — `behavior_v1` (pre-2026-09) vs `behavior_v2` (bridge ≥ 3.0):
 *      identical frame arrays [ms,fc,idx,ft,x,y,hd]; v2 writes each browser
 *      `arena_command` echo as the compact array
 *        ["a", t_off, dt, hex, status, rx_off(, error)]
 *      with ms offsets from the v2 frame_schema line's `t0`. `expandV2Line`
 *      rebuilds the EXACT v1 object (key order type,event,t,dt,len,head,status,
 *      echo,ok,error,dir,rx_ms) so every existing consumer keeps working; readers
 *      call `createNormalizer()` and pass each parsed line through `normalize()`.
 *      Timeout rule (verified on the course corpus, bridge.py mirrors it): when
 *      `status` is null then `echo` and `ok` are null too — NOT false.
 *      A v2 file may still carry a verbatim v1 `arena_command` object (an echo the
 *      bridge could not compact, e.g. a bulk command with a truncated ` …` head)
 *      and a converted legacy file may carry `"cols": null` in its schema.
 *
 * `compactV1Line` / `convertV1ToV2Text` / `convertV2ToV1Text` are the JS mirror of
 * the bridge's converter — used by the tests and the corpus parity script so the
 * readers can be exercised on v2 data generated from every existing v1 log.
 *
 * LOADING: classic <script src> (window-global `RunlogFormat` + CommonJS), no ES
 * `export` — same rule as arena-session.js (see CLAUDE.md). Load it BEFORE
 * js/runlog-replay.js. The dashboard's copy at dashboard/data-browser/vendor/ must
 * stay byte-identical (tests/test-runlog-format.js enforces it).
 */
(function (global) {
    'use strict';

    const GZIP_MAGIC_0 = 0x1f;
    const GZIP_MAGIC_1 = 0x8b;
    const ARENA_TAG = 'a';
    const ARENA_DIR = 'browser→bridge';
    const BEHAVIOR_V2_ARENA_COLS = ['t_off', 'dt', 'hex', 'status', 'rx_off'];
    const ARENA_COMMAND_KEYS = [
        'type',
        'event',
        't',
        'dt',
        'len',
        'head',
        'status',
        'echo',
        'ok',
        'error',
        'dir',
        'rx_ms'
    ];
    const RUNLOG_NAME_RE = /\.(jsonl|ndjson|json)(\.gz)?$/i;

    // ── bytes / gzip ────────────────────────────────────────────────────────────
    function toBytes(input) {
        if (input instanceof Uint8Array) return input;
        if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer)
            return new Uint8Array(input);
        if (input && ArrayBuffer.isView && ArrayBuffer.isView(input))
            return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        if (typeof input === 'string') return new TextEncoder().encode(input);
        throw new Error(
            'RunlogFormat: cannot read bytes from ' + Object.prototype.toString.call(input)
        );
    }

    function isGzip(bytes) {
        let u8;
        try {
            u8 = toBytes(bytes);
        } catch (_) {
            return false;
        }
        return u8.length >= 2 && u8[0] === GZIP_MAGIC_0 && u8[1] === GZIP_MAGIC_1;
    }

    function isRunlogName(name) {
        return RUNLOG_NAME_RE.test(String(name || ''));
    }

    /** `run.jsonl.gz` → `run.jsonl` (filename parsers key on the .jsonl stem). */
    function stripGz(name) {
        return String(name || '').replace(/\.gz$/i, '');
    }

    function concatBytes(chunks) {
        let n = 0;
        for (const c of chunks) n += c.length;
        const out = new Uint8Array(n);
        let at = 0;
        for (const c of chunks) {
            out.set(c, at);
            at += c.length;
        }
        return out;
    }

    /**
     * gunzip. `tolerateTruncation` returns what could be inflated from a cut-off
     * stream (a file prefix) instead of throwing at the missing trailer.
     */
    async function inflate(bytes, tolerateTruncation) {
        const u8 = toBytes(bytes);
        if (typeof DecompressionStream !== 'undefined') {
            const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
            const reader = stream.getReader();
            const chunks = [];
            try {
                for (;;) {
                    const part = await reader.read();
                    if (part.done) break;
                    chunks.push(part.value);
                }
            } catch (err) {
                if (!tolerateTruncation) throw err;
            }
            return concatBytes(chunks);
        }
        if (typeof require === 'function') {
            const zlib = require('zlib');
            const buf = zlib.gunzipSync(
                Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength),
                tolerateTruncation ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : undefined
            );
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        throw new Error('RunlogFormat: no gzip support (DecompressionStream missing)');
    }

    /** Bytes in → bytes out, inflated when they start with the gzip magic. */
    async function inflateIfGzip(bytes) {
        const u8 = toBytes(bytes);
        return isGzip(u8) ? inflate(u8, false) : u8;
    }

    function decodeText(u8) {
        return new TextDecoder('utf-8').decode(u8);
    }

    /**
     * The one entry point for loaders: string (returned as-is), Uint8Array /
     * ArrayBuffer / typed array, or a Blob|File (anything with arrayBuffer()) →
     * the log TEXT, inflated when gzipped.
     */
    async function readRunlogText(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.arrayBuffer === 'function' && !(input instanceof Uint8Array)) {
            input = await input.arrayBuffer();
        }
        return decodeText(await inflateIfGzip(toBytes(input)));
    }

    /**
     * A possibly TRUNCATED prefix of a file (the catalog's 64 KB metadata read) →
     * as much text as can be recovered; gzip prefixes inflate partially.
     */
    async function readRunlogPrefixText(input) {
        if (typeof input === 'string') return input;
        const u8 = toBytes(input);
        if (!isGzip(u8)) return decodeText(u8);
        try {
            return decodeText(await inflate(u8, true));
        } catch (_) {
            return '';
        }
    }

    // ── behavior_v2 line format ─────────────────────────────────────────────────
    function isInt(v) {
        return Number.isInteger(v);
    }

    function isArenaArray(value) {
        return (
            Array.isArray(value) &&
            (value.length === 6 || value.length === 7) &&
            value[0] === ARENA_TAG
        );
    }

    function isSchemaRecord(rec) {
        return (
            !!rec && !Array.isArray(rec) && typeof rec === 'object' && rec.type === 'frame_schema'
        );
    }

    function hexBytes(hex) {
        if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/.test(hex)) return null;
        const parts = [];
        for (let i = 0; i < hex.length; i += 2) parts.push(hex.slice(i, i + 2));
        return parts;
    }

    /**
     * ["a", t_off, dt, hex, status, rx_off(, error)] → the exact v1 arena_command
     * object. `schema` is the v2 frame_schema record (uses its `t0`) or a number.
     * Throws on a malformed array.
     */
    function expandV2Line(arr, schema) {
        if (!isArenaArray(arr)) throw new Error('RunlogFormat: not a compact arena array');
        const t0 = typeof schema === 'number' ? schema : schema && schema.t0;
        const tOff = arr[1];
        const dt = arr[2];
        const hex = arr[3];
        const status = arr[4];
        const rxOff = arr[5];
        const error = arr.length === 7 ? arr[6] : null;
        if (!isInt(t0) || !isInt(tOff) || !isInt(rxOff))
            throw new Error('RunlogFormat: t0/t_off/rx_off must be integers');
        if (typeof dt !== 'number') throw new Error('RunlogFormat: dt must be a number');
        const parts = hexBytes(hex);
        if (!parts) throw new Error('RunlogFormat: malformed hex ' + JSON.stringify(hex));
        if (status !== null && !isInt(status))
            throw new Error('RunlogFormat: status must be int or null');
        if (status !== null && parts.length < 2)
            throw new Error('RunlogFormat: status present but no command byte');
        if (error !== null && typeof error !== 'string')
            throw new Error('RunlogFormat: error must be a string');
        return {
            type: 'log',
            event: 'arena_command',
            t: t0 + tOff,
            dt: dt,
            len: parts.length,
            head: parts.join(' '),
            status: status,
            echo: status === null ? null : parseInt(parts[1], 16),
            ok: status === null ? null : status === 0,
            error: error,
            dir: ARENA_DIR,
            rx_ms: t0 + rxOff
        };
    }

    /**
     * v1 arena_command object → compact array, or null when the object does not fit
     * the fixed shape (then it stays verbatim). Mirrors bridge.py's invariants.
     */
    function compactV1Line(obj, t0) {
        if (!obj || Array.isArray(obj) || typeof obj !== 'object') return null;
        if (obj.type !== 'log' || obj.event !== 'arena_command') return null;
        const keys = Object.keys(obj);
        if (keys.length !== ARENA_COMMAND_KEYS.length) return null;
        for (const k of ARENA_COMMAND_KEYS) if (!(k in obj)) return null;
        if (obj.dir !== ARENA_DIR) return null;
        if (!isInt(t0) || !isInt(obj.t) || !isInt(obj.rx_ms)) return null;
        if (typeof obj.dt !== 'number') return null;
        if (typeof obj.head !== 'string' || !obj.head) return null;
        const parts = obj.head.split(' ');
        if (!parts.every((p) => /^[0-9a-f]{2}$/.test(p))) return null;
        if (obj.len !== parts.length) return null;
        if (obj.status === null) {
            if (obj.echo !== null || obj.ok !== null) return null;
        } else {
            if (!isInt(obj.status)) return null;
            if (parts.length < 2 || obj.echo !== parseInt(parts[1], 16)) return null;
            if (typeof obj.ok !== 'boolean' || obj.ok !== (obj.status === 0)) return null;
        }
        if (obj.error !== null && typeof obj.error !== 'string') return null;
        const arr = [ARENA_TAG, obj.t - t0, obj.dt, parts.join(''), obj.status, obj.rx_ms - t0];
        if (obj.error !== null) arr.push(obj.error);
        return arr;
    }

    /**
     * 'behavior_v2' | 'behavior_v1' | 'full' | 'legacy' | 'unknown' from either the
     * log text (first `maxLines` lines) or an array of parsed records. The schema
     * line decides; without one, "a" arrays mean v2, fictrac_frame objects with the
     * 25-column array mean `full`, other content is a pre-#140 log.
     */
    function detectFormat(input, maxLines) {
        let records = input;
        if (typeof input === 'string') {
            records = [];
            const lines = input.split(/\r?\n/);
            const n = Math.min(lines.length, maxLines || 200);
            for (let i = 0; i < n; i++) {
                const ln = lines[i].trim();
                if (!ln) continue;
                try {
                    records.push(JSON.parse(ln));
                } catch (_) {
                    /* torn line */
                }
            }
        }
        if (!Array.isArray(records) || !records.length) return 'unknown';
        let sawFull = false;
        let sawAny = false;
        for (const o of records) {
            sawAny = true;
            if (isSchemaRecord(o)) return String(o.level || 'behavior_v1');
            if (isArenaArray(o)) return 'behavior_v2';
            if (
                o &&
                typeof o === 'object' &&
                o.type === 'fictrac_frame' &&
                Array.isArray(o.fictrac)
            )
                sawFull = true;
        }
        if (!sawAny) return 'unknown';
        return sawFull ? 'full' : 'legacy';
    }

    /**
     * Per-file state machine for readers: feed every parsed line through
     * `normalize(rec)`; it remembers the frame_schema (v1 or v2), expands compact
     * arena arrays to v1 objects, and passes everything else through untouched.
     * `format` reports what the file turned out to be once enough lines went by.
     */
    function createNormalizer() {
        const state = {
            schema: null,
            level: null,
            orphanArena: 0,
            sawFull: false,
            sawAny: false
        };
        return {
            get schema() {
                return state.schema;
            },
            get level() {
                return state.level;
            },
            get orphanArena() {
                return state.orphanArena;
            },
            get format() {
                if (state.level) return state.level;
                if (!state.sawAny) return 'unknown';
                return state.sawFull ? 'full' : 'legacy';
            },
            normalize(rec) {
                state.sawAny = true;
                if (isSchemaRecord(rec)) {
                    state.schema = rec;
                    state.level = String(rec.level || 'behavior_v1');
                    return rec;
                }
                if (isArenaArray(rec)) {
                    if (!state.schema || !isInt(state.schema.t0)) {
                        // No t0 → the timestamps could not be trusted; leave the array
                        // (readers ignore it as a frame row) and count it.
                        state.orphanArena++;
                        if (!state.level) state.level = 'behavior_v2';
                        return rec;
                    }
                    if (!state.level) state.level = 'behavior_v2';
                    return expandV2Line(rec, state.schema);
                }
                if (
                    rec &&
                    typeof rec === 'object' &&
                    !Array.isArray(rec) &&
                    rec.type === 'fictrac_frame' &&
                    Array.isArray(rec.fictrac)
                )
                    state.sawFull = true;
                return rec;
            }
        };
    }

    // ── whole-text converters (JS mirror of bridge.py --convert; tests + parity) ──
    function parseLines(text) {
        const out = [];
        for (const line of String(text).split(/\r?\n/)) {
            const ln = line.trim();
            if (!ln) continue;
            out.push(JSON.parse(ln));
        }
        return out;
    }

    function dumpLines(records) {
        return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    }

    function isSession(o) {
        return o && typeof o === 'object' && !Array.isArray(o) && o.type === 'session';
    }

    /** behavior_v1 / legacy / full text → behavior_v2 text (lossless). */
    function convertV1ToV2Text(text) {
        const records = parseLines(text);
        const schemaIdx = records.findIndex(isSchemaRecord);
        let cols = null;
        if (schemaIdx >= 0) {
            const sch = records[schemaIdx];
            if (sch.level === 'behavior_v2') throw new Error('already behavior_v2');
            cols = sch.cols;
        }
        let t0 = null;
        for (const o of records) {
            if (isSession(o) && isInt(o.ms)) {
                t0 = o.ms;
                break;
            }
        }
        if (t0 === null) {
            const a = records.find(
                (o) =>
                    o && typeof o === 'object' && !Array.isArray(o) && o.event === 'arena_command'
            );
            t0 = a && isInt(a.t) ? a.t : 0;
        }
        const schema = {
            type: 'frame_schema',
            level: 'behavior_v2',
            cols: cols,
            arena_cols: BEHAVIOR_V2_ARENA_COLS.slice(),
            t0: t0
        };
        const insertAt =
            schemaIdx >= 0 ? schemaIdx : records.length && isSession(records[0]) ? 1 : 0;
        const out = [];
        records.forEach((o, i) => {
            if (i === schemaIdx) {
                out.push(schema);
                return;
            }
            if (schemaIdx < 0 && i === insertAt) out.push(schema);
            if (o && typeof o === 'object' && !Array.isArray(o) && o.event === 'arena_command') {
                const arr = compactV1Line(o, t0);
                out.push(arr || o);
            } else out.push(o);
        });
        if (schemaIdx < 0 && insertAt >= records.length) out.push(schema);
        return dumpLines(out);
    }

    /** behavior_v2 text → behavior_v1 text (the exact inverse). */
    function convertV2ToV1Text(text) {
        const records = parseLines(text);
        const schemaIdx = records.findIndex(isSchemaRecord);
        if (schemaIdx < 0 || records[schemaIdx].level !== 'behavior_v2')
            throw new Error('not a behavior_v2 log');
        const sch = records[schemaIdx];
        const out = [];
        records.forEach((o, i) => {
            if (i === schemaIdx) {
                if (sch.cols !== null && sch.cols !== undefined)
                    out.push({ type: 'frame_schema', level: 'behavior_v1', cols: sch.cols });
                return;
            }
            out.push(isArenaArray(o) ? expandV2Line(o, sch) : o);
        });
        return dumpLines(out);
    }

    const RunlogFormat = {
        ARENA_TAG,
        ARENA_DIR,
        ARENA_COMMAND_KEYS,
        BEHAVIOR_V2_ARENA_COLS,
        isGzip,
        isRunlogName,
        stripGz,
        inflateIfGzip,
        readRunlogText,
        readRunlogPrefixText,
        isArenaArray,
        expandV2Line,
        compactV1Line,
        detectFormat,
        createNormalizer,
        convertV1ToV2Text,
        convertV2ToV1Text
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = RunlogFormat;
    global.RunlogFormat = RunlogFormat;
})(typeof window !== 'undefined' ? window : globalThis);
