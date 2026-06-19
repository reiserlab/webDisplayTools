/**
 * run-log.js — structured experiment run-log builder (Arena Studio).
 *
 * A DOM-free accumulator that turns a recorded experiment run into a
 * self-describing, exportable record: a metadata header + a timestamped event
 * stream + a run summary. The browser feeds it the ArenaRunner's onProgress
 * phases (no new instrumentation — those events already carry everything); this
 * module stamps each one (the runner emits no timestamps) and serializes to
 * BOTH runlog.json (canonical, for analysis) and runlog.txt (human transcript),
 * generated from the same array so they can never drift.
 *
 * Provenance: the header records the protocol filename + sha256 the run actually
 * used, so the saved .yaml on disk and this log are self-verifying as a pair
 * (re-hash the file, compare). intent='test' runs are tagged and carry no hash.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES
 * `export`) — same pattern as arena-session.js / arena-runner-g6.js, so it loads
 * before the module block and dodges the ES-import-cache gotcha. The core is
 * DOM-free + clock-injectable so it is fully unit-testable under Node
 * (tests/test-run-log.js); only `download()` touches the DOM and is guarded.
 */
(function (global) {
    'use strict';

    const SCHEMA = 'arena-studio-runlog/1';

    function iso(ms) {
        return new Date(ms).toISOString();
    }
    function round(n, d) {
        const f = Math.pow(10, d);
        return Math.round(n * f) / f;
    }
    // Filesystem-safe slug for filenames (experimenter etc.).
    function slug(s) {
        return (
            String(s || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'anon'
        );
    }
    // Strip a YAML extension to a basename for the log filename.
    function baseName(filename) {
        return String(filename || 'untitled').replace(/\.ya?ml$/i, '');
    }
    // Derive a terminal outcome flag from the runner summary (+ optional override).
    function deriveOutcome(summary, override) {
        if (override) return override;
        if (!summary) return 'UNKNOWN';
        if (summary.aborted) return 'ABORTED_BY_USER';
        if (summary.errors > 0) return 'ERRORED';
        if (summary.completed) return 'COMPLETED';
        return 'UNKNOWN';
    }

    // One readable transcript line per event. Known runner phases get friendly
    // text; anything else falls back to a compact JSON dump so nothing is lost.
    function formatLine(ev) {
        const stamp = ev.t_iso.slice(11, 19) + '  ';
        const step = ev.step || {};
        const where =
            ev.index != null ? '[' + (ev.index + 1) + (ev.total ? '/' + ev.total : '') + '] ' : '';
        switch (ev.phase) {
            case 'sequence-start':
                return stamp + '▸ sequence start — ' + (ev.total || 0) + ' steps (host-timed)';
            case 'step-start':
                return (
                    stamp +
                    '▸ ' +
                    where +
                    (step.conditionName || step.label || '') +
                    (step.kind ? ' · ' + step.kind : '')
                );
            case 'trial-running':
                return (
                    stamp +
                    '   ' +
                    where +
                    'running ' +
                    (step.conditionName || '') +
                    (ev.durationSec != null ? ' (' + ev.durationSec + 's, host-timed)' : '')
                );
            case 'command':
                return (
                    stamp +
                    '   ' +
                    where +
                    (ev.op || 'command') +
                    (ev.value != null ? ' ' + ev.value : '')
                );
            case 'skip':
                return (
                    stamp +
                    '   ' +
                    where +
                    'SKIP ' +
                    (ev.plugin_name || '') +
                    (ev.command_name ? '.' + ev.command_name : '') +
                    (ev.reason ? ' (' + ev.reason + ')' : '')
                );
            case 'error':
                return stamp + '   ' + where + 'ERROR ' + (ev.reason || '');
            case 'step-done':
                return stamp + '   ' + where + 'done';
            case 'sequence-complete':
            case 'aborted':
                return stamp + '■ ' + ev.phase;
            default:
                return stamp + ev.phase + ' ' + compactPayload(ev);
        }
    }
    function compactPayload(ev) {
        const out = {};
        for (const k in ev) {
            if (k === 't_iso' || k === 't_offset_s' || k === 'phase' || k === 'step') continue;
            out[k] = ev[k];
        }
        const keys = Object.keys(out);
        return keys.length ? JSON.stringify(out) : '';
    }

    /**
     * Create a run-log accumulator.
     * @param {object} [opts]
     * @param {object} [opts.meta]   per-run metadata: run_id, experimenter, genotype,
     *     notes, protocol_filename, protocol_sha256, arena_config, rig, firmware, tool_version
     * @param {string} [opts.intent] 'experiment' (default) | 'test'
     * @param {Function} [opts.now]  () => ms-since-epoch (injectable for tests; default Date.now)
     */
    function createRunLog(opts) {
        const o = opts || {};
        const now = o.now || Date.now;
        const intent = o.intent || 'experiment';
        const startMs = now();
        const meta = Object.assign({}, o.meta, { timestamp_start: iso(startMs) });
        // A test run never carries a protocol hash — keep the two un-confusable.
        if (intent === 'test') meta.protocol_sha256 = null;
        const events = [];
        let summary = null;

        return {
            get intent() {
                return intent;
            },
            get meta() {
                return meta;
            },
            get events() {
                return events;
            },
            get summary() {
                return summary;
            },

            /** Append a stamped event (phase + arbitrary payload). Returns it. */
            event(phase, payload) {
                const t = now();
                const ev = Object.assign(
                    { t_iso: iso(t), t_offset_s: round((t - startMs) / 1000, 3), phase: phase },
                    payload || {}
                );
                events.push(ev);
                return ev;
            },

            /**
             * Close the log at a terminal event.
             * @param {object} runnerSummary {completed,aborted,steps,errors,skipped}
             * @param {string} [outcomeOverride] e.g. 'DISCONNECTED'
             */
            finish(runnerSummary, outcomeOverride) {
                const endMs = now();
                summary = Object.assign({}, runnerSummary, {
                    timestamp_end: iso(endMs),
                    duration_s: round((endMs - startMs) / 1000, 3),
                    outcome: deriveOutcome(runnerSummary, outcomeOverride)
                });
                return summary;
            },

            /** Canonical machine record. */
            toJSON() {
                return {
                    schema: SCHEMA,
                    intent: intent,
                    meta: meta,
                    events: events,
                    summary: summary
                };
            },

            /** Human transcript (lab-notebook friendly), same content as toJSON. */
            toText() {
                const L = [];
                L.push('# Arena Studio run log (' + intent + ')');
                const order = [
                    'run_id',
                    'timestamp_start',
                    'experimenter',
                    'genotype',
                    'notes',
                    'protocol_filename',
                    'protocol_sha256',
                    'arena_config',
                    'rig',
                    'firmware',
                    'tool_version'
                ];
                for (const k of order) {
                    if (meta[k] != null && meta[k] !== '') L.push(k + ': ' + meta[k]);
                }
                L.push('');
                for (const ev of events) L.push(formatLine(ev));
                if (summary) {
                    L.push('');
                    L.push(
                        '— ' +
                            (summary.outcome || 'DONE') +
                            ' — ' +
                            (summary.steps != null ? summary.steps + ' steps · ' : '') +
                            (summary.errors || 0) +
                            ' errors · ' +
                            (summary.skipped || 0) +
                            ' skipped · ' +
                            (summary.duration_s != null ? summary.duration_s + 's' : '')
                    );
                    L.push(
                        '(durations are host-side estimates — firmware-confirmed timing pending FW #4)'
                    );
                }
                return L.join('\n');
            },

            /** Filename convention: <protocol>__<experimenter>__<ISO-dashes>__<run_id>.runlog.<ext> */
            filename(ext) {
                const isoDash = meta.timestamp_start.replace(/[:.]/g, '-').slice(0, 19);
                return (
                    baseName(meta.protocol_filename) +
                    '__' +
                    slug(meta.experimenter) +
                    '__' +
                    isoDash +
                    '__' +
                    (meta.run_id || 'run') +
                    '.runlog.' +
                    (ext || 'json')
                );
            }
        };
    }

    // Browser-only: trigger a download of the log as .json (+ .txt). Reuses the
    // arena_console #btn-save Blob+anchor recipe. No-op (returns false) under Node.
    function download(log, opts) {
        if (typeof document === 'undefined') return false;
        const both = !opts || opts.text !== false;
        const drop = (text, ext, mime) => {
            const blob = new Blob([text], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = log.filename(ext);
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        };
        drop(JSON.stringify(log.toJSON(), null, 2), 'json', 'application/json');
        if (both) drop(log.toText(), 'txt', 'text/plain');
        return true;
    }

    const RunLog = { createRunLog, download, slug, baseName, deriveOutcome, SCHEMA };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = RunLog;
    }
    if (typeof global !== 'undefined') {
        global.RunLog = RunLog;
    }
})(typeof window !== 'undefined' ? window : this);
