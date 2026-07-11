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

const G = require('../js/studio-github.js');

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
check('bare patterns NOT writable', G.isAllowedPath('patterns'), false);
check('other dir still blocked', G.isAllowedReadPath('js/evil.js'), false);
check('nested roster blocked', G.isAllowedReadPath('secrets/roster.yaml'), false);
check('genotypes NOT writable', G.isAllowedPath('genotypes.yaml'), false);
check('traversal blocked', G.isAllowedReadPath('roster.yaml/../js/evil.js'), false);

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

    console.log('\n=== Summary ===');
    console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
    process.exit(failures ? 1 : 0);
})();
