#!/usr/bin/env node
/**
 * Tests for js/studio-github.js — the "Save as Pull Request" request builder.
 * No network: asserts the {method,url,headers,body} descriptors, base64 body,
 * create-vs-update sha, branch namespacing, path allowlist, and that the token
 * lives only in the Authorization header (never in a URL).
 *
 * Run: node tests/test-studio-github.js   (wired into `pixi run test`)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const G = require('../js/studio-github.js');
const studioHtml = fs.readFileSync(path.join(__dirname, '..', 'arena_studio.html'), 'utf8');

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

const TOKEN = 'github_pat_SECRET123';
const O = 'reiserlab';
const R = 'webDisplayTools';

// ── base64 (UTF-8 safe) ──────────────────────────────────────────────────────
console.log('=== b64 ===');
check('ascii', G.b64('hello'), 'aGVsbG8=');
check('utf8 snowman', G.b64('☃'), '4piD');
check('empty', G.b64(''), '');

// ── binary-safe base64 (b64Bytes) ────────────────────────────────────────────
console.log('=== b64Bytes ===');
check('ascii bytes', G.b64Bytes(new Uint8Array([104, 101, 108, 108, 111])), 'aGVsbG8=');
// High bytes are NOT valid UTF-8 — the text b64() would mangle these.
check('binary high bytes', G.b64Bytes(new Uint8Array([0x00, 0xff, 0x80, 0x7f])), 'AP+Afw==');
check('empty bytes', G.b64Bytes(new Uint8Array(0)), '');
check('ArrayBuffer accepted', G.b64Bytes(new Uint8Array([1, 2, 3]).buffer), 'AQID');
// Subarray view must respect byteOffset (Buffer.from(u8.buffer) would not).
const viewSrc = new Uint8Array([9, 9, 1, 2, 3, 9]);
check('subarray view respects offset', G.b64Bytes(viewSrc.subarray(2, 5)), 'AQID');
// .pat-style header magic G6PT + a GS16 byte round-trips exactly.
check(
    'pat header bytes',
    Buffer.from(G.b64Bytes(new Uint8Array([0x47, 0x36, 0x50, 0x54, 0xab])), 'base64').join(','),
    '71,54,80,84,171'
);

// ── bytesEqual (promote overwrite guard) ─────────────────────────────────────
console.log('=== bytesEqual ===');
check('equal', G.bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
check('differs', G.bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
check('length differs', G.bytesEqual(new Uint8Array([1]), new Uint8Array([1, 0])), false);
check('empty equal', G.bytesEqual(new Uint8Array(0), new Uint8Array(0)), true);

// ── path allowlist ───────────────────────────────────────────────────────────
console.log('=== isAllowedPath ===');
check('protocols ok', G.isAllowedPath('protocols/looming_v3.yaml'), true);
check('metadata ok', G.isAllowedPath('configs/metadata/people.yaml'), true);
check('runlogs ok', G.isAllowedPath('runlogs/bench03/x__y__z__id.jsonl'), true);
check('rig subdir ok', G.isAllowedPath('protocols/bench03/looming.yaml'), true);
check('patterns subdir ok', G.isAllowedPath('protocols/bench03/loom_patterns/a.pat'), true);
check('shared pattern library ok', G.isAllowedPath('patterns/G6_2x10_dark_bar_8pix_GS2.pat'), true);
check('rejects other dir', G.isAllowedPath('js/evil.js'), false);
check('rejects traversal', G.isAllowedPath('protocols/../js/evil.js'), false);
check('rejects patterns traversal', G.isAllowedPath('patterns/../js/evil.js'), false);
check('rejects abs', G.isAllowedPath('/etc/passwd'), false);
check('rejects backslash', G.isAllowedPath('protocols\\x.yaml'), false);
check('roster NOT writable', G.isAllowedPath('roster.yaml'), false);

console.log('=== isAllowedReadPath ===');
check('roster readable', G.isAllowedReadPath('roster.yaml'), true);
check('genotypes readable', G.isAllowedReadPath('genotypes.yaml'), true);
check('writable paths readable', G.isAllowedReadPath('protocols/shared/x.yaml'), true);
check('runlogs readable', G.isAllowedReadPath('runlogs/bench03/x.jsonl'), true);
check('bare patterns dir listable', G.isAllowedReadPath('patterns'), true);
check('bare protocols dir listable', G.isAllowedReadPath('protocols'), true);
check('bare runlogs dir listable', G.isAllowedReadPath('runlogs'), true);
check('bare patterns NOT writable', G.isAllowedPath('patterns'), false);
check('other dir still blocked', G.isAllowedReadPath('js/evil.js'), false);
check('nested roster blocked', G.isAllowedReadPath('secrets/roster.yaml'), false);
check('genotypes NOT writable', G.isAllowedPath('genotypes.yaml'), false);
check('traversal blocked', G.isAllowedReadPath('roster.yaml/../js/evil.js'), false);
// Every root vocab file Studio.refreshCourseMeta() reads must be readable (a miss
// throws inside its try/catch and the course override silently falls back).
for (const f of ['ages.yaml', 'sexes.yaml', 'fly_numbers.yaml']) {
    check(f + ' readable', G.isAllowedReadPath(f), true);
    check(f + ' NOT writable', G.isAllowedPath(f), false);
}
check(
    'pattern-sets snapshot writable',
    G.isAllowedPath('pattern-sets/0123abcd/patterns.zip'),
    true
);
check(
    'pattern-sets snapshot readable (dedup)',
    G.isAllowedReadPath('pattern-sets/0123abcd/patterns.zip'),
    true
);
check('bare pattern-sets dir listable', G.isAllowedReadPath('pattern-sets'), true);

// ── branch naming ────────────────────────────────────────────────────────────
console.log('=== branchName ===');
check('namespaced + slugged', G.branchName('Looming v3!', 'ab12cd'), 'studio/looming-v3-ab12cd');
check('empty name → protocol', G.branchName('', 'x'), 'studio/protocol-x');

// ── headers ──────────────────────────────────────────────────────────────────
console.log('=== headers ===');
const h = G.headers(TOKEN);
check('bearer token', h.Authorization, 'Bearer ' + TOKEN);
check('api version', h['X-GitHub-Api-Version'], '2022-11-28');
check('accept', h.Accept, 'application/vnd.github+json');

// ── Arena Studio authentication + public-read wiring ───────────────────────
console.log('=== Arena Studio auth wiring ===');
const signInStart = studioHtml.indexOf("$('ghSignInBtn').addEventListener");
const signInEnd = studioHtml.indexOf('// Sign out', signInStart);
const signInBody = studioHtml.slice(signInStart, signInEnd);
const lockStart = studioHtml.indexOf('const lockTargets = () =>');
const lockEnd = studioHtml.indexOf('function applyGhLock', lockStart);
const lockBody = studioHtml.slice(lockStart, lockEnd);
const openCourseStart = studioHtml.indexOf("$('fmOpenCourse').addEventListener");
const openCourseEnd = studioHtml.indexOf('async function openFromCourseRepo', openCourseStart);
const openCourseBody = studioHtml.slice(openCourseStart, openCourseEnd);
checkBool('Sign in handler is present', signInStart >= 0 && signInEnd > signInStart);
checkBool(
    'locked safe mode keeps Sign in clickable',
    lockStart >= 0 && !lockBody.includes("$('ghSignInBtn')")
);
checkBool('advanced archive option is included in kiosk lock', lockBody.includes('archive'));
checkBool(
    'Sign in shows a checking state',
    signInBody.includes("signInBtn.textContent = 'Checking…'") &&
        signInBody.includes("signInBtn.setAttribute('aria-busy', 'true')")
);
checkBool(
    'Sign in verifies access to the configured course repo',
    signInBody.includes('GH.reqGetRepo(cs.repo.owner, cs.repo.name, token)')
);
checkBool(
    'repo access is verified before a token is stored',
    signInBody.indexOf('GH.reqGetRepo(cs.repo.owner, cs.repo.name, token)') <
        signInBody.indexOf("sessionStorage.setItem('studio_gh_pat'")
);
checkBool(
    'choosing session-only Sign in removes an older remembered token',
    signInBody.includes("localStorage.removeItem('studio_gh_pat')")
);
checkBool(
    'a stale Sign in response cannot replace a newer auth state',
    signInBody.includes('const authGeneration = ++ghAuthGeneration') &&
        (signInBody.match(/authGeneration !== ghAuthGeneration/g) || []).length >= 3
);
checkBool(
    'Sign in always restores its busy state',
    signInBody.includes('finally {') &&
        signInBody.includes("signInBtn.removeAttribute('aria-busy')") &&
        signInBody.includes('signInBtn.disabled = false')
);
checkBool(
    'public Open from Repo does not require a token',
    openCourseStart >= 0 && !openCourseBody.includes("if (!token) { Studio.showBanner('Sign in")
);
checkBool(
    'repo-listing failures are surfaced instead of rendered as empty data',
    openCourseBody.includes('Course repo could not be read:') &&
        openCourseBody.includes('GH.reqGetRepo(cs.repo.owner, cs.repo.name, token)')
);
checkBool(
    'file launch gets an explicit localhost guard',
    studioHtml.includes("location.protocol === 'file:'") && studioHtml.includes('pixi run serve')
);
checkBool(
    'production picker is exposed to Alt replay',
    studioHtml.includes('Studio.showPicker = showPicker')
);
const saveStart = studioHtml.indexOf('Studio.saveCurrent = function ()');
const saveEnd = studioHtml.indexOf("$('fmSave').addEventListener", saveStart);
const saveAsStart = studioHtml.indexOf("$('fmSaveAs').addEventListener");
const saveAsEnd = studioHtml.indexOf("$('ghSignInBtn').addEventListener", saveAsStart);
const promoteStart = studioHtml.indexOf("$('fmPromote').addEventListener");
const promoteEnd = studioHtml.indexOf('// ---- URL state', promoteStart);
checkBool(
    'Safe mode blocks protocol save writes',
    studioHtml.slice(saveStart, saveEnd).includes('if (!Studio.advanced)')
);
checkBool(
    'Safe mode blocks Save As before filename mutation',
    studioHtml.slice(saveAsStart, saveAsEnd).includes('if (!Studio.advanced)') &&
        studioHtml.slice(saveAsStart, saveAsEnd).indexOf('if (!Studio.advanced)') <
            studioHtml.slice(saveAsStart, saveAsEnd).indexOf('doc.filename =')
);
checkBool(
    'Safe mode blocks protocol promotion writes',
    studioHtml.slice(promoteStart, promoteEnd).includes('if (!Studio.advanced)')
);
const initStart = studioHtml.indexOf('async function initFromUrl()');
const initEnd = studioHtml.indexOf('// ?rig=', initStart);
checkBool(
    'public repo protocol links can open anonymously',
    !studioHtml.slice(initStart, initEnd).includes('if (!token) {')
);
checkBool(
    'stored sessions re-check configured repo access',
    studioHtml.includes('GH.reqGetRepo(cs.repo.owner, cs.repo.name, storedToken)') &&
        studioHtml.includes('The stored GitHub token cannot access ')
);
const restoreStart = studioHtml.indexOf('// Restore an existing session token on load.');
const restoreEnd = studioHtml.indexOf(
    'updateSaveLabel(); // reflect stored course settings',
    restoreStart
);
const restoreBody = studioHtml.slice(restoreStart, restoreEnd);
checkBool(
    'stored-token restore cannot overwrite a newer auth attempt',
    restoreBody.includes('const restoreGeneration = ghAuthGeneration') &&
        restoreBody.includes(
            'restoreGeneration === ghAuthGeneration && ghToken() === storedToken'
        ) &&
        (restoreBody.match(/restoreCurrent\(\)/g) || []).length >= 4
);
checkBool(
    'transient repo verification failures preserve the stored token',
    restoreBody.includes('access.status === 401 || access.status === 404') &&
        restoreBody.includes('The stored token was kept; retry or sign in again.')
);
checkBool(
    'lazy repo pattern fetches resolve the current token instead of retaining one',
    (studioHtml.match(/const currentToken = ghToken\(\);/g) || []).length >= 2
);

// ── request builders ─────────────────────────────────────────────────────────
console.log('=== reqGetRepo ===');
let req = G.reqGetRepo(O, R, TOKEN);
check('method', req.method, 'GET');
check('url', req.url, 'https://api.github.com/repos/reiserlab/webDisplayTools');
checkBool('token not in url', !req.url.includes(TOKEN), req.url);
checkBool('token in header', req.headers.Authorization.includes(TOKEN), 'auth');

console.log('=== reqGetRef ===');
req = G.reqGetRef(O, R, 'main', TOKEN);
check(
    'ref url',
    req.url,
    'https://api.github.com/repos/reiserlab/webDisplayTools/git/ref/heads/main'
);

console.log('=== reqCreateRef ===');
req = G.reqCreateRef(O, R, 'studio/looming-x', 'BASESHA', TOKEN);
check('create ref method', req.method, 'POST');
check('create ref body', req.body, { ref: 'refs/heads/studio/looming-x', sha: 'BASESHA' });

console.log('=== reqPutContents (create) ===');
req = G.reqPutContents(
    O,
    R,
    'protocols/looming_v3.yaml',
    {
        message: 'add looming_v3',
        contentText: 'version: 3\n',
        branch: 'studio/looming-x'
    },
    TOKEN
);
check('put method', req.method, 'PUT');
check(
    'put url',
    req.url,
    'https://api.github.com/repos/reiserlab/webDisplayTools/contents/protocols/looming_v3.yaml'
);
check('create omits sha', req.body.sha, undefined);
check('content is base64', req.body.content, G.b64('version: 3\n'));
check('branch in body', req.body.branch, 'studio/looming-x');

console.log('=== reqPutContents (update includes sha) ===');
req = G.reqPutContents(
    O,
    R,
    'configs/metadata/people.yaml',
    {
        message: 'add person',
        contentText: 'people: []\n',
        branch: 'studio/x',
        sha: 'EXISTINGBLOB'
    },
    TOKEN
);
check('update includes sha', req.body.sha, 'EXISTINGBLOB');

console.log('=== reqPutContents rejects disallowed path ===');
let threw = false;
try {
    G.reqPutContents(O, R, 'js/evil.js', { message: 'x', contentText: 'y', branch: 'b' }, TOKEN);
} catch (e) {
    threw = true;
}
checkBool('throws on disallowed path', threw, 'js/evil.js');
threw = false;
try {
    G.reqPutContents(O, R, 'roster.yaml', { message: 'x', contentText: 'y', branch: 'b' }, TOKEN);
} catch (e) {
    threw = true;
}
checkBool('roster.yaml is read-only (PUT throws)', threw, 'roster.yaml');

console.log('=== reqPutContents (binary contentBytes) ===');
req = G.reqPutContents(
    O,
    R,
    'protocols/bench03/loom_patterns/loom.pat',
    {
        message: 'push pattern',
        contentBytes: new Uint8Array([0x47, 0x36, 0x50, 0x54, 0xff]),
        branch: 'main'
    },
    TOKEN
);
check(
    'bytes win over text',
    req.body.content,
    G.b64Bytes(new Uint8Array([0x47, 0x36, 0x50, 0x54, 0xff]))
);

console.log('=== reqGetContentsRaw ===');
req = G.reqGetContentsRaw(O, R, 'protocols/shared/loom_patterns/loom.pat', 'main', TOKEN);
check('raw accept header', req.headers.Accept, 'application/vnd.github.raw');
check(
    'raw url',
    req.url,
    'https://api.github.com/repos/reiserlab/webDisplayTools/contents/protocols/shared/loom_patterns/loom.pat?ref=main'
);
req = G.reqGetContents(O, R, 'patterns', null, null);
check(
    'anonymous public read omits auth',
    Object.prototype.hasOwnProperty.call(req.headers, 'Authorization'),
    false
);
check('anonymous public read keeps accept', req.headers.Accept, 'application/vnd.github+json');
req = G.reqGetContentsRaw(O, R, 'runlogs/rig1/example.jsonl', null, null);
check(
    'anonymous raw public read omits auth',
    Object.prototype.hasOwnProperty.call(req.headers, 'Authorization'),
    false
);
req = G.reqGetContentsRaw(O, R, 'roster.yaml', null, TOKEN);
check(
    'roster raw readable',
    req.url,
    'https://api.github.com/repos/reiserlab/webDisplayTools/contents/roster.yaml'
);
threw = false;
try {
    G.reqGetContentsRaw(O, R, 'js/evil.js', null, TOKEN);
} catch (e) {
    threw = true;
}
checkBool('raw read rejects disallowed path', threw, 'js/evil.js');

console.log('=== reqCreatePull ===');
req = G.reqCreatePull(
    O,
    R,
    { title: 'Add looming', head: 'studio/x', base: 'main', body: 'via Studio' },
    TOKEN
);
check('pull method', req.method, 'POST');
check('pull url', req.url, 'https://api.github.com/repos/reiserlab/webDisplayTools/pulls');
check('pull body', req.body, {
    title: 'Add looming',
    head: 'studio/x',
    base: 'main',
    body: 'via Studio'
});

// ── token never leaks into any URL ───────────────────────────────────────────
console.log('=== token containment ===');
const allReqs = [
    G.reqGetRepo(O, R, TOKEN),
    G.reqGetRef(O, R, 'main', TOKEN),
    G.reqCreateRef(O, R, 'b', 's', TOKEN),
    G.reqGetContents(O, R, 'protocols/x.yaml', 'b', TOKEN),
    G.reqPutContents(
        O,
        R,
        'protocols/x.yaml',
        { message: 'm', contentText: 't', branch: 'b' },
        TOKEN
    ),
    G.reqCreatePull(O, R, { title: 't', head: 'h', base: 'main' }, TOKEN)
];
checkBool(
    'no token in any url',
    allReqs.every((q) => !q.url.includes(TOKEN)),
    'urls clean'
);
checkBool(
    'no token in any body',
    allReqs.every((q) => JSON.stringify(q.body || {}).indexOf(TOKEN) === -1),
    'bodies clean'
);

// ── run() executor with an injected fetch ────────────────────────────────────
console.log('=== run (injected fetch) ===');
(async () => {
    let seenUrl = null;
    let seenAuth = null;
    const fakeFetch = async (url, init) => {
        seenUrl = url;
        seenAuth = init.headers.Authorization;
        return { ok: true, status: 200, json: async () => ({ default_branch: 'main' }) };
    };
    const res = await G.run(fakeFetch, G.reqGetRepo(O, R, TOKEN));
    check('run returns data', res.data.default_branch, 'main');
    check('run ok+status', [res.ok, res.status], [true, 200]);
    checkBool('run passed auth header', seenAuth === 'Bearer ' + TOKEN, seenAuth);
    checkBool('run hit repo url', seenUrl.endsWith('/repos/reiserlab/webDisplayTools'), seenUrl);

    console.log('=== runBytes (raw executor) ===');
    const rawFetch = async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([0x47, 0x36, 0x50, 0x54]).buffer
    });
    const rb = await G.runBytes(rawFetch, G.reqGetContentsRaw(O, R, 'roster.yaml', null, TOKEN));
    check('runBytes ok', rb.ok, true);
    check('runBytes bytes', Array.from(rb.bytes), [0x47, 0x36, 0x50, 0x54]);

    // ── directCommit orchestration (course-data write mode) ──────────────────
    console.log('=== directCommit ===');
    function fakeApi(routes) {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({
                url,
                method: init.method,
                body: init.body ? JSON.parse(init.body) : null
            });
            for (const [match, resp] of routes) {
                if (url.includes(match) && (resp.method || 'GET') === init.method) {
                    return {
                        ok: resp.status < 400,
                        status: resp.status,
                        json: async () => resp.data
                    };
                }
            }
            return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
        };
        return { calls, fetchImpl };
    }

    // create: file 404s → PUT without sha, on the default branch.
    let api = fakeApi([
        [
            '/repos/course/data/contents/',
            { method: 'PUT', status: 201, data: { content: { sha: 'NEW' } } }
        ],
        ['/repos/course/data', { status: 200, data: { default_branch: 'trunk' } }]
    ]);
    let dc = await G.directCommit(api.fetchImpl, {
        owner: 'course',
        repo: 'data',
        token: TOKEN,
        path: 'runlogs/bench03/loom__mr__2026-07-03T14-00-00__ab12cd34.jsonl',
        message: 'run log',
        contentText: '{"a":1}\n'
    });
    check('create ok', [dc.ok, dc.updated, dc.branch], [true, false, 'trunk']);
    const putCall = api.calls.find((c) => c.method === 'PUT');
    check('create PUT omits sha', putCall.body.sha, undefined);
    check('create PUT targets default branch', putCall.body.branch, 'trunk');
    checkBool(
        'create GET-for-sha used default branch ref',
        api.calls.some((c) => c.method === 'GET' && c.url.includes('?ref=trunk')),
        api.calls.map((c) => c.url).join(' | ')
    );

    // update: existing blob sha flows into the PUT.
    api = fakeApi([
        ['?ref=main', { status: 200, data: { sha: 'OLDBLOB' } }],
        [
            '/repos/course/data/contents/',
            { method: 'PUT', status: 200, data: { content: { sha: 'NEW2' } } }
        ],
        ['/repos/course/data', { status: 200, data: { default_branch: 'main' } }]
    ]);
    dc = await G.directCommit(api.fetchImpl, {
        owner: 'course',
        repo: 'data',
        token: TOKEN,
        path: 'protocols/bench03/looming.yaml',
        message: 'save',
        contentText: 'version: 3\n'
    });
    check('update ok+updated', [dc.ok, dc.updated], [true, true]);
    check('update PUT carries sha', api.calls.find((c) => c.method === 'PUT').body.sha, 'OLDBLOB');

    // binary payload: contentBytes → b64Bytes in the PUT body.
    api = fakeApi([
        ['/repos/course/data/contents/', { method: 'PUT', status: 201, data: {} }],
        ['/repos/course/data', { status: 200, data: { default_branch: 'main' } }]
    ]);
    dc = await G.directCommit(api.fetchImpl, {
        owner: 'course',
        repo: 'data',
        token: TOKEN,
        path: 'protocols/bench03/loom_patterns/loom.pat',
        message: 'push pattern',
        contentBytes: new Uint8Array([0x00, 0xff, 0x80])
    });
    check('binary direct commit ok', dc.ok, true);
    check(
        'binary body is b64Bytes',
        api.calls.find((c) => c.method === 'PUT').body.content,
        G.b64Bytes(new Uint8Array([0x00, 0xff, 0x80]))
    );

    // repo read failure surfaces step + message, and nothing is written.
    api = fakeApi([['/repos/course/data', { status: 401, data: { message: 'Bad credentials' } }]]);
    dc = await G.directCommit(api.fetchImpl, {
        owner: 'course',
        repo: 'data',
        token: TOKEN,
        path: 'protocols/bench03/x.yaml',
        message: 'x',
        contentText: 'y'
    });
    check('repo failure', [dc.ok, dc.step, dc.error], [false, 'repo', 'Bad credentials']);
    checkBool('no PUT after repo failure', !api.calls.some((c) => c.method === 'PUT'), 'clean');

    // non-404 GET failure blocks the PUT (a blind create would 422 confusingly).
    api = fakeApi([
        ['?ref=main', { status: 403, data: { message: 'rate limited' } }],
        ['/repos/course/data', { status: 200, data: { default_branch: 'main' } }]
    ]);
    dc = await G.directCommit(api.fetchImpl, {
        owner: 'course',
        repo: 'data',
        token: TOKEN,
        path: 'protocols/bench03/x.yaml',
        message: 'x',
        contentText: 'y'
    });
    check('non-404 GET blocks', [dc.ok, dc.step], [false, 'get']);
    checkBool('no PUT after GET failure', !api.calls.some((c) => c.method === 'PUT'), 'clean');

    // ── gzipBytes / isGzip (run logs commit as .jsonl.gz) ───────────────────
    console.log('=== gzipBytes / isGzip ===');
    {
        const zlib = require('zlib');
        const text =
            '{"type":"session"}\n' + '[5,9052,39,0.0,1.42578,-3.19222,1.21378]\n'.repeat(200);
        const gz = await G.gzipBytes(text);
        checkBool('returns Uint8Array', gz instanceof Uint8Array, typeof gz);
        check('gzip magic', G.isGzip(gz), true);
        check(
            'inflates to the original text',
            zlib.gunzipSync(Buffer.from(gz)).toString('utf8'),
            text
        );
        checkBool(
            'smaller than the input',
            gz.length < text.length / 4,
            gz.length + ' vs ' + text.length
        );
        const gz2 = await G.gzipBytes(new TextEncoder().encode('héllo ☃'));
        check(
            'Uint8Array input, UTF-8 preserved',
            zlib.gunzipSync(Buffer.from(gz2)).toString('utf8'),
            'héllo ☃'
        );
        check('isGzip on plain text false', G.isGzip(new TextEncoder().encode('{"a":1}')), false);
        check('isGzip on empty false', G.isGzip(new Uint8Array(0)), false);
    }

    // ── Git Database API request builders ───────────────────────────────────
    console.log('=== git-db request builders ===');
    {
        const blob = G.reqCreateBlob(O, R, new Uint8Array([0x1f, 0x8b, 0x00, 0xff]), TOKEN);
        check(
            'blob POST url',
            [blob.method, blob.url],
            ['POST', 'https://api.github.com/repos/reiserlab/webDisplayTools/git/blobs']
        );
        check('blob body base64 + encoding', blob.body, {
            content: 'H4sA/w==',
            encoding: 'base64'
        });
        check('blob auth header', blob.headers.Authorization, 'Bearer ' + TOKEN);
        const gc = G.reqGetCommit(O, R, 'abc123', TOKEN);
        check(
            'get commit',
            [gc.method, gc.url],
            ['GET', 'https://api.github.com/repos/reiserlab/webDisplayTools/git/commits/abc123']
        );
        const tree = G.reqCreateTree(
            O,
            R,
            'treeBase',
            'runlogs/bench03/run.jsonl.gz',
            'blobSha',
            TOKEN
        );
        check(
            'tree POST url',
            tree.url,
            'https://api.github.com/repos/reiserlab/webDisplayTools/git/trees'
        );
        check('tree body: base_tree + ONE blob entry', tree.body, {
            base_tree: 'treeBase',
            tree: [
                {
                    path: 'runlogs/bench03/run.jsonl.gz',
                    mode: '100644',
                    type: 'blob',
                    sha: 'blobSha'
                }
            ]
        });
        let threw = null;
        try {
            G.reqCreateTree(O, R, 't', '.github/workflows/x.yml', 'b', TOKEN);
        } catch (e) {
            threw = e.message;
        }
        checkBool(
            'tree refuses a path outside WRITABLE_PREFIXES',
            /disallowed path/.test(threw || ''),
            threw
        );
        const cm = G.reqCreateCommit(
            O,
            R,
            { message: 'runlog: x', treeSha: 'T', parentSha: 'P' },
            TOKEN
        );
        check('commit body', cm.body, { message: 'runlog: x', tree: 'T', parents: ['P'] });
        const ref = G.reqUpdateRef(O, R, 'main', 'NEW', TOKEN);
        check(
            'ref PATCH (fast-forward only)',
            [ref.method, ref.url, ref.body],
            [
                'PATCH',
                'https://api.github.com/repos/reiserlab/webDisplayTools/git/refs/heads/main',
                { sha: 'NEW', force: false }
            ]
        );
        for (const r of [blob, gc, tree, cm, ref])
            checkBool(
                'token never in URL (' + r.method + ' ' + r.url.split('/git/')[1] + ')',
                !r.url.includes(TOKEN),
                r.url
            );
    }

    // ── directCommitLarge + commitFile routing ──────────────────────────────
    console.log('=== directCommitLarge / commitFile ===');
    {
        const mkApi = (opts) => {
            opts = opts || {};
            const calls = [];
            const fetchImpl = async (url, init) => {
                calls.push({
                    method: init.method,
                    url,
                    body: init.body ? JSON.parse(init.body) : null
                });
                const j = (status, data) => ({ ok: status < 300, status, json: async () => data });
                if (init.method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url))
                    return j(200, { default_branch: 'main' });
                if (init.method === 'GET' && /\/git\/ref\/heads\/main$/.test(url))
                    return j(200, { object: { sha: 'HEAD1' } });
                if (init.method === 'GET' && /\/git\/commits\/HEAD1$/.test(url))
                    return j(200, { sha: 'HEAD1', tree: { sha: 'ROOT1' } });
                if (init.method === 'POST' && /\/git\/blobs$/.test(url))
                    return opts.blobFail
                        ? j(422, { message: 'blob too big' })
                        : j(201, { sha: 'BLOB1' });
                if (init.method === 'POST' && /\/git\/trees$/.test(url))
                    return j(201, { sha: 'TREE1' });
                if (init.method === 'POST' && /\/git\/commits$/.test(url))
                    return j(201, { sha: 'COMMIT1' });
                if (init.method === 'PATCH' && /\/git\/refs\/heads\/main$/.test(url))
                    return j(200, { object: { sha: 'COMMIT1' } });
                // Contents API path (small files)
                if (init.method === 'GET' && /\/contents\//.test(url))
                    return j(404, { message: 'Not Found' });
                if (init.method === 'PUT' && /\/contents\//.test(url))
                    return j(201, { content: { path: 'x' } });
                return j(500, { message: 'unexpected ' + init.method + ' ' + url });
            };
            return { calls, fetchImpl };
        };
        const bytes = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
        let api = mkApi();
        let res = await G.directCommitLarge(api.fetchImpl, {
            owner: O,
            repo: R,
            token: TOKEN,
            path: 'runlogs/bench03/big.jsonl.gz',
            message: 'runlog: big',
            contentBytes: bytes
        });
        check(
            'large: ok via git-db with the new commit sha',
            [res.ok, res.via, res.branch, res.sha],
            [true, 'git-db', 'main', 'COMMIT1']
        );
        check(
            'large: 7-call sequence repo→ref→commit→blob→tree→commit→ref',
            api.calls.map((c) => c.method + ' ' + c.url.replace(/^.*\/repos\/[^/]+\/[^/]+/, '')),
            [
                'GET ',
                'GET /git/ref/heads/main',
                'GET /git/commits/HEAD1',
                'POST /git/blobs',
                'POST /git/trees',
                'POST /git/commits',
                'PATCH /git/refs/heads/main'
            ]
        );
        check('large: tree built on the head root tree with the blob', api.calls[4].body, {
            base_tree: 'ROOT1',
            tree: [
                { path: 'runlogs/bench03/big.jsonl.gz', mode: '100644', type: 'blob', sha: 'BLOB1' }
            ]
        });
        check('large: commit parents = head', api.calls[5].body.parents, ['HEAD1']);
        check('large: ref moved to the new commit, no force', api.calls[6].body, {
            sha: 'COMMIT1',
            force: false
        });
        checkBool(
            'large: token only in headers',
            api.calls.every((c) => !c.url.includes(TOKEN)),
            'urls clean'
        );
        api = mkApi({ blobFail: true });
        res = await G.directCommitLarge(api.fetchImpl, {
            owner: O,
            repo: R,
            token: TOKEN,
            path: 'runlogs/b/x.jsonl.gz',
            message: 'm',
            contentBytes: bytes
        });
        check(
            'large: blob failure reported with step + status + message',
            [res.ok, res.step, res.status, res.error],
            [false, 'blob', 422, 'blob too big']
        );
        check('large: stops after the failing call', api.calls.length, 4);

        // commitFile routes by size: small → Contents API, big → git-db.
        api = mkApi();
        res = await G.commitFile(api.fetchImpl, {
            owner: O,
            repo: R,
            token: TOKEN,
            path: 'runlogs/b/small.jsonl.gz',
            message: 'm',
            contentBytes: bytes
        });
        check(
            'commitFile small → contents path',
            [res.ok, res.via, res.bytes],
            [true, 'contents', 5]
        );
        check(
            'commitFile small → GET contents + PUT',
            api.calls.slice(1).map((c) => c.method),
            ['GET', 'PUT']
        );
        api = mkApi();
        res = await G.commitFile(api.fetchImpl, {
            owner: O,
            repo: R,
            token: TOKEN,
            path: 'runlogs/b/big.jsonl.gz',
            message: 'm',
            contentBytes: bytes,
            thresholdBytes: 4
        });
        check(
            'commitFile over threshold → git-db path',
            [res.ok, res.via, res.bytes],
            [true, 'git-db', 5]
        );
        check(
            'commitFile over threshold → blob posted',
            api.calls.some((c) => /\/git\/blobs$/.test(c.url)),
            true
        );
        api = mkApi();
        res = await G.commitFile(api.fetchImpl, {
            owner: O,
            repo: R,
            token: TOKEN,
            path: 'runlogs/b/t.jsonl',
            message: 'm',
            contentText: 'héllo'
        });
        check('commitFile contentText → byte length is UTF-8 length', res.bytes, 6);
        check('LARGE_FILE_BYTES is 30 MiB', G.LARGE_FILE_BYTES, 30 * 1024 * 1024);
    }

    // ── the Studio's run-log commit path uses gzip + commitFile ─────────────
    console.log('=== arena_studio.html run-log commit wiring ===');
    {
        const start = studioHtml.indexOf('async function commitRunLog(');
        const end = studioHtml.indexOf('Studio._maybeCommitRunLog = maybeCommitRunLog;', start);
        const body = studioHtml.slice(start, end);
        checkBool(
            'commitRunLog gzips the export',
            /GH\.gzipBytes\(exported\.content\)/.test(body),
            'gzipBytes call'
        );
        checkBool(
            'commitRunLog commits <name>.jsonl.gz',
            /basePath \+ '\.gz'/.test(body),
            '.gz path'
        );
        checkBool(
            'commitRunLog routes through GH.commitFile (size-based path choice)',
            /GH\.commitFile\(fetch,/.test(body),
            'commitFile call'
        );
        checkBool(
            'commitRunLog no longer calls directCommit directly',
            !/GH\.directCommit\(fetch/.test(body),
            'directCommit absent'
        );
        checkBool(
            'commitRunLog falls back to raw .jsonl when gzip is unavailable',
            /contentText: exported\.content/.test(body),
            'fallback'
        );
        checkBool(
            'fmLogLevel offers behavior_v2 as the default option',
            /<option value="behavior_v2">behavior_v2 \(compact — default\)<\/option>/.test(
                studioHtml
            ),
            'option'
        );
        checkBool(
            'run_metadata carries log_format',
            /event: 'run_metadata', rig_id: Studio\.rigId \|\| null, log_format: logLevel/.test(
                studioHtml
            ),
            'log_format'
        );
    }

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures ? 1 : 0);
})();
