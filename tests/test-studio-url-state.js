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
