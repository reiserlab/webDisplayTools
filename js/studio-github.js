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
 * DIRECT-COMMIT flow (course-data repos, CSHL pipeline): directCommit() skips
 * the branch + PR — GET /repos (default_branch) → GET contents (sha) → PUT on
 * the default branch. Safe there because RIG-ID namespacing means no two rigs
 * write the same file.
 *
 * Security: the token lives ONLY in the Authorization header — never in a URL,
 * never in the body. Writable paths are allowlisted to protocols/, runlogs/,
 * and configs/metadata/ (mirrors the URL-state path-traversal guard); reads
 * additionally allow the course repo's root-level roster.yaml.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES `export`).
 */
(function (global) {
    'use strict';

    const API = 'https://api.github.com';
    const API_VERSION = '2022-11-28';
    // patterns/ = the shared pattern library (Pattern Designer "Save to Repo").
    const WRITABLE_PREFIXES = ['protocols/', 'runlogs/', 'configs/metadata/', 'patterns/'];
    // Read-only extras: exact root paths readable but never writable — the
    // course roster + genotype vocabulary (instructor-edited on GitHub).
    const READABLE_EXACT = ['roster.yaml', 'genotypes.yaml'];

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

    const StudioGitHub = {
        API,
        API_VERSION,
        WRITABLE_PREFIXES,
        READABLE_EXACT,
        b64,
        b64Bytes,
        bytesEqual,
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
        reqCreatePull,
        run,
        runBytes,
        directCommit
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioGitHub;
    }
    if (typeof global !== 'undefined') {
        global.StudioGitHub = StudioGitHub;
    }
})(typeof window !== 'undefined' ? window : this);
