/**
 * studio-github.js — Arena Studio "Save as Pull Request" request builder.
 *
 * A PURE request-descriptor builder: every function returns a plain
 * {method, url, headers, body} object with NO network I/O, so the whole save
 * pipeline is Node-unit-testable (assert URLs, headers, base64 body, create-vs-
 * update sha, branch namespacing, path allowlist) without hitting the API. A
 * thin `run(fetchImpl, req)` executes one descriptor; the HTML orchestrates the
 * sequence and does the token storage / UI.
 *
 * Client-side flow (api.github.com is CORS-friendly for token auth — no server):
 *   1. GET  /repos/{o}/{r}                      → default_branch
 *   2. GET  /repos/{o}/{r}/git/ref/heads/{b}    → base commit sha
 *   3. POST /repos/{o}/{r}/git/refs             → create studio/<slug>-<runId>
 *   4. GET  /repos/{o}/{r}/contents/{path}?ref  → existing blob sha (or 404)
 *      PUT  /repos/{o}/{r}/contents/{path}      → create/update file on the branch
 *   5. POST /repos/{o}/{r}/pulls                → open the PR
 *
 * DIRECT-COMMIT flow (data repos — the CSHL course repo or a lab repo such as
 * reiserlab/arena-experiments): directCommit() skips the branch + PR — GET
 * /repos (default_branch) → GET contents (sha) → PUT on the default branch.
 * Safe there because bench/rig-id namespacing means no two rigs write the
 * same file.
 *
 * Security: the token lives ONLY in the Authorization header — never in a URL,
 * never in the body. Run logs commit as gzip (`gzipBytes`, `.jsonl.gz`) and
 * `commitFile` routes >30 MiB payloads through the Git Database API
 * (`directCommitLarge`) — the Contents API rejects ~35 MiB+ files (HTTP 422).
 * Writable paths are allowlisted (WRITABLE_PREFIXES:
 * protocols/, runlogs/, configs/metadata/, patterns/, pattern-sets/ — mirrors
 * the URL-state path-traversal guard); reads additionally allow the data
 * repo's root-level controlled-vocabulary YAMLs (READABLE_EXACT: roster,
 * genotypes, ages, sexes, fly_numbers). Keep BOTH lists in sync with every
 * path the Studio reads/writes — a miss throws inside a try/catch and shows up
 * only as a "… unreadable" / "… skipped" log line (that is how the age/sex/
 * fly-number course override silently failed until 2026-09).
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES `export`).
 */
(function (global) {
    'use strict';

    const API = 'https://api.github.com';
    const API_VERSION = '2022-11-28';
    // The Contents API rejects files over ~35 MiB (measured: 35 OK, 40 → 422).
    // commitFile() routes anything above this through the Git Database API
    // (blob → tree → commit → ref; hard limit 100 MiB per file).
    const LARGE_FILE_BYTES = 30 * 1024 * 1024;
    // patterns/ = the shared pattern library (Pattern Designer "Save to Repo");
    // pattern-sets/<hash>/patterns.zip = the opt-in post-run SD snapshot.
    const WRITABLE_PREFIXES = [
        'protocols/',
        'runlogs/',
        'configs/metadata/',
        'patterns/',
        'pattern-sets/'
    ];
    // Read-only extras: exact root paths readable but never writable — the data
    // repo's controlled vocabularies (roster/genotypes/ages/sexes/fly_numbers),
    // edited on GitHub. MUST list every file Studio.refreshCourseMeta() reads.
    const READABLE_EXACT = [
        'roster.yaml',
        'genotypes.yaml',
        'ages.yaml',
        'sexes.yaml',
        'fly_numbers.yaml'
    ];

    // UTF-8-safe base64 (Node Buffer or browser btoa+encodeURIComponent).
    function b64(text) {
        const s = String(text == null ? '' : text);
        if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
        return btoa(unescape(encodeURIComponent(s)));
    }

    // Binary-safe base64 for .pat / arbitrary bytes (Uint8Array or ArrayBuffer).
    // The text-only b64() would mangle bytes ≥ 0x80 via the UTF-8 round-trip.
    function b64Bytes(bytes) {
        const u8 =
            bytes instanceof Uint8Array
                ? bytes
                : new Uint8Array(bytes && bytes.byteLength != null ? bytes : 0);
        if (typeof Buffer !== 'undefined') {
            return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
        }
        let bin = '';
        for (let i = 0; i < u8.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }

    /**
     * gzip bytes (or a UTF-8 string) with the platform CompressionStream —
     * Chrome ≥ 80, Node ≥ 18. Run logs are committed as `.jsonl.gz` (6–8×
     * smaller; lossless). Rejects when the platform has no CompressionStream so
     * the caller can fall back to the uncompressed path.
     * @param {Uint8Array|ArrayBuffer|string} input
     * @returns {Promise<Uint8Array>}
     */
    async function gzipBytes(input) {
        if (typeof CompressionStream === 'undefined') {
            throw new Error('CompressionStream unavailable — cannot gzip in this browser');
        }
        const u8 =
            typeof input === 'string'
                ? new TextEncoder().encode(input)
                : input instanceof Uint8Array
                  ? input
                  : new Uint8Array(input);
        const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    /** gzip magic (1f 8b) — how readers tell a `.gz` payload regardless of name. */
    function isGzip(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
        return u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
    }

    function _isSanePath(path) {
        if (typeof path !== 'string' || !path) return false;
        if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return false;
        return true;
    }

    function isAllowedPath(path) {
        if (!_isSanePath(path)) return false;
        return WRITABLE_PREFIXES.some((p) => path.startsWith(p));
    }

    // Directory listings hit the bare root ('patterns', 'protocols/bench03') —
    // the top-level dir has no trailing slash, so it can't match a prefix.
    // Readable, never writable (a write to the bare name would be a FILE).
    const READABLE_DIR_EXACT = WRITABLE_PREFIXES.map((p) => p.replace(/\/$/, ''));

    // Reads: everything writable plus the exact-match read-only extras.
    function isAllowedReadPath(path) {
        if (!_isSanePath(path)) return false;
        return (
            isAllowedPath(path) ||
            READABLE_EXACT.includes(path) ||
            READABLE_DIR_EXACT.includes(path)
        );
    }

    // Filesystem-safe slug for a branch segment.
    function slug(s) {
        return (
            String(s || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'protocol'
        );
    }

    function branchName(name, runId) {
        return 'studio/' + slug(name) + '-' + (runId || 'run');
    }

    function headers(token) {
        const h = {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION
        };
        // Public course repos can be browsed without a token. Omit the header
        // entirely: `Bearer null` is an invalid credential, not an anonymous
        // GitHub request. Write paths still require authentication normally.
        if (token) h.Authorization = 'Bearer ' + token;
        return h;
    }

    function enc(seg) {
        return encodeURIComponent(seg);
    }

    function reqGetRepo(o, r, token) {
        return {
            method: 'GET',
            url: API + '/repos/' + enc(o) + '/' + enc(r),
            headers: headers(token)
        };
    }
    function reqGetRef(o, r, branch, token) {
        return {
            method: 'GET',
            url:
                API +
                '/repos/' +
                enc(o) +
                '/' +
                enc(r) +
                '/git/ref/heads/' +
                branch.split('/').map(enc).join('/'),
            headers: headers(token)
        };
    }
    function reqCreateRef(o, r, newBranch, baseSha, token) {
        return {
            method: 'POST',
            url: API + '/repos/' + enc(o) + '/' + enc(r) + '/git/refs',
            headers: headers(token),
            body: { ref: 'refs/heads/' + newBranch, sha: baseSha }
        };
    }
    function _contentsUrl(o, r, path) {
        return (
            API +
            '/repos/' +
            enc(o) +
            '/' +
            enc(r) +
            '/contents/' +
            path.split('/').map(enc).join('/')
        );
    }
    function reqGetContents(o, r, path, ref, token) {
        if (!isAllowedReadPath(path)) throw new Error('Refusing to read disallowed path: ' + path);
        return {
            method: 'GET',
            url: _contentsUrl(o, r, path) + (ref ? '?ref=' + enc(ref) : ''),
            headers: headers(token)
        };
    }
    /**
     * Raw-media-type contents read: the response body IS the file bytes, not
     * JSON+base64. Required for .pat previews — the Contents API omits
     * `content` for files >1MB, and .pat files can exceed that. Execute with
     * runBytes(), not run().
     */
    function reqGetContentsRaw(o, r, path, ref, token) {
        if (!isAllowedReadPath(path)) throw new Error('Refusing to read disallowed path: ' + path);
        const h = headers(token);
        h.Accept = 'application/vnd.github.raw';
        return {
            method: 'GET',
            url: _contentsUrl(o, r, path) + (ref ? '?ref=' + enc(ref) : ''),
            headers: h
        };
    }
    /**
     * @param {object} a {message, contentText?, contentBytes?, branch, sha?} —
     *        sha present ⇒ update, absent ⇒ create. contentBytes (Uint8Array/
     *        ArrayBuffer) wins over contentText for binary payloads (.pat).
     */
    function reqPutContents(o, r, path, a, token) {
        if (!isAllowedPath(path)) throw new Error('Refusing to write disallowed path: ' + path);
        const body = {
            message: a.message,
            content: a.contentBytes != null ? b64Bytes(a.contentBytes) : b64(a.contentText),
            branch: a.branch
        };
        if (a.sha) body.sha = a.sha; // update; omit to create
        return {
            method: 'PUT',
            url: _contentsUrl(o, r, path),
            headers: headers(token),
            body: body
        };
    }
    // ── Git Database API (the >30 MiB path; see directCommitLarge) ────────────
    function _gitUrl(o, r, tail) {
        return API + '/repos/' + enc(o) + '/' + enc(r) + '/git/' + tail;
    }
    function reqCreateBlob(o, r, bytes, token) {
        return {
            method: 'POST',
            url: _gitUrl(o, r, 'blobs'),
            headers: headers(token),
            body: { content: b64Bytes(bytes), encoding: 'base64' }
        };
    }
    function reqGetCommit(o, r, sha, token) {
        return {
            method: 'GET',
            url: _gitUrl(o, r, 'commits/' + enc(sha)),
            headers: headers(token)
        };
    }
    function reqCreateTree(o, r, baseTreeSha, path, blobSha, token) {
        if (!isAllowedPath(path)) throw new Error('Refusing to write disallowed path: ' + path);
        return {
            method: 'POST',
            url: _gitUrl(o, r, 'trees'),
            headers: headers(token),
            body: {
                base_tree: baseTreeSha,
                tree: [{ path: path, mode: '100644', type: 'blob', sha: blobSha }]
            }
        };
    }
    function reqCreateCommit(o, r, a, token) {
        return {
            method: 'POST',
            url: _gitUrl(o, r, 'commits'),
            headers: headers(token),
            body: { message: a.message, tree: a.treeSha, parents: [a.parentSha] }
        };
    }
    function reqUpdateRef(o, r, branch, sha, token) {
        return {
            method: 'PATCH',
            url: _gitUrl(o, r, 'refs/heads/' + branch.split('/').map(enc).join('/')),
            headers: headers(token),
            body: { sha: sha, force: false }
        };
    }

    function reqCreatePull(o, r, a, token) {
        return {
            method: 'POST',
            url: API + '/repos/' + enc(o) + '/' + enc(r) + '/pulls',
            headers: headers(token),
            body: { title: a.title, head: a.head, base: a.base, body: a.body || '' }
        };
    }

    // Thin executor: run one descriptor with an injected fetch. Returns
    // {ok, status, data}. Never logs the token. Kept tiny so the builders stay
    // the tested surface.
    async function run(fetchImpl, req) {
        const res = await fetchImpl(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body != null ? JSON.stringify(req.body) : undefined
        });
        let data = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }
        return { ok: res.ok, status: res.status, data: data };
    }

    // Executor for raw-media-type reads (reqGetContentsRaw): the body is the
    // file itself. Returns {ok, status, bytes: Uint8Array|null}.
    async function runBytes(fetchImpl, req) {
        const res = await fetchImpl(req.url, {
            method: req.method,
            headers: req.headers
        });
        let bytes = null;
        try {
            bytes = new Uint8Array(await res.arrayBuffer());
        } catch (_) {
            bytes = null;
        }
        return { ok: res.ok, status: res.status, bytes: bytes };
    }

    // Byte-for-byte equality (the promote-to-shared overwrite guard).
    function bytesEqual(a, b) {
        const ua = a instanceof Uint8Array ? a : new Uint8Array(a || 0);
        const ub = b instanceof Uint8Array ? b : new Uint8Array(b || 0);
        if (ua.length !== ub.length) return false;
        for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
        return true;
    }

    function _apiError(res) {
        return (res && res.data && res.data.message) || 'HTTP ' + (res && res.status);
    }

    /**
     * Direct-commit orchestration (the course-data write mode): PUT one file
     * straight onto the repo's default branch — no branch, no PR. Sequence:
     * GET /repos (default_branch + existence/auth check) → GET contents (blob
     * sha, 404 ⇒ create) → PUT. All-or-nothing per file; the caller notifies.
     * @param {Function} fetchImpl injected fetch
     * @param {object} a {owner, repo, token, path, message, contentText?, contentBytes?}
     * @returns {{ok:boolean, status:number, branch?:string, updated?:boolean,
     *            data?:object, step?:string, error?:string}}
     */
    async function directCommit(fetchImpl, a) {
        const repo = await run(fetchImpl, reqGetRepo(a.owner, a.repo, a.token));
        if (!repo.ok || !repo.data || !repo.data.default_branch) {
            return { ok: false, step: 'repo', status: repo.status, error: _apiError(repo) };
        }
        const branch = repo.data.default_branch;
        const cur = await run(fetchImpl, reqGetContents(a.owner, a.repo, a.path, branch, a.token));
        if (!cur.ok && cur.status !== 404) {
            return { ok: false, step: 'get', status: cur.status, error: _apiError(cur) };
        }
        const sha = cur.ok && cur.data && !Array.isArray(cur.data) ? cur.data.sha : undefined;
        const put = await run(
            fetchImpl,
            reqPutContents(
                a.owner,
                a.repo,
                a.path,
                {
                    message: a.message,
                    contentText: a.contentText,
                    contentBytes: a.contentBytes,
                    branch: branch,
                    sha: sha
                },
                a.token
            )
        );
        if (!put.ok) return { ok: false, step: 'put', status: put.status, error: _apiError(put) };
        return { ok: true, status: put.status, branch: branch, updated: !!sha, data: put.data };
    }

    /**
     * Large-file direct commit via the Git Database API — for payloads the
     * Contents API refuses (>~35 MiB): GET /repos (default_branch) → GET
     * git/ref/heads/<branch> (head commit) → GET git/commits/<sha> (root tree)
     * → POST git/blobs → POST git/trees (base_tree + ONE entry) → POST
     * git/commits → PATCH git/refs/heads/<branch> (fast-forward only). Same
     * token, same WRITABLE_PREFIXES allowlist. Overwrites an existing path
     * (no sha dance — the tree entry simply replaces it).
     * @param {Function} fetchImpl injected fetch
     * @param {object} a {owner, repo, token, path, message, contentBytes}
     * @returns {{ok:boolean, status:number, branch?:string, sha?:string,
     *            via:'git-db', step?:string, error?:string}}
     */
    async function directCommitLarge(fetchImpl, a) {
        const fail = (step, res) => ({
            ok: false,
            via: 'git-db',
            step: step,
            status: res.status,
            error: _apiError(res)
        });
        const repo = await run(fetchImpl, reqGetRepo(a.owner, a.repo, a.token));
        if (!repo.ok || !repo.data || !repo.data.default_branch) return fail('repo', repo);
        const branch = repo.data.default_branch;
        const ref = await run(fetchImpl, reqGetRef(a.owner, a.repo, branch, a.token));
        if (!ref.ok || !ref.data || !ref.data.object || !ref.data.object.sha)
            return fail('ref', ref);
        const headSha = ref.data.object.sha;
        const head = await run(fetchImpl, reqGetCommit(a.owner, a.repo, headSha, a.token));
        if (!head.ok || !head.data || !head.data.tree || !head.data.tree.sha)
            return fail('commit-get', head);
        const blob = await run(fetchImpl, reqCreateBlob(a.owner, a.repo, a.contentBytes, a.token));
        if (!blob.ok || !blob.data || !blob.data.sha) return fail('blob', blob);
        const tree = await run(
            fetchImpl,
            reqCreateTree(a.owner, a.repo, head.data.tree.sha, a.path, blob.data.sha, a.token)
        );
        if (!tree.ok || !tree.data || !tree.data.sha) return fail('tree', tree);
        const commit = await run(
            fetchImpl,
            reqCreateCommit(
                a.owner,
                a.repo,
                { message: a.message, treeSha: tree.data.sha, parentSha: headSha },
                a.token
            )
        );
        if (!commit.ok || !commit.data || !commit.data.sha) return fail('commit', commit);
        const upd = await run(
            fetchImpl,
            reqUpdateRef(a.owner, a.repo, branch, commit.data.sha, a.token)
        );
        if (!upd.ok) return fail('ref-update', upd);
        return {
            ok: true,
            via: 'git-db',
            status: upd.status,
            branch: branch,
            sha: commit.data.sha
        };
    }

    /**
     * Commit ONE file to the default branch, picking the path by size: the
     * Contents API (directCommit) up to LARGE_FILE_BYTES, the Git Database API
     * (directCommitLarge) above it. The result carries `via` and `bytes` so the
     * caller can say which path landed the file.
     * @param {object} a {owner, repo, token, path, message, contentText?|contentBytes?,
     *                    thresholdBytes?  (test hook; default LARGE_FILE_BYTES)}
     */
    async function commitFile(fetchImpl, a) {
        const bytes =
            a.contentBytes != null
                ? a.contentBytes instanceof Uint8Array
                    ? a.contentBytes
                    : new Uint8Array(a.contentBytes)
                : new TextEncoder().encode(a.contentText == null ? '' : String(a.contentText));
        const threshold = Number.isFinite(a.thresholdBytes) ? a.thresholdBytes : LARGE_FILE_BYTES;
        let res;
        if (bytes.length > threshold) {
            res = await directCommitLarge(fetchImpl, Object.assign({}, a, { contentBytes: bytes }));
        } else {
            res = await directCommit(fetchImpl, a);
            res.via = 'contents';
        }
        res.bytes = bytes.length;
        return res;
    }

    const StudioGitHub = {
        API,
        API_VERSION,
        LARGE_FILE_BYTES,
        WRITABLE_PREFIXES,
        READABLE_EXACT,
        b64,
        b64Bytes,
        bytesEqual,
        gzipBytes,
        isGzip,
        isAllowedPath,
        isAllowedReadPath,
        slug,
        branchName,
        headers,
        reqGetRepo,
        reqGetRef,
        reqCreateRef,
        reqGetContents,
        reqGetContentsRaw,
        reqPutContents,
        reqCreateBlob,
        reqGetCommit,
        reqCreateTree,
        reqCreateCommit,
        reqUpdateRef,
        reqCreatePull,
        run,
        runBytes,
        directCommit,
        directCommitLarge,
        commitFile
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioGitHub;
    }
    if (typeof global !== 'undefined') {
        global.StudioGitHub = StudioGitHub;
    }
})(typeof window !== 'undefined' ? window : this);
