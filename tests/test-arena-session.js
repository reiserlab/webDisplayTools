#!/usr/bin/env node
/**
 * Tests for js/arena-session.js — the shared connection broker (Stage A),
 * exercised with FAKED link + runner (no hardware, no Web Serial). Pins the
 * contract both pages depend on:
 *   - one page-wide singleton (shared / _resetShared)
 *   - event multicast (on/off, unsubscribe, subscriber-throw isolation)
 *   - connect/disconnect lifecycle + 'state'/'disconnect' emission
 *   - involuntary disconnect aborts the runner WITHOUT a STOP send
 *   - run mechanism forwards runner status to 'runstatus' + per-call sink
 *   - runTrial/runSequence pre-empt an active run
 *
 * Run: node tests/test-arena-session.js   (wired into `npm test`)
 * Exits 0 on PASS, 1 on any FAIL.
 */

'use strict';

const ArenaSession = require('../js/arena-session.js');

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

// ── mocks ────────────────────────────────────────────────────────────────────
function makeMocks() {
    const calls = [];
    let cb = null; // the options object ArenaSession passes to `new ArenaLink(...)`
    class MockLink {
        constructor(c) {
            cb = c;
            this._open = false;
            this.sent = [];
        }
        static isSupported() {
            return true;
        }
        get connected() {
            return this._open;
        }
        async connect() {
            this._open = true;
            calls.push('link.connect');
        }
        async close() {
            this._open = false;
            calls.push('link.close');
        }
        send(bytes, opts) {
            this.sent.push([Array.from(bytes), opts]);
            calls.push('link.send');
            return Promise.resolve(new Uint8Array([1, 0, bytes[1] || 0]));
        }
        sendBulkRead(bytes, opts) {
            this.sent.push([Array.from(bytes), opts]);
            calls.push('link.sendBulkRead');
            return Promise.resolve(new Uint8Array(bytes));
        }
    }
    class MockRunner {
        constructor(link, wire) {
            this.link = link;
            this.wire = wire;
            this._active = false;
        }
        get active() {
            return this._active;
        }
        get conditionName() {
            return this._cn || null;
        }
        async start(a) {
            calls.push('runner.start');
            this.lastStart = a;
            this._active = true;
            if (a.onStatus) a.onStatus({ phase: 'running' });
            this._active = false;
            return { ok: true, kind: 'trial' };
        }
        async runSequence(a) {
            calls.push('runner.runSequence');
            this.lastSeq = a;
            if (a.onProgress) a.onProgress({ phase: 'sequence-complete' });
            return { completed: true };
        }
        async stop() {
            calls.push('runner.stop');
            this._active = false;
            return { ok: true, kind: 'stop' };
        }
        abort() {
            calls.push('runner.abort');
            this._active = false;
        }
    }
    return { calls, MockLink, RunnerLib: { ArenaRunner: MockRunner }, getCb: () => cb };
}

function newSession(m) {
    return new ArenaSession({ wire: { mark: 1 }, LinkClass: m.MockLink, RunnerLib: m.RunnerLib });
}

(async () => {
    // ── construction guards ───────────────────────────────────────────────────
    console.log('=== construction guards ===');
    {
        let threw = false;
        try {
            new ArenaSession({ LinkClass: null, RunnerLib: {} });
        } catch (_) {
            threw = true;
        }
        checkBool('throws when ArenaLink missing', threw);
    }
    {
        let threw = false;
        try {
            new ArenaSession({ LinkClass: makeMocks().MockLink, RunnerLib: null });
        } catch (_) {
            threw = true;
        }
        checkBool('throws when ArenaRunnerG6 missing', threw);
    }
    checkBool('isSupported() false in Node (no window)', ArenaSession.isSupported() === false);

    // ── singleton ─────────────────────────────────────────────────────────────
    console.log('=== singleton ===');
    {
        const m = makeMocks();
        ArenaSession._resetShared();
        const a = ArenaSession.shared({ LinkClass: m.MockLink, RunnerLib: m.RunnerLib });
        const b = ArenaSession.shared();
        checkBool('shared() returns the same instance', a === b);
        ArenaSession._resetShared();
        const c = ArenaSession.shared({ LinkClass: m.MockLink, RunnerLib: m.RunnerLib });
        checkBool('_resetShared() drops the singleton', c !== a);
    }

    // ── events: on/off, unsubscribe, multicast, throw isolation ────────────────
    console.log('=== events ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        let n1 = 0;
        let n2 = 0;
        const off1 = s.on('state', () => n1++);
        s.on('state', () => n2++);
        s._emit('state');
        check('both subscribers fired', [n1, n2], [1, 1]);
        off1();
        s._emit('state');
        check('unsubscribe stops only that handler', [n1, n2], [1, 2]);

        let unknownThrew = false;
        try {
            s.on('nope', () => {});
        } catch (_) {
            unknownThrew = true;
        }
        checkBool('on() rejects unknown event', unknownThrew);

        // A throwing non-'error' handler must not break siblings and should
        // surface on the 'error' channel.
        let sib = 0;
        let errSeen = 0;
        s.on('error', () => errSeen++);
        s.on('log', () => {
            throw new Error('boom');
        });
        s.on('log', () => sib++);
        s._emit('log', 'hi');
        checkBool('sibling handler still runs after a throw', sib === 1);
        checkBool('throw re-emitted on error channel', errSeen === 1);
    }

    // ── link callbacks fan out ─────────────────────────────────────────────────
    console.log('=== link callback fan-out ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        let logged = null;
        let erred = null;
        s.on('log', (msg) => (logged = msg));
        s.on('error', (e) => (erred = e && e.message));
        m.getCb().onLog('-> 01 67');
        m.getCb().onError(new Error('read fail'));
        check('onLog → log event', logged, '-> 01 67');
        check('onError → error event', erred, 'read fail');
    }

    // ── connect / disconnect lifecycle ─────────────────────────────────────────
    console.log('=== connect / disconnect ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        let states = 0;
        let disc = null;
        s.on('state', () => states++);
        s.on('disconnect', (d) => (disc = d));
        checkBool('starts disconnected', s.connected === false);
        await s.connect();
        checkBool('connected after connect()', s.connected === true);
        checkBool("connect() emits 'state'", states === 1);

        await s.disconnect();
        checkBool('disconnected after disconnect()', s.connected === false);
        check('user disconnect is involuntary:false', disc, { involuntary: false });
        checkBool("disconnect() emits a further 'state'", states === 2);
        check('voluntary disconnect closed the link', m.calls.includes('link.close'), true);
    }

    // ── disconnect stops an active run first ────────────────────────────────────
    console.log('=== disconnect stops active run ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        await s.connect();
        s._runner._active = true; // simulate a run in flight
        await s.disconnect();
        const i = m.calls.indexOf('runner.stop');
        const j = m.calls.indexOf('link.close');
        checkBool('runner.stop before link.close on disconnect', i >= 0 && j >= 0 && i < j);
    }

    // ── involuntary disconnect: abort WITHOUT stop ──────────────────────────────
    console.log('=== involuntary disconnect ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        let disc = null;
        s.on('disconnect', (d) => (disc = d));
        await s.connect();
        m.getCb().onDisconnect(); // cable-pull
        check('cable-pull is involuntary:true', disc, { involuntary: true });
        checkBool('cable-pull aborts the runner', m.calls.includes('runner.abort'));
        checkBool('cable-pull does NOT send STOP', !m.calls.includes('runner.stop'));
    }

    // ── send delegates to the link ──────────────────────────────────────────────
    console.log('=== send ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        const resp = await s.send(new Uint8Array([1, 0x67]), { timeoutMs: 99 });
        checkBool('send returns the response frame', resp instanceof Uint8Array);
        check('send forwarded bytes + opts', s._link.sent[0], [[1, 0x67], { timeoutMs: 99 }]);
    }

    // ── replay hardware-output interlock ────────────────────────────────────────
    console.log('=== hardware-output interlock ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        let states = 0;
        s.on('state', () => states++);
        checkBool('output starts enabled', s.outputInhibited === false);
        check('no initial inhibition reason', s.outputInhibitedReason, null);
        checkBool('enabling interlock reports a change', s.setOutputInhibited('replay') === true);
        checkBool('outputInhibited true in replay', s.outputInhibited === true);
        check('interlock retains reason', s.outputInhibitedReason, 'replay');
        checkBool('enabling same reason is idempotent', s.setOutputInhibited('replay') === false);
        checkBool('latch change emitted one state event', states === 1);

        const blocked = [];
        for (const [name, fn] of [
            ['connect', () => s.connect()],
            ['send', () => s.send(new Uint8Array([1, 0x67]))],
            ['bulk-read', () => s.sendBulkRead(new Uint8Array([1, 0x68]))],
            ['trial', () => s.runTrial({ params: { mode: 2, patternId: 1 } })],
            ['sequence', () => s.runSequence({ steps: [], conditionsByName: new Map() })],
            ['stop', () => s.stop()]
        ]) {
            try {
                await fn();
            } catch (e) {
                blocked.push([name, e && e.code, e && e.reason]);
            }
        }
        check('all hardware entry points blocked with coded reason', blocked, [
            ['connect', 'ARENA_OUTPUT_INHIBITED', 'replay'],
            ['send', 'ARENA_OUTPUT_INHIBITED', 'replay'],
            ['bulk-read', 'ARENA_OUTPUT_INHIBITED', 'replay'],
            ['trial', 'ARENA_OUTPUT_INHIBITED', 'replay'],
            ['sequence', 'ARENA_OUTPUT_INHIBITED', 'replay'],
            ['stop', 'ARENA_OUTPUT_INHIBITED', 'replay']
        ]);
        checkBool(
            'blocked calls reached neither link nor runner',
            !m.calls.some((c) => c.startsWith('link.') || c.startsWith('runner.'))
        );

        checkBool('clearing interlock reports a change', s.setOutputInhibited(null) === true);
        checkBool('output re-enabled', s.outputInhibited === false);
        check('reason cleared', s.outputInhibitedReason, null);
        await s.send(new Uint8Array([1, 0x67]));
        checkBool('normal send resumes after clear', m.calls.includes('link.send'));
        checkBool('clear emitted a second state event', states === 2);
    }
    {
        const m = makeMocks();
        const s = newSession(m);
        s._runner._active = true;
        let errorCode = null;
        try {
            s.setOutputInhibited('replay');
        } catch (e) {
            errorCode = e && e.code;
        }
        check('cannot enter replay while a run is active', errorCode, 'ARENA_RUN_ACTIVE');
        checkBool('failed enable leaves output live', s.outputInhibited === false);
    }
    {
        const m = makeMocks();
        const s = newSession(m);
        await s.connect();
        s.setOutputInhibited('replay');
        await s.disconnect();
        checkBool('disconnect remains available under interlock', s.connected === false);
        checkBool(
            'disconnect under interlock closes without a STOP',
            !m.calls.includes('runner.stop')
        );
    }
    {
        const m = makeMocks();
        const s = newSession(m);
        await s.connect();
        s.setOutputInhibited('replay');
        // Simulate a stale/injected runner reporting active after the replay latch
        // was set. Disconnect must still favor local abort over a forbidden STOP.
        s._runner._active = true;
        await s.disconnect();
        checkBool(
            'active runner discovered under interlock is aborted locally',
            m.calls.includes('runner.abort')
        );
        checkBool(
            'active runner discovered under interlock never sends STOP',
            !m.calls.includes('runner.stop')
        );
        checkBool('emergency disconnect still closes the link', m.calls.includes('link.close'));
    }

    // ── runTrial: forwards status, pre-empts active run ─────────────────────────
    console.log('=== runTrial ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        const seen = [];
        const broadcast = [];
        s.on('runstatus', (st) => broadcast.push(st.phase));
        const params = { mode: 2, patternId: 1 };
        await s.runTrial({
            params,
            durationSec: 5,
            conditionName: 'c1',
            onStatus: (st) => seen.push(st.phase)
        });
        check('runner.start got params/duration/name', s._runner.lastStart.params, params);
        check('per-call onStatus fired', seen, ['running']);
        check('status broadcast on runstatus', broadcast, ['running']);

        // pre-empt: an active run is stopped before the next start
        m.calls.length = 0;
        s._runner._active = true;
        await s.runTrial({ params });
        const i = m.calls.indexOf('runner.stop');
        const j = m.calls.indexOf('runner.start');
        checkBool('runTrial pre-empts active run (stop before start)', i >= 0 && i < j);
    }

    // ── _sanitizeRunStatus keeps conditional-LED provenance ────────────────────
    // The bridge run log (committed to the course repo) is built from sanitized
    // runstatus events. led-activation transitions must keep their ON/OFF flag +
    // brightness, and trial-running must keep the led_activation spec, so the log
    // is self-contained (regression: the allowlist dropped on/ledPercent/ledActivation
    // → the committed log had transition times but not whether the LED went on/off).
    console.log('=== runstatus sanitize: LED activation provenance ===');
    {
        const s = newSession(makeMocks());
        const t = s._sanitizeRunStatus({
            phase: 'led-activation',
            on: true,
            index: 60,
            ledPercent: 20
        });
        check('led-activation keeps phase', t.phase, 'led-activation');
        check('led-activation keeps on', t.on, true);
        check('led-activation keeps index', t.index, 60);
        check('led-activation keeps ledPercent', t.ledPercent, 20);
        const tr = s._sanitizeRunStatus({
            phase: 'trial-running',
            ledActivation: { level: 20, hysteresis: 3, on_ranges: [[50, 99]] }
        });
        check('trial-running keeps led_activation spec', tr.ledActivation, {
            level: 20,
            hysteresis: 3,
            on_ranges: [[50, 99]]
        });
        const apply = { variable: 'led_percent', old_value: 20, new_value: 40 };
        const record = {
            event: 'runtime_control_trial_parameters',
            resolved_variables: { led_percent: 40 }
        };
        check(
            'runtime apply provenance survives bridge sanitizer',
            s._sanitizeRunStatus({
                phase: 'runtime-control-applied',
                runtimeControlApply: apply
            }).runtimeControlApply,
            apply
        );
        check(
            'resolved trial record survives bridge sanitizer',
            s._sanitizeRunStatus({ phase: 'trial-resolved', runtimeRecord: record }).runtimeRecord,
            record
        );
    }

    // ── runSequence: forwards progress, pre-empts ───────────────────────────────
    console.log('=== runSequence ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        const prog = [];
        s.on('runstatus', (st) => prog.push(st.phase));
        const steps = [{ kind: 'ref' }];
        const conditionsByName = new Map();
        const summary = await s.runSequence({
            steps,
            conditionsByName,
            resolveCondition: () => null,
            onProgress: (st) => prog.push('cb:' + st.phase)
        });
        check('runner.runSequence got steps', s._runner.lastSeq.steps, steps);
        checkBool(
            'runSequence forwards resolveCondition hook',
            typeof s._runner.lastSeq.resolveCondition === 'function'
        );
        check('progress broadcast + per-call', prog, ['sequence-complete', 'cb:sequence-complete']);
        check('returns the runner summary', summary, { completed: true });
    }

    // ── stop delegates + emits state ────────────────────────────────────────────
    console.log('=== stop ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        let states = 0;
        s.on('state', () => states++);
        const r = await s.stop();
        check('stop returns runner result', r, { ok: true, kind: 'stop' });
        check('stop delegated to runner', m.calls.includes('runner.stop'), true);
        checkBool("stop emits 'state'", states === 1);
    }

    // ── running / runConditionName getters ──────────────────────────────────────
    console.log('=== getters ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        checkBool('running false initially', s.running === false);
        s._runner._active = true;
        s._runner._cn = 'cond_x';
        checkBool('running reflects runner.active', s.running === true);
        check('runConditionName reflects runner', s.runConditionName, 'cond_x');
    }

    // ── fw #50: runner sends are logged through the session; bridge fault → runner.fault
    console.log('\n=== runner link facade routes through session.send ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        await s.connect();
        checkBool('runner got a facade, not the bare link', s._runner.link !== s._link);
        checkBool('facade reports link connectivity', s._runner.link.connected === true);
        const before = s._link.sent.length;
        await s._runner.link.send(new Uint8Array([1, 0x30]), { timeoutMs: 7 });
        check('runner send reached the link with opts', s._link.sent[before], [
            [1, 0x30],
            { timeoutMs: 7 }
        ]);
        s.setOutputInhibited('replay');
        let blocked = null;
        try {
            s._runner.link.send(new Uint8Array([1, 0x30]));
        } catch (e) {
            blocked = e.code || e.message;
        }
        checkBool('runner send obeys the output interlock', blocked !== null, String(blocked));
        s.setOutputInhibited(null);
        await s.disconnect();
    }

    console.log('\n=== bridge fault → runner.fault + session fault event ===');
    {
        const m = makeMocks();
        class MockBridge {
            constructor(o) {
                this.o = o;
                this._h = {};
                this.logging = false;
                this.apply = false;
            }
            on(ev, fn) {
                (this._h[ev] = this._h[ev] || []).push(fn);
                return () => {};
            }
            emit(ev, ...a) {
                (this._h[ev] || []).forEach((fn) => fn(...a));
            }
            setApply() {}
            log() {}
        }
        const faults = [];
        m.RunnerLib.ArenaRunner.prototype.fault = function (reason, detail) {
            m.calls.push('runner.fault');
            this.lastFault = { reason, detail };
        };
        const s = new ArenaSession({
            wire: { mark: 1 },
            LinkClass: m.MockLink,
            RunnerLib: m.RunnerLib,
            BridgeClientLib: MockBridge
        });
        let states = 0;
        s.on('fault', (f) => faults.push(f));
        s.on('state', () => states++);
        const f = { kind: 'controller_unresponsive', failures: 3, window: 10 };
        s.bridge.emit('fault', f);
        checkBool('runner.fault called', m.calls.includes('runner.fault'));
        check('runner got reason + detail', s._runner.lastFault, {
            reason: 'controller_unresponsive',
            detail: f
        });
        check("session re-emits 'fault'", faults, [f]);
        checkBool("'state' emitted after fault", states >= 1);
        checkBool('runner.abort NOT used when fault() exists', !m.calls.includes('runner.abort'));
        delete m.RunnerLib.ArenaRunner.prototype.fault;
    }

    console.log('\n=== bridge applyFrame: a controller REJECT counts as an apply failure ===');
    {
        const m = makeMocks();
        let status = 0;
        m.MockLink.prototype.send = function (bytes, opts) {
            this.sent.push([Array.from(bytes), opts]);
            return Promise.resolve(new Uint8Array([2, status, bytes[1] || 0]));
        };
        class MockBridge {
            constructor(o) {
                this.applyFrame = o.applyFrame;
                this.logging = false;
            }
            on() {
                return () => {};
            }
            setApply() {}
        }
        const wire = {
            encodeSetFramePosition: (i) => new Uint8Array([3, 0x70, i & 0xff, i >> 8]),
            decodeResponse: (f) => ({ status: f[1], ok: f[1] === 0, echoCmd: f[2] })
        };
        const s = new ArenaSession({
            wire,
            LinkClass: m.MockLink,
            RunnerLib: m.RunnerLib,
            BridgeClientLib: MockBridge
        });
        await s.connect();
        let okResp = null;
        await s.bridge.applyFrame(7).then((r) => (okResp = r));
        checkBool('status 0 → applyFrame resolves', okResp instanceof Uint8Array);
        status = 1;
        let rejected = null;
        await s.bridge.applyFrame(8).catch((e) => (rejected = e));
        checkBool(
            'status 1 → applyFrame REJECTS',
            rejected instanceof Error,
            rejected && rejected.message
        );
        check('reject carries the status', rejected && rejected.status, 1);
        checkBool(
            'reject message names the command',
            /SET_FRAME_POSITION/.test(rejected && rejected.message)
        );
    }

    console.log('\n=== runstatus sanitizer keeps fault detail + terminal summary ===');
    {
        const m = makeMocks();
        const s = newSession(m);
        const out = s._sanitizeRunStatus({
            phase: 'aborted',
            summary: {
                completed: false,
                aborted: true,
                steps: 3,
                errors: 1,
                skipped: 0,
                fault: 'controller_unresponsive',
                stopAcked: false,
                extra: 'dropped'
            }
        });
        check('summary passthrough (allowlist)', out.summary, {
            completed: false,
            aborted: true,
            steps: 3,
            errors: 1,
            skipped: 0,
            fault: 'controller_unresponsive',
            stopAcked: false
        });
        const out2 = s._sanitizeRunStatus({ phase: 'fault', reason: 'x', detail: { failures: 3 } });
        check('fault detail passthrough', [out2.reason, out2.detail], ['x', { failures: 3 }]);
    }

    // ── summary ─────────────────────────────────────────────────────────────────

    console.log('\n=== send({silent:true}) skips the bridge command log ===');
    {
        const logged = [];
        const bridge = {
            logging: true,
            connected: true,
            log: (o) => logged.push(o),
            on: () => () => {}
        };
        const link = {
            connected: true,
            send: async () => Uint8Array.from([3, 0x00, 0xa9, 0]),
            setCallbacks() {},
            on() {
                return () => {};
            }
        };
        const m = makeMocks();
        const sess = new ArenaSession({
            wire: { mark: 1 },
            LinkClass: m.MockLink,
            RunnerLib: m.RunnerLib
        });
        sess._link = link;
        sess._bridge = bridge;
        await sess.send(Uint8Array.from([8, 0xa9, 0xff, 0xff, 0xff, 0xff, 0xb2, 0, 0]), {
            silent: true
        });
        await sess.send(Uint8Array.from([1, 0xc2]));
        await new Promise((r) => setTimeout(r, 5));
        check('silent send not logged, normal send logged', logged.length, 1);
        check(
            'logged one is the 0xC2',
            logged[0] && logged[0].head && logged[0].head.slice(0, 5),
            '01 c2'
        );
    }
    // ── LAB-303 S1: bridge lost mid-run → the runner decides, the page is told ──
    console.log("\n=== bridge 'lost' → runner.onBridgeLost + session 'bridgelost' ===");
    {
        class MockBridge {
            constructor() {
                this._h = {};
                this.logging = false;
            }
            on(ev, fn) {
                (this._h[ev] = this._h[ev] || []).push(fn);
                return () => {};
            }
            emit(ev, ...a) {
                (this._h[ev] || []).forEach((fn) => fn(...a));
            }
            setApply() {}
            log() {}
        }
        const mk = (proto) => {
            const m = makeMocks();
            Object.assign(m.RunnerLib.ArenaRunner.prototype, proto || {});
            const s = new ArenaSession({
                wire: { mark: 1 },
                LinkClass: m.MockLink,
                RunnerLib: m.RunnerLib,
                BridgeClientLib: MockBridge
            });
            const got = [];
            let states = 0;
            s.on('bridgelost', (e) => got.push(e));
            s.on('state', () => states++);
            return { m, s, got, states: () => states };
        };
        // (a) a runner that knows the policy
        {
            const t = mk({
                onBridgeLost(info) {
                    this.lostInfo = info;
                    return 'aborted';
                }
            });
            t.s._runner._active = true;
            const info = { code: 1006, apply: true };
            t.s.bridge.emit('lost', info);
            check('runner.onBridgeLost got the info', t.s._runner.lostInfo, info);
            check("session re-emits 'bridgelost' with the runner's action", t.got, [
                { info, action: 'aborted', running: true }
            ]);
            checkBool("'state' emitted", t.states() >= 1);
            delete t.m.RunnerLib.ArenaRunner.prototype.onBridgeLost;
        }
        // (b) a stale-cache runner without onBridgeLost: an ACTIVE run is stopped anyway
        {
            const t = mk();
            t.s._runner._active = true;
            t.s.bridge.emit('lost', { code: 1006 });
            checkBool('stale runner: stop() used', t.m.calls.includes('runner.stop'));
            check('stale runner: action aborted', t.got[0].action, 'aborted');
        }
        // (c) idle: nothing to stop, the page still hears it (Console closed loop)
        {
            const t = mk();
            t.s.bridge.emit('lost', { code: 1006, apply: true });
            checkBool('idle: no stop()', !t.m.calls.includes('runner.stop'));
            check('idle: action idle', t.got[0].action, 'idle');
            check('idle: info.apply passes through', t.got[0].info.apply, true);
        }
        // (d) runSequence forwards bridgeRequired; the sanitizer keeps the loss
        {
            const t = mk();
            await t.s.connect();
            await t.s.runSequence({ steps: [], conditionsByName: new Map(), bridgeRequired: true });
            check('runSequence forwards bridgeRequired', t.s._runner.lastSeq.bridgeRequired, true);
            const out = t.s._sanitizeRunStatus({
                phase: 'aborted',
                summary: {
                    aborted: true,
                    fault: null,
                    bridgeLost: { kind: 'bridge_lost', code: 1006 }
                }
            });
            check('sanitizer keeps summary.bridgeLost', out.summary.bridgeLost, {
                kind: 'bridge_lost',
                code: 1006
            });
            const ev = t.s._sanitizeRunStatus({ phase: 'bridge-lost', action: 'stopped' });
            check('sanitizer keeps the bridge-lost action', ev.action, 'stopped');
        }
    }

    console.log('\n=== end to end: bridge socket killed mid closed-loop epoch (ww18 step 5.7) ===');
    {
        const Runner = require('../js/arena-runner-g6.js');
        const Wire = require('../js/arena-wire-g6.js');
        const Client = require('../js/fictrac-bridge-client.js');
        const RunLog = require('../js/run-log.js');
        const Adapter = require('../js/studio-runlog-adapter.js');
        class FakeWS {
            constructor(url) {
                FakeWS.last = this;
                this.url = url;
                this.readyState = 0;
                this.sent = [];
            }
            send(s) {
                this.sent.push(JSON.parse(s));
            }
            close() {
                this.readyState = 3;
                if (this.onclose) this.onclose({ code: 1000, wasClean: true });
            }
        }
        class TestClient extends Client {
            constructor(o) {
                super(Object.assign({ WebSocketImpl: FakeWS }, o));
            }
        }
        class Link {
            constructor() {
                this._open = false;
                this.sent = [];
            }
            get connected() {
                return this._open;
            }
            async connect() {
                this._open = true;
            }
            async close() {
                this._open = false;
            }
            async send(bytes) {
                this.sent.push(Array.from(bytes));
                return new Uint8Array([0x02, 0x00, bytes[1]]); // OK ack, echo = cmd
            }
        }
        const s = new ArenaSession({
            wire: Wire,
            LinkClass: Link,
            RunnerLib: Runner,
            BridgeClientLib: TestClient
        });
        await s.connect();
        const bridge = s.bridge;
        bridge.connect('ws://localhost:8765');
        const ws = FakeWS.last;
        ws.readyState = 1;
        ws.onopen();
        bridge.setLogging(true);
        ws.onmessage({
            data: JSON.stringify({
                type: 'log_control_ack',
                enabled: true,
                level: 'behavior_v2',
                requested: 'behavior_v2',
                file: 'arena-log-20261015-153548-287.jsonl'
            })
        });
        const log = RunLog.createRunLog({ meta: { run_id: 'r1' }, intent: 'experiment' });
        let outcome = null;
        s.on('runstatus', (st) => {
            const r = Adapter.feedRunStatus(log, st);
            if (r.terminal) outcome = r.summary.outcome;
        });
        const lostEvents = [];
        s.on('bridgelost', (e) => lostEvents.push(e));
        const cl = {
            name: 'cl',
            commands: [
                {
                    type: 'controller',
                    command_name: 'trialParams',
                    mode: 3,
                    frame_rate: 0,
                    gain: 0,
                    frame_index: 0,
                    duration: 30,
                    pattern: 'p'
                },
                { type: 'plugin', plugin_name: 'fictrac', command_name: 'startClosedLoop' },
                { type: 'wait', duration: 30 },
                { type: 'plugin', plugin_name: 'fictrac', command_name: 'stopClosedLoop' }
            ]
        };
        const t0 = Date.now();
        const run = s.runSequence({
            steps: [{ kind: 'ref', conditionName: 'cl', label: 'cl', seqIdx: 0 }],
            conditionsByName: new Map([['cl', cl]]),
            resolvePatternId: () => 1,
            resolvePatternFrames: () => 20,
            fictracPluginNames: new Set(['fictrac'])
        });
        await new Promise((r) => setTimeout(r, 30));
        checkBool('closed loop live before the kill', bridge.apply === true && s.running);
        // A request waiting on the bridge when it dies (15 s timeout) must fail at once.
        let exportErr = null;
        const exp = bridge.exportLog(15000).catch((e) => (exportErr = e.message));
        // taskkill /F on the bridge: the socket closes; nobody called disconnect().
        ws.readyState = 3;
        ws.onclose({ code: 1006, reason: '', wasClean: false });
        const summary = await run;
        await exp;
        checkBool('run ended promptly (not after the 30 s epoch)', Date.now() - t0 < 2000);
        check('outcome recorded in the run log: BRIDGE_LOST', outcome, 'BRIDGE_LOST');
        check('runner summary outcome', RunLog.deriveOutcome(summary), 'BRIDGE_LOST');
        check(
            'loss names the run’s bridge file',
            summary.bridgeLost && summary.bridgeLost.logFile,
            'arena-log-20261015-153548-287.jsonl'
        );
        check(
            'page told: action aborted',
            lostEvents.map((e) => e.action),
            ['aborted']
        );
        checkBool(
            'pending export failed fast with "bridge lost"',
            /bridge lost/.test(exportErr),
            exportErr
        );
        check('closed loop is off', bridge.apply, false);
        check('run no longer active', s.running, false);
        checkBool(
            'the display got STOP over the (healthy) serial link',
            s._link.sent.some((b) => b[1] === 0x30)
        );
        checkBool('transcript shows the loss', /BRIDGE LOST/.test(log.toText()), log.toText());
    }

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
})();
