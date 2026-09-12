#!/usr/bin/env node
/**
 * Hardware-free tests for js/arena-link.js (the Web Serial transport).
 *
 * Run: node tests/test-arena-link.js
 *
 * A real arena needs manual verification, but the risky logic — stream
 * de-framing across chunk boundaries, single-flight + echo-verified
 * correlation, timeout cleanup + rx flush, read-error/disconnect teardown, and
 * partial-open rollback — is all exercised here with a fake reader/writer/port
 * and an injected `navigator.serial`. No browser, no hardware.
 *
 * Exits 0 on PASS, 1 on any FAIL. Wired into `npm test` for CI.
 */

'use strict';

const ArenaLink = require('../js/arena-link.js');
const Wire = require('../js/arena-wire-g6.js');

let totalChecks = 0;
let failures = 0;

const hex = (bytes) =>
    Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');

function checkBool(name, ok, info) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

function checkBytes(name, got, expectedHex) {
    totalChecks++;
    const gotHex = hex(got);
    const ok = gotHex === expectedHex;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got [${gotHex}], expected [${expectedHex}]`);
    if (!ok) failures++;
}

// Assert a promise rejects, optionally matching the message.
async function checkRejects(name, promise, matcher) {
    totalChecks++;
    let rejected = false;
    let msg = '';
    try {
        await promise;
    } catch (e) {
        rejected = true;
        msg = (e && e.message) || String(e);
    }
    const ok = rejected && (!matcher || matcher.test(msg));
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}${rejected ? ' — ' + msg : ' (did NOT reject)'}`
    );
    if (!ok) failures++;
}

const flush = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── fakes ─────────────────────────

class FakeReader {
    constructor() {
        this.waiters = [];
        this.queue = [];
        this.canceled = false;
        this.error = null;
    }
    read() {
        if (this.error) return Promise.reject(this.error);
        if (this.queue.length) return Promise.resolve(this.queue.shift());
        if (this.canceled) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    // Test driver: deliver an incoming chunk to the read loop.
    push(chunk) {
        const item = { value: Uint8Array.from(chunk), done: false };
        if (this.waiters.length) this.waiters.shift().resolve(item);
        else this.queue.push(item);
    }
    // Test driver: make the in-flight read() reject (simulate I/O failure).
    fail(err) {
        this.error = err;
        const ws = this.waiters;
        this.waiters = [];
        ws.forEach((w) => w.reject(err));
    }
    async cancel() {
        this.canceled = true;
        const ws = this.waiters;
        this.waiters = [];
        ws.forEach((w) => w.resolve({ value: undefined, done: true }));
    }
    releaseLock() {}
}

class FakeWriter {
    constructor(opts) {
        this.writes = [];
        this._opts = opts || {};
    }
    async write(bytes) {
        if (this._opts.failWrite) throw new Error('write failed');
        this.writes.push(Uint8Array.from(bytes));
    }
    releaseLock() {}
}

class FakePort {
    constructor(reader, writer, opts) {
        this._reader = reader;
        this._writer = writer;
        this._opts = opts || {};
        this.opened = false;
        this.closed = false;
    }
    async open() {
        this.opened = true;
    }
    async close() {
        this.closed = true;
    }
    get readable() {
        return { getReader: () => this._reader };
    }
    get writable() {
        return {
            getWriter: () => {
                if (this._opts.failGetWriter) throw new Error('getWriter failed');
                return this._writer;
            }
        };
    }
}

// Build a fresh link + injected navigator.serial for one scenario.
function setup(opts) {
    opts = opts || {};
    const reader = new FakeReader();
    const writer = new FakeWriter(opts.writer);
    const port = new FakePort(reader, writer, opts.port);
    const listeners = {};
    global.navigator = {
        serial: {
            requestPort: async () => port,
            addEventListener: (t, fn) => {
                (listeners[t] = listeners[t] || []).push(fn);
            },
            removeEventListener: (t, fn) => {
                const a = listeners[t] || [];
                const i = a.indexOf(fn);
                if (i >= 0) a.splice(i, 1);
            },
            _dispatch: (t, ev) => {
                (listeners[t] || []).slice().forEach((fn) => fn(ev));
            }
        }
    };
    const events = { errors: [], disconnects: 0 };
    const link = new ArenaLink({
        onError: (e) => events.errors.push(e),
        onDisconnect: () => {
            events.disconnects++;
        }
    });
    return { link, reader, writer, port, events };
}

// Canonical request encoders + matching response frames.
const REQ_INFO = '01 c2';
const REQ_SPI = '01 c6';
const RESP_INFO = Uint8Array.from([0x04, 0x00, 0xc2, 0x02, 0x11]); // echo 0xC2
const RESP_SPI = Uint8Array.from([0x04, 0x00, 0xc6, 0x14, 0x00]); // echo 0xC6

async function main() {
    console.log('=== feature detection ===');
    delete global.navigator;
    checkBool('isSupported() false without navigator.serial', ArenaLink.isSupported() === false);

    console.log('\n=== guards ===');
    {
        const { link } = setup();
        checkBool('isSupported() true with navigator.serial', ArenaLink.isSupported() === true);
        await checkRejects(
            'send before connect rejects',
            link.send(Wire.encodeGetControllerInfo()),
            /not connected/
        );
    }

    console.log('\n=== connect + correlated response round-trip ===');
    {
        const { link, reader, writer, port } = setup();
        await link.connect();
        checkBool('connected after connect()', link.connected === true);
        const p = link.send(Wire.encodeGetControllerInfo());
        await flush();
        checkBytes('request written to port', writer.writes[0], REQ_INFO);
        reader.push(RESP_INFO);
        const frame = await p;
        checkBytes('resolves with response frame', frame, '04 00 c2 02 11');
        const info = Wire.decodeControllerInfo(Wire.decodeResponse(frame));
        checkBool('frame decodes (version=2)', info && info.version === 2);
        await link.close();
        checkBool('not connected after close()', link.connected === false);
        checkBool('port closed after close()', port.closed === true);
    }

    console.log('\n=== echo verification (desync) ===');
    {
        const { link, reader } = setup();
        await link.connect();
        const p = link.send(Wire.encodeGetControllerInfo()); // expects echo 0xc2
        await flush();
        reader.push(RESP_SPI); // echo 0xC6 — wrong
        await checkRejects('mismatched echo rejects as desync', p, /desync/);
        await link.close();
    }

    console.log('\n=== de-framing across chunk boundaries ===');
    {
        const { link, reader } = setup();
        await link.connect();
        const p = link.send(Wire.encodeGetControllerInfo());
        await flush();
        reader.push([0x04, 0x00]); // first half of the frame
        await flush();
        reader.push([0xc2, 0x02, 0x11]); // second half
        const frame = await p;
        checkBytes('split frame reassembled', frame, '04 00 c2 02 11');
        await link.close();
    }

    console.log('\n=== runt/stray bytes ignored ===');
    {
        const { link, reader } = setup();
        await link.connect();
        const p = link.send(Wire.encodeGetControllerInfo());
        await flush();
        reader.push([0x00]); // claimedLen 0 — runt
        reader.push([0x01, 0x00]); // claimedLen 1, no echo — runt
        await flush();
        reader.push(RESP_INFO); // the real reply
        const frame = await p;
        checkBytes('runts skipped, real frame resolves', frame, '04 00 c2 02 11');
        await link.close();
    }

    console.log('\n=== timeout + rx flush recovery ===');
    {
        const { link, reader } = setup();
        await link.connect();
        const p = link.send(Wire.encodeGetControllerInfo(), { timeoutMs: 20 });
        await flush();
        await checkRejects('send times out with no reply', p, /timeout/);
        // rxBuf was flushed + inflight cleared — a fresh send still works.
        const p2 = link.send(Wire.encodeGetControllerInfo());
        await flush();
        reader.push(RESP_INFO);
        const frame = await p2;
        checkBytes('send works again after a timeout', frame, '04 00 c2 02 11');
        await link.close();
    }

    console.log('\n=== late response after timeout does not poison the next request ===');
    {
        const { link, reader } = setup();
        await link.connect();
        const p1 = link.send(Wire.encodeGetControllerInfo(), { timeoutMs: 20 }); // echo c2
        await flush();
        await checkRejects('first request times out', p1, /timeout/);
        reader.push(RESP_INFO); // the tardy echo-c2 reply — no request waiting, dropped
        await flush();
        const p2 = link.send(Wire.encodeGetSpiClock()); // echo c6
        await flush();
        reader.push(RESP_SPI); // echo c6
        const frame = await p2;
        checkBytes('next request gets its OWN reply, not the stale one', frame, '04 00 c6 14 00');
        await link.close();
    }

    console.log('\n=== single-flight serialization ===');
    {
        const { link, reader, writer } = setup();
        await link.connect();
        const p1 = link.send(Wire.encodeGetControllerInfo()); // echo c2
        const p2 = link.send(Wire.encodeGetSpiClock()); // echo c6
        await flush();
        checkBool('only the first request is written', writer.writes.length === 1);
        checkBytes('first write is get-info', writer.writes[0], REQ_INFO);
        reader.push(RESP_INFO); // resolves p1, releases p2 to write
        const f1 = await p1;
        await flush();
        checkBool('second request written after first resolves', writer.writes.length === 2);
        checkBytes('second write is get-spi', writer.writes[1], REQ_SPI);
        reader.push(RESP_SPI);
        const f2 = await p2;
        checkBytes('p1 resolved with get-info reply', f1, '04 00 c2 02 11');
        checkBytes('p2 resolved with get-spi reply', f2, '04 00 c6 14 00');
        await link.close();
    }

    console.log('\n=== read-loop error -> connection failure ===');
    {
        const { link, reader, events } = setup();
        await link.connect();
        const p = link.send(Wire.encodeGetControllerInfo());
        await flush();
        reader.fail(new Error('USB read failure'));
        await checkRejects('in-flight request rejected on read error', p, /USB read failure/);
        checkBool('onError fired', events.errors.length === 1);
        checkBool('onDisconnect fired', events.disconnects === 1);
        checkBool('not connected after read error', link.connected === false);
        await link.close();
    }

    console.log('\n=== disconnect event -> clean teardown ===');
    {
        const { link, reader, port, events } = setup();
        await link.connect();
        const p = link.send(Wire.encodeGetControllerInfo());
        await flush();
        global.navigator.serial._dispatch('disconnect', { target: port });
        await checkRejects('in-flight request rejected on disconnect', p, /disconnected/);
        checkBool('onDisconnect fired (event)', events.disconnects === 1);
        checkBool('onError NOT fired on clean unplug', events.errors.length === 0);
        checkBool('not connected after disconnect', link.connected === false);
        reader.cancel(); // release the lingering read loop
        await link.close();
    }

    console.log('\n=== partial open() rollback ===');
    {
        const { link, port } = setup({ port: { failGetWriter: true } });
        await checkRejects(
            'open() rejects when getWriter throws',
            link.connect(),
            /getWriter failed/
        );
        checkBool('port closed on open rollback', port.closed === true);
        checkBool('not connected after failed open', link.connected === false);
    }

    console.log('\n=== write deadline: a stalled write rejects like a timeout ===');
    {
        const { link, writer, reader } = setup();
        await link.connect();
        writer.write = () => new Promise(() => {}); // USB write never completes
        const t0 = Date.now();
        await checkRejects(
            'stalled write → timeout rejection',
            link.send(Wire.encodeGetControllerInfo(), { timeoutMs: 40 }),
            /response timeout/
        );
        checkBool('rejected promptly (not hung)', Date.now() - t0 < 1000);
        checkBool('no request left in flight', link._inflight === null);
        reader.cancel();
        await link.close();
    }

    console.log('\n=== reconnect(): granted-port reopen without a gesture (fw #50 recovery) ===');
    {
        // Same port still valid (no re-enumeration): reopen it.
        const { link, reader, port } = setup();
        await link.connect();
        global.navigator.serial._dispatch('disconnect', { target: port });
        await flush();
        checkBool('disconnected after unplug event', link.connected === false);
        global.navigator.serial.getPorts = async () => [port];
        const p = await link.reconnect({ timeoutMs: 500, pollMs: 20 });
        checkBool('reconnect reopened the same port', p === port && link.connected === true);
        reader.cancel();
        await link.close();
    }
    {
        // Re-enumerated: old port object is dead, one granted port matches VID/PID.
        const { link, reader, port } = setup();
        port.getInfo = () => ({ usbVendorId: 0x16c0, usbProductId: 0x0483 });
        await link.connect();
        global.navigator.serial._dispatch('disconnect', { target: port });
        await flush();
        port.open = async () => {
            throw new Error('device gone');
        };
        const reader2 = new FakeReader();
        const newPort = new FakePort(reader2, new FakeWriter());
        newPort.getInfo = () => ({ usbVendorId: 0x16c0, usbProductId: 0x0483 });
        const other = new FakePort(new FakeReader(), new FakeWriter());
        other.getInfo = () => ({ usbVendorId: 0x0403, usbProductId: 0x6001 }); // an FTDI, not ours
        global.navigator.serial.getPorts = async () => [other, newPort];
        const p = await link.reconnect({ timeoutMs: 500, pollMs: 20 });
        checkBool('reconnect picked the VID/PID match, not the FTDI', p === newPort);
        checkBool('connected on the new port', link.connected === true && link.port === newPort);
        reader.cancel();
        reader2.cancel();
        await link.close();
    }
    {
        // Ambiguous: two granted ports match → refuse (never guess a controller).
        const { link, reader, port } = setup();
        port.getInfo = () => ({ usbVendorId: 0x16c0, usbProductId: 0x0483 });
        await link.connect();
        global.navigator.serial._dispatch('disconnect', { target: port });
        await flush();
        port.open = async () => {
            throw new Error('device gone');
        };
        const a = new FakePort(new FakeReader(), new FakeWriter());
        const b = new FakePort(new FakeReader(), new FakeWriter());
        a.getInfo = b.getInfo = () => ({ usbVendorId: 0x16c0, usbProductId: 0x0483 });
        global.navigator.serial.getPorts = async () => [a, b];
        await checkRejects(
            'two matching granted ports → ambiguous',
            link.reconnect({ timeoutMs: 300, pollMs: 20 }),
            /ambiguous/
        );
        checkBool('still disconnected after refusal', link.connected === false);
        reader.cancel();
    }
    {
        // Nothing comes back: times out with a manual-connect hint.
        const { link, reader, port } = setup();
        await link.connect();
        global.navigator.serial._dispatch('disconnect', { target: port });
        await flush();
        port.open = async () => {
            throw new Error('device gone');
        };
        global.navigator.serial.getPorts = async () => [];
        const t0 = Date.now();
        await checkRejects(
            'no granted port → times out',
            link.reconnect({ timeoutMs: 120, pollMs: 20 }),
            /no granted port came back.*connect manually/
        );
        checkBool('honoured the timeout', Date.now() - t0 < 2000);
        reader.cancel();
    }

    console.log(`\n=== Summary ===\n${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('test harness crashed:', e);
    process.exit(1);
});
