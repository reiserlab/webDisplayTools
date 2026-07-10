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
    p2: 'p2-object-burst__hannah-marie__2026-07-08T21-45-53__lk56hjd4.jsonl'
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

assert.strictEqual(p0.protocolInfo.family, 'p0');
assert.strictEqual(p1.protocolInfo.family, 'p1');
assert.strictEqual(p2.protocolInfo.family, 'p2-burst');
assert.strictEqual(p0.parseErrors.length, 0);
assert.strictEqual(p1.parseErrors.length, 0);
assert.strictEqual(p2.parseErrors.length, 0);

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

const p0Pages = P.buildPages([p0], { mode: 'single', showIndividuals: true });
const p1Pages = P.buildPages([p1], { mode: 'single', showIndividuals: true });
const p2Pages = P.buildPages([p2], { mode: 'single', showIndividuals: true });
assert.strictEqual(p0Pages.length, 7);
assert.strictEqual(p1Pages.length, 7);
assert.strictEqual(p2Pages.length, 9);
assert(p0Pages.every((page) => page.figure.data.length > 0));
assert(p1Pages.every((page) => page.figure.data.length > 0));
assert(p2Pages.every((page) => page.figure.data.length > 0));
assert(p2Pages.find((page) => page.id === 'p2-occupancy').csvRows.length > 0);
assert(
    p2Pages
        .find((page) => page.id === 'p2-polar')
        .figure.data.every((trace) => trace.type === 'scatterpolar')
);

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
        groupedP0Pages: grouped.length
    })
);
