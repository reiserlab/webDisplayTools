/**
 * studio-data-repos.js — the registry of GitHub DATA repos the Arena Studio,
 * Pattern Designer and data-browser dashboard can read/write (protocols,
 * patterns, run logs), plus the shared owner/name parser and the user-facing
 * label helpers that let one code path serve a course bench AND a lab rig.
 *
 * Adding a repo = one entry in DATA_REPOS (it appears in the Studio's File ▾
 * Repo picker). Unknown repos (typed under "Other…" or arriving via ?repo=)
 * still work: the helpers fall back to generic labels.
 *
 * Copy rule (CLAUDE.md): user-visible strings go through repoLabel / idLabel /
 * sharedLabel; internal identifiers (`courseSettings`, `fetchCourse*`, element
 * ids) keep their historical "course" names — tests anchor on them.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES
 * `export`) — same pattern as studio-meta.js / studio-github.js, so it loads
 * before the module block and the classic-shell settings can use it.
 */
(function (global) {
    'use strict';

    // Same shape rule as StudioUrlState.isSafeRepo (owner: 1-39 chars, no leading
    // hyphen; name: 1-100 of [A-Za-z0-9._-]); `..` is rejected separately.
    const REPO_RE = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

    /**
     * Known data repos. `idLabel` names the per-rig namespace segment
     * (protocols/<id>/, runlogs/<id>/) in that repo's vocabulary; `sharedLabel`
     * qualifies the protocols/shared/ picker header.
     */
    const DATA_REPOS = [
        {
            key: 'course',
            full: 'reiserlab/cshl-2026-course',
            label: 'CSHL 2026 course',
            idLabel: 'Bench id',
            idPlaceholder: 'bench03',
            sharedLabel: 'class-wide',
            visibility: 'public'
        },
        {
            key: 'lab',
            full: 'reiserlab/arena-experiments',
            label: 'Reiser lab experiments',
            idLabel: 'Rig id',
            idPlaceholder: '3e229-g6a',
            sharedLabel: 'lab-wide',
            visibility: 'private'
        }
    ];

    const GENERIC = { idLabel: 'Rig id', idPlaceholder: 'rig-a', sharedLabel: 'shared' };

    /** owner/name → {owner, name, full} or null (shape-only; no allowlist). */
    function parseRepo(raw) {
        const s = String(raw == null ? '' : raw).trim();
        if (!s || s.includes('..')) return null;
        const m = REPO_RE.exec(s);
        return m ? { owner: m[1], name: m[2], full: s } : null;
    }

    function _full(repo) {
        if (!repo) return '';
        if (typeof repo === 'string') return repo.trim();
        return repo.full || (repo.owner && repo.name ? repo.owner + '/' + repo.name : '');
    }

    /** Registry entry for a repo (string or {owner,name,full}) or null. */
    function findRepo(repo) {
        const full = _full(repo).toLowerCase();
        if (!full) return null;
        return DATA_REPOS.find((r) => r.full.toLowerCase() === full) || null;
    }

    /** Human label: registry label, else the owner/name, else 'data repo'. */
    function repoLabel(repo) {
        const e = findRepo(repo);
        if (e) return e.label;
        return _full(repo) || 'data repo';
    }

    /** 'Bench id' for the course repo, 'Rig id' otherwise. */
    function idLabel(repo) {
        const e = findRepo(repo);
        return (e && e.idLabel) || GENERIC.idLabel;
    }

    function idPlaceholder(repo) {
        const e = findRepo(repo);
        return (e && e.idPlaceholder) || GENERIC.idPlaceholder;
    }

    /** Qualifier for protocols/shared/: 'class-wide' | 'lab-wide' | 'shared'. */
    function sharedLabel(repo) {
        const e = findRepo(repo);
        return (e && e.sharedLabel) || GENERIC.sharedLabel;
    }

    const StudioDataRepos = {
        DATA_REPOS,
        REPO_RE,
        parseRepo,
        findRepo,
        repoLabel,
        idLabel,
        idPlaceholder,
        sharedLabel
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioDataRepos;
    }
    if (typeof global !== 'undefined') {
        global.StudioDataRepos = StudioDataRepos;
    }
})(typeof window !== 'undefined' ? window : this);
