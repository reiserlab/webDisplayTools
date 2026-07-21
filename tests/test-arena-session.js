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

    // ── summary ─────────────────────────────────────────────────────────────────
    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
})();
