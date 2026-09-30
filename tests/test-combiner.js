#!/usr/bin/env node
// Tests for js/pattern-editor/tools/combiner.js (ES module; Node ≥ 22.7 detects the syntax).
// Focus: the 'add' (add-and-saturate) mode added for stacking color-panel patterns (LAB-228).
import { combinePatterns } from '../js/pattern-editor/tools/combiner.js';

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
    } else {
        failed++;
        console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
}
const mk = (gsMode, frames) => ({
    generation: 'G6',
    gsMode,
    numFrames: frames.length,
    pixelRows: 2,
    pixelCols: 4,
    frames: frames.map((f) => Uint8Array.from(f))
});

console.log('combine: add (saturate)');
{
    const a = mk(16, [[15, 0, 15, 0, 0, 0, 0, 0]]);
    const b = mk(16, [[0, 15, 0, 15, 0, 0, 9, 9]]);
    const out = combinePatterns(a, b, 'add');
    check(
        'disjoint lattices stack at full level (no halving)',
        Array.from(out.frames[0]).join() === '15,15,15,15,0,0,9,9'
    );
    const c = mk(16, [[10, 15, 3, 0, 0, 0, 0, 0]]);
    const d = mk(16, [[10, 15, 3, 0, 0, 0, 0, 0]]);
    check(
        'overlap saturates at 15 (GS16)',
        Array.from(combinePatterns(c, d, 'add').frames[0])
            .slice(0, 3)
            .join() === '15,15,6'
    );
    const e = mk(2, [[1, 0, 1, 0, 0, 0, 0, 0]]);
    const f = mk(2, [[1, 1, 0, 0, 0, 0, 0, 0]]);
    check(
        'GS2 saturates at 1',
        Array.from(combinePatterns(e, f, 'add').frames[0])
            .slice(0, 4)
            .join() === '1,1,1,0'
    );
    const blend = combinePatterns(a, b, 'blend');
    check(
        'blend still halves (unchanged behaviour)',
        Array.from(blend.frames[0]).slice(0, 2).join() === '8,8'
    );
    const multi = combinePatterns(
        mk(16, [
            [1, 0, 0, 0, 0, 0, 0, 0],
            [2, 0, 0, 0, 0, 0, 0, 0]
        ]),
        mk(16, [[4, 0, 0, 0, 0, 0, 0, 0]]),
        'add'
    );
    check(
        'shorter pattern wraps across frames',
        multi.numFrames === 2 && multi.frames[0][0] === 5 && multi.frames[1][0] === 6
    );
    check(
        'result keeps A metadata, filename cleared',
        out.gsMode === 16 && out.pixelCols === 4 && out.filename === null
    );
    let threw = false;
    try {
        combinePatterns(a, mk(2, [[0, 0, 0, 0, 0, 0, 0, 0]]), 'add');
    } catch (_) {
        threw = true;
    }
    check('mismatched grayscale modes throw', threw);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
