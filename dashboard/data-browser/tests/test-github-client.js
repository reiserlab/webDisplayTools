'use strict';

const assert = require('assert');

function storage() {
    const values = new Map();
    return {
        getItem: (key) => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key)
    };
}

global.sessionStorage = storage();
global.localStorage = storage();
sessionStorage.setItem('studio_gh_pat', 'github_pat_TEST_SECRET');
localStorage.setItem('studio_gh_repo', 'reiserlab/cshl-2026-course');
localStorage.setItem('studio_bench_id', 'bench02');

const seen = [];
global.fetch = async (url, options) => {
    seen.push({ url, options });
    if (url.endsWith('/user'))
        return new Response(JSON.stringify({ login: 'course-user' }), { status: 200 });
    if (url.includes('/contents/runlogs/bench02/example.jsonl')) {
        return new Response('{"event":"run_metadata","run_id":"abc"}\n[1,2,3]\n', { status: 200 });
    }
    if (url.includes('/contents/runlogs')) {
        return new Response(JSON.stringify([{ type: 'dir', path: 'runlogs/bench02' }]), {
            status: 200
        });
    }
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
};

const G = require('../github-repo.js');

(async () => {
    assert.strictEqual(G.currentToken(), 'github_pat_TEST_SECRET');
    assert.strictEqual(G.currentRepo(), 'reiserlab/cshl-2026-course');
    assert.deepStrictEqual(G.parseRepo('reiserlab/cshl-2026-course'), {
        owner: 'reiserlab',
        name: 'cshl-2026-course',
        full: 'reiserlab/cshl-2026-course'
    });
    assert.throws(() => G.parseRepo('https://github.com/reiserlab/cshl-2026-course'));
    assert.deepStrictEqual(
        G.preferredFolders(G.currentRepo(), ['bench01', 'bench02', 'bench03']),
        ['bench02'],
        'Arena Studio bench should be the initial dashboard rig selection'
    );
    assert.deepStrictEqual(G.saveFolders(G.currentRepo(), ['bench03', 'bench01', 'bench03']), [
        'bench01',
        'bench03'
    ]);
    assert.deepStrictEqual(
        G.preferredFolders(G.currentRepo(), ['bench01', 'bench02', 'bench03']),
        ['bench01', 'bench03'],
        'saved dashboard selection should override the Arena Studio bench default'
    );

    const listing = await G.listPath(G.currentRepo(), 'runlogs', 'main');
    assert.strictEqual(listing[0].path, 'runlogs/bench02');
    const text = await G.fetchText(G.currentRepo(), 'runlogs/bench02/example.jsonl', 'main');
    assert(text.includes('run_metadata'));

    for (const request of seen) {
        assert(!request.url.includes('github_pat_TEST_SECRET'), 'token must never appear in a URL');
        assert.strictEqual(request.options.headers.Authorization, 'Bearer github_pat_TEST_SECRET');
        assert(
            !request.options.body || !request.options.body.includes('github_pat_TEST_SECRET'),
            'token must never appear in a body'
        );
    }
    assert.strictEqual(
        G.repoTreeUrl(G.currentRepo(), 'runlogs', 'main'),
        'https://github.com/reiserlab/cshl-2026-course/tree/main/runlogs'
    );
    console.log(JSON.stringify({ requests: seen.length, tokenOnlyInAuthorizationHeader: true }));
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
