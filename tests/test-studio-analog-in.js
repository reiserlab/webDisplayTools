#!/usr/bin/env node
/**
 * Tests for js/studio-analog-in.js (the Console "Analog In" panel logic) and the
 * panel's wiring in arena_studio.html. No DOM: the poller is driven by calling
 * tick() with injected timers; the monitor/sweep math is pure.
 * Run: node tests/test-studio-analog-in.js   (wired into `pixi run test`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AI = require('../js/studio-analog-in.js');
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
function approx(name, got, expected, tol) {
    total++;
    const ok = typeof got === 'number' && Math.abs(got - expected) <= (tol == null ? 1e-9 : tol);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}, expected ${expected}`);
    if (!ok) failures++;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
    console.log('=== formatting / flags ===');
    check('formatMv +', AI.formatMv(1234.4), '+1234 mV');
    check('formatMv −', AI.formatMv(-7263), '-7263 mV');
    check('formatMv 0', AI.formatMv(0), '0 mV');
    check('formatMv NaN', AI.formatMv(NaN), '—');
    approx('barFraction 0 V = middle', AI.barFraction(0), 0.5);
    approx('barFraction +10 V = right', AI.barFraction(10000), 1);
    approx('barFraction −12 V clamps', AI.barFraction(-12000), 0);
    check(
        'describeFlags pre-F1 (no byte)',
        AI.describeFlags(null).text,
        '10-bit (pre-F1 fw) · uncalibrated'
    );
    check('describeFlags 12-bit uncal', AI.describeFlags(0x04).text, '12-bit · uncalibrated');
    check('describeFlags 12-bit both cal', AI.describeFlags(0x07).text, '12-bit · calibrated');
    check('describeFlags one channel cal', AI.describeFlags(0x05).text, '12-bit · cal: AI1 only');
    check(
        'describeFlags lsb',
        [AI.describeFlags(0x04).lsbMv, AI.describeFlags(0).lsbMv],
        [4.9, 19.6]
    );
    check('median odd / even', [AI.median([3, 1, 2]), AI.median([4, 1, 3, 2])], [2, 2.5]);
    check('median empty → NaN', Number.isNaN(AI.median([])), true);

    console.log('=== decodeAnalogIn (wire) — 4-byte pre-F1 and 5-byte F1 replies ===');
    {
        const old = Wire.decodeAnalogIn(
            Uint8Array.from([0x06, 0x00, 0xa4, 0xa1, 0xe3, 0xd2, 0x04])
        );
        check('pre-F1: values', [old.ain1Mv, old.ain2Mv], [-7263, 1234]);
        check('pre-F1: flags null', old.flags, null);
        check('pre-F1: bits12/cal false', [old.bits12, old.cal1, old.cal2], [false, false, false]);
        const f1 = Wire.decodeAnalogIn(
            Uint8Array.from([0x07, 0x00, 0xa4, 0xa1, 0xe3, 0xd2, 0x04, 0x05])
        );
        check('F1: values unchanged', [f1.ain1Mv, f1.ain2Mv], [-7263, 1234]);
        check('F1: flags byte', f1.flags, 5);
        check('F1: bits12 + cal1 decoded', [f1.bits12, f1.cal1, f1.cal2], [true, true, false]);
    }

    console.log('=== createMonitor ===');
    {
        const m = AI.createMonitor({ windowMs: 1000 });
        m.push(0, 100, -200);
        m.push(100, 300, -100);
        m.push(200, 50, -400);
        check('stats ch1', m.stats(1), { last: 50, min: 50, max: 300, n: 3 });
        check('stats ch2', m.stats(2), { last: -400, min: -400, max: -100, n: 3 });
        approx('rateHz from spacing', m.rateHz(), 10);
        m.push(1500, 0, 0); // everything older than the window is trimmed
        check(
            'window trim keeps only in-window samples',
            m.samples().map((s) => s.ms),
            [1500]
        );
        check('min/max persist across trim', [m.stats(1).min, m.stats(1).max], [0, 300]);
        m.resetMinMax();
        check('resetMinMax → NaN until next push', Number.isNaN(m.stats(1).min), true);
        m.push(1600, 7, 8);
        check(
            'after reset, min/max restart from new samples',
            [m.stats(1).min, m.stats(1).max],
            [7, 7]
        );
        m.clear();
        check('clear empties samples', m.samples().length, 0);
        const m2 = AI.createMonitor({ windowMs: 1e9, maxSamples: 3 });
        for (let i = 0; i < 5; i++) m2.push(i, i, i);
        check(
            'maxSamples cap',
            m2.samples().map((s) => s.ms),
            [2, 3, 4]
        );
        m2.push(undefined, 1, 1);
        check('missing ms → previous + 100', m2.samples().pop().ms, 104);
    }

    console.log('=== createPoller: single-flight, gate, errors, timers ===');
    {
        let gate = { ok: true };
        const pending = [];
        const samples = [];
        const states = [];
        const p = AI.createPoller({
            read: () => new Promise((res, rej) => pending.push({ res, rej })),
            canPoll: () => gate,
            onSample: (s) => samples.push(s),
            onState: (s, r) => states.push([s, r]),
            maxConsecutiveErrors: 2
        });
        check('initial state paused', p.state, 'paused');
        p.tick(); // read #1 in flight
        p.tick(); // skipped (single-flight)
        p.tick(); // skipped
        await tick();
        check('only one read in flight', pending.length, 1);
        check('skipped ticks counted', p.stats.skipped, 2);
        pending[0].res({ ain1Mv: 1, ain2Mv: 2 });
        await tick();
        check('sample delivered', samples, [{ ain1Mv: 1, ain2Mv: 2 }]);
        check('state → polling once', states, [['polling', '']]);
        gate = { ok: false, reason: 'run active' };
        p.tick();
        p.tick();
        await tick();
        check('gate closed → paused with reason, reported once', states.slice(1), [
            ['paused', 'run active']
        ]);
        check('no read issued while paused', pending.length, 1);
        gate = { ok: true };
        p.tick();
        await tick();
        pending[1].rej(new Error('timeout'));
        await tick();
        check('read error → error state with message', states[states.length - 1], [
            'error',
            'timeout'
        ]);
        p.tick();
        await tick();
        pending[2].rej(new Error('timeout'));
        await tick();
        check('errors counted', p.errors, 2);
        p.tick();
        await tick();
        check('at maxConsecutiveErrors the poller parks itself', p.state, 'error');
        checkBool('… with a resume hint', /paused \(resume to retry\)/.test(p.reason), p.reason);
        check('no further read attempted', pending.length, 3);
        p.resume();
        p.tick();
        await tick();
        check('resume() allows a new read', pending.length, 4);
        pending[3].res({ ain1Mv: 5, ain2Mv: 6 });
        await tick();
        check('recovered → polling', p.state, 'polling');
        gate = { ok: false, reason: 'panel closed' };
        p.tick();
        await tick();
        gate = { ok: true };
        p.tick();
        await tick();
        check('gate reopen resets error count', p.errors, 0);
        pending[4].res({ ain1Mv: 0, ain2Mv: 0 });
        await tick();

        // injected timers: start / restart at a new rate / stop
        const timers = [];
        let cleared = 0;
        const fakeSet = (fn, ms) => {
            timers.push({ fn, ms });
            return timers.length;
        };
        const fakeClear = () => {
            cleared++;
        };
        p.start(100, fakeSet, fakeClear);
        check(
            'start registers an interval at the requested period',
            [p.running, p.intervalMs, timers[0].ms],
            [true, 100, 100]
        );
        p.start(500, fakeSet, fakeClear);
        check(
            'restart clears the old interval and uses the new period',
            [cleared, p.intervalMs, timers.length],
            [1, 500, 2]
        );
        p.start(5, fakeSet, fakeClear);
        check('period floor for silly values', p.intervalMs, 100);
        p.stop();
        check('stop clears', [p.running, cleared], [false, 3]);
        timers[2].fn(); // a fired interval callback just ticks
        await tick();
        check('interval callback ticks the poller', pending.length, 6);
    }

    console.log('=== sweep: plan, fit, summary, csv ===');
    check('sweepPlan default 0..5000 by 500', AI.sweepPlan(0, 5000, 500).length, 11);
    check(
        'sweepPlan ends exactly at `to`',
        AI.sweepPlan(0, 5000, 1500),
        [0, 1500, 3000, 4500, 5000]
    );
    check('sweepPlan clamps to the AO range', AI.sweepPlan(-100, 9000, 5000), [0, 5000]);
    check('sweepPlan descending', AI.sweepPlan(1000, 0, 500), [1000, 500, 0]);
    check('sweepPlan bad step → 500', AI.sweepPlan(0, 1000, 0), [0, 500, 1000]);
    {
        const xs = [0, 1000, 2000, 3000, 4000, 5000];
        const ys = xs.map((x) => 1.02 * x + 15);
        const f = AI.fitLinear(xs, ys);
        approx('fitLinear slope', f.slope, 1.02, 1e-9);
        approx('fitLinear offset', f.offset, 15, 1e-6);
        approx('fitLinear rmse exact fit', f.rmse, 0, 1e-6);
        check('fitLinear n', f.n, 6);
        check('fitLinear < 2 points → null', AI.fitLinear([1], [2]), null);
        check('fitLinear ignores NaN rows', AI.fitLinear([0, NaN, 1000], [0, 5, 1000]).n, 2);
        const rows = xs.map((x) => ({ aoMv: x, ai1Mv: 1.02 * x + 15, ai2Mv: 40 }));
        const good = AI.summarizeSweep(rows, 1);
        check('summarizeSweep ok verdict', good.verdict, 'ok');
        checkBool(
            'summarizeSweep text',
            /slope 1\.0200 · offset 15 mV · max \|err\| 0 mV · 6 steps · ok/.test(good.text),
            good.text
        );
        check('summarizeSweep rows carry per-step error', good.rows.length, 6);
        const bad = AI.summarizeSweep(
            xs.map((x) => ({ aoMv: x, ai1Mv: 9990, ai2Mv: 0 })),
            1
        ); // saturated (un-reworked board)
        check('saturated input → fail', bad.verdict, 'fail');
        const meh = AI.summarizeSweep(
            xs.map((x) => ({ aoMv: x, ai1Mv: 0.9 * x, ai2Mv: 0 })),
            1
        );
        check('10 % slope error → check', meh.verdict, 'check');
        const ch2 = AI.summarizeSweep(
            xs.map((x) => ({ aoMv: x, ai1Mv: 0, ai2Mv: x })),
            2
        );
        check('channel 2 fit', [ch2.ch, ch2.verdict], [2, 'ok']);
        // Linear but offset by +1 V: slope is perfect, so this used to pass as ok.
        const off = AI.summarizeSweep(
            [0, 1000, 2000, 3000, 4000, 5000].map((v) => ({ aoMv: v, ai1Mv: v + 1000, ai2Mv: 0 })),
            1
        );
        check('1 V offset with perfect slope → check, not ok', off.verdict, 'check');
        check('offset reported in the text', /offset 1000 mV/.test(off.text), true);
        check(
            'sweepCsv',
            AI.sweepCsv(rows.slice(0, 2)),
            'ao_mv,ai1_mv,ai2_mv\n0,15,40\n1000,1035,40\n'
        );
    }
    console.log('=== calibration record helpers ===');
    {
        const ch1 = { ch: 1, valid: true, rawOpen: 3700, rawGnd: 100, deadbandMv: 20 };
        const ch2 = { ch: 2, valid: false, rawOpen: 3650, rawGnd: 0, deadbandMv: 50 };
        const rec = {
            version: 1,
            adcBits: 12,
            source: 'eeprom',
            sdMirrorOk: true,
            channels: [ch1, ch2]
        };
        approx('nominalMv midscale 12-bit = 0', AI.nominalMv(2047.5, 12), 0);
        approx('nominalMv 0 counts = −10 V', AI.nominalMv(0, 12), -10000);
        approx('nominalMv 10-bit full scale = +10 V', AI.nominalMv(1023, 10), 10000);
        const line = AI.calLine(ch1);
        approx('calLine a = 10000/3600', line.a, 10000 / 3600, 1e-9);
        approx('calLine b = −a·gnd', line.b, -(10000 / 3600) * 100, 1e-9);
        check('calLine invalid channel → null', AI.calLine(ch2), null);
        approx('calMv at the ground point = 0', AI.calMv(ch1, 100), 0, 1e-9);
        approx('calMv at the open point = +10 000', AI.calMv(ch1, 3700), 10000, 1e-9);
        approx('calMv falls back to nominal when invalid', AI.calMv(ch2, 2047.5, 12), 0, 1e-9);
        check('calStepsText valid', AI.calStepsText(ch1), 'calibrated (both points)');
        check('calStepsText one point', AI.calStepsText(ch2), '+10 V point ✓ · 0 V point —');
        check(
            'calStepsText none',
            AI.calStepsText({ valid: false, rawOpen: 0, rawGnd: 0 }),
            'no points'
        );
        check(
            'describeCalSource eeprom + mirror',
            AI.describeCalSource(rec),
            'stored in EEPROM · SD mirror ok · 12-bit'
        );
        check(
            'describeCalSource none',
            AI.describeCalSource({ source: 'none', adcBits: 12 }),
            'no record (nominal scale) · 12-bit'
        );
        const rows = AI.calTableRows(rec, { raw1: 1900, raw2: 2047 });
        check('calTableRows count', rows.length, 2);
        approx('calTableRows ch1 mV cal', rows[0].mvCal, (10000 / 3600) * (1900 - 100), 1e-6);
        approx('calTableRows ch1 mV nominal', rows[0].mvNominal, (1900 / 4095 - 0.5) * 20000, 1e-6);
        check('calTableRows ch2 no line', String([rows[1].a, rows[1].mvCal]), String([null, null]));
        check('calTableRows without raws', AI.calTableRows(rec, null)[0].rawNow, null);
    }

    check('drawStripChart without a canvas → false', AI.drawStripChart(null, []), false);
    check('drawStripChart with a non-canvas → false', AI.drawStripChart({}, []), false);

    console.log('=== arena_studio.html wiring ===');
    checkBool(
        'loads js/studio-analog-in.js as a classic script after the wire module',
        studioHtml.indexOf('<script src="js/studio-analog-in.js"') >
            studioHtml.indexOf('<script src="js/arena-wire-g6.js"') &&
            studioHtml.indexOf('<script src="js/studio-analog-in.js"') > 0,
        'script tag'
    );
    checkBool(
        'rail button data-panel="ai"',
        /<div class="rail-btn" data-panel="ai"[^>]*>Analog In<span class="sub" id="cAiSum">/.test(
            studioHtml
        ),
        'rail'
    );
    checkBool(
        'panel section data-panel="ai"',
        /<section class="panel" data-panel="ai">/.test(studioHtml),
        'section'
    );
    for (const id of [
        'cAiStatus',
        'cAiPoll',
        'cAiRate',
        'cAiFlags',
        'cAi1Val',
        'cAi2Val',
        'cAi1Bar',
        'cAi2Bar',
        'cAi1Range',
        'cAi2Range',
        'cAiChart',
        'cAiLoopCh',
        'cAiLoopStep',
        'cAiSweepSum',
        'cAiSweepTable',
        'cAiSweepCsv'
    ])
        checkBool(`panel element #${id}`, new RegExp(`id="${id}"`).test(studioHtml), id);
    for (const cmd of ['caipoll', 'caireset', 'caisweep', 'caisweepcsv']) {
        checkBool(
            `button data-cmd="${cmd}"`,
            new RegExp(`data-cmd="${cmd}"`).test(studioHtml),
            cmd
        );
        checkBool(`handler ${cmd}:`, new RegExp(`^\\s+${cmd}: `, 'm').test(studioHtml), cmd);
    }
    checkBool(
        'poller reads via session.send (quiet), not the logging send()',
        /const resp = await session\.send\(Wire\.encodeGetAnalogIn\(\)\)/.test(studioHtml),
        'quiet read'
    );
    checkBool(
        'poller gate pauses during a run',
        /if \(session\.running\) return \{ ok: false, reason: 'paused — run active' \}/.test(
            studioHtml
        ),
        'run gate'
    );
    checkBool(
        'poller gate requires io_ext',
        /reason: 'needs io_ext firmware'/.test(studioHtml),
        'io_ext gate'
    );
    checkBool(
        'HELP map: rail entry',
        /'\.rail-btn\[data-panel="ai"\]': '/.test(studioHtml),
        'help rail'
    );
    checkBool('HELP map: panel entry', /^\s+ai: '/m.test(studioHtml), 'help panel');
    checkBool(
        'trial gain tooltip states the G3-faithful scale',
        /gain \(mode 4\), ×10 — 10 = unity = 100 frames\/s per volt/.test(studioHtml),
        'gain tooltip'
    );
    checkBool('footer bumped past v0.71', !/Arena Studio v0\.71 \|/.test(studioHtml), 'footer');
    checkBool('sweep restores the previous AO level', /\(restore\)/.test(studioHtml), 'restore');
    console.log('=== calibration wiring (S2) ===');
    for (const id of ['cAiCalCh', 'cAiDeadband', 'cAiCalSum', 'cAiCalTable', 'cAiCalTableRow'])
        checkBool(`panel element #${id}`, new RegExp(`id="${id}"`).test(studioHtml), id);
    for (const cmd of ['caicalread', 'caicalopen', 'caicalgnd', 'caicaldb', 'caicalclear']) {
        checkBool(
            `button data-cmd="${cmd}"`,
            new RegExp(`data-cmd="${cmd}"`).test(studioHtml),
            cmd
        );
        checkBool(`handler ${cmd}:`, new RegExp(`^\\s+${cmd}: `, 'm').test(studioHtml), cmd);
    }
    {
        const start = studioHtml.indexOf('const SAFE_BLOCKED_CMDS = new Set([');
        const body = studioHtml.slice(start, studioHtml.indexOf(']);', start));
        for (const cmd of ['caicalopen', 'caicalgnd', 'caicaldb', 'caicalclear'])
            checkBool(`safe mode blocks ${cmd}`, body.includes(`'${cmd}'`), 'SAFE_BLOCKED_CMDS');
        checkBool(
            'safe mode does NOT block the read',
            !body.includes("'caicalread'"),
            'read allowed'
        );
    }
    checkBool(
        'calibration gated on the ai_cal capability',
        /Studio\.capabilities\.includes\('ai_cal'\)/.test(studioHtml),
        'ai_cal gate'
    );
    checkBool(
        'calibration actions logged to the run log',
        /event: 'analog_cal'/.test(studioHtml),
        'analog_cal event'
    );
    checkBool(
        'clear asks for confirmation',
        /Forget the selected channel/.test(studioHtml),
        'confirm'
    );
    checkBool('footer at v0.75', /Arena Studio v0\.75 \|/.test(studioHtml), 'footer');

    console.log('\n=== Summary ===');
    console.log(`${total - failures} / ${total} checks passed`);
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error('test crashed:', e);
    process.exit(1);
});
