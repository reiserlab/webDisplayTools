/**
 * tests/test-build-channel.js — js/build-channel.js (release tier: Production / Next / local)
 * plus static guards on the pages that use it. Node, no browser: a tiny fake DOM stands in.
 *
 * Run: node tests/test-build-channel.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const BC = require('../js/build-channel.js');
const Meta = require('../js/studio-meta.js');

const ROOT = path.join(__dirname, '..');
let total = 0;
let failures = 0;
function check(name, got, expected) {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
            (ok ? '' : ` — got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
    );
    if (!ok) failures++;
}

// ── a minimal fake document ──────────────────────────────────────────────────
function fakeDoc(metaContent, bannerPresent) {
    const nodes = {};
    const banner = bannerPresent
        ? { id: 'wdt-next-banner', parentNode: { removeChild: () => (nodes.bannerRemoved = true) } }
        : null;
    return {
        nodes,
        querySelector: (sel) =>
            sel === 'meta[name="wdt-build"]' && metaContent != null
                ? { getAttribute: () => metaContent }
                : null,
        getElementById: (id) => (id === 'wdt-next-banner' ? banner : null),
        createElement: () => ({ className: '', textContent: '', title: '' })
    };
}
function fakeHost() {
    const kids = [];
    return {
        kids,
        querySelector: () => kids[0] || null,
        appendChild: (el) => kids.push(el)
    };
}
const PROD = { channel: 'production', sha: 'abc1234def', built_at_et: '2026-09-28 10:28 ET' };
const NEXT = {
    channel: 'next',
    sha: 'fed9876abc',
    candidate: {
        name: '2026-10-02',
        rc: 2,
        label: 'candidate 2026-10-02-rc2',
        prs: [{ number: 219 }, { number: 178 }]
    }
};

console.log('=== detect ===');
check(
    'stamped production',
    BC.detect(fakeDoc(JSON.stringify(PROD)), { pathname: '/webDisplayTools/arena_studio.html' })
        .channel,
    'production'
);
check(
    'stamped → known',
    BC.detect(fakeDoc(JSON.stringify(PROD)), { pathname: '/x.html' }).known,
    true
);
check(
    'stamped next keeps candidate',
    BC.detect(fakeDoc(JSON.stringify(NEXT)), { pathname: '/w/next/a.html' }).candidate.rc,
    2
);
check(
    'unstamped under /next/ → next, NOT local',
    BC.detect(fakeDoc(null), { pathname: '/webDisplayTools/next/arena_studio.html' }),
    {
        channel: 'next',
        known: false,
        sha: null,
        candidate: null
    }
);
check(
    'unstamped elsewhere → local',
    BC.detect(fakeDoc(null), { pathname: '/arena_studio.html' }).channel,
    'local'
);
check(
    'malformed stamp → local',
    BC.detect(fakeDoc('{nope'), { pathname: '/arena_studio.html' }).channel,
    'local'
);
check(
    'unknown channel in stamp ignored',
    BC.detect(fakeDoc('{"channel":"staging"}'), { pathname: '/a.html' }).channel,
    'local'
);
check('"nextgen/" is not the Next tier', BC.inNextPath('/w/nextgen/a.html'), false);

console.log('=== badge / run metadata ===');
check('production badge says beta', BC.badgeModel(PROD).text, 'beta');
check('production title names the build', /abc1234/.test(BC.badgeModel(PROD).title), true);
check('next badge names the candidate', BC.badgeModel(NEXT).text, 'NEXT · 2026-10-02-rc2');
check('next title lists the PRs', /#219 #178/.test(BC.badgeModel(NEXT).title), true);
check('next badge class', BC.badgeModel(NEXT).cls, 'wdt-ch-next');
check('local badge', BC.badgeModel({ channel: 'local' }).text, 'LOCAL');
check('runMeta next', BC.runMeta(NEXT), {
    channel: 'next',
    build: 'fed9876abc',
    candidate: 'candidate 2026-10-02-rc2'
});
check('runMeta local', BC.runMeta({ channel: 'local' }), {
    channel: 'local',
    build: null,
    candidate: null
});
const m = Meta.buildMeta({ runId: 'r', build: NEXT });
check(
    'buildMeta records channel/build/candidate',
    [m.channel, m.build, m.candidate],
    ['next', 'fed9876abc', 'candidate 2026-10-02-rc2']
);
const m0 = Meta.buildMeta({ runId: 'r' });
check('buildMeta without build → nulls', [m0.channel, m0.build, m0.candidate], [null, null, null]);

console.log('=== window names / tier matching ===');
check('production window name unchanged', BC.windowName('arena-studio', PROD), 'arena-studio');
check('next window name suffixed', BC.windowName('arena-studio', NEXT), 'arena-studio@next');
check('same tier: next page in next', BC.samePageTier('/w/next/pattern_editor.html', NEXT), true);
check('other tier: prod page from next', BC.samePageTier('/w/pattern_editor.html', NEXT), false);
check(
    'other tier: next page from prod',
    BC.samePageTier('/w/next/pattern_editor.html', PROD),
    false
);

console.log('=== migration markers (typed, monotonic) ===');
check('int equal → current', BC.markerCurrent('2', '2'), true);
check('int newer (Next wrote 3) → current for Production', BC.markerCurrent('3', '2'), true);
check('int older → migrate', BC.markerCurrent('1', '2'), false);
check('"10" vs "2" compares as numbers', BC.markerCurrent('10', '2'), true);
check('missing → migrate', BC.markerCurrent(null, '2'), false);
check('malformed → migrate', BC.markerCurrent('two', '2'), false);
check('date equal', BC.markerCurrent('2026-07-08', '2026-07-08'), true);
check('date newer', BC.markerCurrent('2026-09-01', '2026-07-08'), true);
check('date older', BC.markerCurrent('2026-01-01', '2026-07-08'), false);
check('date vs int-shaped → migrate', BC.markerCurrent('2', '2026-07-08'), false);

console.log('=== renderBadge ===');
const d1 = fakeDoc(JSON.stringify(NEXT), true);
const h1 = fakeHost();
const el = BC.renderBadge(d1, h1, NEXT);
check(
    'badge inserted',
    [h1.kids.length, el.className, el.textContent],
    [1, 'wdt-channel wdt-ch-next', 'NEXT · 2026-10-02-rc2']
);
check('next removes the injected banner', d1.nodes.bannerRemoved, true);
BC.renderBadge(d1, h1, NEXT);
check('re-render reuses the element', h1.kids.length, 1);
const d2 = fakeDoc(JSON.stringify(NEXT), false);
let deferred = null;
d2.readyState = 'loading';
d2.addEventListener = (ev, fn) => {
    if (ev === 'DOMContentLoaded') deferred = fn;
};
BC.renderBadge(d2, fakeHost(), NEXT);
check(
    'banner parsed after the badge → removal deferred to DOMContentLoaded',
    typeof deferred,
    'function'
);
check('missing host → no throw', BC.renderBadge(fakeDoc(null), null, PROD), null);

console.log('=== checkFresh ===');
const fakeFetch =
    (sha, ok = true) =>
    async () => ({ ok, json: async () => ({ sha }) });
(async () => {
    check(
        'same sha → fresh',
        await BC.checkFresh(fakeFetch('abc1234def'), Object.assign({ known: true }, PROD)),
        { stale: false, servedSha: 'abc1234def' }
    );
    check(
        'different sha → stale',
        (await BC.checkFresh(fakeFetch('9999999'), Object.assign({ known: true }, PROD))).stale,
        true
    );
    check(
        'unknown build → never stale',
        (await BC.checkFresh(fakeFetch('9999999'), { channel: 'local', known: false })).stale,
        false
    );
    check(
        'fetch failure → not stale',
        (
            await BC.checkFresh(
                async () => {
                    throw new Error('x');
                },
                Object.assign({ known: true }, PROD)
            )
        ).stale,
        false
    );
    check(
        '404 → not stale',
        (await BC.checkFresh(fakeFetch('x', false), Object.assign({ known: true }, PROD))).stale,
        false
    );

    console.log('=== static guards on the pages ===');
    const studio = fs.readFileSync(path.join(ROOT, 'arena_studio.html'), 'utf8');
    const pd = fs.readFileSync(path.join(ROOT, 'pattern_editor.html'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const replay = fs.readFileSync(path.join(ROOT, 'js', 'studio-replay.js'), 'utf8');
    const alt = fs.readFileSync(path.join(ROOT, 'js', 'arena-studio-alt.js'), 'utf8');
    const bcAt = studio.indexOf('<script src="js/build-channel.js">');
    check(
        'Studio loads build-channel.js before studio-meta.js',
        bcAt > 0 && bcAt < studio.indexOf('<script src="js/studio-meta.js">'),
        true
    );
    check(
        'Studio loads it before the first marker site',
        bcAt > 0 && bcAt < studio.indexOf("studio_scope_sound_v'"),
        true
    );
    check(
        'no exact-match migration markers left',
        /getItem\('studio_[a-z_]+_v'\)\s*!==/.test(studio),
        false
    );
    check(
        'three typed marker sites',
        (studio.match(/studioMarkerCurrent\(localStorage\.getItem\('studio_[a-z_]+_v'\)/g) || [])
            .length,
        3
    );
    check(
        'run metadata gets the build',
        /toolVersion: Studio\.TOOL_VERSION,\s*build: Studio\.build/.test(studio),
        true
    );
    check(
        'Studio window name is tier-suffixed',
        studio.includes("window.name = tierName('arena-studio')"),
        true
    );
    check(
        'no bare window names left in the Studio',
        /window\.open\([^()]*,\s*'pattern-designer'\s*\)/.test(studio),
        false
    );
    check(
        'Designer window name is tier-suffixed',
        pd.includes("window.name = tierName('pattern-designer')"),
        true
    );
    check(
        'Designer loads build-channel.js',
        pd.includes('<script src="js/build-channel.js">'),
        true
    );
    check('Designer reuse check is tier-aware', pd.includes('sameTier(w.location.pathname)'), true);
    check(
        'Studio reuse check is tier-aware',
        studio.includes('sameTier(w.location.pathname)'),
        true
    );
    check(
        'replay popup tier-suffixed',
        replay.includes("windowName('arena-studio-replay-viewer')"),
        true
    );
    check(
        'Alt replay popup tier-suffixed',
        alt.includes("windowName('arena-studio-alt-replay-viewer')"),
        true
    );
    check(
        'index renders the badge',
        idx.includes('BuildChannel.renderBadge(document') &&
            idx.includes('<script src="js/build-channel.js">'),
        true
    );
    check(
        'Next confirm is in beginRun, not runOnce',
        (() => {
            const b = studio.indexOf('Studio.beginRun = async function');
            const r = studio.indexOf('Studio.runOnce = async function');
            const a = studio.indexOf("sessionStorage.getItem('studio_next_ack')");
            return b > 0 && a > b && a < r;
        })(),
        true
    );
    check(
        'footer untouched by the badge (TOOL_VERSION regex still matches)',
        /Arena Studio v\d+(?:\.\d+)* \| \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET · <a/.test(studio),
        true
    );

    console.log('\n=== Summary ===');
    console.log(`${total - failures} / ${total} checks passed`);
    process.exit(failures ? 1 : 0);
})();
