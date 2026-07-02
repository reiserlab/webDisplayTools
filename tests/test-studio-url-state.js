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

d = U.decode('?p=g6_2x10_smoke&lib=looming_v3&dock=raw&set=g6_2x10', { allowedKeys: ALLOWED });
check('lib resolved', d.state.lib, 'looming_v3');
check('dock enum', d.state.dock, 'raw');
check('set key', d.state.set, 'g6_2x10');

// ── decode: rejection ────────────────────────────────────────────────────────
console.log('=== decode: rejection ===');
d = U.decode('?p=not_a_known_protocol', { allowedKeys: ALLOWED });
check('unknown p dropped', d.state.p, undefined);
checkBool('unknown p warns', d.warnings.length === 1, d.warnings.join('|'));

d = U.decode('?mode=bogus', { allowedKeys: ALLOWED });
check('bogus mode → run', d.state.mode, 'run');

d = U.decode('?dock=danger', { allowedKeys: ALLOWED });
check('bad dock dropped', d.state.dock, undefined);

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
check('closed dock omitted', U.encode({ dock: 'closed' }), '');
check('non-closed dock kept', U.encode({ dock: 'stepper' }), '?dock=stepper');

// round-trip
console.log('=== round-trip ===');
const rt = U.encode({ mode: 'edit', lib: 'looming_v3', dock: 'raw', source: 'committed' });
const back = U.decode(rt, { allowedKeys: ALLOWED });
check('round-trip mode', back.state.mode, 'edit'); // no p present → edit honored
check('round-trip lib', back.state.lib, 'looming_v3');
check('round-trip dock', back.state.dock, 'raw');

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures ? 1 : 0);
