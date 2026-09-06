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

    console.log('\n=== log level (behavior_v2 default / v1 + full selectable) ===');
    {
        const client = new FicTracBridgeClient({ WebSocketImpl: FakeWS });
        check('LOG_LEVELS exposed, v2 first', FicTracBridgeClient.LOG_LEVELS, [
            'behavior_v2',
            'behavior_v1',
            'full'
        ]);
        client.connect('ws://localhost:8765');
        const ws = FakeWS.last;
        ws.open();
        const lastEnable = () => ws.sent.filter((m) => m.type === 'log_control' && m.enabled).pop();
        client.setLogging(true);
        check('setLogging asserts default level behavior_v2', lastEnable().level, 'behavior_v2');
        check('logLevel getter = requested level', client.logLevel, 'behavior_v2');
        client.setLogLevel('behavior_v1');
        client.setLogging(true);
        check('setLogLevel(behavior_v1) still selectable', lastEnable().level, 'behavior_v1');
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

    console.log('\n=== hello_ack / log_control_ack: the bridge names the level it writes ===');
    {
        const client = new FicTracBridgeClient({ WebSocketImpl: FakeWS });
        const events = [];
        const logs = [];
        client.on('loglevel', (i) => events.push(i));
        client.on('log', (m, kind) => logs.push([kind, m]));
        client.connect('ws://localhost:8765');
        const ws = FakeWS.last;
        ws.open();
        check('no hello_ack yet → bridgeInfo null', client.bridgeInfo, null);
        check(
            'no hello_ack yet → bridgeSupportsLevel unknown (null)',
            client.bridgeSupportsLevel('behavior_v2'),
            null
        );
        check('nothing acked yet', client.ackedLogLevel, null);
        // A pre-3.0 bridge never acks: waitForLogLevelAck resolves null after the timeout.
        client.setLogging(true);
        check('old bridge: wait times out → null', await client.waitForLogLevelAck(15), null);
        // A 3.0 bridge answers hello with its levels.
        ws.message({
            type: 'hello_ack',
            bridge: '3.0 · behavior_v2',
            levels: ['behavior_v2', 'behavior_v1', 'full'],
            level: 'behavior_v2',
            logging: false
        });
        check('hello_ack recorded', client.bridgeInfo, {
            version: '3.0 · behavior_v2',
            levels: ['behavior_v2', 'behavior_v1', 'full'],
            level: 'behavior_v2'
        });
        check('bridgeSupportsLevel(v2) true', client.bridgeSupportsLevel('behavior_v2'), true);
        check('bridgeSupportsLevel(bogus) false', client.bridgeSupportsLevel('behavior_v9'), false);
        check(
            'hello loglevel event ok',
            [events[0].source, events[0].ok, events[0].level],
            ['hello', true, 'behavior_v2']
        );
        checkBool(
            'no warning when supported',
            logs.filter((l) => l[0] === 'err').length === 0,
            JSON.stringify(logs)
        );
        // Enable logging; the ack names the same level → ok, waiters resolve.
        client.setLogging(true);
        const pending = client.waitForLogLevelAck(5000);
        ws.message({
            type: 'log_control_ack',
            enabled: true,
            level: 'behavior_v2',
            requested: 'behavior_v2',
            file: 'arena-log-1.jsonl'
        });
        check('ack → ackedLogLevel', client.ackedLogLevel, 'behavior_v2');
        check('waitForLogLevelAck resolves with the acked level', await pending, 'behavior_v2');
        check(
            'already acked → immediate resolve',
            await client.waitForLogLevelAck(5000),
            'behavior_v2'
        );
        const e = events[events.length - 1];
        check(
            'log_control loglevel event',
            [e.source, e.ok, e.level, e.requested, e.file, e.enabled],
            ['log_control', true, 'behavior_v2', 'behavior_v2', 'arena-log-1.jsonl', true]
        );
        // Disable → acked level cleared, ack with enabled:false is ok regardless of level.
        client.setLogging(false);
        check('setLogging(false) clears acked level (pending)', client.ackedLogLevel, null);
        ws.message({
            type: 'log_control_ack',
            enabled: false,
            level: 'behavior_v2',
            requested: null,
            file: 'arena-log-1.jsonl'
        });
        check('disabled ack keeps ackedLogLevel null', client.ackedLogLevel, null);
        check('disabled ack is ok', events[events.length - 1].ok, true);
        // MISMATCH: the bridge cannot write what we asked → warning + ok:false.
        client.setLogging(true);
        ws.message({
            type: 'log_control_ack',
            enabled: true,
            level: 'behavior_v1',
            requested: 'behavior_v2',
            file: 'arena-log-2.jsonl'
        });
        const m = events[events.length - 1];
        check(
            'mismatch → ok false, level = what the bridge writes',
            [m.ok, m.level, m.requested],
            [false, 'behavior_v1', 'behavior_v2']
        );
        check(
            "mismatch → ackedLogLevel is the bridge's level",
            client.ackedLogLevel,
            'behavior_v1'
        );
        checkBool(
            'mismatch → err log line names both levels',
            logs.some(
                (l) =>
                    l[0] === 'err' &&
                    /too old for behavior_v2/.test(l[1]) &&
                    /logging behavior_v1/.test(l[1])
            ),
            JSON.stringify(logs.slice(-1))
        );
        // hello_ack from a bridge that lacks the requested level warns up front.
        const before = logs.length;
        ws.message({
            type: 'hello_ack',
            bridge: '2.9',
            levels: ['behavior_v1', 'full'],
            level: 'behavior_v1',
            logging: true
        });
        check(
            'hello without our level → loglevel ok:false with fallback level',
            [events[events.length - 1].ok, events[events.length - 1].level],
            [false, 'behavior_v1']
        );
        checkBool(
            'hello without our level → err log line',
            logs.length === before + 1 &&
                logs[before][0] === 'err' &&
                /cannot write behavior_v2/.test(logs[before][1]),
            JSON.stringify(logs.slice(before))
        );
        // Disconnect resets negotiation state (a fresh setLogging clears the
        // previous ack, so the waiter is really pending when the socket closes).
        client.setLogging(true);
        check('fresh setLogging → acked level pending again', client.ackedLogLevel, null);
        const w = client.waitForLogLevelAck(5000);
        ws.close();
        check('close → pending waiter resolves null', await w, null);
        check('close → bridgeInfo reset', client.bridgeInfo, null);
        check('close → ackedLogLevel reset', client.ackedLogLevel, null);
        check(
            'not connected → wait resolves null immediately',
            await client.waitForLogLevelAck(5000),
            null
        );
    }

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
