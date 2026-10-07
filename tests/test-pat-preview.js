#!/usr/bin/env node
/**
 * Tests for js/pat-preview.js (LAB-95/96) — browser-free.
 *
 * pat-preview is pure orchestration: it samples evenly-spaced frame indices and calls
 * an INJECTED per-frame renderer (the browser passes icon-generator's
 * generatePatternIcon). Here we inject a string stub so the sampling logic, the
 * frameIndex pass-through, iconOpts merging, the staticIndex (middle frame), and the
 * skip-on-throw path are all exercised without a DOM. The DOM flat fallback is
 * browser-verified; in Node renderFlatFrame must return null (no document).
 */

const PP = require('../js/pat-preview.js');

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

/** Build a fake pat-parser output with N frames (pixel data unused by the stub). */
function fakeParsed(n) {
    const frames = [];
    for (let i = 0; i < n; i++) frames.push(new Uint8Array(40 * 200));
    return { frames, pixelRows: 40, pixelCols: 200, gs_val: 2, numFrames: n };
}

// ── 1. pickFrameIndices ─────────────────────────────────────────────────────────
console.log('\n=== pickFrameIndices ===');
check('0 frames → []', PP.pickFrameIndices(0, 10), []);
check('n <= max → all indices', PP.pickFrameIndices(4, 10), [0, 1, 2, 3]);
check('n == max → all indices', PP.pickFrameIndices(10, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
check(
    '200 frames, max 10 → step 20',
    PP.pickFrameIndices(200, 10),
    [0, 20, 40, 60, 80, 100, 120, 140, 160, 180]
);
checkBool('never exceeds max (200,10)', PP.pickFrameIndices(200, 10).length === 10);
checkBool('never exceeds max (15,10)', PP.pickFrameIndices(15, 10).length <= 10);
checkBool('default max applies when omitted', PP.pickFrameIndices(200).length === PP.DEFAULT_MAX);

// ── 2. samplePreviewFrames — sampling, staticIndex, frameIndex pass-through ───────
console.log('\n=== samplePreviewFrames (stub renderIcon) ===');
{
    const seen = [];
    const renderIcon = (parsed, arena, opts) => {
        seen.push(opts.frameIndex);
        return 'icon-' + opts.frameIndex;
    };
    const res = PP.samplePreviewFrames(fakeParsed(5), { generation: 'G6' }, { renderIcon });
    check('5 frames → 5 thumbs', res.frames, ['icon-0', 'icon-1', 'icon-2', 'icon-3', 'icon-4']);
    check('staticIndex = middle (5)', res.staticIndex, 2);
    check('renderIcon got each frameIndex', seen, [0, 1, 2, 3, 4]);
}
{
    const res = PP.samplePreviewFrames(
        fakeParsed(200),
        { generation: 'G6' },
        {
            renderIcon: (p, a, o) => 'f' + o.frameIndex
        }
    );
    checkBool('200 frames capped to 10 thumbs', res.frames.length === 10, res.frames.join(','));
    check('staticIndex = middle (10)', res.staticIndex, 5);
}
{
    // iconOpts merged into each call (width passed through alongside frameIndex)
    let sawWidth = null;
    PP.samplePreviewFrames(
        fakeParsed(3),
        {},
        {
            renderIcon: (p, a, o) => {
                sawWidth = o.width;
                return 'x';
            },
            iconOpts: { width: 96 }
        }
    );
    check('iconOpts.width passed through', sawWidth, 96);
}

// ── 3. skip-on-throw (no flat fallback in Node) ──────────────────────────────────
console.log('\n=== samplePreviewFrames (renderIcon throws) ===');
{
    const res = PP.samplePreviewFrames(
        fakeParsed(4),
        {},
        {
            renderIcon: () => {
                throw new Error('boom');
            },
            flatFallback: false
        }
    );
    check('all throws skipped → []', res.frames, []);
    check('empty staticIndex = 0', res.staticIndex, 0);
}
{
    // flatFallback defaults on, but Node has no document → renderFlatFrame returns null → skipped
    const res = PP.samplePreviewFrames(
        fakeParsed(4),
        {},
        {
            renderIcon: () => {
                throw new Error('boom');
            }
        }
    );
    check('throws + no DOM flat → []', res.frames, []);
}

// ── 4. renderFlatFrame is null in Node ───────────────────────────────────────────
console.log('\n=== renderFlatFrame (Node, no document) ===');
checkBool(
    'returns null without a document',
    PP.renderFlatFrame(new Uint8Array(10), 2, 5, 2, 64) === null
);

// ── 5. liveFetchVerdict: when a thumbnail may download a card-only pattern ────────
// The controller sends only whole files (0x84) and nothing else can use the link
// meanwhile, so: size must be known and ≤ 1 MiB, connected, no run active.
console.log('\n=== liveFetchVerdict ===');
const idle = { connected: true, running: false };
check('LIVE_FETCH_MAX_BYTES is 1 MiB', PP.LIVE_FETCH_MAX_BYTES, 1 << 20);
check(
    '81 KB color grating (bench pattern 1) → ok',
    PP.liveFetchVerdict({ fileSize: 81338 }, idle),
    {
        ok: true,
        reason: null
    }
);
check('exactly the cap → ok', PP.liveFetchVerdict({ fileSize: 1 << 20 }, idle).ok, true);
check('8 MB pattern → too-large', PP.liveFetchVerdict({ fileSize: 8e6 }, idle).reason, 'too-large');
check('size unknown → refused', PP.liveFetchVerdict(null, idle).reason, 'unknown-size');
check('size 0 → refused', PP.liveFetchVerdict({ fileSize: 0 }, idle).reason, 'unknown-size');
check(
    'run active → refused (a run owns the link)',
    PP.liveFetchVerdict({ fileSize: 1000 }, { connected: true, running: true }).reason,
    'running'
);
check(
    'not connected → offline',
    PP.liveFetchVerdict({ fileSize: 1000 }, { connected: false }).reason,
    'offline'
);

console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
