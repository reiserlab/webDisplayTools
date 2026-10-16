#!/usr/bin/env node
/**
 * Arena Studio connect-time traffic must never queue ahead of a user command.
 *
 * Bench 2026-10-07 (rig cshl_g6_2x10_ball, 24 patterns on the card): the first
 * TRIAL_PARAMS after Connect was acknowledged 57 s late. The SD listing auto-picks
 * pattern 1 and the picker thumbnail downloaded the whole file (0x84); with
 * Chrome's default 255-byte Web Serial buffer the body arrived 901 bytes short,
 * and the single-flight link waited out the read's 60 s timeout with the
 * GET_PATTERN_INFO sweep and the user's command queued behind it.
 *
 * The transport half (1 MiB bufferSize, bulk stall timeout, background lane) is
 * tested in tests/test-arena-link.js; this file pins the Studio call sites to it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const studio = fs.readFileSync(path.join(__dirname, '..', 'arena_studio.html'), 'utf8');

let totalChecks = 0;
let failures = 0;
function check(name, ok, detail) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
}
// Source of a top-level function in the module block, up to the next top-level one.
function fnBody(signature) {
    const a = studio.indexOf(signature);
    if (a < 0) return '';
    const b = studio
        .slice(a + signature.length)
        .search(/\n(?:async )?function |\nlet |\nconst |\nStudio\./);
    return b < 0 ? studio.slice(a) : studio.slice(a, a + signature.length + b);
}

console.log('=== GET_PATTERN_INFO sweep (closed-loop frame counts, #201) ===');
const info = fnBody('function cardPatternInfo(p)');
check('cardPatternInfo found', info.length > 0);
check(
    '0x88 goes in the background lane',
    /encodeGetPatternInfo\(p\.index\)[^)]*background: true/.test(info)
);
check(
    'caches frames + file size on the entry',
    /p\.card = \{ frames: info\.frameCount, fileSize: info\.fileSize \}/.test(info)
);
check(
    'keeps preview.frames, the closed-loop modulus',
    /p\.preview = Object\.assign\(p\.preview \|\| \{\}, \{ frames: info\.frameCount \}\)/.test(info)
);
const sweep = fnBody('async function fillPatternFramesFromCard(m)');
check('sweep found', sweep.length > 0);
check('sweep reads through cardPatternInfo', /await cardPatternInfo\(p\)/.test(sweep));
check('sweep sends no foreground 0x88 of its own', !/session\.send\(/.test(sweep));
check('sweep still stops for a run', /Studio\.session\.running\) return/.test(sweep));

console.log('\n=== picker thumbnail live fetch ===');
const src = fnBody('async function patByteSource(p, refusal)');
check('patByteSource found', src.length > 0);
check('in-memory sources first', /Studio\.webBytesForName\(p\.sd_name\)/.test(src));
check(
    'gated by PatPreview.liveFetchVerdict (size known, ≤ 1 MiB, no run)',
    /PP\.liveFetchVerdict\(card,/.test(src)
);
check(
    '0x84 goes in the background lane',
    /encodeGetPatternFile\(p\.index\), \{[^}]*background: true/.test(src)
);
check('no 60 s thumbnail fetch', !/timeoutMs: 60000/.test(src));
const thumb = fnBody('async function renderPatThumb(name)');
check('renderPatThumb found', thumb.length > 0);
check('only the newest pick draws', (thumb.match(/seq !== patThumbSeq/g) || []).length >= 2);
check(
    'no other live 0x84 fetch in the picker/preview code',
    (studio.match(/sendBulkRead\(Wire\.encodeGetPatternFile\(/g) || []).length === 2,
    'expected exactly patByteSource + the SD table Download button'
);

console.log(`\n=== Summary ===\n${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
