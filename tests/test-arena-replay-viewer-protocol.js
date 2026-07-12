#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Protocol = require('../js/arena-replay-viewer-protocol.js');

let checks = 0;
let failures = 0;

function check(name, condition, details) {
    checks++;
    const ok = Boolean(condition);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
    if (!ok) failures++;
}

function equal(name, actual, expected) {
    check(
        name,
        JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}`
    );
}

console.log('\n=== envelope construction ===');
const sessionId = 'replay-session-1234';
const init = Protocol.makeMessage(Protocol.OPENER_SOURCE, 'init', sessionId, {
    arenaConfigName: 'G6_2x10'
});
equal(
    'opener envelope has stable routing fields',
    {
        channel: init.channel,
        version: init.version,
        source: init.source,
        type: init.type,
        sessionId: init.sessionId
    },
    {
        channel: 'arena-studio-replay-viewer',
        version: 1,
        source: 'arena-studio-alt',
        type: 'init',
        sessionId
    }
);
check('short session ids are rejected', !Protocol.isSessionId('short'));
check(
    'UUID-shaped session ids are accepted',
    Protocol.isSessionId('12345678-abcd-4abc-9abc-123456789abc')
);
check(
    'viewer cannot emit inbound-only state messages',
    (() => {
        try {
            Protocol.makeMessage(Protocol.VIEWER_SOURCE, 'state', sessionId, {});
            return false;
        } catch (error) {
            return true;
        }
    })()
);

console.log('\n=== opener, origin, source, and session validation ===');
const openerWindow = {};
const baseEvent = {
    source: openerWindow,
    origin: 'https://reiserlab.github.io',
    data: init
};
const context = {
    openerWindow,
    expectedOrigin: 'https://reiserlab.github.io',
    sessionId
};
check('valid event passes all routing checks', Protocol.validateInbound(baseEvent, context).ok);
equal(
    'wrong opener window is rejected first',
    Protocol.validateInbound({ ...baseEvent, source: {} }, context),
    { ok: false, reason: 'window' }
);
equal(
    'wrong origin is rejected',
    Protocol.validateInbound({ ...baseEvent, origin: 'https://example.test' }, context),
    { ok: false, reason: 'origin' }
);
equal(
    'wrong semantic source is rejected',
    Protocol.validateInbound(
        { ...baseEvent, data: { ...init, source: Protocol.VIEWER_SOURCE } },
        context
    ),
    { ok: false, reason: 'source' }
);
equal(
    'wrong session is rejected',
    Protocol.validateInbound(
        { ...baseEvent, data: { ...init, sessionId: 'other-session-9999' } },
        context
    ),
    { ok: false, reason: 'session' }
);
equal(
    'unknown type is rejected',
    Protocol.validateInbound({ ...baseEvent, data: { ...init, type: 'seek' } }, context),
    { ok: false, reason: 'type' }
);
equal(
    'wrong protocol channel is rejected',
    Protocol.validateInbound(
        { ...baseEvent, data: { ...init, channel: 'another-channel' } },
        context
    ),
    { ok: false, reason: 'channel' }
);
equal(
    'wrong protocol version is rejected',
    Protocol.validateInbound({ ...baseEvent, data: { ...init, version: 2 } }, context),
    { ok: false, reason: 'version' }
);
equal(
    'array payload is rejected',
    Protocol.validateInbound({ ...baseEvent, data: { ...init, payload: [] } }, context),
    { ok: false, reason: 'payload' }
);

console.log('\n=== viewer-to-opener validation ===');
const viewerWindow = {};
const ready = Protocol.makeMessage(Protocol.VIEWER_SOURCE, 'ready', sessionId, {
    protocolVersion: 1
});
const viewerEvent = {
    source: viewerWindow,
    origin: 'https://reiserlab.github.io',
    data: ready
};
const openerContext = {
    viewerWindow,
    expectedOrigin: 'https://reiserlab.github.io',
    sessionId
};
check(
    'opener accepts a ready message from its exact popup',
    Protocol.validateFromViewer(viewerEvent, openerContext).ok
);
equal(
    'opener rejects a different popup window',
    Protocol.validateFromViewer({ ...viewerEvent, source: {} }, openerContext),
    { ok: false, reason: 'window' }
);
equal(
    'opener rejects a same-window message with the wrong semantic source',
    Protocol.validateFromViewer(
        { ...viewerEvent, data: { ...ready, source: Protocol.OPENER_SOURCE } },
        openerContext
    ),
    { ok: false, reason: 'source' }
);
equal(
    'opener rejects an inbound-only message type from the viewer',
    Protocol.validateFromViewer(
        { ...viewerEvent, data: { ...ready, type: 'state' } },
        openerContext
    ),
    { ok: false, reason: 'type' }
);

console.log('\n=== replay-state normalization ===');
equal(
    'canonical state stays canonical',
    Protocol.normalizeReplayState({
        elapsedMs: 6250,
        condition: 'training / red',
        frame: 8,
        ledOn: true
    }),
    { elapsedMs: 6250, condition: 'training / red', frame: 8, ledOn: true }
);
equal(
    'JSONL aliases normalize and numeric LED one is on',
    Protocol.normalizeReplayState({
        elapsed_ms: 125,
        condition_name: 'baseline',
        frame_index: 3.9,
        led_on: 1
    }),
    { elapsedMs: 125, condition: 'baseline', frame: 3, ledOn: true }
);
equal(
    'logged LED percentage and frame-position aliases normalize directly',
    Protocol.normalizeReplayState({
        elapsedMs: 900,
        frame_position: 12,
        ledPercent: 25
    }),
    { elapsedMs: 900, condition: '—', frame: 12, ledOn: true }
);
equal(
    'logged LED activation text normalizes directly',
    Protocol.normalizeReplayState({ ledActivation: 'ON' }),
    { elapsedMs: 0, condition: '—', frame: 0, ledOn: true }
);
equal(
    'explicit logged OFF wins over a positive LED percentage',
    Protocol.normalizeReplayState({ on: false, ledPercent: 25 }),
    { elapsedMs: 0, condition: '—', frame: 0, ledOn: false }
);
equal(
    'logged OFF text keeps the replay lamp dark',
    Protocol.normalizeReplayState({ ledActivation: 'OFF' }),
    { elapsedMs: 0, condition: '—', frame: 0, ledOn: false }
);
equal(
    'invalid and negative values use safe defaults',
    Protocol.normalizeReplayState({ elapsedMs: -50, frame: -2, ledOn: 'not-a-state' }),
    { elapsedMs: 0, condition: '—', frame: 0, ledOn: false }
);
equal(
    'partial updates retain previous state',
    Protocol.normalizeReplayState(
        { elapsedMs: 8000 },
        { elapsedMs: 7000, condition: 'test', frame: 4, ledOn: true }
    ),
    { elapsedMs: 8000, condition: 'test', frame: 4, ledOn: true }
);
equal(
    'display mode is clamped and retained for synchronized all-on/off replay',
    Protocol.normalizeReplayState(
        { displayMode: 'all-on' },
        { elapsedMs: 0, condition: 'test', frame: 4, ledOn: false, displayMode: 'pattern' }
    ),
    { elapsedMs: 0, condition: 'test', frame: 4, ledOn: false, displayMode: 'all-on' }
);
equal('elapsed formatter preserves hundredths', Protocol.formatElapsed(62567), '01:02.57');

console.log('\n=== origin normalization ===');
equal(
    'URL path is reduced to its origin',
    Protocol.normalizeOrigin('https://reiserlab.github.io/webDisplayTools/arena_studio_alt.html'),
    'https://reiserlab.github.io'
);
equal('opaque null origin stays explicit', Protocol.normalizeOrigin('null'), 'null');
equal(
    'javascript URL is rejected as opaque',
    Protocol.normalizeOrigin('javascript:alert(1)'),
    null
);

console.log('\n=== browser entrypoint wiring ===');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'arena_replay_viewer.html'), 'utf8');
const viewerModule = fs.readFileSync(path.join(root, 'js/arena-replay-viewer.js'), 'utf8');
check(
    'pat-parser is not loaded as an invalid classic script',
    !html.includes('<script src="js/pat-parser.js"></script>')
);
check(
    'viewer module imports the ES-module parser directly',
    viewerModule.includes("import PatParser from './pat-parser.js';")
);
check(
    'viewer import map resolves Three.js addon bare imports',
    html.includes('"three": "https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.module.js"')
);
check(
    'apparatus declares the required 9 mm ball',
    viewerModule.includes('const BALL_DIAMETER_MM = 9;')
);

console.log(`\n${checks - failures} / ${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
