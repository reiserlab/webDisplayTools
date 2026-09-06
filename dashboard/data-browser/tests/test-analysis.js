'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../analysis-core.js');
const P = require('../plot-specs.js');

const repo = process.argv[2] || '/Users/reiserm/Documents/GitHub/cshl-2026-course';
const bench = path.join(repo, 'runlogs', 'bench02');
const fixtures = {
    p0: 'p0-opto-intensity__hannah-marie__2026-07-07T20-32-52__3ic476gs.jsonl',
    p1: 'p1-motion-v2__hannah-marie__2026-07-07T22-55-06__8o2so8el.jsonl',
    p2: 'p2-object-burst__hannah-marie__2026-07-08T21-45-53__lk56hjd4.jsonl',
    p3: path.join(
        '..',
        'rig7',
        'p3-conditioning-closedloop-v2-short__michael__2026-07-11T00-25-23__m7qkhw6o.jsonl'
    ),
    p3Legacy: path.join(
        '..',
        'rig7',
        'p3-conditioning-closedloop-short-negative__michael__2026-07-10T23-37-38__kibvj85p.jsonl'
    )
};

function load(file) {
    const fullPath = path.join(bench, file);
    return A.parseJsonl(fs.readFileSync(fullPath, 'utf8'), file, fullPath, {
        ballDiameterMm: 9,
        smoothWindowS: 0.5
    });
}

const p0 = load(fixtures.p0);
const p1 = load(fixtures.p1);
const p2 = load(fixtures.p2);
const p3 = load(fixtures.p3);
const p3Legacy = load(fixtures.p3Legacy);

assert.strictEqual(p0.protocolInfo.family, 'p0');
assert.strictEqual(p1.protocolInfo.family, 'p1');
assert.strictEqual(p2.protocolInfo.family, 'p2-burst');
assert.strictEqual(p3.protocolInfo.family, 'p3-heisenberg-ts');
assert.strictEqual(p3.protocolInfo.p3Pattern, 'heisenberg_ts');
assert.strictEqual(p3.protocolInfo.p3Timing, 'short');
assert.strictEqual(p3.protocolInfo.p3Legacy, false);
assert.strictEqual(p3Legacy.protocolInfo.family, 'p3-legacy-diagnostic');
assert.strictEqual(p3Legacy.protocolInfo.p3Legacy, true);
assert.strictEqual(
    A.protocolInfo({ protocol_filename: 'p3_heisenberg_high_low_full.yaml' }, []).family,
    'p3-heisenberg-high-low'
);
assert.strictEqual(
    A.protocolInfo({ protocol_filename: 'p3_heisenberg_slashes_short.yaml' }, []).family,
    'p3-heisenberg-slashes'
);
assert.strictEqual(
    A.protocolInfo({ protocol_filename: 'p3_heisenberg_relational_full.yaml' }, []).family,
    'p3-heisenberg-relational'
);
assert.strictEqual(
    A.protocolInfo({ protocol_filename: 'p3_dill_random_checkers_short.yaml' }, []).family,
    'p3-dill-random-checkers'
);
// Rig-saved variants (hyphenated, LED-level / trial-length suffixes) must classify
// from metadata alone — the catalog has no condition names yet.
for (const [file, timing] of [
    ['p3-heisenberg-ts-full-led8.yaml', 'full'],
    ['p3-heisenberg-ts-full-led8-40sTrain.yaml', 'full'],
    ['p3-heisenberg-ts-short-led5.yaml', 'short'],
    ['p3_heisenberg_high_low_full_v2.yaml', 'full']
]) {
    const info = A.protocolInfo({ protocol_filename: file }, []);
    assert.strictEqual(info.p3Legacy, false, file + ' is not legacy');
    assert.strictEqual(info.p3Timing, timing, file + ' timing');
}
assert.strictEqual(
    A.protocolInfo({ protocol_filename: 'p3-heisenberg-ts-full-led8.yaml' }, []).family,
    'p3-heisenberg-ts'
);
assert.strictEqual(
    A.protocolInfo({ protocol_filename: 'p3_heisenberg_high_low_full_v2.yaml' }, []).family,
    'p3-heisenberg-high-low'
);
assert.strictEqual(p0.parseErrors.length, 0);
assert.strictEqual(p1.parseErrors.length, 0);
assert.strictEqual(p2.parseErrors.length, 0);
assert.strictEqual(p3.parseErrors.length, 0);
assert.strictEqual(p3Legacy.parseErrors.length, 0);
assert.strictEqual(p3.totalMissingFrames, 0);
assert.strictEqual(p3Legacy.totalMissingFrames, 0);

const p3Trials = p3.steps.filter((step) => A.p3Phase(step.condition));
assert.strictEqual(p3Trials.length, 24);
assert.deepStrictEqual(
    p3Trials.reduce(
        (counts, step) => {
            const phase = A.p3Phase(step.condition);
            counts[phase] += 1;
            return counts;
        },
        { baseline: 0, training: 0, probe: 0 }
    ),
    { baseline: 6, training: 12, probe: 6 }
);
assert.deepStrictEqual(
    A.p3LoggedLedActivations(p3).map((activation) => ({
        variant: activation.variant,
        level: activation.level,
        ranges: activation.ranges
    })),
    [
        {
            variant: 'phase0',
            level: 25,
            ranges: [
                [0, 49],
                [100, 149]
            ]
        },
        {
            variant: 'phase90',
            level: 25,
            ranges: [
                [50, 99],
                [150, 199]
            ]
        }
    ]
);
assert.deepStrictEqual(A.p3AnalysisRanges(p3), [
    [0, 49],
    [100, 149]
]);
const p3Phase90 = p3Trials.find((step) => step.condition === 'baseline_phase90');
const p3Phase90Raw = p3.framesByStep.get(p3Phase90.index)[0].index;
assert.strictEqual(A.p3TrialIndices(p3, p3Phase90, 0)[0], (Math.round(p3Phase90Raw) + 50) % 200);
const legacyTrial = p3Legacy.steps.find((step) => step.condition === 'baseline_b');
const legacyRaw = p3Legacy.framesByStep.get(legacyTrial.index)[0].index;
assert.strictEqual(A.p3TrialIndices(p3Legacy, legacyTrial, 0)[0], Math.round(legacyRaw) % 200);
const p3LedEpochs = A.p3LedEpochs(p3);
assert(p3LedEpochs.length > 0, 'p3 should recover logged LED-on intervals');
const p3TrainingSteps = p3Trials.filter((step) => A.p3Phase(step.condition) === 'training');
const p3TrainingStart = Math.min(...p3TrainingSteps.map((step) => step.startMs));
const p3TrainingEnd = Math.max(...p3TrainingSteps.map((step) => step.endMs));
assert(
    p3LedEpochs.every((epoch) => epoch.startMs >= p3TrainingStart && epoch.endMs <= p3TrainingEnd),
    'p3 LED intervals should stay inside the training block'
);
const firstP3Preference = A.p3PreferenceIndex(p3, p3Trials[0], 0);
assert(Number.isFinite(firstP3Preference.preference));
assert(firstP3Preference.preference >= -1 && firstP3Preference.preference <= 1);
assert(
    Math.abs(
        firstP3Preference.safeFraction -
            firstP3Preference.reinforcedFraction -
            firstP3Preference.preference
    ) < 1e-12
);
const firstTrainingDose = A.p3TrialDoseMetrics(p3, p3TrainingSteps[0]);
assert(firstTrainingDose.ledOnFraction > 0 && firstTrainingDose.ledOnFraction <= 1);
assert(Number.isInteger(firstTrainingDose.sectorEntries));
assert.strictEqual(firstTrainingDose.loggedActivation.level, 25);
const firstP3Quality = A.p3TrialQualityMetrics(p3, p3Trials[0], 1);
assert(firstP3Quality.cueStabilizationStrength >= 0);
assert(firstP3Quality.cueStabilizationStrength <= 1);
assert(firstP3Quality.movementFraction >= 0 && firstP3Quality.movementFraction <= 1);
assert(firstP3Quality.meanSpeedMmS >= 0);
assert(firstP3Quality.meanAbsTurningDegS >= 0);
assert.strictEqual(firstP3Quality.skippedFrames, 0);
const firstP3Dwell = A.p3DwellBouts(p3, p3Trials[0]);
assert(firstP3Dwell.some((bout) => bout.sector === 'safe'));
assert(firstP3Dwell.some((bout) => bout.sector === 'reinforced'));
assert(
    firstP3Dwell.reduce((sum, bout) => sum + bout.durationSec, 0) > 19.8,
    'p3 dwell bouts should cover the trial duration'
);

const p0Trial = p0.steps.find((step) => step.condition === 'grating_cw_level_1');
assert(p0Trial);
assert(
    p0Trial.relStartSec < -1.9 && p0Trial.relStartSec > -2.1,
    'p0 should align to LED onset after a 2 s baseline'
);
assert(p0Trial.epochs.some((epoch) => epoch.type === 'opto'));

const p1Trial = p1.steps.find((step) => step.condition === 'om_36deg_cw_2hz');
assert(p1Trial);
assert(
    p1Trial.relStartSec < -0.45 && p1Trial.relStartSec > -0.6,
    'p1 should align to visual motion onset'
);

const p2Trial = p2.steps.find((step) => step.condition === 'burst_sw_36_cw');
assert(p2Trial);
assert(
    p2Trial.relStartSec < -0.45 && p2Trial.relStartSec > -0.6,
    'p2 burst should retain the pre-stimulus opto epoch'
);
assert(
    p2Trial.epochs.some((epoch) => epoch.type === 'opto' && epoch.endMs <= p2Trial.alignMs + 20)
);

const choice = p2.steps.find((step) => A.choiceInfo(step.condition));
assert(choice);
const angles = A.choiceAngles(p2, choice, 2);
assert(angles.length > 0);
const histogram = A.occupancyHistogram(angles, 100);
assert.strictEqual(histogram.percent.length, 100);
assert(Math.abs(histogram.percent.reduce((sum, value) => sum + value, 0) - 100) < 1e-9);
const smoothedHistogram = A.circularBoxcar(histogram.percent, 5);
assert.strictEqual(smoothedHistogram.length, 100);
assert(
    Math.abs(smoothedHistogram.reduce((sum, value) => sum + value, 0) - 100) < 1e-9,
    'circular display smoothing should preserve total occupancy'
);

const p0Pages = P.buildPages([p0], { mode: 'single', showIndividuals: true });
const p1Pages = P.buildPages([p1], { mode: 'single', showIndividuals: true });
const p2Pages = P.buildPages([p2], { mode: 'single', showIndividuals: true });
const p3Pages = P.buildPages([p3], { mode: 'single', showIndividuals: true });
const p3Page = (id) => p3Pages.find((page) => page.id === id);
assert.strictEqual(p0Pages.length, 7);
assert.strictEqual(p1Pages.length, 9);
assert.strictEqual(p2Pages.length, 9);
assert.strictEqual(p3Pages.length, 9); // + p3-heisenberg-2 and -4
assert(p0Pages.every((page) => page.figure.data.length > 0));
assert(p1Pages.every((page) => page.figure.data.length > 0));
assert(p2Pages.every((page) => page.figure.data.length > 0));
assert(p3Pages.every((page) => page.figure.data.length > 0));
assert.deepStrictEqual(
    p3Pages.map((page) => page.id),
    [
        'p3-timeline',
        'p3-orientation',
        'p3-preference',
        'p3-heisenberg-2',
        'p3-heisenberg-4',
        'p3-corrected-probe',
        'p3-dose-entries',
        'p3-quality-qc',
        'p3-dwell'
    ]
);
assert.strictEqual(
    Object.keys(p3Pages[0].figure.layout).filter((key) => /^yaxis\d*$/.test(key)).length,
    3
);
assert.deepStrictEqual(p3Pages[0].figure.layout.yaxis.range, [-180, 180]);
assert(
    p3Pages[0].figure.layout.shapes.length > p3LedEpochs.length * 3,
    'timeline should overlay LED-on intervals on all three rows plus phase and sector bands'
);
assert.strictEqual(
    Object.keys(p3Pages[1].figure.layout).filter((key) => /^yaxis\d*$/.test(key)).length,
    3
);
assert(
    p3Pages[1].figure.layout.images.every(
        (image) => image.source === 'assets/p3_heisenberg_ts.png'
    ) && p3Pages[1].figure.layout.images.length === 3,
    'orientation histograms should include the static cue-aligned stimulus image'
);
const p3OrientationRows = p3Pages[1].csvRows.filter(
    (row) => row.phase === 'baseline' && row.run_id === p3.id
);
assert.strictEqual(p3OrientationRows.length, 100);
assert(p3OrientationRows.every((row) => row.display_boxcar_indices === 10));
assert(
    p3OrientationRows.some(
        (row) => Math.abs(row.occupancy_percent - row.raw_occupancy_percent) > 1e-9
    ),
    'single-fly occupancy display should use the 10-index circular boxcar'
);
assert(
    Math.abs(p3OrientationRows.reduce((sum, row) => sum + row.occupancy_percent, 0) - 100) < 1e-9
);
assert.strictEqual(
    p3Pages[2].figure.layout.images[0].source,
    'assets/p3_heisenberg_ts.png',
    'trial PI should show the logged stimulus image along the left side'
);
assert.strictEqual(p3Pages[2].csvRows.filter((row) => row.level === 'fly_trial').length, 24);
assert.strictEqual(
    p3Page('p3-corrected-probe').csvRows.filter((row) => row.level === 'fly_trial').length,
    6
);
assert.strictEqual(
    Object.keys(p3Page('p3-dose-entries').figure.layout).filter((key) => /^yaxis\d*$/.test(key))
        .length,
    2
);
assert.strictEqual(
    p3Page('p3-dose-entries').csvRows.filter((row) => row.level === 'fly_trial').length,
    48
);
assert(
    p3Page('p3-dose-entries').csvRows.some(
        (row) => row.metric === 'ledOnPercent' && row.led_level_percent === 25
    ),
    'dose CSV should retain actual logged LED level and raw ranges'
);
assert.strictEqual(
    Object.keys(p3Page('p3-quality-qc').figure.layout).filter((key) => /^yaxis\d*$/.test(key))
        .length,
    5
);
assert.strictEqual(
    p3Page('p3-quality-qc').csvRows.filter((row) => row.level === 'fly_trial').length,
    120
);
assert(
    p3Page('p3-dwell').csvRows.some((row) => row.sector === 'safe') &&
        p3Page('p3-dwell').csvRows.some((row) => row.sector === 'reinforced')
);
assert(p2Pages.find((page) => page.id === 'p2-occupancy').csvRows.length > 0);
assert(
    p2Pages
        .find((page) => page.id === 'p2-polar')
        .figure.data.every((trace) => trace.type === 'scatterpolar')
);

const p1Matched = p1Pages.find((page) => page.id === 'p1-optomotor-matched-summary');
assert(p1Matched, 'p1 should include a two-row matched optomotor summary');
assert.strictEqual(
    Object.keys(p1Matched.figure.layout).filter((key) => /^yaxis\d*$/.test(key)).length,
    4
);
const rawP1Ccw = A.mean(
    p1.steps
        .filter((step) => step.condition === 'om_36deg_ccw_2hz')
        .map((step) => A.stepMean(p1, step, 'turning', 0, 2))
);
const alignedCcw = p1Matched.figure.data.find(
    (trace) => trace.name === 'CCW / left' && trace.yaxis === 'y'
);
assert(alignedCcw);
assert(
    Math.abs(alignedCcw.y[alignedCcw.x.indexOf(2)] + rawP1Ccw) < 1e-9,
    'CCW/left turning should be sign-flipped into the CW/right frame'
);

const p1Folded = p1Pages.find((page) => page.id === 'p1-optomotor-folded-summary');
assert(p1Folded, 'p1 should include a CW-aligned folded optomotor summary');
const rawP1Cw = A.mean(
    p1.steps
        .filter((step) => step.condition === 'om_36deg_cw_2hz')
        .map((step) => A.stepMean(p1, step, 'turning', 0, 2))
);
const foldedTurning = p1Folded.figure.data.find(
    (trace) => trace.name === 'CW-aligned folded mean' && trace.yaxis === 'y'
);
assert(foldedTurning);
assert(
    Math.abs(foldedTurning.y[foldedTurning.x.indexOf(2)] - (rawP1Cw - rawP1Ccw) / 2) < 1e-9,
    'folded turning should average CW with sign-flipped CCW'
);
const rawP1CwForward = A.mean(
    p1.steps
        .filter((step) => step.condition === 'om_36deg_cw_2hz')
        .map((step) => A.stepMean(p1, step, 'forward', 0, 2))
);
const rawP1CcwForward = A.mean(
    p1.steps
        .filter((step) => step.condition === 'om_36deg_ccw_2hz')
        .map((step) => A.stepMean(p1, step, 'forward', 0, 2))
);
const foldedForward = p1Folded.figure.data.find(
    (trace) => trace.name === 'CW-aligned folded mean' && trace.yaxis === 'y3'
);
assert(foldedForward);
assert(
    Math.abs(foldedForward.y[foldedForward.x.indexOf(2)] - (rawP1CwForward + rawP1CcwForward) / 2) <
        1e-9,
    'folded forward should average CW and CCW without sign reversal'
);

const manualP1Pages = P.buildPages([p1], {
    mode: 'single',
    showIndividuals: true,
    axisRanges: { turning: [-300, 300], forward: [0, 25] },
    useCourseAxisFloor: false
});
assert.deepStrictEqual(
    manualP1Pages.find((page) => page.id === 'p1-optomotor-turning').figure.layout.yaxis.range,
    [-300, 300]
);
assert.deepStrictEqual(
    manualP1Pages.find((page) => page.id === 'p1-optomotor-forward').figure.layout.yaxis.range,
    [0, 25]
);
const manualMatched = manualP1Pages.find((page) => page.id === 'p1-optomotor-matched-summary');
assert.deepStrictEqual(manualMatched.figure.layout.yaxis.range, [-300, 300]);
assert.deepStrictEqual(manualMatched.figure.layout.yaxis3.range, [0, 25]);
const manualFolded = manualP1Pages.find((page) => page.id === 'p1-optomotor-folded-summary');
assert.deepStrictEqual(manualFolded.figure.layout.yaxis.range, [-300, 300]);
assert.deepStrictEqual(manualFolded.figure.layout.yaxis3.range, [0, 25]);

const p2Forward = p2Pages.find((page) => page.id === 'p2-sweep-forward');
const p2ForwardValues = p2Forward.figure.data.flatMap((trace) =>
    Array.isArray(trace.y) ? trace.y.filter(Number.isFinite) : []
);
const p2ForwardRange = p2Forward.figure.layout.yaxis.range;
assert.deepStrictEqual(
    p2ForwardRange,
    [-20, 20],
    'ordinary forward plots should use the shared course envelope'
);
assert(
    p2ForwardRange[0] < Math.min(...p2ForwardValues) &&
        p2ForwardRange[1] > Math.max(...p2ForwardValues),
    'shared p2 forward range should contain every displayed point with padding'
);
assert(
    Object.entries(p2Forward.figure.layout)
        .filter(([key]) => /^yaxis\d*$/.test(key))
        .every(([, axis]) => JSON.stringify(axis.range) === JSON.stringify(p2ForwardRange)),
    'all p2 forward panels should use the same dataset-wide range'
);

assert.deepStrictEqual(
    P.datasetSharedRange([{ traces: [{ y: [-8, 0, 12] }] }]).map((value) =>
        Number(value.toFixed(8))
    ),
    [-10, 15],
    'dataset range should include full extrema rather than a percentile cutoff'
);

const secondP0 = load('p0-opto-intensity__hannah-marie__2026-07-07T20-11-17__qjs21a3i.jsonl');
const grouped = P.buildPages([p0, secondP0], { mode: 'group', showIndividuals: true });
assert.strictEqual(grouped.length, 7);
assert(grouped.some((page) => page.csvRows.some((row) => row.level === 'group_mean')));

console.log(
    JSON.stringify({
        p0: { frames: p0.frames.length, steps: p0.steps.length, pages: p0Pages.length },
        p1: { frames: p1.frames.length, steps: p1.steps.length, pages: p1Pages.length },
        p2: { frames: p2.frames.length, steps: p2.steps.length, pages: p2Pages.length },
        p3: { frames: p3.frames.length, steps: p3.steps.length, pages: p3Pages.length },
        groupedP0Pages: grouped.length
    })
);

// ---- p3 Heisenberg-style bundled preference index --------------------------
{
    // Pure bundling on synthetic rows: pooled (time-weighted) PI, same-stage
    // chunking, partial trailing bundle, real step times.
    const mk = (stage, trial, safe, reinforced, t0) => ({
        stage,
        phase: stage.startsWith('probe') || stage === 'final_probe' ? 'probe' : stage.split('_')[0],
        variant: trial % 2 ? 'phase0' : 'phase90',
        trial,
        samples: safe + reinforced,
        safeFraction: safe / (safe + reinforced),
        reinforcedFraction: reinforced / (safe + reinforced),
        step: { startMs: t0, endMs: t0 + 20000 }
    });
    const rows = [
        mk('baseline', 1, 50, 50, 0),
        mk('baseline', 2, 90, 10, 20000), // pooled: 140 safe / 60 reinf → 0.4
        mk('training_1', 3, 100, 0, 40000),
        mk('training_1', 4, 100, 0, 60000),
        mk('training_1', 5, 0, 100, 80000) // odd count → partial bundle of 1
    ];
    const b2 = A.p3BundleTrials(rows, 2);
    assert.strictEqual(b2.length, 3);
    assert.deepStrictEqual(b2[0].trials, [1, 2]);
    assert.strictEqual(b2[0].stage, 'baseline');
    assert.ok(Math.abs(b2[0].preference - 0.4) < 1e-9, 'pooled PI is time-weighted');
    assert.strictEqual(b2[0].startMs, 0);
    assert.strictEqual(b2[0].endMs, 40000);
    assert.strictEqual(b2[0].durationSec, 40);
    assert.strictEqual(b2[0].partial, false);
    assert.deepStrictEqual(b2[1].trials, [3, 4]); // never crosses a stage boundary
    assert.strictEqual(b2[1].preference, 1);
    assert.deepStrictEqual(b2[2].trials, [5]);
    assert.strictEqual(b2[2].partial, true);
    assert.strictEqual(b2[2].preference, -1);
    assert.deepStrictEqual(
        b2.map((b) => b.key),
        ['baseline#1', 'training_1#1', 'training_1#2']
    );
    const b4 = A.p3BundleTrials(rows, 4);
    assert.strictEqual(b4.length, 2);
    assert.deepStrictEqual(b4[1].trials, [3, 4, 5]);
    assert.strictEqual(b4[1].partial, true);
    assert.ok(Math.abs(b4[1].preference - (200 - 100) / 300) < 1e-9);
    assert.strictEqual(A.p3BundleTrials([], 2).length, 0);

    // Real run: pages exist, every trial lands in exactly one bundle, bars
    // carry the classic styling, and the axis label follows the trial length.
    const pages = P.buildPages([p3], { mode: 'single' });
    const h2 = pages.find((page) => page.id === 'p3-heisenberg-2');
    const h4 = pages.find((page) => page.id === 'p3-heisenberg-4');
    assert.ok(h2 && h4, 'both bundle pages registered');
    const trialCount = p3.steps.filter((step) => A.p3Phase(step.condition)).length;
    const flyRows2 = h2.csvRows.filter((row) => row.level === 'fly_bundle');
    const covered2 = flyRows2.reduce((sum, row) => sum + row.bundle_size, 0);
    assert.strictEqual(covered2, trialCount, 'every trial in exactly one 2-bundle');
    const covered4 = h4.csvRows
        .filter((row) => row.level === 'fly_bundle')
        .reduce((sum, row) => sum + row.bundle_size, 0);
    assert.strictEqual(covered4, trialCount, 'every trial in exactly one 4-bundle');
    assert.ok(
        flyRows2.every((row) => row.stage && row.phase),
        'stage + phase on every bundle'
    );
    const training = h2.figure.data.find((trace) => trace.name === 'training');
    const probe = h2.figure.data.find((trace) => trace.name === 'memory test');
    assert.ok(training && training.marker.pattern.shape === '/', 'training bars hatched');
    assert.ok(probe && probe.marker.pattern.shape === '.', 'memory-test bars dotted');
    assert.ok(
        h2.figure.data.every((trace) => trace.x.every(Number.isFinite)),
        'finite minute positions'
    );
    assert.strictEqual(h2.figure.layout.xaxis.title, 't [min]');
    const pref = pages.find((page) => page.id === 'p3-preference');
    assert.ok(
        /^\d+ s trial$/.test(pref.figure.layout.xaxis.title),
        'trial axis title derived from log'
    );
    console.log(
        'p3 Heisenberg bundles OK:',
        b2.length,
        'synthetic;',
        flyRows2.length,
        '2-bundles /',
        trialCount,
        'trials in',
        fixtures.p3.split('/').pop()
    );
}

// ---- catalog: session bounds from head/tail + loaded-run duration -------------
{
    const head =
        '{"type":"session","event":"logging_started","file":"x.jsonl","ms":1788636439304}\n' +
        '{"type":"frame_schema","level":"behavior_v1","cols":["ms","fc","idx","ft","x","y","hd"]}\n' +
        '{"type":"log","event":"run_metadata","run_id":"r1","timestamp_start":"2026-09-05T19:27:19.251Z","rx_ms":1788636439305}\n' +
        '[6,37638,53,0.0,1.99288,-0.91475,4.6'; // partial trailing line
    const tail =
        ',41.68795,1.02512]\n' + // partial leading line
        '{"type":"log","event":"runner","phase":"sequence-complete","dir":"browser→bridge","rx_ms":1788638604507}\n' +
        '{"type":"session","event":"logging_stopped","ms":1788638604509}\n';
    const b = A.sessionBounds(head, tail);
    assert.strictEqual(b.startMs, 1788636439304);
    assert.strictEqual(b.stopMs, 1788638604509);
    assert.ok(Math.abs(b.durationSec - 2165.205) < 1e-6, 'duration from session bookends');
    assert.strictEqual(b.complete, true);
    // aborted run, no logging_stopped in the tail → runner rx_ms fallback + complete=false
    const tail2 = '{"type":"log","event":"runner","phase":"aborted","rx_ms":1788637000000}\n';
    const b2 = A.sessionBounds(head, tail2);
    assert.strictEqual(b2.complete, false);
    assert.ok(Math.abs(b2.durationSec - 560.696) < 1e-6);
    // no tail at all → NaN, never throws
    assert.ok(Number.isNaN(A.sessionBounds(head, null).durationSec));
    assert.ok(Number.isNaN(A.sessionBounds('', '').durationSec));
    // metadata start fallback when logging_started is missing
    const b3 = A.sessionBounds(head.split('\n').slice(1).join('\n'), tail);
    assert.strictEqual(b3.startMs, Date.parse('2026-09-05T19:27:19.251Z'));
    // descriptor carries startedMs
    const d = A.descriptorFromMetadata({ timestamp_start: '2026-09-05T19:27:19.251Z' }, 'x.jsonl');
    assert.strictEqual(d.startedMs, Date.parse('2026-09-05T19:27:19.251Z'));
    // loaded-run duration on the real fixture matches its own bookends
    const dur = A.runDurationSec(p3);
    assert.ok(Number.isFinite(dur) && dur > 60, 'fixture duration ' + dur);
    const text = fs.readFileSync(path.join(bench, fixtures.p3), 'utf8');
    const fromBounds = A.sessionBounds(text.slice(0, 4096), text.slice(-4096));
    assert.ok(
        Math.abs(fromBounds.durationSec - dur) < 0.01,
        `bounds ${fromBounds.durationSec} vs run ${dur}`
    );
    console.log('catalog duration helpers OK: fixture', dur.toFixed(1), 's');
}
