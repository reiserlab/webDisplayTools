/**
 * test-fictrac-bridge-client.js — the shared FicTrac bridge client
 * (js/fictrac-bridge-client.js). No WebSocket / browser: we drive handleFrame()
 * directly and inject a controllable applyFrame to exercise the coalesced,
 * single-flight apply loop (the load-bearing behavior the console proved).
 */
'use strict';

const FicTracBridgeClient = require('../js/fictrac-bridge-client.js');

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
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
    console.log('=== coalesced single-flight apply loop (newest index wins) ===');
    {
        const applied = [];
        const gates = [];
        const client = new FicTracBridgeClient({
            applyFrame: (i) =>
                new Promise((res) => {
                    applied.push(i);
                    gates.push(res);
                }),
            clampFrame: (i) => i
        });
        client.setApply(true);
        client.handleFrame(1); // starts drain → applyFrame(1) in flight
        client.handleFrame(2); // in flight ⇒ just coalesces pending
        client.handleFrame(3); // supersedes 2 ⇒ pending = 3
        await tick();
        check('only frame 1 in flight so far', applied, [1]);
        gates[0](); // resolve applyFrame(1) → loop picks up pending (3), skips 2
        await tick();
        gates[1](); // resolve applyFrame(3)
        await tick();
        check('applied newest-wins (1 then 3, 2 dropped)', applied, [1, 3]);
        const s = client.stats;
        check('recv counts every frame', s.recv, 3);
        check('applied counts only sent', s.applied, 2);
        check('drop = recv - applied', s.drop, 1);
    }

    console.log('\n=== apply gate: setApply(false) does not drive ===');
    {
        const applied = [];
        const client = new FicTracBridgeClient({
            applyFrame: (i) => {
                applied.push(i);
                return Promise.resolve();
            }
        });
        client.handleFrame(5); // apply is off by default
        await tick();
        check('no apply while apply off', applied, []);
        client.setApply(true);
        client.handleFrame(7);
        await tick();
        check('applies once enabled', applied, [7]);
    }

    console.log("\n=== 'apply' event fires on setApply transitions (closed-loop indicator) ===");
    {
        const client = new FicTracBridgeClient({});
        const events = [];
        client.on('apply', (on) => events.push(on));
        client.setApply(true); // false → true
        client.setApply(true); // no change → no event
        client.setApply(false); // true → false
        check('apply event only on change', events, [true, false]);
        checkBool('apply getter reflects state', client.apply === false);
    }

    console.log('\n=== canApply gate blocks + emits blocked ===');
    {
        const applied = [];
        let allow = false;
        let blocked = 0;
        const client = new FicTracBridgeClient({
            applyFrame: (i) => {
                applied.push(i);
                return Promise.resolve();
            },
            canApply: () => allow,
            now: () => 100000 // stable clock so the 500ms throttle doesn't fire twice
        });
        client.on('blocked', () => blocked++);
        client.setApply(true);
        client.handleFrame(1);
        await tick();
        check('blocked: nothing applied', applied, []);
        checkBool('blocked event emitted', blocked >= 1);
        allow = true;
        client.handleFrame(2);
        await tick();
        check('applies once canApply true', applied, [2]);
    }

    console.log('\n=== events + setters + disconnected no-ops ===');
    {
        const frames = [];
        const appliedEv = [];
        const client = new FicTracBridgeClient({});
        client.setApplyFrame((i) => {
            appliedEv.push(i);
            return Promise.resolve();
        });
        client.on('frame', (i) => frames.push(i));
        client.on('applied', (i) => appliedEv.push('ev:' + i));
        client.setApply(true);
        client.handleFrame(9);
        await tick();
        check('frame event fired', frames, [9]);
        checkBool('applied event fired', appliedEv.includes('ev:9'));
        // disconnected: config/log must not throw and must not "send"
        checkBool('not connected initially', client.connected === false);
        client.setConfig({ gain: 2.5, frames: 60 });
        check('config merged locally', client.config.gain, 2.5);
        check('frames merged locally', client.config.frames, 60);
        client.setLogging(true);
        checkBool('logging flag set even offline', client.logging === true);
        client.log({ event: 'x' }); // no throw when disconnected
        checkBool('log() offline is a no-op (no throw)', true);
    }

    console.log('\n=== behavior_v1 sample event ===');
    {
        const samples = [];
        const frames = [];
        const client = new FicTracBridgeClient({});
        client.on('sample', (s) => samples.push(s));
        client.on('frame', (i) => frames.push(i));
        // A full bridge frame message carries the behavior_v1 fields → 'sample'.
        client.handleFrame(42, {
            type: 'frame',
            index: 42,
            seq: 7,
            t: 1000,
            ms: 500,
            fc: 7,
            idx: 42,
            ft: 123.4,
            x: 0.1,
            y: 0.2,
            hd: 0.3
        });
        check('frame event still fires', frames, [42]);
        checkBool('sample event fired', samples.length === 1, JSON.stringify(samples));
        check('sample carries hd', samples[0] && samples[0].hd, 0.3);
        check('sample carries ft', samples[0] && samples[0].ft, 123.4);
        check('sample carries idx', samples[0] && samples[0].idx, 42);
        check('sample carries fc', samples[0] && samples[0].fc, 7);
        // An index-only frame (older bridge, no kinematic fields) → NO 'sample'.
        client.handleFrame(43);
        check('no sample without kinematic fields', samples.length, 1);
        check('frame still fired for index-only', frames, [42, 43]);
    }

    console.log('\n=== non-finite frame ignored ===');
    {
        const applied = [];
        const client = new FicTracBridgeClient({
            applyFrame: (i) => {
                applied.push(i);
                return Promise.resolve();
            }
        });
        client.setApply(true);
        client.handleFrame(NaN);
        client.handleFrame(undefined);
        await tick();
        check('non-finite indices ignored', applied, []);
        check('recv not incremented', client.stats.recv, 0);
    }

    // Minimal WebSocket double for the export request/response pair.
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
            if (this.onclose) this.onclose();
        }
        open() {
            this.readyState = 1;
            if (this.onopen) this.onopen();
        }
        message(obj) {
            if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
        }
    }

    console.log('\n=== exportLog (log_export request/response) ===');
    {
        const client = new FicTracBridgeClient({ WebSocketImpl: FakeWS });
        // disconnected ⇒ immediate reject
        let rejected = null;
        await client.exportLog().catch((e) => (rejected = e.message));
        checkBool('disconnected export rejects', /not connected/.test(rejected), rejected);

        client.connect('ws://localhost:8765');
        const ws = FakeWS.last;
        ws.open();
        const p1 = client.exportLog(5000);
        const p2 = client.exportLog(5000);
        checkBool('single-in-flight shares the promise', p1 === p2, 'same promise');
        checkBool(
            'log_export sent once',
            ws.sent.filter((m) => m.type === 'log_export').length === 1,
            JSON.stringify(ws.sent)
        );
        ws.message({ type: 'log_export_result', name: 'arena-log-x.jsonl', content: '{"a":1}\n' });
        const got = await p1;
        check('resolves name', got.name, 'arena-log-x.jsonl');
        check('resolves content', got.content, '{"a":1}\n');

        // a second export after settle sends a fresh request
        const p3 = client.exportLog(5000);
        checkBool(
            'new request after settle',
            ws.sent.filter((m) => m.type === 'log_export').length === 2,
            'sent again'
        );
        ws.message({ type: 'log_export_result', error: 'no log file has been written' });
        let err3 = null;
        await p3.catch((e) => (err3 = e.message));
        checkBool('bridge error rejects', /no log file/.test(err3), err3);

        // timeout path
        const p4 = client.exportLog(10);
        let err4 = null;
        await p4.catch((e) => (err4 = e.message));
        checkBool('timeout rejects', /timed out/.test(err4), err4);

        // disconnect-while-pending path
        const p5 = client.exportLog(5000);
        ws.close();
        let err5 = null;
        await p5.catch((e) => (err5 = e.message));
        checkBool('disconnect rejects pending export', /disconnected/.test(err5), err5);
        client.disconnect();
    }

    console.log('\n=== log level (behavior_v1 default / full override) ===');
    {
        const client = new FicTracBridgeClient({ WebSocketImpl: FakeWS });
        client.connect('ws://localhost:8765');
        const ws = FakeWS.last;
        ws.open();
        const lastEnable = () => ws.sent.filter((m) => m.type === 'log_control' && m.enabled).pop();
        client.setLogging(true);
        check('setLogging asserts default level behavior_v1', lastEnable().level, 'behavior_v1');
        client.setLogLevel('full');
        client.setLogging(true);
        check('setLogLevel(full) → level full', lastEnable().level, 'full');
        client.setLogLevel('bogus'); // ignored
        client.setLogging(true);
        check('unknown level ignored (stays full)', lastEnable().level, 'full');
        client.setLogging(false);
        const off = ws.sent[ws.sent.length - 1];
        checkBool(
            'disabling sends log_control without a level',
            off.type === 'log_control' && off.enabled === false && off.level === undefined,
            JSON.stringify(off)
        );
    }

    console.log('\n=== bias waveform config (LAB-185) ===');
    {
        const client = new FicTracBridgeClient({ WebSocketImpl: FakeWS });
        client.connect('ws://localhost:8765');
        const ws = FakeWS.last;
        ws.open();
        const lastCfg = () => ws.sent.filter((m) => m.type === 'config').pop();

        // Nothing pushed until a bias is set — an old bridge must be unaffected.
        check('bias absent before it is ever set', client.bias, null);
        checkBool(
            'no bias key in the connect-time config',
            lastCfg().bias === undefined,
            JSON.stringify(lastCfg())
        );

        // THE regression this guards: `bias` is the one OBJECT-valued config key, and
        // sendConfig() gates the scalars on Number.isFinite — an object would be dropped.
        const seen = [];
        client.on('bias', (b) => seen.push(b));
        client.setConfig({ bias: { type: 'sine', amplitude: 90, frequency: 0.5 } });
        check('object-valued bias survives setConfig', lastCfg().bias, {
            type: 'sine',
            amplitude: 90,
            frequency: 0.5
        });
        check("'bias' event fired with the normalized spec", seen, [
            { type: 'sine', amplitude: 90, frequency: 0.5 }
        ]);
        check('bias getter reflects it', client.bias.type, 'sine');

        // Scalars still work alongside it, and still gate on finiteness.
        client.setConfig({ gain: 3.6, frames: 60 });
        check('scalars pushed alongside bias', [lastCfg().gain, lastCfg().frames], [3.6, 60]);
        check('bias persists across a scalar-only setConfig', lastCfg().bias.type, 'sine');
        client.setConfig({ gain: NaN });
        checkBool(
            'non-finite scalar omitted from the push',
            lastCfg().gain === undefined,
            JSON.stringify(lastCfg())
        );
        checkBool('bias still rides along', lastCfg().bias.type === 'sine', 'bias intact');
        client.setConfig({ gain: 3.6 }); // restore for the checks below

        // Coercion: string scalars from YAML/DOM must become numbers.
        client.setConfig({ bias: { type: 'square', amplitude: '30', frequency: '2' } });
        check('string amplitude/frequency coerced', lastCfg().bias, {
            type: 'square',
            amplitude: 30,
            frequency: 2
        });

        // Re-pushing the SAME waveform must still reach the bridge (it re-zeros the
        // phase clock there, which is how each closed-loop epoch restarts at phase 0)
        // even though no 'bias' event fires, since nothing changed.
        const before = seen.length;
        const sentBefore = ws.sent.filter((m) => m.type === 'config').length;
        client.setConfig({ bias: { type: 'square', amplitude: 30, frequency: 2 } });
        checkBool(
            'identical bias still pushed (phase reset)',
            ws.sent.filter((m) => m.type === 'config').length === sentBefore + 1,
            'config resent'
        );
        check('no bias event when unchanged', seen.length, before);

        // stopClosedLoop's clear: {type:'none'} must be SENT (not omitted), so the
        // bridge stops integrating instead of leaking the waveform into later trials.
        client.setConfig({ bias: { type: 'none' } });
        check('type none is pushed, not dropped', lastCfg().bias, {
            type: 'none',
            amplitude: 0,
            frequency: 0
        });
        check("'bias' event fired for the clear", seen[seen.length - 1].type, 'none');

        // Explicit null clears it entirely (nothing more pushed).
        client.setBias(null);
        check('setBias(null) clears', client.bias, null);
        checkBool(
            'cleared bias omitted from config',
            lastCfg().bias === undefined,
            JSON.stringify(lastCfg())
        );

        // Reconnect must re-assert the bias, or a mid-run bridge restart would
        // silently drop the disturbance.
        client.setBias({ type: 'constant', amplitude: 45 });
        client.disconnect();
        client.connect('ws://localhost:8765');
        const ws2 = FakeWS.last;
        ws2.open();
        const cfg2 = ws2.sent.filter((m) => m.type === 'config').pop();
        check('bias re-sent on reconnect', cfg2.bias, {
            type: 'constant',
            amplitude: 45,
            frequency: 0
        });
        client.disconnect();
    }

    console.log('\n=== live bias angle from the frame message ===');
    {
        const client = new FicTracBridgeClient({ applyFrame: () => Promise.resolve() });
        check('biasAngleDeg null before any frame', client.biasAngleDeg, null);
        client.handleFrame(7, { hd: 0.1, x: 0, y: 0, bias: 12.5 });
        check('biasAngleDeg picked up from the frame', client.biasAngleDeg, 12.5);
        // An older bridge sends no `bias` field — must read as inactive, not stale.
        client.handleFrame(8, { hd: 0.2, x: 0, y: 0 });
        check('biasAngleDeg back to null when absent', client.biasAngleDeg, null);
        client.handleFrame(9, { hd: 0.3, x: 0, y: 0, bias: 0 });
        check('a zero bias angle is kept (not confused with absent)', client.biasAngleDeg, 0);
    }

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
