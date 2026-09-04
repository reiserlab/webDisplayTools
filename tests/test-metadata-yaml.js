#!/usr/bin/env node
/**
 * Guard for configs/metadata/*.yaml — the site-library controlled vocabularies
 * (experimenter / genotype / age / sex / fly-number pick-lists) that Arena Studio
 * loads at page start (populateMetaDatalists) and falls back to whenever no data
 * repo is signed in.
 *
 * Why: these files are edited in the GitHub web UI. A one-space indent slip in
 * people.yaml (2026-08-27) made the vendored YAML parser throw; the Studio's
 * loadVocab() swallows parse errors, so the ONLY symptom was an empty Experimenter
 * dropdown — which blocks recorded runs. Nothing in CI parsed these files.
 *
 * Parses each file with the SAME vendored `yaml` build the browser uses and checks
 * the expected top-level key holds a non-empty list of the expected shape.
 *
 * Run: node tests/test-metadata-yaml.js   (wired into `pixi run test` + CI)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const META_DIR = path.join(__dirname, '..', 'configs', 'metadata');
// file → { key, shape }. shape 'people' = [{id,name}], 'strings' = non-empty
// scalars (numbers allowed for fly_numbers).
const EXPECTED = {
    'people.yaml': { key: 'people', shape: 'people' },
    'genotypes.yaml': { key: 'genotypes', shape: 'strings' },
    'ages.yaml': { key: 'ages', shape: 'strings' },
    'sexes.yaml': { key: 'sexes', shape: 'strings' },
    'fly_numbers.yaml': { key: 'fly_numbers', shape: 'strings' }
};

let totalChecks = 0;
let failures = 0;
function check(name, ok, info) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

(async () => {
    // The browser build is ESM; dynamic import works from CommonJS on Node >= 22.12.
    const mod = await import('../js/vendor/yaml/browser/dist/index.js');
    const YAML = mod.default || mod;

    const files = fs.readdirSync(META_DIR).filter((f) => /\.ya?ml$/i.test(f));
    console.log('=== configs/metadata/*.yaml parse + shape ===');
    for (const f of files) {
        const exp = EXPECTED[f];
        check(f + ' is a known vocab file', !!exp, exp ? '' : 'add it to EXPECTED in this test');
        if (!exp) continue;
        let data = null;
        let err = null;
        try {
            data = YAML.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8'));
        } catch (e) {
            err = e;
        }
        check(f + ' parses', !err, err ? String(err.message).split('\n')[0] : '');
        if (err) continue;
        const list = data && data[exp.key];
        check(f + ' has non-empty `' + exp.key + ':` list', Array.isArray(list) && list.length > 0);
        if (!Array.isArray(list)) continue;
        if (exp.shape === 'people') {
            const bad = list.filter((p) => !p || typeof p !== 'object' || !p.id || !p.name);
            check(
                f + ' entries all have id + name',
                bad.length === 0,
                bad.length ? JSON.stringify(bad[0]) : ''
            );
            const ids = list.map((p) => p && p.id);
            check(f + ' ids unique', new Set(ids).size === ids.length);
        } else {
            const bad = list.filter(
                (v) => !(typeof v === 'string' ? v.trim() : Number.isFinite(v))
            );
            check(
                f + ' entries are non-empty scalars',
                bad.length === 0,
                bad.length ? JSON.stringify(bad[0]) : ''
            );
        }
    }
    for (const f of Object.keys(EXPECTED)) {
        check(f + ' exists', files.includes(f));
    }

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures ? 1 : 0);
})();
