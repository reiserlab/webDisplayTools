#!/usr/bin/env node
/**
 * Tests for js/studio-url-state.js — the #107 URL state codec.
 * Covers encode/decode round-trip, mode clamping + shared-link→Run, unknown-key
 * drops, path-traversal rejection, and the local-doc shareability boundary.
 *
 * Run: node tests/test-studio-url-state.js   (wired into `pixi run test`)
 */
'use strict';

const U = require('../js/studio-url-state.js');

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

const ALLOWED = ['looming_v3', 'g6_2x10_smoke'];

// ── decode: valid params ─────────────────────────────────────────────────────
console.log('=== decode: valid ===');
let d = U.decode('?p=looming_v3&mode=edit', { allowedKeys: ALLOWED });
// mode=edit + a shared p ⇒ forced to Run (newbie-safety).
check('shared protocol forces Run', d.state.mode, 'run');
check('p resolved', d.state.p, 'looming_v3');
checkBool(
    'warns about forced Run',
    d.warnings.some((w) => /Run/.test(w)),
    d.warnings.join('|')
);

d = U.decode('?mode=edit', { allowedKeys: ALLOWED });
check('mode=edit honored with no p', d.state.mode, 'edit');

// console is always honored — bench links are connect-gated + protocol-agnostic,
// so even a shared p does NOT force it back to Run (that rule is edit-only).
d = U.decode('?mode=console', { allowedKeys: ALLOWED });
check('mode=console honored', d.state.mode, 'console');
d = U.decode('?p=looming_v3&mode=console', { allowedKeys: ALLOWED });
check('mode=console honored with shared p', d.state.mode, 'console');
check('p still resolved alongside console', d.state.p, 'looming_v3');

d = U.decode('?p=g6_2x10_smoke&lib=looming_v3&set=g6_2x10', { allowedKeys: ALLOWED });
check('lib resolved', d.state.lib, 'looming_v3');
check('set key', d.state.set, 'g6_2x10');

// dock was removed with the bottom-dock concept — now an unknown param:
// silently ignored (no warning), never decoded.
d = U.decode('?dock=raw&mode=edit', { allowedKeys: ALLOWED });
check('legacy dock param ignored', d.state.dock, undefined);
checkBool('legacy dock does not warn', d.warnings.length === 0, d.warnings.join('|'));

// ── decode: rejection ────────────────────────────────────────────────────────
console.log('=== decode: rejection ===');
d = U.decode('?p=not_a_known_protocol', { allowedKeys: ALLOWED });
check('unknown p dropped', d.state.p, undefined);
checkBool('unknown p warns', d.warnings.length === 1, d.warnings.join('|'));

d = U.decode('?mode=bogus', { allowedKeys: ALLOWED });
check('bogus mode → run', d.state.mode, 'run');

// ── path-traversal / key safety ──────────────────────────────────────────────
console.log('=== safety ===');
checkBool('isSafeKey ok', U.isSafeKey('looming_v3'), 'looming_v3');
checkBool('isSafeKey rejects slash', !U.isSafeKey('a/b'), 'a/b');
checkBool('isSafeKey rejects dots', !U.isSafeKey('../evil'), '../evil');
checkBool('isSafePath ok', U.isSafePath('./protocols/looming_v3.yaml'), 'good');
checkBool('isSafePath rejects ..', !U.isSafePath('./protocols/../secrets.yaml'), '..');
checkBool('isSafePath rejects abs', !U.isSafePath('/etc/passwd'), '/etc');
checkBool('isSafePath rejects //host', !U.isSafePath('//evil.com/x.yaml'), '//');
checkBool('isSafePath rejects http', !U.isSafePath('http://evil.com/x.yaml'), 'http');
checkBool('isSafePath rejects backslash', !U.isSafePath('.\\protocols\\x.yaml'), 'backslash');
// key regex also blocks a traversal-shaped p param at decode.
d = U.decode('?p=' + encodeURIComponent('../../etc/passwd'), { allowedKeys: ALLOWED });
check('traversal p rejected', d.state.p, undefined);

// ── encode ───────────────────────────────────────────────────────────────────
console.log('=== encode ===');
check(
    'committed doc encodes p',
    U.encode({ mode: 'run', p: 'looming_v3', source: 'committed' }),
    '?p=looming_v3'
);
check('run mode omitted (default)', U.encode({ mode: 'run' }), '');
check('edit mode kept', U.encode({ mode: 'edit', p: 'x', source: 'committed' }), '?mode=edit&p=x');
check('console mode kept', U.encode({ mode: 'console' }), '?mode=console');
// Local (file-picked) doc is NOT shareable → p/set omitted.
check('local doc omits p', U.encode({ mode: 'run', p: 'x', set: 'y', source: 'local' }), '');

// ── encodeApp (write side: live app state → search) ──────────────────────────
console.log('=== encodeApp ===');
check(
    'registry doc, run',
    U.encodeApp({ mode: 'run', protocolKey: 'looming_v3' }),
    '?p=looming_v3'
);
check(
    'registry doc, edit',
    U.encodeApp({ mode: 'edit', protocolKey: 'looming_v3' }),
    '?mode=edit&p=looming_v3'
);
check(
    'registry doc, console',
    U.encodeApp({ mode: 'console', protocolKey: 'looming_v3' }),
    '?mode=console&p=looming_v3'
);
check('no doc, run (clean default)', U.encodeApp({ mode: 'run', protocolKey: null }), '');
check('local doc, edit', U.encodeApp({ mode: 'edit', protocolKey: null }), '?mode=edit');
// encodeApp must ignore source/baseSource/dirty entirely — key-presence is the
// only signal (saveLocal flips baseSource to 'committed' for plain local saves).
check(
    'ignores source/baseSource/dirty fields',
    U.encodeApp({
        mode: 'run',
        protocolKey: null,
        source: 'committed',
        baseSource: 'committed',
        dirty: false
    }),
    ''
);
check('empty state', U.encodeApp({}), '');
check('no arg', U.encodeApp(), '');

// ── rig param (#135: session/bench rig) ──────────────────────────────────────
console.log('=== rig param ===');
const RIGS = ['cshl_g6_2x10', 'cshl_g6_2x8', 'cshl_g6_2x10_ball'];
d = U.decode('?rig=cshl_g6_2x10', { allowedKeys: ALLOWED, allowedRigs: RIGS });
check('rig resolved', d.state.rig, 'cshl_g6_2x10');
check('rig alone has no mode implication', d.state.mode, 'run');
d = U.decode('?rig=cshl_g6_2x10&mode=console', { allowedRigs: RIGS });
check('rig + console coexist', d.state.mode, 'console');
check('rig kept alongside console', d.state.rig, 'cshl_g6_2x10');
d = U.decode('?p=looming_v3&rig=cshl_g6_2x8', { allowedKeys: ALLOWED, allowedRigs: RIGS });
check('rig + shared p coexist', d.state.rig, 'cshl_g6_2x8');
check('shared p still forces Run with rig present', d.state.mode, 'run');
d = U.decode('?rig=not_a_rig', { allowedRigs: RIGS });
check('unknown rig dropped', d.state.rig, undefined);
checkBool(
    'unknown rig warns',
    d.warnings.some((w) => /not a known rig/.test(w)),
    d.warnings.join('|')
);
d = U.decode('?rig=' + encodeURIComponent('../evil'), { allowedRigs: RIGS });
check('traversal rig rejected', d.state.rig, undefined);
d = U.decode('?rig=anything_safe'); // no allowedRigs → shape-only validation (same as p)
check('rig accepted shape-only without allowlist', d.state.rig, 'anything_safe');
// encode: rig is bench identity — kept even for a local doc (unlike p/set).
check(
    'local doc keeps rig, omits p',
    U.encode({ mode: 'run', p: 'x', rig: 'cshl_g6_2x10', source: 'local' }),
    '?rig=cshl_g6_2x10'
);
// encodeApp: rigKey = explicit selection only (caller passes null for derived).
check(
    'explicit rig encoded',
    U.encodeApp({ mode: 'run', protocolKey: 'looming_v3', rigKey: 'cshl_g6_2x10' }),
    '?p=looming_v3&rig=cshl_g6_2x10'
);
check(
    'derived rig (null rigKey) omitted',
    U.encodeApp({ mode: 'run', protocolKey: 'looming_v3', rigKey: null }),
    '?p=looming_v3'
);
check(
    'rig-only bookmark',
    U.encodeApp({ mode: 'run', protocolKey: null, rigKey: 'cshl_g6_2x8' }),
    '?rig=cshl_g6_2x8'
);
// round-trip: rig survives encodeApp → decode.
const rtRig = U.decode(
    U.encodeApp({ mode: 'console', protocolKey: null, rigKey: 'cshl_g6_2x10' }),
    {
        allowedRigs: RIGS
    }
);
check('round-trip rig', rtRig.state.rig, 'cshl_g6_2x10');
check('round-trip rig mode', rtRig.state.mode, 'console');

// ── repo param (course pipeline: ?repo=owner/name re-scopes p to a path) ─────
console.log('=== repo param ===');
const REPO = 'reiserlab/cshl-2026-course-data';
checkBool('isSafeRepo ok', U.isSafeRepo(REPO), REPO);
checkBool('isSafeRepo rejects bare owner', !U.isSafeRepo('reiserlab'), 'no name');
checkBool('isSafeRepo rejects extra segment', !U.isSafeRepo('a/b/c'), 'a/b/c');
checkBool('isSafeRepo rejects dotdot', !U.isSafeRepo('a/b..c'), 'dotdot');
checkBool('isSafeRepo rejects leading hyphen owner', !U.isSafeRepo('-evil/repo'), '-evil');
checkBool('isSafeRepoPath ok', U.isSafeRepoPath('protocols/bench03/looming.yaml'), 'bench path');
checkBool('isSafeRepoPath shared ok', U.isSafeRepoPath('protocols/shared/loom.yml'), 'shared');
checkBool('isSafeRepoPath flat ok', U.isSafeRepoPath('protocols/looming.yaml'), 'flat');
checkBool('isSafeRepoPath rejects ./-prefix', !U.isSafeRepoPath('./protocols/x.yaml'), './');
checkBool(
    'isSafeRepoPath rejects non-protocols',
    !U.isSafeRepoPath('runlogs/bench03/x.yaml'),
    'runlogs'
);
checkBool('isSafeRepoPath rejects .pat', !U.isSafeRepoPath('protocols/bench03/x.pat'), '.pat');
checkBool('isSafeRepoPath rejects traversal', !U.isSafeRepoPath('protocols/../js/x.yaml'), '..');

// decode: repo present ⇒ p is a PATH (no registry allowlist applies).
d = U.decode('?repo=' + REPO + '&p=protocols/bench03/looming.yaml', { allowedKeys: ALLOWED });
check('repo resolved', d.state.repo, REPO);
check('p is a repo path', d.state.p, 'protocols/bench03/looming.yaml');
checkBool('no warnings for repo-path p', d.warnings.length === 0, d.warnings.join('|'));
// still forces Run for a shared link (newbie-safety applies to course links too).
d = U.decode('?repo=' + REPO + '&p=protocols/bench03/looming.yaml&mode=edit', {});
check('repo-shared link forces Run', d.state.mode, 'run');
// bad path with repo present is dropped.
d = U.decode('?repo=' + REPO + '&p=' + encodeURIComponent('../../etc/passwd'), {});
check('repo-mode traversal p dropped', d.state.p, undefined);
checkBool(
    'repo-mode bad p warns as path',
    d.warnings.some((w) => /invalid repo path/.test(w)),
    d.warnings.join('|')
);
// a registry KEY under repo-mode is not a valid path ⇒ dropped.
d = U.decode('?repo=' + REPO + '&p=looming_v3', { allowedKeys: ALLOWED });
check('registry key invalid in repo mode', d.state.p, undefined);
// bad repo is dropped AND p falls back to registry-key semantics.
d = U.decode('?repo=not-a-repo-ref!&p=looming_v3', { allowedKeys: ALLOWED });
check('bad repo dropped', d.state.repo, undefined);
check('p falls back to key semantics', d.state.p, 'looming_v3');
checkBool(
    'bad repo warns',
    d.warnings.some((w) => /invalid owner\/name/.test(w)),
    d.warnings.join('|')
);
// no repo ⇒ a path-shaped p is rejected as before (unchanged registry rule).
d = U.decode('?p=' + encodeURIComponent('protocols/bench03/looming.yaml'), {
    allowedKeys: ALLOWED
});
check('path-shaped p without repo rejected', d.state.p, undefined);

// encode: repo emitted only alongside a valid repo path.
check(
    'repo+path encode',
    U.encode({ mode: 'run', repo: REPO, p: 'protocols/bench03/looming.yaml', source: 'committed' }),
    '?repo=' + REPO + '&p=protocols/bench03/looming.yaml'
);
check(
    'repo without valid path omitted',
    U.encode({ mode: 'run', repo: REPO, p: 'looming_v3', source: 'committed' }),
    '?p=looming_v3'
);
check('repo alone omitted', U.encode({ mode: 'run', repo: REPO }), '');

// encodeApp: repo+repoPath provenance wins over protocolKey.
check(
    'encodeApp repo provenance',
    U.encodeApp({ mode: 'run', repo: REPO, repoPath: 'protocols/bench03/looming.yaml' }),
    '?repo=' + REPO + '&p=protocols/bench03/looming.yaml'
);
check(
    'encodeApp repo + rig + mode',
    U.encodeApp({
        mode: 'console',
        repo: REPO,
        repoPath: 'protocols/shared/loom.yaml',
        rigKey: 'cshl_g6_2x10'
    }),
    '?mode=console&repo=' + REPO + '&p=protocols/shared/loom.yaml&rig=cshl_g6_2x10'
);
check(
    'encodeApp without repoPath ignores repo',
    U.encodeApp({ mode: 'run', repo: REPO, protocolKey: 'looming_v3' }),
    '?p=looming_v3'
);
// round-trip: repo link survives encodeApp → decode.
const rtRepo = U.decode(
    U.encodeApp({ mode: 'run', repo: REPO, repoPath: 'protocols/bench03/looming.yaml' }),
    {}
);
check('round-trip repo', rtRepo.state.repo, REPO);
check('round-trip repo path', rtRepo.state.p, 'protocols/bench03/looming.yaml');

// ── advanced param (safe mode: soft-gate request flag) ──────────────────────
console.log('=== advanced param ===');
d = U.decode('?advanced=1', { allowedKeys: ALLOWED });
check('advanced=1 requested', d.state.advanced, true);
checkBool('advanced=1 does not warn', d.warnings.length === 0, d.warnings.join('|'));
d = U.decode('?advanced=0', { allowedKeys: ALLOWED });
check('advanced=0 → force safe (explicit false)', d.state.advanced, false);
checkBool('advanced=0 does not warn', d.warnings.length === 0, d.warnings.join('|'));
// encode/encodeApp never EMIT advanced=0 (clean-URL rule) — false is treated as off.
check('encode advanced=false still omitted', U.encode({ mode: 'run', advanced: false }), '');
d = U.decode('?advanced=yes', { allowedKeys: ALLOWED });
check('advanced=yes dropped', d.state.advanced, undefined);
checkBool(
    'advanced=yes warns',
    d.warnings.some((w) => /expected 0 or 1/.test(w)),
    d.warnings.join('|')
);
d = U.decode('', {});
check('no advanced param → safe (undefined)', d.state.advanced, undefined);
// advanced coexists with a shared protocol (still forces Run) and a rig.
d = U.decode('?p=looming_v3&advanced=1', { allowedKeys: ALLOWED });
check('advanced + shared p still forces Run', d.state.mode, 'run');
check('advanced kept alongside p', d.state.advanced, true);
// encode: emitted only when true.
check('encode advanced', U.encode({ mode: 'run', advanced: true }), '?advanced=1');
check('encode advanced=false omitted', U.encode({ mode: 'run', advanced: false }), '');
check('encode no advanced omitted', U.encode({ mode: 'run' }), '');
// encodeApp: the write side passes advanced only when active AND URL-requested.
check(
    'encodeApp advanced with doc',
    U.encodeApp({ mode: 'run', protocolKey: 'looming_v3', advanced: true }),
    '?p=looming_v3&advanced=1'
);
check(
    'encodeApp advanced omitted when false (remembered-unlocked, clean URL)',
    U.encodeApp({ mode: 'run', protocolKey: 'looming_v3', advanced: false }),
    '?p=looming_v3'
);
check(
    'encodeApp advanced with repo provenance',
    U.encodeApp({
        mode: 'run',
        repo: REPO,
        repoPath: 'protocols/bench03/looming.yaml',
        advanced: true
    }),
    '?repo=' + REPO + '&p=protocols/bench03/looming.yaml&advanced=1'
);
// round-trip: advanced survives encodeApp → decode.
const rtAdv = U.decode(U.encodeApp({ mode: 'run', protocolKey: null, advanced: true }), {});
check('round-trip advanced', rtAdv.state.advanced, true);

// ── navMode (popstate: literal mode, NO shared-p force) ──────────────────────
console.log('=== navMode ===');
check('empty search → run', U.navMode(''), 'run');
check(
    'edit honored even with p (in-session traversal)',
    U.navMode('?mode=edit&p=looming_v3'),
    'edit'
);
check('console honored', U.navMode('?mode=console'), 'console');
check('bogus mode → run', U.navMode('?mode=bogus'), 'run');
check('undefined search → run', U.navMode(undefined), 'run');

// round-trip
console.log('=== round-trip ===');
const rt = U.encode({ mode: 'edit', lib: 'looming_v3', source: 'committed' });
const back = U.decode(rt, { allowedKeys: ALLOWED });
check('round-trip mode', back.state.mode, 'edit'); // no p present → edit honored
check('round-trip lib', back.state.lib, 'looming_v3');
// encodeApp→decode: the shared-p force still applies to a FRESH load of an
// edit+p URL (newbie-safety) — the write side bypasses it only via
// history.state (own refresh) and navMode (popstate).
const rt2 = U.decode(U.encodeApp({ mode: 'edit', protocolKey: 'looming_v3' }), {
    allowedKeys: ALLOWED
});
check('fresh load of edit+p URL forces Run', rt2.state.mode, 'run');
check('fresh load of edit+p URL keeps p', rt2.state.p, 'looming_v3');

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures ? 1 : 0);
