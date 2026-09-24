#!/usr/bin/env node
/**
 * Tests for js/controller-settings.js (the pure "assert before run" planner) and the rig
 * YAML `defaults:` / `limits:` / `requires:` / `strict:` parsing in js/plugin-registry.js.
 *
 * Run: node tests/test-controller-settings.js   (wired into `pixi run test`)
 */
'use strict';

const CS = require('../js/controller-settings.js');
const Registry = require('../js/plugin-registry.js');

let checks = 0;
let failures = 0;
function check(name, got, expected) {
    checks++;
    const g = JSON.stringify(got);
    const e = JSON.stringify(expected);
    const ok = g === e;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${g}, expected ${e}`);
    if (!ok) failures++;
}
function checkTrue(name, cond, info) {
    checks++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
    if (!cond) failures++;
}

console.log('normalizePanelMode');
check('int 2', CS.normalizePanelMode(2), 2);
check('"triggered"', CS.normalizePanelMode('triggered'), 2);
check('"Persist"', CS.normalizePanelMode('Persist'), 1);
check('"persistent"', CS.normalizePanelMode('persistent'), 1);
check('"3"', CS.normalizePanelMode('3'), 3);
check('7 → null', CS.normalizePanelMode(7), null);
check('"fast" → null', CS.normalizePanelMode('fast'), null);
check('null → null', CS.normalizePanelMode(null), null);

console.log('firmwareMatches');
checkTrue('2p matches 2p-9014b5bb-d', CS.firmwareMatches('2p-9014b5bb-d', '2p'));
checkTrue('tag matches itself', CS.firmwareMatches('panel-fw-v1.2.0', 'panel-fw-v1.2.0'));
checkTrue('2p does not match panel-fw-v1.2.0', !CS.firmwareMatches('panel-fw-v1.2.0', '2p'));
checkTrue('empty requirement always matches', CS.firmwareMatches('anything', ''));
checkTrue('no footer never matches a requirement', !CS.firmwareMatches(null, '2p'));

console.log('normalizeControllerBlock');
const nb = CS.normalizeControllerBlock({ panel_mode: 'triggered', refresh_policy: 'line_sync_safe', panel_firmware: '2p' });
check('normalized', [nb.declared, nb.panel_mode, nb.refresh_hz, nb.refresh_policy, nb.panel_firmware, nb.errors.length], [true, 2, null, 'line_sync_safe', '2p', 0]);
check('absent → undeclared', CS.normalizeControllerBlock(undefined).declared, false);
check('bad mode → error', CS.normalizeControllerBlock({ panel_mode: 9 }).errors.length, 1);
check('hz + policy → error', CS.normalizeControllerBlock({ refresh_hz: 300, refresh_policy: 'line_sync_safe' }).errors.length, 1);
check('unknown key → warning', CS.normalizeControllerBlock({ foo: 1 }).warnings.length, 1);
check('list → error', CS.normalizeControllerBlock([1]).errors.length, 1);

console.log('rig YAML settings (parseRigIo)');
const rig2p = Registry.parseRigIo({
    name: 'Bergamo', io: { dio: [{ port: 1, role: 'out_debug_framescan' }, { port: 2, role: 'in_trigger' }], ao: { role: 'programmable', default: 0 } },
    defaults: { panel_mode: 'triggered' }, limits: { max_refresh_hz: 300 }, requires: { panel_firmware: '2p' }, strict: true
});
check('rig defaults/limits/requires/strict', [rig2p.name, rig2p.defaults.panel_mode, rig2p.limits.max_refresh_hz, rig2p.requires.panel_firmware, rig2p.strict, rig2p.dio[1].role], ['Bergamo', 2, 300, '2p', true, 'in_trigger']);
const rigCourse = Registry.parseRigIo({ io: { dio: [{ port: 1, role: 'out_debug_framescan' }] }, defaults: { panel_mode: 'persistent' } });
check('course rig default persistent, not strict', [rigCourse.defaults.panel_mode, rigCourse.strict, rigCourse.limits.max_refresh_hz], [1, false, null]);
const rigBad = Registry.parseRigIo({ defaults: { panel_mode: 'fast' }, limits: { max_refresh_hz: 99999 }, requires: { panel_firmware: 5 } });
check('bad rig values → 3 warnings, all null', [rigBad.warnings.length, rigBad.defaults.panel_mode, rigBad.limits.max_refresh_hz, rigBad.requires.panel_firmware], [3, null, null, null]);
check('parseRigIo(null) has the new fields', [Registry.parseRigIo(null).defaults.panel_mode, Registry.parseRigIo(null).strict], [null, false]);

console.log('planAssertions — 2P protocol on the 2P rig');
const block2p = CS.normalizeControllerBlock({ panel_mode: 2, refresh_policy: 'line_sync_safe', panel_firmware: '2p' });
const snapOk = { panel_mode: 1, refresh_hz: 300, capabilities: ['g6_mode', 'v3_triggered', 'v3_gated', 'io_ext'], panel_firmware: { version: '2p-9014b5bb-d' }, verified: { ok: true, verified: 20, total: 20, at: 't' } };
let plan = CS.planAssertions({ block: block2p, rig: rig2p, snapshot: snapOk, patterns: [{ name: 'a', gsVal: 2 }], protocolRig: 'bergamo_g6_2x10_2p', sessionRig: 'bergamo_g6_2x10_2p' });
check('ok, strict, one action: mode 1→2', [plan.ok, plan.strict, plan.actions], [true, true, [{ setting: 'panel_mode', from: 1, to: 2 }]]);
check('intended recorded', [plan.intended.panel_mode, plan.intended.refresh_hz_max, plan.intended.panel_firmware, plan.intended.pattern_gs], [2, 300, '2p', ['GS16']]);
check('no warnings', plan.warnings, []);

console.log('planAssertions — refresh derivation');
plan = CS.planAssertions({ block: block2p, rig: rig2p, snapshot: Object.assign({}, snapOk, { panel_mode: 2, refresh_hz: 1000 }), patterns: [{ name: 'a', gsVal: 2 }] });
check('refresh above cap → set to cap', plan.actions, [{ setting: 'refresh_hz', from: 1000, to: 300 }]);
plan = CS.planAssertions({ block: block2p, rig: rig2p, snapshot: Object.assign({}, snapOk, { panel_mode: 2, refresh_hz: 250 }), patterns: [{ name: 'gs2', gsVal: 1 }] });
check('GS2 pattern (default 1000) on capped rig → pin to cap', plan.actions, [{ setting: 'refresh_hz', from: 250, to: 300 }]);
plan = CS.planAssertions({ block: block2p, rig: rig2p, snapshot: Object.assign({}, snapOk, { panel_mode: 2, refresh_hz: 300 }), patterns: [{ name: 'a', gsVal: null }] });
check('unknown grayscale → warning, no action', [plan.actions.length, plan.warnings.length], [0, 1]);
const blockHz = CS.normalizeControllerBlock({ panel_mode: 2, refresh_hz: 500 });
plan = CS.planAssertions({ block: blockHz, rig: rig2p, snapshot: snapOk, patterns: [] });
check('explicit refresh_hz above rig cap → blocking', plan.ok, false);
plan = CS.planAssertions({ block: CS.normalizeControllerBlock({ refresh_hz: 200 }), rig: rigCourse, snapshot: Object.assign({}, snapOk, { refresh_hz: 300 }), patterns: [] });
check('explicit refresh_hz on an uncapped rig → set', plan.actions, [{ setting: 'refresh_hz', from: 300, to: 200 }]);

console.log('planAssertions — course protocol inherits the rig default');
plan = CS.planAssertions({ block: undefined, rig: rigCourse, snapshot: Object.assign({}, snapOk, { panel_mode: 2 }), patterns: [] });
check('bench left in triggered → set back to persistent, not strict', [plan.ok, plan.strict, plan.actions], [true, false, [{ setting: 'panel_mode', from: 2, to: 1 }]]);
plan = CS.planAssertions({ block: undefined, rig: Registry.parseRigIo({}), snapshot: snapOk, patterns: [] });
check('nothing declared anywhere → record only', [plan.ok, plan.actions.length, Object.keys(plan.intended).filter((k) => plan.intended[k] != null).length], [true, 0, 0]);

console.log('planAssertions — what refuses');
plan = CS.planAssertions({ block: block2p, rig: rigCourse, snapshot: snapOk, patterns: [], protocolRig: 'bergamo_g6_2x10_2p', sessionRig: 'cshl_g6_2x10' });
checkTrue('2P protocol on a course rig → rig mismatch blocks (protocol block makes it strict)', !plan.ok && plan.blocking.some((b) => /rig/.test(b)), plan.blocking.join(' | '));
plan = CS.planAssertions({ block: block2p, rig: rig2p, snapshot: Object.assign({}, snapOk, { panel_firmware: { version: 'panel-fw-v1.2.0' } }), patterns: [] });
checkTrue('wrong panel firmware → blocks', !plan.ok && plan.blocking.some((b) => /firmware/.test(b)), plan.blocking.join(' | '));
plan = CS.planAssertions({ block: block2p, rig: rig2p, snapshot: Object.assign({}, snapOk, { verified: { ok: false, verified: 18, total: 20, mismatched: [7, 12] } }), patterns: [] });
checkTrue('failed fleet verify → blocks and names the panels', !plan.ok && plan.blocking.some((b) => /panels 7, 12/.test(b)), plan.blocking.join(' | '));
plan = CS.planAssertions({ block: block2p, rig: rig2p, snapshot: Object.assign({}, snapOk, { verified: null }), patterns: [] });
checkTrue('unverified fleet → warning, not blocking', plan.ok && plan.warnings.some((w) => /not verified/.test(w)), plan.warnings.join(' | '));
plan = CS.planAssertions({ block: block2p, rig: rig2p, snapshot: Object.assign({}, snapOk, { capabilities: ['g6_mode'] }), patterns: [] });
checkTrue('mode 2 without v3_triggered capability → blocks', !plan.ok && plan.blocking.some((b) => /v3_triggered/.test(b)), plan.blocking.join(' | '));
plan = CS.planAssertions({ block: block2p, rig: rig2p, snapshot: Object.assign({}, snapOk, { panel_mode: null }), patterns: [] });
checkTrue('unreadable mode on a strict rig → blocks', !plan.ok && plan.blocking.some((b) => /cannot read the panel display mode/.test(b)), plan.blocking.join(' | '));
plan = CS.planAssertions({ block: undefined, rig: rigCourse, snapshot: Object.assign({}, snapOk, { panel_mode: null }), patterns: [] });
checkTrue('unreadable mode on a course rig → warning only', plan.ok && plan.warnings.length === 1, plan.warnings.join(' | '));
plan = CS.planAssertions({ block: CS.normalizeControllerBlock({ panel_mode: 'nope' }), rig: rigCourse, snapshot: snapOk, patterns: [] });
check('block errors are blocking', plan.ok, false);

console.log('formatSnapshot');
const line = CS.formatSnapshot(Object.assign({}, snapOk, { spi_mhz: 20, ao_mv: 0, dio_roles: [{ port: 1, role: 'out_debug_framescan' }, { port: 2, role: 'in_trigger' }], controller_firmware: 'v3' }));
checkTrue('one line names mode, refresh, DIO roles, firmware', /persistent.*300 Hz.*SPI 20.*1=out_debug_framescan 2=in_trigger.*2p-9014b5bb-d.*verified 20\/20/.test(line), line);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
