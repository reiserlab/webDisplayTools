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
check('optomotor_led_test / optomotor_test_60deg(_tf) → family optomotor, not p0', () => {
    const led = A.protocolInfo({ protocol_filename: 'optomotor_led_test.yaml' }, []);
    assert.strictEqual(led.family, 'optomotor');
    assert.strictEqual(led.label, 'optomotor ± opto LED (36° grating)');
    const deg60 = A.protocolInfo({ protocol_filename: 'optomotor_test_60deg.yaml' }, []);
    assert.strictEqual(deg60.label, 'optomotor ± opto LED (60° grating)');
    assert.strictEqual(deg60.optomotorGratingDeg, 60);
    const tf = A.protocolInfo({ protocol_filename: 'optomotor_test_60deg_tf.yaml' }, []);
    assert.strictEqual(tf.label, 'optomotor ± opto LED (60° grating, temporal frequency variable)');
    // condition names alone (a renamed copy): grating_cw_noled is NOT a p0 level
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'x.yaml' }, [
            'all_on',
            'grating_cw_noled',
            'gap',
            'grating_ccw_led'
        ]).family,
        'optomotor'
    );
    // the real p0 protocol still classifies as p0
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'p0_opto_intensity_short.yaml' }, ['grating_cw_3'])
            .family,
        'p0'
    );
});

check(
    '"optomotor" inside a filename is not enough: protocols without an opto LED stay generic',
    () => {
        const cases = [
            ['g6_color_optomotor_smoke.yaml', ['dark_pause', 'violet_pair_d100', 'blue_pair_d100']],
            ['g6_color_optomotor_test.yaml', ['dark_pause', 'violet_pair_d25', 'blue_pair_d25']],
            ['simple_optomotor_protocol.yaml', ['rightward_grating', 'leftward_grating']]
        ];
        for (const [file, conditions] of cases) {
            // The catalog classifies from the filename alone; a loaded run adds the conditions.
            assert.strictEqual(
                A.protocolInfo({ protocol_filename: file }, []).family,
                'generic',
                file
            );
            assert.strictEqual(
                A.protocolInfo({ protocol_filename: file }, conditions).family,
                'generic',
                file
            );
        }
        // A folder in the stored name does not change the result, and hyphens count as underscores.
        assert.strictEqual(
            A.protocolInfo({ protocol_filename: 'protocols/rig03-sr/optomotor-led-test.yaml' }, [])
                .family,
            'optomotor'
        );
    }
);

check('SBD revision in the label: coupled v2 / v3, bias40 v2, uncoupled', () => {
    const v3 = A.protocolInfo(
        { protocol_filename: 'p3-sbd-placelearning-coupled-v3-led14.yaml' },
        []
    );
    assert.strictEqual(v3.family, 'sbd-place');
    assert.strictEqual(v3.sbdVariant, 'coupled');
    assert.strictEqual(v3.sbdVersion, 'v3');
    assert.strictEqual(v3.label, 'SBD place learning (coupled v3)');
    const v2 = A.protocolInfo(
        { protocol_filename: 'p3-sbd-placelearning-coupled-v2-led10.yaml' },
        []
    );
    assert.strictEqual(v2.label, 'SBD place learning (coupled v2)');
    const bias = A.protocolInfo(
        { protocol_filename: 'p3-sbd-placelearning-coupled-bias40-led20-v2.yaml' },
        []
    );
    assert.strictEqual(bias.label, 'SBD place learning (bias v2)');
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'p3-sbd-placelearning-uncoupled-led20-v2.yaml' }, [])
            .label,
        'SBD place learning (uncoupled v2)'
    );
    assert.strictEqual(
        A.protocolInfo({ protocol_filename: 'p3-sbd-placelearning-led5.yaml' }, []).sbdVersion,
        'v1'
    );
    // a renamed v3 copy is recognised from its sham stages
    const renamed = A.protocolInfo({ protocol_filename: 'x.yaml' }, [
        'sham_preprobe',
        'preprobe',
        'train_plus',
        'probe_mid'
    ]);
    assert.strictEqual(renamed.label, 'SBD place learning (v3)');
});

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

// ---- v1/v2 runs know nothing of the v3 stages --------------------------
check('v1/v2 run: no heat-off bouts, summary lists only preprobe / training / probe', () => {
    assert.deepStrictEqual(
        bouts.map((row) => row.heatOff),
        [false, false, false, false]
    );
    const s = A.sbdStageSummary(run);
    assert.deepStrictEqual(s.stages, ['preprobe', 'training', 'probe']);
    for (const stage of ['sham_preprobe', 'probe_mid', 'sham_probe']) {
        assert.strictEqual(s[stage].bouts, 0, stage + ' has no bouts');
        assert.ok(Number.isNaN(s[stage].preference), stage + ' PI is NaN');
    }
    assert.strictEqual(s.preprobe.shortLabel, 'before');
    assert.strictEqual(s.probe.shortLabel, 'test');
    assert.strictEqual(s.training.heatOff, false);
    const pages = P.buildPages([run], { mode: 'single', showIndividuals: true });
    // the sequence pages label the tests and number the bouts
    assert.deepStrictEqual(pages[0].figure.layout.xaxis.ticktext, ['before', '1', '2', 'test']);
    // the stage pages show only the stages the run ran
    assert.deepStrictEqual(pages[4].figure.data[0].x, ['preprobe', 'training', 'probe']);
    assert.strictEqual(pages[3].figure.data.length, 3);
    assert.strictEqual(pages[0].csvRows[0].heat_off, false);
});

// ---- stage mapping for the v3 / v4 condition names -----------------------
check('sbdStage: sham / mid tests are their own stages, v4 train_k<k>_<side> is training', () => {
    assert.strictEqual(A.sbdStage('sham_preprobe'), 'sham_preprobe');
    assert.strictEqual(A.sbdStage('probe_mid'), 'probe_mid');
    assert.strictEqual(A.sbdStage('sham_probe'), 'sham_probe');
    assert.strictEqual(A.sbdStage('preprobe'), 'preprobe');
    assert.strictEqual(A.sbdStage('probe'), 'probe');
    for (const name of [
        'train_plus',
        'train_minus',
        'train_k0_plus',
        'train_k3_minus',
        'pair_m1_p2'
    ])
        assert.strictEqual(A.sbdStage(name), 'training', name);
    for (const name of ['blank', 'optomotor_cw', 'led_off', 'train_k10_plus', 'probe_x'])
        assert.strictEqual(A.sbdStage(name), '', name);
    assert.deepStrictEqual(A.SBD_STAGES, [
        'sham_preprobe',
        'preprobe',
        'training',
        'probe_mid',
        'sham_probe',
        'probe'
    ]);
    assert.deepStrictEqual(A.SBD_SHAM_STAGES, ['sham_preprobe', 'sham_probe']);
    assert.strictEqual(A.sbdIsHeatOff('sham_probe'), true);
    assert.strictEqual(A.sbdIsHeatOff('probe_mid'), false);
    assert.deepStrictEqual(A.SBD_STAGE_SHORT, {
        sham_preprobe: 'sham before',
        preprobe: 'before',
        training: 'training',
        probe_mid: 'mid test',
        sham_probe: 'sham test',
        probe: 'test'
    });
});
check('a renamed v4 uncoupled copy (train_k<k>_<side> + preprobe) routes to sbd-place', () => {
    const info = A.protocolInfo({ protocol_filename: 'x.yaml' }, [
        'sham_preprobe',
        'preprobe',
        'train_k0_plus',
        'train_k1_minus',
        'probe_mid'
    ]);
    assert.strictEqual(info.family, 'sbd-place');
    assert.strictEqual(info.sbdVersion, 'v3');
});

// ---- a synthetic v3/v4-style coupled run ---------------------------------
// sham_preprobe(+) preprobe(−) train_01(+) train_02(−) probe_mid(+) train_03(−)
// sham_probe(−) probe(+); the shams carry NO ledActivation (LED off, ledDrive 0 before).
const lines3 = [];
const push3 = (obj) => lines3.push(JSON.stringify(obj));
push3({ type: 'session', event: 'logging_started', ms: T0 });
push3({
    type: 'frame_schema',
    level: 'behavior_v2',
    cols: ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd'],
    arena_cols: ['t_off', 'dt', 'hex', 'status', 'rx_off'],
    t0: T0
});
push3({
    type: 'log',
    event: 'run_metadata',
    run_id: 'sbdtest3',
    rig_id: 'rig03-sr',
    protocol_filename: 'p3-sbd-placelearning-coupled-v4-led14.yaml',
    experimenter: 'test',
    genotype: 'none',
    rx_ms: T0 + 1
});
let fc3 = 5000;
function frames3(fromMs, toMs, indexAt) {
    for (let ms = fromMs; ms <= toMs; ms += 10) {
        fc3 += 1;
        push3([ms, fc3, indexAt(ms), ms, 0, 0, 0]);
    }
}
const V3_STEPS = [
    // [condition, start frame, ledActivation (undefined = LED off), fly index over the 2 s bout]
    ['sham_preprobe', 57, undefined, () => 80], // opposite sector the whole time — heat frames, LED OFF
    ['preprobe', 108, UNIFORM, () => 80],
    ['train_plus', 57, HEAT, (t) => (t < 1000 ? 57 : 180)],
    ['train_minus', 108, HEAT, () => 180],
    ['probe_mid', 57, UNIFORM, (t) => (t < 500 ? 57 : 183)],
    ['train_k0_minus', 108, HEAT, () => 180], // the v4 uncoupled name
    ['sham_probe', 108, undefined, () => 183], // zone centre the whole time, LED OFF
    ['probe', 57, UNIFORM, () => 190]
];
V3_STEPS.forEach(([condition, initPos, ledActivation, indexAt], index) => {
    const base = 1000 + index * 3000;
    push3({
        type: 'log',
        event: 'runner',
        phase: 'step-start',
        index,
        condition,
        rx_ms: T0 + base
    });
    const trial = {
        type: 'log',
        event: 'runner',
        phase: 'trial-running',
        index,
        condition,
        durationSec: 2,
        params: { mode: 3, patternId: 46, initPos },
        rx_ms: T0 + base
    };
    if (ledActivation) trial.ledActivation = ledActivation;
    push3(trial);
    frames3(base, base + 2000, (ms) => indexAt(ms - base));
    push3({
        type: 'log',
        event: 'runner',
        phase: 'step-done',
        index,
        condition,
        rx_ms: T0 + base + 2010
    });
});
push3({
    type: 'log',
    event: 'runner',
    phase: 'sequence-complete',
    rx_ms: T0 + 1000 + V3_STEPS.length * 3000,
    summary: { completed: true }
});
const run3 = A.parseJsonl(
    lines3.join('\n'),
    'p3-sbd-placelearning-coupled-v4-led14__test__x__sbdtest3.jsonl',
    '/x/sbd3.jsonl',
    { ballDiameterMm: 9, smoothWindowS: 0.5 }
);
const v3 = A.sbdBouts(run3);

check('v4 run classifies as sbd-place / coupled v4', () => {
    assert.strictEqual(run3.protocolInfo.family, 'sbd-place');
    assert.strictEqual(run3.protocolInfo.sbdVariant, 'coupled');
    assert.strictEqual(run3.protocolInfo.sbdVersion, 'v4');
});
check(
    'v3/v4 bouts: every test is its own stage, positions line up across protocol versions',
    () => {
        assert.strictEqual(v3.bouts.length, 8);
        assert.strictEqual(v3.trainingBouts, 3);
        assert.deepStrictEqual(
            v3.bouts.map((row) => row.stage),
            [
                'sham_preprobe',
                'preprobe',
                'training',
                'training',
                'probe_mid',
                'training',
                'sham_probe',
                'probe'
            ]
        );
        assert.deepStrictEqual(
            v3.bouts.map((row) => row.label),
            [
                'sham_preprobe',
                'preprobe',
                'train_01',
                'train_02',
                'probe_mid',
                'train_03',
                'sham_probe',
                'probe'
            ]
        );
        // sham before −1, before 0, train_k = k, mid test / sham test = k + 0.5 after bout k, test = N + 1
        assert.deepStrictEqual(
            v3.bouts.map((row) => row.position),
            [-1, 0, 1, 2, 2.5, 3, 3.5, 4]
        );
        assert.deepStrictEqual(
            v3.bouts.map((row) => row.bout),
            [null, null, 1, 2, null, 3, null, null]
        );
        assert.deepStrictEqual(
            v3.bouts.map((row) => row.side),
            ['+', '-', '+', '-', '+', '-', '-', '+']
        );
    }
);
check(
    'v3/v4 heat flags: shams are heat-off (LED on 0 even in heat frames), not uniform heat',
    () => {
        assert.deepStrictEqual(
            v3.bouts.map((row) => row.heatOff),
            [true, false, false, false, false, false, true, false]
        );
        assert.deepStrictEqual(
            v3.bouts.map((row) => row.uniformHeat),
            [false, true, false, false, true, false, false, true]
        );
        const [shamPre, pre, t1, , mid, , shamProbe, probe] = v3.bouts;
        // sham_preprobe sits at frame 80 (a heat frame) the whole time, yet the LED was off
        assert.strictEqual(shamPre.ledOnFraction, 0);
        assert.strictEqual(pre.ledOnFraction, 1); // the same frames with uniform heat
        assert.strictEqual(shamProbe.ledOnFraction, 0);
        assert.strictEqual(mid.ledOnFraction, 1);
        assert.strictEqual(probe.ledOnFraction, 1);
        assert.ok(
            Math.abs(t1.ledOnFraction - 0.5) < 0.02,
            'train_01 LED on ~50 %: ' + t1.ledOnFraction
        );
    }
);
check('v3/v4 shams and mid test are scored on the same zone geometry as the probe', () => {
    assert.deepStrictEqual(v3.zone.heat, [8, 158]);
    const [shamPre, , , , mid, , shamProbe, probe] = v3.bouts;
    assert.strictEqual(shamPre.safeFraction, 0);
    assert.strictEqual(shamPre.oppositeFraction, 1);
    assert.strictEqual(shamPre.preference, -1);
    assert.ok(Number.isNaN(shamPre.firstEntrySec));
    assert.strictEqual(shamProbe.safeFraction, 1);
    assert.strictEqual(shamProbe.preference, 1);
    assert.strictEqual(shamProbe.firstEntrySec, 0);
    assert.ok(Math.abs(mid.safeFraction - 0.75) < 0.02, 'mid test ~75 % safe: ' + mid.safeFraction);
    assert.ok(Math.abs(mid.firstEntrySec - 0.5) < 0.02);
    assert.strictEqual(mid.preference, 1);
    assert.strictEqual(probe.preference, 1);
});
check('v3/v4 stage summary lists all six stages in protocol order with short labels', () => {
    const s = A.sbdStageSummary(run3);
    assert.deepStrictEqual(s.stages, A.SBD_STAGES);
    assert.strictEqual(s.trainingBouts, 3);
    assert.deepStrictEqual(
        s.stages.map((stage) => s[stage].bouts),
        [1, 1, 3, 1, 1, 1]
    );
    assert.deepStrictEqual(
        s.stages.map((stage) => s[stage].shortLabel),
        ['sham before', 'before', 'training', 'mid test', 'sham test', 'test']
    );
    assert.deepStrictEqual(
        s.stages.map((stage) => s[stage].heatOff),
        [true, false, false, false, true, false]
    );
    assert.strictEqual(s.sham_preprobe.ledOnFraction, 0);
    assert.strictEqual(s.sham_probe.ledOnFraction, 0);
    assert.strictEqual(s.probe_mid.ledOnFraction, 1);
    assert.strictEqual(s.sham_preprobe.preference, -1);
    assert.strictEqual(s.sham_probe.preference, 1);
    assert.strictEqual(s.probe_mid.preference, 1);
    assert.strictEqual(A.sbdOccupancy(run3, 'sham_probe', 100).samples, 201);
});
check(
    'v3/v4 pages: the stage pages gain the sham / mid stages, the sequence axis labels them',
    () => {
        const pages = P.buildPages([run3], { mode: 'single', showIndividuals: true });
        assert.deepStrictEqual(
            pages.map((page) => page.id),
            [
                'sbd-zone-occupancy',
                'sbd-first-entry',
                'sbd-led-on',
                'sbd-occupancy',
                'sbd-preference'
            ]
        );
        assert.deepStrictEqual(
            pages[0].figure.layout.xaxis.tickvals,
            [-1, 0, 1, 2, 2.5, 3, 3.5, 4]
        );
        assert.deepStrictEqual(pages[0].figure.layout.xaxis.ticktext, [
            'sham before',
            'before',
            '1',
            '2',
            'mid test',
            '3',
            'sham test',
            'test'
        ]);
        // one shaded band per test (5), none for the training bouts
        assert.strictEqual(
            pages[0].figure.layout.shapes.filter((shape) => shape.type === 'rect').length,
            5
        );
        assert.strictEqual(pages[0].csvRows.length, 8);
        assert.strictEqual(pages[0].csvRows[0].heat_off, true);
        assert.strictEqual(pages[0].csvRows[0].stage, 'sham_preprobe');
        // LED page: the sham tests plot 0
        const ledMean = pages[2].figure.data[pages[2].figure.data.length - 1];
        assert.strictEqual(ledMean.y[0], 0);
        assert.strictEqual(ledMean.y[6], 0);
        assert.strictEqual(ledMean.y[1], 100);
        // occupancy: one trace per stage present
        assert.strictEqual(pages[3].figure.data.length, 6);
        assert.deepStrictEqual(
            pages[3].figure.data.map((trace) => trace.name),
            [
                'sham before (LED off)',
                'before (uniform heat)',
                'training (heat outside the zone)',
                'mid test (uniform heat)',
                'sham test (LED off)',
                'test (uniform heat)'
            ]
        );
        // preference: six bars, labelled with the short names
        const bar = pages[4].figure.data[pages[4].figure.data.length - 1];
        assert.deepStrictEqual(bar.x, A.SBD_STAGES);
        assert.deepStrictEqual(pages[4].figure.layout.xaxis.ticktext, [
            'sham before',
            'before',
            'training',
            'mid test',
            'sham test',
            'test'
        ]);
        assert.strictEqual(bar.y[0], -1);
        assert.strictEqual(bar.y[4], 1);
        const prefRows = pages[4].csvRows;
        assert.strictEqual(prefRows.length, 6);
        assert.strictEqual(prefRows[0].stage_label, 'sham before');
        assert.strictEqual(prefRows[0].heat_off, true);
        // a mixed group (v1/v2 + v4) shows the union of stages, still in protocol order
        const mixed = P.buildPages([run, run3], { mode: 'group', showIndividuals: true });
        const mixedBar = mixed[4].figure.data[mixed[4].figure.data.length - 1];
        assert.deepStrictEqual(mixedBar.x, A.SBD_STAGES);
        assert.strictEqual(mixed[3].figure.data.length, 6);
    }
);

console.log(`\n${total} / ${total} checks passed`);
