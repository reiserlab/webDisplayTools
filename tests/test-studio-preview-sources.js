#!/usr/bin/env node
/**
 * Tests for js/studio-preview-sources.js (layered pattern-preview byte sources) and
 * the Studio contract around it (LAB-303 S2, ww18 2026-10-15): a `?p=` link stayed
 * empty until a refresh because initFromUrl AWAITED a GitHub listing (the course
 * repo's shared patterns/) before loading the protocol. The listing is now
 * fire-and-forget, which is only safe because precedence no longer depends on which
 * listing arrives first.
 *
 * Run: node tests/test-studio-preview-sources.js   (picked up by `pixi run test`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Sources = require('../js/studio-preview-sources.js');

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
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}
const src = (tag) => () => tag; // a byte source stand-in that names its origin

console.log('=== layers, low → high precedence ===');
check('LAYERS', Sources.LAYERS, ['builtin', 'shared', 'colocated', 'uploaded']);

console.log('\n=== precedence does not depend on arrival order ===');
{
    // Every permutation of the four layers registering the same filename.
    const perms = (a) =>
        a.length <= 1
            ? [a]
            : a.flatMap((x, i) => perms(a.filter((_, j) => j !== i)).map((p) => [x, ...p]));
    let allOk = true;
    for (const order of perms(Sources.LAYERS)) {
        const r = Sources.create();
        for (const layer of order) r.set(layer, '001_grating.pat', src(layer));
        if (r.get('001_grating.pat')() !== 'uploaded') allOk = false;
    }
    checkBool('uploaded wins in all 24 arrival orders', allOk);

    // THE S2 case: the colocated listing lands first, the shared listing late.
    const r = Sources.create();
    r.set('colocated', 'p3_heisenberg.pat', src('colocated'));
    r.replaceLayer('shared', [
        ['p3_heisenberg.pat', src('shared')],
        ['only_shared.pat', src('shared')]
    ]);
    check(
        'a late shared listing does not override colocated',
        r.get('p3_heisenberg.pat')(),
        'colocated'
    );
    check('…and still serves names only it has', r.get('only_shared.pat')(), 'shared');
    check(
        'layerOf',
        [r.layerOf('p3_heisenberg.pat'), r.layerOf('only_shared.pat'), r.layerOf('x')],
        ['colocated', 'shared', null]
    );

    const b = Sources.create();
    b.set('shared', 'all_on.pat', src('shared'));
    b.set('builtin', 'all_on.pat', src('builtin')); // the built-in manifest landing last
    check(
        'a late built-in manifest does not override the repo library',
        b.get('all_on.pat')(),
        'shared'
    );
}

console.log('\n=== replaceLayer swaps one layer only ===');
{
    const r = Sources.create();
    r.set('builtin', 'a.pat', src('builtin'));
    r.replaceLayer('shared', [
        ['a.pat', src('shared-1')],
        ['b.pat', src('shared-1')]
    ]);
    r.set('colocated', 'c.pat', src('colocated'));
    r.replaceLayer('shared', [['d.pat', src('shared-2')]]); // repo changed
    check('old shared entries gone; builtin shows through again', r.get('a.pat')(), 'builtin');
    check('b.pat (old repo only) is gone', r.has('b.pat'), false);
    check('new shared entry', r.get('d.pat')(), 'shared-2');
    check('colocated untouched', r.get('c.pat')(), 'colocated');
    check('namesIn(shared)', r.namesIn('shared'), ['d.pat']);
    r.clearLayer('colocated');
    check('clearLayer', r.has('c.pat'), false);
}

console.log('\n=== reads look like a Map of the effective sources ===');
{
    const r = Sources.create();
    r.set('builtin', 'x.pat', src('builtin'));
    r.set('shared', 'x.pat', src('shared'));
    r.set('builtin', 'y.pat', src('builtin'));
    const seen = [];
    for (const [name, fn] of r) seen.push(name + '=' + fn());
    check('iteration: one entry per name, the effective one', seen.sort(), [
        'x.pat=shared',
        'y.pat=builtin'
    ]);
    check('size counts names, not entries', r.size, 2);
    check('get of an unknown name', r.get('nope.pat'), undefined);
    let threw = false;
    try {
        r.set('bogus', 'z.pat', src('z'));
    } catch (_) {
        threw = true;
    }
    check('an unknown layer throws (a typo must not silently mis-rank a source)', threw, true);
}

console.log('\n=== Studio contract (arena_studio.html source) ===');
{
    const studio = fs.readFileSync(path.join(__dirname, '..', 'arena_studio.html'), 'utf8');
    const tag = studio.indexOf('<script src="js/studio-preview-sources.js');
    const firstModule = studio.indexOf('<script type="module">');
    checkBool(
        'the module loads as a classic script before the module block',
        tag > 0 && tag < firstModule
    );

    const writes = studio.match(/webPreviewBySdName\.set\(([^,]*),/g) || [];
    checkBool(
        'every webPreviewBySdName.set names a known layer',
        writes.length >= 3 &&
            writes.every((w) => Sources.LAYERS.some((l) => w.includes("'" + l + "'"))),
        writes.join(' | ')
    );
    checkBool(
        'the shared listing replaces its own layer and drops superseded replies',
        studio.includes("webPreviewBySdName.replaceLayer('shared', entries);") &&
            studio.includes('if (gen !== sharedPreviewGen) return;')
    );

    // Everything initFromUrl awaits BEFORE it loads `?p=` must be same-origin: a GitHub
    // (or any remote) call here is what left the ww18 tab empty until a refresh.
    const start = studio.indexOf('async function initFromUrl() {');
    const pLoad = studio.indexOf('} else if (state.p) {', start);
    const prefix = start > 0 && pLoad > start ? studio.slice(start, pLoad) : '';
    checkBool('initFromUrl + its ?p= branch found', prefix.length > 0);
    const awaited = (prefix.match(/await\s+[\w.]+\(/g) || []).map((s) =>
        s.replace(/^await\s+/, '').replace(/\($/, '')
    );
    // `openFromCourseRepo` is the ?repo=&p= load itself (the protocol lives on GitHub).
    const allowed = [
        'populateMetaDatalists',
        'populateSessionRig',
        'fetch',
        'res.json',
        'openFromCourseRepo',
        'guarded', // the same-origin pre-steps (rig / vocab population), each wrapped in a try/catch
        'fn' // …and the awaited callee inside guarded()
    ];
    checkBool(
        'nothing else is awaited before the ?p= load',
        awaited.every((a) => allowed.includes(a)),
        JSON.stringify(awaited)
    );
    checkBool(
        'the shared + colocated preview listings are started, not awaited',
        /\n\s+refreshRepoSharedPatternPreviews\(\)\.catch\(/.test(prefix) &&
            /\n\s+rewireRepoPatternPreviews\(\)\.catch\(/.test(prefix)
    );
    checkBool(
        'the protocol registry fetch itself stays same-origin and uncached',
        prefix.includes("await fetch('./protocols/index.json', { cache: 'no-store' })")
    );
}

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures ? 1 : 0);
