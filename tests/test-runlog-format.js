#!/usr/bin/env node
/**
 * Tests for js/runlog-format.js — the shared run-log FILE decoder every reader uses
 * (dashboard, replay parser, Alt Studio replay): gzip detection + inflation
 * (whole file and truncated prefix), behavior_v2 compact arena echo → exact v1
 * object (incl. the timeout rule: status/echo/ok ALL null), the per-file
 * normalizer, format detection, and the JS v1⇄v2 text converters used by the
 * dashboard parity checks. Also enforces that the dashboard's vendored copy is
 * byte-identical to js/runlog-format.js. Run: node tests/test-runlog-format.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const F = require('../js/runlog-format.js');

let total = 0;
let failures = 0;
function check(name, got, expected) {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`}`
    );
    if (!ok) failures++;
}
function checkBool(name, ok, info) {
    total++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + (info || '')}`);
    if (!ok) failures++;
}
function checkThrows(name, fn, re) {
    total++;
    try {
        fn();
        console.log(`  FAIL  ${name} — did not throw`);
        failures++;
    } catch (e) {
        const ok = !re || re.test(e.message);
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} (threw ${e.message})`);
        if (!ok) failures++;
    }
}

// Real v1 line shapes (rig03-sr run rydc2tql, values trimmed) + the bridge's
// Python-produced compact arrays for the same lines (tests/test-bridge-behavior.py).
const T0 = 1788636439304;
const A_OK = {
    type: 'log',
    event: 'arena_command',
    t: 1788636442353,
    dt: 7,
    len: 4,
    head: '03 70 2e 00',
    status: 0,
    echo: 112,
    ok: true,
    error: null,
    dir: 'browser→bridge',
    rx_ms: 1788636442360
};
const A_REJECT = {
    ...A_OK,
    t: 1788636442400,
    dt: 4,
    head: '03 70 31 00',
    status: 1,
    ok: false,
    rx_ms: 1788636442405
};
const A_TIMEOUT = {
    ...A_OK,
    t: 1788636442467,
    dt: 505,
    head: '03 70 a6 00',
    status: null,
    echo: null,
    ok: null,
    error: 'response timeout after 500 ms (cmd 0x70)',
    rx_ms: 1788636442972
};
const A_OK_ARR = ['a', 3049, 7, '03702e00', 0, 3056];
const A_TIMEOUT_ARR = [
    'a',
    3163,
    505,
    '0370a600',
    null,
    3668,
    'response timeout after 500 ms (cmd 0x70)'
];
const SCHEMA_V2 = {
    type: 'frame_schema',
    level: 'behavior_v2',
    cols: ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd'],
    arena_cols: ['t_off', 'dt', 'hex', 'status', 'rx_off'],
    t0: T0
};
const FRAME = [5, 9052, 39, 0.0, 1.42578, -3.19222, 1.21378];

async function main() {
    console.log('=== vendored copy is byte-identical ===');
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'runlog-format.js'), 'utf8');
    const vendored = fs.readFileSync(
        path.join(__dirname, '..', 'dashboard', 'data-browser', 'vendor', 'runlog-format.js'),
        'utf8'
    );
    checkBool(
        'dashboard/data-browser/vendor/runlog-format.js === js/runlog-format.js',
        src === vendored,
        'copy js/runlog-format.js over the vendored file'
    );

    console.log('=== isGzip / names ===');
    const gz = zlib.gzipSync(Buffer.from('{"a":1}\n'));
    check('gzip magic detected', F.isGzip(new Uint8Array(gz)), true);
    check('Buffer accepted', F.isGzip(gz), true);
    check('plain text not gzip', F.isGzip(new TextEncoder().encode('{"a":1}')), false);
    check('empty not gzip', F.isGzip(new Uint8Array(0)), false);
    check('garbage input not gzip', F.isGzip(null), false);
    check('isRunlogName .jsonl', F.isRunlogName('run.jsonl'), true);
    check('isRunlogName .jsonl.gz', F.isRunlogName('runlogs/rig1/run.jsonl.gz'), true);
    check('isRunlogName .ndjson', F.isRunlogName('x.ndjson'), true);
    check(
        'isRunlogName rejects bare .json — runlogs/<folder>/index.json is a catalog, not a run',
        [
            F.isRunlogName('x.json'),
            F.isRunlogName('runlogs/rig1/index.json'),
            F.isRunlogName('index.json.gz')
        ],
        [false, false, false]
    );
    check(
        'isRunlogName rejects .yaml / .gz alone',
        [F.isRunlogName('p.yaml'), F.isRunlogName('x.gz')],
        [false, false]
    );
    check('stripGz', F.stripGz('a__b__c__d.jsonl.gz'), 'a__b__c__d.jsonl');
    check('stripGz no-op', F.stripGz('a.jsonl'), 'a.jsonl');

    console.log('=== inflateIfGzip / readRunlogText ===');
    const text = [JSON.stringify(SCHEMA_V2), JSON.stringify(FRAME), 'héllo ☃'].join('\n') + '\n';
    const gzBytes = new Uint8Array(zlib.gzipSync(Buffer.from(text, 'utf8')));
    check('inflateIfGzip inflates', new TextDecoder().decode(await F.inflateIfGzip(gzBytes)), text);
    const plain = new TextEncoder().encode(text);
    check(
        'inflateIfGzip passes plain bytes through (same object)',
        (await F.inflateIfGzip(plain)) === plain,
        true
    );
    check('readRunlogText(string) as-is', await F.readRunlogText(text), text);
    check('readRunlogText(gz Uint8Array)', await F.readRunlogText(gzBytes), text);
    check(
        'readRunlogText(gz ArrayBuffer)',
        await F.readRunlogText(
            gzBytes.buffer.slice(gzBytes.byteOffset, gzBytes.byteOffset + gzBytes.byteLength)
        ),
        text
    );
    check('readRunlogText(plain bytes)', await F.readRunlogText(plain), text);
    check(
        'readRunlogText(Blob of gz) — the File path',
        await F.readRunlogText(new Blob([gzBytes])),
        text
    );
    check('readRunlogText(Blob of text)', await F.readRunlogText(new Blob([text])), text);

    console.log('=== readRunlogPrefixText: truncated gzip prefix still yields the head ===');
    const big = [
        JSON.stringify({ type: 'session', event: 'logging_started', file: 'x', ms: T0 }),
        JSON.stringify(SCHEMA_V2),
        JSON.stringify({
            type: 'log',
            event: 'run_metadata',
            run_id: 'abc',
            protocol_filename: 'p3.yaml',
            dir: 'browser→bridge',
            rx_ms: T0 + 1
        })
    ];
    for (let i = 0; i < 20000; i++)
        big.push(
            JSON.stringify([
                i * 8,
                9000 + i,
                i % 200,
                i * 8.27,
                Math.sin(i) * 3,
                Math.cos(i) * 3,
                (i % 628) / 100
            ])
        );
    const bigText = big.join('\n') + '\n';
    const bigGz = new Uint8Array(zlib.gzipSync(Buffer.from(bigText)));
    checkBool(
        'fixture gz is bigger than the 64 KB prefix',
        bigGz.length > 65536,
        String(bigGz.length)
    );
    const prefix = await F.readRunlogPrefixText(bigGz.subarray(0, 65536));
    checkBool(
        'truncated gz prefix inflates to a non-empty head',
        prefix.length > 1000,
        String(prefix.length)
    );
    checkBool(
        '… containing the run_metadata line',
        /"event":"run_metadata","run_id":"abc"/.test(prefix),
        prefix.slice(0, 300)
    );
    checkBool(
        '… starting with the session line',
        prefix.startsWith('{"type":"session"'),
        prefix.slice(0, 40)
    );
    check(
        'plain prefix passes through',
        await F.readRunlogPrefixText(new TextEncoder().encode('abc')),
        'abc'
    );
    check('string prefix passes through', await F.readRunlogPrefixText('abc'), 'abc');

    console.log('=== expandV2Line: exact v1 object ===');
    check('ok line expands to the exact v1 object', F.expandV2Line(A_OK_ARR, SCHEMA_V2), A_OK);
    check(
        'key order = the v1 order',
        Object.keys(F.expandV2Line(A_OK_ARR, SCHEMA_V2)),
        F.ARENA_COMMAND_KEYS
    );
    check(
        'timeout: status/echo/ok ALL null + error restored',
        F.expandV2Line(A_TIMEOUT_ARR, SCHEMA_V2),
        A_TIMEOUT
    );
    check('t0 as a number works too', F.expandV2Line(A_OK_ARR, T0).t, A_OK.t);
    check(
        'reject (status 1) → ok false, echo = cmd byte',
        F.expandV2Line(['a', 3096, 4, '03703100', 1, 3101], T0),
        A_REJECT
    );
    check(
        'other command byte → echo 0xa0',
        F.expandV2Line(['a', 1, 9, '03a00100', 0, 2], T0).echo,
        160
    );
    check('isArenaArray: compact', F.isArenaArray(A_OK_ARR), true);
    check('isArenaArray: frame row is NOT', F.isArenaArray(FRAME), false);
    check('isArenaArray: wrong length', F.isArenaArray(['a', 1, 2]), false);
    checkThrows('malformed hex throws', () => F.expandV2Line(['a', 1, 2, '037', 0, 3], T0), /hex/);
    checkThrows(
        'float offset throws',
        () => F.expandV2Line(['a', 1.5, 2, '03700000', 0, 3], T0),
        /integers/
    );
    checkThrows(
        'missing t0 throws',
        () => F.expandV2Line(A_OK_ARR, { type: 'frame_schema', level: 'behavior_v2' }),
        /integers/
    );
    checkThrows(
        'non-string error throws',
        () => F.expandV2Line(['a', 1, 2, '03700000', null, 3, 5], T0),
        /error/
    );
    checkThrows(
        'status without command byte throws',
        () => F.expandV2Line(['a', 1, 2, '03', 0, 3], T0),
        /command byte/
    );

    console.log('=== compactV1Line: mirror of the bridge encoder ===');
    check('ok line → Python-identical array', F.compactV1Line(A_OK, T0), A_OK_ARR);
    check('timeout → 7 elements, Python-identical', F.compactV1Line(A_TIMEOUT, T0), A_TIMEOUT_ARR);
    for (const [name, o] of [
        ['ok', A_OK],
        ['reject', A_REJECT],
        ['timeout', A_TIMEOUT]
    ]) {
        check(`round trip ${name}`, F.expandV2Line(F.compactV1Line(o, T0), T0), o);
    }
    check('unknown extra key → null (verbatim)', F.compactV1Line({ ...A_OK, extra: 1 }, T0), null);
    check('echo mismatch → null', F.compactV1Line({ ...A_OK, echo: 113 }, T0), null);
    check('ok inconsistent → null', F.compactV1Line({ ...A_OK, ok: false }, T0), null);
    check(
        'truncated head (…) → null',
        F.compactV1Line({ ...A_OK, head: '03 8d 00 01 02 03 04 05 …', len: 12 }, T0),
        null
    );
    check('float t → null', F.compactV1Line({ ...A_OK, t: A_OK.t + 0.5 }, T0), null);
    check(
        'not an arena_command → null',
        F.compactV1Line({ type: 'log', event: 'runner' }, T0),
        null
    );

    console.log('=== createNormalizer ===');
    {
        const n = F.createNormalizer();
        check('fresh: format unknown', n.format, 'unknown');
        const s = { type: 'session', event: 'logging_started', ms: T0 };
        check('session passes through', n.normalize(s), s);
        check('after a non-schema line: legacy', n.format, 'legacy');
        check(
            'schema passes through + remembered',
            [n.normalize(SCHEMA_V2), n.level],
            [SCHEMA_V2, 'behavior_v2']
        );
        check('frame row untouched', n.normalize(FRAME), FRAME);
        check('compact arena → v1 object', n.normalize(A_OK_ARR), A_OK);
        check(
            'verbatim v1 arena object in a v2 file passes through',
            n.normalize(A_REJECT),
            A_REJECT
        );
        check(
            'runner object passes through',
            n.normalize({ type: 'log', event: 'runner', phase: 'x' }),
            { type: 'log', event: 'runner', phase: 'x' }
        );
        check('format = schema level', n.format, 'behavior_v2');
        check('no orphans', n.orphanArena, 0);
    }
    {
        const n = F.createNormalizer();
        const v1s = { type: 'frame_schema', level: 'behavior_v1', cols: SCHEMA_V2.cols };
        n.normalize(v1s);
        check('v1 schema → level behavior_v1', n.format, 'behavior_v1');
    }
    {
        const n = F.createNormalizer();
        const r = n.normalize(A_OK_ARR); // no schema yet → cannot place in time
        check('arena array before any schema is left as-is', r, A_OK_ARR);
        check(
            '… counted as orphan, format still v2',
            [n.orphanArena, n.format],
            [1, 'behavior_v2']
        );
    }
    {
        const n = F.createNormalizer();
        n.normalize({
            type: 'fictrac_frame',
            seq: 1,
            index: 2,
            t: 3,
            fictrac: new Array(25).fill(0)
        });
        check('full-level file detected', n.format, 'full');
    }

    console.log('=== detectFormat ===');
    check(
        'v2 text',
        F.detectFormat(JSON.stringify(SCHEMA_V2) + '\n' + JSON.stringify(FRAME)),
        'behavior_v2'
    );
    check(
        'v1 text',
        F.detectFormat('{"type":"frame_schema","level":"behavior_v1","cols":[]}\n'),
        'behavior_v1'
    );
    check(
        'v2 by arena array (no schema)',
        F.detectFormat([{ type: 'session' }, A_OK_ARR]),
        'behavior_v2'
    );
    check(
        'full by fictrac array',
        F.detectFormat([{ type: 'fictrac_frame', fictrac: new Array(25).fill(0) }]),
        'full'
    );
    check(
        'legacy',
        F.detectFormat([{ type: 'session' }, { type: 'fictrac_frame', seq: 1 }]),
        'legacy'
    );
    check('empty → unknown', F.detectFormat(''), 'unknown');
    check(
        'torn lines tolerated',
        F.detectFormat('{"type":"frame_schema","level":"behavior_v2","cols":null,"t0":1}\n{"trunc'),
        'behavior_v2'
    );

    console.log('=== convertV1ToV2Text / convertV2ToV1Text ===');
    const v1Text =
        [
            JSON.stringify({ type: 'session', event: 'logging_started', file: 'x', ms: T0 }),
            JSON.stringify({ type: 'frame_schema', level: 'behavior_v1', cols: SCHEMA_V2.cols }),
            JSON.stringify({
                type: 'log',
                event: 'run_metadata',
                run_id: 'r',
                dir: 'browser→bridge',
                rx_ms: T0 + 1
            }),
            JSON.stringify(FRAME),
            JSON.stringify(A_OK),
            JSON.stringify(A_TIMEOUT),
            JSON.stringify({ ...A_OK, extra: 1 }),
            JSON.stringify({ type: 'session', event: 'logging_stopped', ms: T0 + 500 })
        ].join('\n') + '\n';
    const v2Text = F.convertV1ToV2Text(v1Text);
    const v2Lines = v2Text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
    check('same line count', v2Lines.length, 8);
    check('schema replaced in place with t0 = session ms', v2Lines[1], SCHEMA_V2);
    check(
        'arena lines compacted (2), unknown-key one verbatim',
        v2Lines.filter(F.isArenaArray).length,
        2
    );
    check('verbatim line kept', v2Lines[6], { ...A_OK, extra: 1 });
    check('frame row unchanged', v2Lines[3], FRAME);
    check('detectFormat(v2Text)', F.detectFormat(v2Text), 'behavior_v2');
    check('v2 → v1 restores the original text exactly', F.convertV2ToV1Text(v2Text), v1Text);
    checkThrows('v1→v2 of a v2 text throws', () => F.convertV1ToV2Text(v2Text), /already/);
    checkThrows(
        'v2→v1 of a v1 text throws',
        () => F.convertV2ToV1Text(v1Text),
        /not a behavior_v2/
    );
    // legacy file (no schema): schema with cols null inserted after the session line, dropped on the way back
    const legacyText =
        [
            JSON.stringify({ type: 'session', event: 'logging_started', file: 'x', ms: T0 }),
            JSON.stringify({
                type: 'fictrac_frame',
                seq: 1,
                index: 2,
                t: T0 + 5,
                fictrac: new Array(25).fill(0)
            }),
            JSON.stringify(A_OK)
        ].join('\n') + '\n';
    const legacyV2 = F.convertV1ToV2Text(legacyText)
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
    check(
        'legacy: schema inserted at line 2 with cols null',
        [legacyV2[1].type, legacyV2[1].cols, legacyV2[1].t0],
        ['frame_schema', null, T0]
    );
    check('legacy: arena compacted', F.isArenaArray(legacyV2[3]), true);
    check(
        'legacy round trip exact',
        F.convertV2ToV1Text(F.convertV1ToV2Text(legacyText)),
        legacyText
    );
    // and through gzip + the normalizer, as a reader would see it
    const readBack = await F.readRunlogText(new Uint8Array(zlib.gzipSync(Buffer.from(v2Text))));
    const n = F.createNormalizer();
    const seen = readBack
        .trim()
        .split('\n')
        .map((l) => n.normalize(JSON.parse(l)));
    check('gz → text → normalizer yields the v1 objects', [seen[4], seen[5]], [A_OK, A_TIMEOUT]);
    check('… and the v1 schema is the v2 one (readers key on cols)', seen[1].cols, SCHEMA_V2.cols);

    console.log('\n=== Summary ===');
    console.log(`${total - failures} / ${total} checks passed`);
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
