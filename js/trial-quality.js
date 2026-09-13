/**
 * trial-quality.js — per-trial stimulus-quality classification from the
 * controller telemetry ring (fw sd_fastpath / ring v2, 2026-09-13).
 *
 * The SD card inside the controller stalls for 23–89 ms every ~24.5k reads of a
 * large pattern (card-internal read-count maintenance); during a stall the
 * display freezes and the queued closed-loop commands are coalesced. Michael's
 * acceptable display freeze is 5 ms (target) / 10 ms (worst case); anything
 * ≥ 30 ms is a visible stimulus artifact. This module turns the drained ring
 * records into a verdict per trial so the analysis can flag (never silently
 * drop) the affected trials:
 *
 *   pass     complete telemetry coverage, no read or displayed-frame gap over the threshold
 *   fail     at least one `sd_slow` read or FRAME `req_age_us` over the threshold
 *   unknown  coverage incomplete (seq gap, controller reboot, drain paused / refused
 *            by the bridge, drainer error) and no fail evidence — NEVER promoted to pass
 *
 * Attribution is by CONTROLLER order, not by arrival: records are fed in ring
 * `seq` order; a trial starts at every successful `sd_open` (kind 7, code 0) and
 * ends at the next one; `sd_reads` (kind 13) is emitted by the firmware for the
 * pattern being left before the next `sd_open`, so it belongs to the trial that
 * is current when it arrives. Records re-delivered by the drainer (a refused or
 * re-armed block) are dropped by `seq` — counting is idempotent.
 *
 * Classic dual-export (window global + CommonJS), no bare ES `export`.
 */
(function (global) {
    'use strict';

    const DEFAULT_GAP_US = 10000; // worst-case acceptable freeze (Michael, 2026-09-13)
    const DEFAULT_TARGET_US = 5000; // the target, reported but not a fail criterion

    /**
     * @param {object} [opts]
     *   gapUs        fail threshold for sd_slow read time and FRAME req_age_us (default 10 000)
     *   targetUs     reported "over target" count (default 5 000)
     *   onGap(gap)   called once per over-threshold event with a run-log-ready object
     *   onTrial(t)   called when a trial closes (the next sd_open or reset())
     */
    function createTrialQuality(opts) {
        const o = opts || {};
        const gapUs = o.gapUs || DEFAULT_GAP_US;
        const targetUs = o.targetUs || DEFAULT_TARGET_US;
        const onGap = o.onGap || (() => {});
        const onTrial = o.onTrial || (() => {});

        let trials = [];
        let current = null; // the open trial (not yet closed by the next sd_open)
        let lastSeq = null; // highest seq accepted (dedup + gap detection)
        let pendingCoverage = []; // coverage issues noted while no trial is open
        let duplicates = 0;
        let fedRecords = 0;

        function newTrial(rec) {
            closeCurrent();
            current = {
                index: trials.length + 1, // 1-based, in controller order
                pattern: rec.arg,
                openSeq: rec.seq,
                openTUs: rec.tUs,
                lastTUs: rec.tUs,
                cmds70: 0,
                indexChanges: 0,
                lastIdx: null,
                frames: 0,
                reads: null, // from sd_reads (kind 13) when the trial closes
                stalls: [], // over-threshold sd_slow reads
                slowReads: 0, // every sd_slow record (firmware threshold, 10 ms on v2 / 20 ms on v1)
                ageGaps: [], // over-threshold FRAME req_age_us
                overTarget: 0, // FRAME req_age_us over the target (5 ms) but under the threshold
                maxReadUs: 0,
                maxAgeUs: 0,
                superseded: 0,
                coverage: pendingCoverage.splice(0)
            };
            trials.push(current);
        }

        function closeCurrent() {
            if (!current) return;
            const t = current;
            current = null;
            t.status = statusOf(t);
            onTrial(t);
        }

        function statusOf(t) {
            if (t.stalls.length || t.ageGaps.length) return 'fail';
            if (t.coverage.length) return 'unknown';
            return 'pass';
        }

        function coverage(reason, detail) {
            const entry = { reason, detail: detail || null };
            if (current) current.coverage.push(entry);
            else pendingCoverage.push(entry);
        }

        function gapEvent(kind, rec, us, extra) {
            const ev = Object.assign(
                {
                    event: 'display_gap',
                    trial: current ? current.index : null,
                    pattern: current ? current.pattern : null,
                    seq: rec.seq,
                    t_us: rec.tUs,
                    ms: Math.round(us / 100) / 10,
                    kind
                },
                extra || {}
            );
            onGap(ev);
            return ev;
        }

        /**
         * Feed parsed records (js/arena-telemetry.js `parseBlock().records`) in the
         * order the drainer delivered them (= ring seq order).
         */
        function feed(records) {
            for (const r of records || []) {
                if (typeof r.seq !== 'number') continue;
                // Dedup: the drainer re-delivers a block the sink refused (ack withheld)
                // and, after a rearm, records already stored. seq is monotonic within a
                // ring incarnation; a boot record marks a possible restart (fresh ring).
                const isBoot = r.kind === 'state' && r.stateKind === 1;
                if (lastSeq != null && !isBoot && seqLE(r.seq, lastSeq)) {
                    duplicates++;
                    continue;
                }
                if (lastSeq != null && !isBoot && r.seq !== (lastSeq + 1) >>> 0) {
                    coverage('seq_gap', { expected: (lastSeq + 1) >>> 0, got: r.seq });
                }
                lastSeq = r.seq;
                fedRecords++;
                if (current && typeof r.tUs === 'number') current.lastTUs = r.tUs;

                if (r.kind === 'state') {
                    switch (r.stateKind) {
                        case 1: // boot: the controller reset — whatever trial was open lost its tail
                            coverage('controller_reboot', { code: r.code });
                            lastSeq = r.seq; // seq may restart (fresh ring) — accept the new numbering
                            break;
                        case 7: // sd_open
                            if (r.code === 0) newTrial(r);
                            break;
                        case 4: {
                            // sd_slow: readFrame over the FIRMWARE threshold (10 ms v2 / 20 ms v1)
                            if (!current) break;
                            const us = (r.readUs != null ? r.readUs : r.arg * 100) >>> 0;
                            current.slowReads++;
                            if (us > current.maxReadUs) current.maxReadUs = us;
                            if (us > gapUs) {
                                const ev = gapEvent('sd_slow', r, us, {
                                    phase: r.phase || 'unknown',
                                    read_error: !!r.readError
                                });
                                current.stalls.push({
                                    seq: r.seq,
                                    tUs: r.tUs,
                                    us,
                                    phase: ev.phase
                                });
                            }
                            break;
                        }
                        case 13: // sd_reads for the pattern being left
                            if (current) current.reads = r.reads != null ? r.reads : r.arg;
                            break;
                        case 5: // ring_overrun: records evicted before the host read them
                            coverage('ring_overrun', { code: r.code, arg: r.arg });
                            break;
                        default:
                            break;
                    }
                } else if (r.kind === 'frame') {
                    if (!current) continue;
                    current.frames++;
                    if (current.lastIdx == null) current.lastIdx = r.idx; // the trial's initial frame: a 0x70 for it is not an index change
                    if (typeof r.superseded === 'number') current.superseded += r.superseded;
                    if (typeof r.reqAgeUs === 'number') {
                        if (r.reqAgeUs > current.maxAgeUs) current.maxAgeUs = r.reqAgeUs;
                        if (r.reqAgeUs > gapUs) {
                            gapEvent('frame_age', r, r.reqAgeUs, { idx: r.idx });
                            current.ageGaps.push({
                                seq: r.seq,
                                tUs: r.tUs,
                                us: r.reqAgeUs,
                                idx: r.idx
                            });
                        } else if (r.reqAgeUs > targetUs) current.overTarget++;
                    }
                } else if (r.kind === 'cmd') {
                    if (!current || r.cmd !== 0x70 || r.status !== 0) continue;
                    current.cmds70++;
                    const idx = idxFromReq(r.req);
                    if (idx != null && idx !== current.lastIdx) {
                        current.indexChanges++;
                        current.lastIdx = idx;
                    }
                }
            }
        }

        /** Coverage note from outside the record stream (poller paused, bridge refused, drainer error). */
        function noteCoverage(reason, detail) {
            coverage(reason, detail);
        }

        /** Close the open trial (run end) and return the summary. */
        function finish() {
            closeCurrent();
            return summary();
        }

        function summary() {
            const rows = trials.map((t) => compact(t));
            const counts = { pass: 0, fail: 0, unknown: 0, open: 0 };
            for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
            let worstUs = 0;
            for (const t of trials) worstUs = Math.max(worstUs, t.maxReadUs, t.maxAgeUs);
            return {
                threshold_us: gapUs,
                target_us: targetUs,
                trials: rows,
                counts,
                worst_gap_us: worstUs,
                flagged_trials: rows.filter((r) => r.status === 'fail').map((r) => r.trial),
                unknown_trials: rows.filter((r) => r.status === 'unknown').map((r) => r.trial),
                duplicates_dropped: duplicates,
                records: fedRecords
            };
        }

        function compact(t) {
            return {
                trial: t.index,
                pattern: t.pattern,
                status: t === current ? 'open' : t.status || statusOf(t),
                duration_s: Math.round((((t.lastTUs - t.openTUs) >>> 0) / 1e6) * 10) / 10,
                cmds70: t.cmds70,
                index_changes: t.indexChanges,
                reads: t.reads,
                frames: t.frames,
                slow_reads: t.slowReads,
                stalls: t.stalls.length,
                max_read_ms: Math.round(t.maxReadUs / 100) / 10,
                age_gaps: t.ageGaps.length,
                max_age_ms: Math.round(t.maxAgeUs / 100) / 10,
                over_target: t.overTarget,
                superseded: t.superseded,
                coverage: t.coverage.map((c) => c.reason)
            };
        }

        function reset() {
            trials = [];
            current = null;
            lastSeq = null;
            pendingCoverage = [];
            duplicates = 0;
            fedRecords = 0;
        }

        return {
            feed,
            noteCoverage,
            finish,
            summary,
            reset,
            get current() {
                return current ? compact(current) : null;
            },
            get thresholdUs() {
                return gapUs;
            }
        };
    }

    // seq a <= b with u32 wrap tolerance (half-range rule)
    function seqLE(a, b) {
        return (b - a) >>> 0 < 0x80000000;
    }

    // CMD record `req` = hex of the request bytes AFTER [len, cmd] as the firmware
    // records them: for SET_FRAME_POSITION "2d00" → index 45. Host-style echoes that
    // still carry the prefix ("03702d00") are tolerated for older fixtures.
    function idxFromReq(req) {
        if (typeof req !== 'string' || req.length < 4) return null;
        const off = req.length >= 8 && req.slice(2, 4) === '70' ? 4 : 0;
        const lo = parseInt(req.slice(off, off + 2), 16);
        const hi = parseInt(req.slice(off + 2, off + 4), 16);
        if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
        return lo | (hi << 8);
    }

    const TrialQuality = {
        DEFAULT_GAP_US,
        DEFAULT_TARGET_US,
        createTrialQuality,
        idxFromReq
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = TrialQuality;
    if (typeof global !== 'undefined') global.TrialQuality = TrialQuality;
})(typeof window !== 'undefined' ? window : this);
