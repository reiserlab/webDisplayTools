#!/usr/bin/env node
/**
 * Tests for js/pattern-set.js (LAB-92) — browser-free.
 *
 * Exercises the Pattern Set engine against the two committed fixtures:
 *   test_patterns/web_G6_2x10_*.pat  → valid for the G6_2x10 arena
 *   test_patterns/web_G6_3x16_*.pat  → rejected against G6_2x10 (arena mismatch)
 *
 * Verifies: NNN_<name>.pat naming (zero-padded index prefix; diverges from MATLAB's
 * pat%04d.pat because the bench G6 controller mis-reads pure-8.3 names), MANIFEST.bin
 * bytes (uint16 count + uint32 unix, LE), MANIFEST.txt layout, the duty 0x80 re-encode
 * (the patch_duty.js retirement), timestamp formats, and the manifest read API.
 */

const fs = require('fs');
const path = require('path');

const _pp = require('../js/pat-parser.js');
const PatParser = _pp.default || _pp;
const PatEncoder = require('../js/pat-encoder.js');
const { getConfig } = require('../js/arena-configs.js');
const PS = require('../js/pattern-set.js');

const deps = { parsePatFile: PatParser.parsePatFile, encode: PatEncoder.encode, getConfig };

const FIX_2x10 = path.join(__dirname, '../test_patterns/web_G6_2x10_gs2_square_grating_G6.pat');
const FIX_3x16 = path.join(__dirname, '../test_patterns/web_G6_3x16_full_gs16_sine_grating_G6.pat');
const bytes2x10 = fs.readFileSync(FIX_2x10);
const bytes3x16 = fs.readFileSync(FIX_3x16);

let totalChecks = 0;
let failures = 0;

const hex = (bytes) =>
    Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');

function check(name, got, expected) {
    totalChecks++;
    const ok = got === expected;
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

function checkBytes(name, got, expectedHex) {
    totalChecks++;
    const gotHex = hex(got);
    const ok = gotHex === expectedHex;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got [${gotHex}], expected [${expectedHex}]`);
    if (!ok) failures++;
}

function checkThrows(name, fn) {
    totalChecks++;
    let threw = false;
    try {
        fn();
    } catch (_) {
        threw = true;
    }
    console.log(`  ${threw ? 'PASS' : 'FAIL'}  ${name}: ${threw ? 'threw' : 'did NOT throw'}`);
    if (!threw) failures++;
}

function fresh2x10Set(n) {
    const set = PS.createPatternSet({ arenaConfig: 'G6_2x10' });
    for (let i = 0; i < (n || 1); i++) {
        PS.ingest(set, bytes2x10, 'web_G6_2x10_gs2_square_grating_G6.pat', 'local', deps);
    }
    return set;
}

// ── 1. index assignment + NNN_<name>.pat naming ─────────────────────────────────
console.log('\n=== assignIndices → NNN_<name>.pat (alpha order == index order) ===');
{
    const set = fresh2x10Set(3);
    PS.assignIndices(set);
    checkBool(
        'item 1 sd_name = 001_<name>.pat',
        /^001_.+\.pat$/.test(set.items[0].sd_name),
        set.items[0].sd_name
    );
    checkBool(
        'item 2 sd_name = 002_<name>.pat',
        /^002_.+\.pat$/.test(set.items[1].sd_name),
        set.items[1].sd_name
    );
    checkBool(
        'item 3 sd_name = 003_<name>.pat',
        /^003_.+\.pat$/.test(set.items[2].sd_name),
        set.items[2].sd_name
    );
    check('item 2 index', set.items[1].index, 2);
    const names = set.items.map((it) => it.sd_name);
    const sorted = names.slice().sort();
    checkBool('alphabetical sort == index order', JSON.stringify(names) === JSON.stringify(sorted));
    checkBool('duplicate human names deduped', set.items[1].name !== set.items[0].name);
}

// ── 2. geometry validation (accept / reject) ────────────────────────────────────
console.log('\n=== geometry validation vs the target arena ===');
{
    const p2 = PatParser.parsePatFile(
        bytes2x10.buffer.slice(bytes2x10.byteOffset, bytes2x10.byteOffset + bytes2x10.byteLength)
    );
    const p3 = PatParser.parsePatFile(
        bytes3x16.buffer.slice(bytes3x16.byteOffset, bytes3x16.byteOffset + bytes3x16.byteLength)
    );
    const okV = PS.validateGeometry(p2, 'G6_2x10', getConfig);
    const badV = PS.validateGeometry(p3, 'G6_2x10', getConfig);
    checkBool('2x10 pattern accepted for G6_2x10', okV.ok === true);
    checkBool('3x16 pattern rejected for G6_2x10', badV.ok === false);
    checkBool('rejection has a reason', !!badV.reason, badV.reason || '(none)');

    // ingest path stages the bad one as invalid (not exported)
    const set = PS.createPatternSet({ arenaConfig: 'G6_2x10' });
    const it = PS.ingest(
        set,
        bytes3x16,
        'web_G6_3x16_full_gs16_sine_grating_G6.pat',
        'local',
        deps
    );
    checkBool('ingest stages 3x16 as invalid', it.valid === false, it.reason || '');
    checkThrows('buildBundle refuses an invalid entry', () => PS.buildBundle(set));
}

// ── 3. re-encode applies duty 0x80 (patch_duty.js retirement) ────────────────────
console.log('\n=== re-encode drops stretch → duty 0x80 ===');
{
    const set = fresh2x10Set(1);
    const it = set.items[0];
    const back = PatParser.parsePatFile(PS.buildBundle(set).patterns[0].bytes);
    checkBool(
        'parsed-back has per-frame stretch values',
        Array.isArray(back.stretchValues) && back.stretchValues.length === back.numFrames
    );
    const all128 = back.stretchValues.every((v) => v === 0x80);
    checkBool('every frame duty == 0x80 (128)', all128, 'stretch[0]=' + back.stretchValues[0]);
    checkBool('item.bytes is canonical (re-encoded)', it.bytes instanceof ArrayBuffer);
}

// ── 4. MANIFEST.bin exact bytes (uint16 count + uint32 unix, LE) ─────────────────
console.log('\n=== MANIFEST.bin bytes ===');
{
    const bin = PS.buildManifestBin(3, 0x01020304);
    checkBool('MANIFEST.bin is 6 bytes', bin.length === 6);
    checkBytes('count=3, unix=0x01020304 little-endian', bin, '03 00 04 03 02 01');
}

// ── 5. MANIFEST.txt layout + parseManifestTxt roundtrip ──────────────────────────
console.log('\n=== MANIFEST.txt layout + read-back ===');
{
    const set = fresh2x10Set(2);
    const ts = PS.makeTimestamps(new Date(2026, 5, 10, 15, 30, 45));
    PS.assignIndices(set);
    const txt = PS.buildManifestTxt(set, ts);
    checkBool('uses CRLF line endings', txt.indexOf('\r\n') !== -1);
    checkBool('has Pattern Count line', txt.indexOf('Pattern Count: 2') !== -1);
    checkBool('has Mapping header', txt.indexOf('Mapping:') !== -1);
    checkBool(
        'maps first sd_name',
        txt.indexOf(set.items[0].sd_name + ' <- ') !== -1,
        set.items[0].sd_name
    );
    const parsed = PS.parseManifestTxt(txt);
    check('parseManifestTxt count', parsed.count, 2);
    check('parseManifestTxt[0].sd_name', parsed.patterns[0].sd_name, set.items[0].sd_name);
    check('parseManifestTxt[0].index', parsed.patterns[0].index, 1);
    check('parseManifestTxt[0].name', parsed.patterns[0].name, set.items[0].name);
}

// ── 6. timestamp formats (MATLAB convention) ─────────────────────────────────────
console.log('\n=== timestamp formats ===');
{
    const d = new Date(2026, 5, 10, 15, 30, 45); // local: 2026-06-10 15:30:45
    const ts = PS.makeTimestamps(d);
    check('iso', ts.iso, '2026-06-10T15:30:45');
    check('file (set_id)', ts.file, '20260610_153045');
    check('unix', ts.unix, Math.floor(d.getTime() / 1000));
}

// ── 7. buildBundle ───────────────────────────────────────────────────────────────
console.log('\n=== buildBundle ===');
{
    const set = fresh2x10Set(2);
    const bundle = PS.buildBundle(set);
    check('bundle exposes 2 pattern files', bundle.patterns.length, 2);
    check('bundle file 1 name', bundle.patterns[0].name, set.items[0].sd_name);
    checkBool('bundle README mentions SD card', bundle.readme.indexOf('SD card') !== -1);
    checkBool('bundle has no manifestJson', !('manifestJson' in bundle));
    checkBool('MANIFEST.txt has Pattern Set ID', bundle.manifestTxt.indexOf('Pattern Set ID:') !== -1);
    checkThrows('buildBundle refuses an empty set', () =>
        PS.buildBundle(PS.createPatternSet({ arenaConfig: 'G6_2x10' }))
    );
}

// ── 8. single-source rule ────────────────────────────────────────────────────────
console.log('\n=== single-source (no mixing) ===');
{
    const set = fresh2x10Set(1); // source = 'local'
    checkThrows('ingest with a different source throws', () =>
        PS.ingest(set, bytes2x10, 'x.pat', 'builtin', deps)
    );
    PS.clearItems(set);
    checkBool('clearItems resets source', set.source === null && set.items.length === 0);
}

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
