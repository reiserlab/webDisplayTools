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

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
