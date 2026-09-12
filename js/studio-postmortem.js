/**
 * studio-postmortem.js — the controller-fault lifecycle for the Arena Studio
 * (firmware issue #50: the Mode-3 wedge). One place that knows what to do once
 * the session/runner have declared `controller_unresponsive`:
 *
 *   quiet period → confirmation probe → probe window → policy (halt | reset →
 *   reconnect → verify identity → post-reset probe)
 *
 * Every probe goes through `session.send` (so it is an ordinary `arena_command`
 * row in the run log, with a LONG timeout so the degraded round trip is measured
 * instead of cut off at 500 ms) AND is written as a typed `probe` event with the
 * decoded reply + raw hex, because the compact `["a", …]` rows carry no payload.
 *
 * Pure orchestration: no DOM. Injected `session`, `wire`, `now`, `sleep`, `log`
 * make it testable in Node. Classic dual-export (window global + CommonJS), no
 * bare ES `export` — loaded by the Studio's classic layer.
 */
(function (global) {
    'use strict';

    const DEFAULTS = {
        quietMs: 1000, // ≥ one 0x70 timeout window: let a late reply land, then flush rx
        confirmTimeoutMs: 2000,
        probeTimeoutMs: 5000,
        probeWindowMs: 60000, // sample the degraded controller for a minute
        probeEveryMs: 2000,
        resetTimeoutMs: 3000,
        resetSettleMs: 3000, // SYSRESETREQ → re-enumeration
        reconnectTimeoutMs: 15000,
        degradedDtMs: 50 // a reply slower than this counts as "degraded" in summaries
    };

    const hex = (u8) =>
        u8 && u8.length
            ? Array.from(u8)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join('')
            : '';

    /**
     * The probe set. `sd:true` marks commands that touch the card (the
     * hypothesis ladder separates SD-touching from RAM-only replies).
     * `cap` gates a probe on a 0xC2 capability name.
     */
    function probeSet(W) {
        const list = [
            {
                name: 'controller_info',
                enc: () => W.encodeGetControllerInfo(),
                dec: W.decodeControllerInfo
            },
            { name: 'frames_sent', enc: () => W.encodeGetFramesSent(), dec: W.decodeFramesSent },
            {
                name: 'frame_position',
                enc: () => W.encodeGetFramePosition(),
                dec: W.decodeFramePosition
            },
            { name: 'health', enc: () => W.encodeGetHealth(), dec: W.decodeHealth, cap: 'health' },
            // Build identity — so a post-mortem (and the post-reset probe) records
            // WHICH firmware wedged. Same capability gate as health.
            {
                name: 'firmware_version',
                enc: () => W.encodeGetFirmwareVersion(),
                dec: W.decodeFirmwareVersion,
                cap: 'health'
            },
            {
                name: 'pattern_info_1',
                enc: () => W.encodeGetPatternInfo(1),
                dec: W.decodePatternInfo,
                sd: true
            },
            // 0xE3 reads /firmware/panel.bin's footer: status 1 ("no image") is
            // the normal answer on a card without a panel image — we want its
            // LATENCY (SD.open + seek + read), not its payload.
            {
                name: 'firmware_info',
                enc: () => W.encodeGetFirmwareInfo(),
                dec: W.decodeFirmwareInfo,
                sd: true
            }
        ];
        return list.filter((p) => typeof p.enc === 'function');
    }

    /**
     * @param {object} deps
     * @param {object} deps.session   ArenaSession-like: send(bytes,{timeoutMs}), connected,
     *                                bridge (.logging/.log), flushRx(), reconnect(opts)
     * @param {object} deps.wire      ArenaWireG6
     * @param {function} [deps.log]   (msg, kind) → Console/rawLog line
     * @param {function} [deps.now]   monotonic ms clock (default performance.now / Date.now)
     * @param {function} [deps.sleep] (ms) → Promise (default setTimeout)
     * @param {object} [deps.opts]    overrides for DEFAULTS
     */
    function createPostmortem(deps) {
        const session = deps.session;
        const W = deps.wire;
        const opts = Object.assign({}, DEFAULTS, deps.opts || {});
        const now =
            deps.now ||
            (typeof performance !== 'undefined' && performance.now
                ? () => performance.now()
                : () => Date.now());
        const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        const say = deps.log || (() => {});
        let aborted = false;

        // One typed row into the bridge log (the durable record) + the Console.
        function record(ev) {
            const row = Object.assign({ event: 'probe' }, ev);
            try {
                if (
                    session.bridge &&
                    session.bridge.logging &&
                    typeof session.bridge.log === 'function'
                ) {
                    session.bridge.log(row);
                }
            } catch (_) {
                /* logging must never break the lifecycle */
            }
            return row;
        }

        async function sendProbe(p, phase, caps) {
            if (p.cap && caps && !caps.includes(p.cap)) {
                return { name: p.name, skipped: 'capability ' + p.cap + ' absent' };
            }
            let bytes;
            try {
                bytes = p.enc();
            } catch (e) {
                return { name: p.name, skipped: 'encoder: ' + (e && e.message) };
            }
            const t0 = now();
            const out = { name: p.name, phase, cmd: bytes[1], req: hex(bytes), sd: !!p.sd };
            try {
                const resp = await session.send(bytes, { timeoutMs: opts.probeTimeoutMs });
                out.dt = Math.round(now() - t0);
                out.resp = hex(resp);
                const d = W.decodeResponse(resp);
                out.status = d ? d.status : null;
                out.ok = !!(d && d.ok);
                try {
                    const decoded = p.dec ? p.dec(resp) : null;
                    if (decoded !== null && decoded !== undefined) out.decoded = decoded;
                } catch (_) {
                    /* undecodable payload — the raw hex is still recorded */
                }
            } catch (e) {
                out.dt = Math.round(now() - t0);
                out.status = null;
                out.ok = null;
                out.error = (e && e.message) || String(e);
            }
            record(out);
            return out;
        }

        function summarize(results) {
            const answered = results.filter(
                (r) => r.ok !== null && r.ok !== undefined && !r.skipped
            );
            const timeouts = results.filter((r) => r.error && /timeout/i.test(r.error)).length;
            const dts = answered.map((r) => r.dt).filter((v) => Number.isFinite(v));
            const max = dts.length ? Math.max.apply(null, dts) : null;
            const sdDts = answered.filter((r) => r.sd).map((r) => r.dt);
            const ramDts = answered.filter((r) => !r.sd).map((r) => r.dt);
            const med = (a) => {
                if (!a.length) return null;
                const s = a.slice().sort((x, y) => x - y);
                return s[Math.floor(s.length / 2)];
            };
            return {
                probes: results.length,
                answered: answered.length,
                timeouts,
                maxDt: max,
                medianDtSd: med(sdDts),
                medianDtRam: med(ramDts),
                degraded: max !== null && max > opts.degradedDtMs,
                unresponsive: answered.length === 0 && results.some((r) => !r.skipped)
            };
        }

        /** Stop an in-progress lifecycle at the next step boundary (operator STOP). */
        function abort() {
            aborted = true;
        }

        /**
         * Quiet period + rx flush: with no request id on the wire, a late reply
         * to an earlier 0x70 would otherwise be taken as the answer to the first
         * probe. Nothing is sent for `quietMs`, then buffered bytes are dropped.
         */
        async function quiet(ms) {
            await sleep(ms || opts.quietMs);
            const n = typeof session.flushRx === 'function' ? session.flushRx() : 0;
            record({ phase: 'quiet', quietMs: ms || opts.quietMs, flushedBytes: n });
            return n;
        }

        /** Confirmation: one 0xC2 with a generous timeout. Resolves {confirmed, result}. */
        async function confirm() {
            const t0 = now();
            const out = { name: 'controller_info', phase: 'confirm', cmd: 0xc2, req: '01c2' };
            let confirmed = false;
            let caps = null;
            let mac = null;
            try {
                const resp = await session.send(W.encodeGetControllerInfo(), {
                    timeoutMs: opts.confirmTimeoutMs
                });
                out.dt = Math.round(now() - t0);
                out.resp = hex(resp);
                const d = W.decodeResponse(resp);
                out.status = d ? d.status : null;
                out.ok = !!(d && d.ok);
                const info = W.decodeControllerInfo(resp);
                if (info) {
                    out.decoded = info;
                    caps = info.capabilities || [];
                    mac = info.mac || null;
                }
                // A reply that took longer than the normal 0x70 timeout is still a
                // wedge (a healthy controller answers 0xC2 in ~2 ms); only a fast,
                // ok reply clears the suspicion.
                confirmed = !(out.ok && out.dt < opts.degradedDtMs);
            } catch (e) {
                out.dt = Math.round(now() - t0);
                out.status = null;
                out.ok = null;
                out.error = (e && e.message) || String(e);
                confirmed = true;
            }
            record(out);
            return { confirmed, result: out, caps, mac };
        }

        /** One pass over the probe set. */
        async function probeOnce(phase, caps) {
            const results = [];
            for (const p of probeSet(W)) {
                if (aborted) break;
                results.push(await sendProbe(p, phase || 'probe', caps));
            }
            return results;
        }

        /** Repeated passes for `windowMs` (default probeWindowMs), every probeEveryMs. */
        async function probeWindow(caps, windowMs) {
            const end = now() + (windowMs != null ? windowMs : opts.probeWindowMs);
            const all = [];
            let pass = 0;
            do {
                if (aborted) break;
                const r = await probeOnce('window', caps);
                r.forEach((x) => (x.pass = pass));
                all.push.apply(all, r);
                pass++;
                if (now() >= end) break;
                await sleep(opts.probeEveryMs);
            } while (now() < end && !aborted);
            const summary = summarize(all);
            record({ phase: 'window-summary', passes: pass, summary });
            return { results: all, summary, passes: pass };
        }

        /**
         * The reset experiment: SYSTEM_RESET 0x01 (ack then SYSRESETREQ), settle,
         * reconnect from the granted ports, verify it is the SAME controller by
         * MAC, then the post-reset probe — whose `health.prevBreadcrumb` /
         * `resetCause` are the payload of the whole exercise.
         * @param {object} a {expectMac?: string}
         */
        async function resetAndReconnect(a) {
            a = a || {};
            const out = { phase: 'reset', steps: [] };
            const t0 = now();
            try {
                const resp = await session.send(W.encodeSystemReset(), {
                    timeoutMs: opts.resetTimeoutMs
                });
                const d = W.decodeResponse(resp);
                out.resetAck = !!(d && d.ok);
                out.resetDt = Math.round(now() - t0);
            } catch (e) {
                out.resetAck = false;
                out.resetDt = Math.round(now() - t0);
                out.resetError = (e && e.message) || String(e);
            }
            record(Object.assign({ name: 'system_reset' }, out));
            say(
                'SYSTEM_RESET sent (' +
                    (out.resetAck ? 'acked' : 'no ack') +
                    ') — waiting for re-enumeration',
                'warn'
            );
            await sleep(opts.resetSettleMs);
            const t1 = now();
            try {
                await session.reconnect({ timeoutMs: opts.reconnectTimeoutMs });
                out.reconnected = true;
                out.reconnectDt = Math.round(now() - t1);
            } catch (e) {
                out.reconnected = false;
                out.reconnectDt = Math.round(now() - t1);
                out.reconnectError = (e && e.message) || String(e);
                record(Object.assign({ name: 'reconnect' }, out));
                return out;
            }
            // Identity check — VID/PID names a product, the MAC names the unit.
            const c = await confirm();
            out.mac = c.mac;
            out.identityOk = !a.expectMac || !c.mac || c.mac === a.expectMac;
            if (!out.identityOk) {
                out.identityError = 'reconnected to ' + c.mac + ', expected ' + a.expectMac;
                say('⚠ ' + out.identityError, 'err');
            }
            out.post = await probeOnce('post-reset', c.caps);
            out.postSummary = summarize(out.post);
            const h = out.post.find((r) => r.name === 'health' && r.decoded);
            if (h) {
                out.prevBreadcrumb = h.decoded.prevBreadcrumbOp;
                out.resetCause = h.decoded.resetCause;
            }
            record(Object.assign({ name: 'reconnect' }, out));
            return out;
        }

        /**
         * The whole lifecycle after a declared fault.
         * @param {object} a {policy: 'halt'|'reset-continue', expectMac?, windowMs?, faultDetail?}
         * @returns {Promise<object>} {confirmed, window, reset?, outcome}
         */
        async function run(a) {
            a = a || {};
            aborted = false;
            const policy = a.policy === 'reset-continue' ? 'reset-continue' : 'halt';
            record({ phase: 'begin', policy, fault: a.faultDetail || null });
            await quiet();
            const c = await confirm();
            if (!c.confirmed) {
                record({ phase: 'end', outcome: 'transient', policy });
                say(
                    'controller answered the confirmation probe normally — transient stall, not a wedge',
                    'warn'
                );
                return { confirmed: false, outcome: 'transient' };
            }
            say(
                'controller fault CONFIRMED — probing for ' +
                    Math.round((a.windowMs != null ? a.windowMs : opts.probeWindowMs) / 1000) +
                    ' s',
                'err'
            );
            const win = await probeWindow(c.caps, a.windowMs);
            if (aborted) {
                record({ phase: 'end', outcome: 'operator-stop', policy });
                return { confirmed: true, window: win, outcome: 'operator-stop' };
            }
            if (policy === 'halt') {
                record({ phase: 'end', outcome: 'halted', policy });
                say(
                    'post-mortem complete — controller left as-is for inspection (halt policy)',
                    'err'
                );
                return { confirmed: true, window: win, outcome: 'halted' };
            }
            const reset = await resetAndReconnect({ expectMac: a.expectMac || c.mac });
            const recovered = !!(
                reset.reconnected &&
                reset.identityOk &&
                reset.postSummary &&
                !reset.postSummary.degraded &&
                reset.postSummary.answered > 0
            );
            record({ phase: 'end', outcome: recovered ? 'recovered' : 'reset-failed', policy });
            say(
                recovered
                    ? 'controller recovered after SYSTEM_RESET (prev breadcrumb: ' +
                          (reset.prevBreadcrumb || '?') +
                          ')'
                    : 'controller did NOT recover after SYSTEM_RESET — halting',
                recovered ? 'warn' : 'err'
            );
            return {
                confirmed: true,
                window: win,
                reset,
                outcome: recovered ? 'recovered' : 'reset-failed'
            };
        }

        return {
            run,
            quiet,
            confirm,
            probeOnce,
            probeWindow,
            resetAndReconnect,
            summarize,
            abort,
            opts
        };
    }

    const StudioPostmortem = { createPostmortem, DEFAULTS, probeSet };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioPostmortem;
    }
    if (typeof global !== 'undefined') {
        global.StudioPostmortem = StudioPostmortem;
    }
})(typeof window !== 'undefined' ? window : this);
