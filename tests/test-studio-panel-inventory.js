#!/usr/bin/env node
/**
 * Tests for js/studio-panel-inventory.js (the panel-inventory reader behind the
 * Studio's link-up identity + run_metadata.panels) and its wiring in
 * arena_studio.html. No DOM: readAll() is driven by a fake send() that serves
 * canned 0xD1 pages, including a scan_id change between pages.
 * Run: node tests/test-studio-panel-inventory.js   (wired into `pixi run test`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Inv = require('../js/studio-panel-inventory.js');
const Wire = require('../js/arena-wire-g6.js');
const studioHtml = fs.readFileSync(path.join(__dirname, '..', 'arena_studio.html'), 'utf8');

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

// Build a 0xD1 page frame: header fields + entries [{status, crc32}].
function page(o) {
    const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const body = [1, o.count, o.flags, o.first, o.entries.length]
        .concat(u32(o.refCrc || 0), u32(o.fpLen || 65536), u32(o.ageMs || 100), [o.scanId])
        .concat(o.entries.flatMap((e) => [e.status].concat(u32(e.crc32 || 0))));
    return Uint8Array.from([body.length + 2, 0x00, 0xd1].concat(body));
}
const fwA = 0x9be0d3c7;
const fwB = 0x03e66c15;

// Fake send: routes by the request's `first` byte, serving the page set `pagesByFirst`;
// `onCall` lets a test mutate the world between pages.
function fakeSend(pagesByFirst, onCall) {
    const calls = [];
    return {
        calls,
        send: async (bytes) => {
            const first = bytes.length >= 3 ? bytes[2] : 0;
            calls.push(first);
            if (onCall) onCall(calls.length, first);
            const p = pagesByFirst[first];
            if (!p) throw new Error('no page for first=' + first);
            return p;
        }
    };
}

(async () => {
    console.log('=== readAll: one page (20 panels) ===');
    {
        const entries = Array.from({ length: 20 }, () => ({ status: 5, crc32: fwA }));
        const f = fakeSend({ 0: page({ count: 20, flags: 0x13, first: 0, scanId: 3, entries }) });
        const r = await Inv.readAll(f.send);
        check('one page → one request', f.calls, [0]);
        check('entries', r.entries.length, 20);
        const inv = Inv.summarize(r);
        check('present', inv.present.length, 20);
        check('missing', inv.missing, []);
        check(
            'firmware groups',
            inv.firmware.map((g) => [g.hex, g.panels.length]),
            [['0x9BE0D3C7', 20]]
        );
        check('mismatched (single fw, no ref)', inv.mismatched, []);
        check('scanId', inv.scanId, 3);
        check(
            'describe',
            Inv.describe(inv),
            '20/20 present · fw 0x9BE0D3C7 ×20 (64 KB prefix, no SD image)'
        );
        const meta = Inv.toRunMeta(inv);
        check('run meta shape', Object.keys(meta), [
            'schema',
            'status',
            'count',
            'present',
            'missing',
            'panel_status',
            'firmware',
            'mismatched',
            'ref_crc32',
            'fp_len',
            'presence_valid',
            'fp_valid',
            'fp_in_progress',
            'scan_id',
            'age_ms'
        ]);
        check('run meta status ok when presence is valid', [meta.schema, meta.status], [1, 'ok']);
        check('run meta firmware', meta.firmware, [
            { crc32: '0x9BE0D3C7', panels: entries.map((_, i) => i + 1) }
        ]);
        check('run meta ref_crc32 null without SD image', meta.ref_crc32, null);
        check('run meta per-panel status array', meta.panel_status.length, 20);
        check('run meta explicit status wins', Inv.toRunMeta(inv, 'pending').status, 'pending');
    }

    console.log('\n=== readAll: incoherent pages (wrong first / panel_count) → re-read ===');
    {
        const e0 = Array.from({ length: 32 }, () => ({ status: 2 }));
        const e1 = Array.from({ length: 8 }, () => ({ status: 2 }));
        let served = 0;
        const f = {
            calls: [],
            send: async (bytes) => {
                const first = bytes.length >= 3 ? bytes[2] : 0;
                f.calls.push(first);
                served++;
                // The first second page comes back for the wrong offset; the retry is right.
                const wrongFirst = served === 2 ? 0 : first;
                return page({
                    count: 40,
                    flags: 1,
                    first: wrongFirst,
                    scanId: 5,
                    entries: first ? e1 : e0
                });
            }
        };
        const r = await Inv.readAll(f.send);
        check('re-read after a wrong-offset page', f.calls, [0, 32, 0, 32]);
        check('40 entries after the retry', r.entries.length, 40);
    }

    console.log('\n=== readAll: two pages (48 panels), consistent ===');
    {
        const e0 = Array.from({ length: 32 }, () => ({ status: 3, crc32: fwA }));
        const e1 = Array.from({ length: 16 }, (_, i) => ({
            status: i === 4 ? 4 : 3,
            crc32: i === 4 ? fwB : fwA
        }));
        const f = fakeSend({
            0: page({
                count: 48,
                flags: 0x0b,
                first: 0,
                scanId: 9,
                refCrc: fwA,
                fpLen: 135248,
                entries: e0
            }),
            32: page({
                count: 48,
                flags: 0x0b,
                first: 32,
                scanId: 9,
                refCrc: fwA,
                fpLen: 135248,
                entries: e1
            })
        });
        const inv = Inv.summarize(await Inv.readAll(f.send));
        check('two requests: first=0 then 32', f.calls, [0, 32]);
        check('48 statuses', inv.statuses.length, 48);
        check('refPresent', inv.refPresent, true);
        check('mismatched = the fw_differs panel (37)', inv.mismatched, [37]);
        check(
            'firmware groups sorted by size',
            inv.firmware.map((g) => [g.hex, g.panels.length]),
            [
                ['0x9BE0D3C7', 47],
                ['0x03E66C15', 1]
            ]
        );
        checkBool(
            'describe flags the mismatch',
            Inv.describe(inv).includes('1 ≠ SD panel.bin'),
            Inv.describe(inv)
        );
        check('run meta ref_crc32', Inv.toRunMeta(inv).ref_crc32, '0x9BE0D3C7');
    }

    console.log('\n=== readAll: scan_id changes between pages → re-read ===');
    {
        const e0 = Array.from({ length: 32 }, () => ({ status: 2 }));
        const e1 = Array.from({ length: 16 }, () => ({ status: 2 }));
        const pages = {
            0: page({ count: 48, flags: 0x01, first: 0, scanId: 1, entries: e0 }),
            32: page({ count: 48, flags: 0x01, first: 32, scanId: 2, entries: e1 }) // a rescan landed
        };
        const f = fakeSend(pages, (n) => {
            if (n === 2)
                pages[0] = page({ count: 48, flags: 0x01, first: 0, scanId: 2, entries: e0 }); // page 0 now agrees
        });
        const inv = Inv.summarize(await Inv.readAll(f.send));
        check('re-read from first=0 after the mismatch', f.calls, [0, 32, 0, 32]);
        check('settled on scan_id 2', inv.scanId, 2);
    }
    {
        // Never settles → throws after `retries` attempts.
        let flip = 0;
        const e = Array.from({ length: 32 }, () => ({ status: 2 }));
        const f = fakeSend({}, () => {});
        f.send = async (bytes) => {
            const first = bytes.length >= 3 ? bytes[2] : 0;
            flip++;
            return page({
                count: 40,
                flags: 1,
                first,
                scanId: flip,
                entries: first ? e.slice(0, 8) : e
            });
        };
        let threw = null;
        try {
            await Inv.readAll(f.send, { retries: 2 });
        } catch (err) {
            threw = err.message;
        }
        check('gives up after retries', threw, 'scan_id changed between pages');
    }

    console.log('\n=== summarize: presence-only, partial, no-ISP ===');
    {
        const entries = [
            { status: 5, crc32: fwA },
            { status: 1 },
            { status: 6 },
            { status: 5, crc32: fwA },
            { status: 5, crc32: fwB }
        ];
        const inv = Inv.summarize({
            pages: [
                Wire.decodePanelInventory(
                    page({ count: 5, flags: 0x15, first: 0, scanId: 4, entries })
                )
            ],
            entries: Wire.decodePanelInventory(
                page({ count: 5, flags: 0x15, first: 0, scanId: 4, entries })
            ).entries
        });
        check('present excludes absent', inv.present, [1, 3, 4, 5]);
        check('missing', inv.missing, [2]);
        check('noIsp', inv.noIsp, [3]);
        check('fpInProgress', inv.fpInProgress, true);
        check('minority fw + no-ISP are mismatched', inv.mismatched, [3, 5]);
        checkBool(
            'describe says fingerprinting…',
            Inv.describe(inv).includes('fingerprinting…'),
            Inv.describe(inv)
        );
        const pending = Inv.summarize({
            pages: [
                Wire.decodePanelInventory(
                    page({
                        count: 5,
                        flags: 0x00,
                        first: 0,
                        scanId: 0,
                        entries: entries.map(() => ({ status: 0 }))
                    })
                )
            ],
            entries: []
        });
        check('describe before the boot scan', Inv.describe(pending), 'panel scan pending');
        check('toRunMeta(pending) status', Inv.toRunMeta(pending).status, 'pending');
        check(
            'toRunMeta records presence_valid=false',
            Inv.toRunMeta(pending).presence_valid,
            false
        );
        check('describe(null)', Inv.describe(null), '—');
        check('toRunMeta(null) = unsupported, never null', Inv.toRunMeta(null), {
            schema: 1,
            status: 'unsupported'
        });
        check('toRunMeta(null, failed)', Inv.toRunMeta(null, 'failed'), {
            schema: 1,
            status: 'failed'
        });
    }

    console.log('\n=== arena_studio.html wiring ===');
    checkBool(
        'studio loads js/studio-panel-inventory.js as a classic script',
        /<script src="js\/studio-panel-inventory\.js"><\/script>/.test(studioHtml)
    );
    checkBool(
        'studio reads the inventory on link-up (refreshPanelInventory defined + called)',
        /Studio\.refreshPanelInventory = async function/.test(studioHtml) &&
            (studioHtml.match(/await Studio\.refreshPanelInventory\(\)/g) || []).length >= 2
    );
    checkBool(
        'inventory read is gated on the panel_inventory feature',
        /features[\s\S]{0,120}includes\('panel_inventory'\)/.test(studioHtml)
    );
    checkBool(
        'run_metadata carries panels with its status',
        /toRunMeta\(Studio\.panels, Studio\.panelsStatus\)/.test(studioHtml)
    );
    checkBool(
        'run start re-reads the inventory before startRunLog (run-start snapshot)',
        /await Studio\.refreshPanelInventory\(\{ quiet: true \}\);\s*\n\s*startRunLog\(isExperiment\);/.test(
            studioHtml
        )
    );
    checkBool(
        'a failed read never leaves a stale inventory',
        /Studio\.panels = null;\s*\n\s*if \(!Studio\.session/.test(studioHtml) &&
            /catch \(e\) \{\s*\n\s*Studio\.panelsStatus = 'failed';/.test(studioHtml)
    );
    checkBool(
        'disconnect clears features + panels',
        /Studio\.features = null;\s*\n\s*Studio\.panels = null;/.test(studioHtml)
    );
    checkBool('provenance box shows panels', /id="pvPanels"/.test(studioHtml));
    checkBool(
        'Console fw panel has inventory + rescan buttons',
        /data-cmd="cinv"/.test(studioHtml) && /data-cmd="cinvscan"/.test(studioHtml)
    );
    checkBool(
        'Rescan stops the display, so it is guardDestructive',
        /cinvscan: \(\) => guardDestructive\(async/.test(studioHtml)
    );
    checkBool(
        'follow-up reads go through the gated scheduler (no bare setTimeout)',
        (studioHtml.match(/Studio\.scheduleInventoryFollowUp\(/g) || []).length >= 2 &&
            !/setTimeout\(\(\) => Studio\.refreshPanelInventory\(\), 3000\)/.test(studioHtml)
    );

    console.log('\n=== Summary ===');
    console.log(`${total - failures} / ${total} checks passed`);
    process.exit(failures ? 1 : 0);
})();
