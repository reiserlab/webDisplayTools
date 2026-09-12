#!/usr/bin/env node
/**
 * Tests for js/studio-postmortem.js — the controller-fault lifecycle (fw #50)
 * with a FAKED session (no hardware, no Web Serial): quiet period + rx flush,
 * confirmation probe, probe window, halt vs reset-continue, MAC identity check,
 * typed `probe` rows into the bridge log.
 *
 * Run: node tests/test-studio-postmortem.js
 */
'use strict';

const PM = require('../js/studio-postmortem.js');
const Wire = require('../js/arena-wire-g6.js');

let totalChecks = 0;
let failures = 0;
function check(name, got, expected) {
    totalChecks++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`
    );
    if (!ok) failures++;
}
function checkBool(name, ok, info) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

// A controller model: answers by opcode with a configurable delay; `wedged`
// makes every reply take `slowMs` (> the probe threshold) or time out.
function makeSession(model) {
    const rows = [];
    const sent = [];
    let clock = 0;
    const session = {
        connected: true,
        bridge: { logging: true, log: (o) => rows.push(o) },
        flushed: 0,
        flushRx() {
            this.flushed++;
            return 3;
        },
        reconnectCalls: 0,
        async reconnect() {
            this.reconnectCalls++;
            if (model.reconnectFails) throw new Error('reconnect: no granted port came back');
            model.afterReset && model.afterReset();
            this.connected = true;
            return {};
        },
        async send(bytes, opts) {
            const cmd = bytes[1];
            sent.push({ cmd, timeoutMs: opts && opts.timeoutMs });
            const r = model.reply(cmd, opts);
            if (r === 'timeout') {
                clock += (opts && opts.timeoutMs) || 500;
                throw new Error(
                    'response timeout after ' +
                        ((opts && opts.timeoutMs) || 500) +
                        ' ms (cmd 0x' +
                        cmd.toString(16) +
                        ')'
                );
            }
            clock += r.dt || 2;
            return r.frame;
        }
    };
    const deps = {
        session,
        wire: Wire,
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
        },
        log: () => {}
    };
    return { session, rows, sent, deps, tick: (ms) => (clock += ms) };
}

const ok = (cmd, payload) =>
    Uint8Array.from([2 + (payload || []).length, 0x00, cmd].concat(payload || []));
const macA = [0x04, 0xe9, 0xe5, 0x12, 0x91, 0xc0];
const infoFrame = (mac, cap) => ok(0xc2, [2, cap == null ? 0xa3 : cap].concat(mac || macA));
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
function healthFrame(fields) {
    const f = Object.assign(
        { prevBreadcrumb: 0, prevSlowOp: 1, prevSlowUs: 1300000, resetCause: 0x00000800 },
        fields || {}
    );
    const p = [1, 0x03].concat(
        u32(1000),
        u32(500),
        u32(4000),
        u32(300),
        u32(10),
        u32(2000),
        [0],
        u32(0),
        u32(7),
        u32(9),
        u32(11),
        [4],
        [5, 0],
        u32(f.resetCause),
        [f.prevBreadcrumb],
        u32(123),
        [0x01, f.prevSlowOp],
        u32(f.prevSlowUs),
        [2],
        u32(4200)
    );
    return ok(0xca, p);
}

// Healthy controller: every reply fast and ok.
function healthyModel() {
    return {
        reply(cmd) {
            if (cmd === 0xc2) return { frame: infoFrame(), dt: 2 };
            if (cmd === 0xca) return { frame: healthFrame(), dt: 2 };
            if (cmd === 0x33) return { frame: ok(0x33, u32(1234)), dt: 1 };
            if (cmd === 0x72) return { frame: ok(0x72, [5, 0, 200, 0]), dt: 1 };
            if (cmd === 0x01) return { frame: ok(0x01), dt: 2 };
            return { frame: ok(cmd), dt: 1 };
        }
    };
}
// Wedged controller: every reply slow (300 ms) or, when `dead`, timing out.
function wedgedModel(opts) {
    opts = opts || {};
    const m = {
        wedged: true,
        reply(cmd) {
            if (!m.wedged) return healthyModel().reply(cmd);
            if (opts.dead) return 'timeout';
            const h = healthyModel().reply(cmd);
            return { frame: h.frame, dt: opts.slowMs || 300 };
        },
        afterReset() {
            if (!opts.stayWedged) m.wedged = false;
        }
    };
    return m;
}

(async () => {
    console.log('=== transient stall: confirmation probe answers fast → no lifecycle ===');
    {
        const t = makeSession(healthyModel());
        const pm = PM.createPostmortem(t.deps);
        const res = await pm.run({ policy: 'reset-continue' });
        check('outcome transient', res.outcome, 'transient');
        check('quiet period flushed rx', t.session.flushed, 1);
        check(
            'only the confirmation 0xC2 was sent',
            t.sent.map((s) => s.cmd),
            [0xc2]
        );
        check('confirmation used the long timeout', t.sent[0].timeoutMs, 2000);
        check(
            'phases logged',
            t.rows.map((r) => r.phase),
            ['begin', 'quiet', 'confirm', 'end']
        );
        checkBool('no reset attempted', t.session.reconnectCalls === 0);
    }

    console.log('\n=== wedged (slow replies), halt policy: probe window, no reset ===');
    {
        const t = makeSession(wedgedModel({ slowMs: 300 }));
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 5000, probeEveryMs: 2000 } })
        );
        const res = await pm.run({ policy: 'halt', faultDetail: { failures: 3 } });
        check('outcome halted', res.outcome, 'halted');
        checkBool('confirmed (slow ok reply is still a wedge)', res.confirmed === true);
        checkBool(
            'several probe passes ran',
            res.window.passes >= 2,
            'passes=' + res.window.passes
        );
        const names = t.rows.filter((r) => r.phase === 'window').map((r) => r.name);
        checkBool(
            'probe set covers RAM + SD commands',
            names.includes('frames_sent') &&
                names.includes('pattern_info_1') &&
                names.includes('firmware_info')
        );
        checkBool('health probed (capability present)', names.includes('health'));
        const probes = t.rows.filter((r) => r.phase === 'window' && r.dt != null);
        checkBool(
            'probes used 5 s timeouts',
            t.sent
                .filter((s) => s.cmd !== 0xc2 || s.timeoutMs === 5000)
                .every((s) => s.timeoutMs === 5000 || s.timeoutMs === 2000)
        );
        checkBool(
            'probe rows carry raw reply hex + decoded payload',
            probes.every((r) => typeof r.resp === 'string') && probes.some((r) => r.decoded)
        );
        check('window summary flags degraded', res.window.summary.degraded, true);
        check('window summary max dt', res.window.summary.maxDt, 300);
        checkBool(
            'SD vs RAM medians both reported',
            res.window.summary.medianDtSd === 300 && res.window.summary.medianDtRam === 300
        );
        checkBool(
            'no reset attempted under halt',
            !t.sent.some((s) => s.cmd === 0x01) && t.session.reconnectCalls === 0
        );
        checkBool(
            'begin row records the fault detail',
            t.rows[0].fault && t.rows[0].fault.failures === 3
        );
    }

    console.log('\n=== wedged (dead), halt: everything times out, summary says unresponsive ===');
    {
        const t = makeSession(wedgedModel({ dead: true }));
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 1000, probeEveryMs: 500 } })
        );
        const res = await pm.run({ policy: 'halt' });
        check('outcome halted', res.outcome, 'halted');
        check('unresponsive', res.window.summary.unresponsive, true);
        checkBool('timeouts counted', res.window.summary.timeouts > 0);
        const probe = t.rows.find((r) => r.phase === 'window');
        check(
            'timed-out probe row: status/ok null + error',
            [probe.status, probe.ok, /timeout/.test(probe.error)],
            [null, null, true]
        );
    }

    console.log('\n=== wedged, reset-continue: reset → reconnect → MAC verified → recovered ===');
    {
        const t = makeSession(wedgedModel({ slowMs: 200 }));
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 1000, probeEveryMs: 500 } })
        );
        const res = await pm.run({ policy: 'reset-continue' });
        check('outcome recovered', res.outcome, 'recovered');
        checkBool(
            'SYSTEM_RESET sent with its own timeout',
            t.sent.some((s) => s.cmd === 0x01 && s.timeoutMs === 3000)
        );
        check('reconnect called once', t.session.reconnectCalls, 1);
        check('identity verified against the pre-reset MAC', res.reset.identityOk, true);
        check(
            'post-reset probe surfaces the previous boot slowest op',
            res.reset.prevSlowOp === undefined ? res.reset.prevBreadcrumb : res.reset.prevSlowOp,
            'idle'
        );
        checkBool('post-reset summary not degraded', res.reset.postSummary.degraded === false);
        const end = t.rows[t.rows.length - 1];
        check('end row', [end.phase, end.outcome], ['end', 'recovered']);
        const rr = t.rows.find((r) => r.name === 'reconnect');
        checkBool('reconnect row carries resetCause + breadcrumb', rr && rr.resetCause === 0x800);
    }

    console.log('\n=== reset-continue but the controller stays wedged → reset-failed ===');
    {
        const t = makeSession(wedgedModel({ slowMs: 300, stayWedged: true }));
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 1000, probeEveryMs: 500 } })
        );
        const res = await pm.run({ policy: 'reset-continue' });
        check('outcome reset-failed', res.outcome, 'reset-failed');
        check('post-reset still degraded', res.reset.postSummary.degraded, true);
    }

    console.log('\n=== reconnect fails → reset-failed, no identity claim ===');
    {
        const m = wedgedModel({ slowMs: 300 });
        m.reconnectFails = true;
        const t = makeSession(m);
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 1000, probeEveryMs: 500 } })
        );
        const res = await pm.run({ policy: 'reset-continue' });
        check('outcome reset-failed', res.outcome, 'reset-failed');
        check('reconnected false', res.reset.reconnected, false);
        checkBool('reconnect error recorded', /no granted port/.test(res.reset.reconnectError));
    }

    console.log(
        '\n=== MAC-less controller_info after reconnect → identity NOT ok (expected MAC) ==='
    );
    {
        const m = wedgedModel({ slowMs: 300 });
        const base = m.reply.bind(m);
        m.afterReset = () => {
            m.wedged = false;
            // 0xC2 answers but without the MAC bytes (older-firmware shape)
            m.reply = (cmd) => (cmd === 0xc2 ? { frame: ok(0xc2, [2, 0xa3]), dt: 2 } : base(cmd));
        };
        const t = makeSession(m);
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 1000, probeEveryMs: 500 } })
        );
        const res = await pm.run({ policy: 'reset-continue', expectMac: '04:e9:e5:1e:88:ec' });
        check('outcome reset-failed (no MAC to verify)', res.outcome, 'reset-failed');
        check('identityOk false', res.reset.identityOk, false);
        checkBool(
            'identity error names the missing MAC',
            /no MAC|expected/.test(res.reset.identityError)
        );
    }

    console.log('\n=== post-reset: one probe answers, the rest time out → NOT recovered ===');
    {
        const m = wedgedModel({ slowMs: 300 });
        const base = m.reply.bind(m);
        m.afterReset = () => {
            m.wedged = false;
            // controller_info + frames_sent answer; everything else is dead
            m.reply = (cmd) => (cmd === 0xc2 || cmd === 0x33 ? base(cmd) : 'timeout');
        };
        const t = makeSession(m);
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 1000, probeEveryMs: 500 } })
        );
        const res = await pm.run({ policy: 'reset-continue' });
        check('outcome reset-failed (timeouts after reset)', res.outcome, 'reset-failed');
        checkBool('post-reset timeouts counted', res.reset.postSummary.timeouts > 0);
        check('answered > 0 alone does not recover', res.reset.postSummary.answered > 0, true);
    }

    console.log(
        '\n=== capabilities unknown (0xC2 dead) → capability-gated probes are SKIPPED, not sent ==='
    );
    {
        const t = makeSession(wedgedModel({ dead: true }));
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 1000, probeEveryMs: 500 } })
        );
        await pm.run({ policy: 'halt' });
        const sentCmds = t.sent.map((x) => x.cmd);
        check('no GET_HEALTH (0xCA) sent blind', sentCmds.includes(0xca), false);
        check('no GET_FIRMWARE_VERSION (0xCB) sent blind', sentCmds.includes(0xcb), false);
        checkBool(
            'skip reason recorded',
            t.rows.some((r) => r && r.skipped === 'capabilities unknown')
        );
    }

    console.log(
        '\n=== link dropped after the fault (hardware watchdog reboot) → self-reset path ==='
    );
    {
        const m = wedgedModel({ slowMs: 300 });
        const t = makeSession(m);
        t.session.connected = false; // the controller re-enumerated on its own
        let afterReconnectCalls = 0;
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, {
                afterReconnect: async () => {
                    afterReconnectCalls++;
                    return { records: 3 };
                },
                opts: { probeWindowMs: 1000, probeEveryMs: 500 }
            })
        );
        const res = await pm.run({ policy: 'halt' }); // policy irrelevant: it already reset
        check('outcome self-reset', res.outcome, 'self-reset');
        check('recovered', res.recovered, true);
        check(
            'no SYSTEM_RESET was sent',
            t.sent.some((x) => x.cmd === 0x01),
            false
        );
        check('reconnect attempted once', t.session.reconnectCalls, 1);
        check('evidence hook (ring drain) ran once', afterReconnectCalls, 1);
        checkBool('health probe ran before the post probes', !!res.reset.health);
        checkBool(
            'self_reset row recorded',
            t.rows.some((r) => r && r.name === 'self_reset')
        );
    }

    console.log('\n=== wrong controller after reconnect → identity error ===');
    {
        const m = wedgedModel({ slowMs: 300 });
        const other = [0x04, 0xe9, 0xe5, 0x1e, 0x88, 0xec];
        const base = m.reply.bind(m);
        m.afterReset = () => {
            m.wedged = false;
            m.reply = (cmd) => (cmd === 0xc2 ? { frame: infoFrame(other), dt: 2 } : base(cmd));
        };
        const t = makeSession(m);
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 1000, probeEveryMs: 500 } })
        );
        const res = await pm.run({ policy: 'reset-continue', expectMac: '04:E9:E5:12:91:C0' });
        check('identity mismatch detected', res.reset.identityOk, false);
        check('outcome not recovered', res.outcome, 'reset-failed');
    }

    console.log('\n=== operator abort mid-window ===');
    {
        const t = makeSession(wedgedModel({ slowMs: 300 }));
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 60000, probeEveryMs: 2000 } })
        );
        // Abort right after the first probe pass by hooking the session send.
        let n = 0;
        const orig = t.session.send.bind(t.session);
        t.session.send = async (b, o) => {
            n++;
            if (n === 4) pm.abort();
            return orig(b, o);
        };
        const res = await pm.run({ policy: 'reset-continue' });
        check('outcome operator-stop', res.outcome, 'operator-stop');
        checkBool('no reset after operator stop', !t.sent.some((s) => s.cmd === 0x01));
    }

    console.log('\n=== probe set skips capability-gated health on old firmware ===');
    {
        const m = healthyModel();
        m.reply = ((base) => (cmd) =>
            cmd === 0xc2 ? { frame: infoFrame(macA, 0x23), dt: 300 } : base(cmd))(m.reply);
        const t = makeSession(m);
        const pm = PM.createPostmortem(
            Object.assign({}, t.deps, { opts: { probeWindowMs: 500, probeEveryMs: 500 } })
        );
        const res = await pm.run({ policy: 'halt' });
        const h = res.window.results.find((r) => r.name === 'health');
        checkBool(
            'health probe skipped without capability bit 7',
            h && /capability/.test(h.skipped)
        );
        checkBool('0xCA never sent', !t.sent.some((s) => s.cmd === 0xca));
    }

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
