#!/usr/bin/env node
/**
 * Tests for js/studio-data-repos.js — the data-repo registry + label helpers,
 * and the HTML wiring that consumes it (Studio Repo picker, no default write
 * repo, Pattern Designer + dashboard load the module).
 *
 * Run: node tests/test-studio-data-repos.js   (wired into `pixi run test`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const R = require('../js/studio-data-repos.js');
const U = require('../js/studio-url-state.js');
const root = path.join(__dirname, '..');
const studio = fs.readFileSync(path.join(root, 'arena_studio.html'), 'utf8');
const pd = fs.readFileSync(path.join(root, 'pattern_editor.html'), 'utf8');
const dash = fs.readFileSync(path.join(root, 'dashboard', 'data-browser', 'index.html'), 'utf8');

let total = 0;
let failures = 0;
function check(name, got, expected) {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`
    );
    if (!ok) failures++;
}
function checkBool(name, ok, info) {
    total++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!ok) failures++;
}

console.log('=== registry ===');
check('two known repos', R.DATA_REPOS.length, 2);
check('keys unique', new Set(R.DATA_REPOS.map((r) => r.key)).size, R.DATA_REPOS.length);
check('fulls unique', new Set(R.DATA_REPOS.map((r) => r.full)).size, R.DATA_REPOS.length);
for (const r of R.DATA_REPOS) {
    checkBool(r.full + ' passes StudioUrlState.isSafeRepo', U.isSafeRepo(r.full));
    checkBool(
        r.full + ' has label/idLabel/idPlaceholder/sharedLabel',
        !!(r.label && r.idLabel && r.idPlaceholder && r.sharedLabel)
    );
}
check('course repo present', !!R.findRepo('reiserlab/cshl-2026-course'), true);
check('lab repo present', !!R.findRepo('reiserlab/arena-experiments'), true);
check(
    'course repo is public (reads work signed-out)',
    R.findRepo('reiserlab/cshl-2026-course').visibility,
    'public'
);
check('lab repo is private', R.findRepo('reiserlab/arena-experiments').visibility, 'private');

console.log('=== parseRepo ===');
check('owner/name', R.parseRepo('reiserlab/arena-experiments'), {
    owner: 'reiserlab',
    name: 'arena-experiments',
    full: 'reiserlab/arena-experiments'
});
check('trims', R.parseRepo('  a/b  ').full, 'a/b');
check('rejects empty', R.parseRepo(''), null);
check('rejects null', R.parseRepo(null), null);
check('rejects traversal', R.parseRepo('a/..'), null);
check('rejects URL', R.parseRepo('https://github.com/a/b'), null);
check('rejects missing name', R.parseRepo('reiserlab'), null);
check('rejects leading hyphen owner', R.parseRepo('-x/y'), null);
check('rejects 3 segments', R.parseRepo('a/b/c'), null);

console.log('=== labels ===');
check('course label', R.repoLabel('reiserlab/cshl-2026-course'), 'CSHL 2026 course');
check(
    'lab label',
    R.repoLabel({ owner: 'reiserlab', name: 'arena-experiments' }),
    'Reiser lab experiments'
);
check('unknown repo label = owner/name', R.repoLabel('someone/else'), 'someone/else');
check('no repo label', R.repoLabel(null), 'data repo');
check('course idLabel', R.idLabel('reiserlab/cshl-2026-course'), 'Bench id');
check('lab idLabel', R.idLabel('reiserlab/arena-experiments'), 'Rig id');
check('unknown idLabel', R.idLabel('x/y'), 'Rig id');
check('course idPlaceholder', R.idPlaceholder('reiserlab/cshl-2026-course'), 'bench03');
check('course sharedLabel', R.sharedLabel('reiserlab/cshl-2026-course'), 'class-wide');
check('lab sharedLabel', R.sharedLabel('reiserlab/arena-experiments'), 'lab-wide');
check('unknown sharedLabel', R.sharedLabel('x/y'), 'shared');
check(
    'case-insensitive match',
    R.repoLabel('ReiserLab/Arena-Experiments'),
    'Reiser lab experiments'
);

console.log('=== HTML wiring ===');
checkBool(
    'Studio loads studio-data-repos.js as a classic script',
    /<script src="js\/studio-data-repos\.js"><\/script>/.test(studio)
);
checkBool(
    'Studio loads it BEFORE the module block',
    studio.indexOf('js/studio-data-repos.js') < studio.indexOf('<script type="module">')
);
checkBool(
    'Pattern Designer loads it',
    /<script src="js\/studio-data-repos\.js"><\/script>/.test(pd)
);
checkBool('dashboard loads it', /studio-data-repos\.js/.test(dash));
checkBool(
    'no default write repo: DEFAULT_COURSE_REPO gone',
    !studio.includes('DEFAULT_COURSE_REPO')
);
const csStart = studio.indexOf('Studio.courseSettings = function');
const csBody = studio.slice(csStart, studio.indexOf('};', csStart));
checkBool(
    'courseSettings reads studio_gh_repo with NO fallback repo',
    csBody.includes("localStorage.getItem('studio_gh_repo') || ''")
);
checkBool(
    'courseSettings uses StudioDataRepos.parseRepo with a regex fallback',
    csBody.includes('StudioDataRepos') &&
        csBody.includes('parseRepo') &&
        /\/\^\(\[A-Za-z0-9/.test(csBody)
);
checkBool(
    'Studio.dataRepoLabel / idLabel / sharedLabel helpers exist (classic shell)',
    studio.includes('Studio.dataRepoLabel = function') &&
        studio.includes('Studio.idLabel = function') &&
        studio.includes('Studio.sharedLabel = function')
);
checkBool('gh-block has the Repo <select>', /<select id="ghRepoSelect"/.test(studio));
checkBool(
    'gh-block keeps #ghRepoInput as the value of record',
    /<input type="text" id="ghRepoInput"/.test(studio)
);
checkBool(
    'bench/rig id label is dynamic (#ghBenchLabel) with a rig-id datalist',
    /id="ghBenchLabel"/.test(studio) &&
        /<datalist id="rigIdList">/.test(studio) &&
        /id="ghBenchId" list="rigIdList"/.test(studio)
);
const lockStart = studio.indexOf('const lockTargets = () =>');
const lockBody = studio.slice(lockStart, studio.indexOf('function applyGhLock', lockStart));
checkBool('kiosk lock covers the Repo <select>', lockBody.includes("$('ghRepoSelect')"));
checkBool('Promote button copy is repo-neutral', !/Promote to shared \(course\)/.test(studio));
checkBool('picker header uses sharedLabel', studio.includes('Studio.sharedLabel(cs)'));
checkBool('Save label uses dataRepoLabel', studio.includes("'Save → ' + Studio.dataRepoLabel(cs)"));
checkBool(
    'Pattern Designer repoSettings uses the shared parser',
    pd.includes('window.StudioDataRepos') && pd.includes('R.parseRepo(raw)')
);

console.log('\n=== Summary ===');
console.log(`${total - failures} / ${total} checks passed`);
process.exit(failures ? 1 : 0);
