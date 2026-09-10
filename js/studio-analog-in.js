/**
 * studio-analog-in.js — the logic behind the Arena Studio Console's "Analog In"
 * panel (docs/development/analog-input-plan.md § 4, S1), kept DOM-free so it is
 * Node-testable (tests/test-studio-analog-in.js):
 *
 *   - createMonitor()   ring buffer of [ms, ain1, ain2] samples over a time window,
 *                       per-channel last/min/max, sample rate estimate
 *   - createPoller()    single-flight periodic reader: never issues a second
 *                       GET_ANALOG_IN while one is in flight, pauses (with a reason)
 *                       whenever the gate says no — panel closed, not connected, no
 *                       io_ext firmware, run active, user pause — and reports state
 *                       CHANGES (not every tick) so the Console log is not flooded
 *   - sweepPlan / fitLinear / summarizeSweep / sweepCsv — the AO → AI loopback
 *                       self-test (cable "Analog Out (0-5V)" J27 to an Analog In BNC,
 *                       step the output 0..5000 mV, read the input, fit slope/offset)
 *   - describeFlags()   the GET_ANALOG_IN 0xA4 reply flags byte (firmware F1+)
 *   - drawStripChart()  canvas trace of both channels (browser only; guarded)
 *
 * Volts: the controller reports millivolts of BNC input on a nominal ±10 V scale
 * (per-board calibration is firmware F2). 1 LSB is ~4.9 mV with the 12-bit F1
 * firmware, ~19.6 mV before it.
 *
 * LOADING: classic <script src> (window-global `StudioAnalogIn` + CommonJS), no ES
 * `export` — same rule as arena-session.js (CLAUDE.md).
 */
(function (global) {
    'use strict';

    const FULL_SCALE_MV = 10000; // ±10 V front end
    const AO_MAX_MV = 5000; // "Analog Out (0-5V)" range
    // GET_ANALOG_IN 0xA4 reply flags (5th byte; absent on pre-F1 firmware).
    const AIN_FLAGS = { CH1_CAL: 0x01, CH2_CAL: 0x02, BITS12: 0x04 };

    function isNum(v) {
        return typeof v === 'number' && Number.isFinite(v);
    }

    /** '+1234 mV' / '-7263 mV' / '—' */
    function formatMv(mv) {
        if (!isNum(mv)) return '—';
        const r = Math.round(mv);
        return (r > 0 ? '+' : '') + r + ' mV';
    }

    /** Position of a mV value on the ±10 V bar, 0..1 (clamped). */
    function barFraction(mv) {
        if (!isNum(mv)) return 0.5;
        return Math.min(1, Math.max(0, (mv + FULL_SCALE_MV) / (2 * FULL_SCALE_MV)));
    }

    /** Decode the 0xA4 flags byte (null/undefined = pre-F1 firmware, 10-bit, uncal). */
    function describeFlags(flags) {
        const f = isNum(flags) ? flags : null;
        const bits12 = f !== null && !!(f & AIN_FLAGS.BITS12);
        const cal1 = f !== null && !!(f & AIN_FLAGS.CH1_CAL);
        const cal2 = f !== null && !!(f & AIN_FLAGS.CH2_CAL);
        const parts = [];
        parts.push(f === null ? '10-bit (pre-F1 fw)' : bits12 ? '12-bit' : '10-bit');
        parts.push(
            cal1 && cal2
                ? 'calibrated'
                : cal1 || cal2
                  ? 'cal: ' + (cal1 ? 'AI1' : 'AI2') + ' only'
                  : 'uncalibrated'
        );
        return {
            flags: f,
            bits12,
            cal1,
            cal2,
            lsbMv: bits12 ? 4.9 : 19.6,
            text: parts.join(' · ')
        };
    }

    function median(values) {
        const v = (values || [])
            .filter(isNum)
            .slice()
            .sort((a, b) => a - b);
        if (!v.length) return NaN;
        const m = v.length >> 1;
        return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    }

    // ── monitor ────────────────────────────────────────────────────────────────
    /**
     * @param {object} [opts] {windowMs=30000, maxSamples=4000}
     */
    function createMonitor(opts) {
        const o = opts || {};
        const windowMs = isNum(o.windowMs) && o.windowMs > 0 ? o.windowMs : 30000;
        const maxSamples = isNum(o.maxSamples) && o.maxSamples > 0 ? o.maxSamples : 4000;
        let samples = []; // [{ms, a1, a2}]
        const range = { 1: { min: NaN, max: NaN }, 2: { min: NaN, max: NaN } };
        let total = 0;

        function trim(nowMs) {
            const cutoff = nowMs - windowMs;
            let i = 0;
            while (i < samples.length && samples[i].ms < cutoff) i++;
            if (i) samples.splice(0, i);
            if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
        }
        function track(ch, v) {
            if (!isNum(v)) return;
            const r = range[ch];
            r.min = isNum(r.min) ? Math.min(r.min, v) : v;
            r.max = isNum(r.max) ? Math.max(r.max, v) : v;
        }
        return {
            get windowMs() {
                return windowMs;
            },
            push(ms, a1, a2) {
                const t = isNum(ms)
                    ? ms
                    : samples.length
                      ? samples[samples.length - 1].ms + 100
                      : 0;
                samples.push({ ms: t, a1: isNum(a1) ? a1 : NaN, a2: isNum(a2) ? a2 : NaN });
                total++;
                track(1, a1);
                track(2, a2);
                trim(t);
            },
            samples() {
                return samples.slice();
            },
            /** {last, min, max, n} for channel 1|2 (mV). */
            stats(ch) {
                const key = ch === 2 ? 'a2' : 'a1';
                const last = samples.length ? samples[samples.length - 1][key] : NaN;
                const r = range[ch === 2 ? 2 : 1];
                return { last, min: r.min, max: r.max, n: total };
            },
            /** Achieved sample rate over the last ~20 samples, Hz (NaN if < 2). */
            rateHz() {
                const n = Math.min(samples.length, 20);
                if (n < 2) return NaN;
                const a = samples[samples.length - n];
                const b = samples[samples.length - 1];
                const dt = b.ms - a.ms;
                return dt > 0 ? ((n - 1) * 1000) / dt : NaN;
            },
            resetMinMax() {
                range[1] = { min: NaN, max: NaN };
                range[2] = { min: NaN, max: NaN };
            },
            clear() {
                samples = [];
            }
        };
    }

    // ── poller ─────────────────────────────────────────────────────────────────
    /**
     * @param {object} a
     * @param {function():Promise<object>} a.read      one GET_ANALOG_IN round trip → decoded reply
     * @param {function():{ok:boolean,reason?:string}} a.canPoll  the gate, evaluated every tick
     * @param {function(object):void} [a.onSample]
     * @param {function(string,string):void} [a.onState]  (state, reason) on CHANGE only:
     *        'polling' | 'paused' | 'error'
     * @param {number} [a.maxConsecutiveErrors=5]  after this many failed reads in a row the
     *        poller parks itself ('error' state) until the gate flips or resume() is called
     */
    function createPoller(a) {
        const read = a.read;
        const canPoll = a.canPoll || (() => ({ ok: true }));
        const onSample = a.onSample || (() => {});
        const onState = a.onState || (() => {});
        const maxErrors = isNum(a.maxConsecutiveErrors) ? a.maxConsecutiveErrors : 5;
        let inFlight = false;
        let timer = null;
        let intervalMs = 100;
        let state = 'paused';
        let reason = 'not started';
        let errors = 0;
        let clearImpl = null;
        let ticks = 0;
        let skipped = 0;
        let lastGateOk = null;

        function setState(s, r) {
            const rr = r || '';
            if (s === state && rr === reason) return;
            state = s;
            reason = rr;
            onState(s, rr);
        }

        async function tick() {
            ticks++;
            const gate = canPoll();
            const ok = !!(gate && gate.ok);
            if (ok !== lastGateOk) {
                lastGateOk = ok;
                if (ok) errors = 0; // gate re-opened → forgive a previous error streak
            }
            if (!ok) {
                setState('paused', (gate && gate.reason) || 'paused');
                return false;
            }
            if (errors >= maxErrors) {
                setState('error', 'read failed ' + errors + '× — paused (resume to retry)');
                return false;
            }
            if (inFlight) {
                skipped++; // single-flight: the previous read is still on the wire
                return false;
            }
            inFlight = true;
            try {
                const r = await read();
                errors = 0;
                onSample(r);
                setState('polling', '');
                return true;
            } catch (e) {
                errors++;
                setState('error', (e && e.message) || String(e));
                return false;
            } finally {
                inFlight = false;
            }
        }

        return {
            tick,
            /** Start (or restart at a new rate). `setIntervalImpl`/`clearIntervalImpl` are injectable for tests. */
            start(ms, setIntervalImpl, clearIntervalImpl) {
                this.stop();
                intervalMs = isNum(ms) && ms >= 20 ? Math.round(ms) : 100;
                const si =
                    setIntervalImpl || (typeof setInterval === 'function' ? setInterval : null);
                clearImpl =
                    clearIntervalImpl ||
                    (typeof clearInterval === 'function' ? clearInterval : null);
                if (!si) throw new Error('StudioAnalogIn poller: no setInterval available');
                timer = si(() => {
                    tick();
                }, intervalMs);
            },
            stop() {
                if (timer !== null && clearImpl) clearImpl(timer);
                timer = null;
            },
            /** Clear an error streak (user resume). */
            resume() {
                errors = 0;
            },
            get running() {
                return timer !== null;
            },
            get intervalMs() {
                return intervalMs;
            },
            get state() {
                return state;
            },
            get reason() {
                return reason;
            },
            get errors() {
                return errors;
            },
            get stats() {
                return { ticks, skipped, errors };
            }
        };
    }

    // ── loopback sweep ─────────────────────────────────────────────────────────
    /** Inclusive AO levels from..to by step, clamped to 0..5000 mV, integers. */
    function sweepPlan(fromMv, toMv, stepMv) {
        const from = isNum(fromMv) ? Math.max(0, Math.min(AO_MAX_MV, Math.round(fromMv))) : 0;
        const to = isNum(toMv) ? Math.max(0, Math.min(AO_MAX_MV, Math.round(toMv))) : AO_MAX_MV;
        const step = isNum(stepMv) && stepMv > 0 ? Math.round(stepMv) : 500;
        const out = [];
        if (to >= from) for (let v = from; v <= to; v += step) out.push(v);
        else for (let v = from; v >= to; v -= step) out.push(v);
        if (out[out.length - 1] !== to) out.push(to);
        return out;
    }

    /** Ordinary least squares y = slope·x + offset; null when < 2 finite points. */
    function fitLinear(xs, ys) {
        const pts = [];
        for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
            if (isNum(xs[i]) && isNum(ys[i])) pts.push([xs[i], ys[i]]);
        }
        const n = pts.length;
        if (n < 2) return null;
        let sx = 0;
        let sy = 0;
        for (const [x, y] of pts) {
            sx += x;
            sy += y;
        }
        const mx = sx / n;
        const my = sy / n;
        let sxx = 0;
        let sxy = 0;
        for (const [x, y] of pts) {
            sxx += (x - mx) * (x - mx);
            sxy += (x - mx) * (y - my);
        }
        const slope = sxx > 0 ? sxy / sxx : NaN;
        const offset = my - slope * mx;
        let se = 0;
        let maxAbsErr = 0;
        for (const [x, y] of pts) {
            const e = y - (slope * x + offset);
            se += e * e;
            maxAbsErr = Math.max(maxAbsErr, Math.abs(e));
        }
        return { slope, offset, rmse: Math.sqrt(se / n), maxAbsErr, n };
    }

    /**
     * rows: [{aoMv, ai1Mv, ai2Mv}], ch: 1|2 (the input the cable feeds).
     * Returns {ch, fit, rows:[{aoMv, aiMv, errMv}], verdict:'ok'|'check'|'fail', text}.
     * Verdict: slope within ±5 % of 1, |offset| ≤ 150 mV and max |err| ≤ 150 mV → ok
     * (a loopback that reads AO + 1 V is linear but wrong — offset is diagnostic);
     * slope in ±15 % → check; else fail (an un-reworked board saturates near +10 V → fail).
     */
    function summarizeSweep(rows, ch) {
        const key = ch === 2 ? 'ai2Mv' : 'ai1Mv';
        const xs = rows.map((r) => r.aoMv);
        const ys = rows.map((r) => r[key]);
        const fit = fitLinear(xs, ys);
        const out = rows.map((r) => ({
            aoMv: r.aoMv,
            aiMv: r[key],
            errMv: fit ? r[key] - (fit.slope * r.aoMv + fit.offset) : NaN
        }));
        let verdict = 'fail';
        if (fit && isNum(fit.slope)) {
            const slopeOk = Math.abs(fit.slope - 1) <= 0.05;
            const offsetOk = Math.abs(fit.offset) <= 150;
            if (slopeOk && offsetOk && fit.maxAbsErr <= 150) verdict = 'ok';
            else if (Math.abs(fit.slope - 1) <= 0.15) verdict = 'check';
        }
        const text = fit
            ? 'slope ' +
              fit.slope.toFixed(4) +
              ' · offset ' +
              Math.round(fit.offset) +
              ' mV · max |err| ' +
              Math.round(fit.maxAbsErr) +
              ' mV · ' +
              fit.n +
              ' steps · ' +
              verdict
            : 'not enough points';
        return { ch: ch === 2 ? 2 : 1, fit, rows: out, verdict, text };
    }

    /** CSV of a sweep: ao_mv,ai1_mv,ai2_mv */
    function sweepCsv(rows) {
        const lines = ['ao_mv,ai1_mv,ai2_mv'];
        for (const r of rows || []) {
            lines.push(
                [r.aoMv, r.ai1Mv, r.ai2Mv].map((v) => (isNum(v) ? Math.round(v) : '')).join(',')
            );
        }
        return lines.join('\n') + '\n';
    }

    // ── strip chart (browser only) ─────────────────────────────────────────────
    /**
     * Draw both channels over the monitor window on a <canvas>. Returns false when
     * there is no usable canvas (Node, or the panel is not rendered).
     * @param {HTMLCanvasElement} canvas
     * @param {Array<{ms:number,a1:number,a2:number}>} samples
     * @param {object} [opts] {windowMs=30000, nowMs=Date.now(), colors}
     */
    function drawStripChart(canvas, samples, opts) {
        if (!canvas || typeof canvas.getContext !== 'function') return false;
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        const o = opts || {};
        const W = canvas.width;
        const H = canvas.height;
        const windowMs = isNum(o.windowMs) ? o.windowMs : 30000;
        const now = isNum(o.nowMs) ? o.nowMs : Date.now();
        const colors = o.colors || {
            a1: '#00e676',
            a2: '#4fa8ff',
            grid: '#2d3640',
            zero: '#8b949e'
        };
        ctx.clearRect(0, 0, W, H);
        // grid: ±10, ±5 V; zero line brighter
        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = 1;
        for (const v of [-10000, -5000, 5000, 10000]) {
            const y = H - barFraction(v) * H;
            ctx.beginPath();
            ctx.moveTo(0, Math.round(y) + 0.5);
            ctx.lineTo(W, Math.round(y) + 0.5);
            ctx.stroke();
        }
        ctx.strokeStyle = colors.zero;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(H / 2) + 0.5);
        ctx.lineTo(W, Math.round(H / 2) + 0.5);
        ctx.stroke();
        const x = (ms) => W - ((now - ms) / windowMs) * W;
        for (const [key, color] of [
            ['a1', colors.a1],
            ['a2', colors.a2]
        ]) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let pen = false;
            for (const s of samples || []) {
                if (!isNum(s[key])) {
                    pen = false;
                    continue;
                }
                const px = x(s.ms);
                const py = H - barFraction(s[key]) * H;
                if (!pen) {
                    ctx.moveTo(px, py);
                    pen = true;
                } else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }
        return true;
    }

    const StudioAnalogIn = {
        FULL_SCALE_MV,
        AO_MAX_MV,
        AIN_FLAGS,
        formatMv,
        barFraction,
        describeFlags,
        median,
        createMonitor,
        createPoller,
        sweepPlan,
        fitLinear,
        summarizeSweep,
        sweepCsv,
        drawStripChart
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = StudioAnalogIn;
    global.StudioAnalogIn = StudioAnalogIn;
})(typeof window !== 'undefined' ? window : globalThis);
