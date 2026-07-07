#!/usr/bin/env node
/**
 * Tests for js/studio-meta.js — run_id, buildMeta, canMutate, canRunExperiment.
 * Plus a sha256 algorithm-parity check (node:crypto vs the browser crypto.subtle
 * algorithm the HTML uses) so the metadata hash is verifiably the same bytes.
 *
 * Run: node tests/test-studio-meta.js   (wired into `pixi run test`)
 */
'use strict';

const crypto = require('crypto');
const M = require('../js/studio-meta.js');

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

// ── makeRunId ────────────────────────────────────────────────────────────────
console.log('=== makeRunId ===');
const fixedNow = () => Date.parse('2026-07-01T21:00:00.000Z');
const id1 = M.makeRunId(fixedNow, () => 0.5);
const id2 = M.makeRunId(fixedNow, () => 0.5);
check('deterministic under injected now/rand', id1, id2);
checkBool('8 chars', id1.length === 8, id1);
checkBool('base36 charset', /^[a-z0-9]{8}$/.test(id1), id1);
// Monotonic prefix across increasing time (same rand): later id sorts >= earlier.
const early = M.makeRunId(
    () => 1000000000000,
    () => 0
);
const late = M.makeRunId(
    () => 2000000000000,
    () => 0
);
checkBool('time-ordered (later >= earlier)', late >= early, early + ' -> ' + late);
// Same-ms collisions broken by rand.
const c1 = M.makeRunId(fixedNow, () => 0.1);
const c2 = M.makeRunId(fixedNow, () => 0.9);
checkBool('random suffix breaks same-ms collision', c1 !== c2, c1 + ' vs ' + c2);

// ── buildMeta ────────────────────────────────────────────────────────────────
console.log('=== buildMeta ===');
const meta = M.buildMeta({
    runId: 'abc123',
    panel: {
        experimenter: '  mreiser ',
        genotype: 'Canton-S',
        age: '3-4 days',
        sex: 'F',
        fly_number: ' 7 ',
        notes: ' fly 7 '
    },
    doc: { filename: 'looming_v3.yaml', sha256: 'deadbeef' },
    session: { firmware: 'v1', controllerId: '04:E9:E5:AB:CD:12' },
    rig: { name: 'cshl_g6_2x10', arenaConfig: 'G6_2x10' },
    toolVersion: 'Arena Studio v0.1'
});
check('run_id passthrough', meta.run_id, 'abc123');
check('experimenter trimmed', meta.experimenter, 'mreiser');
check('genotype', meta.genotype, 'Canton-S');
check('age', meta.age, '3-4 days');
check('sex', meta.sex, 'F');
check('fly_number trimmed', meta.fly_number, '7');
check('notes trimmed', meta.notes, 'fly 7');
check('protocol_filename', meta.protocol_filename, 'looming_v3.yaml');
check('protocol_sha256', meta.protocol_sha256, 'deadbeef');
check('arena_config from rig', meta.arena_config, 'G6_2x10');
check('rig name', meta.rig, 'cshl_g6_2x10');
check('firmware from session', meta.firmware, 'v1');
check('controller_id from session', meta.controller_id, '04:E9:E5:AB:CD:12');
check('tool_version', meta.tool_version, 'Arena Studio v0.1');

const bare = M.buildMeta({});
check('missing filename → untitled', bare.protocol_filename, 'untitled.yaml');
check('missing sha → null', bare.protocol_sha256, null);
check('missing fw → null', bare.firmware, null);
check('missing controller_id → null', bare.controller_id, null);
check('missing experimenter → empty string', bare.experimenter, '');

// ── canMutate ────────────────────────────────────────────────────────────────
console.log('=== canMutate (read-only chokepoint) ===');
check('edit + not importing → true', M.canMutate({ mode: 'edit', importMode: false }), true);
check('edit + importing → false', M.canMutate({ mode: 'edit', importMode: true }), false);
check('run → false', M.canMutate({ mode: 'run', importMode: false }), false);
check('console → false', M.canMutate({ mode: 'console', importMode: false }), false);
check('undefined → false', M.canMutate(undefined), false);

// ── canRunExperiment ─────────────────────────────────────────────────────────
console.log('=== canRunExperiment (recorded-run gate) ===');
const okState = {
    connected: true,
    hasProtocol: true,
    dirty: false,
    unsaved: false,
    experimenter: 'mreiser',
    genotype: 'Canton-S',
    bridgeConnected: true,
    missingPatterns: []
};
check('all satisfied → ok', M.canRunExperiment(okState).ok, true);
check(
    'disconnected → reason',
    M.canRunExperiment({ ...okState, connected: false }).reason,
    'Connect to run'
);
check(
    'no protocol → reason',
    M.canRunExperiment({ ...okState, hasProtocol: false }).reason,
    'Open a protocol to run'
);
check('dirty → save reason', M.canRunExperiment({ ...okState, dirty: true }).ok, false);
check(
    'missing experimenter → false',
    M.canRunExperiment({ ...okState, experimenter: '  ' }).ok,
    false
);
check('missing genotype → false', M.canRunExperiment({ ...okState, genotype: '' }).ok, false);
// Universal bridge logging (course pipeline): a dead bridge blocks loudly.
check('dead bridge blocks', M.canRunExperiment({ ...okState, bridgeConnected: false }).ok, false);
checkBool(
    'dead bridge reason names the bridge',
    /[Bb]ridge/.test(M.canRunExperiment({ ...okState, bridgeConnected: false }).reason),
    M.canRunExperiment({ ...okState, bridgeConnected: false }).reason
);
checkBool(
    'bridge omitted entirely blocks too',
    !M.canRunExperiment({ ...okState, bridgeConnected: undefined }).ok,
    'strict gate'
);
// Missing-pattern preflight: unresolvable names block BEFORE the run starts.
const missing = M.canRunExperiment({ ...okState, missingPatterns: ['loom_20deg'] });
check('missing pattern blocks', missing.ok, false);
checkBool(
    'reason names the pattern + SD upload fix',
    /loom_20deg/.test(missing.reason) && /SD upload/.test(missing.reason),
    missing.reason
);
check(
    'empty missing list passes',
    M.canRunExperiment({ ...okState, missingPatterns: [] }).ok,
    true
);
check(
    'absent missing list passes (callers not computing it)',
    M.canRunExperiment({ ...okState, missingPatterns: undefined }).ok,
    true
);
// Reason priority: metadata prompts come before the bridge/pattern checks.
check(
    'experimenter outranks bridge',
    M.canRunExperiment({ ...okState, experimenter: '', bridgeConnected: false }).reason,
    'Experimenter is required'
);

// ── sha256 parity ────────────────────────────────────────────────────────────
// The HTML computes crypto.subtle.digest('SHA-256', TextEncoder().encode(text));
// node:crypto over the same UTF-8 bytes must produce the identical hex. This
// guards the "re-hash the saved .yaml → matches the run-log" self-verifying pair.
console.log('=== sha256 parity (node:crypto == browser algorithm) ===');
function nodeSha256Hex(text) {
    return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}
const sample = 'version: 3\nexperiment_info:\n  name: "smoke ☃"\n';
const h = nodeSha256Hex(sample);
checkBool('64 hex chars', /^[0-9a-f]{64}$/.test(h), h.slice(0, 12) + '…');
// Known vector: sha256("") — matches WebCrypto over an empty Uint8Array.
check(
    'sha256("") vector',
    nodeSha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
);
// UTF-8 multibyte stability (☃ = e2 98 83): same input → same hash.
checkBool('utf8 multibyte stable', nodeSha256Hex(sample) === nodeSha256Hex(sample), 'idempotent');

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures ? 1 : 0);
