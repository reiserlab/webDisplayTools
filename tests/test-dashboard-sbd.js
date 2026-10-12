#!/usr/bin/env node
/**
 * Dashboard: SBD visual place-learning family ('sbd-place').
 *
 * Builds a small synthetic behavior_v2 run log the way the Studio + bridge 3.4
 * write one (session line, frame_schema, run_metadata, runner events with
 * absolute rx_ms, frame rows with relative ms) and checks:
 *   - classification: filename / condition-name routes to 'sbd-place' with the
 *     right variant, and BEFORE the p3 families (p3-sbd-… must not become a
 *     Heisenberg T-figure run); Heisenberg files still classify as before;
 *   - bouts: one row per Mode-3 interval (two per uncoupled pair step), with
 *     the safe zone read from the logged zones, start side, pattern rotation k,
 *     safe / opposite / LED-on fractions, first-entry latency, preference;
 *   - stage summary and occupancy histogram;
 *   - buildPages returns the five SBD pages with CSV rows.
 */
const assert = require('assert');
const A = require('../dashboard/data-browser/analysis-core.js');
const P = require('../dashboard/data-browser/plot-specs.js');

let total = 0;
function check(name, fn) {
    total += 1;
    fn();
    console.log('  PASS  ' + name);
}

// ---- classification -----------------------------------------------------
check('filename p3-sbd-placelearning-led5 → sbd-place (base), not a p3 family', () => {
    const info = A.protocolInfo({ protocol_filename: 'p3-sbd-placelearning-led5.yaml' }, []);
    assert.strictEqual(info.family, 'sbd-place');
    assert.strictEqual(info.sbdVariant, 'base');
    assert.strictEqual(info.label, 'SBD place learning');
});
check('variants from the filename: coupled / uncoupled / bias', () => {
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'p3-sbd-placelearning-coupled.yaml' }, []).sbdVariant,
        'coupled'
    );
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'p3-sbd-placelearning-uncoupled.yaml' }, []).sbdVariant,
        'uncoupled'
    );
    const bias = A.protocolInfo({ protocol_filename: 'sbd-bias-sineA30-placelearning.yaml' }, []);
    assert.strictEqual(bias.sbdVariant, 'bias');
    assert.strictEqual(bias.label, 'SBD place learning (bias)');
});
check('condition names alone route a renamed copy to sbd-place', () => {
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'my_place_test.yaml' }, [
            'preprobe',
            'train_minus',
            'blank'
        ]).family,
        'sbd-place'
    );
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'x.yaml' }, ['preprobe', 'pair_m0_p1']).family,
        'sbd-place'
    );
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'x.yaml' }, ['preprobe']).family,
        'generic'
    );
});
check('Heisenberg files still classify as p3 families', () => {
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'p3-heisenberg-ts-short-led5-baseprobe3.yaml' }, [])
            .family,
        'p3-heisenberg-ts'
    );
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'p3_heisenberg_ts_short.yaml' }, [
            'baseline_phase0',
            'training_phase0'
        ]).family,
        'p3-heisenberg-ts'
    );
});

// ---- zone geometry -------------------------------------------------------
check('heat span from normalized zones; uniform heat → null', () => {
    assert.deepStrictEqual(
        A.sbdHeatSpan({
            baseline: 0,
            zones: [{ level: 5, ramp_in: [8, 16], ramp_out: [150, 158] }]
        }),
        [8, 158]
    );
    assert.strictEqual(
        A.sbdHeatSpan({
            baseline: 0,
            zones: [{ level: 5, ramp_in: [0, 0], ramp_out: [200, 200] }]
        }),
        null
    );
    assert.strictEqual(A.sbdHeatSpan(null), null);
});
check('default zone: 50 safe frames 158..7, centre 183, chance 25 %', () => {
    const zone = A.sbdZone({ steps: [] });
    assert.deepStrictEqual(zone.heat, A.SBD_DEFAULT_HEAT);
    assert.strictEqual(zone.size, 50);
    assert.strictEqual(zone.centerIndex, 183);
    assert.strictEqual(zone.chance, 0.25);
    assert.strictEqual(zone.isSafe(158), true);
    assert.strictEqual(zone.isSafe(7), true);
    assert.strictEqual(zone.isSafe(8), false);
    assert.strictEqual(zone.isSafe(157), false);
    // opposite = the zone rotated 180°: frames 58..107
    assert.strictEqual(zone.isOpposite(58), true);
    assert.strictEqual(zone.isOpposite(107), true);
    assert.strictEqual(zone.isOpposite(57), false);
    assert.strictEqual(zone.isOpposite(108), false);
    assert.strictEqual(zone.angleDeg(183), 0);
    assert.strictEqual(Math.round(zone.angleDeg(57)), Math.round((57 - 183) * 1.8 + 360)); // +133.2
    assert.strictEqual(Math.round(zone.angleDeg(108)), Math.round((108 - 183) * 1.8)); // −135
});

// ---- a synthetic uncoupled run -----------------------------------------
const T0 = 1700000000000;
const lines = [];
const push = (obj) => lines.push(JSON.stringify(obj));
push({ type: 'session', event: 'logging_started', ms: T0 });
push({
    type: 'frame_schema',
    level: 'behavior_v2',
    cols: ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd'],
    arena_cols: ['t_off', 'dt', 'hex', 'status', 'rx_off'],
    t0: T0
});
push({
    type: 'log',
    event: 'run_metadata',
    run_id: 'sbdtest1',
    rig_id: 'rig03-sr',
    protocol_filename: 'p3-sbd-placelearning-uncoupled.yaml',
    experimenter: 'test',
    genotype: 'none',
    rx_ms: T0 + 1
});
let fc = 1000;
function frames(fromMs, toMs, indexAt) {
    for (let ms = fromMs; ms <= toMs; ms += 10) {
        fc += 1;
        push([ms, fc, indexAt(ms), ms, 0, 0, 0]);
    }
}
const UNIFORM = { baseline: 0, zones: [{ level: 5, ramp_in: [0, 0], ramp_out: [200, 200] }] };
const HEAT = { baseline: 0, zones: [{ level: 5, ramp_in: [8, 16], ramp_out: [150, 158] }] };
function runner(phase, extra) {
    push({ type: 'log', event: 'runner', phase, ...extra });
}
// step 0: preprobe, 2 s, start 57 (+), uniform heat; fly sits at 57 for 1 s then at 180 (in zone)
runner('step-start', { index: 0, condition: 'preprobe', rx_ms: T0 + 1000 });
runner('trial-running', {
    index: 0,
    condition: 'preprobe',
    durationSec: 2,
    params: { mode: 3, patternId: 46, initPos: 57 },
    ledActivation: UNIFORM,
    rx_ms: T0 + 1000
});
frames(1000, 3000, (ms) => (ms < 2000 ? 57 : 180));
runner('step-done', { index: 0, condition: 'preprobe', rx_ms: T0 + 3010 });
// step 1: uncoupled pair — bout A: start 108 (−) on pattern 47, goes to 170 (zone) after 0.5 s;
//                          bout B: start 57 (+) on pattern 48, never enters the zone
runner('step-start', { index: 1, condition: 'pair_m1_p2', rx_ms: T0 + 4000 });
runner('trial-running', {
    index: 1,
    condition: 'pair_m1_p2',
    durationSec: 2,
    params: { mode: 3, patternId: 47, initPos: 108 },
    ledActivation: HEAT,
    rx_ms: T0 + 4000
});
frames(4000, 6000, (ms) => (ms < 4500 ? 108 : 170));
runner('trial-running', {
    index: 1,
    condition: 'pair_m1_p2',
    durationSec: 2,
    params: { mode: 3, patternId: 48, initPos: 57 },
    ledActivation: HEAT,
    rx_ms: T0 + 7000
});
frames(7000, 9000, () => 80); // 80 is inside the opposite sector (58..107), LED on
runner('step-done', { index: 1, condition: 'pair_m1_p2', rx_ms: T0 + 9010 });
// step 2: probe, start 108 (−), uniform heat, fly in zone the whole time
runner('step-start', { index: 2, condition: 'probe', rx_ms: T0 + 10000 });
runner('trial-running', {
    index: 2,
    condition: 'probe',
    durationSec: 2,
    params: { mode: 3, patternId: 46, initPos: 108 },
    ledActivation: UNIFORM,
    rx_ms: T0 + 10000
});
frames(10000, 12000, () => 190);
runner('step-done', { index: 2, condition: 'probe', rx_ms: T0 + 12010 });
runner('sequence-complete', { rx_ms: T0 + 12020, summary: { completed: true } });

const run = A.parseJsonl(
    lines.join('\n'),
    'p3-sbd-placelearning-uncoupled__test__x__sbdtest1.jsonl',
    '/x/sbd.jsonl',
    {
        ballDiameterMm: 9,
        smoothWindowS: 0.5
    }
);

check('parsed run classifies as sbd-place / uncoupled', () => {
    assert.strictEqual(run.protocolInfo.family, 'sbd-place');
    assert.strictEqual(run.protocolInfo.sbdVariant, 'uncoupled');
    assert.strictEqual(run.descriptor.protocolFamily, 'sbd-place');
});

const { zone, bouts, trainingBouts } = A.sbdBouts(run);
check(
    'one bout per Mode-3 interval: preprobe, two training bouts from the pair step, probe',
    () => {
        assert.strictEqual(bouts.length, 4);
        assert.deepStrictEqual(
            bouts.map((row) => row.stage),
            ['preprobe', 'training', 'training', 'probe']
        );
        assert.deepStrictEqual(
            bouts.map((row) => row.position),
            [0, 1, 2, 3]
        );
        assert.deepStrictEqual(
            bouts.map((row) => row.label),
            ['preprobe', 'train_01', 'train_02', 'probe']
        );
        assert.strictEqual(trainingBouts, 2);
    }
);
check('zone read from the first training bout: heat [8,158), 50 safe frames', () => {
    assert.deepStrictEqual(zone.heat, [8, 158]);
    assert.strictEqual(zone.size, 50);
});
check('start frame, side and picture rotation per bout', () => {
    assert.deepStrictEqual(
        bouts.map((row) => row.startFrame),
        [57, 108, 57, 108]
    );
    assert.deepStrictEqual(
        bouts.map((row) => row.side),
        ['+', '-', '+', '-']
    );
    assert.deepStrictEqual(
        bouts.map((row) => row.patternId),
        [46, 47, 48, 46]
    );
    assert.deepStrictEqual(
        bouts.map((row) => row.rotationK),
        [0, 1, 2, 0]
    );
    assert.deepStrictEqual(
        bouts.map((row) => row.uniformHeat),
        [true, false, false, true]
    );
});
check('safe fraction, first entry, LED-on fraction, preference', () => {
    const [pre, a, b, probe] = bouts;
    // preprobe: 1 s at 57 (heat side), 1 s at 180 (zone) → ~50 % safe, enters at 1.0 s, LED uniform → 100 %
    assert.ok(Math.abs(pre.safeFraction - 0.5) < 0.02, 'preprobe ~50 % safe: ' + pre.safeFraction);
    assert.ok(Math.abs(pre.firstEntrySec - 1.0) < 0.02);
    assert.strictEqual(pre.ledOnFraction, 1);
    // bout A: 0.5 s at 108 then in zone → ~75 % safe, first entry 0.5 s, LED on only while at 108
    assert.ok(Math.abs(a.safeFraction - 0.75) < 0.02, 'bout A ~75 % safe: ' + a.safeFraction);
    assert.ok(Math.abs(a.firstEntrySec - 0.5) < 0.02);
    assert.ok(Math.abs(a.ledOnFraction - 0.25) < 0.02, 'bout A LED on ~25 %: ' + a.ledOnFraction);
    assert.ok(a.preference > 0.99, 'bout A PI → +1 (never opposite): ' + a.preference);
    // bout B: always at 80 = opposite sector, LED always on, never enters
    assert.strictEqual(b.safeFraction, 0);
    assert.strictEqual(b.oppositeFraction, 1);
    assert.strictEqual(b.ledOnFraction, 1);
    assert.ok(Number.isNaN(b.firstEntrySec));
    assert.strictEqual(b.preference, -1);
    // probe: always in zone
    assert.strictEqual(probe.safeFraction, 1);
    assert.strictEqual(probe.preference, 1);
});
check('stage summary is time-weighted over bouts', () => {
    const s = A.sbdStageSummary(run);
    assert.strictEqual(s.trainingBouts, 2);
    assert.strictEqual(s.preprobe.bouts, 1);
    assert.strictEqual(s.training.bouts, 2);
    // training: bout A ~75 % safe + bout B 0 % → ~37.5 %; PI pooled = (150 − 201) / 351 ≈ −0.145
    assert.ok(
        Math.abs(s.training.safeFraction - 0.375) < 0.02,
        'training ~37.5 %: ' + s.training.safeFraction
    );
    assert.ok(
        s.training.preference < 0 && s.training.preference > -0.3,
        'pooled PI: ' + s.training.preference
    );
    assert.strictEqual(s.probe.preference, 1);
});
check('occupancy histogram is centred on the zone', () => {
    const hist = A.sbdOccupancy(run, 'probe', 100);
    assert.strictEqual(hist.samples, 201);
    const peak = hist.percent.indexOf(Math.max(...hist.percent));
    // frame 190 is (190 − 183) × 1.8 = +12.6° from the centre
    assert.ok(Math.abs(hist.angle[peak] - 12.6) < 4, 'peak near +12.6°: ' + hist.angle[peak]);
});
check('buildPages → the five SBD pages with CSV rows', () => {
    const pages = P.buildPages([run], { mode: 'single', showIndividuals: true });
    assert.deepStrictEqual(
        pages.map((page) => page.id),
        ['sbd-zone-occupancy', 'sbd-first-entry', 'sbd-led-on', 'sbd-occupancy', 'sbd-preference']
    );
    for (const page of pages) {
        assert.ok(
            page.figure && Array.isArray(page.figure.data) && page.figure.data.length,
            page.id + ' has traces'
        );
        assert.ok(Array.isArray(page.csvRows) && page.csvRows.length, page.id + ' has csv rows');
    }
    const zoneRows = pages[0].csvRows;
    assert.strictEqual(zoneRows.length, 4);
    assert.strictEqual(zoneRows[1].rotation_k, 1);
    assert.ok(pages[4].description.includes('uncoupled'));
    // group mode with two copies of the run adds per-fly traces + SEM
    const group = P.buildPages([run, { ...run, id: 'copy' }], {
        mode: 'group',
        showIndividuals: true
    });
    assert.ok(group[0].figure.data.length >= 3);
});

console.log(`\n${total} / ${total} checks passed`);
