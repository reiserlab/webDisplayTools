#!/usr/bin/env node
/**
 * Static guards on the panel-firmware catalog served by this site (flasher/ and the
 * Studio's Choose… picker). Background: on 2026-09-28 the flasher's default entry was
 * a stale pre-release build that put the PE03 frame-drop bug on ten new panels.
 *   - the default build comes from the published Pages manifest, never from this site
 *   - with no default (catalog unreachable) the flasher shows a disabled placeholder
 *   - the legacy images on this site are listed in ONE hashed manifest both pages read
 *   - every legacy file exists and matches its sha256; no stale / dev / v0.2.1 / BETA image remains
 *   - the flash path fetches through the shared verified fetch (status + sha256)
 * Run: node tests/test-flasher-catalog.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const flasherJs = read('flasher/flasher.js');
const flasherHtml = read('flasher/index.html');
const studio = read('arena_studio.html');
const fwDir = path.join(root, 'flasher', 'firmware');
const fwFiles = fs.existsSync(fwDir) ? fs.readdirSync(fwDir) : [];

let total = 0;
let failures = 0;
function checkBool(name, ok, info) {
    total++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + (info || '')}`);
    if (!ok) failures++;
}

console.log('=== flasher/firmware/legacy-manifest.json ===');
let legacy = null;
try {
    legacy = JSON.parse(read('flasher/firmware/legacy-manifest.json'));
} catch (e) {
    checkBool('legacy manifest parses', false, e.message);
}
if (legacy) {
    checkBool(
        'legacy manifest has artifacts',
        Array.isArray(legacy.artifacts) && legacy.artifacts.length >= 1
    );
    for (const a of legacy.artifacts || []) {
        checkBool(`${a.label}: default is false`, a.default === false);
        checkBool(`${a.label}: marked legacy`, a.legacy === true);
        checkBool(`${a.label}: has a fingerprint`, /^0x[0-9A-F]{8}$/.test(a.fingerprint || ''));
        for (const kind of ['uf2', 'bin']) {
            const f = a[kind] && a[kind].file;
            checkBool(`${a.label}: ${kind} listed`, !!f);
            if (!f) continue;
            const exists = fwFiles.includes(f);
            checkBool(`${kind} exists: ${f}`, exists);
            if (exists) {
                const got = crypto
                    .createHash('sha256')
                    .update(fs.readFileSync(path.join(fwDir, f)))
                    .digest('hex');
                checkBool(
                    `${kind} sha256 matches: ${f}`,
                    got === a[kind].sha256,
                    `got ${got.slice(0, 12)}…`
                );
            }
        }
    }
    // The fingerprint listed for a legacy UF2 must equal CRC-32 of the first 64 KiB of its
    // flattened payload — the number the controller's panel inventory (0xD1) reports.
    function crc32(buf) {
        let c = 0xffffffff;
        for (let i = 0; i < buf.length; i++) {
            c ^= buf[i];
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        return (c ^ 0xffffffff) >>> 0;
    }
    for (const a of legacy.artifacts || []) {
        if (!(a.bin && fwFiles.includes(a.bin.file))) continue;
        const bin = fs.readFileSync(path.join(fwDir, a.bin.file));
        const fp = '0x' + crc32(bin.subarray(0, 65536)).toString(16).toUpperCase().padStart(8, '0');
        checkBool(`${a.label}: fingerprint matches the .bin (${fp})`, fp === a.fingerprint);
    }
}

console.log('\n=== flasher/flasher.js ===');
checkBool(
    'reads the legacy manifest',
    /LEGACY_MANIFEST = 'firmware\/legacy-manifest\.json'/.test(flasherJs)
);
checkBool(
    'no hard-coded local build list',
    !/const LOCAL_BUILDS = \[|const LEGACY_BUILDS = \[/.test(flasherJs)
);
checkBool(
    'legacy entries can never be defaults',
    /default: local \? false : !!a\.default/.test(flasherJs)
);
checkBool(
    'published catalog comes before legacy in the merged list',
    /\[\.\.\.remote, \.\.\.legacy\]/.test(flasherJs)
);
checkBool(
    'placeholder when nothing is default (catalog unreachable)',
    /firmware\.builds\.some\(\(b\) => b\.default\)/.test(flasherJs) &&
        /— choose a build —/.test(flasherJs)
);
checkBool(
    'flash path uses the shared verified fetch',
    /const uf2 = await fetchBuildBytes\(b\)/.test(flasherJs)
);
checkBool(
    'shared fetch verifies sha256 and status',
    /sha256 mismatch/.test(flasherJs) &&
        /HTTP \$\{res\.status\}/.test(flasherJs) &&
        /cache: 'no-store'/.test(flasherJs)
);
checkBool(
    'flash refuses on a catalog fingerprint mismatch (fail closed, like the Studio picker)',
    /Refusing to flash: catalog fingerprint mismatch/.test(flasherJs) &&
        /const got = hex32\(fingerprintOfBlocks\(blocks\)\)/.test(flasherJs)
);
checkBool(
    'dropdown locked while flashing',
    /\$\('build-select'\)\.disabled = true/.test(flasherJs)
);
checkBool(
    'fingerprint computed from the bytes to be flashed + catalog cross-check',
    /fingerprintOfBlocks\(parseUF2\(buf\)\)/.test(flasherJs) &&
        /the image and its listing disagree, so this build cannot be flashed/.test(flasherJs) &&
        /if \(mismatch\) \$\('flash-btn'\)\.disabled = true/.test(flasherJs)
);
checkBool('no stale -isp.uf2 references', !/-isp\.uf2/.test(flasherJs));
checkBool(
    'no v0.2.1 references (hardware retired)',
    !/v0\.2\.1|pico_v021|G6 Panel v0\.2/.test(flasherJs)
);
checkBool(
    'no BETA 2P entry (folded into production in panel-fw-v1.3.0)',
    !/BETA-eintlow-2p|eintlow_2p/.test(flasherJs)
);

console.log('\n=== flasher/firmware/ ===');
for (const f of fwFiles) {
    const stale = /-isp\.uf2$|progress-|fleet-|BETA|v0\.2\.1|manifest-dev/.test(f);
    checkBool(`no stale image on disk: ${f}`, !stale);
}
checkBool('dev manifest removed', !fwFiles.includes('manifest-dev.json'));

console.log('\n=== flasher/index.html ===');
checkBool('fingerprint element present', /id="build-fp"/.test(flasherHtml));
checkBool(
    'no v0.2.1 revision-picking text',
    !/v0\.2\.1 and v0\.3\.1 use different binaries/.test(flasherHtml)
);

console.log('\n=== arena_studio.html picker ===');
checkBool('no dev manifest source', !/FW_DEV_MANIFEST|manifest-dev\.json/.test(studio));
checkBool('published manifest is the source', /FW_PAGES_BASE \+ '\/manifest\.json'/.test(studio));
checkBool(
    'legacy list comes from the shared manifest, not a hard-coded array',
    /FW_LEGACY_MANIFEST = 'flasher\/firmware\/legacy-manifest\.json'/.test(studio) &&
        !/const FW_LEGACY = \[/.test(studio)
);
checkBool(
    'legacy entries are never defaults',
    /isDefault: legacy \? false : !!a\.default/.test(studio)
);
checkBool(
    'picker rows show the fingerprint',
    /fingerprint ' \+ entry\.fingerprint|fingerprint 0x/.test(studio)
);
checkBool(
    'Use re-fetches through the shared cache and sha256-verifies',
    /const data = await fwEntryBytes\(entry\)/.test(studio) && /sha256 MISMATCH/.test(studio)
);

console.log('\n=== catalog sanity + docs ===');
checkBool(
    'flasher refuses more than one published default',
    /defaults\.length > 1/.test(flasherJs) && /refusing to pick one/.test(flasherJs)
);
checkBool('flasher drops duplicate catalog files', /Duplicate catalog entry/.test(flasherJs));
checkBool(
    'Studio verifies the catalog fingerprint against the bytes before uploading',
    /fingerprint MISMATCH for/.test(studio)
);
checkBool(
    'Studio evicts a failed fetch from its cache',
    /fwBytesCache\.delete\(entry\.file\)/.test(studio)
);
// No doc or page may point at a firmware file this site no longer serves.
const served = new Set(fwFiles);
const textFiles = fs
    .readdirSync(path.join(root, 'docs', 'development'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => 'docs/development/' + f)
    .concat(
        ['flasher/index.html', 'flasher/flasher.js', 'arena_studio.html', 'README.md'].filter((f) =>
            fs.existsSync(path.join(root, f))
        )
    );
const referenced = new Map();
for (const f of textFiles) {
    for (const m of read(f).matchAll(/flasher\/firmware\/([A-Za-z0-9._-]+\.(?:uf2|bin|json))/g)) {
        if (!served.has(m[1])) referenced.set(m[1], (referenced.get(m[1]) || []).concat(f));
    }
}
for (const [file, where] of referenced) {
    // The superseded 2P checklist keeps its history (banner at the top says the files are gone).
    const only2p = where.every((w) => w.endsWith('2p-line-sync-rig-checklist.md'));
    checkBool(
        `no live reference to a removed image: ${file}`,
        only2p,
        'referenced from ' + [...new Set(where)].join(', ')
    );
}
checkBool(
    '2P rig checklist marked superseded',
    /Superseded \(2026-09-29\)/.test(read('docs/development/2p-line-sync-rig-checklist.md'))
);

console.log('\n=== Summary ===');
console.log(`${total - failures} / ${total} checks passed`);
process.exit(failures ? 1 : 0);
