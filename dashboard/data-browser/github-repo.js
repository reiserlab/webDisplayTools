(function (global) {
    'use strict';

    const API = 'https://api.github.com';
    const API_VERSION = '2022-11-28';
    const TOKEN_KEY = 'studio_gh_pat';
    const REPO_KEY = 'studio_gh_repo';
    const BENCH_KEY = 'studio_bench_id';
    const FOLDERS_KEY_PREFIX = 'dashboard_runlog_folders:';
    const DEFAULT_REPO = 'reiserlab/cshl-2026-course';

    function currentToken() {
        return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
    }

    function currentRepo() {
        return (localStorage.getItem(REPO_KEY) || DEFAULT_REPO).trim();
    }

    function foldersKey(repoValue) {
        return `${FOLDERS_KEY_PREFIX}${parseRepo(repoValue || currentRepo()).full}`;
    }

    function normalizeFolders(folders, available) {
        const allowed = available ? new Set(available) : null;
        return [
            ...new Set(
                (Array.isArray(folders) ? folders : [])
                    .map((folder) => String(folder || '').trim())
                    .filter(
                        (folder) =>
                            folder &&
                            !folder.includes('/') &&
                            !folder.includes('\\') &&
                            folder !== '.' &&
                            folder !== '..' &&
                            (!allowed || allowed.has(folder))
                    )
            )
        ].sort((a, b) => a.localeCompare(b));
    }

    function savedFolders(repoValue, available) {
        try {
            return normalizeFolders(
                JSON.parse(localStorage.getItem(foldersKey(repoValue)) || '[]'),
                available
            );
        } catch (_) {
            return [];
        }
    }

    function preferredFolders(repoValue, available) {
        const folders = normalizeFolders(available || []);
        const saved = savedFolders(repoValue, folders);
        if (saved.length) return saved;
        const bench = String(localStorage.getItem(BENCH_KEY) || '').trim();
        if (folders.includes(bench)) return [bench];
        return folders;
    }

    function saveFolders(repoValue, folders) {
        const normalized = normalizeFolders(folders);
        localStorage.setItem(foldersKey(repoValue), JSON.stringify(normalized));
        return normalized;
    }

    function parseRepo(value) {
        const match = String(value || '')
            .trim()
            .match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
        if (!match) throw new Error('Repository must be owner/name');
        return { owner: match[1], name: match[2], full: `${match[1]}/${match[2]}` };
    }

    function headers(token, accept) {
        return {
            Authorization: `Bearer ${token}`,
            Accept: accept || 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION
        };
    }

    function encodePath(path) {
        const value = String(path || '');
        if (!value || value.includes('..') || value.startsWith('/') || value.includes('\\')) {
            throw new Error('Unsafe repository path');
        }
        return value.split('/').map(encodeURIComponent).join('/');
    }

    function contentsUrl(repo, path, ref) {
        const parsed = typeof repo === 'string' ? parseRepo(repo) : repo;
        const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
        return `${API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/contents/${encodePath(path)}${query}`;
    }

    async function apiJson(url, options) {
        const token = currentToken();
        if (!token) throw new Error('Sign in with the course GitHub token first');
        const response = await fetch(url, {
            method: (options && options.method) || 'GET',
            headers: headers(token),
            body: options && options.body ? JSON.stringify(options.body) : undefined
        });
        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            data = null;
        }
        if (!response.ok)
            throw new Error((data && data.message) || `GitHub HTTP ${response.status}`);
        return data;
    }

    async function validateToken(token) {
        const response = await fetch(`${API}/user`, { headers: headers(token) });
        if (!response.ok) throw new Error(`token rejected (${response.status})`);
        return response.json();
    }

    async function signIn(repoValue) {
        const repo = parseRepo(repoValue || currentRepo());
        const pat = prompt(
            `Paste a GitHub fine-grained personal access token for ${repo.full}.\n` +
                'The course token should have Contents read/write access.\n\n' +
                'It is stored in sessionStorage first. The next prompt can remember it on this browser.'
        );
        if (!pat) return null;
        const token = pat.trim();
        const user = await validateToken(token);
        sessionStorage.setItem(TOKEN_KEY, token);
        if (
            confirm(
                'Remember this token on THIS browser?\nYES for a course bench; NO on a shared personal machine.'
            )
        ) {
            localStorage.setItem(TOKEN_KEY, token);
        }
        localStorage.setItem(REPO_KEY, repo.full);
        return user;
    }

    function signOut() {
        sessionStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_KEY);
    }

    async function user() {
        const token = currentToken();
        return token ? validateToken(token) : null;
    }

    async function repoInfo(repoValue) {
        const repo = parseRepo(repoValue || currentRepo());
        return apiJson(
            `${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
        );
    }

    async function listPath(repoValue, path, ref) {
        const repo = parseRepo(repoValue || currentRepo());
        const data = await apiJson(contentsUrl(repo, path, ref));
        if (!Array.isArray(data)) throw new Error(`${path} is not a directory`);
        return data;
    }

    async function fetchRaw(repoValue, path, ref, prefixBytes) {
        const token = currentToken();
        if (!token) throw new Error('Sign in with the course GitHub token first');
        const repo = parseRepo(repoValue || currentRepo());
        const requestHeaders = headers(token, 'application/vnd.github.raw');
        if (prefixBytes) requestHeaders.Range = `bytes=0-${Math.max(1023, prefixBytes - 1)}`;
        const response = await fetch(contentsUrl(repo, path, ref), { headers: requestHeaders });
        if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
        if (!prefixBytes || !response.body || !response.body.getReader) return response.text();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        try {
            while (text.length < prefixBytes) {
                const part = await reader.read();
                if (part.done) break;
                text += decoder.decode(part.value, { stream: true });
                if (
                    text.includes('"run_metadata"') &&
                    text.split(/\r?\n/).some((line) => line.includes('"run_metadata"'))
                )
                    break;
            }
        } finally {
            try {
                await reader.cancel();
            } catch (_) {
                /* response may already be complete */
            }
        }
        return text;
    }

    function fetchPrefix(repoValue, path, ref, bytes) {
        return fetchRaw(repoValue, path, ref, bytes || 65536);
    }

    function fetchText(repoValue, path, ref) {
        return fetchRaw(repoValue, path, ref, 0);
    }

    async function mapLimit(items, limit, worker, onProgress) {
        const results = new Array(items.length);
        let cursor = 0;
        let completed = 0;
        async function next() {
            while (cursor < items.length) {
                const index = cursor;
                cursor += 1;
                results[index] = await worker(items[index], index);
                completed += 1;
                if (onProgress) onProgress(completed, items.length);
            }
        }
        await Promise.all(
            new Array(Math.min(Math.max(1, limit), items.length || 1)).fill(null).map(next)
        );
        return results;
    }

    function repoTreeUrl(repoValue, path, branch) {
        const repo = parseRepo(repoValue || currentRepo());
        return `https://github.com/${repo.full}/tree/${encodeURIComponent(branch || 'main')}/${String(path || '').replace(/^\/+/, '')}`;
    }

    const DashboardGitHub = {
        API,
        API_VERSION,
        TOKEN_KEY,
        REPO_KEY,
        BENCH_KEY,
        FOLDERS_KEY_PREFIX,
        DEFAULT_REPO,
        currentToken,
        currentRepo,
        foldersKey,
        savedFolders,
        preferredFolders,
        saveFolders,
        parseRepo,
        headers,
        signIn,
        signOut,
        user,
        repoInfo,
        listPath,
        fetchPrefix,
        fetchText,
        mapLimit,
        repoTreeUrl
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = DashboardGitHub;
    global.DashboardGitHub = DashboardGitHub;
})(typeof window !== 'undefined' ? window : globalThis);
